import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	agentFsBootstrapFailure,
	enforceAgentFsBootstrap,
	isRunFailure,
	summarizeReport,
} from "../extensions/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const loadFixture = (name: string): Record<string, unknown> =>
	JSON.parse(fs.readFileSync(path.join(here, "fixtures", name), "utf-8")) as Record<string, unknown>;

// Known bug (Swival 1.0.40 + AgentFS 0.6.4): `report.sandbox.mode` is written
// straight from argv (report.py:349), so it says "agentfs" whether or not
// the process actually re-exec'd into the overlay. Only the re-exec'd
// process sets `sandbox.agentfs_version` (and, when there was something to
// diff, `sandbox.diff_hint`). A regression check that only asserts on
// `sandbox.mode` would pass even when isolation silently did not happen.
describe("agentFsBootstrapFailure", () => {
	it("is a no-op when the sandbox was not requested, regardless of report", () => {
		expect(agentFsBootstrapFailure(false, undefined)).toBeUndefined();
		expect(agentFsBootstrapFailure(false, summarizeReport({}))).toBeUndefined();
	});

	it("fails when agentfs was requested but no report exists to confirm the re-exec", () => {
		const failure = agentFsBootstrapFailure(true, undefined);
		expect(failure).toBeDefined();
		expect(failure?.text).toMatch(/no report/i);
	});

	it("fails when agentfs was requested but report.sandbox.mode says builtin", () => {
		const report = summarizeReport(loadFixture("report-success-with-review.json"));
		expect(report.sandbox?.mode).toBe("builtin");
		const failure = agentFsBootstrapFailure(true, report);
		expect(failure).toBeDefined();
		expect(failure?.text).toMatch(/builtin/);
	});

	it("fails when sandbox.mode says agentfs but agentfs_version (re-exec-only evidence) is absent", () => {
		// This is the exact known-bug shape: swival was invoked with
		// --sandbox agentfs, the report's mode field reflects that argv
		// value, but nothing proves the re-exec into the overlay happened.
		const report = summarizeReport(loadFixture("report-agentfs-missing-evidence.json"));
		expect(report.sandbox?.mode).toBe("agentfs");
		expect(report.sandbox?.agentfsVersion).toBeUndefined();
		const failure = agentFsBootstrapFailure(true, report);
		expect(failure).toBeDefined();
		expect(failure?.text).toMatch(/agentfs_version/);
	});

	it("passes when sandbox.mode is agentfs and agentfs_version is present", () => {
		const report = summarizeReport(loadFixture("report-agentfs-success.json"));
		expect(report.sandbox?.mode).toBe("agentfs");
		expect(report.sandbox?.agentfsVersion).toBe("0.6.4");
		expect(report.sandbox?.diffHint).toBe("2 files changed in overlay");
		expect(agentFsBootstrapFailure(true, report)).toBeUndefined();
	});
});

describe("enforceAgentFsBootstrap + isRunFailure integration", () => {
	it("turns a bootstrap-evidence-free run into a run failure even with exit 0 and outcome success", () => {
		const report = summarizeReport(loadFixture("report-agentfs-missing-evidence.json"));
		expect(report.outcome).toBe("success"); // swival itself reported success
		const enforced = enforceAgentFsBootstrap(true, report);
		expect(enforced.reason).toBeDefined();
		// The exact failure mode this test guards against: a sandbox bootstrap
		// failure must never look like a successful result.
		expect(isRunFailure({ exitCode: 0, report: enforced.report })).toBe(true);
	});

	it("leaves a genuine agentfs success alone", () => {
		const report = summarizeReport(loadFixture("report-agentfs-success.json"));
		const enforced = enforceAgentFsBootstrap(true, report);
		expect(enforced.reason).toBeUndefined();
		expect(isRunFailure({ exitCode: 0, report: enforced.report })).toBe(false);
	});

	it("does not touch non-agentfs runs", () => {
		const report = summarizeReport(loadFixture("report-success-with-review.json"));
		const enforced = enforceAgentFsBootstrap(false, report);
		expect(enforced.reason).toBeUndefined();
		expect(isRunFailure({ exitCode: 0, report: enforced.report })).toBe(false);
	});
});
