import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import {
	BACKGROUND_WORK_PROTOCOL_VERSION,
	BACKGROUND_WORK_REGISTER_EVENT,
	BACKGROUND_WORK_UNREGISTER_EVENT,
	isSwivalPreflightDisabled,
	mapSwivalActiveWorkForAliases,
	registerBackgroundWorkProviderViaEvents,
	resolveConfirmProjectAgents,
	type BackgroundWorkRegistrationPayload,
} from "../extensions/runtime.js";

/**
 * Wiring test for the parts the pure-function tests cannot reach: the
 * session_start hook must build the notifier and reconciler, the reconciler
 * must deliver a completed run through pi.sendMessage, and session_shutdown
 * must tear everything down. The extension factory is driven with a stub pi,
 * so no Pi runtime, no swival process, and no LLM are involved.
 */

/** Poll rather than sleep, so a concurrent fs.watch test is not starved. */
async function waitFor(predicate: () => boolean, timeoutMs = 4000, intervalMs = 25): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** Re-evaluate the extension so module-level ARTIFACT_ROOT reads current env. */
async function loadExtension(): Promise<(pi: never, deps?: unknown) => void> {
	vi.resetModules();
	const module = await import("../extensions/index.js");
	return module.default as unknown as (pi: never, deps?: unknown) => void;
}

interface Handlers {
	session_start?: (event: unknown, ctx: unknown) => unknown;
	session_shutdown?: (event: unknown, ctx: unknown) => unknown;
	message_end?: (event: unknown, ctx: unknown) => unknown;
}

interface RegisteredTool {
	execute: (...args: unknown[]) => Promise<unknown>;
}

interface FakeSpawnSpec {
	args: string[];
	cwd?: string;
}

function makeFakeChildProcess() {
	class FakeChildProcess extends EventEmitter {
		stdout = new EventEmitter();
		stderr = new EventEmitter();
		killed = false;
		kill = vi.fn(() => {
			this.killed = true;
			return true;
		});
	}
	return new FakeChildProcess();
}

function installThrowingSpawn(onSpawn?: (spec: FakeSpawnSpec) => void) {
	const spawn = vi.fn((_: string, args: string[], options?: { cwd?: string }) => {
		onSpawn?.({ args, cwd: options?.cwd });
		throw new Error("spawn should not be reached when the collision guard rejects first");
	});
	vi.doMock("node:child_process", () => ({ spawn }));
	return { spawn };
}

function installSuccessfulSpawn(onSpawn?: (spec: FakeSpawnSpec) => void) {
	const spawn = vi.fn((_: string, args: string[], options?: { cwd?: string }) => {
		onSpawn?.({ args, cwd: options?.cwd });
		const proc = makeFakeChildProcess();
		const reportIndex = args.indexOf("--report");
		if (reportIndex !== -1) {
			const reportPath = args[reportIndex + 1];
			if (reportPath) {
				fs.mkdirSync(path.dirname(reportPath), { recursive: true });
				fs.writeFileSync(reportPath, JSON.stringify({
					result: { outcome: "success", answer: "ok" },
					stats: { review_rounds: 0 },
				}));
			}
		}
		queueMicrotask(() => {
			proc.stdout.emit("data", Buffer.from("ok\n"));
			proc.emit("spawn");
			proc.emit("close", 0, null);
		});
		return proc;
	});
	vi.doMock("node:child_process", () => ({ spawn }));
	return { spawn };
}

function installAsyncSpawn(factory: (spec: FakeSpawnSpec) => EventEmitter & {
	stdout: EventEmitter;
	stderr: EventEmitter;
	pid?: number;
	unref?: () => void;
	kill?: () => boolean;
}) {
	const spawn = vi.fn((_: string, args: string[], options?: { cwd?: string }) => factory({ args, cwd: options?.cwd }));
	vi.doMock("node:child_process", () => ({ spawn }));
	return { spawn };
}

interface StubRunState {
	meta: {
		runId: string;
		agent: string;
		task: string;
		startedAt: number;
		pid?: number;
		artifactDir: string;
		stdoutFile: string;
		stderrFile: string;
		sessionId?: string;
	};
	liveness: "running" | "exited" | "unknown";
	exited: boolean;
	exitCode: number | null;
	completed?: { exitCode: number | null; exitedAt: string };
	spawnError?: string;
	entry?: { proc?: { once?: (event: string, listener: () => void) => void } };
}

function stubPi(sessionId: string) {
	const handlers: Handlers = {};
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const registered: { current?: RegisteredTool } = {};
	const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => sessionId } };
	const pi = {
		on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
			handlers[event as keyof Handlers] = handler;
			return () => {};
		},
		registerTool: vi.fn((tool: RegisteredTool) => { registered.current = tool; }),
		sendMessage: (message: unknown, options: unknown) => {
			sent.push({ message, options });
			queueMicrotask(() => {
				void handlers.message_end?.({
					type: "message_end",
					message: { role: "custom", ...(message as Record<string, unknown>) },
				}, ctx);
			});
		},
		events: {
			emit: (channel: string, data: unknown) => { emitted.push({ channel, data }); },
			on: () => () => {},
		},
	};
	return { pi, ctx, handlers, sent, emitted, registered };
}

function writeCompletedRun(root: string, runId: string, sessionId: string | undefined): string {
	const dir = path.join(root, runId);
	fs.mkdirSync(dir, { recursive: true });
	const meta: Record<string, unknown> = {
		runId,
		agent: "self-review-worker",
		task: "t",
		startedAt: Date.now(),
		artifactDir: dir,
		stdoutFile: path.join(dir, "stdout.txt"),
		stderrFile: path.join(dir, "stderr.txt"),
	};
	if (sessionId) meta.sessionId = sessionId;
	fs.writeFileSync(path.join(dir, "run-meta.json"), JSON.stringify(meta));
	fs.writeFileSync(path.join(dir, "stdout.txt"), "the final answer");
	fs.writeFileSync(path.join(dir, "completed.json"), JSON.stringify({ exitCode: 0, exitedAt: new Date().toISOString() }));
	return dir;
}

describe("background-work event registration", () => {
	const provider = { name: "pi-swival", wakeChannels: ["pi-swival:run-finished"], listActiveWork: () => [] };

	it("requires a synchronous acceptance and unregisters with the same opaque token", () => {
		const emitted: Array<{ channel: string; data: unknown }> = [];
		const bus = { emit(channel: string, data: unknown) {
			emitted.push({ channel, data });
			if (channel === BACKGROUND_WORK_REGISTER_EVENT) {
				(data as BackgroundWorkRegistrationPayload).acknowledge({ ok: true });
			}
		} };
		const dispose = registerBackgroundWorkProviderViaEvents(bus, provider);
		const registration = emitted[0]!.data as BackgroundWorkRegistrationPayload;
		expect(registration.version).toBe(BACKGROUND_WORK_PROTOCOL_VERSION);
		expect(registration.registrationId).toMatch(/^[0-9a-f]{32}$/);
		dispose();
		const unregister = emitted[1]!;
		expect(unregister).toMatchObject({ channel: BACKGROUND_WORK_UNREGISTER_EVENT });
		expect(unregister.data).toMatchObject({
			version: BACKGROUND_WORK_PROTOCOL_VERSION,
			registrationId: registration.registrationId,
		});
	});

	it("throws when no event bridge acknowledges synchronously", () => {
		expect(() => registerBackgroundWorkProviderViaEvents({ emit: () => {} }, provider))
			.toThrow("Background-work provider 'pi-swival' has no background-work event bridge.");
	});

	it("propagates bridge rejection text", () => {
		const bus = { emit(channel: string, data: unknown) {
			if (channel === BACKGROUND_WORK_REGISTER_EVENT) {
				(data as BackgroundWorkRegistrationPayload).acknowledge({ ok: false, error: "provider collision" });
			}
		} };
		expect(() => registerBackgroundWorkProviderViaEvents(bus, provider)).toThrow("provider collision");
	});

	it("returns an idempotent unregister disposer", () => {
		const unregister = vi.fn();
		const bus = { emit(channel: string, data: unknown) {
			if (channel === BACKGROUND_WORK_REGISTER_EVENT) {
				(data as BackgroundWorkRegistrationPayload).acknowledge({ ok: true });
			} else if (channel === BACKGROUND_WORK_UNREGISTER_EVENT) unregister(data);
		} };
		const dispose = registerBackgroundWorkProviderViaEvents(bus, provider);
		dispose();
		dispose();
		expect(unregister).toHaveBeenCalledTimes(1);
	});
});

describe("extension wiring", () => {
	it("maps active runs owned by a session alias under every exact alias", () => {
		const entries = [
			{ meta: { runId: "mine", sessionId: "/sessions/current.jsonl" }, exited: false },
			{ meta: { runId: "theirs", sessionId: "another-session" }, exited: false },
			{ meta: { runId: "finished", sessionId: "/sessions/current.jsonl" }, exited: true },
		];

		expect(mapSwivalActiveWorkForAliases(entries, ["/sessions/current.jsonl", "session-uuid", "", "session-uuid"])).toEqual([
			{ id: "mine", sessionId: "/sessions/current.jsonl" },
			{ id: "mine", sessionId: "session-uuid" },
		]);
	});

	it("only disables preflight for case-insensitive 1 or true", () => {
		expect(isSwivalPreflightDisabled("1")).toBe(true);
		expect(isSwivalPreflightDisabled("TRUE")).toBe(true);
		expect(isSwivalPreflightDisabled("false")).toBe(false);
		expect(isSwivalPreflightDisabled("0")).toBe(false);
	});
	it("registers the tool and a session_start hook", async () => {
		const { pi, handlers } = stubPi("session-1");
		(await loadExtension())(pi as never);
		expect(pi.registerTool).toHaveBeenCalledTimes(1);
		expect(typeof handlers.session_start).toBe("function");
		expect(typeof handlers.session_shutdown).toBe("function");
	});

	it("activates wiring from execute without session_start and does not duplicate it", async () => {
		const startReconciler = vi.fn(() => () => {});
		const registerBackgroundWorkProvider = vi.fn(() => () => {});
		const factory = await loadExtension();
		const { pi, ctx, registered } = stubPi("session-1");
		factory(pi as never, {
			startReconciler,
			registerBackgroundWorkProvider,
			loadRunState: async () => undefined,
		});

		await registered.current?.execute("call-1", { action: "status", id: "missing" }, undefined, undefined, ctx);
		await registered.current?.execute("call-2", { action: "status", id: "missing" }, undefined, undefined, ctx);

		expect(startReconciler).toHaveBeenCalledTimes(1);
		expect(registerBackgroundWorkProvider).toHaveBeenCalledTimes(1);
	});

	it("publishes a file-scoped active run through current file and UUID aliases", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-aliases-"));
		const previousRoot = process.env.PI_SWIVAL_ARTIFACT_ROOT;
		let provider: { listActiveWork(): readonly { id: string; sessionId: string }[] } | undefined;
		const { spawn } = installAsyncSpawn(() => {
			const proc = makeFakeChildProcess() as EventEmitter & {
				stdout: EventEmitter;
				stderr: EventEmitter;
				pid?: number;
				unref: ReturnType<typeof vi.fn>;
			};
			proc.pid = 61234;
			proc.unref = vi.fn();
			queueMicrotask(() => { proc.emit("spawn"); });
			return proc;
		});
		try {
			process.env.PI_SWIVAL_ARTIFACT_ROOT = path.join(root, "artifacts");
			const factory = await loadExtension();
			const { pi, ctx, registered, handlers } = stubPi("session-uuid");
			const sessionFile = path.join(root, "session.jsonl");
			const aliasedCtx = {
				...ctx,
				sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "session-uuid" },
			};
			const registerBackgroundWorkProvider = vi.fn((value: typeof provider) => {
				provider = value;
				return () => {};
			});
			factory(pi as never, { startReconciler: () => () => {}, registerBackgroundWorkProvider });
			await handlers.session_start?.({}, aliasedCtx);
			const result = await registered.current?.execute(
				"call",
				{ agent: "self-review-worker", task: "background task", async: true },
				undefined,
				undefined,
				aliasedCtx,
			) as { content: Array<{ text: string }> };
			const runId = /^runId:\s+(\S+)$/m.exec(result.content[0]?.text ?? "")?.[1];
			expect(runId).toBeDefined();
			expect(provider?.listActiveWork()).toEqual([
				{ id: runId, sessionId: sessionFile },
				{ id: runId, sessionId: "session-uuid" },
			]);

			await handlers.session_start?.({}, {
				...aliasedCtx,
				sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "reloaded-uuid" },
			});
			expect(registerBackgroundWorkProvider).toHaveBeenCalledTimes(1);
			expect(provider?.listActiveWork()).toEqual([
				{ id: runId, sessionId: sessionFile },
				{ id: runId, sessionId: "reloaded-uuid" },
			]);
			handlers.session_shutdown?.({}, aliasedCtx);
			expect(provider?.listActiveWork()).toEqual([]);
			expect(spawn).toHaveBeenCalledTimes(1);
		} finally {
			if (previousRoot === undefined) delete process.env.PI_SWIVAL_ARTIFACT_ROOT;
			else process.env.PI_SWIVAL_ARTIFACT_ROOT = previousRoot;
			fs.rmSync(root, { recursive: true, force: true });
			vi.doUnmock("node:child_process");
		}
	});

	it("resolves project-agent confirmation policy", () => {
		expect(resolveConfirmProjectAgents(false, undefined)).toBe(false);
		expect(resolveConfirmProjectAgents(undefined, undefined)).toBe(true);
		expect(resolveConfirmProjectAgents(undefined, "1")).toBe(false);
	});

	it("rejects same-CWD parallel tasks that resolve to the same named AgentFS session before spawn", async () => {
		const { spawn } = installThrowingSpawn();
		try {
			const factory = await loadExtension();
			const { pi, ctx, registered } = stubPi("session-1");
			factory(pi as never, { startReconciler: () => () => {}, registerBackgroundWorkProvider: () => () => {} });
			const result = await registered.current?.execute(
				"call",
				{
					tasks: [
						{ agent: "self-review-worker", task: "first", cwd: "/repo", sandboxSession: "shared-overlay" },
						{ agent: "self-review-worker", task: "second", cwd: "/repo", sandboxSession: "shared-overlay" },
					],
					isolation: "agentfs",
				},
				undefined,
				undefined,
				ctx,
			) as { content: Array<{ text: string }>; isError?: boolean };
			const text = result.content[0]?.text ?? "";
			expect(result.isError).toBe(true);
			expect(text).toContain("Refusing to dispatch 2 write-capable tasks against the same cwd");
			expect(text).toContain("[0] self-review-worker");
			expect(text).toContain("[1] self-review-worker");
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			vi.doUnmock("node:child_process");
		}
	});

	it("allows same-CWD AgentFS tasks that keep distinct automatic overlays and dispatches them", async () => {
		const seen: FakeSpawnSpec[] = [];
		const { spawn } = installSuccessfulSpawn((spec) => { seen.push(spec); });
		try {
			const factory = await loadExtension();
			const { pi, ctx, registered } = stubPi("session-1");
			factory(pi as never, { startReconciler: () => () => {}, registerBackgroundWorkProvider: () => () => {} });
			const result = await registered.current?.execute(
				"call",
				{
					tasks: [
						{ agent: "self-review-worker", task: "first", cwd: "/repo" },
						{ agent: "self-review-worker", task: "second", cwd: "/repo" },
					],
					isolation: "agentfs",
				},
				undefined,
				undefined,
				ctx,
			) as { content: Array<{ text: string }>; isError?: boolean };
			const text = result.content[0]?.text ?? "";
			expect(result.isError).not.toBe(true);
			expect(text).toContain("swival parallel: 2/2 ok");
			expect(spawn).toHaveBeenCalledTimes(2);
			expect(seen).toHaveLength(2);
			for (const spec of seen) {
				expect(spec.cwd).toBe("/repo");
				expect(spec.args).toContain("--sandbox");
				expect(spec.args[spec.args.indexOf("--sandbox") + 1]).toBe("agentfs");
				expect(spec.args).toContain("--no-sandbox-auto-session");
				expect(spec.args).not.toContain("--sandbox-session");
			}
		} finally {
			vi.doUnmock("node:child_process");
		}
	});

	it("returns a start error when the child reports ENOENT before commitment and emits no completion signal", async () => {
		const { spawn } = installAsyncSpawn(() => {
			const proc = makeFakeChildProcess() as EventEmitter & {
				stdout: EventEmitter;
				stderr: EventEmitter;
				pid?: number;
				unref: ReturnType<typeof vi.fn>;
			};
			proc.pid = undefined;
			proc.unref = vi.fn();
			queueMicrotask(() => {
				const error = Object.assign(new Error("spawn swival ENOENT"), { code: "ENOENT" });
				proc.emit("error", error);
				proc.emit("close", null, null);
			});
			return proc;
		});
		try {
			const factory = await loadExtension();
			const { pi, ctx, registered, emitted, sent, handlers } = stubPi("session-1");
			factory(pi as never, { startReconciler: () => () => {}, registerBackgroundWorkProvider: () => () => {} });
			await handlers.session_start?.({}, ctx);
			const result = await registered.current?.execute(
				"call",
				{ agent: "self-review-worker", task: "background task", async: true },
				undefined,
				undefined,
				ctx,
			) as { content: Array<{ text: string }>; isError?: boolean };
			const text = result.content[0]?.text ?? "";
			expect(result.isError).toBe(true);
			expect(text).toContain("Failed to start async run:");
			expect(text).not.toContain("Async swival run started");
			expect(spawn).toHaveBeenCalledTimes(1);
			expect(sent).toHaveLength(0);
			expect(emitted).toEqual([]);
		} finally {
			vi.doUnmock("node:child_process");
		}
	});

	it("kills the detached process and rolls back state when metadata persistence fails after spawn", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-meta-fail-"));
		const previousRoot = process.env.PI_SWIVAL_ARTIFACT_ROOT;
		const killProcessGroup = vi.fn();
		let artifactDir: string | undefined;
		const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
		const writeFile = vi.spyOn(fs.promises, "writeFile");
		let procRef: EventEmitter | undefined;
		const { spawn } = installAsyncSpawn((spec) => {
			const proc = makeFakeChildProcess() as EventEmitter & {
				stdout: EventEmitter;
				stderr: EventEmitter;
				pid?: number;
				unref: ReturnType<typeof vi.fn>;
			};
			proc.pid = 43210;
			proc.unref = vi.fn();
			procRef = proc;
			const reportIndex = spec.args.indexOf("--report");
			const reportPath = reportIndex >= 0 ? spec.args[reportIndex + 1] : undefined;
			artifactDir = reportPath ? path.dirname(reportPath) : undefined;
			queueMicrotask(() => { proc.emit("spawn"); });
			return proc;
		});
		try {
			process.env.PI_SWIVAL_ARTIFACT_ROOT = path.join(root, "artifacts");
			const factory = await loadExtension();
			const { pi, ctx, registered, emitted, sent, handlers } = stubPi("session-1");
			writeFile.mockImplementation(async (...args: Parameters<typeof fs.promises.writeFile>) => {
				const target = String(args[0]);
				if (target.endsWith("run-meta.json")) {
					throw new Error("disk full while writing run-meta");
				}
				return originalWriteFile(...args);
			});
			factory(pi as never, { startReconciler: () => () => {}, registerBackgroundWorkProvider: () => () => {}, killProcessGroup });
			await handlers.session_start?.({}, ctx);
			const pending = registered.current?.execute(
				"call",
				{ agent: "self-review-worker", task: "background task", async: true },
				undefined,
				undefined,
				ctx,
			) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
			await waitFor(() => killProcessGroup.mock.calls.length === 1);
			expect(killProcessGroup).toHaveBeenNthCalledWith(1, 43210, "SIGTERM");
			await waitFor(() => killProcessGroup.mock.calls.length === 2);
			expect(killProcessGroup).toHaveBeenNthCalledWith(2, 43210, "SIGKILL");
			procRef?.emit("close", null, null);
			const result = await pending;
			const text = result.content[0]?.text ?? "";
			expect(result.isError).toBe(true);
			expect(text).toContain("Failed to start async run: disk full while writing run-meta");
			expect(spawn).toHaveBeenCalledTimes(1);
			expect(sent).toHaveLength(0);
			expect(emitted).toEqual([]);
			expect(artifactDir).toBeDefined();
			if (artifactDir) {
				expect(fs.existsSync(path.join(artifactDir, "run-meta.json"))).toBe(false);
			}
		} finally {
			writeFile.mockRestore();
			if (previousRoot === undefined) delete process.env.PI_SWIVAL_ARTIFACT_ROOT;
			else process.env.PI_SWIVAL_ARTIFACT_ROOT = previousRoot;
			fs.rmSync(root, { recursive: true, force: true });
			vi.doUnmock("node:child_process");
		}
	});

	it("defers exactly one completion signal when the child exits before metadata commitment", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-early-exit-"));
		const previousRoot = process.env.PI_SWIVAL_ARTIFACT_ROOT;
		try {
			process.env.PI_SWIVAL_ARTIFACT_ROOT = path.join(root, "artifacts");
			const { spawn } = installAsyncSpawn((spec) => {
				const proc = makeFakeChildProcess() as EventEmitter & {
					stdout: EventEmitter;
					stderr: EventEmitter;
					pid?: number;
					unref: ReturnType<typeof vi.fn>;
				};
				proc.pid = 50123;
				proc.unref = vi.fn();
				const reportIndex = spec.args.indexOf("--report");
				const reportPath = reportIndex >= 0 ? spec.args[reportIndex + 1] : undefined;
				if (reportPath) {
					fs.mkdirSync(path.dirname(reportPath), { recursive: true });
					fs.writeFileSync(reportPath, JSON.stringify({ result: { outcome: "success", answer: "ok" }, stats: { review_rounds: 0 } }));
				}
				queueMicrotask(() => {
					proc.emit("spawn");
					proc.emit("close", 0, null);
				});
				return proc;
			});
			const factory = await loadExtension();
			const { pi, ctx, registered, sent, emitted, handlers } = stubPi("session-1");
			factory(pi as never, { startReconciler: () => () => {}, registerBackgroundWorkProvider: () => () => {} });
			await handlers.session_start?.({}, ctx);
			const result = await registered.current?.execute(
				"call",
				{ agent: "self-review-worker", task: "background task", async: true },
				undefined,
				undefined,
				ctx,
			) as { content: Array<{ text: string }>; isError?: boolean };
			const text = result.content[0]?.text ?? "";
			expect(result.isError).not.toBe(true);
			expect(text).toContain("Async swival run started.");
			await waitFor(() => sent.length === 1);
			expect(sent).toHaveLength(1);
			expect((sent[0]!.message as { content: string }).content).toContain("completed: **self-review-worker**");
			expect(emitted.filter((event) => event.channel === "pi-swival:run-finished")).toHaveLength(1);
			expect(spawn).toHaveBeenCalledTimes(1);
		} finally {
			if (previousRoot === undefined) delete process.env.PI_SWIVAL_ARTIFACT_ROOT;
			else process.env.PI_SWIVAL_ARTIFACT_ROOT = previousRoot;
			fs.rmSync(root, { recursive: true, force: true });
			vi.doUnmock("node:child_process");
		}
	});

	it("disposes both previous registrations before replacing them", async () => {
		const calls: string[] = [];
		let reconcilerNumber = 0;
		let providerNumber = 0;
		const startReconciler = vi.fn(() => {
			const name = `reconciler-${++reconcilerNumber}`;
			calls.push(`${name}:start`);
			return () => { calls.push(`${name}:dispose`); };
		});
		const registerBackgroundWorkProvider = vi.fn(() => {
			const name = `provider-${++providerNumber}`;
			calls.push(`${name}:register`);
			return () => { calls.push(`${name}:dispose`); };
		});
		const factory = await loadExtension();
		const { pi, ctx, handlers } = stubPi("session-1");
		factory(pi as never, { startReconciler, registerBackgroundWorkProvider });
		await handlers.session_start?.({}, ctx);
		await handlers.session_start?.({}, { ...ctx, sessionManager: { getSessionId: () => "session-2" } });
		expect(startReconciler).toHaveBeenCalledTimes(2);
		expect(registerBackgroundWorkProvider).toHaveBeenCalledTimes(2);
		expect(calls.indexOf("reconciler-1:dispose")).toBeLessThan(calls.indexOf("reconciler-2:start"));
		expect(calls.indexOf("provider-1:dispose")).toBeLessThan(calls.indexOf("provider-2:register"));
		handlers.session_shutdown?.({}, ctx);
		expect(calls).toContain("reconciler-2:dispose");
		expect(calls).toContain("provider-2:dispose");
	});

	it("keeps stale registration disposers replacement-safe and idempotent", async () => {
		const disposers: Array<() => void> = [];
		const registerBackgroundWorkProvider = vi.fn(() => {
			let disposed = false;
			const dispose = vi.fn(() => { disposed = true; });
			disposers.push(() => { if (!disposed) dispose(); });
			return disposers.at(-1)!;
		});
		const factory = await loadExtension();
		const { pi, ctx, handlers } = stubPi("session-1");
		factory(pi as never, { startReconciler: () => () => {}, registerBackgroundWorkProvider });
		handlers.session_start?.({}, ctx);
		const stale = disposers[0]!;
		handlers.session_start?.({}, { ...ctx, sessionManager: { getSessionId: () => "session-2" } });
		stale();
		stale();
		handlers.session_shutdown?.({}, ctx);
		expect(registerBackgroundWorkProvider).toHaveBeenCalledTimes(2);
	});

	it("labels resume output possibly incomplete when liveness is unknown", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-wiring-unknown-"));
		const previousRoot = process.env.PI_SWIVAL_ARTIFACT_ROOT;
		try {
			const artifactRoot = path.join(root, "artifacts");
			const runDir = writeCompletedRun(artifactRoot, "unknown-run", "session-1");
			fs.rmSync(path.join(runDir, "completed.json"));
			fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify({ result: { outcome: "success", answer: "partial answer" } }));
			const meta = JSON.parse(fs.readFileSync(path.join(runDir, "run-meta.json"), "utf8")) as Record<string, unknown>;
			meta.pid = 999999;
			meta.startedAt = Date.now();
			fs.writeFileSync(path.join(runDir, "run-meta.json"), JSON.stringify(meta));
			process.env.PI_SWIVAL_ARTIFACT_ROOT = artifactRoot;
			const factory = await loadExtension();
			const { pi, ctx, registered } = stubPi("session-1");
			factory(pi as never, { startReconciler: () => () => {}, registerBackgroundWorkProvider: () => () => {} });
			const result = await registered.current?.execute("call", { action: "resume", id: "unknown-run" }, undefined, undefined, ctx);
			const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
			expect(text).toContain("possibly incomplete");
			expect(text).toContain("partial answer");
		} finally {
			if (previousRoot === undefined) delete process.env.PI_SWIVAL_ARTIFACT_ROOT;
			else process.env.PI_SWIVAL_ARTIFACT_ROOT = previousRoot;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports the latest review round from bounded stderr status output", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-wiring-review-round-"));
		const previousRoot = process.env.PI_SWIVAL_ARTIFACT_ROOT;
		try {
			const artifactRoot = path.join(root, "artifacts");
			const runDir = writeCompletedRun(artifactRoot, "review-round-run", "session-1");
			fs.writeFileSync(path.join(runDir, "stderr.txt"), [
				"noise",
				"▶ Review round 1: sending answer to reviewer",
				"more noise",
				"▶ Review round 3: sending answer to reviewer",
			].join("\n"));
			const completed = JSON.parse(fs.readFileSync(path.join(runDir, "completed.json"), "utf8")) as Record<string, unknown>;
			completed.exitedAt = new Date(Date.now() + 1500).toISOString();
			fs.writeFileSync(path.join(runDir, "completed.json"), JSON.stringify(completed));
			process.env.PI_SWIVAL_ARTIFACT_ROOT = artifactRoot;
			const factory = await loadExtension();
			const { pi, ctx, registered } = stubPi("session-1");
			factory(pi as never, { startReconciler: () => () => {}, registerBackgroundWorkProvider: () => () => {} });
			const result = await registered.current?.execute("call", { action: "status", id: "review-round-run" }, undefined, undefined, ctx);
			const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
			expect(text).toContain("review round: 3");
			expect(text).not.toContain("review round: 1");
		} finally {
			if (previousRoot === undefined) delete process.env.PI_SWIVAL_ARTIFACT_ROOT;
			else process.env.PI_SWIVAL_ARTIFACT_ROOT = previousRoot;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("revalidates identity before SIGTERM and before delayed SIGKILL, and cancels escalation on close", async () => {
		vi.useFakeTimers();
		try {
			const factory = await loadExtension();
			const { pi, ctx, registered } = stubPi("session-1");
			const closeListeners: Array<() => void> = [];
			const state: StubRunState = {
				meta: {
					runId: "interrupt-run",
					agent: "self-review-worker",
					task: "t",
					startedAt: 1_000_000,
					pid: 4321,
					artifactDir: "/tmp/interrupt-run",
					stdoutFile: "/tmp/interrupt-run/stdout.txt",
					stderrFile: "/tmp/interrupt-run/stderr.txt",
					sessionId: "session-1",
				},
				liveness: "running",
				exited: false,
				exitCode: null,
				entry: { proc: { once: (_event, listener) => { closeListeners.push(listener); } } },
			};
			const loadRunState = vi.fn(async () => state);
			const revalidate = vi.fn(async () => true);
			const killProcessGroup = vi.fn();
			factory(pi as never, {
				startReconciler: () => () => {},
				registerBackgroundWorkProvider: () => () => {},
				loadRunState,
				revalidateRunIdentity: revalidate,
				killProcessGroup,
			});

			const first = await registered.current?.execute("call", { action: "interrupt", id: "interrupt-run" }, undefined, undefined, ctx);
			const firstText = (first as { content: Array<{ text: string }> }).content[0]?.text ?? "";
			expect(firstText).toContain("Sent SIGTERM");
			expect(revalidate).toHaveBeenCalledTimes(1);
			expect(killProcessGroup).toHaveBeenNthCalledWith(1, 4321, "SIGTERM");

			closeListeners.forEach((listener) => listener());
			await vi.advanceTimersByTimeAsync(5000);
			expect(revalidate).toHaveBeenCalledTimes(1);
			expect(killProcessGroup).toHaveBeenCalledTimes(1);

			revalidate.mockResolvedValueOnce(false);
			const second = await registered.current?.execute("call", { action: "interrupt", id: "interrupt-run" }, undefined, undefined, ctx);
			const secondText = (second as { content: Array<{ text: string }> }).content[0]?.text ?? "";
			expect(secondText).toContain("identity changed");
			expect(killProcessGroup).toHaveBeenCalledTimes(1);

			revalidate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
			const third = await registered.current?.execute("call", { action: "interrupt", id: "interrupt-run" }, undefined, undefined, ctx);
			const thirdText = (third as { content: Array<{ text: string }> }).content[0]?.text ?? "";
			expect(thirdText).toContain("Sent SIGTERM");
			expect(killProcessGroup).toHaveBeenNthCalledWith(2, 4321, "SIGTERM");
			await vi.advanceTimersByTimeAsync(5000);
			expect(revalidate).toHaveBeenCalledTimes(4);
			expect(killProcessGroup).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("delivers a completed run owned by this session, and ignores others", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-wiring-"));
		const previousRoot = process.env.PI_SWIVAL_ARTIFACT_ROOT;
		try {
			const artifactRoot = path.join(root, "artifacts");
			fs.mkdirSync(artifactRoot);
			const mine = writeCompletedRun(artifactRoot, "mine-1-aaaa", "session-1");
			const theirs = writeCompletedRun(artifactRoot, "theirs-1-bbbb", "session-2");
			const orphan = writeCompletedRun(artifactRoot, "orphan-1-cccc", undefined);

			// Redirect the extension's own artifact root, then re-import it so the
			// module-level constant picks the scratch path up. This exercises the
			// reconciler the session_start hook builds, not a copy of it.
			process.env.PI_SWIVAL_ARTIFACT_ROOT = artifactRoot;
			const factory = await loadExtension();

			const { pi, ctx, handlers, sent } = stubPi("session-1");
			factory(pi as never);
			try {
				await handlers.session_start?.({ reason: "startup" }, ctx);
				// The wired notifier batches clean completions for 1500 ms by default.
				await waitFor(() => sent.length >= 1);
				await waitFor(() => fs.existsSync(path.join(mine, "notified.json")));

				expect(sent).toHaveLength(1);
				const message = sent[0]!.message as { customType: string; content: string; display: boolean; details?: Record<string, unknown> };
				expect(message.customType).toBe("swival-notify");
				expect(message.content).toContain("mine-1-aaaa");
				expect(message.content).toContain(`Artifact dir: ${mine}`);
				expect(message.content).not.toContain("the final answer");
				expect(message.display).toBe(false);
				expect(message.details).toMatchObject({ runIds: ["mine-1-aaaa"] });
				expect(sent[0]!.options).toMatchObject({ triggerTurn: true });

				expect(fs.existsSync(path.join(mine, "notified.json"))).toBe(true);
				expect(fs.existsSync(path.join(theirs, "notified.json"))).toBe(false);
				expect(fs.existsSync(path.join(orphan, "notified.json"))).toBe(false);
			} finally {
				handlers.session_shutdown?.({}, ctx);
			}
		} finally {
			if (previousRoot === undefined) delete process.env.PI_SWIVAL_ARTIFACT_ROOT;
			else process.env.PI_SWIVAL_ARTIFACT_ROOT = previousRoot;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
