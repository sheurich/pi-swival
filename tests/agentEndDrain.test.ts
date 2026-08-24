import { describe, expect, it, vi } from "vitest";
import {
	AGENT_END_DRAIN_POLL_MS,
	DEFAULT_AGENT_END_DRAIN_TIMEOUT_MS,
	drainOwnedAsyncRuns,
	hasOwnedActiveRun,
	validateDrainPollIntervalMs,
	validateDrainTimeoutMs,
} from "../extensions/runtime.js";

/**
 * Unit tests for the pi-swival-owned `agent_end` headless drain helper.
 * These exercise `drainOwnedAsyncRuns` / `hasOwnedActiveRun` directly, with
 * an injected `onWake` stand-in for `pi-swival:run-finished` so the tests
 * are deterministic and don't need a real swival process. Wiring-level
 * coverage (the actual `pi.on("agent_end", ...)` handler, ctx.hasUI, and a
 * real async spawn) lives in extensionWiring.test.ts.
 */

interface Entry {
	meta: { sessionId?: string };
	exited: boolean;
}

/** A stub wake channel: captures the latest subscriber and lets tests fire it manually. */
function makeWakeChannel() {
	let listener: (() => void) | undefined;
	let subscribeCount = 0;
	let unsubscribeCount = 0;
	const onWake = (l: () => void) => {
		listener = l;
		subscribeCount++;
		return () => {
			unsubscribeCount++;
			if (listener === l) listener = undefined;
		};
	};
	return {
		onWake,
		fire: () => listener?.(),
		get subscribeCount() { return subscribeCount; },
		get unsubscribeCount() { return unsubscribeCount; },
		get hasActiveListener() { return listener !== undefined; },
	};
}

describe("hasOwnedActiveRun", () => {
	it("is false for empty aliases, exited entries, or entries owned by another session", () => {
		const entries: Entry[] = [
			{ meta: { sessionId: "mine" }, exited: true },
			{ meta: { sessionId: "theirs" }, exited: false },
			{ meta: { sessionId: undefined }, exited: false },
		];
		expect(hasOwnedActiveRun(entries, ["mine"])).toBe(false);
		expect(hasOwnedActiveRun(entries, [])).toBe(false);
	});

	it("is true for a non-exited entry owned by any exact alias", () => {
		const entries: Entry[] = [{ meta: { sessionId: "session-uuid" }, exited: false }];
		expect(hasOwnedActiveRun(entries, ["session-file.jsonl", "session-uuid"])).toBe(true);
	});
});

describe("validateDrainTimeoutMs", () => {
	it("accepts positive finite values", () => {
		expect(validateDrainTimeoutMs(1)).toBe(1);
		expect(validateDrainTimeoutMs(DEFAULT_AGENT_END_DRAIN_TIMEOUT_MS)).toBe(DEFAULT_AGENT_END_DRAIN_TIMEOUT_MS);
	});

	it("rejects zero, negative, NaN, and non-finite values", () => {
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => validateDrainTimeoutMs(bad)).toThrow();
		}
	});
});

describe("validateDrainPollIntervalMs", () => {
	it("accepts positive finite values", () => {
		expect(validateDrainPollIntervalMs(1)).toBe(1);
		expect(validateDrainPollIntervalMs(AGENT_END_DRAIN_POLL_MS)).toBe(AGENT_END_DRAIN_POLL_MS);
	});

	it("rejects zero, negative, NaN, and non-finite values", () => {
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => validateDrainPollIntervalMs(bad)).toThrow();
		}
	});
});

describe("drainOwnedAsyncRuns", () => {
	it("rejects an invalid timeout before doing any work", async () => {
		await expect(drainOwnedAsyncRuns(() => [], ["mine"], 0)).rejects.toThrow();
	});

	it("rejects an invalid poll interval before doing any work, so it cannot busy-loop", async () => {
		const entries: Entry[] = [{ meta: { sessionId: "mine" }, exited: false }];
		for (const bad of [0, -1, Number.NaN]) {
			await expect(
				drainOwnedAsyncRuns(() => entries, ["mine"], 5_000, { pollIntervalMs: bad }),
			).rejects.toThrow();
		}
	});

	it("waits while an owned run is active, then resolves once it completes", async () => {
		const entries: Entry[] = [{ meta: { sessionId: "mine" }, exited: false }];
		const wake = makeWakeChannel();

		let resolved = false;
		const drain = drainOwnedAsyncRuns(() => entries, ["mine"], 5_000, {
			pollIntervalMs: 1_000_000, // never fire on its own within this test
			onWake: wake.onWake,
		}).then(() => { resolved = true; });

		await vi.waitFor(() => expect(wake.hasActiveListener).toBe(true));
		expect(resolved).toBe(false);

		entries[0]!.exited = true;
		wake.fire();

		await drain;
		expect(resolved).toBe(true);
		expect(wake.unsubscribeCount).toBe(wake.subscribeCount);
	});

	it("does not block on a run owned by a different session", async () => {
		const entries: Entry[] = [{ meta: { sessionId: "another-session" }, exited: false }];
		const onWake = vi.fn(() => {
			throw new Error("must not subscribe to wake events when no owned run is active");
		});

		await drainOwnedAsyncRuns(() => entries, ["mine"], 5_000, { onWake });
		expect(onWake).not.toHaveBeenCalled();
	});

	it("also awaits work added while draining, not just the initial snapshot", async () => {
		const entries: Entry[] = [{ meta: { sessionId: "mine" }, exited: false }];
		const wake = makeWakeChannel();

		let resolved = false;
		const drain = drainOwnedAsyncRuns(() => entries, ["mine"], 5_000, {
			pollIntervalMs: 1_000_000,
			onWake: wake.onWake,
		}).then(() => { resolved = true; });

		await vi.waitFor(() => expect(wake.hasActiveListener).toBe(true));

		// First run finishes, but a second owned run shows up before the drain
		// re-checks — it must keep waiting for the new one too.
		entries[0]!.exited = true;
		entries.push({ meta: { sessionId: "mine" }, exited: false });
		wake.fire();

		await vi.waitFor(() => expect(wake.hasActiveListener).toBe(true));
		expect(resolved).toBe(false);

		entries[1]!.exited = true;
		wake.fire();

		await drain;
		expect(resolved).toBe(true);
	});

	it("times out cleanly without killing the run and without leaking a wake listener", async () => {
		// Fake timers make the timeout/poll deterministic instead of depending on
		// real wall-clock waits (both `setTimeout` and `Date.now` are virtualized).
		vi.useFakeTimers();
		try {
			const entries: Entry[] = [{ meta: { sessionId: "mine" }, exited: false }];
			const wake = makeWakeChannel(); // deliberately never fired — simulates a missed event

			const drain = drainOwnedAsyncRuns(() => entries, ["mine"], 40, {
				pollIntervalMs: 10,
				onWake: wake.onWake,
			});

			await vi.advanceTimersByTimeAsync(40);
			await drain;

			// Timed out, not "finished": the entry is untouched (drain never kills/interrupts).
			expect(entries[0]!.exited).toBe(false);
			expect(wake.subscribeCount).toBeGreaterThan(0);
			expect(wake.unsubscribeCount).toBe(wake.subscribeCount);
			expect(wake.hasActiveListener).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("falls back to polling at the default interval when no onWake is supplied", async () => {
		vi.useFakeTimers();
		try {
			const entries: Entry[] = [{ meta: { sessionId: "mine" }, exited: false }];
			const start = Date.now();
			// No onWake at all: must still return once the (virtual) timeout elapses,
			// purely from polling — no real wall-clock wait involved.
			const drain = drainOwnedAsyncRuns(() => entries, ["mine"], 30, { pollIntervalMs: 10 });
			await vi.advanceTimersByTimeAsync(30);
			await drain;
			expect(Date.now() - start).toBeGreaterThanOrEqual(25);
			expect(AGENT_END_DRAIN_POLL_MS).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
