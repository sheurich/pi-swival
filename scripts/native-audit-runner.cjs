#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { finalizeNativeAudit } = require("./native-audit-lifecycle.cjs");
const runDir = process.argv[2];
const request = JSON.parse(fs.readFileSync(path.join(runDir, "request.json"), "utf8"));
const sessionDir = path.join(os.homedir(), ".agentfs", "run", request.session);
const bridge = path.join(__dirname, "native_audit.py");
const cap = 2 * 1024 * 1024;
const fds = [];
let bytes = 0;
let stopped;
let deadline;
let ownershipTimer;
let ownershipAcknowledged = false;
let sessionOwned = false;
let child;
let childClosed;
let finalization;

function cancellationReason() {
	return stopped ?? (!process.connected ? "Native ownership channel disconnected; audit cancelled." : undefined);
}
function stop(reason) {
	stopped ??= reason;
	// Closing the commit pipe before authorization prevents external execution.
	// Once committed, the shared finalizer stops the live owned group instead.
	child?.stdio[3]?.destroy();
	child?.stdin?.destroy();
	void finish(1);
}
const ioFailure = () => stop("Native runner I/O failed.");
async function closeLogs(shutdown) {
	if (child) {
		if (shutdown === "unverified") {
			child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
			child.unref();
		} else await childClosed;
	}
	let failed = false;
	for (const fd of fds.splice(0)) {
		try { fs.closeSync(fd); } catch { failed = true; }
	}
	if (failed) throw new Error("Native log close failed.");
}
function finish(code) {
	if (finalization) return finalization;
	clearTimeout(deadline);
	clearTimeout(ownershipTimer);
	finalization = finalizeNativeAudit({ runDir,
		ownership: child?.pid ? { signal: (signal) => process.kill(-child.pid, signal) } : undefined,
		sessionDir, sessionOwned, closeLogs, cancellationReason,
	}, { exitCode: code, stopped }).then((terminal) => {
		process.exitCode = terminal.exitCode;
	}, () => {
		process.exitCode = 1;
		process.stderr.write(`Native terminal failure evidence could not be persisted. Artifacts: ${runDir}.\n`);
	}).finally(() => {
		process.removeListener("message", acknowledge);
		process.removeListener("disconnect", disconnected);
		for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, interrupted);
		if (process.connected) process.disconnect();
	});
	return finalization;
}
const interrupted = () => stop("Native audit was interrupted.");
const disconnected = () => stop("Native ownership channel disconnected; audit cancelled.");
function acknowledge(message) {
	if (!child?.pid || ownershipAcknowledged || !message || typeof message !== "object" || Array.isArray(message) ||
		Object.keys(message).sort().join(",") !== "pid,type" ||
		message.type !== "native-child-owned" || message.pid !== child.pid) {
		stop("Native child ownership acknowledgement was invalid.");
		return;
	}
	ownershipAcknowledged = true;
	clearTimeout(ownershipTimer);
	process.removeListener("message", acknowledge);
	if (cancellationReason()) { stop(cancellationReason()); return; }
	const input = JSON.stringify(request);
	if (Buffer.byteLength(input) > 64 * 1024) { stop("Native request exceeded its bounded protocol."); return; }
	child.stdin.end(input, () => {
		if (cancellationReason()) { stop(cancellationReason()); return; }
		child.stdio[3].end("EXEC\n", () => {
			if (cancellationReason()) { stop(cancellationReason()); return; }
			// This is live launch readiness, not native completion. No disk PID
			// or readiness marker can authorize a handoff.
			process.send({ type: "native-started", pid: child.pid }, (error) => {
				if (error) stop("Native launch readiness notification failed.");
			});
		});
	});
}

// These handlers remain active from before spawn through terminal persistence.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, interrupted);
process.on("disconnect", disconnected);
process.on("message", acknowledge);
try {
	let collision = false;
	try { fs.lstatSync(sessionDir); collision = true; }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	if (collision) stop("Refusing to reuse an existing AgentFS session.");
	else {
		sessionOwned = true;
		const env = { ...process.env, ...(request.runtimePath ? { PATH: request.runtimePath } : {}) };
		for (const name of Object.keys(env)) {
			if (name.startsWith("GIT_") || name.startsWith("PYTHON") ||
				["AGENTFS", "SWIVAL_AGENTFS_ACTIVE", "SWIVAL_AGENTFS_SESSION", "SWIVAL_AGENTFS_VERSION", "BASH_ENV", "ENV"].includes(name)) delete env[name];
		}
		Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1",
			GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_LFS_SKIP_SMUDGE: "1" });
		// No external executable starts here. The isolated trusted Python waits
		// for ownership ACK and commit, then replaces itself with fixed AgentFS.
		for (const name of ["stdout.txt", "stderr.txt"]) fds.push(fs.openSync(path.join(runDir, name), "w", 0o600));
		child = spawn(request.python, ["-I", "-B", bridge, "--launch", request.agentfs,
			request.snapshot, request.evidence, request.session], {
			cwd: path.join(runDir, "sandbox"), env, shell: false, detached: true,
			stdio: ["pipe", "pipe", "pipe", "pipe"],
		});
		childClosed = new Promise((resolve) => child.once("close", resolve));
		function collect(fd, chunk) {
			const remaining = Math.max(0, cap - bytes);
			try {
				const output = chunk.subarray(0, remaining);
				let offset = 0;
				while (offset < output.length) {
					const written = fs.writeSync(fd, output.subarray(offset));
					if (!written) { ioFailure(); return; }
					offset += written;
					bytes += written;
				}
			} catch { ioFailure(); return; }
			if (chunk.length > remaining) stop("Native output exceeded the 2 MiB combined cap.");
		}
		child.stdout.on("data", (chunk) => collect(fds[0], chunk));
		child.stderr.on("data", (chunk) => collect(fds[1], chunk));
		for (const stream of [child.stdin, child.stdout, child.stderr, child.stdio[3]]) stream.on("error", ioFailure);
		child.once("error", () => stop("Native sandbox failed to start."));
		// A descendant can hold stdio open after leader exit. Finalization must
		// establish group absence before awaiting log drain or copying evidence.
		child.once("exit", (code, signal) => { void finish(code ?? (signal === "SIGKILL" ? 137 : 143)); });
		deadline = setTimeout(() => stop(`Native audit timed out after ${request.timeoutMs}ms.`), request.timeoutMs);
		child.once("spawn", () => {
			if (cancellationReason() || typeof process.send !== "function") {
				stop(cancellationReason() ?? "Native child ownership channel is unavailable."); return;
			}
			ownershipTimer = setTimeout(() => stop("Native child ownership acknowledgement timed out."), 2000);
			process.send({ type: "native-child", pid: child.pid }, (error) => {
				if (error) stop("Native child ownership notification failed.");
			});
		});
	}
} catch { ioFailure(); }
