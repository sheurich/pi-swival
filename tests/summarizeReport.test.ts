import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFailure, isRunFailure, renderStatus, summarizeReport, terminalFailureReason } from "../extensions/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const loadFixture = (name: string): Record<string, unknown> =>
	JSON.parse(fs.readFileSync(path.join(here, "fixtures", name), "utf-8")) as Record<string, unknown>;

describe("summarizeReport", () => {
	it.each([1, 2, 127])("rejects raw success when the final reviewer exits %i", (exit) => {
		const report = summarizeReport({
			result: { outcome: "success", exit_code: 0 },
			stats: { review_rounds: 2 },
			timeline: [
				{ type: "review", exit_code: 0, feedback: "accept earlier" },
				{ type: "review", exit_code: exit, feedback: "final rejection" },
			],
		});
		expect(report.outcome).toBe("success");
		expect(report.accepted).toBe(false);
		expect(report.lastReviewExitCode).toBe(exit);
		expect(isRunFailure({ exitCode: 0, report })).toBe(true);
		expect(terminalFailureReason(0, report, [])?.code).toBe("review_rejected");
		expect(renderStatus({ exitCode: 0, report } as any)).toBe("rejected");
	});

	it("accepts reject-then-accept using only the final review", () => {
		const report = summarizeReport({ result: { outcome: "success", exit_code: 0 }, stats: { review_rounds: 2 },
			timeline: [{ type: "review", exit_code: 1 }, { type: "review", exit_code: 0 }] });
		expect(report.lastReviewExitCode).toBe(0);
		expect(report.accepted).toBe(true);
		expect(isRunFailure({ exitCode: 0, report })).toBe(false);
		expect(renderStatus({ exitCode: 0, report } as any)).toBe("accepted");
	});

	it("does not borrow older feedback or acceptance from a missing final review exit", () => {
		const report = summarizeReport({ result: { outcome: "success", exit_code: 0 }, stats: { review_rounds: 2 },
			timeline: [{ type: "review", exit_code: 0, feedback: "old" }, { type: "review" }] });
		expect(report.lastReviewFeedback).toBeUndefined();
		expect(report.accepted).not.toBe(true);
		expect(isRunFailure({ exitCode: 0, report })).toBe(true);
		expect(renderStatus({ exitCode: 0, report } as any)).toBe("error");
	});

	it("requires review evidence when settings enable a reviewer even with zero rounds", () => {
		const report = summarizeReport({ result: { outcome: "success", exit_code: 0 },
			settings: { self_review: true }, stats: { review_rounds: 0 } });
		expect(isRunFailure({ exitCode: 0, report })).toBe(true);
	});

	it("preserves exhausted/2 and separates max-turns from context exhaustion", () => {
		const report = summarizeReport({ result: { outcome: "exhausted", exit_code: 2 } });
		expect(report.outcome).toBe("exhausted");
		expect(report.resultExitCode).toBe(2);
		expect(report.accepted).toBe(false);
		expect(terminalFailureReason(2, report, [])?.code).toBe("max_turns");
		expect(terminalFailureReason(2, report, ["context window exceeded"])?.code).toBe("context_overflow");
		expect(terminalFailureReason(2, undefined, [])?.code).toBe("config_error");
	});

	it.each([false, true])("uses terminal structured context exhaustion with empty stderr (earlier rejection=%s)", (rejected) => {
		const report = summarizeReport({ result: { outcome: "exhausted", exit_code: 2 },
			stats: { turns: 3, review_rounds: rejected ? 1 : 0 },
			timeline: [
				...(rejected ? [{ type: "review", exit_code: 1, feedback: "earlier rejection" }] : []),
				{ type: "llm_call", turn: 3 },
				{ type: "recovered_response", turn: 3, reason: "context_exhausted" },
			] });
		expect(report.outcome).toBe("exhausted");
		expect(report.resultExitCode).toBe(2);
		expect(report.accepted).toBe(false);
		expect(classifyFailure([], report)?.code).toBe("context_overflow");
		expect(terminalFailureReason(2, report, [])?.code).toBe("context_overflow");
	});

	it.each(["success", "exhausted"])("ignores a nonterminal context marker before later %s", (outcome) => {
		const report = summarizeReport({ result: { outcome, exit_code: outcome === "success" ? 0 : 2 },
			stats: { turns: 4 }, timeline: [
				{ type: "recovered_response", turn: 3, reason: "context_exhausted" },
				{ type: "llm_call", turn: 4 },
			] });
		expect(terminalFailureReason(outcome === "success" ? 0 : 2, report, [])?.code)
			.toBe(outcome === "success" ? undefined : "max_turns");
	});

	it("keeps final reviewer rejection after a stale context marker", () => {
		const report = summarizeReport({ result: { outcome: "success", exit_code: 0 },
			stats: { review_rounds: 1 }, timeline: [
				{ type: "recovered_response", turn: 3, reason: "context_exhausted" },
				{ type: "review", exit_code: 1 },
			] });
		expect(report.lastReviewExitCode).toBe(1);
		expect(terminalFailureReason(0, report, [])?.code).toBe("review_rejected");
	});

	it("uses max_turns without a terminal context marker after an earlier rejection", () => {
		const report = summarizeReport({ result: { outcome: "exhausted", exit_code: 2 },
			stats: { review_rounds: 1, turns: 4 }, timeline: [
				{ type: "review", exit_code: 1 }, { type: "llm_call", turn: 4 },
			] });
		expect(terminalFailureReason(2, report, [])?.code).toBe("max_turns");
	});

	it("retains context exhaustion through final lifecycle bookkeeping", () => {
		const report = summarizeReport({ result: { outcome: "exhausted", exit_code: 2 },
			stats: { turns: 3 }, timeline: [
				{ type: "recovered_response", turn: 3, reason: "context_exhausted" },
				{ type: "lifecycle", event: "run.end" },
			] });
		expect(terminalFailureReason(2, report, [])?.code).toBe("context_overflow");
	});

	it("uses terminal context evidence when released max_turn_seen lags the marker", () => {
		// The unknown-window terminal-floor failure records no successful LLM
		// call. record_recovered_response does not advance max_turn_seen.
		const report = summarizeReport({ result: { outcome: "exhausted", exit_code: 2 },
			stats: { turns: 0 }, timeline: [
				{ type: "recovered_response", turn: 1, reason: "context_exhausted" },
			] });
		expect(report.turns).toBe(0);
		expect(terminalFailureReason(2, report, [])?.code).toBe("context_overflow");
	});

	it("ignores a context marker from an older turn even when it ends the timeline", () => {
		const report = summarizeReport({ result: { outcome: "exhausted", exit_code: 2 },
			stats: { turns: 4 }, timeline: [
				{ type: "recovered_response", turn: 3, reason: "context_exhausted" },
			] });
		expect(terminalFailureReason(2, report, [])?.code).toBe("max_turns");
	});

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

	it("extracts exposure and cost from Swival 1.0.45 stats.exposure schema", () => {
		const s = summarizeReport({
			result: { outcome: "success", exit_code: 0 },
			stats: {
				exposure: {
					unit: "tokens",
					input: {
						total: 8200,
						system: 500,
						user: 1200,
						assistant: 2500,
						tool_schemas: { read_file: 300, edit: 500 },
						tool_results: { read_file: 2000, grep: 800 },
						summaries: { previous_round: 400 },
					},
					cost: {
						known_usd: 0.057,
					},
				},
			},
		});
		expect(s.estimatedCostUsd).toBe(0.057);
		expect(s.exposure?.totalEstimatedInputTokens).toBe(8200);
		expect(s.exposure?.toolSchemas).toBe(800);
		expect(s.exposure?.toolResults).toBe(2800);
		expect(s.exposure?.summaries).toBe(400);
		expect(s.exposure?.history).toBe(4200);
	});

	it("extracts estimatedCostUsd and exposure breakdown when present", () => {
		const s = summarizeReport({
			result: { outcome: "success", exit_code: 0 },
			stats: {
				estimated_cost_usd: 0.042,
			},
			exposure: {
				tool_results: 1500,
				tool_schemas: 800,
				history: 4200,
				summaries: 350,
				total_estimated_input_tokens: 6850,
			},
		});
		expect(s.estimatedCostUsd).toBe(0.042);
		expect(s.exposure?.toolResults).toBe(1500);
		expect(s.exposure?.toolSchemas).toBe(800);
		expect(s.exposure?.history).toBe(4200);
		expect(s.exposure?.summaries).toBe(350);
		expect(s.exposure?.totalEstimatedInputTokens).toBe(6850);
	});

	it("falls back to alternate cost field names (total_cost_usd, cost_usd)", () => {
		expect(summarizeReport({ stats: { total_cost_usd: 0.12 } }).estimatedCostUsd).toBe(0.12);
		expect(summarizeReport({ stats: { cost_usd: 0.08 } }).estimatedCostUsd).toBe(0.08);
		expect(summarizeReport({}).estimatedCostUsd).toBeUndefined();
	});

	it("tolerates missing or malformed exposure", () => {
		expect(summarizeReport({}).exposure).toBeUndefined();
		expect(summarizeReport({ exposure: "malformed" as any }).exposure).toBeUndefined();
		expect(summarizeReport({ exposure: {} }).exposure).toBeUndefined();
	});

	it("extracts providerTimeout and initialToolChoice from settings when present", () => {
		const s = summarizeReport({
			result: { outcome: "success", exit_code: 0 },
			settings: { provider_timeout: 300, initial_tool_choice: "required" },
		});
		expect(s.providerTimeout).toBe(300);
		expect(s.initialToolChoice).toBe("required");
	});

	it("tolerates a report with no settings object for providerTimeout/initialToolChoice", () => {
		const s = summarizeReport({ result: { outcome: "success", exit_code: 0 } });
		expect(s.providerTimeout).toBeUndefined();
		expect(s.initialToolChoice).toBeUndefined();
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

	it("classifies E2BIG / argument list too long with escape hatch advice", () => {
		const res = classifyFailure(["exec: argument list too long"]);
		expect(res?.code).toBe("config_error");
		expect(res?.text).toMatch(/sandbox: builtin/);
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
