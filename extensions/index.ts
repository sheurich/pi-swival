/**
 * Swival Subagent Tool — delegate tasks to swival with its reviewer loop.
 *
 * Spawns a separate `swival` process for each invocation. Unlike pi's
 * example subagent extension which shares a JSON streaming protocol,
 * swival has no structured event stream: diagnostics go to stderr,
 * final answer to stdout, and structured metadata to a `--report` JSON
 * file on exit.
 *
 * Modes:
 *   - Single:   { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain:    { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *               Each step's task may reference `{previous}` which is
 *               substituted with the prior step's final answer before
 *               dispatch. The chain stops on the first failing step
 *               (non-zero exit, or outcome is "failed" or "error").
 *
 * Swival agents are discovered from three locations (highest priority wins):
 *   1. .pi/swival-agents/ walked up from cwd (project scope)
 *   2. ~/.pi/agent/swival-agents/ (user scope)
 *   3. This package's agents/ directory (bundled, always available)
 * Their frontmatter schema extends the
 * pi-subagent schema with swival-specific fields (selfReview, reviewer,
 * verify, sandbox, files, commands, etc.). See agents.ts.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type AgentScope,
	discoverSwivalAgents,
	type SwivalAgentConfig,
} from "./agents.js";

// Maximum array size of tasks[] and chain[] params.
const MAX_PARALLEL_TASKS = 8;
const DEFAULT_CONCURRENCY = 4;
// Maximum worker pool size used by mapWithConcurrency.
const MAX_CONCURRENCY = 8;
const STDERR_TAIL_LINES = 30;
/** Ring-buffer cap for stdout accumulation (in UTF-16 code units, i.e.
 * JavaScript string .length). 256 K chars is comfortably above any expected
 * answer length; the ring prevents unbounded growth on chatty agents.
 */
const STDOUT_RING_CHARS = 256 * 1024;
// Artifacts are copied here before the per-run temp dir is deleted. Caller
// sees report.json + trace JSONL under a timestamped subdir keyed by agent.
const ARTIFACT_ROOT = path.join(os.homedir(), ".pi", "agent", "swival-artifacts");

// ------------------------------------------------- async run tracking --

/**
 * Metadata written to `<artifactDir>/run-meta.json` for every async run.
 * Persisted to disk so `status` and `resume` work even after Pi restarts.
 */
export interface RunMeta {
	runId: string;
	agent: string;
	task: string;
	startedAt: number;
	/** PID of the spawned swival process. Stored so we can probe it with
	 *  `process.kill(pid, 0)` after the in-memory entry is gone. */
	pid: number | undefined;
	artifactDir: string;
	stdoutFile: string;
	stderrFile: string;
}

interface AsyncRunEntry {
	meta: RunMeta;
	proc: ChildProcess;
	exited: boolean;
	exitCode: number | null;
}

/** Written to `<artifactDir>/completed.json` when an async run exits (or fails to start). */
interface CompletedMarker {
	exitCode: number | null;
	exitedAt: string; // ISO 8601
}

/** Unified view of an async run's state, for use in control actions. */
interface RunStateInfo {
	meta: RunMeta;
	/** Present when the run is (or was) tracked in the in-memory asyncRuns Map. */
	entry?: AsyncRunEntry;
	/** True when the run has definitively exited (in-memory flag or completed.json found). */
	exited: boolean;
	exitCode: number | null;
	completed?: CompletedMarker;
	/** Contents of spawn-error.txt when swival failed to start (e.g. ENOENT). */
	spawnError?: string;
}

/**
 * Module-level registry of in-flight and recently completed async runs.
 * Keyed by runId (`swival-run-<timestamp>`). Entries are added when a
 * background spawn succeeds and updated (exited=true, exitCode set) when the
 * process closes. Entries survive only for the lifetime of the Pi process;
 * cross-session recovery falls back to scanning `run-meta.json` files in the
 * artifact root.
 */
const asyncRuns = new Map<string, AsyncRunEntry>();

// -------------------------------------------------------------- helpers --

function stripAnsi(s: string): string {
	// Remove CSI / OSC / SGR sequences. Not exhaustive but covers swival's output.
	return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "");
}

function tail<T>(arr: T[], n: number): T[] {
	return arr.length > n ? arr.slice(arr.length - n) : arr;
}

/**
 * Truncate inline body when caller-supplied cap is exceeded. Used in single,
 * chain, and parallel result paths so a 200 KB answer doesn't flood Pi's
 * tool-response content. Truncation is loud — the marker points the caller
 * at where the full answer lives (artifact dir, output file).
 *
 * Char-length cap, not byte cap: TypeScript string slicing is by UTF-16 code
 * unit, not bytes. The marker counts characters too. This matches what
 * buildParallelSummary did pre-extraction; do not change semantics.
 */
export function applyInlineCap(body: string, cap: number | undefined, pointer: string | undefined): string {
	if (typeof cap !== "number" || cap <= 0 || body.length <= cap) return body;
	const cut = body.length - cap;
	const tail = pointer ? `\n[truncated ${cut} chars; full output at ${pointer}]` : `\n[truncated ${cut} chars]`;
	return body.slice(0, cap) + tail;
}

/**
 * Write a run's finalOutput to disk and populate the output bookkeeping
 * fields on the result. Mirrors the inline block previously used in parallel
 * mode. Caller is responsible for picking the cwd anchor for relative paths.
 *
 * On error (mkdir / write failure) the caller's stderrTail is appended; the
 * function does not throw.
 */
async function writeRunOutput(
	r: SwivalResult,
	outputPath: string,
	outputMode: "inline" | "file-only" | undefined,
	cwdAnchor: string,
): Promise<void> {
	const resolved = path.isAbsolute(outputPath) ? outputPath : path.resolve(cwdAnchor, outputPath);
	try {
		await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
		const body = r.finalOutput ?? "";
		await fs.promises.writeFile(resolved, body, "utf-8");
		r.outputPath = resolved;
		// Default file-only when output is set; inline opts back in.
		r.outputMode = outputMode ?? "file-only";
		r.outputBytes = Buffer.byteLength(body, "utf-8");
		r.outputLineCount = body === "" ? 0 : body.split("\n").length;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		r.stderrTail = [...r.stderrTail, `failed to write output to ${resolved}: ${msg}`];
	}
}

/**
 * A run is considered a failure if swival exited non-zero OR the report
 * recorded a non-success outcome. Reviewer rejection and AgentError
 * subclasses can produce `outcome: "failed" | "error"` with exit 0
 * (e.g. review budget exhausted but the CLI itself completed fine).
 * `outcome: "unknown"` — from a missing or malformed report — is NOT
 * treated as failure so a misconfigured report flag doesn't mask a
 * successful run.
 */
export function isRunFailure(r: { exitCode: number; report?: { outcome?: string } }): boolean {
	if (r.exitCode !== 0) return true;
	const o = r.report?.outcome;
	return o === "failed" || o === "error";
}

/**
 * The exact `commands` allowlist that marks an agent as read-only at the
 * shell-allowlist level. Used by `isMutatingCwdAgent` to identify audit-style
 * agents whose only commands are read-only inspection. Drift-sensitive: if
 * the bundled audit-worker's allowlist changes, update this constant in
 * lockstep so the parallel-cwd guard keeps recognising it as read-only.
 */
export const READ_ONLY_AUDIT_COMMANDS = "git,ls,find,rg,grep,head,tail,wc,pwd";

/**
 * True when an agent could plausibly mutate its cwd — the inverse of the
 * conditions that make parallel dispatch on a shared cwd safe.
 *
 * Safe (i.e. NOT mutating-cwd):
 *   1. files: "none" — no filesystem write surface at all.
 *   2. commands == READ_ONLY_AUDIT_COMMANDS — read-only shell allowlist.
 *   3. sandbox: "agentfs" + noSandboxAutoSession — each invocation gets its
 *      own AgentFS overlay session, so writes don't collide on the cwd.
 *
 * Anything else is treated as write-capable for the purposes of the
 * parallel-cwd collision guard.
 */
export function isMutatingCwdAgent(agent: SwivalAgentConfig): boolean {
	if (agent.files === "none") return false;
	if (agent.commands === READ_ONLY_AUDIT_COMMANDS) return false;
	if (agent.sandbox === "agentfs" && agent.noSandboxAutoSession) return false;
	return true;
}

/**
 * Validate that an agent declaring `requiresReviewer: true` actually has a
 * reviewer attached for this call. Returns an error string when the gate
 * fails, or undefined when the call is allowed to proceed. Both frontmatter
 * and overrides count — the dispatcher accepts any of: agent.reviewer,
 * agent.selfReview, overrides.reviewer, overrides.selfReview.
 *
 * Pulled out of the run functions so both sync and async dispatch paths share
 * the same validation logic.
 */
export function checkRequiresReviewer(
	agent: SwivalAgentConfig,
	overrides: SwivalOverrides,
): string | undefined {
	if (!agent.requiresReviewer) return undefined;
	if (overrides.reviewer || agent.reviewer) return undefined;
	if (overrides.selfReview || agent.selfReview) return undefined;
	return (
		`Agent "${agent.name}" requires a reviewer (frontmatter sets requiresReviewer: true) ` +
		`but the call did not supply one. Pass reviewerOverride with a path to a reviewer ` +
		`script (test-as-contract), or selfReviewOverride: true to enable LLM self-review.`
	);
}

/**
 * Dispatch-time overrides that outrank frontmatter for a single call.
 * All fields are optional; undefined means "use the agent's frontmatter value".
 */
export interface SwivalOverrides {
	model?: string;
	profile?: string;
	provider?: string;
	baseUrl?: string;
	selfReview?: boolean;
	reviewer?: string;
	reviewPrompt?: string;
	maxReviewRounds?: number;
	temperature?: number;
	topP?: number;
	seed?: number;
	reasoningEffort?: string;
	maxOutputTokens?: number;
	maxTurns?: number;
	cache?: boolean;
	cacheDir?: string;
	traceDir?: string;
	verify?: string;
	encryptSecrets?: boolean;
	timeoutMs?: number;
}

export function buildSwivalArgs(
	agent: SwivalAgentConfig,
	reportPath: string,
	cwd: string | undefined,
	overrides: SwivalOverrides = {},
): string[] {
	const args: string[] = [];

	// Nested-invocation hygiene: default to disabling lifecycle / MCP / A2A /
	// history / continue / memory / subagents unless the agent explicitly opts
	// in (field=false). --no-subagents prevents a nested swival from spawning
	// its own sub-subagents (unbounded recursion risk).
	if (agent.noLifecycle !== false) args.push("--no-lifecycle");
	if (agent.noMcp !== false) args.push("--no-mcp");
	if (agent.noA2a !== false) args.push("--no-a2a");
	if (agent.noHistory !== false) args.push("--no-history");
	if (agent.noContinue !== false) args.push("--no-continue");
	if (agent.noMemory !== false) args.push("--no-memory");
	if (agent.noSubagents !== false) args.push("--no-subagents");

	// Provider / model (overrides outrank frontmatter)
	const provider = overrides.provider ?? agent.provider;
	if (provider) args.push("--provider", provider);
	const profile = overrides.profile ?? agent.profile;
	if (profile) args.push("--profile", profile);
	const model = overrides.model ?? agent.model;
	if (model) args.push("--model", model);
	const baseUrl = overrides.baseUrl ?? agent.baseUrl;
	if (baseUrl) args.push("--base-url", baseUrl);

	// Sampling / limits
	const temperature = overrides.temperature ?? agent.temperature;
	if (temperature !== undefined) args.push("--temperature", String(temperature));
	const topP = overrides.topP ?? agent.topP;
	if (topP !== undefined) args.push("--top-p", String(topP));
	const seed = overrides.seed ?? agent.seed;
	if (seed !== undefined) args.push("--seed", String(seed));
	const reasoningEffort = overrides.reasoningEffort ?? agent.reasoningEffort;
	if (reasoningEffort) args.push("--reasoning-effort", reasoningEffort);
	const maxOutputTokens = overrides.maxOutputTokens ?? agent.maxOutputTokens;
	if (maxOutputTokens !== undefined) args.push("--max-output-tokens", String(maxOutputTokens));
	const maxTurns = overrides.maxTurns ?? agent.maxTurns;
	if (maxTurns !== undefined) args.push("--max-turns", String(maxTurns));

	// Caching
	const cache = overrides.cache ?? agent.cache;
	if (cache) args.push("--cache");
	const cacheDir = overrides.cacheDir ?? agent.cacheDir;
	if (cacheDir) args.push("--cache-dir", cacheDir);

	// Context management / retry budget (swival 1.0.12+)
	if (agent.proactiveSummaries) args.push("--proactive-summaries");
	if (agent.retries !== undefined) args.push("--retries", String(agent.retries));

	// Reviewer loop — --self-review and --reviewer are mutually exclusive in
	// swival's argparse (hard crash: "cannot be used together"). When
	// selfReview is truthy, skip --reviewer even if the agent sets one.
	const selfReview = overrides.selfReview ?? agent.selfReview;
	const reviewer = overrides.reviewer ?? agent.reviewer;
	if (selfReview) {
		args.push("--self-review");
	} else if (reviewer) {
		args.push("--reviewer", reviewer);
	}
	const reviewPrompt = overrides.reviewPrompt ?? agent.reviewPrompt;
	if (reviewPrompt) args.push("--review-prompt", reviewPrompt);
	const verify = overrides.verify ?? agent.verify;
	if (verify) args.push("--verify", verify);
	const maxReviewRounds = overrides.maxReviewRounds ?? agent.maxReviewRounds;
	if (maxReviewRounds !== undefined) args.push("--max-review-rounds", String(maxReviewRounds));

	// Sandbox / commands
	if (agent.yolo) {
		args.push("--yolo");
	} else {
		if (agent.sandbox) args.push("--sandbox", agent.sandbox);
		if (agent.files) args.push("--files", agent.files);
		if (agent.commands) args.push("--commands", agent.commands);
	}
	// AgentFS session controls (only meaningful with --sandbox agentfs; we pass
	// them through regardless and let swival's argparse reject bad combinations).
	if (agent.sandboxSession) args.push("--sandbox-session", agent.sandboxSession);
	if (agent.sandboxStrictRead) args.push("--sandbox-strict-read");
	if (agent.noSandboxAutoSession) args.push("--no-sandbox-auto-session");
	if (agent.baseDir) args.push("--base-dir", agent.baseDir);
	else if (cwd) args.push("--base-dir", cwd);
	for (const d of agent.addDir ?? []) args.push("--add-dir", d);
	for (const d of agent.addDirRo ?? []) args.push("--add-dir-ro", d);
	const encryptSecrets = overrides.encryptSecrets ?? agent.encryptSecrets;
	if (encryptSecrets) args.push("--encrypt-secrets");
	if (agent.noReadGuard) args.push("--no-read-guard");

	// Prompt / memory (noMemory is handled above in nested-invocation hygiene)
	if (agent.noInstructions) args.push("--no-instructions");
	if (agent.noSkills) args.push("--no-skills");

	// Output shape: we want stdout to carry the final answer.
	// --no-color keeps stderr clean for forwarding to Pi's UI.
	args.push("--no-color");
	if (agent.quiet) args.push("-q");

	args.push("--report", reportPath);
	if (overrides.traceDir) args.push("--trace-dir", overrides.traceDir);

	// Agent system prompt (body of the .md). Pass as --system-prompt
	// argv; node's spawn handles long argv up to the platform ARG_MAX.
	if (agent.systemPrompt.trim()) {
		args.push("--system-prompt", agent.systemPrompt);
	}

	// Escape hatch
	for (const a of agent.extraArgs ?? []) args.push(a);

	return args;
}

// --------------------------------------------------------------- types --

/**
 * Subset of the swival `--report` JSON schema (version 1) that we surface.
 * Unknown / missing fields are tolerated; consumers must null-check.
 *
 * Tracked against swival 1.0.18. Known `outcome` values are "success",
 * "failed" (reviewer rejected), and "error" (an AgentError was raised:
 * ConfigError, ContextOverflowError, ToolsNotSupportedError, or
 * LifecycleError). For error outcomes, `result.error_message` carries
 * the exception string.
 *
 * Example minimal report:
 *   {
 *     "version": 1,
 *     "result": { "outcome": "success" | "failed" | "error",
 *                 "answer": "...final answer...",
 *                 "exit_code": 0,
 *                 "error_message": "context window exceeded (typed)" },
 *     "stats":  { "turns": 4, "review_rounds": 3, "tool_calls_total": 8,
 *                 "tool_calls_by_name": { "read_file": {succeeded:5,failed:0} },
 *                 "total_llm_time_s": 12.4, "total_tool_time_s": 0.1,
 *                 "llm_calls": 9, "compactions": 0 },
 *     "timeline": [
 *       { "type": "llm_call", ... },
 *       { "type": "review", "round": 1, "exit_code": 1, "feedback": "..." }
 *     ]
 *   }
 */
interface ReportSummary {
	// From stats.review_rounds — number of reviewer retry rounds that ran.
	reviewRounds?: number;
	// Derived from result.outcome. "success" means reviewer accepted (or
	// review was disabled and swival returned a terminal answer). "failed"
	// is a reviewer rejection. "error" is an internal AgentError (see
	// errorMessage for the specific cause).
	outcome?: "success" | "failed" | "error" | "unknown";
	accepted?: boolean;
	// From result.error_message — populated when swival raised an AgentError
	// subclass (ConfigError, ContextOverflowError, ToolsNotSupportedError,
	// LifecycleError). Prefer this over stderr-tail classification when present.
	errorMessage?: string;
	// From stats.turns — number of agent-loop iterations actually executed.
	turns?: number;
	// Tool usage stats (no token/cost totals in the report schema).
	toolCallsTotal?: number;
	toolCallsByName?: Record<string, { succeeded?: number; failed?: number }>;
	// Wall-clock breakdown for the session.
	totalLlmTimeS?: number;
	totalToolTimeS?: number;
	llmCalls?: number;
	compactions?: number;
	// Last reviewer feedback (populated from timeline[] when a review rejected).
	lastReviewFeedback?: string;
	// Final answer, if result.answer is present in the report.
	answer?: string;
	// Model / provider recorded by swival.
	model?: string;
	provider?: string;
	raw?: Record<string, unknown>;
}

/**
 * Lightweight view of a single trace event we care to render.
 * Swival emits one HuggingFace-compatible JSON object per line under
 * `--trace-dir/<sessionId>.jsonl`; we only extract tool calls and
 * assistant text for Pi's UI.
 */
export interface TraceToolCall {
	type: "toolCall";
	name: string;
	args: Record<string, unknown>;
	ok?: boolean; // set when a matching tool_result arrives
}
export interface TraceText {
	type: "text";
	text: string;
}
export type TraceEvent = TraceToolCall | TraceText;

/**
 * Short, stable machine code describing why a run *failed*. Separate from
 * the lifecycle `status` field so callers can treat success and failure as
 * orthogonal to the reason, and cleanly omit the reason on success.
 */
export type ReasonCode =
	| "review_rejected"
	| "max_turns"
	| "provider_auth"
	| "rate_limited"
	| "context_overflow"
	| "config_error"
	| "connection_refused"
	| "non_zero_exit"
	| "unknown";

/**
 * Terminal state of a swival run. Distinct from ReasonCode because
 * `completed` (ran without a reviewer) and `accepted` (reviewer approved)
 * are both success states, whereas `rejected` (reviewer said no) and
 * `failed` (non-zero exit) are both failure states with different origins.
 * Collapsing any of these loses diagnostic information.
 */
export type RunStatus =
	| "running"
	| "accepted"
	| "completed"
	| "rejected"
	| "failed"
	| "error";

export interface FailureReason {
	code: ReasonCode;
	text: string;
}

export interface SwivalResult {
	agent: string;
	agentSource: "bundled" | "user" | "project" | "unknown";
	task: string;
	exitCode: number; // -1 still running, 0 ok, >0 failure
	finalOutput: string;
	stderrTail: string[];
	durationMs: number;
	report?: ReportSummary;
	errorMessage?: string;
	// Populated only on failure. Use `renderStatus(result)` for the terminal
	// state; use `result.reason?.code` for a machine-readable failure cause.
	reason?: FailureReason;
	// Populated from --trace-dir JSONL when we can tail it.
	traceEvents?: TraceEvent[];
	// Path to the persisted artifact dir (`~/.pi/agent/swival-artifacts/<agent>-<ts>/`)
	// containing the swival `report.json` and any `<sessionId>.jsonl` trace
	// files we captured before tmpdir cleanup.
	artifactDir?: string;
	// Effective --max-turns value for this run (override or frontmatter).
	// Undefined means swival's built-in default (100) was used. Surfaced
	// in the header as "N/M turns" when a non-default limit was configured.
	effectiveMaxTurns?: number;
	// Set when the caller asked for per-task file output in parallel mode.
	// `outputPath` is the absolute path we wrote finalOutput to; `outputMode`
	// mirrors the TaskItem setting so consumers can decide whether to inline
	// the body or just point at the file. `outputBytes` / `outputLineCount`
	// are pre-computed so the summary can show size metadata without
	// re-reading the file.
	outputPath?: string;
	outputMode?: "inline" | "file-only";
	outputBytes?: number;
	outputLineCount?: number;
}

interface SwivalDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SwivalResult[];
}

type OnUpdateCallback = (partial: AgentToolResult<SwivalDetails>) => void;

// ---------------------------------------------------------- report read --

const toNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const toStr = (v: unknown) => (typeof v === "string" ? v : undefined);

export function summarizeReport(raw: Record<string, unknown>): ReportSummary {
	// Schema version 1 (see swival/report.py). We tolerate missing fields
	// but use the documented keys as the authoritative source.
	const stats = (raw.stats ?? {}) as Record<string, unknown>;
	const result = (raw.result ?? {}) as Record<string, unknown>;
	const timelineRaw = Array.isArray(raw.timeline) ? (raw.timeline as Array<Record<string, unknown>>) : [];

	const outcomeVal = toStr(result.outcome);
	let outcome: ReportSummary["outcome"] = "unknown";
	if (outcomeVal === "success") outcome = "success";
	else if (outcomeVal === "failed") outcome = "failed";
	else if (outcomeVal === "error") outcome = "error";

	// Last reviewer feedback: the most recent timeline entry of type "review".
	// We include its feedback even on accepted runs (for visibility), but
	// only surface it by default on rejections.
	let lastReviewFeedback: string | undefined;
	for (let i = timelineRaw.length - 1; i >= 0; i--) {
		const entry = timelineRaw[i];
		if (entry?.type === "review") {
			const fb = toStr(entry.feedback);
			if (fb && fb.trim()) {
				lastReviewFeedback = fb.trim();
				break;
			}
		}
	}

	return {
		reviewRounds: toNum(stats.review_rounds),
		outcome,
		accepted: outcome === "success" ? true : outcome === "failed" || outcome === "error" ? false : undefined,
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
		raw,
	};
}

function validateToolCallsByName(
	raw: unknown,
): ReportSummary["toolCallsByName"] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const out: Record<string, { succeeded?: number; failed?: number }> = {};
	for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
		if (!val || typeof val !== "object" || Array.isArray(val)) continue;
		const v = val as Record<string, unknown>;
		const succeeded = toNum(v.succeeded);
		const failed = toNum(v.failed);
		if (succeeded !== undefined || failed !== undefined) {
			out[name] = { succeeded, failed };
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

async function readReport(reportPath: string): Promise<ReportSummary | undefined> {
	// Fix 11: retry once on JSON parse error to handle non-atomic writes where
	// the file exists but hasn't been fully flushed yet.
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const txt = await fs.promises.readFile(reportPath, "utf-8");
			const parsed = JSON.parse(txt) as Record<string, unknown>;
			return summarizeReport(parsed);
		} catch (err) {
			if (attempt === 0 && err instanceof SyntaxError) {
				await new Promise<void>((res) => setTimeout(res, 100));
				continue;
			}
			return undefined;
		}
	}
	return undefined;
}

// ---------------------------------------------------- error classify --

/**
 * Map a noisy stderr tail (plus the report summary, if any) onto a short,
 * human-friendly error headline. Pi surfaces `errorMessage` in the failure
 * banner, so keeping it concise makes for a better UX than dumping the
 * entire traceback.
 *
 * When the report carries a typed `result.error_message` (swival 1.0.14+
 * writes one whenever an AgentError subclass is raised), we prefer that
 * over the stderr heuristics below since it's the authoritative cause.
 *
 * Patterns we recognise today:
 *   - AWS SSO session expired / credentials missing
 *   - HTTP 401 / 403 from the LLM provider
 *   - DNS / connection refused to the LLM endpoint (e.g. proxy down)
 *   - Rate limit (429)
 *   - ConfigError (unknown provider / missing model / bad API key)
 *   - ContextOverflowError (context window exceeded; 1.0.14 recovers when
 *     it can, but surfaces this when retries at 50/25/10% all fail)
 *   - ToolsNotSupportedError (model lacks function calling)
 *   - LifecycleError (lifecycle hook failed in fail-closed mode)
 *   - Review-round budget exhausted
 *   - ARG_MAX from oversized system prompt
 */
export function classifyFailure(
	stderrLines: readonly string[],
	report?: ReportSummary,
): FailureReason | undefined {
	// Review budget exhausted is usually success-from-swival-cli's POV (exit 0)
	// but outcome=failed in the report. We surface it specifically so the
	// caller knows *why* the run is marked failed rather than showing stderr.
	if (report?.outcome === "failed" && typeof report.reviewRounds === "number" && report.reviewRounds > 0) {
		return {
			code: "review_rejected",
			text: `Reviewer rejected after ${report.reviewRounds} round${report.reviewRounds === 1 ? "" : "s"}. See 'reviewer feedback' below.`,
		};
	}

	// Prefer the authoritative error_message from the report when swival
	// finalized one (outcome="error" implies an AgentError subclass was raised).
	// We normalise the most common subclasses into a short headline but fall
	// back to the raw message when we don't have a specific pattern.
	const reportMsg = report?.errorMessage?.trim();
	if (reportMsg) {
		if (/context window exceeded|contextoverflow/i.test(reportMsg))
			return { code: "context_overflow", text: `Context window exceeded — ${reportMsg}` };
		if (/does not support (?:chat completions with tools|function calling)|toolsnotsupported/i.test(reportMsg))
			return { code: "config_error", text: `Model does not support function calling — ${reportMsg}` };
		if (/lifecycle.*hook failed|lifecycleerror/i.test(reportMsg))
			return { code: "config_error", text: `Lifecycle hook failed — ${reportMsg}` };
		if (/configerror|unknown provider|invalid provider|agentfs binary not found/i.test(reportMsg))
			return { code: "config_error", text: reportMsg };
		return { code: "unknown", text: reportMsg };
	}

	const tail = stderrLines.slice(-50).join("\n");
	const L = tail.toLowerCase();

	if (/token has expired|sso session|sso.*expired|expired token/i.test(tail))
		return { code: "provider_auth", text: "AWS SSO session expired — run `aws sso login` and retry." };
	if (/unable to locate credentials|no credentials|credentialretrieval|expiredtoken/i.test(tail))
		return { code: "provider_auth", text: "AWS credentials missing or expired." };
	if (/401 unauthorized|invalid[_ -]?api[_ -]?key|authentication.*fail/i.test(tail))
		return { code: "provider_auth", text: "LLM provider rejected the API key (401)." };
	if (/403 forbidden|accessdenied/i.test(tail))
		return { code: "provider_auth", text: "LLM provider denied access (403)." };
	if (/429 too many requests|rate limit|ratelimit/i.test(tail))
		return { code: "rate_limited", text: "Rate limited by the LLM provider (429). Retry after backoff." };
	if (/econnrefused|connection refused/i.test(tail))
		return { code: "connection_refused", text: "Connection refused — is the LLM proxy / MLX server running?" };
	if (/enotfound|name or service not known|dns/i.test(L) && /proxy|api|model/.test(L))
		return { code: "connection_refused", text: "DNS lookup failed for the LLM endpoint." };
	if (/context window exceeded|contextoverflowerror/i.test(tail))
		return {
			code: "context_overflow",
			text: "Context window exceeded (swival could not recover after truncation retries).",
		};
	if (/toolsnotsupportederror|does not support function calling|does not support chat completions with tools/i.test(tail))
		return { code: "config_error", text: "Model does not support function calling." };
	if (/lifecycleerror|lifecycle.*hook failed/i.test(tail))
		return { code: "config_error", text: "Lifecycle hook failed (fail-closed mode)." };
	if (/configerror|unknown provider|invalid provider|agentfs binary not found/i.test(tail))
		return {
			code: "config_error",
			text: tail.split("\n").filter((l) => l.trim()).slice(-1)[0] ?? "swival config error.",
		};
	if (/e2big|argument list too long|exec.*failed/i.test(tail))
		return {
			code: "config_error",
			text: "System prompt too large (ARG_MAX). Trim the agent body or move content into skills.",
		};
	return undefined;
}

/**
 * Compute the human-readable errorMessage surfaced on a failing run.
 *
 * Extracted from `runSingleSwival` so the fallback chain is unit-testable.
 * Regression guard: the previous implementation used `??` (nullish
 * coalescing) in the fallback chain, which let empty strings pass through
 * as a "defined" value — producing an empty errorMessage on credential
 * expiry where classifyFailure returned undefined and stderr was empty.
 * `||` plus explicit empty filtering is what we want here.
 */
export function computeErrorMessage(args: {
	classifiedText: string | undefined;
	stderrTail: string;
	exitCode: number;
	outcome: string | undefined;
}): string | undefined {
	const { classifiedText, stderrTail, exitCode, outcome } = args;
	const fallback =
		exitCode !== 0
			? `swival exited ${exitCode}`
			: `swival reported outcome=${outcome ?? "unknown"}`;
	return (classifiedText || "").trim() || stderrTail.trim() || fallback;
}

// ---------------------------------------------------- trace tailing --

/**
 * Tails a swival `--trace-dir` JSONL file, emitting TraceEvent updates to
 * the supplied callback whenever a new line lands. Swival writes one
 * `<sessionId>.jsonl` per session; since we use a private trace dir per
 * run, we can blindly watch the directory for the first `.jsonl` file to
 * appear and follow it.
 *
 * Returns an async cleanup that flushes any remaining content and stops
 * the watcher.
 */
export function startTraceTail(
	traceDir: string,
	onEvent: (event: TraceEvent) => void,
): () => Promise<void> {
	let watcher: fs.FSWatcher | null = null;
	let fileWatcher: fs.FSWatcher | null = null;
	let traceFile: string | null = null;
	let position = 0;
	let buffer = "";
	const toolUseNames = new Map<string, string>();

	let consuming = false;
	let shouldRerun = false;
	const consume = async () => {
		if (consuming) { shouldRerun = true; return; }
		consuming = true;
		try {
			do {
				shouldRerun = false;
				if (!traceFile) return;
				let stat: fs.Stats;
				try {
					stat = await fs.promises.stat(traceFile);
				} catch {
					return;
				}
				if (stat.size <= position) return;
				let handle: fs.promises.FileHandle | undefined;
				try {
					handle = await fs.promises.open(traceFile, "r");
					// Read in bounded chunks so a burst-appended trace doesn't spike
					// memory. 64 KiB is large enough to cover most single-turn deltas
					// in one pass and small enough that peak RSS stays predictable
					// even when `fs.watch` coalesces multiple append events.
					const CHUNK_BYTES = 64 * 1024;
					const chunk = Buffer.alloc(CHUNK_BYTES);
					const end = stat.size;
					while (position < end) {
						const want = Math.min(CHUNK_BYTES, end - position);
						const { bytesRead } = await handle.read(chunk, 0, want, position);
						if (bytesRead <= 0) break;
					position += bytesRead;
					buffer += chunk.toString("utf-8", 0, bytesRead);
					// Cap buffer to prevent OOM from malicious newline-free trace files
					if (buffer.length > 4 * 1024 * 1024) {
						const cut = buffer.lastIndexOf("\n");
						buffer = cut >= 0 ? buffer.slice(cut + 1) : "";
					}
					}
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						if (!line.trim()) continue;
						let obj: Record<string, unknown>;
						try {
							obj = JSON.parse(line) as Record<string, unknown>;
						} catch {
							continue;
						}
						const t = obj.type;
						if (t === "assistant" && obj.message) {
							const msg = obj.message as Record<string, unknown>;
							const content = msg.content;
							if (Array.isArray(content)) {
								for (const part of content) {
									if (!part || typeof part !== "object") continue;
									const p = part as Record<string, unknown>;
									if (p.type === "tool_use" && typeof p.name === "string") {
										if (typeof p.id === "string") toolUseNames.set(p.id, p.name);
										const args = (p.input as Record<string, unknown>) ?? {};
										onEvent({ type: "toolCall", name: p.name, args });
									} else if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
										onEvent({ type: "text", text: p.text });
									}
								}
							}
						}
						if (t === "user" && obj.message) {
							// tool_result arrives as user-role with content list.
							const msg = obj.message as Record<string, unknown>;
							const content = msg.content;
							if (Array.isArray(content)) {
								for (const part of content) {
									if (!part || typeof part !== "object") continue;
									const p = part as Record<string, unknown>;
									if (p.type === "tool_result" && typeof p.tool_use_id === "string") {
										const name = toolUseNames.get(p.tool_use_id) ?? "tool";
										const ok = p.is_error !== true;
										onEvent({ type: "toolCall", name, args: {}, ok });
									}
								}
							}
						}
					}
				} finally {
					if (handle) await handle.close().catch(() => undefined);
				}
			} while (shouldRerun);
		} finally {
			consuming = false;
		}
	};

	const attachFileWatcher = () => {
		if (!traceFile || fileWatcher) return;
		try {
			fileWatcher = fs.watch(traceFile, { persistent: false }, () => {
				void consume();
			});
		} catch {
			/* file may not exist yet */
		}
	};

	const pickTraceFile = async () => {
		try {
			const entries = await fs.promises.readdir(traceDir);
			const jsonl = entries.find((e) => e.endsWith(".jsonl"));
			if (jsonl) {
				traceFile = path.join(traceDir, jsonl);
				attachFileWatcher();
				await consume();
			}
		} catch {
			/* trace dir not created yet */
		}
	};

	try {
		watcher = fs.watch(traceDir, { persistent: false }, () => {
			void pickTraceFile();
		});
	} catch {
		/* ignore — trace tail is best-effort */
	}
	void pickTraceFile();

	return async () => {
		watcher?.close();
		fileWatcher?.close();
		await consume();
	};
}

// ---------------------------------------------------- artifact persist --

// -------------------------------------------------- artifact dir minting --

interface ArtifactDirMint {
	artifactDir: string;
	ts: number; // epoch ms
	/** Includes the random suffix to prevent millisecond-level runId collisions. */
	runId: string;
}

/**
 * Compute a unique artifact directory path and corresponding runId for a run.
 * Shared by both the sync path (persistArtifacts) and the async path
 * (runSingleSwivalAsync) so they use identical timestamp format and suffix logic.
 * The runId includes the suffix so two runs starting within the same millisecond
 * produce distinct IDs.
 */
function mintArtifactDir(
	agentName: string,
	artifactRoot: string = ARTIFACT_ROOT,
	ts: number = Date.now(),
): ArtifactDirMint {
	const safeAgent =
		agentName
			.replace(/[^a-zA-Z0-9._-]/g, "_")
			.replace(/\.+/g, ".")
			.replace(/^[._-]+/, "") || "swival";
	const suffix = randomBytes(4).toString("hex");
	const runId = `swival-run-${ts}-${suffix}`;
	const artifactDir = path.join(artifactRoot, `${safeAgent}-${ts}-${suffix}`);
	return { artifactDir, ts, runId };
}

/**
 * Copy swival's `report.json` and any `<sessionId>.jsonl` trace files from
 * the per-run tmp dir into `~/.pi/agent/swival-artifacts/<agent>-<ts>/`
 * so they outlive the `rm(tmpDir)` call in `runSingleSwival`.
 *
 * Returns the artifact dir path on success, or undefined if we captured
 * nothing (no report and no trace files — unusual but possible if swival
 * crashed before it could write anything). Best-effort: individual copy
 * errors are swallowed so cleanup always runs.
 */
export async function persistArtifacts(
	tmpDir: string,
	agentName: string,
	artifactRoot: string = ARTIFACT_ROOT,
	now: Date = new Date(),
): Promise<string | undefined> {
	// Fix 2: use shared mintArtifactDir so the directory naming matches the
	// async path (epoch-ms timestamp, same suffix logic).
	const { artifactDir: destDir } = mintArtifactDir(agentName, artifactRoot, now.getTime());

	let captured = false;
	try {
		await fs.promises.mkdir(destDir, { recursive: true });
	} catch {
		return undefined;
	}

	// report.json — top-level of tmpDir.
	const reportSrc = path.join(tmpDir, "report.json");
	try {
		await fs.promises.copyFile(reportSrc, path.join(destDir, "report.json"));
		captured = true;
	} catch {
		/* no report written */
	}

	// trace/*.jsonl — every file swival wrote (usually one <sessionId>.jsonl).
	const traceSrc = path.join(tmpDir, "trace");
	try {
		const entries = await fs.promises.readdir(traceSrc);
		if (entries.length > 0) {
			const destTrace = path.join(destDir, "trace");
			await fs.promises.mkdir(destTrace, { recursive: true });
			for (const name of entries) {
				try {
					await fs.promises.copyFile(path.join(traceSrc, name), path.join(destTrace, name));
					captured = true;
				} catch {
					/* skip unreadable entries */
				}
			}
		}
	} catch {
		/* trace dir never populated */
	}

	if (!captured) {
		// Nothing to keep; clean up the empty dir we just made.
		try {
			await fs.promises.rm(destDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		return undefined;
	}
	return destDir;
}

// ------------------------------------------------- artifact lifecycle --

/**
 * Remove artifact directories in `artifactRoot` that are older than 7 days
 * (based on directory mtime). Best-effort: individual removal failures are
 * swallowed. Called fire-and-forget at the start of every tool invocation so
 * old artifacts from heavy audit sessions don't accumulate indefinitely.
 */
export async function pruneOldArtifacts(
	artifactRoot: string = ARTIFACT_ROOT,
	maxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
): Promise<void> {
	const cutoff = Date.now() - maxAgeMs;
	let entries: string[];
	try {
		entries = await fs.promises.readdir(artifactRoot);
	} catch {
		return; // root doesn't exist yet — nothing to prune
	}
	// Fix 4: build a set of artifactDir paths for runs that are still active
	// (not yet exited) so we never prune a live run's directory.
	const activeArtifactDirs = new Set<string>();
	for (const e of asyncRuns.values()) {
		if (!e.exited) activeArtifactDirs.add(e.meta.artifactDir);
	}
	for (const name of entries) {
		const fullPath = path.join(artifactRoot, name);
		try {
			const stat = await fs.promises.stat(fullPath);
			if (!stat.isDirectory() || stat.mtimeMs >= cutoff) continue;
			// Fix 4: never prune a directory belonging to an in-flight run.
			if (activeArtifactDirs.has(fullPath)) continue;
			// Fix 4: require completed.json — a missing marker means the run is
			// still active or was interrupted before it could write its marker;
			// do not prune based on mtime alone.
			try {
				await fs.promises.access(path.join(fullPath, "completed.json"));
			} catch {
				continue;
			}
			await fs.promises.rm(fullPath, { recursive: true, force: true });
		} catch {
			/* skip unreadable or already-gone entries */
		}
	}
}

/**
 * Scan every subdirectory of `artifactRoot` for a `run-meta.json` whose
 * `runId` matches the supplied id. Used as a cross-session fallback when the
 * in-memory `asyncRuns` Map has been cleared (e.g. Pi restarted).
 *
 * O(n) over artifact dirs but acceptable: the prune pass above caps n, and
 * this is only called for control actions (status / interrupt / resume).
 */
export async function findRunMeta(runId: string, artifactRoot: string = ARTIFACT_ROOT): Promise<RunMeta | undefined> {
	let entries: string[];
	try {
		entries = await fs.promises.readdir(artifactRoot);
	} catch {
		return undefined;
	}
	for (const name of entries) {
		const metaPath = path.join(artifactRoot, name, "run-meta.json");
		try {
			try {
				const metaStat = await fs.promises.stat(metaPath);
				if (metaStat.size > 65536) continue; // 64 KB cap — legitimate meta files are < 1 KB
			} catch { continue; }
			const text = await fs.promises.readFile(metaPath, "utf-8");
			const parsed = JSON.parse(text) as Record<string, unknown>;
			// Fix 10: validate expected fields before trusting the object.
			if (
				typeof parsed.runId !== "string" ||
				typeof parsed.artifactDir !== "string" ||
				!(parsed.pid == null || typeof parsed.pid === "number")
			) continue;

			// Path containment: artifactDir must be under artifactRoot
			const resolvedArtifact = path.resolve(parsed.artifactDir as string);
			const resolvedRoot = path.resolve(artifactRoot);
			if (!resolvedArtifact.startsWith(resolvedRoot + path.sep)) continue;

			// stdoutFile and stderrFile must be under artifactDir
			if (typeof (parsed as any).stdoutFile === "string") {
				if (!path.resolve((parsed as any).stdoutFile).startsWith(resolvedArtifact + path.sep)) continue;
			}
			if (typeof (parsed as any).stderrFile === "string") {
				if (!path.resolve((parsed as any).stderrFile).startsWith(resolvedArtifact + path.sep)) continue;
			}

			// PID range: reject 0, 1, negative, and non-integer values
			if (typeof (parsed as any).pid === "number") {
				const pidVal = (parsed as any).pid;
				if (!Number.isInteger(pidVal) || pidVal < 2) continue;
			}

			const meta = parsed as unknown as RunMeta;
			if (meta.runId === runId) return meta;
		} catch {
			/* not a valid run-meta.json — skip */
		}
	}
	return undefined;
}

/**
 * Fix 8: Unified run-state loader used by all three control actions.
 *
 * Checks the in-memory `asyncRuns` Map first (fast path for same-session
 * queries). If the run is not there — or Pi was restarted — falls back to
 * scanning `run-meta.json` files on disk, then reads `completed.json` (fix 6)
 * and `spawn-error.txt` (fix 5) from the artifact dir.
 *
 * Returns `undefined` when the run cannot be found at all.
 */
async function loadRunState(runId: string): Promise<RunStateInfo | undefined> {
	// In-memory fast path.
	const entry = asyncRuns.get(runId);
	if (entry) {
		const info: RunStateInfo = {
			meta: entry.meta,
			entry,
			exited: entry.exited,
			exitCode: entry.exitCode,
		};
		// Also read completed.json when the entry says exited, so callers
		// that need the marker (e.g. resume) get it without a separate read.
		if (entry.exited) {
			try {
				const txt = await fs.promises.readFile(
					path.join(entry.meta.artifactDir, "completed.json"),
					"utf-8",
				);
				info.completed = JSON.parse(txt) as CompletedMarker;
			} catch { /* best-effort */ }
		}
		return info;
	}

	// Disk fallback: find run-meta.json, then read completed.json + spawn-error.txt.
	const meta = await findRunMeta(runId, ARTIFACT_ROOT);
	if (!meta) return undefined;

	let completed: CompletedMarker | undefined;
	try {
		const txt = await fs.promises.readFile(path.join(meta.artifactDir, "completed.json"), "utf-8");
		completed = JSON.parse(txt) as CompletedMarker;
	} catch { /* not yet written or missing */ }

	let spawnError: string | undefined;
	try {
		spawnError = await fs.promises.readFile(path.join(meta.artifactDir, "spawn-error.txt"), "utf-8");
	} catch { /* no spawn error */ }

	const exited = completed !== undefined;
	const exitCode = completed?.exitCode ?? null;
	return { meta, exited, exitCode, completed, spawnError };
}

// ------------------------------------------------ async (background) --

/**
 * Spawn a swival run in the background (detached process). Returns immediately
 * with a `runId` and the pre-created `artifactDir`. Stdout and stderr are
 * redirected to files in the artifact dir via inherited file descriptors so
 * output is preserved without holding a pipe reference.
 *
 * Only supported in single-agent mode. chain and parallel always run
 * synchronously.
 *
 * NOTE: `--goal` (swival REPL goal mode) is an interactive/REPL-only feature
 * and is NOT available via the CLI invocation used here. See README.
 */
async function runSingleSwivalAsync(
	defaultCwd: string,
	agents: SwivalAgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	overrides: SwivalOverrides,
): Promise<{ runId: string; artifactDir: string }> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		throw new Error(`Unknown swival agent: "${agentName}". Available: ${available}`);
	}
	const reviewerError = checkRequiresReviewer(agent, overrides);
	if (reviewerError) {
		throw new Error(reviewerError);
	}

	// Fix 2: use mintArtifactDir so runId includes the suffix (preventing
	// millisecond collisions) and the directory format matches persistArtifacts.
	const { artifactDir, ts, runId } = mintArtifactDir(agentName, ARTIFACT_ROOT);
	const traceDir = path.join(artifactDir, "trace");
	await fs.promises.mkdir(traceDir, { recursive: true });

	const reportPath = path.join(artifactDir, "report.json");
	const stdoutFile = path.join(artifactDir, "stdout.txt");
	const stderrFile = path.join(artifactDir, "stderr.txt");
	const runCwd = cwd ?? defaultCwd;

	const effectiveOverrides: SwivalOverrides = { ...overrides, traceDir };
	const args = buildSwivalArgs(agent, reportPath, runCwd, effectiveOverrides);
	args.push("--", task);

	// Fix 1: open fds for redirection safely. Open stdoutFd first; if
	// opening stderrFd throws, close stdoutFd before propagating. Both are
	// closed in the spawn try/finally so we never hold references that keep
	// the event loop alive.
	const stdoutFd = fs.openSync(stdoutFile, "w");
	let stderrFd: number;
	try {
		stderrFd = fs.openSync(stderrFile, "w");
	} catch (err) {
		try { fs.closeSync(stdoutFd); } catch { /* ignore */ }
		throw err;
	}
	let proc: ChildProcess;
	try {
		proc = spawn("swival", args, {
			cwd: runCwd,
			shell: false,
			stdio: ["ignore", stdoutFd, stderrFd],
			detached: true,
		});
	} finally {
		try { fs.closeSync(stdoutFd); } catch { /* ignore */ }
		try { fs.closeSync(stderrFd!); } catch { /* ignore */ }
	}
	proc.unref();

	const meta: RunMeta = {
		runId,
		agent: agentName,
		task,
		startedAt: ts,
		pid: proc.pid,
		artifactDir,
		stdoutFile,
		stderrFile,
	};
	await fs.promises.writeFile(
		path.join(artifactDir, "run-meta.json"),
		JSON.stringify(meta, null, 2),
		"utf-8",
	);

	const entry: AsyncRunEntry = { meta, proc, exited: false, exitCode: null };
	asyncRuns.set(runId, entry);

	// TTL after which we remove a completed run from the in-memory map;
	// long enough that same-session status/resume queries still work.
	const ASYNC_RUN_TTL_MS = 60 * 60 * 1000; // 1 hour

	// Fix 6: write completed.json on close so cross-session fallback can
	// determine whether the run finished without relying on process.kill probes.
	// Fix 3: schedule asyncRuns.delete after 1 h (TTL).
	proc.on("close", (code) => {
		const e = asyncRuns.get(runId);
		if (e) { e.exited = true; e.exitCode = code; }
		const marker: CompletedMarker = { exitCode: code, exitedAt: new Date().toISOString() };
		fs.promises
			.writeFile(path.join(artifactDir, "completed.json"), JSON.stringify(marker, null, 2), "utf-8")
			.catch(() => { /* best-effort */ });
		setTimeout(() => { asyncRuns.delete(runId); }, ASYNC_RUN_TTL_MS).unref?.();
	});

	// Fix 5: capture spawn errors (e.g. ENOENT when swival is not on PATH)
	// and persist them so status/resume can report the failure clearly.
	// Fix 6: also write completed.json so cross-session tools see it as done.
	// Fix 3: schedule asyncRuns.delete after TTL.
	proc.on("error", (err) => {
		const e = asyncRuns.get(runId);
		if (e) { e.exited = true; }
		fs.promises
			.writeFile(path.join(artifactDir, "spawn-error.txt"), `swival failed to start: ${err.message}`, "utf-8")
			.catch(() => { /* best-effort */ });
		const marker: CompletedMarker = { exitCode: null, exitedAt: new Date().toISOString() };
		fs.promises
			.writeFile(path.join(artifactDir, "completed.json"), JSON.stringify(marker, null, 2), "utf-8")
			.catch(() => { /* best-effort */ });
		setTimeout(() => { asyncRuns.delete(runId); }, ASYNC_RUN_TTL_MS).unref?.();
	});

	return { runId, artifactDir };
}

// ---------------------------------------------------------- run single (sync) --

async function runSingleSwival(
	defaultCwd: string,
	agents: SwivalAgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	overrides: SwivalOverrides,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SwivalResult[]) => SwivalDetails,
): Promise<SwivalResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			finalOutput: "",
			stderrTail: [`Unknown swival agent: "${agentName}". Available: ${available}`],
			durationMs: 0,
			errorMessage: `Unknown swival agent: "${agentName}"`,
		};
	}
	const reviewerError = checkRequiresReviewer(agent, overrides);
	if (reviewerError) {
		return {
			agent: agent.name,
			agentSource: agent.source,
			task,
			exitCode: 1,
			finalOutput: "",
			stderrTail: [reviewerError],
			durationMs: 0,
			errorMessage: reviewerError,
			reason: { code: "config_error", text: reviewerError },
		};
	}

	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-swival-"));
	const reportPath = path.join(tmpDir, "report.json");
	const traceDir = path.join(tmpDir, "trace");
	await fs.promises.mkdir(traceDir, { recursive: true });
	const runCwd = cwd ?? defaultCwd;

	const current: SwivalResult = {
		agent: agent.name,
		agentSource: agent.source,
		task,
		exitCode: -1,
		finalOutput: "",
		stderrTail: [],
		durationMs: 0,
		traceEvents: [],
	};

	const stderrLines: string[] = [];
	let stdoutBuf = "";
	let stderrBuf = "";

	const emit = () => {
		if (!onUpdate) return;
		const preview = current.finalOutput.trim() || stderrLines.slice(-3).join("\n") || "(running...)";
		onUpdate({
			content: [{ type: "text", text: preview }],
			details: makeDetails([current]),
		});
	};

	let emitTimer: NodeJS.Timeout | undefined;
	let emitPending = false;
	const scheduleEmit = () => {
		if (!onUpdate) return;
		emitPending = true;
		if (emitTimer) return;
		emitTimer = setTimeout(() => {
			emitTimer = undefined;
			if (!emitPending) return;
			emitPending = false;
			emit();
		}, 100);
		emitTimer.unref?.();
	};

	const stopTrace = startTraceTail(traceDir, (event) => {
		if (!current.traceEvents) current.traceEvents = [];
		// Merge tool_result results into the matching toolCall to avoid
		// doubling events; we only track the most recent pending call for a
		// name because the trace does not carry unique ids we can cheaply key
		// on from this side.
		if (event.type === "toolCall" && event.ok !== undefined) {
			for (let i = current.traceEvents.length - 1; i >= 0; i--) {
				const prev = current.traceEvents[i];
				if (prev.type === "toolCall" && prev.name === event.name && prev.ok === undefined) {
					prev.ok = event.ok;
					scheduleEmit();
					return;
				}
			}
		}
		if (current.traceEvents && current.traceEvents.length >= 1000) {
			current.traceEvents.shift();
		}
		current.traceEvents.push(event);
		scheduleEmit();
	});

	const started = Date.now();
	// Attach our internal trace-dir override only if the caller hasn't already
	// requested one (overrides.traceDir outranks us; mostly useful for tests).
	const effectiveOverrides: SwivalOverrides = { ...overrides, traceDir: overrides.traceDir ?? traceDir };
	const args = buildSwivalArgs(agent, reportPath, runCwd, effectiveOverrides);
	// `--` separates options from positional arguments. Without it, a task
	// starting with `-` or `--` would be consumed by swival's argparse as a
	// flag (argv injection). We always emit the separator; swival tolerates
	// an unused trailing `--`.
	args.push("--", task);

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("swival", args, {
				cwd: runCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			const stdoutDecoder = new TextDecoder("utf-8");
			const stderrDecoder = new TextDecoder("utf-8");

			let timeoutTimer: NodeJS.Timeout | undefined;
			let timeoutKillTimer: NodeJS.Timeout | undefined;
			const ms = effectiveOverrides.timeoutMs;
			if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
				timeoutTimer = setTimeout(() => {
					stderrLines.push(`swival timed out after ${ms}ms`);
					try { proc.kill("SIGTERM"); } catch { /* already dead */ }
					timeoutKillTimer = setTimeout(() => {
						try { proc.kill("SIGKILL"); } catch { /* already dead */ }
					}, 5000);
					timeoutKillTimer.unref?.();
				}, ms);
				timeoutTimer.unref?.();
			}

			proc.stdout.on("data", (buf: Buffer) => {
				stdoutBuf += stripAnsi(stdoutDecoder.decode(buf, { stream: true }));
				if (stdoutBuf.length > STDOUT_RING_CHARS) {
					stdoutBuf = stdoutBuf.slice(-STDOUT_RING_CHARS);
				}
				current.finalOutput = stdoutBuf;
				scheduleEmit();
			});

			proc.stderr.on("data", (buf: Buffer) => {
				stderrBuf += stripAnsi(stderrDecoder.decode(buf, { stream: true }));
				const lines = stderrBuf.split("\n");
				stderrBuf = lines.pop() ?? "";
				for (const line of lines) {
					const trimmed = line.replace(/\r$/, "");
					if (trimmed.trim().length === 0) continue;
					stderrLines.push(trimmed);
				}
				current.stderrTail = tail(stderrLines, STDERR_TAIL_LINES);
				scheduleEmit();
			});

			proc.on("close", (code, signal) => {
				if (emitTimer) { clearTimeout(emitTimer); emitTimer = undefined; }
				if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = undefined; }
				if (timeoutKillTimer) { clearTimeout(timeoutKillTimer); timeoutKillTimer = undefined; }
				stdoutBuf += stdoutDecoder.decode();
				stderrBuf += stderrDecoder.decode();
				if (stderrBuf.trim()) stderrLines.push(stderrBuf);
				if (code === null) {
					// The process exited because of a signal (typically our
					// AbortSignal → SIGTERM/SIGKILL path). Record it so the
					// failure doesn't masquerade as success when the report is
					// missing. Use the POSIX 128 + signum convention for the
					// resolved exit code so downstream consumers see a non-zero
					// value.
					const sigLabel = signal ?? "signal";
					stderrLines.push(`swival process terminated by ${sigLabel}`);
					current.stderrTail = tail(stderrLines, STDERR_TAIL_LINES);
					const signalExit = signal === "SIGKILL" ? 137 : signal === "SIGTERM" ? 143 : 1;
					resolve(signalExit);
					return;
				}
				current.stderrTail = tail(stderrLines, STDERR_TAIL_LINES);
				resolve(code);
			});

			proc.on("error", (err) => {
				if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = undefined; }
				if (timeoutKillTimer) { clearTimeout(timeoutKillTimer); timeoutKillTimer = undefined; }
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					current.errorMessage = "swival CLI not found on PATH. Install with: uv tool install swival";
				}
				stderrLines.push(`spawn error: ${err.message}`);
				current.stderrTail = tail(stderrLines, STDERR_TAIL_LINES);
				resolve(1);
			});

			if (signal) {
				const kill = () => {
					proc.kill("SIGTERM");
					// proc.killed is set synchronously by kill(), so we track
					// escalation with our own flag + listen for process exit.
					let escalated = false;
					const escalation = setTimeout(() => {
						escalated = true;
						try { proc.kill("SIGKILL"); } catch { /* already dead */ }
					}, 5000);
					proc.on("close", () => {
						if (!escalated) clearTimeout(escalation);
					});
				};
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});

		current.exitCode = exitCode;
		current.durationMs = Date.now() - started;
		current.report = await readReport(reportPath);

		// Prefer result.answer from the report JSON as the authoritative final
		// output. Swival streams the answer to stdout too, but our 256 KB stdout
		// ring-buffer (STDOUT_RING_CHARS) silently truncates long answers.
		// The report JSON carries the complete, un-truncated answer.
		if (current.report?.answer && current.report.answer.trim()) {
			current.finalOutput = current.report.answer.trim();
		} else {
			current.finalOutput = stdoutBuf.trim();
		}
		emit(); // synchronous final emit: caller must see canonical end state

		// Persist artifacts BEFORE the finally-block removes tmpDir. Callers
		// expect report.json and <session>.jsonl to outlive the run so failure
		// diagnosis has source material to point at.
		try {
			current.artifactDir = await persistArtifacts(tmpDir, agent.name);
		} catch {
			/* best-effort; skip artifact persistence on error */
		}

		// Surface the configured maxTurns (override > frontmatter). Swival's
		// built-in default is 100; we only flag explicitly-set limits.
		const configuredMaxTurns = overrides.maxTurns ?? agent.maxTurns;
		if (configuredMaxTurns !== undefined) current.effectiveMaxTurns = configuredMaxTurns;

		if (isRunFailure(current)) {
			const classified = classifyFailure(stderrLines, current.report);
			// `filter(Boolean)` here is defensive — upstream split already drops
			// whitespace-only lines before they enter stderrLines, so this can't
			// collapse multi-line errors that contain intentional blanks.
			const stderrTail = stderrLines.filter(Boolean).slice(-5).join("\n");
			if (!current.errorMessage) {
				current.errorMessage = computeErrorMessage({
					classifiedText: classified?.text,
					stderrTail,
					exitCode: current.exitCode,
					outcome: current.report?.outcome,
				});
			}
			if (classified) {
				current.reason = classified;
			} else {
				current.reason = {
					code: current.exitCode !== 0 ? "non_zero_exit" : "unknown",
					text: current.errorMessage ?? "",
				};
			}
		}
		// Success states (accepted / completed) leave `reason` undefined on
		// purpose — status + reason are orthogonal, and the failure-only shape
		// lets callers cleanly guard on `if (r.reason) { ...retry logic... }`.
		return current;
	} finally {
		// Stop tailing and flush one more time before cleanup.
		try {
			await stopTrace();
		} catch {
			/* ignore */
		}
		// Best-effort cleanup.
		try {
			await fs.promises.rm(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

// ---------------------------------------------------------- concurrency --

export async function mapWithConcurrency<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const i = nextIndex++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}

// ------------------------------------------------------- tool registry --

export const TaskItem = Type.Object(
	{
		agent: Type.String({ description: "Swival agent name" }),
		task: Type.String({ description: "Task to delegate" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the swival process" })),
		output: Type.Optional(
			Type.String({
				description:
					"File path to write this task's finalOutput to. Relative paths resolve against the task's cwd (or the tool cwd). When set, the tool-response content defaults to file-only metadata (path + size) instead of inlining the body — set outputMode=\"inline\" to also receive the body inline.",
			}),
		),
		outputMode: Type.Optional(
			StringEnum(["inline", "file-only"] as const, {
				description:
					"How to surface the task's output in the tool-response content. Default when output is set is file-only (path + size metadata, no body). Set inline to inline the body even when writing to a file. Ignored when output is not set (body is always inlined in that case).",
			}),
		),
		seed: Type.Optional(Type.Number({ description: "Override --seed for this task only." })),
	},
	{ additionalProperties: false },
);

export const ChainItem = Type.Object(
	{
		agent: Type.String({ description: "Swival agent name" }),
		task: Type.String({
			description: "Task with optional {previous} placeholder for prior step's output",
		}),
		cwd: Type.Optional(Type.String({ description: "Working directory for the swival process" })),
		seed: Type.Optional(Type.Number({ description: "Override --seed for this chain step only." })),
		output: Type.Optional(Type.String({ description: "Chain mode: file path to write this step's finalOutput to. Relative paths resolve against the step's cwd (or top-level cwd). Per-step output overrides top-level output. Defaults to file-only content unless outputMode=\"inline\"." })),
		outputMode: Type.Optional(StringEnum(["inline", "file-only"] as const, { description: "Chain mode: how to surface this step's output. Default with output is file-only; inline returns the body even when also writing to a file." })),
	},
	{ additionalProperties: false },
);

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which swival-agents directories to use. Default: "user".',
	default: "user",
});

const SwivalParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Swival agent name (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description:
				"Array of {agent, task} run sequentially; each step's task may reference '{previous}' which is replaced with the prior step's final answer.",
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the swival process (single mode)" })),

	// Dispatch-time overrides (outrank agent frontmatter).
	modelOverride: Type.Optional(
		Type.String({
			description:
				"Override the exact model for this call. Prefer profileOverride; use this only when the user explicitly requests a one-off model.",
		}),
	),
	profileOverride: Type.Optional(
		Type.String({ description: "Override the agent's named Swival profile for this call, such as fast or heavy." }),
	),
	providerOverride: Type.Optional(Type.String({ description: "Override the agent's provider for this call." })),
	baseUrlOverride: Type.Optional(
		Type.String({ description: "Override the agent's base URL for this call." }),
	),
	selfReviewOverride: Type.Optional(
		Type.Boolean({
			description:
				"Force-enable (true) or suppress (false) --self-review; cannot disable an active --reviewer script set by the agent.",
		}),
	),
	reviewerOverride: Type.Optional(
		Type.String({
			description:
				"Override --reviewer script path for this call. Mutually exclusive with selfReviewOverride=true.",
		}),
	),
	reviewPromptOverride: Type.Optional(
		Type.String({ description: "Override --review-prompt for this call." }),
	),
	maxReviewRoundsOverride: Type.Optional(
		Type.Number({ description: "Override --max-review-rounds for this call." }),
	),
	maxTurnsOverride: Type.Optional(
		Type.Number({
			description:
				"Override --max-turns for this call. Swival's default is 100 turns; lower this to bound runtime, raise for sweep-style refactors.",
		}),
	),
	maxOutputTokensOverride: Type.Optional(
		Type.Number({ description: "Override --max-output-tokens for this call." }),
	),
	temperatureOverride: Type.Optional(Type.Number({ description: "Override --temperature for this call." })),
	topPOverride: Type.Optional(Type.Number({ description: "Override --top-p for this call." })),
	seedOverride: Type.Optional(Type.Number({ description: "Override --seed for this call." })),
	reasoningEffortOverride: Type.Optional(
		Type.String({ description: "Override --reasoning-effort for this call." }),
	),
	cacheOverride: Type.Optional(Type.Boolean({ description: "Override --cache for this call." })),
	cacheDirOverride: Type.Optional(Type.String({ description: "Override --cache-dir for this call." })),
	verifyOverride: Type.Optional(
		Type.String({ description: "Override --verify acceptance criteria file for this call." }),
	),
	encryptSecretsOverride: Type.Optional(
		Type.Boolean({ description: "Override --encrypt-secrets for this call." }),
	),
	concurrency: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: MAX_CONCURRENCY,
			description: `Parallel-mode only: max concurrent tasks. Default 4, max ${MAX_CONCURRENCY}.`,
		}),
	),
	maxInlineBytes: Type.Optional(
		Type.Number({
			minimum: 1,
			description:
				"Cap (in characters) on a task's finalOutput inlined into the tool-response content. Applies to single, chain, and parallel modes. When output exceeds the cap, the response shows the first maxInlineBytes characters followed by a [truncated N chars; full output at <artifactDir>] marker. Omit (default) to inline the full output — silent truncation is never the default. To avoid token growth entirely, pass `output: \"...\"` paths instead.",
		}),
	),
	output: Type.Optional(Type.String({ description: "Single/chain mode: file path to write the run's finalOutput to. Relative paths resolve against cwd. When set, the tool-response content defaults to file-only metadata (path + size) instead of inlining the body — set outputMode=\"inline\" to also receive the body inline." })),
	outputMode: Type.Optional(StringEnum(["inline", "file-only"] as const, { description: "Single/chain mode: how to surface output in the tool-response content. Default with output is file-only; inline returns the body even when also writing to a file." })),
	timeoutMs: Type.Optional(Type.Number({ minimum: 1, description: "Wall-clock budget in milliseconds for the swival process. On expiry: SIGTERM, then SIGKILL after 5 seconds. No default; only enforced when set." })),

	// ---- async / background execution ----

	/** When true, spawn the swival process detached and return immediately with
	 *  a `runId`. Only applies to single-agent mode (agent+task). Parallel and
	 *  chain modes ignore this flag and always run synchronously. */
	async: Type.Optional(
		Type.Boolean({
			description:
				"Single mode only: spawn swival in the background and return immediately with a runId (e.g. swival-run-<timestamp>). Stdout/stderr are piped to files in the artifact dir so output is preserved. Use action:status/resume/interrupt with the returned runId to manage the run.",
		}),
	),

	/** Control action for a previously started async run. Must be paired with `id`. */
	action: Type.Optional(
		StringEnum(["status", "interrupt", "resume"] as const, {
			description:
				"Control action for an async run identified by `id`. status: check whether the run is alive or read its final report.json. interrupt: send SIGTERM to the process. resume: return the final output and reviewer feedback from a completed run.",
		}),
	),

	/** runId of the async run to query (returned by a prior async invocation). */
	id: Type.Optional(
		Type.String({
			description: "runId returned by a previous async invocation (e.g. swival-run-1716326580000). Required when action is set.",
		}),
	),
});

function buildOverridesFromParams(params: Record<string, unknown>): SwivalOverrides {
	const g = <T>(k: string): T | undefined => params[k] as T | undefined;
	return {
		model: g<string>("modelOverride"),
		profile: g<string>("profileOverride"),
		provider: g<string>("providerOverride"),
		baseUrl: g<string>("baseUrlOverride"),
		selfReview: g<boolean>("selfReviewOverride"),
		reviewer: g<string>("reviewerOverride"),
		reviewPrompt: g<string>("reviewPromptOverride"),
		maxReviewRounds: g<number>("maxReviewRoundsOverride"),
		maxTurns: g<number>("maxTurnsOverride"),
		maxOutputTokens: g<number>("maxOutputTokensOverride"),
		temperature: g<number>("temperatureOverride"),
		topP: g<number>("topPOverride"),
		seed: g<number>("seedOverride"),
		reasoningEffort: g<string>("reasoningEffortOverride"),
		cache: g<boolean>("cacheOverride"),
		cacheDir: g<string>("cacheDirOverride"),
		verify: g<string>("verifyOverride"),
		encryptSecrets: g<boolean>("encryptSecretsOverride"),
		timeoutMs: g<number>("timeoutMs"),
	};
}

/**
 * Render the terminal status of a run. Preserves four distinct success/
 * failure states so the caller can tell:
 *   - accepted:  reviewer approved (review_rounds ≥ 1, outcome=success)
 *   - completed: ran without a reviewer to natural success (review_rounds=0)
 *   - rejected:  reviewer said no (outcome=failed, exit=0)
 *   - failed:    non-zero exit (swival itself crashed or was killed)
 *   - error:     internal AgentError subclass (outcome=error)
 *
 * This is not the same as `reason.code` — a `rejected` run has
 * `reason.code = "review_rejected"`, a `failed` run may have any of
 * `provider_auth`, `non_zero_exit`, etc. Status is lifecycle; reason is
 * cause.
 */
export function renderStatus(r: SwivalResult): RunStatus {
	if (r.exitCode === -1) return "running";
	if (r.exitCode !== 0) return "failed";
	if (r.report?.outcome === "error") return "error";
	if (r.report?.outcome === "failed") return "rejected";
	if (r.report?.outcome === "success") {
		const rounds = r.report.reviewRounds ?? 0;
		return rounds > 0 ? "accepted" : "completed";
	}
	// exit=0 with no or unknown report: the run didn't fail, but we can't
	// confirm a reviewer approved it. Treat as "completed" (ran to end).
	return "completed";
}

/**
 * Backwards-compatible alias. Deprecated in favor of `renderStatus` — the
 * name implied "outcome" (the report field) but the function returns the
 * broader lifecycle state.
 */
function renderOutcome(r: SwivalResult): string {
	return renderStatus(r);
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Header meta string for a single swival result. Shape:
 *   "opus-reviewed · 3 rounds · 8 tool calls · 12.4s · accepted"
 * Pieces are omitted when the underlying stat is missing or zero.
 */
function buildHeaderMeta(r: SwivalResult): string {
	const parts: string[] = [];
	const model = r.report?.model;
	if (model) parts.push(model);
	const rounds = r.report?.reviewRounds;
	if (typeof rounds === "number" && rounds > 0) {
		parts.push(`${rounds} round${rounds === 1 ? "" : "s"}`);
	}
	const turns = r.report?.turns;
	if (typeof turns === "number" && turns > 0) {
		parts.push(`${turns} turn${turns === 1 ? "" : "s"}`);
	}
	const toolCalls = r.report?.toolCallsTotal;
	if (typeof toolCalls === "number" && toolCalls > 0) {
		parts.push(`${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`);
	}
	if (r.durationMs) parts.push(formatDuration(r.durationMs));
	parts.push(renderOutcome(r));
	return parts.join(" · ");
}

/**
 * Render the full per-task summary for parallel mode.
 *
 * Output routing (from the reviewer's feedback on the v1 patch):
 *   - r.outputPath set AND r.outputMode !== "inline": emit file-only
 *     metadata (path, line count, byte size). Body stays in the file,
 *     not in the tool-response content — saves tokens for audit-style
 *     jobs that produce 50–200 KB reports.
 *   - r.outputPath set AND r.outputMode === "inline": write to file AND
 *     inline the body (caller wants both).
 *   - no outputPath: inline the full finalOutput. No default cap; hardcoding
 *     one just reproduces the original silent-truncation defect at a bigger
 *     scale. Callers who need a hard bound set maxInlineBytes explicitly.
 *
 * Truncation is always loud: when maxInlineBytes causes a cut, the block
 * carries `[truncated N chars; full output at <artifactDir>]` so the caller
 * can read the full answer from the persisted report.
 *
 * Header shape distinguishes reviewer-approved from ran-without-reviewer:
 *   === [i] <agent> (<status>[/reason], [effTurns/]N turns) ===
 * where <status> ∈ {accepted, completed, rejected, failed, error} and
 * <reason> ∈ ReasonCode (failures only).
 *
 * Aggregate header uses neutral "M/N ok" vocabulary (not "succeeded" or
 * "accepted") because an ok batch can mix accepted + completed runs.
 */
export function buildParallelSummary(
	results: readonly SwivalResult[],
	opts: { maxInlineBytes?: number } = {},
): string {
	const cap = opts.maxInlineBytes;
	const ok = results.filter((r) => !isRunFailure(r)).length;
	const header = `swival parallel: ${ok}/${results.length} ok`;

	const blocks = results.map((r, i) => {
		const status = renderStatus(r);
		const statusLabel =
			isRunFailure(r) && r.reason ? `${status}/${r.reason.code}` : status;
		const turns = r.report?.turns;
		const maxTurns = r.effectiveMaxTurns;
		let turnsLabel = "";
		if (typeof turns === "number" && turns > 0) {
			if (typeof maxTurns === "number" && maxTurns > 0) {
				turnsLabel = `, ${turns}/${maxTurns} turns`;
			} else {
				turnsLabel = `, ${turns} turn${turns === 1 ? "" : "s"}`;
			}
		}
		const titleLine = `=== [${i}] ${r.agent} (${statusLabel}${turnsLabel}) ===`;

		const lines: string[] = [titleLine];
		if (isRunFailure(r) && r.errorMessage) {
			lines.push(`error: ${r.errorMessage.replace(/\n/g, " ").trim()}`);
		}
		if (r.artifactDir) {
			lines.push(`artifacts: ${r.artifactDir}`);
		}

		const hasOutputFile = Boolean(r.outputPath);
		const fileOnly = hasOutputFile && r.outputMode !== "inline";

		if (fileOnly) {
			const meta: string[] = [];
			if (typeof r.outputLineCount === "number")
				meta.push(`${r.outputLineCount} line${r.outputLineCount === 1 ? "" : "s"}`);
			if (typeof r.outputBytes === "number") meta.push(`${r.outputBytes} bytes`);
			const metaStr = meta.length > 0 ? ` (${meta.join(", ")})` : "";
			lines.push("");
			lines.push(`→ ${r.outputPath}${metaStr}`);
		} else if (!isRunFailure(r)) {
			if (hasOutputFile) {
				lines.push(`output file: ${r.outputPath}`);
			}
		const body = r.finalOutput ?? "";
		if (body.length > 0) {
				lines.push("");
				lines.push(applyInlineCap(body, cap, r.artifactDir ?? r.outputPath ?? "report.json"));
			}
		}
		// Failed tasks omit the finalOutput body: mid-run stdout for a
		// failed run is usually interrupted narration. The full text (if
		// any) sits in artifactDir/report.json for the caller to read.
		return lines.join("\n");
	});

	return [header, "", ...blocks].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "swival-subagent",
		label: "Swival subagent",
		description: [
			"Delegate a task to a swival subprocess with its built-in reviewer loop.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with '{previous}' substitution).",
			"Bundled agents work out of the box; override or extend via ~/.pi/agent/swival-agents/ (user) or .pi/swival-agents/ (project).",
			"Use this when you want the reviewer loop, test-as-contract, sandbox overlay, or secret encryption to wrap the subagent's work.",
		].join(" "),
		// Surface this tool in the default system prompt's "Available tools"
		// section and contribute a bullet to "Guidelines". Without
		// `promptSnippet`, Pi leaves custom tools out of the "Available tools"
		// list entirely (see pi docs/extensions.md), so the model only sees the
		// tool via its schema at invocation time.
		promptSnippet:
			"Delegate to swival with reviewer loop, AgentFS sandbox, test-as-contract, or secret encryption",
		promptGuidelines: [
			"Use swival-subagent when a task benefits from swival's reviewer loop (retry until acceptance passes), a test-as-contract script, OS-enforced filesystem isolation via AgentFS, or format-preserving secret encryption — otherwise prefer simpler tools.",
		],
		parameters: SwivalParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Prune artifact dirs older than 7 days — fire-and-forget, never blocks.
			void pruneOldArtifacts(ARTIFACT_ROOT);

			const agentScope: AgentScope = params.agentScope ?? "user";
			// Project-agent discovery must walk up from the effective working
			// directory the swival process will run in, not Pi's own cwd. In
			// single mode that is params.cwd if provided; in parallel/chain modes
			// individual steps may override per-task, but we still anchor the
			// initial discovery to the top-level params.cwd so e.g. dispatching
			// from a repo root finds agents in .pi/swival-agents/.
			const discoveryCwd = params.cwd ?? ctx.cwd;
			const discovery = discoverSwivalAgents(discoveryCwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = !process.env.PI_SWIVAL_TRUST_PROJECT_AGENTS;
			const overrides = buildOverridesFromParams(params as unknown as Record<string, unknown>);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SwivalResult[]): SwivalDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			// Fix 7a: async is only supported in single mode.
			if (params.async && ((params.chain?.length ?? 0) > 0 || (params.tasks?.length ?? 0) > 0)) {
				return {
					content: [{ type: "text", text: "`async: true` is only supported in single mode (agent + task). Remove `chain` or `tasks`, or omit `async`." }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			// Fix 7b: action is mutually exclusive with run-dispatch fields.
			if (params.action) {
				const conflicting = (["agent", "task", "tasks", "chain", "async"] as const)
					.filter((k) => params[k] != null && params[k] !== false);
				if (conflicting.length > 0) {
					return {
						content: [{ type: "text", text: `\`action\` cannot be combined with: ${conflicting.join(", ")}. Use \`action\` + \`id\` alone.` }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
			}

			// ---- control actions (status / interrupt / resume) ----
			// Fix 8: all three actions use loadRunState() for a unified lookup that
			// checks asyncRuns first, then falls back to disk (run-meta.json +
			// completed.json + spawn-error.txt). No more process.kill(pid,0) probes.
			if (params.action) {
				const runId = params.id;
				if (!runId) {
					return {
						content: [{ type: "text", text: `\`id\` is required when \`action\` is set (got action="${params.action}").` }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}

				if (params.action === "status") {
					const state = await loadRunState(runId);
					if (!state) {
						return {
							content: [{ type: "text", text: `Run ${runId} not found. It may have been pruned or was never started.` }],
							details: makeDetails("single")([]),
							isError: true,
						};
					}
					if (!state.exited) {
						return {
							content: [{ type: "text", text: `Run ${runId} is still running (pid: ${state.meta.pid ?? "unknown"}).\nArtifact dir: ${state.meta.artifactDir}` }],
							details: makeDetails("single")([]),
						};
					}
					if (state.spawnError) {
						return {
							content: [{ type: "text", text: `Run ${runId} failed to start: ${state.spawnError}\nArtifact dir: ${state.meta.artifactDir}` }],
							details: makeDetails("single")([]),
							isError: true,
						};
					}
					const report = await readReport(path.join(state.meta.artifactDir, "report.json"));
					const outcome = report?.outcome ?? "unknown";
					const exitedAt = state.completed?.exitedAt ?? "unknown";
					return {
						content: [{ type: "text", text: `Run ${runId} completed (exit ${state.exitCode ?? "?"}, outcome: ${outcome}, exitedAt: ${exitedAt}).\nArtifact dir: ${state.meta.artifactDir}` }],
						details: makeDetails("single")([]),
					};
				}

				if (params.action === "interrupt") {
					const state = await loadRunState(runId);
					if (!state || state.exited) {
						return {
							content: [{ type: "text", text: `Run ${runId} is not running (already completed or not found) — nothing to interrupt.` }],
							details: makeDetails("single")([]),
							isError: true,
						};
					}
				const pid = state.meta.pid;
				if (pid == null) {
					return {
						content: [{ type: "text", text: `Run ${runId} has no recorded PID — cannot interrupt.` }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				if (!Number.isInteger(pid) || pid < 2 || pid === process.pid) {
					return {
						content: [{ type: "text", text: `Run ${runId} has an invalid recorded PID (${pid}) — refusing to signal.` }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				// Fix 9: signal the entire process group so child processes
					// (sub-shells, nested tools) are also terminated.
					// Schedule SIGKILL escalation after 5 s in case SIGTERM is ignored.
					try {
						process.kill(-pid, "SIGTERM");
					} catch {
						return {
							content: [{ type: "text", text: `Run ${runId} is not running (pid ${pid} not found). It may have already completed.` }],
							details: makeDetails("single")([]),
							isError: true,
						};
					}
					const killTimer = setTimeout(() => {
						try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
					}, 5000);
					killTimer.unref?.();
					return {
						content: [{ type: "text", text: `Sent SIGTERM to process group of run ${runId} (pgid: ${pid}). SIGKILL escalation scheduled in 5 s.` }],
						details: makeDetails("single")([]),
					};
				}

				if (params.action === "resume") {
					const state = await loadRunState(runId);
					if (!state) {
						return {
							content: [{ type: "text", text: `Run ${runId} not found. It may have been pruned or was never started.` }],
							details: makeDetails("single")([]),
							isError: true,
						};
					}
					if (!state.exited) {
						return {
							content: [{ type: "text", text: `Run ${runId} is still in progress (pid: ${state.meta.pid ?? "unknown"}). Wait for it to complete, or interrupt it first.` }],
							details: makeDetails("single")([]),
							isError: true,
						};
					}
					if (state.spawnError) {
						return {
							content: [{ type: "text", text: `Run ${runId} failed to start: ${state.spawnError}\nArtifact dir: ${state.meta.artifactDir}` }],
							details: makeDetails("single")([]),
							isError: true,
						};
					}
					// Read final output: prefer report.result.answer, fall back to stdout file.
					const report = await readReport(path.join(state.meta.artifactDir, "report.json"));
					const stdoutContent = await fs.promises.readFile(state.meta.stdoutFile, "utf-8").catch(() => "");
					const finalOutput = (report?.answer?.trim() || stdoutContent.trim()) || "(no output)";
					const feedback = report?.lastReviewFeedback;
					const outcome = report?.outcome ?? "unknown";
					let text = `Run ${runId} (${state.meta.agent}) — outcome: ${outcome}\nArtifact dir: ${state.meta.artifactDir}\n\n${finalOutput}`;
					if (feedback) text += `\n\n─── reviewer feedback ───\n${feedback}`;
					return {
						content: [{ type: "text", text }],
						details: makeDetails("single")([]),
					};
				}
			}

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			// Default to the generic "swival" agent when task is provided without an explicit agent.
			if (!params.agent && params.task && !hasChain && !hasTasks) {
				params.agent = "swival";
			}
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode (agent+task OR tasks[] OR chain[]).\nAvailable swival agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// Project-local agent approval, mirroring pi's subagent extension.
			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents) {
				const requested = new Set<string>();
				if (params.chain) for (const s of params.chain) requested.add(s.agent);
				if (params.tasks) for (const t of params.tasks) requested.add(t.agent);
				if (params.agent) requested.add(params.agent);
				const projectRequested = Array.from(requested)
					.map((n) => agents.find((a) => a.name === n))
					.filter((a): a is SwivalAgentConfig => a?.source === "project");
				if (projectRequested.length > 0) {
					const names = projectRequested.map((a) => a.name).join(", ");
					if (!ctx.hasUI) {
						return {
							content: [{ type: "text", text: `Refusing to run project-local swival agents (${names}) without UI confirmation. Pass confirmProjectAgents: false to opt out, or invoke from an interactive session.` }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
							isError: true,
						};
					}
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local swival agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject swival agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Canceled: project-local swival agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
					}
				}
			}

			if (params.chain && params.chain.length > 0) {
				if (params.chain.length > MAX_PARALLEL_TASKS) {
					return {
						content: [
							{
								type: "text",
								text: `Too many chain steps (${params.chain.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("chain")([]),
					};
				}
				const results: SwivalResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
					// Per-step seed outranks the shared override so callers can
					// seed each step independently for reproducibility.
					const perStepOverrides: SwivalOverrides =
						step.seed !== undefined ? { ...overrides, seed: step.seed } : overrides;

					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const current = partial.details?.results[0];
								if (current) {
									const all = [...results, current];
									onUpdate({ content: partial.content, details: makeDetails("chain")(all) });
								}
							}
						: undefined;

					const r = await runSingleSwival(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						perStepOverrides,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
				results.push(r);

					if (isRunFailure(r)) {
					const stepOutput = step.output ?? params.output;
					if (stepOutput) {
						const resolveBase = step.cwd ?? params.cwd ?? ctx.cwd;
						await writeRunOutput(r, stepOutput, step.outputMode ?? params.outputMode, resolveBase);
					}
					const partial = r.finalOutput?.trim();
					const headline = `swival chain stopped at step ${i + 1} (${step.agent}): ${r.errorMessage ?? "(no message)"}`;
					const text = partial
						? `${headline}\n\n--- partial output ---\n${applyInlineCap(partial, params.maxInlineBytes, r.artifactDir)}`
						: headline;
					return {
						content: [{ type: "text", text }],
						details: makeDetails("chain")(results),
						isError: true,
					};
				}
				const isLastStep = i === params.chain.length - 1;
				const stepOutput = step.output ?? (isLastStep ? params.output : undefined);
				const stepOutputMode = step.outputMode ?? (isLastStep ? params.outputMode : undefined);
				if (stepOutput) {
					const resolveBase = step.cwd ?? params.cwd ?? ctx.cwd;
					await writeRunOutput(r, stepOutput, stepOutputMode, resolveBase);
				}
				previousOutput = r.finalOutput;
				}
			const last = results[results.length - 1];
			const fileOnly = last.outputPath && last.outputMode === "file-only";
			const contentText = fileOnly
				? `→ ${last.outputPath} (${last.outputLineCount ?? 0} lines, ${last.outputBytes ?? 0} bytes)`
				: applyInlineCap(last.finalOutput || "(no output)", params.maxInlineBytes, last.artifactDir ?? last.outputPath);
			return {
				content: [{ type: "text", text: contentText }],
				details: makeDetails("chain")(results),
			};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};
				}

				// Reject parallel dispatches where two write-capable tasks resolve to
				// the same cwd. The motivating bug: parallel `reviewed-worker` fan-out
				// on a shared worktree silently lost the second worker's edits because
				// they raced on the same filesystem. Read-only audit-style agents and
				// AgentFS sessions with their own overlay (noSandboxAutoSession=true)
				// are exempted by isMutatingCwdAgent.
				const defaultCwd = params.cwd ?? ctx.cwd;
				const cwdGroups = new Map<string, number[]>();
				for (let i = 0; i < params.tasks.length; i++) {
					const t = params.tasks[i];
					const agent = agents.find((a) => a.name === t.agent);
					if (!agent) continue; // unknown-agent diagnostics happen per-task in runSingleSwival
					if (!isMutatingCwdAgent(agent)) continue;
					const resolvedCwd = path.resolve(t.cwd ?? defaultCwd);
					const existing = cwdGroups.get(resolvedCwd) ?? [];
					existing.push(i);
					cwdGroups.set(resolvedCwd, existing);
				}
				for (const [resolvedCwd, indices] of cwdGroups) {
					if (indices.length < 2) continue;
					const preview = indices
						.map((i) => `[${i}] ${params.tasks![i].agent}`)
						.join(", ");
					return {
						content: [
							{
								type: "text",
								text:
									`Refusing to dispatch ${indices.length} write-capable tasks against the same cwd ` +
									`(${resolvedCwd}): ${preview}. Parallel filesystem writes on a shared cwd race ` +
									`and silently lose edits. Remedies: (a) dispatch them serially, (b) give each task ` +
									`its own cwd (per-task cwd field, e.g. distinct git worktrees), or (c) use an agent ` +
									`with sandbox: agentfs and noSandboxAutoSession: true so each invocation gets its ` +
									`own overlay.`,
							},
						],
						details: makeDetails("parallel")([]),
						isError: true,
					};
				}

				const placeholders: SwivalResult[] = params.tasks.map((t) => ({
					agent: t.agent,
					agentSource: "unknown",
					task: t.task,
					exitCode: -1,
					finalOutput: "",
					stderrTail: [],
					durationMs: 0,
				}));

				const emitParallel = () => {
					if (!onUpdate) return;
					const running = placeholders.filter((r) => r.exitCode === -1).length;
					const done = placeholders.length - running;
					onUpdate({
						content: [
							{
								type: "text",
								text: `swival parallel: ${done}/${placeholders.length} done, ${running} running`,
							},
						],
						details: makeDetails("parallel")([...placeholders]),
					});
				};

				const requestedConcurrency = params.concurrency ?? DEFAULT_CONCURRENCY;
				const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, requestedConcurrency));

				const results = await mapWithConcurrency(params.tasks, concurrency, async (t, idx) => {
					// Per-task seed outranks the shared override so callers can
					// seed each task independently for reproducibility.
					const perTaskOverrides: SwivalOverrides =
						t.seed !== undefined ? { ...overrides, seed: t.seed } : overrides;
					const r = await runSingleSwival(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						perTaskOverrides,
						signal,
						(partial) => {
							if (partial.details?.results[0]) {
								placeholders[idx] = partial.details.results[0];
								emitParallel();
							}
						},
						makeDetails("parallel"),
					);
				// Persist per-task output to a file when requested. The path
				// resolves relative to the task's cwd (or the tool cwd) so
				// caller-supplied relative paths behave like shell redirections.
				if (t.output) {
					const resolveBase = t.cwd ?? params.cwd ?? ctx.cwd;
					await writeRunOutput(r, t.output, t.outputMode, resolveBase);
				}
					placeholders[idx] = r;
					emitParallel();
					return r;
				});

				return {
					content: [
						{
							type: "text",
							text: buildParallelSummary(results, {
								maxInlineBytes: params.maxInlineBytes,
							}),
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			// Single mode
			// ---- async (background) path ----
			if (params.async) {
				const agentName = params.agent as string;
				const task = params.task as string;
				let runId: string;
				let artifactDir: string;
				try {
					({ runId, artifactDir } = await runSingleSwivalAsync(
						ctx.cwd,
						agents,
						agentName,
						task,
						params.cwd,
						overrides,
					));
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: `Failed to start async run: ${msg}` }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				return {
					content: [{
						type: "text",
						text: [
							`Async swival run started.`,
							`runId:        ${runId}`,
							`agent:        ${agentName}`,
							`artifactDir:  ${artifactDir}`,
							``,
							`Use action:"status" id:"${runId}" to check progress.`,
							`Use action:"resume" id:"${runId}" to retrieve the final output when done.`,
							`Use action:"interrupt" id:"${runId}" to cancel.`,
						].join("\n"),
					}],
					details: makeDetails("single")([]),
				};
			}

			// ---- synchronous path ----
			const result = await runSingleSwival(
				ctx.cwd,
				agents,
				params.agent as string,
				params.task as string,
				params.cwd,
				overrides,
				signal,
				onUpdate,
				makeDetails("single"),
			);
			const isError = isRunFailure(result);
			if (isError) {
				if (params.output) {
					await writeRunOutput(result, params.output, params.outputMode, params.cwd ?? ctx.cwd);
				}
				return {
					content: [
						{
							type: "text",
							text: `swival agent failed (exit ${result.exitCode}): ${result.errorMessage ?? "(no message)"}`,
						},
					],
					details: makeDetails("single")([result]),
					isError: true,
				};
			}
			if (params.output) {
				await writeRunOutput(result, params.output, params.outputMode, params.cwd ?? ctx.cwd);
			}
			const fileOnly = result.outputPath && result.outputMode === "file-only";
			const contentText = fileOnly
				? `→ ${result.outputPath} (${result.outputLineCount ?? 0} lines, ${result.outputBytes ?? 0} bytes)`
				: applyInlineCap(result.finalOutput || "(no output)", params.maxInlineBytes, result.artifactDir ?? result.outputPath);
			return {
				content: [{ type: "text", text: contentText }],
				details: makeDetails("single")([result]),
			};
		},

		// ---------------------------------------------------- render call --

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("swival ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const clean = step.task.replace(/\{previous\}/g, "").trim();
					const preview = clean.length > 40 ? `${clean.slice(0, 40)}...` : clean;
					text +=
						`\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("swival ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 50 ? `${t.task.slice(0, 50)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			const text =
				theme.fg("toolTitle", theme.bold("swival ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`) +
				`\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		// -------------------------------------------------- render result --

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SwivalDetails | undefined;
			if (!details || details.results.length === 0) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
			}
			const mdTheme = getMarkdownTheme();

			const renderOne = (r: SwivalResult, container: Container) => {
				const rIcon =
					r.exitCode === -1
						? theme.fg("warning", "⏳")
						: isRunFailure(r)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
				const meta = buildHeaderMeta(r);
				container.addChild(
					new Text(`${rIcon} ${theme.fg("accent", r.agent)} ${theme.fg("muted", meta)}`, 0, 0),
				);
				container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
				if (r.errorMessage) {
					container.addChild(new Text(theme.fg("error", r.errorMessage), 0, 0));
				}
				// Per-tool-call progress from trace tailing. Always show a recent
				// slice while the run is in flight so Pi's UI has something live.
				const trace = r.traceEvents ?? [];
				const toolCallEvents = trace.filter((e): e is TraceToolCall => e.type === "toolCall");
				const TRACE_PREVIEW_LIMIT = expanded ? toolCallEvents.length : 6;
				if (toolCallEvents.length > 0 && (expanded || r.exitCode === -1)) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── tool calls ───"), 0, 0));
					const shown = toolCallEvents.slice(-TRACE_PREVIEW_LIMIT);
					if (toolCallEvents.length > TRACE_PREVIEW_LIMIT) {
						container.addChild(
							new Text(theme.fg("dim", `… ${toolCallEvents.length - TRACE_PREVIEW_LIMIT} earlier calls omitted`), 0, 0),
						);
					}
					for (const ev of shown) {
						const marker =
							ev.ok === true
								? theme.fg("success", "✓ ")
								: ev.ok === false
									? theme.fg("error", "✗ ")
									: theme.fg("muted", "→ ");
						const argsStr = Object.keys(ev.args).length > 0 ? JSON.stringify(ev.args) : "";
						const preview = argsStr.length > 60 ? `${argsStr.slice(0, 60)}…` : argsStr;
						container.addChild(
							new Text(
								marker + theme.fg("accent", ev.name) + (preview ? " " + theme.fg("dim", preview) : ""),
								0,
								0,
							),
						);
					}
				}
				// On rejection, surface the last reviewer feedback so Pi's UI shows
				// why the reviewer bounced the attempt. Expanded view always shows it.
				const fb = r.report?.lastReviewFeedback;
				const showFeedback = !!fb && (expanded || r.report?.accepted === false);
				if (showFeedback && fb) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── reviewer feedback ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", fb), 0, 0));
				}
				if (expanded && r.stderrTail.length > 0) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── stderr tail ───"), 0, 0));
					for (const line of r.stderrTail) {
						container.addChild(new Text(theme.fg("dim", line), 0, 0));
					}
				}
				if (r.finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(r.finalOutput.trim(), 0, 0, mdTheme));
				}
				if (expanded) {
					const statParts: string[] = [];
					if (typeof r.report?.llmCalls === "number") statParts.push(`${r.report.llmCalls} llm calls`);
					if (typeof r.report?.totalLlmTimeS === "number")
						statParts.push(`llm ${r.report.totalLlmTimeS.toFixed(1)}s`);
					if (typeof r.report?.totalToolTimeS === "number" && r.report.totalToolTimeS > 0)
						statParts.push(`tools ${r.report.totalToolTimeS.toFixed(1)}s`);
					if (typeof r.report?.compactions === "number" && r.report.compactions > 0)
						statParts.push(`${r.report.compactions} compaction${r.report.compactions === 1 ? "" : "s"}`);
					const by = r.report?.toolCallsByName;
					if (by && Object.keys(by).length > 0) {
						const entries = Object.entries(by)
							.map(([name, v]) => {
								const ok = v.succeeded ?? 0;
								const fail = v.failed ?? 0;
								return fail > 0 ? `${name}:${ok}/${ok + fail}` : `${name}:${ok}`;
							})
							.sort();
						statParts.push(entries.join(" "));
					}
					if (statParts.length > 0) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", statParts.join(" · ")), 0, 0));
					}
				}
			};

			if (details.mode === "single") {
				const container = new Container();
				renderOne(details.results[0], container);
				return container;
			}

			if (details.mode === "chain") {
				const container = new Container();
				const ok = details.results.filter((r) => !isRunFailure(r)).length;
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const icon = running > 0 ? theme.fg("warning", "⏳") : ok === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
				container.addChild(
					new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold("swival chain "))}${theme.fg("accent", `${ok}/${details.results.length} steps`)}`,
						0,
						0,
					),
				);
				for (let i = 0; i < details.results.length; i++) {
					const r = details.results[i];
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", `─── step ${i + 1} ───`), 0, 0));
					renderOne(r, container);
				}
				return container;
			}

			// parallel
			const container = new Container();
			const running = details.results.filter((r) => r.exitCode === -1).length;
			const ok = details.results.filter((r) => !isRunFailure(r)).length;
			const isRunning = running > 0;
			const icon = isRunning
				? theme.fg("warning", "⏳")
				: ok === details.results.length
					? theme.fg("success", "✓")
					: theme.fg("warning", "◐");
			container.addChild(
				new Text(
					`${icon} ${theme.fg("toolTitle", theme.bold("swival parallel "))}${theme.fg("accent", `${ok}/${details.results.length}`)}`,
					0,
					0,
				),
			);
			for (const r of details.results) {
				container.addChild(new Spacer(1));
				renderOne(r, container);
			}
			return container;
		},
	});
}
