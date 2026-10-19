import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import registerExtension from "../extensions/index.js";
import { inspectNativeAudit, prepareNativeAudit, type NativeAuditLaunch, type NativeTerminal } from "../extensions/native-audit.js";
import { nativeScratch } from "./nativeFixtures.js";

vi.mock("../extensions/native-audit.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../extensions/native-audit.js")>(),
	prepareNativeAudit: vi.fn(), inspectNativeAudit: vi.fn(),
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
// An event-loop barrier, not a timing assumption: flush ready continuations while
// the explicitly controlled preparation/completion promises remain unresolved.
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function observed(promise: Promise<unknown>) {
	const state = { settled: false };
	void promise.then(() => { state.settled = true; }, () => { state.settled = true; });
	return state;
}
const roots: string[] = [];
afterEach(() => {
	vi.resetAllMocks();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = nativeScratch("native-shutdown-"); roots.push(root);
	let tool: any;
	let shutdown!: () => Promise<void>;
	registerExtension({ registerTool: (value: unknown) => { tool = value; },
		on: (event: string, handler: () => Promise<void>) => { if (event === "session_shutdown") shutdown = handler; },
	} as any, { artifactRoot: root });
	return { shutdown, execute: () => tool.execute("shutdown-test", { audit: {} }, undefined, undefined, { cwd: root, hasUI: false }) as Promise<any> };
}
function liveRun() {
	const terminal = deferred<NativeTerminal>();
	const run = { route: { provider: "openrouter", model: "offline" },
		meta: { task: "/audit", startedAt: Date.now() }, proc: {},
		completion: terminal.promise, cancel: vi.fn(),
	} as unknown as NativeAuditLaunch;
	return { run, terminal };
}
const completed = { exitCode: 0, shutdown: "verified", boundary: "agentfs-cli", exitedAt: new Date().toISOString() } as NativeTerminal;

describe("native preparation session shutdown", () => {
	it("aborts and awaits deferred preparation rejection on repeated shutdown", async () => {
		const preparation = deferred<NativeAuditLaunch>();
		vi.mocked(prepareNativeAudit).mockReturnValue(preparation.promise);
		const f = fixture(); const execution = f.execute();
		const signal = vi.mocked(prepareNativeAudit).mock.calls[0][7]!;
		const first = f.shutdown(); const second = f.shutdown();
		const firstState = observed(first); const secondState = observed(second);
		await turn();
		const pending = [firstState.settled, secondState.settled];
		const aborted = signal.aborted;
		preparation.reject(new Error("controlled preparation rejection"));
		const [result] = await Promise.all([execution, first, second]);
		await f.shutdown();
		expect(aborted).toBe(true);
		expect(pending, "shutdown must await preparation settlement").toEqual([false, false]);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("controlled preparation rejection");
		expect(inspectNativeAudit).not.toHaveBeenCalled();
	});

	it("cancels a late returned live run and awaits its completion and inspection", async () => {
		const preparation = deferred<NativeAuditLaunch>(); const live = liveRun();
		const inspection = deferred<Awaited<ReturnType<typeof inspectNativeAudit>>>();
		vi.mocked(prepareNativeAudit).mockReturnValue(preparation.promise);
		vi.mocked(inspectNativeAudit).mockReturnValue(inspection.promise);
		const f = fixture(); const execution = f.execute();
		const shutdown = f.shutdown(); const state = observed(shutdown);
		preparation.resolve(live.run); await turn();
		const beforeCompletion = state.settled;
		const cancelled = vi.mocked(live.run.cancel).mock.calls.length;
		live.terminal.resolve(completed); await turn();
		const beforeInspection = state.settled;
		inspection.resolve({ status: "failed", error: "cancelled" });
		await Promise.all([execution, shutdown]); await f.shutdown();
		expect(cancelled, "late live handles must be cancelled even if preparation missed abort").toBeGreaterThan(0);
		expect(beforeCompletion).toBe(false); expect(beforeInspection).toBe(false);
	});

	it("drains concurrent preparation, active run, and completion rejection without deadlock", async () => {
		const active = liveRun(); const late = liveRun();
		const rejecting = deferred<NativeAuditLaunch>(); const preparing = deferred<NativeAuditLaunch>();
		vi.mocked(prepareNativeAudit).mockResolvedValueOnce(active.run).mockReturnValueOnce(rejecting.promise).mockReturnValueOnce(preparing.promise);
		vi.mocked(inspectNativeAudit).mockResolvedValue({ status: "failed", error: "cancelled" });
		const f = fixture(); const executions = [f.execute(), f.execute(), f.execute()];
		await turn();
		const shutdowns = [f.shutdown(), f.shutdown()]; const states = shutdowns.map(observed);
		rejecting.reject(new Error("preparation failed")); active.terminal.reject(new Error("finalization failed"));
		await turn(); const pending = states.map((state) => state.settled);
		preparing.resolve(late.run); await turn();
		const lateCancelled = vi.mocked(late.run.cancel).mock.calls.length;
		late.terminal.reject(new Error("late finalization failed"));
		const results = await Promise.all(executions); await Promise.all(shutdowns); await f.shutdown();
		expect(active.run.cancel).toHaveBeenCalled(); expect(lateCancelled).toBeGreaterThan(0);
		expect(pending).toEqual([false, false]); expect(results.every((result) => result.isError)).toBe(true);
	});

	it("cancels preparation admitted while shutdown is draining, but permits later session reuse", async () => {
		const first = deferred<NativeAuditLaunch>(); const second = deferred<NativeAuditLaunch>();
		vi.mocked(prepareNativeAudit).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const f = fixture(); const a = f.execute(); const shutdown = f.shutdown();
		const b = f.execute();
		const signal = vi.mocked(prepareNativeAudit).mock.calls[1][7]!;
		const aborted = signal.aborted;
		first.reject(new Error("cancelled first")); await turn();
		const state = observed(shutdown); await turn(); const pending = state.settled;
		second.reject(new Error("cancelled second")); await Promise.all([a, b, shutdown]);
		const normal = liveRun(); vi.mocked(prepareNativeAudit).mockResolvedValueOnce(normal.run);
		vi.mocked(inspectNativeAudit).mockResolvedValue({ status: "completed", answer: "normal audit" });
		const execution = f.execute(); await turn(); normal.terminal.resolve(completed);
		const result = await execution; await f.shutdown();
		expect(aborted).toBe(true); expect(pending).toBe(false);
		expect(result.isError).toBe(false); expect(result.content[0].text).toContain("normal audit");
		expect(normal.run.cancel).not.toHaveBeenCalled();
		expect(vi.mocked(prepareNativeAudit).mock.calls[2][7]!.aborted).toBe(false);
	});
});
