import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
	mapWithConcurrency,
	computeErrorMessage,
	scheduleProcessGroupKillEscalation,
	terminateProcessGroup,
	TaskItem,
	ChainItem,
} from "../extensions/index.js";

describe("TaskItem schema", () => {
	it("forbids additional properties (rejects silently-dropped unknown fields)", () => {
		// Guards the defect class where new param names (e.g. sibling
		// subagent's `reads`, `progress`, `skill`) would be silently
		// discarded instead of surfacing as a validation error.
		expect((TaskItem as unknown as { additionalProperties?: boolean }).additionalProperties).toBe(false);
	});
});

describe("ChainItem schema", () => {
	it("forbids additional properties", () => {
		expect((ChainItem as unknown as { additionalProperties?: boolean }).additionalProperties).toBe(false);
	});
});

describe("mapWithConcurrency", () => {	it("never runs more than `concurrency` tasks simultaneously", async () => {
		let inFlight = 0;
		let peak = 0;
		const items = Array.from({ length: 6 }, (_, i) => i);

		await mapWithConcurrency(items, 2, async (_item) => {
			inFlight++;
			if (inFlight > peak) peak = inFlight;
			// Short await so scheduler has a chance to start a second worker
			// but not the third before one of the first two resolves.
			await new Promise((r) => setTimeout(r, 10));
			inFlight--;
			return null;
		});

		expect(peak).toBeLessThanOrEqual(2);
		// Sanity: we did schedule more than one concurrently.
		expect(peak).toBeGreaterThan(1);
	});

	it("runs items serially when concurrency=1", async () => {
		let inFlight = 0;
		let peak = 0;
		await mapWithConcurrency([1, 2, 3, 4], 1, async () => {
			inFlight++;
			if (inFlight > peak) peak = inFlight;
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return null;
		});
		expect(peak).toBe(1);
	});

	it("preserves input order in results", async () => {
		const items = [10, 20, 30, 40];
		// Stagger completion time so fast items finish before slow ones, yet
		// the result array must still match input order.
		const results = await mapWithConcurrency(items, 4, async (item) => {
			await new Promise((r) => setTimeout(r, 40 - item));
			return item * 2;
		});
		expect(results).toEqual([20, 40, 60, 80]);
	});
});

describe("scheduleProcessGroupKillEscalation", () => {
	afterEach(() => vi.useRealTimers());

	it("retains SIGKILL escalation when the leader closes but the group remains", () => {
		vi.useFakeTimers();
		const proc = new EventEmitter();
		const kill = vi.fn();
		scheduleProcessGroupKillEscalation(proc, 1234, kill);
		proc.emit("close");
		vi.advanceTimersByTime(5000);
		expect(kill).toHaveBeenCalledWith(-1234, 0);
		expect(kill).toHaveBeenCalledWith(-1234, "SIGKILL");
	});

	it("cancels SIGKILL only when a close-time probe confirms the group is gone", () => {
		vi.useFakeTimers();
		const proc = new EventEmitter();
		const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
			if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
		});
		scheduleProcessGroupKillEscalation(proc, 1234, kill);
		proc.emit("close");
		vi.advanceTimersByTime(5000);
		expect(kill).toHaveBeenCalledWith(-1234, 0);
		expect(kill).not.toHaveBeenCalledWith(-1234, "SIGKILL");
	});

	it("escalates a still-running process group after five seconds", () => {
		vi.useFakeTimers();
		const proc = new EventEmitter();
		const kill = vi.fn();
		scheduleProcessGroupKillEscalation(proc, 1234, kill);
		vi.advanceTimersByTime(5000);
		expect(kill).toHaveBeenCalledWith(-1234, "SIGKILL");
	});

	it("skips SIGKILL when the process group exits during the grace period", () => {
		vi.useFakeTimers();
		const proc = new EventEmitter();
		const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
			if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
		});
		scheduleProcessGroupKillEscalation(proc, 1234, kill);
		vi.advanceTimersByTime(5000);
		expect(kill).toHaveBeenCalledWith(-1234, 0);
		expect(kill).not.toHaveBeenCalledWith(-1234, "SIGKILL");
	});
});

describe("terminateProcessGroup", () => {
	afterEach(() => vi.useRealTimers());

	it("verifies the process group is gone when the leader closes after SIGTERM", async () => {
		const proc = new EventEmitter();
		const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
			if (signal === "SIGTERM") proc.emit("close");
			if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
		});
		await expect(terminateProcessGroup(proc, 1234, kill, 100, 50)).resolves.toBe(true);
		expect(kill).toHaveBeenCalledWith(-1234, "SIGTERM");
		expect(kill).toHaveBeenCalledWith(-1234, 0);
		expect(kill).not.toHaveBeenCalledWith(-1234, "SIGKILL");
	});

	it("escalates when the leader closes but the process group remains", async () => {
		vi.useFakeTimers();
		const proc = new EventEmitter();
		let groupExists = true;
		const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
			if (signal === "SIGTERM") proc.emit("close");
			if (signal === "SIGKILL") groupExists = false;
			if (signal === 0 && !groupExists) {
				throw Object.assign(new Error("gone"), { code: "ESRCH" });
			}
		});
		const termination = terminateProcessGroup(proc, 1234, kill, 100, 50);
		await vi.advanceTimersByTimeAsync(150);
		await expect(termination).resolves.toBe(true);
		expect(kill).toHaveBeenCalledWith(-1234, "SIGKILL");
	});

	it("escalates a TERM-ignoring process and verifies the group is gone", async () => {
		vi.useFakeTimers();
		const proc = new EventEmitter();
		let groupExists = true;
		const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
			if (signal === "SIGKILL") {
				groupExists = false;
				proc.emit("close");
			}
			if (signal === 0 && !groupExists) {
				throw Object.assign(new Error("gone"), { code: "ESRCH" });
			}
		});
		const termination = terminateProcessGroup(proc, 1234, kill, 100, 50);
		await vi.advanceTimersByTimeAsync(100);
		await expect(termination).resolves.toBe(true);
		expect(kill).toHaveBeenCalledWith(-1234, "SIGTERM");
		expect(kill).toHaveBeenCalledWith(-1234, "SIGKILL");
		expect(kill).toHaveBeenCalledWith(-1234, 0);
	});

	it("skips SIGKILL when the process group exits during the grace period", async () => {
		vi.useFakeTimers();
		const proc = new EventEmitter();
		const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
			if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
		});
		const termination = terminateProcessGroup(proc, 1234, kill, 100, 50);
		await vi.advanceTimersByTimeAsync(100);
		await expect(termination).resolves.toBe(true);
		expect(kill).not.toHaveBeenCalledWith(-1234, "SIGKILL");
	});

	it("returns false when no close is observed after SIGKILL", async () => {
		vi.useFakeTimers();
		const proc = new EventEmitter();
		const kill = vi.fn();
		const termination = terminateProcessGroup(proc, 1234, kill, 100, 50);
		await vi.advanceTimersByTimeAsync(150);
		await expect(termination).resolves.toBe(false);
	});
});

describe("computeErrorMessage", () => {
	// Regression for the `??` vs `||` bug: when classifyFailure returns
	// undefined AND the stderr tail is empty, we used to get an empty
	// errorMessage because `??` let "" pass through as a "defined" value.
	it("never returns an empty string when classification and stderr are empty", () => {
		const msg = computeErrorMessage({ classifiedText: undefined, stderrTail: "", exitCode: 1, outcome: "unknown" });
		expect(msg).toBeTruthy();
		expect(msg!.length).toBeGreaterThan(0);
		expect(msg).toMatch(/swival exited 1/);
	});

	it("falls back through empty classification to stderr tail", () => {
		const msg = computeErrorMessage({
			classifiedText: "",
			stderrTail: "real stderr line",
			exitCode: 1,
			outcome: "unknown",
		});
		expect(msg).toBe("real stderr line");
	});

	it("prefers the classified text when present", () => {
		const msg = computeErrorMessage({
			classifiedText: "AWS SSO session expired — run `aws sso login` and retry.",
			stderrTail: "something less helpful",
			exitCode: 1,
			outcome: "error",
		});
		expect(msg).toMatch(/AWS SSO/);
	});

	it("reports outcome when exit=0 but the report marks the run a failure", () => {
		const msg = computeErrorMessage({
			classifiedText: undefined,
			stderrTail: "",
			exitCode: 0,
			outcome: "failed",
		});
		expect(msg).toMatch(/outcome=failed/);
	});
});
