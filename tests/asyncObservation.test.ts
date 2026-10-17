import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import * as extension from "../extensions/index.js";
import type { RunMeta } from "../extensions/index.js";
import { createPiSubagentsAdapter } from "../integrations/pi-subagents.js";

const execution = vi.hoisted(() => ({
	spawn: vi.fn(() => { throw new Error("Unconfigured test spawn boundary"); }),
}));
vi.mock("node:child_process", async () => ({
	...await vi.importActual<typeof import("node:child_process")>("node:child_process"),
	spawn: execution.spawn,
}));

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];
const disposers: Array<() => void> = [];
const observation = await import("../extensions/async-observation.js").catch(() => ({} as any));

function rootDir() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "swival-observation-"));
	roots.push(root);
	return root;
}

function artifact(root: string, id: string, owner: string | null = OWNER) {
	const artifactDir = path.join(root, id);
	fs.mkdirSync(artifactDir);
	const meta: RunMeta = {
		runId: id, agent: "test", task: "private task", startedAt: 1000, pid: 12345,
		artifactDir, stdoutFile: path.join(artifactDir, "stdout.txt"),
		stderrFile: path.join(artifactDir, "stderr.txt"),
		...(owner ? { ownerSessionId: owner, ownerSessionFile: "/synthetic/session.jsonl" } : {}),
	};
	fs.writeFileSync(path.join(artifactDir, "run-meta.json"), JSON.stringify(meta));
	fs.writeFileSync(meta.stdoutFile, "private output");
	fs.writeFileSync(meta.stderrFile, "");
	return meta;
}

function complete(meta: RunMeta, outcome = "success", exitCode: number | null = 0) {
	fs.writeFileSync(path.join(meta.artifactDir, "completed.json"), JSON.stringify({
		exitCode, exitedAt: "2026-01-01T00:00:00.000Z",
	}));
	fs.writeFileSync(path.join(meta.artifactDir, "report.json"), JSON.stringify({
		result: { outcome, answer: "private output" },
	}));
}

function runtime(options: any = {}, implementation: typeof extension = extension) {
	const handlers = new Map<string, (...args: any[]) => any>();
	let tool: any;
	const pi = {
		registerTool: (value: any) => { tool = value; },
		on: (name: string, callback: (...args: any[]) => any) => { handlers.set(name, callback); },
		events: { emit: vi.fn() }, sendMessage: vi.fn(), sendUserMessage: vi.fn(),
	};
	implementation.default(pi as any, options);
	const ctx = (id = OWNER, file: string | undefined = "/synthetic/session.jsonl") => ({
		cwd: process.cwd(), hasUI: false,
		sessionManager: { getSessionId: () => id, getSessionFile: () => file },
	});
	return { pi, handlers, tool, ctx };
}

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	execution.spawn.mockReset();
	execution.spawn.mockImplementation(() => { throw new Error("Unconfigured test spawn boundary"); });
	vi.useRealTimers();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("async observation ownership and durable evidence", () => {
	it("captures a bounded UUID independently from the compatibility session path", () => {
		expect(observation.captureAsyncOwner).toBeTypeOf("function");
		expect(observation.captureAsyncOwner({
			getSessionId: () => OWNER, getSessionFile: () => "/synthetic/session.jsonl",
		})).toEqual({ ownerSessionId: OWNER, ownerSessionFile: "/synthetic/session.jsonl" });
		expect(observation.captureAsyncOwner({ getSessionId: () => "x".repeat(5000) })).toBeUndefined();
		expect(observation.captureAsyncOwner({ getSessionId: () => OWNER, getSessionFile: () => "x".repeat(5000) }))
			.toEqual({ ownerSessionId: OWNER });
	});

	it("ignores unavailable owner methods and unsafe session-file values", () => {
		expect(observation.captureAsyncOwner({ getSessionId: () => { throw new Error("private"); } }))
			.toBeUndefined();
		expect(observation.captureAsyncOwner({ getSessionId: () => OWNER, getSessionFile: () => "/bad\nfile" }))
			.toEqual({ ownerSessionId: OWNER });
	});

	it("recovers only UUID-owned records without adopting legacy or mismatched owners", async () => {
		const root = rootDir();
		const owned = artifact(root, "owned"); complete(owned);
		const other = artifact(root, "other", OTHER); complete(other);
		const legacy = artifact(root, "legacy", null); complete(legacy);
		expect(extension.readAsyncRunObservations).toBeTypeOf("function");
		const rows = await extension.readAsyncRunObservations(OWNER, root);
		expect(rows).toMatchObject([{ runId: "owned", ownerSessionId: OWNER, state: "completed" }]);
		expect(JSON.stringify(rows)).not.toMatch(/private task|private output|12345/);
		await expect(extension.findRunMeta("legacy", root)).resolves.toMatchObject({ runId: "legacy" });
		expect(Object.isFrozen(rows)).toBe(true);
		expect(Object.isFrozen(rows[0])).toBe(true);
	});

	it.each([
		{ ownerSessionId: OTHER.repeat(200) }, { ownerSessionId: "not-a-uuid" },
		{ ownerSessionId: OWNER, ownerSessionFile: "/bad\npath" },
		{ ownerSessionFile: "/orphan/path" },
	])("rejects malformed persisted ownership %j", async (fields) => {
		const root = rootDir();
		const meta = artifact(root, "bad");
		const { ownerSessionId: _id, ownerSessionFile: _file, ...legacy } = meta as any;
		fs.writeFileSync(path.join(meta.artifactDir, "run-meta.json"), JSON.stringify({ ...legacy, ...fields }));
		await expect(extension.findRunMeta("bad", root)).resolves.toBeUndefined();
	});

	it("keeps recovered activity unknown without probing or signaling its PID", async () => {
		const root = rootDir(); artifact(root, "unknown");
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		const rows = await extension.readAsyncRunObservations(OWNER, root);
		expect(rows).toMatchObject([{ state: "unknown" }]);
		expect(kill).not.toHaveBeenCalled();
	});

	it.each(["missing", "invalid-json", "empty", "bad-exit", "bad-date", "bad-calendar"])(
		"never treats a %s completion marker as success", async (marker) => {
			const root = rootDir(); const meta = artifact(root, "invalid"); complete(meta);
			const markerPath = path.join(meta.artifactDir, "completed.json");
			if (marker === "missing") fs.unlinkSync(markerPath);
			else fs.writeFileSync(markerPath, ({
				"invalid-json": "{", empty: "{}", "bad-exit": '{"exitCode":"0","exitedAt":"2026-01-01"}',
				"bad-date": '{"exitCode":0,"exitedAt":"yesterday"}',
				"bad-calendar": '{"exitCode":0,"exitedAt":"2026-02-31T00:00:00.000Z"}',
			} as any)[marker]);
			expect(await extension.readAsyncRunObservations(OWNER, root)).toMatchObject([{ state: "unknown" }]);
		},
	);

	it.each(["missing", "malformed", "rejected", "bootstrap", "exit", "spawn-error"])(
		"validates %s terminal reports through the existing failure policy", async (report) => {
			const root = rootDir(); const meta = artifact(root, "failed"); complete(meta);
			const reportPath = path.join(meta.artifactDir, "report.json");
			if (report === "missing") fs.unlinkSync(reportPath);
			if (report === "malformed") fs.writeFileSync(reportPath, "{}");
			if (report === "rejected") complete(meta, "failed");
			if (report === "exit") complete(meta, "success", 1);
			if (report === "spawn-error") fs.writeFileSync(path.join(meta.artifactDir, "spawn-error.txt"), "private failure");
			if (report === "bootstrap") {
				fs.writeFileSync(reportPath, JSON.stringify({ result: { outcome: "success" }, sandbox: { mode: "agentfs" } }));
			}
			expect(await extension.readAsyncRunObservations(OWNER, root)).toMatchObject([{ state: "failed" }]);
		},
	);

	it("caps recovered rows and ignores oversized artifacts", async () => {
		const root = rootDir();
		for (let i = 0; i < 105; i++) complete(artifact(root, `run-${i}`));
		const rows = await extension.readAsyncRunObservations(OWNER, root);
		expect(rows.length).toBeLessThanOrEqual(100);
		const hugeRoot = rootDir(); const huge = artifact(hugeRoot, "huge"); complete(huge);
		fs.writeFileSync(path.join(huge.artifactDir, "report.json"), " ".repeat(2 * 1024 * 1024));
		expect(await extension.readAsyncRunObservations(OWNER, hugeRoot)).toMatchObject([{ state: "failed" }]);
	});
});

describe("session-scoped async observation lifecycle", () => {
	it("bounds scan work and rejects stale or symlinked evidence", async () => {
		const root = rootDir(); const meta = artifact(root, "stale"); complete(meta);
		fs.writeFileSync(path.join(meta.artifactDir, "completed.json"), JSON.stringify({
			exitCode: 0, exitedAt: "1970-01-01T00:00:00.000Z",
		}));
		expect(await extension.readAsyncRunObservations(OWNER, root)).toMatchObject([{ state: "unknown" }]);
		complete(meta);
		fs.renameSync(path.join(meta.artifactDir, "report.json"), path.join(root, "report-copy.json"));
		fs.symlinkSync(path.join(root, "report-copy.json"), path.join(meta.artifactDir, "report.json"));
		expect(await extension.readAsyncRunObservations(OWNER, root)).toMatchObject([{ state: "failed" }]);
		for (let i = 0; i < 600; i++) fs.mkdirSync(path.join(root, `empty-${i}`));
		const open = vi.spyOn(fs.promises, "open");
		await extension.readAsyncRunObservations(OWNER, root);
		expect(open.mock.calls.length).toBeLessThanOrEqual(260);
	});

	it("starts no resources or adapter registrations in the extension factory", () => {
		const adapter = vi.fn();
		const timer = vi.spyOn(globalThis, "setTimeout");
		const read = vi.spyOn(fs.promises, "opendir");
		runtime({ observationAdapter: adapter, artifactRoot: rootDir() });
		expect(adapter).not.toHaveBeenCalled();
		expect(timer).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
	});

	it("preserves standalone status/resume and legacy manual queries without an adapter", async () => {
		const root = rootDir(); const meta = artifact(root, "legacy", null); complete(meta);
		const r = runtime({ artifactRoot: root });
		for (const action of ["status", "resume"]) {
			const result = await r.tool.execute("call", { action, id: "legacy" }, undefined, undefined, r.ctx(OTHER));
			expect(result.isError).not.toBe(true);
			if (action === "resume") expect(result.content[0].text).toContain("private output");
		}
		expect(r.pi.events.emit).not.toHaveBeenCalled();
	});

	it("rehydrates on start, replaces sessions, and ignores a stale shutdown", async () => {
		const root = rootDir(); complete(artifact(root, "owned"));
		const registrations: any[] = [];
		const adapter = vi.fn((context: any) => {
			const registration = { context, update: vi.fn(), dispose: vi.fn() };
			registrations.push(registration); return registration;
		});
		const r = runtime({ artifactRoot: root, observationAdapter: adapter });
		expect(r.handlers.get("session_start")).toBeTypeOf("function");
		await r.handlers.get("session_start")!({}, r.ctx());
		expect(registrations[0].update).toHaveBeenLastCalledWith(expect.arrayContaining([
			expect.objectContaining({ runId: "owned", state: "completed" }),
		]));
		await r.handlers.get("session_start")!({}, r.ctx(OTHER, "/synthetic/other.jsonl"));
		expect(registrations[0].dispose).toHaveBeenCalledTimes(1);
		expect(registrations[1].update).toHaveBeenLastCalledWith([]);
		await r.handlers.get("session_shutdown")!({}, r.ctx());
		expect(registrations[1].dispose).not.toHaveBeenCalled();
		await r.handlers.get("session_shutdown")!({}, r.ctx(OTHER));
		expect(registrations[1].dispose).toHaveBeenCalledTimes(1);
		expect(r.pi.sendMessage).not.toHaveBeenCalled();
		expect(r.pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it.each(["replace", "shutdown", "reload"])(
		"does not reactivate a stale session after %s during async approval", async (change) => {
			vi.stubEnv("PI_SWIVAL_TRUST_PROJECT_AGENTS", "0");
			await extension.preflightSwivalVersion(async () => "1.0.45");
			const root = fs.realpathSync(rootDir());
			const agentDir = path.join(root, ".pi", "swival-agents");
			fs.mkdirSync(agentDir, { recursive: true });
			fs.writeFileSync(path.join(agentDir, "project-test.md"),
				"---\nname: project-test\ndescription: Synthetic project agent\n---\nSynthetic prompt");
			const registrations: any[] = [];
			const options = { artifactRoot: root, trustProjectAgents: false, observationAdapter: () => {
				const value = { update: vi.fn(), dispose: vi.fn() }; registrations.push(value); return value;
			} };
			const r = runtime(options);
			let approve!: (value: boolean) => void;
			const ctx = { ...r.ctx(), cwd: root, hasUI: true,
				ui: { confirm: vi.fn(() => new Promise<boolean>((resolve) => { approve = resolve; })) } };
			await r.handlers.get("session_start")!({}, ctx);
			const pending = r.tool.execute("call", { agent: "project-test", task: "task",
				agentScope: "project", async: true }, undefined, undefined, ctx);
			expect(ctx.ui.confirm).toHaveBeenCalledOnce();
			let current = r; let currentCtx: any = ctx;
			if (change === "replace") {
				currentCtx = { ...r.ctx(OTHER, "/synthetic/other.jsonl"), cwd: root };
				await r.handlers.get("session_start")!({}, currentCtx);
			} else {
				await r.handlers.get("session_shutdown")!({}, ctx);
				if (change === "reload") {
					current = runtime(options); currentCtx = { ...current.ctx(), cwd: root };
					await current.handlers.get("session_start")!({}, currentCtx);
				}
			}
			const count = registrations.length;
			const proc = new EventEmitter() as any;
			proc.pid = undefined; proc.unref = vi.fn(); execution.spawn.mockReturnValue(proc);
			approve(true); const result = await pending;
			expect(result.isError).not.toBe(true);
			expect(registrations).toHaveLength(count);
			if (change !== "shutdown") expect(registrations.at(-1)!.dispose).not.toHaveBeenCalled();
			const artifactDir = (execution.spawn.mock.calls as any)[0][1][1];
			expect(JSON.parse(fs.readFileSync(path.join(artifactDir, "run-meta.json"), "utf8")))
				.toMatchObject({ ownerSessionId: OWNER, ownerSessionFile: "/synthetic/session.jsonl" });
			proc.emit("close", 1);
			await current.handlers.get("session_shutdown")!({}, currentCtx);
		},
	);

	it.each([
		{ replacement: "same-owner runtime", owner: OWNER, reload: true },
		{ replacement: "foreign-owner runtime", owner: OTHER, reload: true },
		{ replacement: "same-owner session start", owner: OWNER, reload: false },
	])("retires approval before session_start without displacing a $replacement", async ({ owner, reload }) => {
		vi.stubEnv("PI_SWIVAL_TRUST_PROJECT_AGENTS", "0");
		await extension.preflightSwivalVersion(async () => "1.0.45");
		const root = fs.realpathSync(rootDir());
		const agentDir = path.join(root, ".pi", "swival-agents");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "project-test.md"),
			"---\nname: project-test\ndescription: Synthetic project agent\n---\nSynthetic prompt");
		vi.useFakeTimers();
		const subscriptions = new Set<() => void>();
		const observers: any[] = [];
		const createObserver = observation.createAsyncObservation;
		vi.spyOn(observation, "createAsyncObservation").mockImplementation((options: any) => {
			const observer = createObserver({ ...options, subscribe(callback: () => void) {
				const unsubscribe = options.subscribe(callback);
				subscriptions.add(callback);
				return () => { subscriptions.delete(callback); unsubscribe(); };
			} });
			observers.push(observer); return observer;
		});
		let provider: any;
		const providerDisposers: ReturnType<typeof vi.fn>[] = [];
		const api = {
			registerExternalRun: vi.fn((run: any) => run),
			updateExternalRun: vi.fn(), unregisterExternalRun: vi.fn(),
			registerBackgroundWorkProvider: vi.fn((value: any) => {
				provider = value;
				const dispose = vi.fn(() => { if (provider === value) provider = undefined; });
				providerDisposers.push(dispose); return dispose;
			}),
		};
		const adapter = vi.fn(createPiSubagentsAdapter(api));
		const r = runtime({ artifactRoot: root, observationAdapter: adapter });
		let approve!: (value: boolean) => void;
		const ctx = { ...r.ctx(), cwd: root, hasUI: true,
			ui: { confirm: vi.fn(() => new Promise<boolean>((resolve) => { approve = resolve; })) } };
		disposers.push(() => r.handlers.get("session_shutdown")!({}, ctx));
		// Deliberately omit session_start: tool use is an independent lifecycle entry point.
		const pending = r.tool.execute("call", { agent: "project-test", task: "task",
			agentScope: "project", async: true }, undefined, undefined, ctx);
		expect(ctx.ui.confirm).toHaveBeenCalledOnce();
		expect(adapter).not.toHaveBeenCalled(); expect(subscriptions.size).toBe(0);
		await r.handlers.get("session_shutdown")!({}, ctx);
		const current = reload ? runtime({ artifactRoot: root, observationAdapter: adapter }) : r;
		const currentCtx = { ...current.ctx(owner), cwd: root };
		disposers.push(() => current.handlers.get("session_shutdown")!({}, currentCtx));
		artifact(root, "replacement-unknown", owner);
		await current.handlers.get("session_start")!({}, currentCtx);
		const currentProvider = provider;
		expect(vi.getTimerCount()).toBe(1);
		const proc = new EventEmitter() as any;
		proc.pid = undefined; proc.unref = vi.fn(); execution.spawn.mockReturnValue(proc);
		approve(true); const result = await pending;
		await Promise.all(observers.map((observer) => observer.refresh()));
		// The launch still proceeds with its captured owner; only observation is retired.
		expect(result.isError).not.toBe(true);
		expect(execution.spawn).toHaveBeenCalledOnce();
		const artifactDir = (execution.spawn.mock.calls as any)[0][1][1];
		expect(JSON.parse(fs.readFileSync(path.join(artifactDir, "run-meta.json"), "utf8")))
			.toMatchObject({ ownerSessionId: OWNER, ownerSessionFile: "/synthetic/session.jsonl" });
		expect.soft(adapter).toHaveBeenCalledOnce();
		expect.soft(api.registerBackgroundWorkProvider).toHaveBeenCalledOnce();
		expect.soft(provider).toBe(currentProvider);
		expect.soft(providerDisposers[0]).not.toHaveBeenCalled();
		expect.soft(subscriptions.size).toBe(1);
		expect.soft(vi.getTimerCount()).toBe(1);
		if (reload) {
			await r.handlers.get("session_shutdown")!({}, ctx);
			expect.soft(provider).toBe(currentProvider);
		}
		await current.handlers.get("session_shutdown")!({}, currentCtx);
		expect.soft(subscriptions.size).toBe(0);
		expect.soft(vi.getTimerCount()).toBe(0);
		proc.emit("close", 1);
		if (reload) expect.soft(r.pi.events.emit).not.toHaveBeenCalled();
	});

	it("ignores a foreign shutdown while first-use approval is pending", async () => {
		vi.stubEnv("PI_SWIVAL_TRUST_PROJECT_AGENTS", "0");
		await extension.preflightSwivalVersion(async () => "1.0.45");
		const root = fs.realpathSync(rootDir());
		const agentDir = path.join(root, ".pi", "swival-agents");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "project-test.md"),
			"---\nname: project-test\ndescription: Synthetic project agent\n---\nSynthetic prompt");
		const dispose = vi.fn();
		const adapter = vi.fn(() => ({ update: vi.fn(), dispose }));
		const r = runtime({ artifactRoot: root, observationAdapter: adapter });
		let approve!: (value: boolean) => void;
		const ctx = { ...r.ctx(), cwd: root, hasUI: true,
			ui: { confirm: vi.fn(() => new Promise<boolean>((resolve) => { approve = resolve; })) } };
		disposers.push(() => r.handlers.get("session_shutdown")!({}, ctx));
		const pending = r.tool.execute("call", { agent: "project-test", task: "task",
			agentScope: "project", async: true }, undefined, undefined, ctx);
		expect(ctx.ui.confirm).toHaveBeenCalledOnce();
		await r.handlers.get("session_shutdown")!({}, r.ctx(OTHER));
		const proc = new EventEmitter() as any;
		proc.pid = undefined; proc.unref = vi.fn(); execution.spawn.mockReturnValue(proc);
		approve(true); const result = await pending;
		expect(result.isError).not.toBe(true);
		expect(adapter).toHaveBeenCalledOnce();
		expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
			owner: { ownerSessionId: OWNER, ownerSessionFile: "/synthetic/session.jsonl" },
		}));
		expect(dispose).not.toHaveBeenCalled();
		await r.handlers.get("session_shutdown")!({}, ctx);
		expect(dispose).toHaveBeenCalledOnce();
		proc.emit("close", 1);
	});

	it("uses cached transitions, unrefs timers, and makes retired callbacks harmless", async () => {
		vi.useFakeTimers();
		let changed: () => void = () => {};
		let rows: any[] = [{ runId: "r", ownerSessionId: OWNER, state: "running" }];
		const readSnapshot = vi.fn(async () => rows);
		const update = vi.fn(); const dispose = vi.fn(); const wake = vi.fn(); const unsubscribe = vi.fn();
		const observer = observation.createAsyncObservation({
			owner: { ownerSessionId: OWNER }, adapter: () => ({ update, dispose }),
			readSnapshot, subscribe: (callback: () => void) => { changed = callback; return unsubscribe; },
			emitWake: wake, onDiagnostic: vi.fn(),
		});
		disposers.push(observer.dispose);
		await observer.refresh();
		await observer.refresh();
		expect(wake).toHaveBeenCalledTimes(1);
		rows = [{ ...rows[0], state: "failed" }]; changed();
		await observer.refresh();
		expect(wake).toHaveBeenCalledTimes(2);
		await observer.refresh(); expect(wake).toHaveBeenCalledTimes(2);
		observer.dispose(); observer.dispose(); changed();
		await vi.advanceTimersByTimeAsync(5000);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("discards an in-flight snapshot after disposal", async () => {
		let resolve!: (rows: any[]) => void;
		const update = vi.fn(); const wake = vi.fn();
		const observer = observation.createAsyncObservation({
			owner: { ownerSessionId: OWNER }, adapter: () => ({ update, dispose: vi.fn() }),
			readSnapshot: () => new Promise((done) => { resolve = done; }),
			subscribe: () => () => {}, emitWake: wake, onDiagnostic: vi.fn(),
		});
		const pending = observer.refresh(); observer.dispose(); resolve([{ state: "completed" }]); await pending;
		expect(update).not.toHaveBeenCalled(); expect(wake).not.toHaveBeenCalled();
	});

	it("isolates throwing wake, diagnostic, update and teardown callbacks", async () => {
		const fail = () => { throw new Error("private error"); };
		const unsubscribe = vi.fn(fail); const dispose = vi.fn(fail);
		const observer = observation.createAsyncObservation({
			owner: { ownerSessionId: OWNER }, adapter: () => ({ update: fail, dispose }),
			readSnapshot: async () => [{ runId: "r", ownerSessionId: OWNER, state: "completed" }],
			subscribe: () => unsubscribe, emitWake: fail, onDiagnostic: fail,
		});
		await expect(observer.refresh()).resolves.toBeUndefined();
		expect(() => { observer.dispose(); observer.dispose(); }).not.toThrow();
		expect(dispose).toHaveBeenCalledOnce(); expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("reports unavailable artifact storage without exposing the filesystem error", async () => {
		const diagnostic = vi.fn(); const root = rootDir();
		vi.spyOn(fs.promises, "opendir").mockRejectedValue(new Error("private storage failure"));
		const r = runtime({ artifactRoot: root, onObservationDiagnostic: diagnostic });
		await r.handlers.get("session_start")!({}, r.ctx());
		expect(diagnostic).toHaveBeenCalledWith("Async observation unavailable.");
		expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private storage");
		await r.handlers.get("session_shutdown")!({}, r.ctx());
	});

	it("unrefs its reconciliation timer and releases it on disposal", async () => {
		const timer = vi.spyOn(globalThis, "setTimeout");
		const observer = observation.createAsyncObservation({
			owner: { ownerSessionId: OWNER }, readSnapshot: async () => [
				{ runId: "r", ownerSessionId: OWNER, state: "unknown" },
			], subscribe: () => () => {}, emitWake: vi.fn(), onDiagnostic: vi.fn(),
		});
		disposers.push(observer.dispose);
		await observer.refresh();
		expect(timer.mock.results.at(-1)!.value.hasRef()).toBe(false);
		observer.dispose();
	});

	it("rehydrates a replacement runtime without letting an old refresh publish", async () => {
		const root = rootDir(); complete(artifact(root, "owned"));
		const registrations: any[] = [];
		const adapter = (context: any) => {
			const value = { context, update: vi.fn(), dispose: vi.fn() };
			registrations.push(value); return value;
		};
		const first = runtime({ artifactRoot: root, observationAdapter: adapter });
		await first.handlers.get("session_start")!({}, first.ctx());
		await first.handlers.get("session_shutdown")!({}, first.ctx());
		const next = runtime({ artifactRoot: root, observationAdapter: adapter });
		await next.handlers.get("session_start")!({}, next.ctx());
		expect(registrations[1].update).toHaveBeenLastCalledWith(expect.arrayContaining([
			expect.objectContaining({ runId: "owned", state: "completed" }),
		]));
		const calls = registrations[1].update.mock.calls.length;
		await first.handlers.get("session_shutdown")!({}, first.ctx());
		expect(registrations[1].dispose).not.toHaveBeenCalled();
		expect(registrations[1].update).toHaveBeenCalledTimes(calls);
		await next.handlers.get("session_shutdown")!({}, next.ctx());
	});

	it("surfaces bounded adapter failure without changing manual result success", async () => {
		const root = rootDir(); const meta = artifact(root, "ok"); complete(meta);
		const diagnostic = vi.fn();
		const r = runtime({ artifactRoot: root, observationAdapter: () => { throw new Error("private failure"); },
			onObservationDiagnostic: diagnostic });
		await r.handlers.get("session_start")!({}, r.ctx());
		const result = await r.tool.execute("call", { action: "resume", id: "ok" }, undefined, undefined, r.ctx());
		expect(result.isError).not.toBe(true);
		expect(diagnostic).toHaveBeenCalledWith(expect.stringMatching(/unavailable/i));
		expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private failure");
	});
});

describe("async launch observation", () => {
	it.each(["launch", "older"])(
		"publishes acknowledged local activity while the %s artifact scan is deferred", async (scan) => {
			await extension.preflightSwivalVersion(async () => "1.0.45");
			const root = fs.realpathSync(rootDir());
			const agentDir = path.join(root, ".pi", "swival-agents");
			fs.mkdirSync(agentDir, { recursive: true });
			fs.writeFileSync(path.join(agentDir, "project-test.md"),
				"---\nname: project-test\ndescription: Synthetic project agent\n---\nSynthetic prompt");
			let observer: any;
			const createObserver = observation.createAsyncObservation;
			vi.spyOn(observation, "createAsyncObservation").mockImplementation((options: any) => {
				observer = createObserver(options); return observer;
			});
			let provider: any;
			const api = {
				registerExternalRun: vi.fn((run: any) => run),
				updateExternalRun: vi.fn(), unregisterExternalRun: vi.fn(),
				registerBackgroundWorkProvider: vi.fn((value: any) => {
					provider = value; return () => { if (provider === value) provider = undefined; };
				}),
			};
			const adapter = createPiSubagentsAdapter(api);
			const published = vi.fn();
			const r = runtime({ artifactRoot: root, trustProjectAgents: true,
				observationAdapter: (context: any) => {
					const registration = adapter(context);
					return { ...registration, update(rows: any[]) {
						published(rows); registration.update(rows);
					} };
				} });
			const ctx = { ...r.ctx(), cwd: root };
			disposers.push(() => r.handlers.get("session_shutdown")!({}, ctx));
			await r.handlers.get("session_start")!({}, ctx);
			expect(provider.listActiveWork()).toEqual([]);
			let release!: (directory: any) => void;
			let entered: (() => void) | undefined;
			let holdNext = true;
			let observationReads = 0;
			const openDirectory = fs.promises.opendir.bind(fs.promises);
			vi.spyOn(fs.promises, "opendir").mockImplementation((dir: any, ...args: any[]) => {
				if (path.resolve(String(dir)) === root) {
					observationReads++;
					if (holdNext) {
						holdNext = false;
						return new Promise((resolve) => { release = resolve; entered?.(); });
					}
				}
				return (openDirectory as any)(dir, ...args);
			});
			const older = scan === "older" ? observer.refresh() : undefined;
			const proc = new EventEmitter() as any;
			proc.pid = undefined; proc.unref = vi.fn(); execution.spawn.mockReturnValue(proc);
			try {
				const result = await r.tool.execute("call", { agent: "project-test", task: "task",
					agentScope: "project", async: true }, undefined, undefined, ctx);
				expect(result.isError).not.toBe(true);
				const artifactDir = (execution.spawn.mock.calls as any)[0][1][1];
				const { runId } = JSON.parse(fs.readFileSync(path.join(artifactDir, "run-meta.json"), "utf8"));
				// No refresh or asynchronous observation work is required after the acknowledgement.
				expect.soft(provider.listActiveWork()).toEqual([{ id: runId, sessionId: "/synthetic/session.jsonl" }]);
				expect(observationReads).toBe(1);
				published.mockClear();
				release({ async *[Symbol.asyncIterator]() {} });
				await (older ?? observer.refresh());
				expect.soft(published.mock.calls.every(([rows]) => rows.some((row: any) => row.runId === runId
					&& row.state === "running"))).toBe(true);
				expect(provider.listActiveWork()).toEqual([{ id: runId, sessionId: "/synthetic/session.jsonl" }]);
				// A later read cannot revive the registration after shutdown.
				const deferred = new Promise<void>((resolve) => { entered = resolve; });
				holdNext = true;
				const retired = observer.refresh();
				await deferred;
				await r.handlers.get("session_shutdown")!({}, ctx);
				published.mockClear();
				release({ async *[Symbol.asyncIterator]() {} });
				await retired;
				expect(provider).toBeUndefined(); expect(published).not.toHaveBeenCalled();
			} finally {
				release?.({ async *[Symbol.asyncIterator]() {} });
				await r.handlers.get("session_shutdown")!({}, ctx);
				proc.emit("close", 1);
			}
		},
	);

	it("selects live local work before 100 retained terminal runs in core and cached observations", async () => {
		vi.resetModules();
		const fresh = await import("../extensions/index.js");
		const freshObservation = await import("../extensions/async-observation.js");
		await fresh.preflightSwivalVersion(async () => "1.0.45");
		const root = rootDir();
		const owner = { ownerSessionId: OWNER, ownerSessionFile: "/synthetic/session.jsonl" };
		const agent: any = { name: "test", source: "user", description: "test", systemPrompt: "", filePath: "/test.md" };
		for (let i = 0; i < 100; i++) {
			const proc = new EventEmitter() as any;
			proc.pid = undefined; proc.unref = vi.fn(); execution.spawn.mockReturnValue(proc);
			await fresh.runSingleSwivalAsync(root, [agent], "test", "task", undefined, {}, root, owner);
			proc.emit("close", 1);
		}
		let observer: any;
		const createObserver = freshObservation.createAsyncObservation;
		vi.spyOn(freshObservation, "createAsyncObservation").mockImplementation((options: any) => {
			observer = createObserver(options); return observer;
		});
		let provider: any;
		const api = {
			registerExternalRun: vi.fn((run: any) => run),
			updateExternalRun: vi.fn(), unregisterExternalRun: vi.fn(),
			registerBackgroundWorkProvider: vi.fn((value: any) => {
				provider = value; return () => { if (provider === value) provider = undefined; };
			}),
		};
		const r = runtime({ artifactRoot: root, observationAdapter: createPiSubagentsAdapter(api) }, fresh);
		disposers.push(() => r.handlers.get("session_shutdown")!({}, r.ctx()));
		await r.handlers.get("session_start")!({}, r.ctx());
		const proc = new EventEmitter() as any;
		proc.pid = undefined; proc.unref = vi.fn(); execution.spawn.mockReturnValue(proc);
		const live = await fresh.runSingleSwivalAsync(root, [agent], "test", "task", undefined, {}, root, owner);
		try {
			await observer.refresh();
			expect.soft(provider.listActiveWork()).toEqual([{ id: live.runId, sessionId: owner.ownerSessionFile }]);
			const open = vi.spyOn(fs.promises, "open");
			const rows = await fresh.readAsyncRunObservations(OWNER, root);
			expect.soft(rows).toContainEqual(expect.objectContaining({ runId: live.runId, state: "running" }));
			expect(rows).toHaveLength(100);
			expect(open.mock.calls.length).toBeLessThanOrEqual(200);
		} finally {
			await r.handlers.get("session_shutdown")!({}, r.ctx()); proc.emit("close", 1);
		}
	});

	it("uses a local handle for running and leaves explicit result retrieval unchanged", async () => {
		await extension.preflightSwivalVersion(async () => "1.0.45");
		const root = rootDir(); const proc = new EventEmitter() as any;
		proc.pid = undefined; proc.unref = vi.fn(); execution.spawn.mockReturnValue(proc);
		const agent: any = { name: "test", source: "user", description: "test", systemPrompt: "", filePath: "/test.md" };
		const launched = await extension.runSingleSwivalAsync(root, [agent], "test", "task", undefined, {}, root,
			{ ownerSessionId: OWNER });
		expect((execution.spawn.mock.calls as any)[0][1].slice(-2)).toEqual(["--", "task"]);
		expect(await extension.readAsyncRunObservations(OWNER, root)).toMatchObject([{ state: "running" }]);
		const meta = JSON.parse(fs.readFileSync(path.join(launched.artifactDir, "run-meta.json"), "utf8"));
		complete(meta); proc.emit("close", 0);
		expect(await extension.readAsyncRunObservations(OWNER, root)).toMatchObject([{ state: "completed" }]);
		const r = runtime({ artifactRoot: root });
		const result = await r.tool.execute("call", { action: "resume", id: launched.runId }, undefined, undefined, r.ctx());
		expect(result.isError).not.toBe(true); expect(result.content[0].text).toContain("private output");
	});

	it("captures owner data before launch awaits and never adopts an ownerless launch", async () => {
		await extension.preflightSwivalVersion(async () => "1.0.45");
		const root = rootDir(); const proc = new EventEmitter() as any;
		proc.pid = undefined; proc.unref = vi.fn(); execution.spawn.mockReturnValue(proc);
		const agent: any = { name: "test", source: "user", description: "test", systemPrompt: "", filePath: "/test.md" };
		const owner = { ownerSessionId: OWNER };
		const launching = extension.runSingleSwivalAsync(root, [agent], "test", "task", undefined, {}, root, owner);
		owner.ownerSessionId = OTHER;
		const launched = await launching;
		const meta = JSON.parse(fs.readFileSync(path.join(launched.artifactDir, "run-meta.json"), "utf8"));
		expect(meta.ownerSessionId).toBe(OWNER); proc.emit("close", 1);
		const legacyRoot = rootDir(); const legacyProc = new EventEmitter() as any;
		legacyProc.pid = undefined; legacyProc.unref = vi.fn(); execution.spawn.mockReturnValue(legacyProc);
		const legacy = await extension.runSingleSwivalAsync(legacyRoot, [agent], "test", "task", undefined, {}, legacyRoot);
		expect(JSON.parse(fs.readFileSync(path.join(legacy.artifactDir, "run-meta.json"), "utf8")))
			.not.toHaveProperty("ownerSessionId");
		expect(await extension.readAsyncRunObservations(OWNER, legacyRoot)).toEqual([]);
		legacyProc.emit("close", 1);
	});

	it.each(["close", "error"])("persists launch ownership and observes an early %s without stranding execution", async (event) => {
		await extension.preflightSwivalVersion(async () => "1.0.45");
		const root = rootDir();
		const proc = new EventEmitter() as any;
		proc.pid = undefined; proc.unref = vi.fn();
		execution.spawn.mockImplementation(() => {
			queueMicrotask(() => proc.emit(event, event === "close" ? 0 : new Error("synthetic spawn error")));
			return proc;
		});
		const owner = { ownerSessionId: OWNER, ownerSessionFile: "/synthetic/session.jsonl" };
		const agent: any = { name: "test", source: "user", description: "test", systemPrompt: "", filePath: "/synthetic/test.md" };
		const result = await extension.runSingleSwivalAsync(root, [agent], "test", "task", undefined, {}, root, owner);
		expect(result.runId).toMatch(/^swival-run-/);
		const meta = JSON.parse(fs.readFileSync(path.join(result.artifactDir, "run-meta.json"), "utf8"));
		expect(meta).toMatchObject(owner);
		expect(proc.unref).toHaveBeenCalledOnce();
		const rows = await extension.readAsyncRunObservations(OWNER, root);
		expect(rows).toMatchObject([{ runId: result.runId, state: "failed" }]);
	});
});
