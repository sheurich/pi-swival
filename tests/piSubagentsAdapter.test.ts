import { describe, expect, it, vi } from "vitest";

const adapterModule = await import("../integrations/pi-subagents.js").catch(() => ({} as any));
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const FILE = "/synthetic/session.jsonl";

// A public-contract fixture. No private consumer registry access is needed.
function consumer() {
	const runs = new Map<string, any>();
	let provider: any;
	const key = (session: string, id: string) => `${session}\0${id}`;
	const api = {
		registerExternalRun: vi.fn((run: any) => {
			if (runs.has(key(run.sessionId, run.id))) throw new Error("duplicate");
			if (runs.size >= 100) throw new Error("capacity");
			runs.set(key(run.sessionId, run.id), { ...run }); return { ...run };
		}),
		updateExternalRun: vi.fn((session: string, id: string, patch: any) => {
			const previous = runs.get(key(session, id)); if (!previous) throw new Error("missing");
			const next = { ...previous, ...patch }; runs.set(key(session, id), next); return { ...next };
		}),
		unregisterExternalRun: vi.fn((session: string, id: string) => runs.delete(key(session, id))),
		registerBackgroundWorkProvider: vi.fn((value: any) => {
			provider = value; return () => { if (provider === value) provider = undefined; };
		}),
	};
	return { api, runs, provider: () => provider };
}

function row(state = "running", fields: Record<string, unknown> = {}) {
	return { runId: "swival-run-1000-abcd", ownerSessionId: OWNER, ownerSessionFile: FILE,
		agent: "test", startedAt: 1000, state, ...fields };
}

function start(api: any, owner = { ownerSessionId: OWNER, ownerSessionFile: FILE }) {
	expect(adapterModule.createPiSubagentsAdapter).toBeTypeOf("function");
	const adapter = adapterModule.createPiSubagentsAdapter(api);
	const diagnostic = vi.fn();
	const registration = adapter({ owner, onDiagnostic: diagnostic });
	return { adapter, registration, diagnostic };
}

describe("optional pi-subagents public adapter", () => {
	it("does not register before a session uses the explicit adapter", () => {
		const c = consumer();
		expect(adapterModule.createPiSubagentsAdapter).toBeTypeOf("function");
		adapterModule.createPiSubagentsAdapter(c.api);
		for (const fn of Object.values(c.api)) expect(fn).not.toHaveBeenCalled();
	});

	it("projects the consumer session file while keeping UUID ownership authoritative", () => {
		const c = consumer(); const { registration } = start(c.api);
		registration.update([row(), row("running", { runId: "foreign", ownerSessionId: OTHER }),
			row("running", { runId: "legacy", ownerSessionId: undefined })]);
		expect([...c.runs.values()]).toMatchObject([{ sessionId: FILE, state: "running", source: "swival" }]);
		expect(c.provider().listActiveWork({ sessionId: FILE, nowMs: 1000 })).toMatchObject([{ sessionId: FILE }]);
		expect(c.provider().listActiveWork({ sessionId: OWNER, nowMs: 1000 })).toEqual([]);
		expect(c.provider().wakeChannels).toEqual(["pi-swival:async-observation"]);
		expect(c.provider()).not.toHaveProperty("stop");
		registration.dispose();
	});

	it("falls back to UUID for an in-memory consumer session", () => {
		const c = consumer(); const { registration } = start(c.api, { ownerSessionId: OWNER } as any);
		registration.update([row("running", { ownerSessionFile: undefined })]);
		expect([...c.runs.values()][0].sessionId).toBe(OWNER);
		registration.dispose();
	});

	it("does not fabricate a consumer state for unknown recovered activity", () => {
		const c = consumer(); const { registration, diagnostic } = start(c.api);
		registration.update([row("unknown")]);
		expect(c.runs.size).toBe(0); expect(c.provider().listActiveWork()).toEqual([]);
		expect(diagnostic).toHaveBeenCalledWith(expect.stringMatching(/unknown/i));
		registration.update([row("completed")]);
		expect([...c.runs.values()]).toMatchObject([{ state: "completed" }]);
		registration.dispose();
	});

	it("updates display-only terminal states and removes wait activity without returning output", () => {
		const c = consumer(); const { registration } = start(c.api);
		registration.update([row()]); const initial = c.provider().listActiveWork();
		registration.update([row("failed", { endedAt: 2000, answer: "private answer" })]);
		expect(initial).toHaveLength(1); expect(c.provider().listActiveWork()).toEqual([]);
		expect([...c.runs.values()]).toMatchObject([{ state: "failed" }]);
		expect(JSON.stringify([...c.runs.values()])).not.toContain("private answer");
		expect(c.api.updateExternalRun).toHaveBeenCalledTimes(1);
		registration.dispose();
	});

	it("keeps synchronous provider reads cached and returns independent arrays", () => {
		const c = consumer(); const { registration } = start(c.api);
		registration.update([row()]);
		const first = c.provider().listActiveWork(); first[0].id = "mutated"; first.pop();
		expect(c.provider().listActiveWork()).toHaveLength(1);
		expect(c.provider().listActiveWork()[0].id).not.toBe("mutated");
		for (let i = 0; i < 50; i++) c.provider().listActiveWork({ sessionId: FILE, nowMs: i });
		expect(c.api.registerExternalRun).toHaveBeenCalledTimes(1);
		expect(c.api.updateExternalRun).not.toHaveBeenCalled();
		registration.dispose();
	});

	it("bounds Fleet rows separately from background wait items", () => {
		const c = consumer(); const { registration } = start(c.api);
		registration.update(Array.from({ length: 110 }, (_, i) => row("running", { runId: `run-${i}` })));
		expect(c.runs.size).toBeLessThanOrEqual(20);
		expect(c.provider().listActiveWork()).toHaveLength(100);
		registration.dispose(); expect(c.runs.size).toBe(0);
	});

	it("rolls back partial display registration when a public API fails", () => {
		const c = consumer(); const { registration, diagnostic } = start(c.api);
		let calls = 0;
		c.api.registerExternalRun.mockImplementation((run) => {
			if (++calls === 2) throw new Error("private error text");
			c.runs.set(`${run.sessionId}\0${run.id}`, run); return run;
		});
		registration.update([row(), row("running", { runId: "second" })]);
		expect(c.runs.size).toBe(0); expect(c.provider()).toBeUndefined();
		expect(diagnostic).toHaveBeenCalledWith(expect.stringMatching(/unavailable/i));
		expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private error text");
		registration.dispose();
	});

	it("reports a provider registration failure without leaving display rows", () => {
		const c = consumer();
		c.api.registerBackgroundWorkProvider.mockImplementation(() => { throw new Error("capacity"); });
		const { registration, diagnostic } = start(c.api);
		registration.update([row()]);
		expect(c.runs.size).toBe(0);
		expect(diagnostic).toHaveBeenCalledWith(expect.stringMatching(/unavailable/i));
		registration.dispose();
	});

	it("retires old callbacks and prevents old cleanup from deleting replacement registrations", () => {
		const c = consumer(); const first = start(c.api);
		first.registration.update([row()]); const stale = c.provider();
		const second = start(c.api); second.registration.update([row()]);
		const current = c.provider();
		first.registration.update([row("failed")]); first.registration.dispose(); first.registration.dispose();
		expect(c.provider()).toBe(current);
		expect(c.runs.size).toBe(1);
		expect(stale.listActiveWork()).toEqual([]);
		expect([...c.runs.values()][0].state).toBe("running");
		second.registration.dispose(); expect(c.runs.size).toBe(0); expect(c.provider()).toBeUndefined();
	});

	it("filters malformed rows and duplicate identities before public registration", () => {
		const c = consumer(); const { registration } = start(c.api);
		registration.update([row(), row(), row("running", { runId: "bad\nidentity" }),
			row("running", { runId: "bad-time", startedAt: -1 }),
			row("running", { runId: "x".repeat(5000) })]);
		expect(c.runs.size).toBe(1); expect(c.provider().listActiveWork()).toHaveLength(1);
		registration.dispose();
	});

	it("completes all teardown steps even when public callbacks throw", () => {
		const c = consumer();
		const providerDispose = vi.fn(() => { throw new Error("private failure"); });
		c.api.registerBackgroundWorkProvider.mockReturnValue(providerDispose);
		const { registration, diagnostic } = start(c.api);
		registration.update([row(), row("running", { runId: "second" })]);
		c.api.unregisterExternalRun.mockImplementation(() => { throw new Error("private failure"); });
		expect(() => { registration.dispose(); registration.dispose(); }).not.toThrow();
		expect(c.api.unregisterExternalRun).toHaveBeenCalledTimes(2);
		expect(providerDispose).toHaveBeenCalledOnce();
		expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private failure");
	});

	it("wait cancellation has no execution control and leaves the active snapshot intact", () => {
		const c = consumer(); const { registration } = start(c.api);
		registration.update([row()]);
		const abort = new AbortController(); abort.abort();
		expect(c.provider().listActiveWork()).toHaveLength(1);
		expect(Object.keys(c.provider()).sort()).toEqual(["listActiveWork", "name", "wakeChannels"]);
		registration.dispose();
	});
});
