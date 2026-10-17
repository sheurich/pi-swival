import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { inspectNativeAudit } from "../extensions/native-audit.js";
import { completeNativeFixture, nativeScratch, worktree } from "./nativeFixtures.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = nativeScratch("native-completion-"); roots.push(root); return { root, ...completeNativeFixture(root) }; }

describe("native CLI completion evidence", () => {
	it.each(["openrouter", "local-endpoint"])("validates complete and incomplete %s evidence with the same gates", async (kind) => {
		const f = fixture(); const manifest = JSON.parse(fs.readFileSync(path.join(f.root, "manifest.json"), "utf8"));
		manifest.route = { ...manifest.route, version: 2, provider: "openrouter", model: "example/concrete",
			endpoint: kind === "local-endpoint" ? "http://127.0.0.1:8444/v1" : null,
			profile: null, selection: { profileSource: null, explicitFields: [] },
			reportIdentity: { provider: "openrouter", model: "example/concrete" } };
		f.write("manifest.json", manifest);
		const report = JSON.parse(fs.readFileSync(path.join(f.root, "evidence/native-cli-report.json"), "utf8"));
		report.provider = "openrouter"; report.model = "example/concrete"; f.write("evidence/native-cli-report.json", report);
		expect((await inspectNativeAudit(f.root, 0)).status).toBe("completed");
		f.state.deep_reviewed_files = []; f.write("evidence/native-state/abc12345/state.json", f.state);
		expect((await inspectNativeAudit(f.root, 0)).status).toBe("partial");
	});
	it("accepts a complete zero-finding state, not generic exit zero", async () => {
		const f = fixture(); expect(await inspectNativeAudit(f.root, 0)).toMatchObject({ status: "completed" });
	});
	it.each(["missing-state", "phase", "coverage", "deep", "truncated", "profile-failed", "scope", "route", "auth-error", "missing-diagnostics", "diagnostic-truncation", "lost-expansion", "ambiguous-diagnostics", "missing-report", "sandbox", "nonzero", "unverified", "malformed-metrics", "malformed-truncation", "invalid-profile-failures", "auth-persistence-failure"])(
		"refuses incomplete or invalid %s evidence", async (kind) => {
			const f = fixture();
			if (kind === "missing-state") fs.rmSync(f.stateDir, { recursive: true });
			else if (kind === "missing-report") fs.rmSync(path.join(f.root, "evidence/native-cli-report.json"));
			else if (kind === "missing-diagnostics") fs.rmSync(path.join(f.root, "diagnostics.json"));
			else if (kind === "diagnostic-truncation" || kind === "lost-expansion" || kind === "ambiguous-diagnostics" || kind === "auth-persistence-failure")
				f.write("diagnostics.json", { closed: kind !== "diagnostic-truncation", bytes: 100,
					expansionFailures: kind === "lost-expansion" ? 1 : 0, ambiguous: kind === "ambiguous-diagnostics",
					authPersistenceFailure: kind === "auth-persistence-failure", adjudicationFailure: false,
					adjudicationRepairFailure: false });
			else if (kind === "unverified") f.write("completed.json", { exitCode: 1, shutdown: "unverified", exitedAt: new Date().toISOString() });
			else if (["route", "auth-error", "sandbox"].includes(kind)) {
				const report = JSON.parse(fs.readFileSync(path.join(f.root, "evidence/native-cli-report.json"), "utf8"));
				if (kind === "route") report.model = "replacement";
				if (kind === "auth-error") report.result = { outcome: "error", exit_code: 1, error_message: "synthetic auth failure" };
				if (kind === "sandbox") report.sandbox.mode = "nono";
				f.write("evidence/native-cli-report.json", report);
			} else {
				if (kind === "phase") f.state.phase = "triage";
				if (kind === "coverage") f.state.reviewed_files = [];
				if (kind === "deep") f.state.deep_reviewed_files = [];
				if (kind === "truncated") f.state.truncated_files = { "code.py": 1 };
				if (kind === "profile-failed") f.state.metrics = { phase1_profile_failures: 1 };
				if (kind === "scope") f.state.scope.commit = "2".repeat(40);
				if (kind === "malformed-metrics") f.state.metrics = [];
				if (kind === "malformed-truncation") f.state.truncated_files = [];
				if (kind === "invalid-profile-failures") f.state.metrics = { phase1_profile_failures: -1 };
				f.write("evidence/native-state/abc12345/state.json", f.state);
			}
			expect((await inspectNativeAudit(f.root, kind === "nonzero" ? 1 : 0)).status).not.toBe("completed");
		});
	it.each(["adjudicationFailure", "adjudicationRepairFailure"].flatMap((field) =>
		[true, undefined, "false", 0, null, [], {}].map((value) => [field, value] as const)))(
		"refuses terminal or missing/malformed %s=%s", async (field, value) => {
			const f = fixture();
			const diagnostics = JSON.parse(fs.readFileSync(path.join(f.root, "diagnostics.json"), "utf8"));
			diagnostics[field] = value; f.write("diagnostics.json", diagnostics);
			const result = await inspectNativeAudit(f.root, 0);
			expect(result.status).toBe(value === true ? "partial" : "failed");
			expect(result.answer).toBeUndefined();
		});
	it("removes the namespace runner and all adapter auth/transport monkeypatches", () => {
		expect(fs.existsSync(path.join(worktree, "scripts/native-audit-runner.cjs"))).toBe(false);
		const preflight = fs.readFileSync(path.join(worktree, "scripts/native_audit.py"), "utf8");
		for (const forbidden of ["_bound_transport", "_read_only_chatgpt_auth", "Session(", "bubblewrap", "ctypes", "unshare"]) expect(preflight).not.toContain(forbidden);
	});
});
