#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { readOutputConfig, selectAsyncOutputBody } = require("./output-file.cjs");

const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const OUTPUT_STARTUP_TIMEOUT_MS = 5000;
const OUTPUT_COMPLETION_TIMEOUT_MS = 10000;
const KILL_GRACE_MS = 1000;
const [artifactDir, ...runnerArgs] = process.argv.slice(2);
if (!artifactDir) {
	process.stderr.write("async-runner: artifact directory is required\n");
	process.exit(2);
}

const outputRequested = runnerArgs[0] === "--async-output-v1";
let outputBinding;
let outputMode;
let startupError;
const swivalArgs = outputRequested ? runnerArgs.slice(1) : runnerArgs;
if (outputRequested) {
	try {
		const config = readOutputConfig(4);
		outputMode = config.outputMode;
		outputBinding = config.binding;
		if (!["inline", "file-only"].includes(outputMode) ||
			!Number.isSafeInteger(config.dispatchIdentity?.dev) || !Number.isSafeInteger(config.dispatchIdentity?.ino)) {
			throw new Error("invalid output binding fields");
		}
		const stat = fs.lstatSync(".");
		if (!stat.isDirectory() || stat.dev !== config.dispatchIdentity.dev || stat.ino !== config.dispatchIdentity.ino) {
			throw new Error("dispatch directory identity changed before runner startup");
		}
	} catch (error) { startupError = error; }
}

function writeAtomic(name, content) {
	const target = path.join(artifactDir, name);
	const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(temporary, content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
		fs.chmodSync(temporary, 0o600);
		fs.renameSync(temporary, target);
	} finally {
		try { fs.unlinkSync(temporary); } catch { /* already renamed or best-effort cleanup */ }
	}
}

function lastCliOptionValue(args, option) {
	let value;
	const prefix = `${option}=`;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") break;
		if (arg.startsWith(prefix)) { value = arg.slice(prefix.length); continue; }
		if (arg !== option) continue;
		const next = args[index + 1];
		if (next === undefined || next === "--" || next.startsWith("-")) value = undefined;
		else { value = next; index++; }
	}
	return value;
}

function hasCliFlag(args, flag) {
	for (const arg of args) {
		if (arg === "--") return false;
		if (arg === flag) return true;
	}
	return false;
}

function outputEligibility(exitCode) {
	if (!outputBinding) return { eligible: false, reason: "no output requested" };
	if (exitCode !== 0) return { eligible: false, reason: `swival exited ${exitCode}` };
	const reportPath = path.join(artifactDir, "report.json");
	let report;
	try {
		const stat = fs.lstatSync(reportPath);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("report is not a regular file");
		if (stat.size > MAX_REPORT_BYTES) throw new Error(`report exceeds ${MAX_REPORT_BYTES} bytes`);
		report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
	} catch (error) {
		return { eligible: false, reason: `valid terminal report required: ${error.message}` };
	}
	const result = report && typeof report === "object" && !Array.isArray(report) &&
		report.result && typeof report.result === "object" && !Array.isArray(report.result) ? report.result : undefined;
	if (!result || result.outcome !== "success") return { eligible: false, reason: "terminal report outcome is not success" };
	if (result.exit_code !== undefined && result.exit_code !== 0) {
		return { eligible: false, reason: `terminal report exit code is ${String(result.exit_code)}` };
	}
	if (typeof result.answer !== "string") return { eligible: false, reason: "terminal report answer is missing" };
	const settings = report.settings && typeof report.settings === "object" && !Array.isArray(report.settings) ? report.settings : {};
	const timeline = Array.isArray(report.timeline) ? report.timeline : [];
	const reviewRequired = hasCliFlag(swivalArgs, "--self-review") || Boolean(lastCliOptionValue(swivalArgs, "--reviewer")) ||
		settings.self_review === true || (typeof settings.reviewer === "string" && settings.reviewer.trim() !== "") ||
		timeline.some((entry) => entry && typeof entry === "object" && entry.type === "review");
	if (reviewRequired) {
		const reviews = timeline.filter((entry) => entry && typeof entry === "object" && entry.type === "review");
		if (reviews.length === 0 || reviews[reviews.length - 1].exit_code !== 0) {
			return { eligible: false, reason: "required final reviewer acceptance is missing" };
		}
	}
	const sandbox = report.sandbox && typeof report.sandbox === "object" && !Array.isArray(report.sandbox) ? report.sandbox : {};
	const requestedSandbox = lastCliOptionValue(swivalArgs, "--sandbox");
	const agentFsRequested = requestedSandbox === "agentfs" || sandbox.mode === "agentfs";
	if (agentFsRequested && (sandbox.mode !== "agentfs" || typeof sandbox.agentfs_version !== "string" || sandbox.agentfs_version === "")) {
		return { eligible: false, reason: "AgentFS bootstrap evidence is missing" };
	}
	const nonoRequested = requestedSandbox === "nono" || sandbox.mode === "nono";
	if (nonoRequested && (sandbox.mode !== "nono" || typeof sandbox.nono_version !== "string" || sandbox.nono_version === "")) {
		return { eligible: false, reason: "Nono bootstrap evidence is missing" };
	}
	return { eligible: true, body: selectAsyncOutputBody(result.answer, "", true) };
}

// The committer is idle only while owned by this runner. Startup and the
// terminal transfer have fixed deadlines; EOF handles runner disconnection.
function startOutputCommitter() {
	const proc = spawn(process.execPath, [path.join(__dirname, "output-committer.cjs")], {
		cwd: outputBinding.directory, shell: false,
		stdio: ["pipe", "pipe", "ignore", 3, 4],
	});
	let readySeen = false;
	// A terminal reply is proof only after this runner has begun the one
	// authorized transfer. Set this before any pipe write can synchronously
	// surface a helper response.
	let transferPhase = "awaiting-ready";
	let terminal;
	let failure;
	let exited = false;
	let total = 0;
	let pending = "";
	let settleReady;
	let settleClosed;
	let readyOutcome;
	const ready = new Promise((resolve) => { settleReady = resolve; });
	const closed = new Promise((resolve) => { settleClosed = resolve; });
	function resolveReady(error) {
		if (readyOutcome) {
			if (error) readyOutcome.error ??= error;
			return;
		}
		readyOutcome = error ? { error } : {};
		settleReady(readyOutcome);
	}
	let completionTimer;
	let killTimer;
	const startupTimer = setTimeout(() => fail("output committer startup timed out"), OUTPUT_STARTUP_TIMEOUT_MS);
	function cancel() {
		failure ??= "output committer cancelled";
		resolveReady(failure);
		if (exited) return;
		proc.stdin.destroy();
		try { proc.kill("SIGTERM"); } catch { /* already exited */ }
		if (!killTimer) killTimer = setTimeout(() => {
			if (!exited) try { proc.kill("SIGKILL"); } catch { /* already exited */ }
		}, KILL_GRACE_MS);
	}
	function fail(message) {
		failure ??= message;
		resolveReady(failure);
		cancel();
	}
	proc.stdin.on("error", () => fail("output committer input pipe failed"));
	proc.stdout.on("error", () => fail("output committer response pipe failed"));
	proc.stdout.on("end", () => {
		if (!exited && transferPhase !== "completed") fail("output committer response pipe closed before verified completion");
	});
	proc.stdout.setEncoding("utf8");
	proc.stdout.on("data", (chunk) => {
		total += Buffer.byteLength(chunk, "utf8");
		if (total > 65536) { fail("output committer response exceeds 65536 bytes"); return; }
		pending += chunk;
		let newline;
		while ((newline = pending.indexOf("\n")) !== -1) {
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			try {
				const message = JSON.parse(line);
				if (message.status === "error" && typeof message.error === "string") {
					failure ??= message.error;
					resolveReady(failure);
				} else if (!readySeen && !terminal && message.status === "ready") {
					readySeen = true;
					transferPhase = "awaiting-transfer";
					clearTimeout(startupTimer);
					resolveReady();
				} else if (readySeen && !terminal && transferPhase === "transferring" &&
					["written", "discarded"].includes(message.status)) {
					terminal = message;
					transferPhase = "completed";
				} else fail("invalid output committer response sequence");
			} catch { fail("invalid output committer response"); }
		}
	});
	proc.once("error", (error) => fail(`output committer failed to start: ${error.message}`));
	proc.once("close", (code, signal) => {
		exited = true;
		clearTimeout(startupTimer);
		clearTimeout(completionTimer);
		clearTimeout(killTimer);
		if (pending !== "") failure ??= "incomplete output committer response";
		if (code !== 0 || !readySeen || !terminal) failure ??= `output committer exited before verified completion (${signal ?? code})`;
		resolveReady(failure);
		settleClosed({ error: failure, result: terminal });
	});
	return {
		ready, closed, cancel,
		async stop() { cancel(); await closed; },
		async complete(body) {
			if (exited || failure) throw new Error(failure ?? "output committer already exited");
			if (transferPhase !== "awaiting-transfer") throw new Error("output committer is not ready for completion");
			const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(body, "utf8");
			if (bytes.length > MAX_REPORT_BYTES) throw new Error(`output body exceeds ${MAX_REPORT_BYTES} bytes`);
			const header = Buffer.alloc(5);
			header[0] = body === undefined ? 0 : 1;
			header.writeUInt32BE(bytes.length, 1);
			// Mark the phase before either write: pipe activity can synchronously
			// invoke response callbacks in embedders and tests.
			transferPhase = "transferring";
			completionTimer = setTimeout(() => fail("output committer completion timed out"), OUTPUT_COMPLETION_TIMEOUT_MS);
			proc.stdin.write(header);
			proc.stdin.end(bytes);
			const outcome = await closed;
			if (outcome.error) throw new Error(outcome.error);
			const result = outcome.result;
			if (body === undefined ? result.status !== "discarded" :
				result.status !== "written" || result.outputPath !== outputBinding.outputPath ||
				result.outputBytes !== bytes.length || result.outputLineCount !== (body === "" ? 0 : body.split("\n").length)) {
				throw new Error("output committer returned invalid completion evidence");
			}
			return result;
		},
	};
}

let child;
let childCompletion;
let committer;
let cancelledExit;
let workerKillTimer;
function stopWorker(signal = "SIGTERM") {
	if (!child) return;
	try { child.kill(signal); } catch { /* child already exited */ }
	if (outputRequested && !workerKillTimer) workerKillTimer = setTimeout(() => {
		try { child.kill("SIGKILL"); } catch { /* child already exited */ }
	}, KILL_GRACE_MS);
}
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		cancelledExit = signal === "SIGTERM" ? 143 : 130;
		stopWorker(signal);
		committer?.cancel();
	});
}

function startSwival() {
	const taskFile = path.join(artifactDir, "task.txt");
	let stdinFd = "ignore";
	const lastDashDash = swivalArgs.lastIndexOf("--");
	const hasArgvTask = lastDashDash !== -1 && lastDashDash < swivalArgs.length - 1;
	if (!hasArgvTask) {
		try { stdinFd = fs.openSync(taskFile, "r"); } catch { /* no task file: stdin stays ignored */ }
	}
	try {
		// No pathname lookup here: Swival inherits the verified dispatch kernel
		// cwd. Its existing CLI --base-dir argument and semantics are unchanged.
		child = spawn("swival", swivalArgs, { shell: false, stdio: [stdinFd, "inherit", "inherit"] });
	} finally {
		if (typeof stdinFd === "number") fs.closeSync(stdinFd);
	}
	childCompletion = new Promise((resolve) => {
		let spawnError;
		child.once("error", (error) => { spawnError = error; });
		child.once("close", (code, signal) => {
			clearTimeout(workerKillTimer);
			const signalExit = signal === "SIGKILL" ? 137 : signal === "SIGTERM" ? 143 : 1;
			resolve({ exitCode: spawnError ? null : code ?? signalExit, spawnError });
		});
	});
	return childCompletion;
}

async function run() {
	let exitCode = 2;
	try {
		if (outputBinding) committer = startOutputCommitter();
	} catch (error) { startupError ??= error; }
	finally {
		if (outputRequested) for (const fd of [3, 4]) try { fs.closeSync(fd); } catch { /* invalid inherited fd */ }
	}
	try {
		if (committer) {
			const readiness = await committer.ready;
			if (readiness.error) throw new Error(readiness.error);
		}
		if (startupError) throw startupError;
		if (cancelledExit) throw new Error("async runner cancelled before Swival startup");
		const worker = startSwival();
		const outcome = committer ? await Promise.race([
			worker.then((result) => ({ worker: result })),
			committer.closed.then((result) => ({ helper: result })),
		]) : { worker: await worker };
		if (outcome.helper) throw new Error(outcome.helper.error ?? "output committer closed before worker completion");
		exitCode = outcome.worker.exitCode;
		if (outcome.worker.spawnError) writeAtomic("spawn-error.txt", `swival failed to start: ${outcome.worker.spawnError.message}`);
		if (committer) {
			const eligibility = outputEligibility(cancelledExit ?? exitCode);
			const committed = await committer.complete(eligibility.eligible ? eligibility.body : undefined);
			writeAtomic("output-result.json", JSON.stringify(eligibility.eligible ?
				{ ...committed, outputMode } : { status: "not-written", outputPath: outputBinding.outputPath,
					outputMode, reason: eligibility.reason }, null, 2));
		}
	} catch (error) {
		stopWorker();
		if (childCompletion) await childCompletion;
		if (committer) await committer.stop();
		exitCode = cancelledExit ?? (child ? (exitCode === 0 || exitCode === 2 ? 1 : exitCode) : 2);
		const message = `async-runner: ${error.message}`;
		if (!child) try { writeAtomic("spawn-error.txt", message); } catch { /* completion marker remains */ }
		if (outputRequested) try {
			writeAtomic("output-result.json", JSON.stringify({ status: cancelledExit ? "not-written" : "error",
				outputPath: outputBinding?.outputPath, outputMode,
				...(cancelledExit ? { reason: "async runner cancelled" } : { error: message }) }, null, 2));
		} catch { /* completion marker remains */ }
	} finally { clearTimeout(workerKillTimer); }
	try {
		writeAtomic("completed.json", JSON.stringify({ exitCode, exitedAt: new Date().toISOString() }, null, 2));
	} catch (error) {
		process.stderr.write(`async-runner: failed to persist completion: ${error.message}\n`);
		exitCode = 1;
	}
	process.exitCode = exitCode ?? 127;
}
void run();
