/**
 * Swival report summarization and terminal failure classification.
 *
 * Pure transformations over parsed report structures, stderr tails, and
 * provider-timeout hints; no filesystem I/O or process ownership.
 */

import type { EffectiveProviderTimeout, FailureReason, NativeAuditResult, ReportSummary } from "./contracts.js";
import { parseEffectiveProviderTimeout } from "./paths.js";

// ------------------------------------------------------ run failure --

/**
 * A run succeeds only when Swival exits zero and its required report records
 * outcome=success. Reviewer rejection and AgentError subclasses can exit zero,
 * so missing, malformed, or unknown reports must fail closed.
 */
export function isRunFailure(r: { exitCode: number; nativeAudit?: NativeAuditResult; report?: { outcome?: string } }): boolean {
	if (r.nativeAudit) return r.exitCode !== 0 || r.nativeAudit.status !== "completed";
	return r.exitCode !== 0 || r.report?.outcome !== "success";
}

// ---------------------------------------------------- report summary --

const toNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const toStr = (v: unknown) => (typeof v === "string" ? v : undefined);

export function summarizeReport(raw: Record<string, unknown>): ReportSummary {
	// Schema version 1 (see swival/report.py). Missing fields are tolerated.
	const stats = (raw.stats ?? {}) as Record<string, unknown>;
	const result = (raw.result ?? {}) as Record<string, unknown>;
	const settings = (raw.settings ?? {}) as Record<string, unknown>;
	const timelineRaw = Array.isArray(raw.timeline) ? (raw.timeline as Array<Record<string, unknown>>) : [];

	const outcomeVal = toStr(result.outcome);
	const outcome: ReportSummary["outcome"] = (["success", "failed", "error", "interrupted", "exhausted"] as const)
		.find((known) => known === outcomeVal) ?? "unknown";

	// Last reviewer feedback: the most recent timeline entry of type "review".
	let lastReviewFeedback: string | undefined;
	for (let i = timelineRaw.length - 1; i >= 0; i--) {
		const entry = timelineRaw[i];
		if (entry?.type === "review") {
			const fb = toStr(entry.feedback);
			if (fb && fb.trim()) { lastReviewFeedback = fb.trim(); break; }
		}
	}

	const promptCacheRaw = stats.prompt_cache as Record<string, unknown> | undefined;
	const promptCache = promptCacheRaw && typeof promptCacheRaw === "object"
		? { cachedTokens: toNum(promptCacheRaw.cached_tokens), cacheWriteTokens: toNum(promptCacheRaw.cache_write_tokens) }
		: undefined;
	const securityRaw = stats.security as Record<string, unknown> | undefined;
	const security = securityRaw && typeof securityRaw === "object"
		? {
			commandPolicyBlocks: toNum(securityRaw.command_policy_blocks),
			commandPolicyApprovals: toNum(securityRaw.command_policy_approvals),
			untrustedInputs: toNum(securityRaw.untrusted_inputs),
		}
		: undefined;

	return {
		reviewRounds: toNum(stats.review_rounds),
		outcome,
		accepted: outcome === "success" ? true : outcome === "unknown" ? undefined : false,
		errorMessage: toStr(result.error_message),
		turns: toNum(stats.turns),
		toolCallsTotal: toNum(stats.tool_calls_total),
		toolCallsByName: validateToolCallsByName(stats.tool_calls_by_name),
		totalLlmTimeS: toNum(stats.total_llm_time_s),
		totalToolTimeS: toNum(stats.total_tool_time_s),
		llmCalls: toNum(stats.llm_calls),
		compactions: toNum(stats.compactions),
		lastReviewFeedback,
		answer: toStr(result.answer),
		model: toStr(raw.model),
		provider: toStr(raw.provider),
		network: toStr(raw.network),
		sandbox: summarizeSandbox(raw.sandbox),
		promptCache,
		security,
		stormedCalls: toNum(stats.stormed_calls),
		truncationRepairs: toNum(stats.truncation_repairs),
		exposure: summarizeExposure(stats.exposure ?? raw.exposure),
		estimatedCostUsd: summarizeCost(stats.exposure ?? raw.exposure, stats),
		providerTimeout: toNum(settings.provider_timeout),
		initialToolChoice: toStr(settings.initial_tool_choice) === "required" ? "required"
			: toStr(settings.initial_tool_choice) === "auto" ? "auto" : undefined,
		raw,
	};
}

function sumDictValues(val: unknown): number | undefined {
	if (typeof val === "number") return val;
	if (val && typeof val === "object" && !Array.isArray(val)) {
		let sum = 0;
		let hasNumber = false;
		for (const v of Object.values(val as Record<string, unknown>)) {
			if (typeof v === "number") { sum += v; hasNumber = true; }
		}
		return hasNumber ? sum : undefined;
	}
	return undefined;
}

function summarizeCost(exposureRaw: unknown, stats: Record<string, unknown>): number | undefined {
	const exp = (exposureRaw && typeof exposureRaw === "object" ? exposureRaw : undefined) as Record<string, unknown> | undefined;
	const expCost = exp?.cost && typeof exp.cost === "object" ? (exp.cost as Record<string, unknown>).known_usd : undefined;
	return toNum(expCost) ?? toNum(stats.estimated_cost_usd) ?? toNum(stats.total_cost_usd) ?? toNum(stats.cost_usd);
}

function summarizeExposure(raw: unknown): ReportSummary["exposure"] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const e = raw as Record<string, unknown>;
	const input = (e.input && typeof e.input === "object" && !Array.isArray(e.input)) ? (e.input as Record<string, unknown>) : e;
	const toolResults = sumDictValues(input.tool_results) ?? toNum(input.toolResults);
	const toolSchemas = sumDictValues(input.tool_schemas) ?? toNum(input.toolSchemas);
	const summaries = sumDictValues(input.summaries);
	const user = toNum(input.user) ?? 0;
	const assistant = toNum(input.assistant) ?? 0;
	const system = toNum(input.system) ?? 0;
	const history = toNum(input.history) ?? (user + assistant + system > 0 ? user + assistant + system : undefined);
	const totalEstimatedInputTokens = toNum(input.total) ?? toNum(input.total_estimated_input_tokens);
	if ([toolResults, toolSchemas, history, summaries, totalEstimatedInputTokens].every((v) => v === undefined)) return undefined;
	return { toolResults, toolSchemas, history, summaries, totalEstimatedInputTokens };
}

function summarizeSandbox(raw: unknown): ReportSummary["sandbox"] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const s = raw as Record<string, unknown>;
	const sandbox = {
		mode: toStr(s.mode), agentfsVersion: toStr(s.agentfs_version), diffHint: toStr(s.diff_hint),
		nonoVersion: toStr(s.nono_version), nonoProfile: toStr(s.nono_profile),
		nonoRollback: typeof s.rollback === "boolean" ? s.rollback : undefined,
	};
	return Object.values(sandbox).every((v) => v === undefined) ? undefined : sandbox;
}

function validateToolCallsByName(raw: unknown): ReportSummary["toolCallsByName"] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const out: Record<string, { succeeded?: number; failed?: number }> = {};
	for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
		if (!val || typeof val !== "object" || Array.isArray(val)) continue;
		const v = val as Record<string, unknown>;
		const succeeded = toNum(v.succeeded);
		const failed = toNum(v.failed);
		if (succeeded !== undefined || failed !== undefined) out[name] = { succeeded, failed };
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

// ------------------------------------------------ failure classify --

function terminalProviderTimeout(report?: ReportSummary, hint?: EffectiveProviderTimeout): EffectiveProviderTimeout {
	const parsed = parseEffectiveProviderTimeout(hint);
	if (typeof report?.providerTimeout === "number" && Number.isFinite(report.providerTimeout) && report.providerTimeout > 0) {
		return parsed?.seconds === report.providerTimeout ? parsed : { seconds: report.providerTimeout, source: "report.settings" };
	}
	return parsed ?? { seconds: null, source: "unresolved configuration" };
}

function appendProviderTimeoutHint(message: string, timeoutHint: EffectiveProviderTimeout): string {
	const value = timeoutHint.seconds === null ? "unresolved" : `${timeoutHint.seconds}s`;
	const remedy = timeoutHint.source === "agent extraArgs" ? "raise the agent extraArgs --provider-timeout (it outranks providerTimeoutOverride)" : "raise `providerTimeoutOverride`";
	const suffix = `(effective provider timeout ${value} (${timeoutHint.source}); ${remedy})`;
	return message.includes("effective provider timeout") ? message : `${message} ${suffix}`;
}

/**
 * Map a noisy stderr tail (plus the report summary, if any) onto a short,
 * human-friendly error headline. A typed `result.error_message` from the
 * report is authoritative and preferred over stderr heuristics.
 */
export function classifyFailure(
	stderrLines: readonly string[],
	report?: ReportSummary,
	timeoutHint?: EffectiveProviderTimeout,
): FailureReason | undefined {
	if (report?.outcome === "exhausted") return { code: "max_turns", text: "Swival reached its turn limit before completion." };
	if (report?.outcome === "failed" && typeof report.reviewRounds === "number" && report.reviewRounds > 0) {
		return {
			code: "review_rejected",
			text: `Reviewer rejected after ${report.reviewRounds} round${report.reviewRounds === 1 ? "" : "s"}. See 'reviewer feedback' below.`,
		};
	}
	if (report?.outcome === "interrupted") return { code: "non_zero_exit", text: "Swival execution was interrupted (SIGINT / exit 130)." };

	const reportMsg = report?.errorMessage?.trim();
	if (reportMsg) {
		if (/\blitellm\.Timeout\b|\bAPITimeoutError\b|Connection timed out after/i.test(reportMsg)) {
			return { code: "unknown", text: appendProviderTimeoutHint(reportMsg, terminalProviderTimeout(report, timeoutHint)) };
		}
		if (/context window exceeded|contextoverflow/i.test(reportMsg)) return { code: "context_overflow", text: `Context window exceeded — ${reportMsg}` };
		if (/instruction.*(?:too large|fit this setup|read limit)|instructionloaderror/i.test(reportMsg)) return { code: "config_error", text: reportMsg };
		if (/some instruction files could not be read|unreadable instruction/i.test(reportMsg)) return { code: "config_error", text: reportMsg };
		if (/does not support (?:chat completions with tools|function calling)|toolsnotsupported/i.test(reportMsg)) {
			return { code: "config_error", text: `Model does not support function calling — ${reportMsg}` };
		}
		if (/lifecycle.*hook failed|lifecycleerror/i.test(reportMsg)) return { code: "config_error", text: `Lifecycle hook failed — ${reportMsg}` };
		if (/configerror|unknown provider|invalid provider|agentfs binary not found|agentfs sandbox was requested|nono sandbox was requested/i.test(reportMsg)) {
			return { code: "config_error", text: reportMsg };
		}
		return { code: "unknown", text: reportMsg };
	}

	const tail = stderrLines.slice(-50).join("\n");
	const L = tail.toLowerCase();
	const lastStderrLine = tail.split("\n").map((l) => l.trim()).filter(Boolean).slice(-1)[0] ?? "";
	if (/\blitellm\.Timeout\b|\bAPITimeoutError\b|Connection timed out after/i.test(lastStderrLine)) {
		return { code: "unknown", text: appendProviderTimeoutHint(lastStderrLine, terminalProviderTimeout(report, timeoutHint)) };
	}
	if (/interrupted\.|keyboardinterrupt/i.test(tail)) return { code: "non_zero_exit", text: "Swival execution was interrupted (SIGINT / exit 130)." };
	if (/token has expired|sso session|sso.*expired|expired token/i.test(tail)) return { code: "provider_auth", text: "AWS SSO session expired — run `aws sso login` and retry." };
	if (/unable to locate credentials|no credentials|credentialretrieval|expiredtoken/i.test(tail)) return { code: "provider_auth", text: "AWS credentials missing or expired." };
	if (/401 unauthorized|invalid[_ -]?api[_ -]?key|authentication.*fail/i.test(tail)) return { code: "provider_auth", text: "LLM provider rejected the API key (401)." };
	if (/403 forbidden|accessdenied/i.test(tail)) return { code: "provider_auth", text: "LLM provider denied access (403)." };
	if (/429 too many requests|rate limit|ratelimit/i.test(tail)) return { code: "rate_limited", text: "Rate limited by the LLM provider (429). Retry after backoff." };
	if (/econnrefused|connection refused/i.test(tail)) return { code: "connection_refused", text: "Connection refused — is the local model server running?" };
	if (/enotfound|name or service not known|dns/i.test(L) && /proxy|api|model/.test(L)) return { code: "connection_refused", text: "DNS lookup failed for the LLM endpoint." };
	if (/context window exceeded|contextoverflowerror/i.test(tail)) {
		return { code: "context_overflow", text: "Context window exceeded (swival could not recover after truncation retries)." };
	}
	const nonEmpty = () => tail.split("\n").filter((l) => l.trim());
	if (/the instruction files are too large|instruction.*(?:too large|fit this setup|read limit)|instructionloaderror/i.test(tail)) {
		const lines = nonEmpty();
		return { code: "config_error", text: lines.find((l) => /too large|fit this setup|read limit|instructionloaderror/i.test(l))
			?? lines.find((l) => /instruction/i.test(l)) ?? "Instruction files too large for setup." };
	}
	if (/some instruction files could not be read/i.test(tail)) {
		const lines = nonEmpty();
		return { code: "config_error", text: lines.find((l) => /could not be read/i.test(l))
			?? lines.find((l) => /instruction/i.test(l)) ?? "Some instruction files could not be read." };
	}
	if (/^\s*(?:fmt\.warning:\s*)?interrupted\.$|keyboardinterrupt/im.test(tail)) return { code: "non_zero_exit", text: "Swival execution was interrupted (SIGINT / exit 130)." };
	if (/toolsnotsupportederror|does not support function calling|does not support chat completions with tools/i.test(tail)) {
		return { code: "config_error", text: "Model does not support function calling." };
	}
	if (/lifecycleerror|lifecycle.*hook failed/i.test(tail)) return { code: "config_error", text: "Lifecycle hook failed (fail-closed mode)." };
	if (/configerror|unknown provider|invalid provider|agentfs binary not found/i.test(tail)) {
		return { code: "config_error", text: nonEmpty().slice(-1)[0] ?? "swival config error." };
	}
	if (/e2big|argument list too long|exec.*failed/i.test(tail)) {
		return { code: "config_error", text: "Arguments too large (ARG_MAX): trim the task prompt or agent body, or set `sandbox: builtin` to pipe the task over stdin." };
	}
	return undefined;
}

/** Human-readable errorMessage for a failing run; empty strings never pass through as defined values. */
export function computeErrorMessage(args: {
	classifiedText: string | undefined;
	stderrTail: string;
	exitCode: number;
	outcome: string | undefined;
}): string | undefined {
	const { classifiedText, stderrTail, exitCode, outcome } = args;
	const fallback = exitCode !== 0 ? `swival exited ${exitCode}` : `swival reported outcome=${outcome ?? "unknown"}`;
	return (classifiedText || "").trim() || stderrTail.trim() || fallback;
}

/** Apply one failure policy to synchronous and completed asynchronous runs. */
export function terminalFailureReason(
	exitCode: number,
	report: ReportSummary | undefined,
	stderrLines: readonly string[],
	existingReason?: FailureReason,
	timeoutHint?: EffectiveProviderTimeout,
): FailureReason | undefined {
	if (!isRunFailure({ exitCode, report })) return undefined;
	if (existingReason) return existingReason;
	if (exitCode === 130) return { code: "non_zero_exit", text: "Swival execution was interrupted (exit 130)." };
	const classified = classifyFailure(stderrLines, report, timeoutHint);
	if (classified) return classified;
	if (!report || report.outcome === "unknown") return { code: "config_error", text: "Swival did not produce a valid terminal report." };
	const text = computeErrorMessage({
		classifiedText: undefined,
		stderrTail: stderrLines.filter(Boolean).slice(-5).join("\n"),
		exitCode,
		outcome: report.outcome,
	}) ?? "Swival run failed.";
	return { code: exitCode !== 0 ? "non_zero_exit" : "unknown", text };
}
