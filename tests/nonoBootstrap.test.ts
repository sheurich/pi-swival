import { describe, expect, it } from "vitest";
import {
	classifyFailure,
	enforceCompletedAsyncNono,
	enforceNonoBootstrap,
	isNonoRequested,
	isRunFailure,
	nonoBootstrapFailure,
	summarizeReport,
} from "../extensions/index.js";

const makeReport = (sandbox?: Record<string, unknown>) =>
	summarizeReport({ result: { outcome: "success", answer: "completed answer" }, sandbox });

describe("isNonoRequested", () => {
	it("detects --sandbox nono in args", () => {
		expect(isNonoRequested(["--sandbox", "nono"])).toBe(true);
		expect(isNonoRequested(["--sandbox=nono"])).toBe(true);
		expect(isNonoRequested(["--sandbox", "agentfs"])).toBe(false);
		expect(isNonoRequested(["--sandbox", "builtin"])).toBe(false);
		expect(isNonoRequested([])).toBe(false);
	});
});

describe("nonoBootstrapFailure", () => {
	it("is a no-op when nono was not requested", () => {
		expect(nonoBootstrapFailure(false, undefined)).toBeUndefined();
		expect(nonoBootstrapFailure(false, makeReport({ mode: "builtin" }))).toBeUndefined();
	});

	it("fails when nono was requested but no report exists", () => {
		const failure = nonoBootstrapFailure(true, undefined);
		expect(failure).toBeDefined();
		expect(failure?.text).toMatch(/no report/i);
		expect(failure?.code).toBe("config_error");
	});

	it("fails when nono was requested but report.sandbox.mode says builtin", () => {
		const report = makeReport({ mode: "builtin" });
		const failure = nonoBootstrapFailure(true, report);
		expect(failure).toBeDefined();
		expect(failure?.text).toMatch(/builtin/);
		expect(failure?.code).toBe("config_error");
	});

	it("fails when sandbox.mode says nono but nono_version is absent", () => {
		const report = makeReport({ mode: "nono" });
		expect(report.sandbox?.mode).toBe("nono");
		expect(report.sandbox?.nonoVersion).toBeUndefined();
		const failure = nonoBootstrapFailure(true, report);
		expect(failure).toBeDefined();
		expect(failure?.text).toMatch(/sandbox\.nono_version/);
		expect(failure?.code).toBe("config_error");
	});

	it("passes when sandbox.mode is nono and nono_version is present", () => {
		const report = makeReport({ mode: "nono", nono_version: "0.71.0" });
		expect(report.sandbox?.mode).toBe("nono");
		expect(report.sandbox?.nonoVersion).toBe("0.71.0");
		expect(nonoBootstrapFailure(true, report)).toBeUndefined();
	});
});

describe("enforceNonoBootstrap + isRunFailure integration", () => {
	it("turns missing nono evidence run into a run failure even with outcome success", () => {
		const report = makeReport({ mode: "nono" });
		const enforced = enforceNonoBootstrap(true, report);
		expect(enforced.reason).toBeDefined();
		expect(enforced.report?.accepted).toBe(false);
		expect(enforced.report?.outcome).toBe("error");
		expect(isRunFailure({ exitCode: 0, report: enforced.report })).toBe(true);
	});

	it("classifies nono bootstrap failure as config_error", () => {
		const report = makeReport({ mode: "nono" });
		const enforced = enforceNonoBootstrap(true, report);
		const classified = classifyFailure([], enforced.report);
		expect(classified).toEqual(enforced.reason);
		expect(classified?.code).toBe("config_error");
	});

	it("leaves genuine nono run with nono_version alone", () => {
		const report = makeReport({ mode: "nono", nono_version: "0.71.0" });
		const enforced = enforceNonoBootstrap(true, report);
		expect(enforced.reason).toBeUndefined();
		expect(isRunFailure({ exitCode: 0, report: enforced.report })).toBe(false);
	});

	it("does not touch non-nono runs", () => {
		const report = makeReport({ mode: "builtin" });
		const enforced = enforceNonoBootstrap(false, report);
		expect(enforced.reason).toBeUndefined();
		expect(isRunFailure({ exitCode: 0, report: enforced.report })).toBe(false);
	});
});

describe("enforceCompletedAsyncNono", () => {
	it("fails closed when persisted nono intent has no bootstrap evidence", () => {
		const report = makeReport({ mode: "nono" });
		const enforced = enforceCompletedAsyncNono({ nonoRequested: true }, report);
		expect(enforced.reason?.text).toMatch(/nono_version/);
		expect(enforced.report?.outcome).toBe("error");
		expect(enforced.report?.accepted).toBe(false);
	});

	it("preserves completed nono report with nono_version", () => {
		const report = makeReport({ mode: "nono", nono_version: "0.71.0" });
		const enforced = enforceCompletedAsyncNono({ nonoRequested: true }, report);
		expect(enforced.reason).toBeUndefined();
		expect(enforced.report).toBe(report);
	});

	it("enforces nono when report says nono despite persisted false intent", () => {
		const report = makeReport({ mode: "nono" });
		expect(enforceCompletedAsyncNono({ nonoRequested: false }, report).reason?.text).toMatch(/nono_version/);
	});

	it("does not enforce nono when persisted intent is false and report is builtin", () => {
		const report = makeReport({ mode: "builtin" });
		expect(enforceCompletedAsyncNono({ nonoRequested: false }, report).reason).toBeUndefined();
	});
});
