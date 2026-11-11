/**
 * Process ownership for Swival runs: version preflight, trace tailing,
 * synchronous process-group spawning and termination, and the detached
 * async launcher. Only live handles created here ever signal a process group.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createRequire } from "node:module";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { SwivalAgentConfig } from "./agents.js";
import { type AsyncOwner, captureAsyncOwner } from "./async-observation.js";
import {
	asyncOptionError,
	checkRequiresReviewer,
	getSwivalArgumentError,
	planSwivalLaunch,
	unknownAgentMessage,
} from "./args.js";
import {
	asyncRunChanged,
	asyncRuns,
	enforceAgentFsBootstrap,
	enforceNonoBootstrap,
	indexAsyncRun,
	mintArtifactDir,
	persistArtifacts,
	readReport,
	unindexAsyncRun,
} from "./artifacts.js";
import {
	ARTIFACT_ROOT,
	ASYNC_RUNNER_PATH,
	type AsyncScratch,
	type LaunchPlan,
	type LiveRunHandle,
	MAX_STDERR_BUFFER_LINES,
	MIN_COMPATIBLE_SWIVAL_VERSION,
	RECOMMENDED_SWIVAL_VERSION,
	type RunMeta,
	STDERR_TAIL_LINES,
	STDOUT_RING_CHARS,
	SwivalArgumentError,
	type SwivalDetails,
	type SwivalOverrides,
	type SwivalResult,
	type SwivalVersionCheck,
	TRACE_EVENT_RING_LIMIT,
	TRACE_TOOL_MAP_LIMIT,
	type TraceEvent,
} from "./contracts.js";
import { resolveSwivalEvidenceEnv } from "./child-env.js";
import { compareSemver, parseSemver } from "./paths.js";
import { terminalFailureReason } from "./report.js";

// Shared with the plain-Node detached runner; no runtime TypeScript loader.
const asyncEvidence = createRequire(import.meta.url)("../scripts/async-evidence.cjs") as {
	createScratch(): AsyncScratch;
	cleanupScratch(scratch: AsyncScratch): string | undefined;
};

export type OnUpdateCallback = (partial: AgentToolResult<SwivalDetails>) => void;

function stripAnsi(s: string): string {
	// Remove CSI / OSC / SGR sequences. Not exhaustive but covers swival's output.
	return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "");
}

function tail<T>(arr: T[], n: number): T[] {
	return arr.length > n ? arr.slice(arr.length - n) : arr;
}

// ---------------------------------------------------- process groups --

const groupIsGone = (killProcessGroup: (pid: number, signal: NodeJS.Signals | 0) => unknown, pid: number): boolean => {
	try {
		killProcessGroup(-pid, 0);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ESRCH";
	}
};

/** Schedule SIGKILL until a process-group probe confirms that the group is gone. */
export function scheduleProcessGroupKillEscalation(
	proc: { once(event: "close", listener: () => void): unknown },
	pid: number,
	killProcessGroup: (pid: number, signal: NodeJS.Signals | 0) => unknown = process.kill,
): NodeJS.Timeout {
	const timer = setTimeout(() => {
		if (groupIsGone(killProcessGroup, pid)) return;
		try { killProcessGroup(-pid, "SIGKILL"); } catch { /* already exited */ }
	}, 5000);
	timer.unref?.();
	proc.once("close", () => {
		if (groupIsGone(killProcessGroup, pid)) clearTimeout(timer);
	});
	return timer;
}

/** Terminate a tracked process group and verify its absence before forgetting it. */
export async function terminateProcessGroup(
	proc: { once(event: "close", listener: () => void): unknown },
	pid: number,
	killProcessGroup: (pid: number, signal: NodeJS.Signals | 0) => unknown = process.kill,
	graceMs = 5000,
	settleMs = 1000,
): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let finished = false;
		let killTimer: NodeJS.Timeout | undefined;
		let settleTimer: NodeJS.Timeout | undefined;
		const finish = (verified: boolean) => {
			if (finished) return;
			finished = true;
			if (killTimer) clearTimeout(killTimer);
			if (settleTimer) clearTimeout(settleTimer);
			resolve(verified);
		};
		const signal = (name: NodeJS.Signals): boolean => {
			try {
				killProcessGroup(-pid, name);
				return true;
			} catch (err) {
				finish((err as NodeJS.ErrnoException).code === "ESRCH");
				return false;
			}
		};
		proc.once("close", () => {
			if (groupIsGone(killProcessGroup, pid)) finish(true);
		});
		killTimer = setTimeout(() => {
			if (groupIsGone(killProcessGroup, pid)) { finish(true); return; }
			if (signal("SIGKILL") && !finished) settleTimer = setTimeout(() => finish(groupIsGone(killProcessGroup, pid)), settleMs);
		}, graceMs);
		signal("SIGTERM");
	});
}

// ------------------------------------------------- version preflight --

export function evaluateSwivalVersion(installedVersion: string | undefined): SwivalVersionCheck {
	const base = { recommendedVersion: RECOMMENDED_SWIVAL_VERSION, minCompatibleVersion: MIN_COMPATIBLE_SWIVAL_VERSION };
	if (!installedVersion) {
		return { ...base, isOutdated: true, isIncompatible: true,
			errorMessage: `Could not determine installed Swival version (minimum required: ${MIN_COMPATIBLE_SWIVAL_VERSION}). Verify Swival is installed and runs with 'swival --version', or upgrade with: uv tool upgrade swival` };
	}
	if (!parseSemver(installedVersion)) {
		return { ...base, installedVersion, isOutdated: true, isIncompatible: true,
			errorMessage: `Installed Swival version "${installedVersion}" could not be parsed as semver (minimum required: ${MIN_COMPATIBLE_SWIVAL_VERSION}). Upgrade with: uv tool upgrade swival` };
	}
	if (compareSemver(installedVersion, MIN_COMPATIBLE_SWIVAL_VERSION) < 0) {
		return { ...base, installedVersion, isOutdated: true, isIncompatible: true,
			errorMessage: `Installed Swival version ${installedVersion} is incompatible (minimum required: ${MIN_COMPATIBLE_SWIVAL_VERSION}). Upgrade with: uv tool upgrade swival` };
	}
	if (compareSemver(installedVersion, RECOMMENDED_SWIVAL_VERSION) < 0) {
		return { ...base, installedVersion, isOutdated: true, isIncompatible: false,
			advisoryMessage: `Swival ${installedVersion} is installed. Swival ${RECOMMENDED_SWIVAL_VERSION} is recommended for latest security and reliability fixes. Upgrade with: uv tool upgrade swival` };
	}
	return { ...base, installedVersion, isOutdated: false, isIncompatible: false };
}

let cachedVersionCheck: { check: SwivalVersionCheck; timestamp: number } | null = null;
let inFlightVersionCheck: Promise<SwivalVersionCheck> | null = null;
const VERSION_CACHE_TTL_MS = 60_000;

export function resetSwivalVersionCache(): void {
	cachedVersionCheck = null;
	inFlightVersionCheck = null;
}

export async function preflightSwivalVersion(
	execVersion: () => Promise<string | undefined> = defaultGetSwivalVersion,
): Promise<SwivalVersionCheck> {
	const now = Date.now();
	if (cachedVersionCheck && now - cachedVersionCheck.timestamp < VERSION_CACHE_TTL_MS) return cachedVersionCheck.check;
	if (inFlightVersionCheck) return inFlightVersionCheck;
	inFlightVersionCheck = (async () => {
		try {
			const check = evaluateSwivalVersion(await execVersion());
			cachedVersionCheck = { check, timestamp: Date.now() };
			return check;
		} catch {
			return evaluateSwivalVersion(undefined);
		} finally {
			inFlightVersionCheck = null;
		}
	})();
	return inFlightVersionCheck;
}

async function defaultGetSwivalVersion(): Promise<string | undefined> {
	return new Promise<string | undefined>((resolve) => {
		let settled = false;
		let killTimer: NodeJS.Timeout | undefined;
		const finish = (val: string | undefined) => {
			if (settled) return;
			settled = true;
			if (killTimer) clearTimeout(killTimer);
			resolve(val);
		};
		let cp: ChildProcess | undefined;
		killTimer = setTimeout(() => {
			try { cp?.kill("SIGKILL"); } catch { /* ignore */ }
			finish(undefined);
		}, 5000);
		killTimer.unref?.();
		try {
			cp = spawn("swival", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
			cp.unref?.();
			let stdout = "";
			let stderr = "";
			const MAX_PROBE_BYTES = 16 * 1024;
			cp.stdout?.on("data", (d: Buffer) => { if (stdout.length < MAX_PROBE_BYTES) stdout += d.toString("utf-8"); });
			cp.stderr?.on("data", (d: Buffer) => { if (stderr.length < MAX_PROBE_BYTES) stderr += d.toString("utf-8"); });
			cp.on("error", () => finish(undefined));
			cp.on("close", (code) => finish(code === 0 ? (stdout.trim() || stderr.trim() || undefined) : undefined));
		} catch {
			finish(undefined);
		}
	});
}

// ------------------------------------------------------ trace tailing --

/**
 * Tail a swival `--trace-dir` JSONL file, emitting TraceEvent updates
 * whenever a new line lands. One UTF-8 decoder lives across every poll and
 * append read so a code point split across reads is never corrupted; it is
 * flushed only by the returned final drain.
 */
export function startTraceTail(traceDir: string, onEvent: (event: TraceEvent) => void): () => Promise<void> {
	let watcher: fs.FSWatcher | null = null;
	let fileWatcher: fs.FSWatcher | null = null;
	let traceFile: string | null = null;
	let position = 0;
	let buffer = "";
	const decoder = new StringDecoder("utf8");
	const toolUseNames = new Map<string, string>();
	const rememberToolUse = (key: string, name: string) => {
		if (toolUseNames.size >= TRACE_TOOL_MAP_LIMIT) toolUseNames.delete(toolUseNames.keys().next().value!);
		toolUseNames.set(key, name);
	};

	const parseLines = (lines: string[]) => {
		for (const line of lines) {
			if (!line.trim()) continue;
			let obj: Record<string, unknown>;
			try { obj = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
			const t = obj.type;
			// Older/synthetic traces omit sessionId; the selected filename is a stable session identity.
			const sessionId = typeof obj.sessionId === "string" ? obj.sessionId : path.basename(traceFile!, ".jsonl");
			const toolKey = (id: string) => JSON.stringify([sessionId, id]);
			const content = (obj.message as Record<string, unknown> | undefined)?.content;
			if (!Array.isArray(content)) continue;
			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				const p = part as Record<string, unknown>;
				if (t === "assistant") {
					if (p.type === "tool_use" && typeof p.name === "string") {
						const toolUseId = typeof p.id === "string" ? p.id : undefined;
						if (toolUseId !== undefined) rememberToolUse(toolKey(toolUseId), p.name);
						onEvent({ type: "toolCall", name: p.name, args: (p.input as Record<string, unknown>) ?? {}, sessionId, toolUseId });
					} else if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
						onEvent({ type: "text", text: p.text });
					}
				} else if (t === "user" && p.type === "tool_result" && typeof p.tool_use_id === "string") {
					// tool_result arrives as user-role with content list.
					const name = toolUseNames.get(toolKey(p.tool_use_id)) ?? "tool";
					onEvent({ type: "toolCall", name, args: {}, sessionId, toolUseId: p.tool_use_id, ok: p.is_error !== true });
				}
			}
		}
	};

	let consuming: Promise<void> | null = null;
	let shouldRerun = false;
	let stopped = false;
	const consume = (): Promise<void> => {
		shouldRerun = true;
		if (consuming) return consuming;
		// Defer the body so even an empty read shares the tracked promise.
		consuming = Promise.resolve().then(async () => {
			try {
				do {
					shouldRerun = false;
					if (!traceFile) return;
					let stat: fs.Stats;
					try { stat = await fs.promises.stat(traceFile); } catch { return; }
					if (stat.size <= position) continue;
					let handle: fs.promises.FileHandle | undefined;
					try {
						handle = await fs.promises.open(traceFile, "r");
						// Bounded chunks keep peak memory predictable when fs.watch coalesces appends.
						const CHUNK_BYTES = 64 * 1024;
						const chunk = Buffer.alloc(CHUNK_BYTES);
						const end = stat.size;
						while (position < end) {
							const { bytesRead } = await handle.read(chunk, 0, Math.min(CHUNK_BYTES, end - position), position);
							if (bytesRead <= 0) break;
							position += bytesRead;
							buffer += decoder.write(chunk.subarray(0, bytesRead));
							// Cap buffer to prevent OOM from malicious newline-free trace files
							if (buffer.length > 4 * 1024 * 1024) {
								const cut = buffer.lastIndexOf("\n");
								buffer = cut >= 0 ? buffer.slice(cut + 1) : "";
							}
						}
						const lines = buffer.split("\n");
						buffer = lines.pop() ?? "";
						parseLines(lines);
					} finally {
						if (handle) await handle.close().catch(() => undefined);
					}
				} while (shouldRerun);
			} finally {
				consuming = null;
			}
		});
		return consuming;
	};

	const attachFileWatcher = () => {
		if (stopped || !traceFile || fileWatcher) return;
		try {
			fileWatcher = fs.watch(traceFile, { persistent: false }, () => { void consume(); });
		} catch { /* file may not exist yet */ }
	};

	let picking: Promise<void> | null = null;
	const pickTraceFile = (): Promise<void> => {
		if (picking) return picking;
		picking = Promise.resolve().then(async () => {
			try {
				if (!traceFile) {
					const entries = await fs.promises.readdir(traceDir);
					const jsonl = entries.find((e) => e.endsWith(".jsonl"));
					if (jsonl) traceFile = path.join(traceDir, jsonl);
				}
				attachFileWatcher();
				await consume();
			} catch { /* trace dir not created yet */ }
			finally { picking = null; }
		});
		return picking;
	};

	try {
		watcher = fs.watch(traceDir, { persistent: false }, () => { void pickTraceFile(); });
	} catch { /* ignore — trace tail is best-effort */ }
	const pollInterval = setInterval(() => {
		if (!traceFile) void pickTraceFile();
		else void consume();
	}, 100);
	pollInterval.unref?.();
	void pickTraceFile();

	return async () => {
		stopped = true;
		clearInterval(pollInterval);
		watcher?.close();
		fileWatcher?.close();
		// Discovery may still be queued when the process exits immediately
		// after writing its trace. Join it before asking for the final read.
		await pickTraceFile();
		if (!traceFile) await pickTraceFile();
		await consume();
		// Final drain: flush any dangling partial code point and parse the remainder.
		const remainder = buffer + decoder.end();
		buffer = "";
		if (remainder.trim()) parseLines([remainder]);
	};
}

// ------------------------------------------------------- concurrency --

export async function mapWithConcurrency<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	await Promise.all(new Array(limit).fill(null).map(async () => {
		while (true) {
			const i = nextIndex++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	}));
	return results;
}

// ---------------------------------------------------- run single (sync) --

function failedResult(agent: SwivalAgentConfig | undefined, agentName: string, task: string, message: string): SwivalResult {
	return {
		agent: agent?.name ?? agentName,
		agentSource: agent?.source ?? "unknown",
		task,
		exitCode: 1,
		finalOutput: "",
		stderrTail: [message],
		durationMs: 0,
		// The headline rendered to the caller is built from errorMessage, so the roster belongs there too.
		errorMessage: message,
		reason: { code: "config_error", text: message },
	};
}

/** Bounded drain window for inherited pipes after the owned process group is gone. */
const SYNC_STREAM_DRAIN_MS = 2000;

/**
 * Run one Swival process synchronously in its own process group. Finalization
 * starts on leader exit, timeout, abort, or spawn error; the whole group is
 * then terminated and verified before the pipes are drained, so a descendant
 * holding stdout/stderr open can neither block completion nor outlive the call.
 */
export async function runSingleSwival(
	defaultCwd: string,
	agents: SwivalAgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	overrides: SwivalOverrides,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SwivalResult[]) => SwivalDetails,
	artifactRoot: string = ARTIFACT_ROOT,
): Promise<SwivalResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) return failedResult(undefined, agentName, task, unknownAgentMessage(agentName, agents));
	const runCwd = cwd ?? defaultCwd;
	const reviewerError = checkRequiresReviewer(agent, overrides, runCwd);
	if (reviewerError) return failedResult(agent, agentName, task, reviewerError);
	const argumentError = getSwivalArgumentError(agent, runCwd, overrides);
	if (argumentError) return failedResult(agent, agentName, task, argumentError);
	const versionCheck = await preflightSwivalVersion();
	if (versionCheck.isIncompatible) return failedResult(agent, agentName, task, versionCheck.errorMessage!);

	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-swival-"));
	const reportPath = path.join(tmpDir, "report.json");
	const traceDir = path.join(tmpDir, "trace");
	await fs.promises.mkdir(traceDir, { recursive: true, mode: 0o700 });

	const current: SwivalResult = {
		agent: agent.name, agentSource: agent.source, task, exitCode: -1, finalOutput: "", stderrTail: [],
		durationMs: 0, traceEvents: [], versionAdvisory: versionCheck.advisoryMessage,
	};
	const stderrLines: string[] = [];
	const pushStderr = (line: string) => {
		stderrLines.push(line);
		if (stderrLines.length > MAX_STDERR_BUFFER_LINES) stderrLines.splice(0, stderrLines.length - MAX_STDERR_BUFFER_LINES);
		current.stderrTail = tail(stderrLines, STDERR_TAIL_LINES);
	};
	let stdoutBuf = "";

	const emit = () => {
		if (!onUpdate) return;
		const preview = current.finalOutput.trim() || stderrLines.slice(-3).join("\n") || "(running...)";
		onUpdate({ content: [{ type: "text", text: preview }], details: makeDetails([current]) });
	};
	let emitTimer: NodeJS.Timeout | undefined;
	let emitPending = false;
	const scheduleEmit = () => {
		if (!onUpdate) return;
		emitPending = true;
		if (emitTimer) return;
		emitTimer = setTimeout(() => {
			emitTimer = undefined;
			if (!emitPending) return;
			emitPending = false;
			emit();
		}, 100);
		emitTimer.unref?.();
	};

	const stopTrace = startTraceTail(traceDir, (event) => {
		current.traceEvents ??= [];
		// A name is not an identity: same-name calls can overlap, and tool
		// IDs can be reused in another session. Never guess for orphan results.
		if (event.type === "toolCall" && event.ok !== undefined && event.toolUseId !== undefined) {
			for (let i = current.traceEvents.length - 1; i >= 0; i--) {
				const prev = current.traceEvents[i];
				if (prev.type === "toolCall" && prev.sessionId === event.sessionId && prev.toolUseId === event.toolUseId && prev.ok === undefined) {
					prev.ok = event.ok;
					scheduleEmit();
					return;
				}
			}
		}
		if (current.traceEvents.length >= TRACE_EVENT_RING_LIMIT) current.traceEvents.shift();
		current.traceEvents.push(event);
		scheduleEmit();
	});

	const started = Date.now();
	// Attach our internal trace-dir override only if the caller hasn't already
	// requested one (overrides.traceDir outranks us; mostly useful for tests).
	const plan = planSwivalLaunch(agent, task, reportPath, runCwd, {
		...overrides,
		traceDir: overrides.traceDir ?? traceDir,
		installedSwivalVersion: overrides.installedSwivalVersion ?? versionCheck.installedVersion,
	});
	const childEnv = resolveSwivalEvidenceEnv(plan.argv, tmpDir, plan.env ?? process.env, os.homedir(), plan.cwd) ?? plan.env;
	try {
		const outcome = await new Promise<{ exitCode: number; groupVerified: boolean }>((resolve) => {
			const proc = spawn(plan.executable, plan.argv, {
				cwd: plan.cwd,
				...(childEnv ? { env: childEnv } : {}),
				shell: false,
				detached: true,
				stdio: [plan.taskTransport === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
			});
			const pid = typeof proc.pid === "number" && proc.pid > 1 ? proc.pid : undefined;
			if (plan.taskTransport === "stdin") {
				proc.stdin?.on("error", () => { /* child exited before reading prompt */ });
				proc.stdin?.end(plan.stdinPayload, "utf-8");
			}
			const stdoutDecoder = new StringDecoder("utf8");
			const stderrDecoder = new StringDecoder("utf8");
			let stderrBuf = "";
			let closed = false;
			let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
			let spawnFailed = false;
			let finalizing = false;
			let timeoutTimer: NodeJS.Timeout | undefined;
			const closeEvent = new Promise<void>((done) => proc.once("close", () => { closed = true; done(); }));

			const finalize = async (trigger: "exit" | "timeout" | "abort" | "error") => {
				if (finalizing) return;
				finalizing = true;
				if (timeoutTimer) clearTimeout(timeoutTimer);
				signal?.removeEventListener("abort", onAbort);
				// Terminate and verify the owned process group before draining pipes,
				// preserving the 5s SIGTERM -> SIGKILL cancellation grace period on
				// timeout/abort and reaping stray descendants quickly after leader exit.
				let groupVerified: boolean;
				if (spawnFailed) {
					groupVerified = true;
				} else if (pid !== undefined) {
					groupVerified = trigger === "exit"
						? await terminateProcessGroup(proc, pid, process.kill, 250, 100)
						: await terminateProcessGroup(proc, pid, process.kill, 5000, 1000);
				} else {
					if (trigger === "timeout" || trigger === "abort") {
						try { proc.kill("SIGTERM"); } catch { /* already gone */ }
					}
					groupVerified = true;
				}
				if (!closed) {
					let drainTimer: NodeJS.Timeout | undefined;
					await Promise.race([closeEvent, new Promise<void>((done) => {
						drainTimer = setTimeout(done, SYNC_STREAM_DRAIN_MS);
						drainTimer.unref?.();
					})]);
					if (drainTimer) clearTimeout(drainTimer);
					if (!closed) {
						if (pid === undefined) groupVerified = false;
						proc.stdin?.destroy();
						proc.stdout?.destroy();
						proc.stderr?.destroy();
						proc.unref?.();
					}
				}
				if (emitTimer) { clearTimeout(emitTimer); emitTimer = undefined; }
				stdoutBuf += stdoutDecoder.end();
				stderrBuf += stderrDecoder.end();
				if (stderrBuf.trim()) pushStderr(stderrBuf);
				stderrBuf = "";
				let exitCode: number;
				if (spawnFailed) exitCode = 1;
				else if (exitInfo === undefined) {
					if (trigger === "abort") pushStderr("swival process aborted");
					exitCode = 1;
				} else if (exitInfo.code == null) {
					// Signal exit (typically our SIGTERM/SIGKILL path): use 128 + signum so
					// the failure cannot masquerade as success when the report is missing.
					const sig = exitInfo.signal;
					pushStderr(`swival process terminated by ${sig ?? "signal"}`);
					exitCode = sig === "SIGKILL" ? 137 : sig === "SIGTERM" ? 143 : 1;
				} else exitCode = exitInfo.code;
				if (!groupVerified) {
					pushStderr("swival process group could not be verified as terminated; descendants may remain.");
					exitCode ||= 1;
				}
				resolve({ exitCode, groupVerified });
			};

			const onAbort = () => { void finalize("abort"); };
			const ms = plan.timeoutMs;
			if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
				timeoutTimer = setTimeout(() => {
					pushStderr(`swival timed out after ${ms}ms`);
					void finalize("timeout");
				}, ms);
				timeoutTimer.unref?.();
			}

			proc.stdout!.on("data", (buf: Buffer) => {
				stdoutBuf += stripAnsi(stdoutDecoder.write(buf));
				if (stdoutBuf.length > STDOUT_RING_CHARS) stdoutBuf = stdoutBuf.slice(-STDOUT_RING_CHARS);
				current.finalOutput = stdoutBuf;
				scheduleEmit();
			});
			proc.stderr!.on("data", (buf: Buffer) => {
				stderrBuf += stripAnsi(stderrDecoder.write(buf));
				const lines = stderrBuf.split("\n");
				stderrBuf = lines.pop() ?? "";
				for (const line of lines) {
					const trimmed = line.replace(/\r$/, "");
					if (trimmed.trim().length > 0) pushStderr(trimmed);
				}
				scheduleEmit();
			});

			proc.once("exit", (code, sig) => { exitInfo = { code, signal: sig }; void finalize("exit"); });
			// Synthetic handles may only emit close; a real leader always emits exit first.
			proc.once("close", (code, sig) => { exitInfo ??= { code, signal: sig }; void finalize("exit"); });
			proc.once("error", (err) => {
				spawnFailed = true;
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					current.errorMessage = "swival CLI not found on PATH. Install with: uv tool install swival";
				}
				pushStderr(`spawn error: ${err.message}`);
				void finalize("error");
			});
			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}
		});

		// The child has closed: drain trace discovery and all outstanding reads
		// before the canonical update or artifact persistence observes the run.
		await stopTrace().catch(() => undefined);
		if (emitTimer) { clearTimeout(emitTimer); emitTimer = undefined; }
		emitPending = false;
		current.exitCode = outcome.exitCode;
		current.durationMs = Date.now() - started;
		current.report = await readReport(reportPath);
		if (!outcome.groupVerified) {
			current.reason = { code: "non_zero_exit", text: "Swival process group could not be verified as terminated; descendants may remain." };
		}

		// Fail closed when emitted arguments or Swival configuration requested
		// AgentFS or Nono but the report cannot prove sandbox engagement.
		const bootstrapCheck = enforceAgentFsBootstrap(plan.sandbox.agentFsRequested || current.report?.sandbox?.mode === "agentfs", current.report);
		current.report = bootstrapCheck.report;
		if (bootstrapCheck.reason && !current.reason) current.reason = bootstrapCheck.reason;
		const nonoCheck = enforceNonoBootstrap(plan.sandbox.nonoRequested || current.report?.sandbox?.mode === "nono", current.report);
		current.report = nonoCheck.report;
		if (nonoCheck.reason && !current.reason) current.reason = nonoCheck.reason;

		// The report carries the complete answer; the stdout ring may have truncated it.
		current.finalOutput = current.report?.answer?.trim() || stdoutBuf.trim();
		emit(); // synchronous final emit: caller must see canonical end state

		// Persist artifacts BEFORE the finally-block removes tmpDir.
		try {
			current.artifactDir = await persistArtifacts(tmpDir, agent.name, artifactRoot, new Date(), current.exitCode);
		} catch { /* best-effort; skip artifact persistence on error */ }

		if (plan.effectiveMaxTurns !== undefined) current.effectiveMaxTurns = plan.effectiveMaxTurns;
		const terminalReason = terminalFailureReason(current.exitCode, current.report, stderrLines, current.reason, plan.effectiveProviderTimeout);
		if (terminalReason) {
			current.reason = terminalReason;
			current.errorMessage ??= terminalReason.text;
		}
		// Success states leave `reason` undefined on purpose: status and reason are orthogonal.
		return current;
	} finally {
		try { await stopTrace(); } catch { /* ignore */ }
		try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
}

// ------------------------------------------------ async (background) --

/**
 * Spawn Swival through a detached durable wrapper. The wrapper writes the
 * completion marker itself, so status survives a Pi restart. Only supported
 * in single-agent mode; chain and parallel always run synchronously.
 */
export async function runSingleSwivalAsync(
	defaultCwd: string,
	agents: SwivalAgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	overrides: SwivalOverrides,
	artifactRoot: string = ARTIFACT_ROOT,
	owner?: AsyncOwner,
): Promise<{ runId: string; artifactDir: string }> {
	const optionError = asyncOptionError(overrides);
	if (optionError) throw new SwivalArgumentError(optionError);
	artifactRoot = path.resolve(artifactRoot);
	const runOwner = captureAsyncOwner({ getSessionId: () => owner?.ownerSessionId, getSessionFile: () => owner?.ownerSessionFile });
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) throw new Error(unknownAgentMessage(agentName, agents));
	const runCwd = cwd ?? defaultCwd;
	const reviewerError = checkRequiresReviewer(agent, overrides, runCwd);
	if (reviewerError) throw new Error(reviewerError);
	const argumentError = getSwivalArgumentError(agent, runCwd, overrides);
	if (argumentError) throw new SwivalArgumentError(argumentError);
	const versionCheck = await preflightSwivalVersion();
	if (versionCheck.isIncompatible) throw new SwivalArgumentError(versionCheck.errorMessage!);

	const { artifactDir, ts, runId } = mintArtifactDir(agentName, artifactRoot);
	const scratch = asyncEvidence.createScratch();
	const stdoutFile = path.join(artifactDir, "stdout.txt");
	const stderrFile = path.join(artifactDir, "stderr.txt");
	let plan: LaunchPlan;
	let proc: ChildProcess;
	try {
		await fs.promises.mkdir(artifactDir, { recursive: true, mode: 0o700 });
		const traceDir = path.join(scratch.path, "trace");
		await fs.promises.mkdir(traceDir, { mode: 0o700 });
		plan = planSwivalLaunch(agent, task, path.join(scratch.path, "report.json"), runCwd, {
			...overrides,
			// Explicit trace destinations remain caller-owned, not exported here.
			traceDir: overrides.traceDir ?? traceDir,
			installedSwivalVersion: overrides.installedSwivalVersion ?? versionCheck.installedVersion,
		});
		if (plan.taskTransport === "stdin") {
			await fs.promises.writeFile(path.join(artifactDir, "task.txt"), plan.stdinPayload ?? "", { encoding: "utf-8", mode: 0o600 });
		}
		const childEnv = resolveSwivalEvidenceEnv(plan.argv, scratch.path, plan.env ?? process.env, os.homedir(), plan.cwd) ?? plan.env;
		let stdoutFd: number | undefined;
		let stderrFd: number | undefined;
		try {
			stdoutFd = fs.openSync(stdoutFile, "w");
			stderrFd = fs.openSync(stderrFile, "w");
			proc = spawn(process.execPath, [ASYNC_RUNNER_PATH, "--scratch-dir", scratch.path, artifactDir, ...plan.argv], {
				cwd: plan.cwd,
				...(childEnv ? { env: childEnv } : {}),
				shell: false,
				stdio: ["ignore", stdoutFd, stderrFd],
				detached: true,
			});
		} finally {
			try { if (stdoutFd !== undefined) fs.closeSync(stdoutFd); } catch { /* Best-effort descriptor cleanup. */ }
			try { if (stderrFd !== undefined) fs.closeSync(stderrFd); } catch { /* Runner owns scratch after spawn. */ }
		}
	} catch (error) {
		// No runner was launched: the parent still owns temporary storage.
		asyncEvidence.cleanupScratch(scratch);
		throw error;
	}

	const meta: RunMeta = {
		runId, agent: agentName, task, startedAt: ts, ...runOwner, pid: proc.pid, artifactDir, stdoutFile, stderrFile,
		agentFsRequested: plan.sandbox.agentFsRequested,
		nonoRequested: plan.sandbox.nonoRequested,
		effectiveProviderTimeout: plan.effectiveProviderTimeout,
	};
	const entry: LiveRunHandle = { kind: "live", meta, proc, scratch, exited: false, exitCode: null };
	asyncRuns.set(runId, entry);
	indexAsyncRun(entry);

	// Attach lifecycle handlers before any await. ChildProcess does not replay
	// early close/error events, and an unhandled spawn error can terminate Pi.
	const ASYNC_RUN_TTL_MS = 60 * 60 * 1000;
	let ttlScheduled = false;
	const scheduleExpiry = () => {
		if (ttlScheduled) return;
		ttlScheduled = true;
		setTimeout(() => {
			if (asyncRuns.get(runId) === entry) {
				asyncRuns.delete(runId); unindexAsyncRun(entry); asyncRunChanged();
			}
		}, ASYNC_RUN_TTL_MS).unref?.();
	};
	proc.once("close", (code) => {
		// The host runner normally exported and removed scratch before close.
		// After a crash/SIGKILL, reclaim only our original directory identity.
		asyncEvidence.cleanupScratch(scratch);
		const current = asyncRuns.get(runId);
		if (!current || current.exited) return;
		current.exited = true;
		current.exitCode = code;
		indexAsyncRun(current);
		scheduleExpiry();
		asyncRunChanged();
	});
	proc.once("error", (err) => {
		if (proc.pid === undefined) asyncEvidence.cleanupScratch(scratch);
		const current = asyncRuns.get(runId);
		if (!current || current.exited) return;
		current.exited = true;
		indexAsyncRun(current);
		void fs.promises.writeFile(path.join(artifactDir, "spawn-error.txt"), `async runner failed to start: ${err.message}`, "utf-8").catch(() => undefined);
		void fs.promises.writeFile(path.join(artifactDir, "completed.json"),
			JSON.stringify({ exitCode: null, exitedAt: new Date().toISOString() }, null, 2), "utf-8").catch(() => undefined);
		scheduleExpiry();
		asyncRunChanged();
	});
	proc.unref();
	asyncRunChanged();

	try {
		await fs.promises.writeFile(path.join(artifactDir, "run-meta.json"), JSON.stringify(meta, null, 2), "utf-8");
	} catch (err) {
		const terminated = proc.pid && proc.pid > 1 ? await terminateProcessGroup(proc, proc.pid) : false;
		if (terminated) {
			asyncEvidence.cleanupScratch(scratch);
			asyncRuns.delete(runId);
			unindexAsyncRun(entry);
			asyncRunChanged();
			await fs.promises.rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
			throw err;
		}
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`${message}. Async run ${runId} may still be active; tracking and artifacts were retained at ${artifactDir}.`);
	}

	return { runId, artifactDir };
}
