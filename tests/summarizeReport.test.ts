import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFailure, isRunFailure, renderStatus, summarizeReport, terminalFailureReason } from "../extensions/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const loadFixture = (name: string): Record<string, unknown> =>
	JSON.parse(fs.readFileSync(path.join(here, "fixtures", name), "utf-8")) as Record<string, unknown>;

describe("summarizeReport", () => {
	it("maps schema v1 success + one review round", () => {
		const raw = loadFixture("report-success-with-review.json");
		const s = summarizeReport(raw);
		expect(s.outcome).toBe("success");
		expect(s.accepted).toBe(true);
		expect(s.reviewRounds).toBe(1);
		expect(s.turns).toBe(1);
		expect(s.errorMessage).toBeUndefined();
		expect(s.toolCallsTotal).toBe(0);
		expect(s.llmCalls).toBe(1);
		expect(s.totalLlmTimeS).toBeCloseTo(2.543, 3);
		expect(s.totalToolTimeS).toBe(0);
		expect(s.compactions).toBe(0);
		expect(s.answer).toContain("haiku about coffee");
		expect(s.model).toBe("claude-opus-4-6");
		expect(s.provider).toBe("lmstudio");
		expect(s.lastReviewFeedback).toContain("VERDICT: ACCEPT");
	});

	it("maps rejection with multi-round feedback and returns the LAST feedback", () => {
		const raw = loadFixture("report-rejected.json");
		const s = summarizeReport(raw);
		expect(s.outcome).toBe("failed");
		expect(s.accepted).toBe(false);
		expect(s.reviewRounds).toBe(2);
		expect(s.lastReviewFeedback).toContain("Final: REJECT");
		expect(s.lastReviewFeedback).not.toContain("Still has TODOs");
		expect(s.toolCallsTotal).toBe(2);
		expect(s.toolCallsByName?.edit?.succeeded).toBe(1);
		expect(s.toolCallsByName?.read_file?.succeeded).toBe(1);
	});

	it("maps outcome=error with result.error_message (swival 1.0.14 AgentError path)", () => {
		const s = summarizeReport({
			result: {
				outcome: "error",
				exit_code: 1,
				error_message: "context window exceeded (typed)",
			},
			stats: { turns: 3, tool_calls_total: 5 },
		});
		expect(s.outcome).toBe("error");
		expect(s.accepted).toBe(false);
		expect(s.errorMessage).toBe("context window exceeded (typed)");
		expect(s.turns).toBe(3);
		expect(s.toolCallsTotal).toBe(5);
	});

	it("extracts prompt_cache, security stats, nono sandbox, and network mode", () => {
		const s = summarizeReport({
			network: "provider-only",
			sandbox: {
				mode: "nono",
				nono_version: "0.4.1",
				nono_profile: "strict",
				rollback: true,
			},
			result: { outcome: "success", exit_code: 0 },
			stats: {
				prompt_cache: {
					cached_tokens: 12500,
					cache_write_tokens: 3000,
				},
				security: {
					command_policy_blocks: 2,
					command_policy_approvals: 5,
					untrusted_inputs: 1,
				},
				stormed_calls: 3,
				truncation_repairs: 1,
			},
		});
		expect(s.network).toBe("provider-only");
		expect(s.sandbox?.mode).toBe("nono");
		expect(s.sandbox?.nonoVersion).toBe("0.4.1");
		expect(s.sandbox?.nonoRollback).toBe(true);
		expect(s.promptCache?.cachedTokens).toBe(12500);
		expect(s.security?.commandPolicyBlocks).toBe(2);
		expect(s.stormedCalls).toBe(3);
		expect(s.truncationRepairs).toBe(1);
	});

	it("tolerates a completely empty report object", () => {
		const s = summarizeReport({});
		expect(s.outcome).toBe("unknown");
		expect(s.accepted).toBeUndefined();
		expect(s.reviewRounds).toBeUndefined();
		expect(s.toolCallsTotal).toBeUndefined();
		expect(s.answer).toBeUndefined();
		expect(s.lastReviewFeedback).toBeUndefined();
	});

	it("tolerates malformed tool_calls_by_name (string instead of object)", () => {
		const s = summarizeReport({
			stats: { tool_calls_by_name: "not-an-object" },
		});
		expect(s.toolCallsByName).toBeUndefined();
	});

	it("skips tool_calls_by_name entries with non-numeric values", () => {
		const s = summarizeReport({
			stats: {
				tool_calls_by_name: {
					good: { succeeded: 3, failed: 1 },
					bad_string: "nope",
					bad_number: 42,
					bad_array: [1, 2, 3],
				},
			},
		});
		expect(s.toolCallsByName).toBeDefined();
		expect(s.toolCallsByName?.good?.succeeded).toBe(3);
		expect(s.toolCallsByName?.good?.failed).toBe(1);
		expect(s.toolCallsByName).not.toHaveProperty("bad_string");
		expect(s.toolCallsByName).not.toHaveProperty("bad_number");
		expect(s.toolCallsByName).not.toHaveProperty("bad_array");
	});

	it("maps instruction-file-too-large error report", () => {
		const raw = loadFixture("report-instruction-too-large.json");
		const s = summarizeReport(raw);
		expect(s.outcome).toBe("error");
		expect(s.accepted).toBe(false);
		expect(s.errorMessage).toContain("instruction files are too large");
	});

	it("maps interrupted lifecycle report", () => {
		const raw = loadFixture("report-interrupted.json");
		const s = summarizeReport(raw);
		expect(s.outcome).toBe("interrupted");
		expect(s.accepted).toBe(false);
	});

	it("keeps a raw pointer for debugging", () => {
		const raw = loadFixture("report-success-with-review.json");
		const s = summarizeReport(raw);
		expect(s.raw).toBe(raw);
	});
});

describe("classifyFailure", () => {
	it("returns undefined when report.outcome=failed but reviewRounds is 0", () => {
		const res = classifyFailure([], { outcome: "failed", reviewRounds: 0 } as ReturnType<typeof summarizeReport>);
		expect(res).toBeUndefined();
	});

	it("returns a rounds-exhausted message when report.outcome=failed and reviewRounds set", () => {
		const raw = loadFixture("report-rejected.json");
		const s = summarizeReport(raw);
		const res = classifyFailure([], s);
		expect(res?.code).toBe("review_rejected");
		expect(res?.text).toMatch(/Reviewer rejected after 2 rounds/);
	});

	it("recognises expired AWS SSO sessions", () => {
		const res = classifyFailure(["botocore.exceptions.TokenRetrievalError: The SSO session has expired"]);
		expect(res?.code).toBe("provider_auth");
		expect(res?.text).toMatch(/AWS SSO/i);
	});

	it("recognises 401 Unauthorized from the LLM provider", () => {
		const res = classifyFailure(["upstream error: 401 Unauthorized: invalid API key"]);
		expect(res?.code).toBe("provider_auth");
		expect(res?.text).toMatch(/401/);
	});

	it("recognises ECONNREFUSED (local model server down)", () => {
		const res = classifyFailure(["ConnectError: connect ECONNREFUSED 127.0.0.1:4000"]);
		expect(res?.code).toBe("connection_refused");
		expect(res?.text).toBe("Connection refused — is the local model server running?");
	});

	it("recognises rate limits (429)", () => {
		const res = classifyFailure(["Error 429: rate limit exceeded for model X"]);
		expect(res?.code).toBe("rate_limited");
		expect(res?.text).toMatch(/Rate limited/i);
	});

	it("returns undefined when nothing matches", () => {
		expect(classifyFailure(["a totally benign log line"])).toBeUndefined();
	});

	// Reachability spot checks for each FailureReason code. Each string
	// below must be covered by a real matcher in classifyFailure; if any
	// future refactor collapses a matcher, these tests fail loudly.
	it("covers all machine-visible ReasonCode values via matchers", () => {
		const cases: Array<[string[], string]> = [
			[["SSO session expired"], "provider_auth"],
			[["429 too many requests: slow down"], "rate_limited"],
			[["ECONNREFUSED 127.0.0.1:4000"], "connection_refused"],
			[["ContextOverflowError: blah"], "context_overflow"],
			[["ToolsNotSupportedError: blah"], "config_error"],
		];
		for (const [lines, expectedCode] of cases) {
			const res = classifyFailure(lines);
			expect(res?.code, `matcher missing for ${expectedCode}: input=${JSON.stringify(lines)}`).toBe(expectedCode);
		}
		// review_rejected comes from the report, not stderr
		const rejected = classifyFailure([], {
			outcome: "failed",
			reviewRounds: 1,
		} as ReturnType<typeof summarizeReport>);
		expect(rejected?.code).toBe("review_rejected");
	});

	it("prefers report.error_message over stderr heuristics when both are present", () => {
		const res = classifyFailure(
			["401 Unauthorized: invalid API key"], // a stderr pattern we would otherwise match
			{
				outcome: "error",
				errorMessage: "context window exceeded (typed)",
			} as ReturnType<typeof summarizeReport>,
		);
		expect(res?.code).toBe("context_overflow");
		expect(res?.text).toMatch(/context window exceeded/i);
		expect(res?.text).not.toMatch(/401/);
	});

	it("classifies ContextOverflowError from the report", () => {
		const res = classifyFailure([], {
			outcome: "error",
			errorMessage: "context window exceeded (inferred): foo",
		} as ReturnType<typeof summarizeReport>);
		expect(res?.code).toBe("context_overflow");
		expect(res?.text).toMatch(/context window exceeded/i);
	});

	it("classifies ToolsNotSupportedError from the report", () => {
		const res = classifyFailure([], {
			outcome: "error",
			errorMessage: "model does not support function calling: ...",
		} as ReturnType<typeof summarizeReport>);
		expect(res?.code).toBe("config_error");
		expect(res?.text).toMatch(/function calling/i);
	});

	it("classifies LifecycleError from the report", () => {
		const res = classifyFailure([], {
			outcome: "error",
			errorMessage: "lifecycle exit hook failed: non-zero exit",
		} as ReturnType<typeof summarizeReport>);
		expect(res?.code).toBe("config_error");
		expect(res?.text).toMatch(/Lifecycle hook failed/i);
	});

	it("falls back to stderr patterns for ContextOverflowError when report has no error_message", () => {
		const res = classifyFailure([
			"Error: ContextOverflowError: context window exceeded after retries",
		]);
		expect(res?.code).toBe("context_overflow");
		expect(res?.text).toMatch(/context window exceeded/i);
	});

	it("classifies instruction-file-too-large from report", () => {
		const raw = loadFixture("report-instruction-too-large.json");
		const s = summarizeReport(raw);
		const res = classifyFailure([], s);
		expect(res?.code).toBe("config_error");
		expect(res?.text).toMatch(/instruction files are too large/i);
	});

	it("classifies instruction-file-too-large from multi-line stderr fallback to first headline", () => {
		const res = classifyFailure([
			"The instruction files are too large for this setup.",
			"Shorten the listed files, or restart with:",
			"  --no-instructions     Skip project and personal instruction files.",
			"  --instructions-full   Load all instructions; this may crowd out work or fail.",
			"",
			"Files:",
			"  /path/to/AGENTS.md",
		]);
		expect(res?.code).toBe("config_error");
		expect(res?.text).toBe("The instruction files are too large for this setup.");
	});

	it("classifies unreadable instruction error from report and stderr", () => {
		const fromReport = classifyFailure([], {
			outcome: "error",
			errorMessage: "Some instruction files could not be read.",
		} as ReturnType<typeof summarizeReport>);
		expect(fromReport?.code).toBe("config_error");
		expect(fromReport?.text).toMatch(/could not be read/i);

		const fromStderr = classifyFailure(["Some instruction files could not be read."]);
		expect(fromStderr?.code).toBe("config_error");
		expect(fromStderr?.text).toMatch(/could not be read/i);
	});

	it("classifies interrupted outcome from report", () => {
		const raw = loadFixture("report-interrupted.json");
		const s = summarizeReport(raw);
		const res = classifyFailure([], s);
		expect(res?.code).toBe("non_zero_exit");
		expect(res?.text).toMatch(/interrupted/i);
	});

	it("classifies interrupted from stderr fallback", () => {
		const res = classifyFailure(["KeyboardInterrupt", "fmt.warning: interrupted."]);
		expect(res?.code).toBe("non_zero_exit");
		expect(res?.text).toMatch(/interrupted/i);
	});

	it("does not treat estimated-tokenizer or unreadable-instruction warnings as standalone failures", () => {
		expect(
			classifyFailure([
				"  ⚠ Warning: tokenizer data is unavailable, so context sizes are byte estimates; preventive compaction and output clamping are off for this session",
			]),
		).toBeUndefined();
		expect(
			classifyFailure([
				"  ⚠ Warning: instruction file not loaded — /path/to/extra/AGENTS.md: Permission denied",
			]),
		).toBeUndefined();
	});

	it("falls back to stderr patterns for ToolsNotSupportedError", () => {
		const res = classifyFailure([
			"Error: ToolsNotSupportedError: model does not support chat completions with tools",
		]);
		expect(res?.code).toBe("config_error");
		expect(res?.text).toMatch(/function calling/i);
	});
});

describe("isRunFailure", () => {
	it("treats non-zero exit as failure regardless of report outcome", () => {
		expect(isRunFailure({ exitCode: 1 })).toBe(true);
		expect(isRunFailure({ exitCode: 1, report: { outcome: "success" } })).toBe(true);
	});

	it("treats exit=0 + outcome=failed (reviewer rejection) as failure", () => {
		expect(isRunFailure({ exitCode: 0, report: { outcome: "failed" } })).toBe(true);
	});

	it("treats exit=0 + outcome=error (AgentError raised) as failure", () => {
		expect(isRunFailure({ exitCode: 0, report: { outcome: "error" } })).toBe(true);
	});

	it("does NOT treat exit=0 + outcome=success as failure", () => {
		expect(isRunFailure({ exitCode: 0, report: { outcome: "success" } })).toBe(false);
	});

	it("treats outcome=interrupted as failure", () => {
		expect(isRunFailure({ exitCode: 0, report: { outcome: "interrupted" } })).toBe(true);
		expect(isRunFailure({ exitCode: 130, report: { outcome: "interrupted" } })).toBe(true);
	});

	it("fails closed for exit=0 with a missing or unknown report", () => {
		expect(isRunFailure({ exitCode: 0 })).toBe(true);
		expect(isRunFailure({ exitCode: 0, report: {} })).toBe(true);
		expect(isRunFailure({ exitCode: 0, report: { outcome: "unknown" } })).toBe(true);
	});
});

describe("terminalFailureReason and renderStatus", () => {
	it("maps exit status 130 directly to non_zero_exit reason", () => {
		const res = terminalFailureReason(130, undefined, ["process killed"]);
		expect(res?.code).toBe("non_zero_exit");
		expect(res?.text).toMatch(/interrupted/i);
	});

	it("maps outcome=interrupted to non_zero_exit via terminalFailureReason", () => {
		const raw = loadFixture("report-interrupted.json");
		const s = summarizeReport(raw);
		const res = terminalFailureReason(130, s, []);
		expect(res?.code).toBe("non_zero_exit");
		expect(res?.text).toMatch(/interrupted/i);
	});

	it("renderStatus returns failed for outcome=interrupted", () => {
		const raw = loadFixture("report-interrupted.json");
		const s = summarizeReport(raw);
		const status = renderStatus({
			agent: "test",
			agentSource: "bundled",
			task: "task",
			exitCode: 130,
			finalOutput: "",
			stderrTail: [],
			durationMs: 100,
			report: s,
		});
		expect(status).toBe("failed");
	});
});
