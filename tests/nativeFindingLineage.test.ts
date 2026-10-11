import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import registerExtension from "../extensions/index.js";
import { inspectNativeAudit } from "../extensions/native-audit.js";
import { nativeTestPython as python } from "./nativePython.js";

const roots: string[] = [];
const bwrapIdentity = { path: "/usr/bin/bwrap", version: "bubblewrap 0.12.0", package: "bubblewrap",
	packageVersion: "0.12.0-1~deb13u1", architecture: "arm64",
	sha256: "b3b829e18a7d43ee589dc37e351cb9480ff7301b493d8227b8c754294638b976" };
const unshareIdentity = { path: "/usr/bin/unshare", version: "unshare from util-linux 2.41.5", package: "util-linux",
	packageVersion: "2.41.5-0+deb13u1", architecture: "arm64",
	sha256: "285119fd3989039d50f8904b619b2abb8b795cb56753eb0235c8c031eb880a21" };

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const producerOutput = (scenario: string, home: string) => JSON.parse(execFileSync(python,
	["-I", "-B", path.join(import.meta.dirname, "native_lineage_fixture.py"), scenario], {
		timeout: 10_000, maxBuffer: 1024 * 1024,
		env: { HOME: home, PATH: process.env.PATH, LITELLM_LOCAL_MODEL_COST_MAP: "True" },
	}).toString());

function lineage(scenario: string) {
	const artifactRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-lineage-"))); roots.push(artifactRoot);
	const runId = `lineage-${scenario}`; const root = path.join(artifactRoot, runId); fs.mkdirSync(root);
	const generated = producerOutput(scenario, root);
	const expectedDecisions: Record<string, string[]> = { keep: ["keep"], rewrite: ["keep_with_changes"], drop: ["drop"],
		mixed: ["keep_with_changes", "drop"], "projection-collision": ["keep_with_changes", "drop"] };
	if (scenario in expectedDecisions) {
		expect(generated.producer).toEqual({ package: "swival", version: "1.0.46",
			audit_sha256: "be7f711d303c8929a1ed388e80c569b0e851587c72f0154d24e7e3a8546f4902",
			lineage_function: "swival.audit._phase45_adjudicate",
			persistence_function: "swival.audit.AuditRunState.save",
			stubbed_boundary: "swival.audit._call_audit_llm" });
		expect(generated.provenance).toEqual({
			initial_verification: "synthetic proposed/verified/status inputs",
			lineage_outputs: "actual Phase 4.5 verified_findings and adjudication_discarded",
			artifact_state: "synthetic post-Phase-4.5 artifact scaffolding",
		});
		expect(generated.released_decisions).toEqual(expectedDecisions[scenario]);
	} else expect(generated.producer.lineage_function).toBe("handwritten-negative-state");
	const evidence = path.join(root, "evidence"); const stateDir = path.join(evidence, "native-state", "abc12345");
	const findingsDir = path.join(evidence, "audit-findings"); fs.mkdirSync(stateDir, { recursive: true }); fs.mkdirSync(findingsDir);
	const artifactState: Record<string, any> = generated.persisted_state?.artifact_state ?? {};
	if (!generated.persisted_state) {
		for (const [index, key] of generated.verified_keys.entries()) {
			const report = `${index + 1}-lineage.md`; const patch = `${index + 1}-lineage.patch`;
			artifactState[key] = { status: "written", report_filename: report, patch_filename: patch };
		}
	}
	for (const entry of Object.values(artifactState)) {
		fs.writeFileSync(path.join(findingsDir, entry.report_filename), "synthetic artifact report\n");
		fs.writeFileSync(path.join(findingsDir, entry.patch_filename), "synthetic artifact patch\n");
	}
	const fallbackCommit = "1".repeat(40);
	const fallbackScope = { branch: "main", commit: fallbackCommit, tracked_files: ["code.py"], mandatory_files: ["code.py"], focus: [] };
	const state = generated.persisted_state ?? { scope: fallbackScope, reviewed_files: ["code.py"], candidate_files: ["code.py"],
		deep_reviewed_files: ["code.py"], phase: "done", truncated_files: {}, metrics: {}, artifact_state: artifactState,
		proposed_findings: generated.proposed_findings, verification_state: generated.verification_state,
		verified_findings: generated.verified_findings, adjudication_discarded: generated.adjudication_discarded };
	const scope = state.scope; const commit = scope.commit;
	const route = { version: 1, provider: "lmstudio", model: "offline", reasoningEffort: "low" };
	fs.writeFileSync(path.join(stateDir, "state.json"), generated.persisted_state_text ?? JSON.stringify(state));
	fs.writeFileSync(path.join(root, "run-meta.json"), JSON.stringify({ runId, artifactDir: root,
		nativeAuditRequested: true, startedAt: Date.now(), agent: "native-audit", task: "/audit" }));
	fs.writeFileSync(path.join(root, "completed.json"), JSON.stringify({ exitCode: 0, exitedAt: new Date().toISOString(),
		shutdown: "verified", boundary: "bubblewrap-pidfd" }));
	fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ sandbox: "bubblewrap", bwrapVersion: "0.12.0",
		sessionSandbox: "builtin", bwrapIdentity, unshareIdentity, route, scope, snapshotCommit: commit, audit: { all: true } }));
	fs.writeFileSync(path.join(root, "request.json"), JSON.stringify({ sandbox: "bubblewrap", bwrapVersion: "0.12.0",
		sessionSandbox: "builtin", bwrapIdentity, unshareIdentity, expectedRoute: route }));
	fs.writeFileSync(path.join(evidence, "native-result.json"), JSON.stringify({ status: "completed", answer: "lineage corpus",
		sandbox: { external: "bubblewrap", bwrapVersion: "0.12.0", bwrapIdentity,
			startup: { executable: "unshare", identity: unshareIdentity }, session: "builtin" },
		network: "provider-only", scope, route, provider: route.provider, model: route.model, requestedEffort: route.reasoningEffort }));
	let tool: any;
	registerExtension({ registerTool: (registered: any) => { tool = registered; } } as any, { artifactRoot } as any);
	const recover = (action: "status" | "resume") => tool.execute("lineage", { action, id: runId },
		undefined, undefined, { cwd: root, hasUI: false });
	return { direct: inspectNativeAudit(root, 0), recover };
}

const invalid = ["unlinked", "discarded-survivor", "vanished", "fabricated-drop", "malformed-drop",
	"malformed-drop-missing", "malformed-drop-extra", "malformed-drop-type", "mismatched-drop", "extra-drop",
	"overlap-reuse", "proposal-limit", "null-drops"];
const valid = ["keep", "rewrite", "drop", "mixed", "projection-collision"];

describe("released Swival finding lineage", () => {
	it("persists actual released Phase 4.5 output before fixture export", () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-lineage-producer-"))); roots.push(root);
		const generated = producerOutput("rewrite", root);
		expect(generated.producer.lineage_function).toBe("swival.audit._phase45_adjudicate");
		expect(generated.producer.persistence_function).toBe("swival.audit.AuditRunState.save");
		expect(generated.persistence).toMatchObject({ source: "persisted-state.json", save_calls: 1 });
		expect(generated.persistence.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(createHash("sha256").update(generated.persisted_state_text).digest("hex"))
			.toBe(generated.persistence.sha256);
		expect(JSON.parse(generated.persisted_state_text)).toEqual(generated.persisted_state);
	});

	it.each(valid)("accepts genuine released producer outcome: %s", async (scenario) => {
		const fixture = lineage(scenario);
		expect((await fixture.direct).status).toBe("completed");
		for (const action of ["status", "resume"] as const) {
			const recovered = await fixture.recover(action);
			expect(recovered.isError, recovered.content[0].text).not.toBe(true);
			expect(recovered.details.results[0].nativeAudit.status).toBe("completed");
		}
	}, 15_000);

	it.each(invalid)("rejects impossible lineage state: %s", async (scenario) => {
		const fixture = lineage(scenario);
		expect.soft((await fixture.direct).status).not.toBe("completed");
		for (const action of ["status", "resume"] as const) {
			const recovered = await fixture.recover(action);
			expect.soft(recovered.isError).toBe(true);
			expect.soft(recovered.details.results[0].nativeAudit.status).not.toBe("completed");
		}
	}, 15_000);
});
