import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { setImmediate as realImmediate, setTimeout as realTimeout } from "node:timers";
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

// Real temporary artifacts and synthetic handles only; never invoke a provider.
async function indexedFixture() {
	vi.resetModules();
	const fresh = await import("../extensions/index.js");
	const observed = await import("../extensions/async-observation.js");
	await fresh.preflightSwivalVersion(async () => "1.0.45");
	const root = rootDir();
	const owner = { ownerSessionId: OWNER, ownerSessionFile: "/synthetic/session.jsonl" };
	const agent: any = { name: "test", source: "user", description: "test", systemPrompt: "", filePath: "/test.md" };
	const handles: any[] = [];
	let tick = Date.now() - 100_000;
	vi.spyOn(Date, "now").mockImplementation(() => tick++);
	async function launch(id = OWNER, event?: "close" | "error", pid?: number) {
		const proc = new EventEmitter() as any;
		proc.pid = pid; proc.unref = vi.fn(); handles.push(proc);
		execution.spawn.mockImplementation(() => {
			if (event) queueMicrotask(() => proc.emit(event, event === "close" ? 1 : new Error("synthetic")));
			return proc;
		});
		const run = await fresh.runSingleSwivalAsync(root, [agent], "test", "private task", undefined, {}, root,
			{ ...owner, ownerSessionId: id });
		const meta = JSON.parse(fs.readFileSync(path.join(run.artifactDir, "run-meta.json"), "utf8"));
		return { ...run, proc, meta };
	}
	let observer: any;
	const create = observed.createAsyncObservation;
	vi.spyOn(observed, "createAsyncObservation").mockImplementation((options: any) => {
		observer = create(options); return observer;
	});
	let provider: any;
	const api = {
		registerExternalRun: vi.fn((run: any) => run), updateExternalRun: vi.fn(), unregisterExternalRun: vi.fn(),
		registerBackgroundWorkProvider: vi.fn((value: any) => { provider = value; return () => { provider = undefined; }; }),
	};
	const published = vi.fn(); const diagnostic = vi.fn(); const waitCounts: number[] = [];
	const adapter = createPiSubagentsAdapter(api);
	const r = runtime({ artifactRoot: root, onObservationDiagnostic: diagnostic, observationAdapter: (context: any) => {
		const registration = adapter(context);
		return { ...registration, update(rows: any[]) {
			published(rows); registration.update(rows); waitCounts.push(provider.listActiveWork().length);
		} };
	} }, fresh);
	disposers.push(() => { observer?.dispose(); for (const proc of handles) proc.emit("close", 1); });
	return { fresh, root, owner, launch, api, published, diagnostic, waitCounts, r,
		observer: () => observer, provider: () => provider,
		start: () => r.handlers.get("session_start")!({}, r.ctx()) };
}

function finishRun(run: any, success = false) {
	fs.writeFileSync(path.join(run.artifactDir, "report.json"), JSON.stringify({ result: { outcome: success ? "success" : "failed" } }));
	run.proc.emit("close", success ? 0 : 1);
}

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
		const r = runtime({ artifactRoot: root, onObservationDiagnostic: diagnostic,
			observationAdapter: () => ({ update: vi.fn(), dispose: vi.fn() }) });
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

describe("B1/B2 opt-in and owner-index regressions", () => {
	it.each(["session_start", "first launch"])("does no observation work without an adapter at %s", async (entry) => {
		vi.resetModules();
		const standalone = await import("../extensions/index.js");
		const standaloneObservation = await import("../extensions/async-observation.js");
		await standalone.preflightSwivalVersion(async () => "1.0.45");
		const root = fs.realpathSync(rootDir()); artifact(root, "owned-unknown");
		const agentDir = path.join(root, ".pi", "swival-agents");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "test.md"), "---\nname: test\ndescription: Synthetic\n---\nSynthetic prompt");
		const create = vi.spyOn(standaloneObservation, "createAsyncObservation");
		const scan = vi.spyOn(fs.promises, "opendir"); // prune uses readdir, not observation's opendir
		const timer = vi.spyOn(globalThis, "setTimeout");
		const diagnostic = vi.fn();
		const r = runtime({ artifactRoot: root, trustProjectAgents: true, onObservationDiagnostic: diagnostic }, standalone);
		const ctx = { ...r.ctx(), cwd: root };
		disposers.push(() => r.handlers.get("session_shutdown")!({}, ctx));
		if (entry === "session_start") await r.handlers.get("session_start")!({}, ctx);
		else {
			const proc = new EventEmitter() as any; proc.unref = vi.fn(); execution.spawn.mockReturnValue(proc);
			const result = await r.tool.execute("call", { agent: "test", task: "task", agentScope: "project", async: true }, undefined, undefined, ctx);
			expect(result.isError).not.toBe(true);
			const dir = (execution.spawn.mock.calls as any).at(-1)[1][1];
			expect(JSON.parse(fs.readFileSync(path.join(dir, "run-meta.json"), "utf8"))).toMatchObject({ ownerSessionId: OWNER });
			disposers.push(() => proc.emit("close", 1));
		}
		expect.soft(create).not.toHaveBeenCalled(); expect.soft(scan).not.toHaveBeenCalled();
		expect.soft(timer.mock.calls.filter(([, delay]) => delay === 1000)).toHaveLength(0);
		expect.soft(r.pi.events.emit).not.toHaveBeenCalled(); expect(diagnostic).not.toHaveBeenCalled();
		complete(artifact(root, "owned-complete"));
		for (const action of ["status", "resume"]) {
			const result = await r.tool.execute("manual", { action, id: "owned-complete" }, undefined, undefined, ctx);
			expect(result.isError).not.toBe(true);
			if (action === "resume") expect(result.content[0].text).toContain("private output");
		}
		expect(create).not.toHaveBeenCalled(); expect(scan).not.toHaveBeenCalled();
		expect(r.pi.events.emit).not.toHaveBeenCalled();
		await r.handlers.get("session_shutdown")!({}, ctx);
	});

	it.each([99, 100, 101, 256, 257])("publishes the newest launch and its terminal after %i earlier terminals", async (count) => {
		const f = await indexedFixture();
		for (let i = 0; i < count; i++) finishRun(await f.launch());
		await f.start();
		const run = await f.launch();
		// No refresh after acknowledgement: active-wait must already know the new handle.
		expect.soft(f.provider().listActiveWork()).toEqual([{ id: run.runId, sessionId: f.owner.ownerSessionFile }]);
		finishRun(run, true); await f.observer().refresh();
		expect.soft(f.published.mock.calls.some(([rows]) => rows.some((row: any) => row.runId === run.runId && row.state === "completed"))).toBe(true);
		expect.soft(f.api.updateExternalRun).toHaveBeenCalledWith(f.owner.ownerSessionFile, run.runId, expect.objectContaining({ state: "completed" }));
		const rows = await f.fresh.readAsyncRunObservations(OWNER, f.root);
		expect(rows).toHaveLength(100); expect(rows[0].runId).toBe(run.runId);
		expect(f.provider().listActiveWork()).toEqual([]);
	});

	it("publishes active-wait before the launch metadata acknowledgement after a 256 terminal prefix", async () => {
		const f = await indexedFixture();
		for (let i = 0; i < 256; i++) finishRun(await f.launch());
		await f.start();
		const write = fs.promises.writeFile.bind(fs.promises);
		let release!: () => void; let entered!: () => void;
		const writing = new Promise<void>((resolve) => { entered = resolve; });
		vi.spyOn(fs.promises, "writeFile").mockImplementation(async (file: any, ...args: any[]) => {
			if (String(file).endsWith("run-meta.json")) {
				entered(); await new Promise<void>((resolve) => { release = resolve; });
			}
			return (write as any)(file, ...args);
		});
		const pending = f.launch(); await writing;
		try { expect(f.provider().listActiveWork()).toHaveLength(1); }
		finally { release(); await pending; }
	});

	it("orders equal startedAt references by stable run ID", async () => {
		const f = await indexedFixture();
		vi.mocked(Date.now).mockReturnValue(Date.now());
		const runs = [];
		for (let i = 0; i < 101; i++) runs.push(await f.launch());
		const ordered = runs.slice().sort((a, b) => a.runId.localeCompare(b.runId));
		expect((await f.fresh.readAsyncRunObservations(OWNER, f.root)).map((row) => row.runId))
			.toEqual(ordered.slice(0, 100).map((run) => run.runId));
		for (const run of runs) finishRun(run);
		expect((await f.fresh.readAsyncRunObservations(OWNER, f.root)).map((row) => row.runId))
			.toEqual(ordered.slice(0, 100).map((run) => run.runId));
	});

	it("delivers an old selected live run's terminal before newer history displaces it", async () => {
		const f = await indexedFixture(); const old = await f.launch();
		for (let i = 0; i < 101; i++) finishRun(await f.launch());
		await f.start(); finishRun(old, true); await f.observer().refresh();
		expect(f.published.mock.calls.some(([rows]) => rows.some((row: any) => row.runId === old.runId && row.state === "completed"))).toBe(true);
		expect(f.api.updateExternalRun).toHaveBeenCalledWith(f.owner.ownerSessionFile, old.runId, expect.objectContaining({ state: "completed" }));
	});

	it("does not let foreign-owner history consume local selection budget", async () => {
		const f = await indexedFixture();
		for (let i = 0; i < 257; i++) finishRun(await f.launch(OTHER));
		await f.start(); const run = await f.launch();
		expect(f.provider().listActiveWork()).toEqual([{ id: run.runId, sessionId: f.owner.ownerSessionFile }]);
		expect(await f.fresh.readAsyncRunObservations(OWNER, f.root)).toMatchObject([{ runId: run.runId, state: "running" }]);
	});

	it.each([99, 100, 101, 257])("bounds %i live handles, diagnoses overflow, delivers terminal and refills", async (count) => {
		const f = await indexedFixture();
		for (let i = 0; i < 101; i++) finishRun(await f.launch());
		const live = [];
		for (let i = 0; i < count; i++) live.push(await f.launch());
		await f.start();
		const expected = live.slice().reverse().slice(0, 100);
		expect.soft(f.provider().listActiveWork().map((row: any) => row.id)).toEqual(expected.map((run) => run.runId));
		expect.soft(f.diagnostic.mock.calls).toEqual(count > 100 ? [["Async observation truncated; showing 100 live runs."]] : []);
		expect(f.api.registerExternalRun.mock.calls.length).toBeLessThanOrEqual(20);
		const selected = live.at(-1)!;
		finishRun(selected); await f.observer().refresh();
		expect.soft(f.api.updateExternalRun).toHaveBeenCalledWith(f.owner.ownerSessionFile, selected.runId, expect.objectContaining({ state: "failed" }));
		expect.soft(f.provider().listActiveWork().map((row: any) => row.id)).toEqual(live.slice(0, -1).reverse().slice(0, 100).map((run) => run.runId));
		expect(f.diagnostic.mock.calls.length).toBe(count > 100 ? 1 : 0);
	});

	it("never publishes false idle when all 100 selected handles exit while overflow is live", async () => {
		const f = await indexedFixture(); const runs = [];
		for (let i = 0; i < 101; i++) runs.push(await f.launch());
		await f.start(); f.waitCounts.length = 0; f.published.mockClear();
		for (const run of runs.slice(1)) finishRun(run);
		await f.observer().refresh();
		expect(f.waitCounts.every((count) => count > 0)).toBe(true);
		for (const run of runs.slice(1)) expect(f.published.mock.calls.some(([rows]) =>
			rows.some((row: any) => row.runId === run.runId && row.state === "failed"))).toBe(true);
		expect(f.provider().listActiveWork()).toEqual([{ id: runs[0].runId, sessionId: f.owner.ownerSessionFile }]);
	});

	it("delivers displayed local terminals before removal across byte-budget pages", async () => {
		const f = await indexedFixture();
		const runs = [];
		for (let i = 0; i < 28; i++) runs.push(await f.launch());
		// Attribute actual FileHandle.read bytes to the scan pass's budget object.
		const observed = await import("../extensions/async-observation.js");
		const source = vi.mocked(observed.createAsyncObservation); // populated by start()
		const originalOpen = fs.promises.open.bind(fs.promises);
		const bytesByPass = new Map<object, number>();
		let activeBudget: object | undefined;
		vi.spyOn(fs.promises, "open").mockImplementation(async (...args: any[]) => {
			const handle = await (originalOpen as any)(...args); const read = handle.read.bind(handle);
			handle.read = async (...a: any[]) => {
				const result = await read(...a);
				if (activeBudget) bytesByPass.set(activeBudget, (bytesByPass.get(activeBudget) ?? 0) + result.bytesRead);
				return result;
			};
			return handle;
		});
		await f.start();
		const recovery = source.mock.calls[0][0].recovery!;
		const local = recovery.local.bind(recovery);
		recovery.local = (ids) => local(ids).map((item) => ({ async read(budget) {
			activeBudget = budget;
			try { return await item.read(budget); } finally { activeBudget = undefined; }
		} }));
		const exiting = runs.slice(-8);
		for (const run of exiting) {
			fs.writeFileSync(path.join(run.artifactDir, "report.json"), JSON.stringify({
				result: { outcome: "success" }, padding: "x".repeat(900_000),
			}));
			run.proc.emit("close", 0);
		}
		for (let pass = 0; pass < 6; pass++) await f.observer().refresh();
		expect(bytesByPass.size).toBeGreaterThan(1);
		for (const bytes of bytesByPass.values()) expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
		process.stdout.write("B3 repair local bytes/pass " + JSON.stringify([...bytesByPass.values()]) + "\n");
		expect(f.api.registerExternalRun.mock.calls.length).toBeGreaterThanOrEqual(20);
		expect(f.published.mock.calls.every(([rows]) => rows.length <= 100)).toBe(true);
		for (const run of exiting) {
			const terminal = f.api.updateExternalRun.mock.calls.findIndex(([, id, patch]: any[]) =>
				id === run.runId && patch.state === "completed");
			const removed = f.api.unregisterExternalRun.mock.calls.findIndex(([, id]: any[]) => id === run.runId);
			expect.soft(terminal, `missing terminal update for ${run.runId}`).toBeGreaterThanOrEqual(0);
			if (terminal >= 0 && removed >= 0) {
				expect(f.api.updateExternalRun.mock.invocationCallOrder[terminal])
					.toBeLessThan(f.api.unregisterExternalRun.mock.invocationCallOrder[removed]);
			}
		}
	});

	it("delivers the last selected terminal at the row cap before incomplete-history refill", async () => {
		const f = await indexedFixture(); const runs = [];
		for (let i = 0; i < 101; i++) runs.push(await f.launch());
		for (let i = 0; i < 512; i++) fs.mkdirSync(path.join(f.root, `empty-${i}`));
		await f.start(); f.waitCounts.length = 0; f.published.mockClear();
		for (const run of runs.slice(1)) {
			fs.writeFileSync(path.join(run.artifactDir, "report.json"), JSON.stringify({
				result: { outcome: "success" }, padding: "x".repeat(60_000),
			}));
			run.proc.emit("close", 0);
		}
		for (let pass = 0; pass < 8; pass++) await f.observer().refresh();
		for (const run of runs.slice(1)) {
			const terminal = f.published.mock.calls.findIndex(([rows]) =>
				rows.some((row: any) => row.runId === run.runId && row.state === "completed"));
			const missing = f.published.mock.calls.findIndex(([rows]) =>
				!rows.some((row: any) => row.runId === run.runId));
			expect.soft(terminal, run.runId).toBeGreaterThanOrEqual(0);
			if (missing >= 0) expect.soft(terminal, run.runId).toBeLessThan(missing);
		}
		expect(f.waitCounts.every((count) => count > 0)).toBe(true);
		expect(f.published.mock.calls.every(([rows]) => rows.length <= 100)).toBe(true);
		expect(f.provider().listActiveWork()).toEqual([{ id: runs[0].runId, sessionId: f.owner.ownerSessionFile }]);
	});

	it("retains selected local rows when deferred validation is invalidated in flight", async () => {
		const owner = { ownerSessionId: OWNER, ownerSessionFile: "/synthetic/session.jsonl" };
		const rows = ["first", "deferred", "live"].map((runId, i) => ({
			...owner, runId, agent: "test", startedAt: 1000 + i, state: "running" as const,
		}));
		let phase = 0; let notify!: () => void; let release!: () => void; let entered!: () => void;
		const reading = new Promise<void>((done) => { entered = done; });
		const api = { registerExternalRun: vi.fn((run: any) => run), updateExternalRun: vi.fn(),
			unregisterExternalRun: vi.fn(), registerBackgroundWorkProvider: vi.fn(() => () => {}) };
		const updates = vi.fn(); const adapter = createPiSubagentsAdapter(api);
		const observer = observation.createAsyncObservation({
			owner, adapter: (context: any) => {
				const registration = adapter(context);
				return { ...registration, update(snapshot: any) { updates(snapshot); registration.update(snapshot); } };
			},
			readLocalSnapshot: (ids: string[]) => rows.filter((row) => phase === 0 || row.runId === "live" || ids.includes(row.runId)),
			recovery: {
				local: () => rows.map((row) => ({ async read() {
					if (phase === 0 || row.runId === "live") return row;
					if (row.runId === "deferred") {
						if (phase === 1) throw new observation.ObservationReadDeferred();
						if (phase === 2) {
							entered(); await new Promise<void>((done) => { release = done; });
							return { ...row, state: "completed" };
						}
						return { ...row, state: "failed" };
					}
					return { ...row, state: "completed" };
				} })),
				open: async () => ({ read: async () => null, close: async () => {} }),
			},
			subscribe: (callback: () => void) => { notify = callback; return () => {}; }, emitWake: vi.fn(),
		});
		disposers.push(() => observer.dispose());
		await observer.refresh(); updates.mockClear(); phase = 1; await observer.refresh();
		expect.soft(updates.mock.calls.every(([snapshot]) => snapshot.some((row: any) =>
			row.runId === "deferred" && row.state === "running"))).toBe(true);
		expect.soft(api.unregisterExternalRun).not.toHaveBeenCalledWith(owner.ownerSessionFile, "deferred");
		phase = 2; const pending = observer.refresh(); await reading;
		phase = 3; notify(); release(); await pending; await observer.refresh();
		expect(updates.mock.calls.every(([snapshot]) => snapshot.some((row: any) => row.runId === "live" && row.state === "running"))).toBe(true);
		expect(api.updateExternalRun).toHaveBeenCalledWith(owner.ownerSessionFile, "deferred", expect.objectContaining({ state: "failed" }));
		expect(api.updateExternalRun).not.toHaveBeenCalledWith(owner.ownerSessionFile, "deferred", expect.objectContaining({ state: "completed" }));
	});

	it("makes duplicate lifecycle callbacks harmless after a successful terminal", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const f = await indexedFixture(); const run = await f.launch();
		const close = run.proc.listeners("close")[0]; const error = run.proc.listeners("error")[0];
		finishRun(run, true); close(1); error(new Error("late duplicate")); error(new Error("late duplicate"));
		expect(await f.fresh.readAsyncRunObservations(OWNER, f.root)).toMatchObject([{ state: "completed" }]);
		expect(vi.getTimerCount()).toBe(1);
	});

	it("keeps early error terminal across a later close and duplicate callbacks, then expires references", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const f = await indexedFixture();
		const run = await f.launch(OWNER, "error");
		run.proc.emit("close", 0); run.proc.emit("close", 0);
		expect(await f.fresh.readAsyncRunObservations(OWNER, f.root)).toMatchObject([{ runId: run.runId, state: "failed" }]);
		expect(vi.getTimerCount()).toBe(1);
		fs.rmSync(run.artifactDir, { recursive: true });
		await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
		expect(await f.fresh.readAsyncRunObservations(OWNER, f.root)).toEqual([]);
		const next = await f.launch();
		expect(await f.fresh.readAsyncRunObservations(OWNER, f.root)).toMatchObject([{ runId: next.runId, state: "running" }]);
	});

	it("removes observation references after a failed metadata write and verified termination", async () => {
		const f = await indexedFixture();
		const write = fs.promises.writeFile.bind(fs.promises);
		vi.spyOn(fs.promises, "writeFile").mockImplementation((file: any, ...args: any[]) => {
			if (String(file).endsWith("run-meta.json")) return Promise.reject(new Error("synthetic metadata failure"));
			return (write as any)(file, ...args);
		});
		vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
		// Synthetic pid only; process.kill is intercepted above.
		await expect(f.launch(OWNER, undefined, 999999)).rejects.toThrow("synthetic metadata failure");
		expect(await f.fresh.readAsyncRunObservations(OWNER, f.root)).toEqual([]);
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

// Deterministic paging: filesystem enumeration order is deliberately not assumed.
function orderedDirectory(root: string, names: string[]) {
	for (const name of names) fs.mkdirSync(path.join(root, name), { recursive: true });
	const original = fs.promises.opendir.bind(fs.promises);
	const cursors: any[] = [];
	vi.spyOn(fs.promises, "opendir").mockImplementation(async (dir: any, ...args: any[]) => {
		if (String(dir) !== root) return (original as any)(dir, ...args);
		let index = 0;
		const cursor = { reads: 0, closed: false,
			async read() { this.reads++; return index < names.length
				? { name: names[index++], isDirectory: () => true } : null; },
			close: vi.fn(async () => { cursor.closed = true; }),
			async *[Symbol.asyncIterator]() {
				try { for (;;) { const item = await this.read(); if (!item) break; yield item; } }
				finally { await this.close(); }
			},
		};
		cursors.push(cursor); return cursor as any;
	});
	return cursors;
}

function recoveryRuntime(root: string) {
	const updates = vi.fn(); const diagnostic = vi.fn();
	const r = runtime({ artifactRoot: root, onObservationDiagnostic: diagnostic,
		observationAdapter: () => ({ update: updates, dispose() {} }) });
	disposers.push(() => { void r.handlers.get("session_shutdown")!({}, r.ctx()); });
	return { ...r, updates, diagnostic, start: () => r.handlers.get("session_start")!({}, r.ctx()),
		latest: () => updates.mock.calls.at(-1)?.[0] ?? [] };
}

async function nextRecoveryPage(until: () => boolean) {
	await vi.advanceTimersByTimeAsync(1000);
	// Wait for a concrete pass outcome, not a guessed number of event-loop turns.
	for (let i = 0; i < 2000 && !until(); i++) await new Promise<void>((done) => realTimeout(done, 1));
	expect(until()).toBe(true);
}

describe("B3 progressive bounded recovery", () => {
	it("continues successive empty 256-entry pages and closes the finite sweep", async () => {
		vi.useFakeTimers(); const root = rootDir();
		const names = Array.from({ length: 512 }, (_, i) => `unrelated-${i}`);
		complete(artifact(root, "owned-last")); names.push("owned-last");
		const cursors = orderedDirectory(root, names); const r = recoveryRuntime(root);
		await r.start(); expect(r.latest()).toEqual([]);
		expect(cursors[0].reads).toBeLessThanOrEqual(256);
		await nextRecoveryPage(() => cursors[0].reads === 512 && r.updates.mock.calls.length >= 6); expect(r.latest()).toEqual([]);
		expect(cursors).toHaveLength(1); expect(cursors[0].reads).toBe(512);
		await nextRecoveryPage(() => cursors[0].closed);
		expect(r.latest()).toMatchObject([{ runId: "owned-last", state: "completed" }]);
		expect(cursors[0].close).toHaveBeenCalledTimes(1);
	});

	it("retains partial rows, selects newest across pages, and excludes native/foreign/sync/malformed", async () => {
		vi.useFakeTimers(); const root = rootDir(); const names: string[] = [];
		for (let i = 0; i < 300; i++) {
			const id = `row-${String(i).padStart(3, "0")}`; names.push(id);
			const meta = artifact(root, id); meta.startedAt = 1000 + i;
			fs.writeFileSync(path.join(meta.artifactDir, "run-meta.json"), JSON.stringify(meta)); complete(meta);
		}
		for (const [id, owner] of [["foreign", OTHER], ["sync", null]] as const) {
			complete(artifact(root, id, owner)); names.push(id);
		}
		const native = artifact(root, "native"); complete(native);
		fs.writeFileSync(path.join(native.artifactDir, "request.json"), "private native"); names.push("native");
		const declared = artifact(root, "declared-native"); complete(declared);
		fs.writeFileSync(path.join(declared.artifactDir, "run-meta.json"), JSON.stringify({ ...declared, nativeAuditRequested: true }));
		names.push("declared-native");
		fs.mkdirSync(path.join(root, "bad")); fs.writeFileSync(path.join(root, "bad", "run-meta.json"), "{"); names.push("bad");
		orderedDirectory(root, names); const r = recoveryRuntime(root); await r.start();
		expect(r.latest()).toHaveLength(100); expect(r.latest()[0].runId).toBe("row-255");
		await nextRecoveryPage(() => r.latest()[0]?.runId === "row-299");
		expect(r.latest().map((row: any) => row.runId)).toEqual(
			Array.from({ length: 100 }, (_, i) => `row-${299 - i}`));
	});

	it("bounds actual aggregate bytes and defers an unfinished report without publishing failure", async () => {
		vi.useFakeTimers(); const root = rootDir(); const names: string[] = [];
		for (let i = 0; i < 8; i++) {
			const id = `large-${i}`; names.push(id); const meta = artifact(root, id); complete(meta);
			fs.writeFileSync(path.join(meta.artifactDir, "report.json"), JSON.stringify({ result: { outcome: "success" }, padding: "x".repeat(900_000) }));
		}
		const cursors = orderedDirectory(root, names);
		const original = fs.promises.open.bind(fs.promises); let bytes = 0; const opened: string[] = [];
		vi.spyOn(fs.promises, "open").mockImplementation(async (...args: any[]) => {
			opened.push(String(args[0])); const h = await (original as any)(...args); const read = h.read.bind(h);
			h.read = async (...a: any[]) => { const result = await read(...a); bytes += result.bytesRead; return result; }; return h;
		});
		const r = recoveryRuntime(root); await r.start();
		expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
		expect(r.latest().length).toBeGreaterThan(0); expect(r.latest().length).toBeLessThan(8);
		expect(r.latest().every((row: any) => row.state === "completed")).toBe(true);
		expect(cursors[0].closed).toBe(false);
		const first = r.latest().map((row: any) => row.runId);
		const firstPass = { bytes, opens: opened.length, directoryReads: cursors[0].reads }; bytes = 0;
		await nextRecoveryPage(() => r.latest().length === 8); expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
		expect(r.latest()).toHaveLength(8); expect(first.every((id: string) => r.latest().some((row: any) => row.runId === id))).toBe(true);
		expect(opened.every((file) => /(?:run-meta|completed|report)\.json$/.test(file))).toBe(true);
		process.stdout.write("B3 measured per-pass resources " + JSON.stringify([firstPass,
			{ bytes, opens: opened.length - firstPass.opens, directoryReads: cursors[0].reads - firstPass.directoryReads }]) + "\n");
	});

	it.each(["shutdown", "replace", "reload"])("closes an unfinished iterator on %s and starts replacement clean", async (how) => {
		vi.useFakeTimers(); const root = rootDir();
		complete(artifact(root, "old"));
		const cursors = orderedDirectory(root, ["old", ...Array.from({ length: 512 }, (_, i) => `empty-${i}`)]);
		const r = recoveryRuntime(root); await r.start();
		expect(cursors[0].close).not.toHaveBeenCalled();
		if (how === "shutdown") await r.handlers.get("session_shutdown")!({}, r.ctx());
		else if (how === "replace") await r.handlers.get("session_start")!({}, r.ctx(OTHER));
		else await r.handlers.get("session_start")!({}, r.ctx());
		expect(cursors[0].close).toHaveBeenCalledTimes(1);
		if (how === "replace") expect(r.latest()).toEqual([]);
	});
	it("retires an iterator opened after disposal without reading or publishing late rows", async () => {
		const root = rootDir(); complete(artifact(root, "late"));
		let release!: (value: any) => void; let entered!: () => void;
		const opened = new Promise<void>((done) => { entered = done; });
		const cursor = { read: vi.fn(async () => ({ name: "late", isDirectory: () => true })), close: vi.fn(async () => {}) };
		vi.spyOn(fs.promises, "opendir").mockImplementation(() => new Promise<any>((done) => { release = done; entered(); }));
		const r = recoveryRuntime(root); const pending = r.start();
		await opened;
		await r.handlers.get("session_shutdown")!({}, r.ctx()); const count = r.updates.mock.calls.length;
		release(cursor); await pending;
		expect(cursor.close).toHaveBeenCalledTimes(1); expect(cursor.read).not.toHaveBeenCalled();
		expect(r.updates).toHaveBeenCalledTimes(count);
	});

	it("restarts after an interrupted directory read without dropping validated partial rows", async () => {
		vi.useFakeTimers(); const root = rootDir(); complete(artifact(root, "retained"));
		const cursors = orderedDirectory(root, ["retained", ...Array.from({ length: 512 }, (_, i) => `empty-${i}`)]);
		const r = recoveryRuntime(root); await r.start();
		cursors[0].read = vi.fn(async () => { throw new Error("interrupted private scan"); });
		await nextRecoveryPage(() => r.diagnostic.mock.calls.length > 0); expect(cursors[0].close).toHaveBeenCalledTimes(1);
		expect(r.latest()).toMatchObject([{ runId: "retained" }]);
		expect(r.diagnostic).toHaveBeenCalledWith("Async observation unavailable.");
		await nextRecoveryPage(() => cursors.length === 2); expect(cursors).toHaveLength(2);
		expect(r.latest()).toMatchObject([{ runId: "retained" }]);
	});

	it("keeps partial rows through a completely empty continuation page", async () => {
		vi.useFakeTimers(); const root = rootDir(); complete(artifact(root, "first")); complete(artifact(root, "last"));
		const names = ["first", ...Array.from({ length: 511 }, (_, i) => `empty-${i}`), "last"];
		const cursors = orderedDirectory(root, names); const r = recoveryRuntime(root); await r.start();
		expect(r.latest()).toMatchObject([{ runId: "first" }]);
		await nextRecoveryPage(() => cursors[0].reads === 512 && r.updates.mock.calls.length >= 6);
		expect(r.latest()).toMatchObject([{ runId: "first" }]);
		await nextRecoveryPage(() => r.latest().length === 2);
		expect(new Set(r.latest().map((row: any) => row.runId))).toEqual(new Set(["first", "last"]));
	});

	it("prioritizes proven local live work but ranks recovered rows ahead of older local history", async () => {
		const f = await indexedFixture(); const old = await f.launch(); finishRun(old, true);
		const live = await f.launch();
		for (let i = 0; i < 110; i++) {
			const meta = artifact(f.root, `new-recovered-${String(i).padStart(3, "0")}`);
			meta.startedAt = live.meta.startedAt + i + 1;
			fs.writeFileSync(path.join(meta.artifactDir, "run-meta.json"), JSON.stringify(meta)); complete(meta);
		}
		const rows = await f.fresh.readAsyncRunObservations(OWNER, f.root);
		expect(rows[0]).toMatchObject({ runId: live.runId, state: "running" });
		expect(rows).toHaveLength(100); expect(rows.some((row) => row.runId === old.runId)).toBe(false);
		expect(rows[1].runId).toBe("new-recovered-109");
	});

	it("closes an open iterator and file handle when disposed during an artifact open", async () => {
		const root = rootDir(); complete(artifact(root, "interrupted"));
		const cursors = orderedDirectory(root, ["interrupted"]);
		const original = fs.promises.open.bind(fs.promises);
		let release!: () => void; let entered!: () => void; let close: any;
		const opened = new Promise<void>((done) => { entered = done; });
		vi.spyOn(fs.promises, "open").mockImplementation(async (...args: any[]) => {
			const h = await (original as any)(...args); close = vi.spyOn(h, "close"); entered();
			await new Promise<void>((done) => { release = done; }); return h;
		});
		const r = recoveryRuntime(root); const pending = r.start(); await opened;
		await r.handlers.get("session_shutdown")!({}, r.ctx()); const count = r.updates.mock.calls.length;
		release(); await pending;
		expect(close).toHaveBeenCalledTimes(1); expect(cursors[0].close).toHaveBeenCalledTimes(1);
		expect(r.updates).toHaveBeenCalledTimes(count);
	});

	it("closes a directory even if invalidation races its pending read", async () => {
		const source: any = { local: () => [], open: async () => cursor };
		let release!: (value: any) => void; let reading = false;
		const cursor = {
			closed: false,
			read: () => { reading = true; return new Promise<any>((done) => { release = (value) => { reading = false; done(value); }; }); },
			close: vi.fn(async () => { if (reading) throw Object.assign(new Error("busy"), { code: "ERR_DIR_CONCURRENT_OPERATION" }); cursor.closed = true; }),
		};
		const scan = observation.createRecoveryScan(source); const pending = scan.pass([]);
		await new Promise<void>((done) => realImmediate(done)); scan.dispose();
		await new Promise<void>((done) => realImmediate(done));
		expect(cursor.closed).toBe(false); release(null); await pending;
		expect(cursor.closed).toBe(true);
	});

	it("continues a byte-exhausted page even when all rows read so far are foreign", async () => {
		vi.useFakeTimers(); const root = rootDir(); const names: string[] = [];
		for (let i = 0; i < 80; i++) {
			const id = `foreign-${i}`; names.push(id); const meta = artifact(root, id, OTHER);
			fs.writeFileSync(path.join(meta.artifactDir, "run-meta.json"), JSON.stringify({ ...meta, padding: "x".repeat(60_000) }));
		}
		complete(artifact(root, "owned")); names.push("owned");
		const cursors = orderedDirectory(root, names); const r = recoveryRuntime(root); await r.start();
		expect(r.latest()).toEqual([]); expect(cursors[0].reads).toBeLessThan(80);
		expect(cursors[0].closed).toBe(false);
		await nextRecoveryPage(() => r.latest().length === 1);
		expect(r.latest()).toMatchObject([{ runId: "owned", state: "completed" }]);
	});

	it("defers an interrupted read and retries without inventing a terminal failure", async () => {
		vi.useFakeTimers(); const root = rootDir(); complete(artifact(root, "retry"));
		const cursors = orderedDirectory(root, ["retry"]);
		const original = fs.promises.open.bind(fs.promises); let interrupted = false; let closed: any;
		vi.spyOn(fs.promises, "open").mockImplementation(async (...args: any[]) => {
			const h = await (original as any)(...args);
			if (String(args[0]).endsWith("report.json") && !interrupted) {
				interrupted = true; closed = vi.spyOn(h, "close");
				h.read = async () => { throw Object.assign(new Error("private interrupted read"), { code: "EINTR" }); };
			}
			return h;
		});
		const r = recoveryRuntime(root); await r.start();
		expect(r.latest()).toEqual([]); expect(closed).toHaveBeenCalledTimes(1);
		expect(cursors[0].closed).toBe(true);
		await nextRecoveryPage(() => r.latest().length === 1);
		expect(r.latest()).toMatchObject([{ runId: "retry", state: "completed" }]);
	});

	it("treats a not-yet-created artifact root as a complete empty sweep", async () => {
		const root = path.join(rootDir(), "not-created"); const r = recoveryRuntime(root);
		await r.start(); expect(r.latest()).toEqual([]); expect(r.diagnostic).not.toHaveBeenCalled();
	});

	it("does not commit a retired sweep after asynchronous iterator close", async () => {
		const row = { runId: "validated", ownerSessionId: OWNER, agent: "test", startedAt: 1000, state: "completed" };
		let release!: () => void; let entered!: () => void; let reads = 0;
		const closing = new Promise<void>((done) => { entered = done; });
		const first = { read: async () => reads++ === 0 ? { read: async () => row } : null,
			close: () => new Promise<void>((done) => { release = done; entered(); }) };
		const next = { read: async () => ({ read: async () => { throw new observation.ObservationReadDeferred(); } }), close: async () => {} };
		const source = { local: () => [], open: vi.fn().mockResolvedValueOnce(first).mockResolvedValue(next) };
		const scan = observation.createRecoveryScan(source); const pending = scan.pass([]); await closing;
		scan.invalidate(); release(); await pending;
		expect((await scan.pass([])).rows).toMatchObject([{ runId: "validated" }]); scan.dispose();
	});

});

describe("B4 stable artifact root provenance", () => {
	it("recovers legacy relative metadata after a fresh registry with unchanged resolution base", async () => {
		const root = rootDir(); const meta = artifact(root, "legacy-relative"); complete(meta);
		const relative = { ...meta, artifactDir: path.relative(process.cwd(), meta.artifactDir),
			stdoutFile: path.relative(process.cwd(), meta.stdoutFile), stderrFile: path.relative(process.cwd(), meta.stderrFile) };
		fs.writeFileSync(path.join(meta.artifactDir, "run-meta.json"), JSON.stringify(relative));
		vi.resetModules(); const fresh = await import("../extensions/index.js");
		expect(await fresh.readAsyncRunObservations(OWNER, path.relative(process.cwd(), root))).toMatchObject([{ runId: meta.runId, state: "completed" }]);
	});

	it("anchors runtime root before cwd changes and rejects unknown relative provenance", async () => {
		const root = rootDir(); const meta = artifact(root, "absolute"); complete(meta);
		const legacy = artifact(root, "relative"); complete(legacy);
		const base = path.dirname(root);
		fs.writeFileSync(path.join(legacy.artifactDir, "run-meta.json"), JSON.stringify({ ...legacy,
			artifactDir: path.relative(base, legacy.artifactDir) }));
		const cwd = vi.spyOn(process, "cwd").mockReturnValue(base);
		const r = recoveryRuntime(path.basename(root));
		const openDir = vi.spyOn(fs.promises, "opendir");
		cwd.mockReturnValue(rootDir());
		await r.start(); expect(openDir.mock.calls[0][0]).toBe(root);
		expect(r.latest()).toMatchObject([{ runId: "absolute" }]);
		expect(r.latest()).toHaveLength(1); cwd.mockRestore();
	});

	it("resolves direct async launch paths before the first await and persists absolute paths", async () => {
		vi.resetModules(); const fresh = await import("../extensions/index.js");
		await fresh.preflightSwivalVersion(async () => "1.0.45");
		const root = rootDir(); const expected = path.join(root, "relative-launch");
		const proc = new EventEmitter() as any; proc.unref = vi.fn(); proc.pid = 88888;
		execution.spawn.mockReturnValue(proc); disposers.push(() => proc.emit("close", 1));
		const launch = fresh.runSingleSwivalAsync(root, [{ name: "test", systemPrompt: "" } as any], "test", "private", undefined, {}, path.relative(process.cwd(), expected), { ownerSessionId: OWNER });
		const cwd = vi.spyOn(process, "cwd").mockReturnValue(rootDir());
		const run = await launch; cwd.mockRestore();
		expect(path.isAbsolute(run.artifactDir)).toBe(true); expect(path.dirname(run.artifactDir)).toBe(expected);
		const meta = JSON.parse(fs.readFileSync(path.join(run.artifactDir, "run-meta.json"), "utf8"));
		expect([meta.artifactDir, meta.stdoutFile, meta.stderrFile].every(path.isAbsolute)).toBe(true);
	});

	it("excludes root escapes, sibling prefixes, symlink directories and symlink metadata", async () => {
		const root = rootDir(); const outside = rootDir(); const foreign = artifact(outside, "outside"); complete(foreign);
		fs.symlinkSync(foreign.artifactDir, path.join(root, "linked-directory"));
		const linked = artifact(root, "linked-meta"); fs.unlinkSync(path.join(linked.artifactDir, "run-meta.json"));
		fs.symlinkSync(path.join(foreign.artifactDir, "run-meta.json"), path.join(linked.artifactDir, "run-meta.json"));
		for (const [id, artifactDir] of [["escape", path.join(root, "..", "escape")], ["sibling", root + "-sibling/child"]]) {
			const meta = artifact(root, id); complete(meta);
			fs.writeFileSync(path.join(meta.artifactDir, "run-meta.json"), JSON.stringify({ ...meta, artifactDir }));
		}
		expect(await extension.readAsyncRunObservations(OWNER, root)).toEqual([]);
	});
	it("rejects a configured symlink root even when outside metadata claims its lexical path", async () => {
		const parent = rootDir(); const outside = rootDir(); const linkedRoot = path.join(parent, "linked-root");
		fs.symlinkSync(outside, linkedRoot); const meta = artifact(outside, "outside"); complete(meta);
		const claimed = path.join(linkedRoot, "outside");
		fs.writeFileSync(path.join(meta.artifactDir, "run-meta.json"), JSON.stringify({ ...meta,
			artifactDir: claimed, stdoutFile: path.join(claimed, "stdout.txt"), stderrFile: path.join(claimed, "stderr.txt") }));
		expect(await extension.readAsyncRunObservations(OWNER, linkedRoot)).toEqual([]);
	});

	it("does not follow a replaced local terminal artifact directory", async () => {
		const f = await indexedFixture(); const run = await f.launch(); finishRun(run, true);
		const moved = path.join(rootDir(), "moved"); fs.renameSync(run.artifactDir, moved); fs.symlinkSync(moved, run.artifactDir);
		const open = vi.spyOn(fs.promises, "open");
		const rows = await f.fresh.readAsyncRunObservations(OWNER, f.root);
		expect(rows).not.toContainEqual(expect.objectContaining({ runId: run.runId, state: "completed" }));
		expect(open).not.toHaveBeenCalled();
	});

});


// B5 measures the progressive Fleet path, not the disposable one-shot helper.
async function b5Runtime(root: string) {
	vi.resetModules();
	const fresh = await import("../extensions/index.js");
	const observed = await import("../extensions/async-observation.js");
	const create = observed.createAsyncObservation;
	let observer: any;
	vi.spyOn(observed, "createAsyncObservation").mockImplementation((options: any) => {
		observer = create(options); return observer;
	});
	const updates = vi.fn();
	const r = runtime({ artifactRoot: root, observationAdapter: () => ({ update: updates, dispose() {} }) }, fresh);
	disposers.push(() => observer?.dispose());
	return { ...r, updates, observer: () => observer,
		start: () => r.handlers.get("session_start")!({}, r.ctx()),
		latest: () => updates.mock.calls.at(-1)?.[0] ?? [] };
}

function reportReads() {
	const original = fs.promises.open.bind(fs.promises);
	const metrics = { opens: 0, bytes: 0, afterRead: undefined as undefined | (() => void) };
	vi.spyOn(fs.promises, "open").mockImplementation(async (file: any, ...args: any[]) => {
		const handle = await (original as any)(file, ...args);
		if (String(file).endsWith("/report.json")) {
			metrics.opens++;
			const read = handle.read.bind(handle);
			handle.read = async (...readArgs: any[]) => {
				const result = await read(...readArgs); metrics.bytes += result.bytesRead;
				const hook = metrics.afterRead; metrics.afterRead = undefined; hook?.();
				return result;
			};
		}
		return handle;
	});
	return metrics;
}

describe("B5 bounded terminal evidence cache and unresolved backoff", () => {
	it("keeps distinct cached terminals after local expiry transfers them to disk recovery", async () => {
		const expiry = vi.spyOn(globalThis, "setTimeout");
		const f = await indexedFixture();
		for (let i = 0; i < 99; i++) {
			const run = await f.launch();
			finishRun(run, true);
			fs.writeFileSync(path.join(run.artifactDir, "completed.json"), JSON.stringify({
				exitCode: 0, exitedAt: new Date().toISOString(),
			}));
		}
		artifact(f.root, "unknown");
		await f.start();
		const callbacks = expiry.mock.calls.filter(([, delay]) => delay === 60 * 60 * 1000);
		expect(callbacks).toHaveLength(99);
		for (const [callback] of callbacks) (callback as () => void)();
		for (let pass = 0; pass < 3; pass++) await f.observer().refresh();
		const reads = reportReads();
		await f.observer().refresh();
		await f.observer().refresh();
		expect(reads).toMatchObject({ opens: 0, bytes: 0 });
	});
	it("drops expired local successes when changed disk reports exhaust the read budget", async () => {
		const expiry = vi.spyOn(globalThis, "setTimeout");
		const f = await indexedFixture(); const runs = [];
		for (let i = 0; i < 99; i++) {
			const run = await f.launch(); runs.push(run); finishRun(run, true);
			fs.writeFileSync(path.join(run.artifactDir, "completed.json"), JSON.stringify({
				exitCode: 0, exitedAt: new Date().toISOString(),
			}));
		}
		artifact(f.root, "unknown");
		orderedDirectory(f.root, [...runs.map((run) => path.basename(run.artifactDir)), "unknown"]);
		await f.start();
		const reads = reportReads();
		await f.observer().refresh(); await f.observer().refresh();
		expect(reads).toMatchObject({ opens: 0, bytes: 0 });
		const callbacks = expiry.mock.calls.filter(([, delay]) => delay === 60 * 60 * 1000);
		expect(callbacks).toHaveLength(99);
		for (const [callback] of callbacks) (callback as () => void)();
		for (let pass = 0; pass < 3; pass++) await f.observer().refresh();
		reads.opens = reads.bytes = 0;
		await f.observer().refresh(); await f.observer().refresh();
		expect(reads).toMatchObject({ opens: 0, bytes: 0 });
		expect(f.published.mock.calls.at(-1)![0]).toHaveLength(100);
		for (const run of runs.slice(0, 7)) fs.writeFileSync(path.join(run.artifactDir, "report.json"), JSON.stringify({
			result: { outcome: "failed", answer: "x".repeat(600_000) },
		}));
		reads.opens = reads.bytes = 0;
		await f.observer().refresh();
		const rows = f.published.mock.calls.at(-1)![0];
		expect(reads.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
		expect(rows.filter((row: any) => row.state === "failed")).toHaveLength(6);
		expect(rows.find((row: any) => row.runId === runs[6].runId)).toBeUndefined();
		await f.observer().refresh();
		expect(f.published.mock.calls.at(-1)![0].find((row: any) => row.runId === runs[6].runId)).toMatchObject({ state: "failed" });
	});

	it("invalidates a visible success even after its terminal cache entry was evicted", async () => {
		const root = rootDir(); const metas: RunMeta[] = [];
		for (let i = 0; i < 101; i++) {
			const meta = artifact(root, `row-${i.toString().padStart(3, "0")}`);
			meta.startedAt = 1000 + i;
			fs.writeFileSync(path.join(meta.artifactDir, "run-meta.json"), JSON.stringify(meta));
			complete(meta); metas.push(meta);
		}
		// Revisit the evicted oldest after six large changed reports consume the pass.
		orderedDirectory(root, [...metas.slice(1, 7), metas[0], ...metas.slice(7)].map((meta) => meta.runId));
		const r = await b5Runtime(root); await r.start();
		fs.rmSync(metas[100].artifactDir, { recursive: true });
		await r.observer().refresh();
		expect(r.latest()).toContainEqual(expect.objectContaining({ runId: metas[0].runId, state: "completed" }));
		for (const meta of metas.slice(0, 7)) fs.writeFileSync(path.join(meta.artifactDir, "report.json"), JSON.stringify({
			result: { outcome: "failed", answer: "x".repeat(600_000) },
		}));
		await r.observer().refresh();
		expect(r.latest().filter((row: any) => row.state === "failed")).toHaveLength(6);
		expect(r.latest().find((row: any) => row.runId === metas[0].runId)).toBeUndefined();
		await r.observer().refresh();
		expect(r.latest().find((row: any) => row.runId === metas[0].runId)).toMatchObject({ state: "failed" });
	});

	it("reads 99 terminal report bodies once with one unresolved Fleet row, then zero unchanged bodies", async () => {
		vi.useFakeTimers();
		const root = rootDir();
		for (let i = 0; i < 99; i++) complete(artifact(root, `done-${i}`));
		artifact(root, "unknown");
		const reads = reportReads(); const timers = vi.spyOn(globalThis, "setTimeout");
		const r = await b5Runtime(root);
		await r.start();
		expect(r.latest()).toHaveLength(100);
		expect(reads.opens).toBe(99); expect(reads.bytes).toBeGreaterThan(0);
		reads.opens = reads.bytes = 0;
		for (const delay of [1000, 2000]) {
			const count = timers.mock.calls.length;
			await vi.advanceTimersByTimeAsync(delay);
			for (let i = 0; i < 2000 && timers.mock.calls.length === count; i++) await new Promise<void>((done) => realTimeout(done, 1));
			expect(timers.mock.calls.length).toBeGreaterThan(count);
		}
		expect(reads).toMatchObject({ opens: 0, bytes: 0 });
		expect(JSON.stringify(r.latest())).not.toMatch(/private task|private output|12345/);
	});

	it.each(["report", "marker-replace", "spawn-error", "owner", "path", "missing-meta", "missing-marker",
		"missing-report", "stale-report", "stale-marker", "native", "directory-symlink"])(
		"invalidates cached completion for changed %s evidence", async (change) => {
			const root = rootDir(); const meta = artifact(root, "cached"); complete(meta);
			const r = await b5Runtime(root); await r.start();
			expect(r.latest()).toMatchObject([{ state: "completed" }]);
			const file = (name: string) => path.join(meta.artifactDir, name);
			if (change === "report") fs.writeFileSync(file("report.json"), '{"result":{"outcome":"failed"}}');
			if (change === "marker-replace") {
				fs.renameSync(file("completed.json"), file("old-marker"));
				fs.writeFileSync(file("completed.json"), '{"exitCode":1,"exitedAt":"2026-01-01T00:00:00.000Z"}');
			}
			if (change === "spawn-error") fs.writeFileSync(file("spawn-error.txt"), "private failure");
			if (change === "owner" || change === "path") fs.writeFileSync(file("run-meta.json"), JSON.stringify({
				...meta, ...(change === "owner" ? { ownerSessionId: OTHER } : { artifactDir: root }),
			}));
			if (change.startsWith("missing-")) fs.unlinkSync(file(({ "missing-meta": "run-meta.json",
				"missing-marker": "completed.json", "missing-report": "report.json" } as any)[change]));
			if (change.startsWith("stale-")) fs.utimesSync(file(change === "stale-report" ? "report.json" : "completed.json"), 0, 0);
			if (change === "native") fs.mkdirSync(file("snapshot"));
			if (change === "directory-symlink") {
				const moved = path.join(rootDir(), "moved"); fs.renameSync(meta.artifactDir, moved);
				fs.symlinkSync(moved, meta.artifactDir);
			}
			await r.observer().refresh();
			expect(r.latest().some((row: any) => row.state === "completed")).toBe(false);
		});

	it("does not publish terminal state when undefined provenance hides a native transition", async () => {
		const root = rootDir(); const meta = artifact(root, "unsafe-provenance"); complete(meta);
		fs.symlinkSync(rootDir(), path.join(meta.artifactDir, "evidence"));
		const reads = reportReads(); const r = await b5Runtime(root);
		reads.afterRead = () => fs.mkdirSync(path.join(meta.artifactDir, "snapshot"));
		await r.start();
		expect(r.updates.mock.calls.flatMap(([rows]: any[]) => rows)
			.some((row: any) => row.state === "completed" || row.state === "failed")).toBe(false);
	});

	it("never commits completion if a report mutates during its read, and retries stable evidence", async () => {
		const root = rootDir(); const meta = artifact(root, "race"); complete(meta);
		const reads = reportReads(); const r = await b5Runtime(root);
		reads.afterRead = () => fs.writeFileSync(path.join(meta.artifactDir, "report.json"), '{"result":{"outcome":"failed"}}');
		await r.start();
		expect(r.latest().some((row: any) => row.state === "completed")).toBe(false);
		await r.observer().refresh();
		expect(r.latest()).toMatchObject([{ state: "failed" }]);
	});

	it("clears cache on disposal, including disposal during an evidence read", async () => {
		const root = rootDir(); complete(artifact(root, "done")); artifact(root, "unknown");
		const reads = reportReads(); const r = await b5Runtime(root); await r.start();
		r.observer().dispose(); reads.opens = reads.bytes = 0;
		const next = await b5Runtime(root); await next.start(); expect(reads.opens).toBe(1);
		fs.writeFileSync(path.join(root, "done", "report.json"), '{"result":{"outcome":"failed"}}');
		let count = 0;
		reads.afterRead = () => { count = next.updates.mock.calls.length; next.observer().dispose(); };
		await next.observer().refresh(); expect(next.updates).toHaveBeenCalledTimes(count);
	});

	it("keeps at most the newest 100 terminal cache entries", async () => {
		const root = rootDir(); const names: string[] = [];
		for (let i = 0; i < 105; i++) {
			const meta = artifact(root, `row-${i.toString().padStart(3, "0")}`);
			fs.writeFileSync(path.join(meta.artifactDir, "run-meta.json"), JSON.stringify({ ...meta, startedAt: 1000 + i }));
			complete(meta); names.push(meta.runId);
		}
		orderedDirectory(root, names);
		const reads = reportReads(); const r = await b5Runtime(root); await r.start();
		expect(r.latest()).toHaveLength(100); expect(r.latest()[0].runId).toBe("row-104");
		reads.opens = reads.bytes = 0; await r.observer().refresh();
		// Only the five evicted oldest rows are reparsed, not a FIFO cache thrash.
		expect(reads.opens).toBe(5);
	});

	it("backs off unchanged unresolved polls exactly 1/2/4/8/16/30/30 seconds and stops/restarts", async () => {
		vi.useFakeTimers();
		const update = vi.fn(); const read = vi.fn(async () => [{ runId: "unknown", ownerSessionId: OWNER,
			agent: "test", startedAt: 1000, state: "unknown" }]);
		let localEvent!: () => void;
		const timers = vi.spyOn(globalThis, "setTimeout");
		const o = observation.createAsyncObservation({ owner: { ownerSessionId: OWNER },
			adapter: () => ({ update, dispose() {} }), readSnapshot: read,
			subscribe: (callback: () => void) => { localEvent = callback; return () => {}; }, emitWake() {} });
		disposers.push(() => o.dispose());
		await o.refresh();
		for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
			expect(timers.mock.calls.at(-1)?.[1]).toBe(delay);
			await vi.advanceTimersByTimeAsync(delay);
		}
		localEvent(); await o.refresh(); expect(timers.mock.calls.at(-1)?.[1]).toBe(1000);
		read.mockResolvedValue([{ runId: "unknown", ownerSessionId: OWNER, agent: "test", startedAt: 1000, state: "completed" }]);
		await o.refresh(); expect(vi.getTimerCount()).toBe(0);
		read.mockResolvedValue([{ runId: "unknown", ownerSessionId: OWNER, agent: "test", startedAt: 1000, state: "unknown" }]);
		await o.refresh(); expect(timers.mock.calls.at(-1)?.[1]).toBe(1000);
	});
});


describe("B5 invalidation, progression and polling edges", () => {
	it("uses the cache on scheduled Fleet polls and resets on same-state evidence changes", async () => {
		vi.useFakeTimers();
		const root = rootDir(); const pending = artifact(root, "unknown"); complete(artifact(root, "done"));
		const reads = reportReads(); const timers = vi.spyOn(globalThis, "setTimeout");
		const r = await b5Runtime(root); await r.start(); reads.opens = reads.bytes = 0;
		async function poll(delay: number, next: number) {
			const count = timers.mock.calls.length;
			await vi.advanceTimersByTimeAsync(delay);
			for (let i = 0; i < 2000 && timers.mock.calls.length === count; i++) await new Promise<void>((done) => realTimeout(done, 1));
			expect(timers.mock.calls.length).toBeGreaterThan(count);
			expect(timers.mock.calls.at(-1)?.[1]).toBe(next);
		}
		await poll(1000, 2000); await poll(2000, 4000);
		expect(reads).toMatchObject({ opens: 0, bytes: 0 });
		// This changes evidence, but neither row identity nor unresolved state.
		fs.writeFileSync(path.join(pending.artifactDir, "run-meta.json"), JSON.stringify({ ...pending, task: "changed private task" }));
		await poll(4000, 1000);
	});

	it("drops known changed cached success even when its new report is budget-deferred", async () => {
		const root = rootDir(); const metas: RunMeta[] = [];
		for (let i = 0; i < 8; i++) { const meta = artifact(root, `row-${i}`); complete(meta); metas.push(meta); }
		orderedDirectory(root, metas.map((m) => m.runId));
		const r = await b5Runtime(root); await r.start(); expect(r.latest()).toHaveLength(8);
		for (const meta of metas.slice(0, 7)) fs.writeFileSync(path.join(meta.artifactDir, "report.json"), JSON.stringify({
			result: { outcome: "failed", answer: "x".repeat(600_000) },
		}));
		await r.observer().refresh();
		expect(r.latest().find((row: any) => row.runId === "row-6")).toBeUndefined();
		expect(r.latest().filter((row: any) => row.state === "failed")).toHaveLength(6);
		await r.observer().refresh();
		expect(r.latest().find((row: any) => row.runId === "row-6")).toMatchObject({ state: "failed" });
	});

	it("retires undefined-provenance terminal evidence when a changed report is budget-deferred", async () => {
		const root = rootDir(); const metas: RunMeta[] = [];
		for (let i = 0; i < 8; i++) { const meta = artifact(root, `row-${i}`); complete(meta); metas.push(meta); }
		orderedDirectory(root, metas.map((meta) => meta.runId));
		// Both probes are unavailable, including on the earlier publication pass.
		// Unavailable provenance must not preserve that old terminal on deferral.
		fs.symlinkSync(rootDir(), path.join(metas[6].artifactDir, "evidence"));
		const reads = reportReads(); const r = await b5Runtime(root); await r.start();
		expect(r.latest()).toContainEqual(expect.objectContaining({ runId: "row-7", state: "completed" }));
		for (const meta of metas.slice(0, 7)) fs.writeFileSync(path.join(meta.artifactDir, "report.json"), JSON.stringify({
			result: { outcome: "failed", answer: "x".repeat(600_000) },
		}));
		reads.opens = reads.bytes = 0;
		await r.observer().refresh();
		expect(reads.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
		expect(r.latest().filter((row: any) => row.state === "failed")).toHaveLength(6);
		expect(r.latest().find((row: any) => row.runId === "row-6")).toBeUndefined();
		await r.observer().refresh();
		expect(r.latest().find((row: any) => row.runId === "row-6")).toBeUndefined();
		// Omission is reversible once provenance becomes available again.
		fs.unlinkSync(path.join(metas[6].artifactDir, "evidence"));
		await r.observer().refresh();
		expect(r.latest().find((row: any) => row.runId === "row-6")).toMatchObject({ state: "failed" });
	});

	it.each(["marker", "metadata"])("rejects a %s mutation during report validation", async (change) => {
		const root = rootDir(); const meta = artifact(root, "race"); complete(meta);
		const reads = reportReads(); const r = await b5Runtime(root);
		reads.afterRead = () => {
			if (change === "marker") fs.writeFileSync(path.join(meta.artifactDir, "completed.json"), "{}");
			else fs.writeFileSync(path.join(meta.artifactDir, "run-meta.json"), JSON.stringify({ ...meta, ownerSessionId: OTHER }));
		};
		await r.start();
		expect(r.latest().some((row: any) => row.state === "completed")).toBe(false);
		await r.observer().refresh();
		expect(r.latest().some((row: any) => row.state === "completed")).toBe(false);
	});

	it("immediately publishes local activity and resets a long unresolved delay", async () => {
		vi.useFakeTimers();
		let callback!: () => void; let local: any[] = [];
		const update = vi.fn(); const timers = vi.spyOn(globalThis, "setTimeout");
		const unknown = { runId: "recovered", ownerSessionId: OWNER, agent: "test", startedAt: 1000, state: "unknown" };
		let release!: (rows: any[]) => void;
		const read = vi.fn(async () => [unknown]);
		const o = observation.createAsyncObservation({ owner: { ownerSessionId: OWNER },
			adapter: () => ({ update, dispose() {} }), readSnapshot: read,
			readLocalSnapshot: () => local, subscribe: (cb: () => void) => { callback = cb; return () => {}; }, emitWake() {} });
		disposers.push(() => o.dispose()); await o.refresh();
		await vi.advanceTimersByTimeAsync(1000); await vi.advanceTimersByTimeAsync(2000);
		expect(timers.mock.calls.at(-1)?.[1]).toBe(4000);
		read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
		local = [{ ...unknown, runId: "live", state: "running" }]; callback();
		expect(update.mock.calls.at(-1)?.[0]).toContainEqual(local[0]);
		release([unknown, ...local]); await o.refresh();
		expect(timers.mock.calls.at(-1)?.[1]).toBe(1000);
		o.dispose(); const count = update.mock.calls.length; callback();
		await vi.advanceTimersByTimeAsync(30000); expect(update).toHaveBeenCalledTimes(count);
	});
});


describe("B5 cache commit generation guards", () => {
	it("requires stable evidence on a cache hit too", async () => {
		const row = { runId: "cached", ownerSessionId: OWNER, agent: "test", startedAt: 1000, state: "completed" };
		const read = vi.fn(async () => row);
		let version = "A"; let probes = 0; let mutate = false;
		const item = { key: "opaque", read, fingerprint: async () => {
			probes++;
			if (mutate && probes % 2 === 0) version = "B";
			return version;
		} };
		const scan = observation.createRecoveryScan({ local: () => [], open: async () => {
			let sent = false; return { close: async () => {}, read: async () => sent ? null : (sent = true, item) };
		} });
		disposers.push(() => scan.dispose());
		await scan.pass([]); expect(read).toHaveBeenCalledTimes(1);
		mutate = true;
		const page = await scan.pass([]);
		expect(page.rows.some((value: any) => value.state === "completed")).toBe(false);
		expect(page.complete).toBe(false);
	});

	it("does not cache a terminal read retired by invalidation", async () => {
		const row = { runId: "cached", ownerSessionId: OWNER, agent: "test", startedAt: 1000, state: "completed" };
		let release!: (value: any) => void;
		const read = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })).mockResolvedValue(row);
		const item = { key: "opaque", read, fingerprint: async () => "stable" };
		const scan = observation.createRecoveryScan({ local: () => [], open: async () => {
			let sent = false; return { close: async () => {}, read: async () => sent ? null : (sent = true, item) };
		} });
		disposers.push(() => scan.dispose());
		const pending = scan.pass([]);
		while (!release) await Promise.resolve();
		scan.invalidate(); release(row); await pending;
		await scan.pass([]); expect(read).toHaveBeenCalledTimes(2);
	});
});


describe("B5 cached provenance and stable identity", () => {
	it("revalidates cached relative metadata after cwd provenance changes", async () => {
		const root = rootDir(); const meta = artifact(root, "relative"); complete(meta);
		fs.writeFileSync(path.join(meta.artifactDir, "run-meta.json"), JSON.stringify({ ...meta,
			artifactDir: path.relative(process.cwd(), meta.artifactDir),
			stdoutFile: path.relative(process.cwd(), meta.stdoutFile), stderrFile: path.relative(process.cwd(), meta.stderrFile),
		}));
		const r = await b5Runtime(root); await r.start(); expect(r.latest()).toMatchObject([{ state: "completed" }]);
		vi.spyOn(process, "cwd").mockReturnValue(rootDir());
		await r.observer().refresh(); expect(r.latest()).toEqual([]);
	});

	it("notices replacement marker identity even with identical size and restored mtime", async () => {
		const root = rootDir(); const meta = artifact(root, "replace"); complete(meta);
		const reads = reportReads(); const r = await b5Runtime(root); await r.start(); reads.opens = reads.bytes = 0;
		const marker = path.join(meta.artifactDir, "completed.json"); const stat = fs.statSync(marker);
		const content = fs.readFileSync(marker); fs.renameSync(marker, marker + ".old"); fs.writeFileSync(marker, content);
		fs.utimesSync(marker, stat.atime, stat.mtime);
		await r.observer().refresh(); expect(reads.opens).toBe(1);
		expect(r.latest()).toMatchObject([{ state: "completed" }]);
	});
});


describe("B5 coalesced lifecycle reconciliation", () => {
	it("cancels the unresolved timer when a coalesced local event finishes terminal", async () => {
		vi.useFakeTimers();
		let localEvent!: () => void; let sent = false;
		const base = { runId: "run", ownerSessionId: OWNER, agent: "test", startedAt: 1000 };
		const read = vi.fn().mockResolvedValueOnce([{ ...base, state: "unknown" }]).mockResolvedValue([{ ...base, state: "completed" }]);
		const o = observation.createAsyncObservation({ owner: { ownerSessionId: OWNER },
			adapter: () => ({ dispose() {}, update(rows: any[]) {
				if (!sent && rows.some((row) => row.state === "unknown")) { sent = true; localEvent(); }
			} }), readSnapshot: read,
			subscribe: (cb: () => void) => { localEvent = cb; return () => {}; }, emitWake() {} });
		disposers.push(() => o.dispose()); await o.refresh();
		expect(read).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
	});

	it("retires in-flight cache validation on explicit refresh without restarting completed continuation pages", async () => {
		const base = { runId: "run", ownerSessionId: OWNER, agent: "test", startedAt: 1000, state: "completed" };
		let release!: (value: any) => void;
		const read = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })).mockResolvedValue(base);
		const item = { key: "opaque", read, fingerprint: async () => "stable" };
		const o = observation.createAsyncObservation({ owner: { ownerSessionId: OWNER },
			adapter: () => ({ update() {}, dispose() {} }), recovery: { local: () => [], open: async () => {
				let sent = false; return { close: async () => {}, read: async () => sent ? null : (sent = true, item) };
			} }, subscribe: () => () => {}, emitWake() {} });
		disposers.push(() => o.dispose()); const pending = o.refresh();
		while (!release) await Promise.resolve();
		const refreshed = o.refresh(); release(base); await pending; await refreshed;
		expect(read).toHaveBeenCalledTimes(2);
	});
});
