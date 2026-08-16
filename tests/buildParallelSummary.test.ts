import { describe, expect, it } from "vitest";
import { buildParallelSummary, type SwivalResult } from "../extensions/runtime.js";

function makeResult(overrides: Partial<SwivalResult> = {}): SwivalResult {
	return {
		agent: "worker",
		agentSource: "user",
		task: "do the thing",
		exitCode: 0,
		finalOutput: "hello",
		stderrTail: [],
		durationMs: 1234,
		report: { outcome: "success", turns: 3, reviewRounds: 1 },
		...overrides,
	};
}

describe("buildParallelSummary", () => {
	it("uses 'ok' vocabulary in the aggregate header (not 'succeeded')", () => {
		const summary = buildParallelSummary([makeResult()]);
		expect(summary).toMatch(/^swival parallel: 1\/1 ok/);
		expect(summary).not.toMatch(/succeeded/);
	});

	it("labels reviewer-approved runs 'accepted' in the per-task header", () => {
		const summary = buildParallelSummary([
			makeResult({ report: { outcome: "success", turns: 5, reviewRounds: 2 } }),
		]);
		expect(summary).toMatch(/=== \[0\] worker \(accepted, 5 turns\) ===/);
	});

	it("labels no-reviewer success runs 'completed' (not 'accepted')", () => {
		// review_rounds=0 means no reviewer ran. Distinct from reviewer-approved.
		const summary = buildParallelSummary([
			makeResult({ report: { outcome: "success", turns: 5, reviewRounds: 0 } }),
		]);
		expect(summary).toMatch(/=== \[0\] worker \(completed, 5 turns\) ===/);
	});

	it("shows 'N/M turns' in the header when effectiveMaxTurns is configured", () => {
		const summary = buildParallelSummary([
			makeResult({
				report: { outcome: "success", turns: 18, reviewRounds: 1 },
				effectiveMaxTurns: 20,
			}),
		]);
		expect(summary).toMatch(/=== \[0\] worker \(accepted, 18\/20 turns\) ===/);
	});

	it("includes the reason code in the header for failed tasks", () => {
		const results = [
			makeResult({
				agent: "reviewed",
				exitCode: 0,
				report: { outcome: "failed", turns: 8, reviewRounds: 3 },
				errorMessage: "Reviewer rejected after 3 rounds.",
				reason: { code: "review_rejected", text: "Reviewer rejected after 3 rounds." },
			}),
		];
		const summary = buildParallelSummary(results);
		expect(summary).toMatch(/=== \[0\] reviewed \(rejected\/review_rejected, 8 turns\) ===/);
	});

	it("uses errorMessage (not mid-narration from finalOutput) for failed task bodies", () => {
		const results = [
			makeResult({
				exitCode: 1,
				finalOutput: "Starting investigation\nLet me look at this...",
				errorMessage: "AWS SSO session expired — run `aws sso login` and retry.",
				reason: { code: "provider_auth", text: "AWS SSO session expired — run `aws sso login` and retry." },
				report: undefined,
			}),
		];
		const summary = buildParallelSummary(results);
		expect(summary).toMatch(/error: AWS SSO session expired/);
		expect(summary).not.toMatch(/Starting investigation/);
		expect(summary).not.toMatch(/Let me look at this/);
	});

	it("includes the artifact directory path when present", () => {
		const summary = buildParallelSummary([
			makeResult({ artifactDir: "/home/me/.pi/agent/swival-artifacts/worker-20260101T000000Z-abc" }),
		]);
		expect(summary).toMatch(/artifacts: \/home\/me\/\.pi\/agent\/swival-artifacts\/worker-20260101T000000Z-abc/);
	});

	// Routing rule (defect #1 from review):
	//   output set   → file-only metadata, body never inlined (caller reads file)
	//   output unset → inline full finalOutput, no cap unless maxInlineBytes given

	it("inlines the full finalOutput when no output path is set (no silent cap)", () => {
		const big = "x".repeat(50_000);
		const summary = buildParallelSummary([makeResult({ finalOutput: big })]);
		// Full body must be present; no cap should kick in by default.
		expect(summary).toContain(big);
		expect(summary).not.toMatch(/truncated/);
	});

	it("emits file-only metadata (path, size, lines) when output path is set", () => {
		const body = "line one\nline two\nline three";
		const summary = buildParallelSummary([
			makeResult({
				finalOutput: body,
				outputPath: "/work/out/task-0.txt",
				outputBytes: Buffer.byteLength(body, "utf-8"),
				outputLineCount: 3,
			}),
		]);
		expect(summary).toMatch(/→ \/work\/out\/task-0\.txt \(3 lines, \d+ bytes\)/);
		// Body is written to the file, not the tool-result content.
		expect(summary).not.toMatch(/line one/);
	});

	it("inlines the body even when output is set if outputMode is explicitly 'inline'", () => {
		// Caller opts back into inline by setting outputMode="inline" with output path.
		// File is still written; body is also present inline.
		const body = "line one\nline two";
		const summary = buildParallelSummary([
			makeResult({
				finalOutput: body,
				outputPath: "/work/out/task-0.txt",
				outputMode: "inline",
				outputBytes: Buffer.byteLength(body, "utf-8"),
				outputLineCount: 2,
			}),
		]);
		expect(summary).toMatch(/output file: \/work\/out\/task-0\.txt/);
		expect(summary).toMatch(/line one/);
		expect(summary).toMatch(/line two/);
	});

	it("applies maxInlineBytes as a loud cap when the caller sets one", () => {
		const big = "x".repeat(50_000);
		const summary = buildParallelSummary([makeResult({ finalOutput: big })], { maxInlineBytes: 1024 });
		expect(summary).toMatch(/\[truncated \d+ chars; full output at/);
		expect(summary.length).toBeLessThan(2_000);
	});

	it("maxInlineBytes truncation names artifactDir when present as the source-of-truth pointer", () => {
		const big = "x".repeat(50_000);
		const summary = buildParallelSummary(
			[makeResult({ finalOutput: big, artifactDir: "/tmp/artifacts/worker-xyz" })],
			{ maxInlineBytes: 1024 },
		);
		expect(summary).toMatch(/full output at \/tmp\/artifacts\/worker-xyz/);
	});

	it("includes mixed ok and failed counts in the aggregate header", () => {
		const results = [
			makeResult(),
			makeResult({
				exitCode: 1,
				errorMessage: "boom",
				reason: { code: "non_zero_exit", text: "boom" },
				report: { outcome: "unknown" },
			}),
			makeResult(),
		];
		const summary = buildParallelSummary(results);
		expect(summary).toMatch(/swival parallel: 2\/3 ok/);
	});
});
