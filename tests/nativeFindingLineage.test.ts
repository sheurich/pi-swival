import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { completeNativeFixture, nativeScratch } from "./nativeFixtures.js";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import registerExtension from "../extensions/index.js";
import { inspectNativeAudit, nativeFindingKey } from "../extensions/native-audit.js";
import { nativeTestPython as python } from "./nativePython.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const producerOutput = (scenario: string, home: string) => JSON.parse(execFileSync(python,
	["-I", "-B", path.join(import.meta.dirname, "native_lineage_fixture.py"), scenario], {
		timeout: 10_000, maxBuffer: 1024 * 1024,
		env: { HOME: home, PATH: process.env.PATH, TMPDIR: path.join(home, "tmp"), LITELLM_LOCAL_MODEL_COST_MAP: "True", NONO_NO_UPDATE_CHECK: "1" },
	}).toString());

type ArtifactPairMode = "distinct" | "report-reuse" | "patch-reuse" | "both-reused";

function lineage(scenario: string, artifactPairMode?: ArtifactPairMode) {
	const artifactRoot = nativeScratch("native-lineage-"); roots.push(artifactRoot);
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
	if (artifactPairMode) {
		const state = generated.persisted_state;
		const firstFinding = state.proposed_findings[0];
		const secondFinding = { ...firstFinding, title: "second", locations: ["code.py:2"] };
		const secondKey = nativeFindingKey(secondFinding);
		if (!secondKey || secondKey === generated.verified_keys[0]) throw new Error("invalid distinct finding fixture");
		state.proposed_findings.push(secondFinding);
		state.verification_state[secondKey] = { status: "verified" };
		state.verified_findings.push({ ...state.verified_findings[0], finding: secondFinding });
		const firstArtifact = state.artifact_state[generated.verified_keys[0]];
		state.artifact_state[secondKey] = {
			status: "written",
			report_filename: artifactPairMode === "report-reuse" || artifactPairMode === "both-reused"
				? firstArtifact.report_filename : "002-lineage.md",
			patch_filename: artifactPairMode === "patch-reuse" || artifactPairMode === "both-reused"
				? firstArtifact.patch_filename : "002-lineage.patch",
		};
		generated.verified_keys.push(secondKey);
	}
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
	const prepared = completeNativeFixture(root);
	prepared.write("evidence/native-state/abc12345/state.json", artifactPairMode ? state : JSON.parse(generated.persisted_state_text ?? JSON.stringify(state)));
	prepared.write("manifest.json", { snapshotCommit: commit, files: scope.tracked_files, scope,
		sandbox: "agentfs", session: prepared.session, command: prepared.command, audit: { all: true }, route: prepared.route });
	fs.writeFileSync(path.join(root, "run-meta.json"), JSON.stringify({ runId, artifactDir: root,
		nativeAuditRequested: true, startedAt: Date.now(), agent: "native-audit", task: "/audit" }));
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
		const root = nativeScratch("native-lineage-producer-"); roots.push(root);
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
			expect(recovered.isError, "Native synchronous runs are never resurrected from disk").toBe(true);
		}
	}, 15_000);

	it("accepts two independently keyed findings with distinct artifact pairs", async () => {
		const fixture = lineage("keep", "distinct");
		expect((await fixture.direct).status).toBe("completed");
	});

	it.each(["report-reuse", "patch-reuse", "both-reused"] as const)(
		"rejects independently keyed findings with %s at the artifact uniqueness check", async (mode) => {
			const fixture = lineage("keep", mode);
			expect(await fixture.direct).toMatchObject({
				status: "failed", error: "Native artifact filenames are reused across findings.",
			});
		});

	it.each(invalid)("rejects impossible lineage state: %s", async (scenario) => {
		const fixture = lineage(scenario);
		expect.soft((await fixture.direct).status).not.toBe("completed");
		for (const action of ["status", "resume"] as const) {
			const recovered = await fixture.recover(action);
			expect.soft(recovered.isError).toBe(true);
		}
	}, 15_000);
});
