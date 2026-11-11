/**
 * Cross-module data contracts and shared limits for pi-swival.
 *
 * Every launch, run-handle, report, and native-evidence shape is defined here
 * once so the CLI planner, process owner, artifact layer, renderer, and native
 * audit boundary never re-declare or re-parse each other's types.
 */

import type { ChildProcess } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AsyncObservationAdapter } from "./async-observation.js";
import type { AgentDiscoveryDiagnostic, AgentScope, AgentSource, SwivalAgentConfig } from "./agents.js";

// ------------------------------------------------------------- limits --

/** Maximum array size of tasks[] and chain[] params. */
export const MAX_PARALLEL_TASKS = 8;
export const DEFAULT_CONCURRENCY = 4;
/** Maximum worker pool size used by mapWithConcurrency. */
export const MAX_CONCURRENCY = 8;
/** Stderr lines surfaced in results and progress updates. */
export const STDERR_TAIL_LINES = 30;
/** Sliding window kept for failure classification (covers its 50-line tail). */
export const MAX_STDERR_BUFFER_LINES = 64;
/** Ring-buffer cap for stdout accumulation in UTF-16 code units. */
export const STDOUT_RING_CHARS = 256 * 1024;
export const TRACE_EVENT_RING_LIMIT = 1000;
/** Tool-use id -> name map bound inside startTraceTail. */
export const TRACE_TOOL_MAP_LIMIT = 2048;
export const REPORT_MAX_BYTES = 16 * 1024 * 1024;

export const RECOMMENDED_SWIVAL_VERSION = "1.9.3";
export const MIN_COMPATIBLE_SWIVAL_VERSION = "1.0.44";
export const MIN_AGENTFS_VERSION = "0.6.4";
/** Exact upstream versions whose private state the native audit path reads or patches. */
export const NATIVE_COMPATIBILITY_MANIFEST = Object.freeze({ swival: "1.9.3", litellm: "1.106.6" });

/** Tool parameters the native audit path accepts; every other parameter is refused before preflight. */
export const NATIVE_PARAM_NAMES: ReadonlySet<string> = new Set([
	"audit", "async", "timeoutMs", "maxInlineBytes",
	"providerOverride", "profileOverride", "modelOverride", "temperatureOverride", "topPOverride", "seedOverride",
	"reasoningEffortOverride", "maxOutputTokensOverride", "maxTurnsOverride", "providerTimeoutOverride", "encryptSecretsOverride",
]);
export const NATIVE_MAX_ENTRIES = 4096;
export const NATIVE_FILE_LIMIT = 8 * 1024 * 1024;
export const NATIVE_TOTAL_LIMIT = 64 * 1024 * 1024;

const EXTENSION_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPT_ROOT = path.resolve(EXTENSION_ROOT, "../scripts");
/** Artifacts are copied here before the per-run temp dir is deleted. */
export const ARTIFACT_ROOT = path.join(os.homedir(), ".pi", "agent", "swival-artifacts");
export const ASYNC_RUNNER_PATH = path.join(SCRIPT_ROOT, "async-runner.cjs");
export const ANTHROPIC_OAUTH_SHIM_DIR = path.join(SCRIPT_ROOT, "anthropic_oauth_shim");

// ---------------------------------------------------------- run meta --

/**
 * Metadata written to `<artifactDir>/run-meta.json`. Async runs persist the
 * full record so `status` and `resume` work after Pi restarts; synchronous
 * runs persist a minimal record with `sync: true` so retention can prune
 * them without exposing them to async controls or observation.
 */
export interface RunMeta {
	/** UUID owns the run. The optional file is only a consumer compatibility hint. */
	ownerSessionId?: string;
	ownerSessionFile?: string;
	runId: string;
	agent: string;
	task: string;
	startedAt: number;
	/** PID of the durable async wrapper and its process group. Interrupt uses it
	 *  only while the same Pi process still holds the matching ChildProcess. */
	pid: number | undefined;
	artifactDir: string;
	stdoutFile: string;
	stderrFile: string;
	agentFsRequested?: boolean;
	nonoRequested?: boolean;
	nativeAuditRequested?: boolean;
	effectiveProviderTimeout?: EffectiveProviderTimeout;
	/** Present and true only for synchronous run artifacts persisted for retention. */
	sync?: boolean;
}

/** Written to `<artifactDir>/completed.json` when a run exits (or fails to start). */
export interface CompletedMarker {
	exitCode: number | null;
	exitedAt: string; // ISO 8601
}

export type AsyncScratch = { readonly path: string; readonly dev: number; readonly ino: number };

/** A run this Pi process spawned and still holds; the only source of signalling authority. */
export interface LiveRunHandle {
	readonly kind: "live";
	readonly meta: RunMeta;
	readonly proc: ChildProcess;
	/** Live cleanup lease only; never persisted or accepted from control callers. */
	readonly scratch?: AsyncScratch;
	exited: boolean;
	exitCode: number | null;
	completed?: CompletedMarker;
}

/** Disk metadata only. Its recorded PID is never probed or signalled. */
export interface RecoveredRun {
	readonly kind: "recovered";
	readonly meta: RunMeta;
	readonly exited: boolean;
	readonly exitCode: number | null;
	readonly completed?: CompletedMarker;
	/** Contents of spawn-error.txt when swival failed to start (e.g. ENOENT). */
	readonly spawnError?: string;
}

export type AsyncRunState = LiveRunHandle | RecoveredRun;

// -------------------------------------------------------- CLI planning --

export interface EffectiveProviderTimeout {
	seconds: number | null;
	source: string;
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
	instructionsFull?: boolean;
	network?: "full" | "provider-only" | "none";
	nonoRollback?: boolean;
	nonoBlockNet?: boolean;
	commandMiddleware?: string;
	maxOutputKb?: number;
	maxOutputLines?: number;
	skillsDir?: string[];
	shareSkills?: boolean;
	subagents?: boolean;
	timeoutMs?: number;
	a2aConfig?: string;
	providerTimeout?: number;
	initialToolChoice?: "auto" | "required";
	addDir?: string[];
	addDirRo?: string[];
	installedSwivalVersion?: string;
}

export class SwivalArgumentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SwivalArgumentError";
	}
}

export type SwivalOptionKind = "string" | "number" | "boolean" | "enum" | "stringArray";

export interface SwivalOptionOverride {
	readonly key: keyof SwivalOverrides & string;
	readonly param: string;
	readonly description: string;
	/** Integer-constrained TypeBox schema (minimum 1) instead of a plain number. */
	readonly integer?: boolean;
}

export interface SwivalOptionDescriptor {
	readonly key: keyof SwivalAgentConfig & string;
	readonly kind: SwivalOptionKind;
	readonly enumValues?: readonly string[];
	/** Swival CLI flag emitted for this field. */
	readonly cliFlag?: string;
	/** True when buildSwivalArgs emits this flag directly without cross-field policy checks. */
	readonly autoEmit?: boolean;
	/** Dispatch-time override that outranks frontmatter for one call. */
	readonly override?: SwivalOptionOverride;
}

const option = (descriptor: SwivalOptionDescriptor) => descriptor;

export const SWIVAL_OPTION_DESCRIPTORS: readonly SwivalOptionDescriptor[] = [
	// Provider / model routing
	option({ key: "provider", kind: "string", cliFlag: "--provider", autoEmit: true,
		override: { key: "provider", param: "providerOverride", description: "Override the agent's provider for this call." } }),
	option({ key: "profile", kind: "string", cliFlag: "--profile", autoEmit: true,
		override: { key: "profile", param: "profileOverride", description: "Override the agent's named Swival profile for this call, such as budget or frontier." } }),
	option({ key: "model", kind: "string", cliFlag: "--model", autoEmit: true,
		override: { key: "model", param: "modelOverride", description: "Override the exact model for this call. Prefer profileOverride; use this only when the user explicitly requests a one-off model." } }),
	option({ key: "baseUrl", kind: "string", cliFlag: "--base-url", autoEmit: true,
		override: { key: "baseUrl", param: "baseUrlOverride", description: "Override the agent's base URL for this call." } }),
	option({ key: "temperature", kind: "number", cliFlag: "--temperature", autoEmit: true,
		override: { key: "temperature", param: "temperatureOverride", description: "Override --temperature for this call." } }),
	option({ key: "topP", kind: "number", cliFlag: "--top-p", autoEmit: true,
		override: { key: "topP", param: "topPOverride", description: "Override --top-p for this call." } }),
	option({ key: "seed", kind: "number", cliFlag: "--seed", autoEmit: true,
		override: { key: "seed", param: "seedOverride", description: "Override --seed for this call." } }),
	option({ key: "reasoningEffort", kind: "string", cliFlag: "--reasoning-effort", autoEmit: true,
		override: { key: "reasoningEffort", param: "reasoningEffortOverride", description: "Override --reasoning-effort for this call." } }),
	option({ key: "maxOutputTokens", kind: "number", cliFlag: "--max-output-tokens", autoEmit: true,
		override: { key: "maxOutputTokens", param: "maxOutputTokensOverride", description: "Override --max-output-tokens for this call." } }),
	option({ key: "maxTurns", kind: "number", cliFlag: "--max-turns", autoEmit: true,
		override: { key: "maxTurns", param: "maxTurnsOverride", description: "Override --max-turns for this call. Swival's default is 100 turns; lower this to bound runtime, raise for sweep-style refactors." } }),
	option({ key: "providerTimeout", kind: "number", cliFlag: "--provider-timeout", autoEmit: true,
		override: { key: "providerTimeout", param: "providerTimeoutOverride", description: "Override --provider-timeout (seconds) for this call. Swival's default is 900." } }),
	option({ key: "initialToolChoice", kind: "enum", enumValues: ["auto", "required"], cliFlag: "--initial-tool-choice", autoEmit: true,
		override: { key: "initialToolChoice", param: "initialToolChoiceOverride", description: "Override --initial-tool-choice for this call. Swival's default is auto." } }),

	// Reviewer loop
	option({ key: "selfReview", kind: "boolean", cliFlag: "--self-review", autoEmit: true,
		override: { key: "selfReview", param: "selfReviewOverride", description: "Force-enable (true) or suppress (false) --self-review; cannot disable an active --reviewer script set by the agent." } }),
	option({ key: "reviewer", kind: "string", cliFlag: "--reviewer", autoEmit: true,
		override: { key: "reviewer", param: "reviewerOverride", description: "Override --reviewer script path for this call. Mutually exclusive with selfReviewOverride=true." } }),
	option({ key: "reviewPrompt", kind: "string", cliFlag: "--review-prompt", autoEmit: true,
		override: { key: "reviewPrompt", param: "reviewPromptOverride", description: "Override --review-prompt for this call." } }),
	option({ key: "verify", kind: "string", cliFlag: "--verify", autoEmit: true,
		override: { key: "verify", param: "verifyOverride", description: "Override --verify acceptance criteria file for this call." } }),
	option({ key: "maxReviewRounds", kind: "number", cliFlag: "--max-review-rounds", autoEmit: true,
		override: { key: "maxReviewRounds", param: "maxReviewRoundsOverride", description: "Override --max-review-rounds for this call." } }),
	option({ key: "requiresReviewer", kind: "boolean" }),

	// Filesystem / commands
	option({ key: "sandbox", kind: "enum", enumValues: ["builtin", "agentfs", "nono"], cliFlag: "--sandbox" }),
	option({ key: "sandboxSession", kind: "string", cliFlag: "--sandbox-session", autoEmit: true }),
	option({ key: "sandboxStrictRead", kind: "boolean", cliFlag: "--sandbox-strict-read", autoEmit: true }),
	option({ key: "noSandboxAutoSession", kind: "boolean", cliFlag: "--no-sandbox-auto-session", autoEmit: true }),
	option({ key: "nonoProfile", kind: "string", cliFlag: "--nono-profile", autoEmit: true }),
	option({ key: "nonoRollback", kind: "boolean", cliFlag: "--nono-rollback", autoEmit: true,
		override: { key: "nonoRollback", param: "nonoRollbackOverride", description: "Override nono rollback snapshots." } }),
	option({ key: "nonoBlockNet", kind: "boolean", cliFlag: "--nono-block-net", autoEmit: true,
		override: { key: "nonoBlockNet", param: "nonoBlockNetOverride", description: "Block all outbound network in nono sandbox." } }),
	option({ key: "nonoAllowDomain", kind: "stringArray", cliFlag: "--nono-allow-domain", autoEmit: true }),
	option({ key: "network", kind: "enum", enumValues: ["full", "provider-only", "none"], cliFlag: "--network", autoEmit: true,
		override: { key: "network", param: "networkOverride", description: "Override network policy: full, provider-only, or none." } }),
	option({ key: "files", kind: "enum", enumValues: ["none", "some", "all"], cliFlag: "--files" }),
	option({ key: "commands", kind: "string", cliFlag: "--commands" }),
	option({ key: "commandMiddleware", kind: "string", cliFlag: "--command-middleware", autoEmit: true,
		override: { key: "commandMiddleware", param: "commandMiddlewareOverride", description: "Command run before each tool command (JSON on stdin -> allow/deny/rewrite)." } }),
	option({ key: "baseDir", kind: "string", cliFlag: "--base-dir" }),
	option({ key: "addDir", kind: "stringArray", cliFlag: "--add-dir",
		override: { key: "addDir", param: "addDirOverride", description: "Single mode only: additional read-write directories to grant via --add-dir for this call (outranks agent addDir)." } }),
	option({ key: "addDirRo", kind: "stringArray", cliFlag: "--add-dir-ro",
		override: { key: "addDirRo", param: "addDirRoOverride", description: "Additional read-only directories to grant via --add-dir-ro for this call (outranks agent addDirRo)." } }),
	option({ key: "encryptSecrets", kind: "boolean", cliFlag: "--encrypt-secrets", autoEmit: true,
		override: { key: "encryptSecrets", param: "encryptSecretsOverride", description: "Override --encrypt-secrets for this call." } }),
	option({ key: "noReadGuard", kind: "boolean", cliFlag: "--no-read-guard", autoEmit: true }),
	option({ key: "yolo", kind: "boolean", cliFlag: "--yolo" }),

	// Prompt / memory
	option({ key: "instructionsFull", kind: "boolean", cliFlag: "--instructions-full",
		override: { key: "instructionsFull", param: "instructionsFullOverride", description: "Opt in to loading complete AGENTS.md/CLAUDE.md instruction files without truncation. When true, passes --instructions-full and suppresses --no-instructions." } }),
	option({ key: "noInstructions", kind: "boolean", cliFlag: "--no-instructions" }),
	option({ key: "noMemory", kind: "boolean", cliFlag: "--no-memory" }),
	option({ key: "noSkills", kind: "boolean", cliFlag: "--no-skills" }),
	option({ key: "skillsDir", kind: "stringArray", cliFlag: "--skills-dir",
		override: { key: "skillsDir", param: "skillsDirOverride", description: "Additional directories to scan for Swival skills." } }),

	// Output budgeting
	option({ key: "maxOutputKb", kind: "number", cliFlag: "--max-output-kb",
		override: { key: "maxOutputKb", param: "maxOutputKbOverride", integer: true, description: "Size cap in KB for tool output sent to the model (default 50)." } }),
	option({ key: "maxOutputLines", kind: "number", cliFlag: "--max-output-lines",
		override: { key: "maxOutputLines", param: "maxOutputLinesOverride", integer: true, description: "Default number of lines returned by file reads (default 2000)." } }),

	// Caching
	option({ key: "cache", kind: "boolean", cliFlag: "--cache", autoEmit: true,
		override: { key: "cache", param: "cacheOverride", description: "Override --cache for this call." } }),
	option({ key: "cacheDir", kind: "string", cliFlag: "--cache-dir", autoEmit: true,
		override: { key: "cacheDir", param: "cacheDirOverride", description: "Override --cache-dir for this call." } }),

	// Context-management / retries
	option({ key: "proactiveSummaries", kind: "boolean", cliFlag: "--proactive-summaries", autoEmit: true }),
	option({ key: "retries", kind: "number", cliFlag: "--retries", autoEmit: true }),

	// A2A (agent-to-agent) client configuration
	option({ key: "a2aConfig", kind: "string", cliFlag: "--a2a-config",
		override: { key: "a2aConfig", param: "a2aConfigOverride", description: "Path to an A2A TOML config file with [a2a_servers.*] tables for this call. Relative paths resolve against cwd. Suppresses --no-a2a and requires networkOverride/network=full (or omitted, which defaults to full)." } }),
	option({ key: "allowA2a", kind: "boolean" }),

	// Nested-invocation hygiene (default true for all — see buildSwivalArgs)
	option({ key: "noLifecycle", kind: "boolean", cliFlag: "--no-lifecycle" }),
	option({ key: "noMcp", kind: "boolean", cliFlag: "--no-mcp" }),
	option({ key: "noA2a", kind: "boolean", cliFlag: "--no-a2a" }),
	option({ key: "noWebSearch", kind: "boolean", cliFlag: "--no-web-search" }),
	option({ key: "noHistory", kind: "boolean", cliFlag: "--no-history" }),
	option({ key: "noContinue", kind: "boolean", cliFlag: "--no-continue" }),
	option({ key: "noSubagents", kind: "boolean", cliFlag: "--no-subagents" }),
	option({ key: "subagents", kind: "boolean", cliFlag: "--subagents",
		override: { key: "subagents", param: "subagentsOverride", description: "Explicitly allow Swival to spawn native subagents (spawn_subagent/check_subagents)." } }),

	// Output control and escape hatch
	option({ key: "quiet", kind: "boolean", cliFlag: "-q" }),
	option({ key: "extraArgs", kind: "stringArray" }),
];

/** Every CLI flag that consumes a following value, so argv readers never mistake a value for a flag. */
export const VALUE_CLI_FLAGS: ReadonlySet<string> = new Set([
	...SWIVAL_OPTION_DESCRIPTORS.filter((d) => d.cliFlag && d.kind !== "boolean").map((d) => d.cliFlag!),
	"--report", "--trace-dir", "--system-prompt", "--gcp-project", "--location",
]);

export interface CliOptionEntry {
	readonly flag: string;
	readonly value?: string;
	readonly dangling?: boolean;
}

/** Walk emitted argv up to `--`, consuming values of value-carrying flags so a value can never masquerade as a flag. */
export function cliOptionEntries(args: readonly string[]): CliOptionEntry[] {
	const entries: CliOptionEntry[] = [];
	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (token === "--") break;
		if (!token.startsWith("-")) continue;
		const eq = token.indexOf("=");
		if (token.startsWith("--") && eq !== -1) {
			entries.push({ flag: token.slice(0, eq), value: token.slice(eq + 1) });
			continue;
		}
		if (VALUE_CLI_FLAGS.has(token)) {
			const next = args[i + 1];
			if (next === undefined || next === "--") entries.push({ flag: token, dangling: true });
			else { entries.push({ flag: token, value: next }); i++; }
			continue;
		}
		entries.push({ flag: token });
	}
	return entries;
}

export function hasCliFlag(args: readonly string[], flag: string): boolean {
	return cliOptionEntries(args).some((entry) => entry.flag === flag && entry.value === undefined && !entry.dangling);
}

export function lastCliOptionValue(args: readonly string[], option: string): string | undefined {
	let value: string | undefined;
	for (const entry of cliOptionEntries(args)) if (entry.flag === option) value = entry.value;
	return value;
}

export function allCliOptionValues(args: readonly string[], option: string): string[] {
	return cliOptionEntries(args).filter((entry) => entry.flag === option && entry.value !== undefined).map((entry) => entry.value!);
}

/** Structured launch state resolved once by planSwivalLaunch and consumed by spawners. */
export interface LaunchPlan {
	readonly executable: string;
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly baseDir: string;
	readonly taskTransport: "argv" | "stdin";
	readonly stdinPayload?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly route: {
		readonly provider?: string;
		readonly profile?: string;
		readonly model?: string;
		readonly baseUrl?: string;
		readonly externalReviewer?: string;
	};
	readonly sandbox: {
		readonly mode?: string;
		readonly agentFsRequested: boolean;
		readonly nonoRequested: boolean;
		readonly reexecPossible: boolean;
	};
	readonly effectiveProviderTimeout: EffectiveProviderTimeout;
	readonly effectiveMaxTurns?: number;
	readonly timeoutMs?: number;
}

export interface SwivalVersionCheck {
	installedVersion?: string;
	recommendedVersion: string;
	minCompatibleVersion: string;
	isOutdated: boolean;
	isIncompatible: boolean;
	advisoryMessage?: string;
	errorMessage?: string;
}

// ------------------------------------------------------------ reports --

/**
 * Subset of the swival `--report` JSON schema (version 1) that we surface.
 * Unknown / missing fields are tolerated; consumers must null-check.
 */
export interface ReportSummary {
	reviewRounds?: number;
	outcome?: "success" | "failed" | "error" | "interrupted" | "exhausted" | "unknown";
	accepted?: boolean;
	errorMessage?: string;
	turns?: number;
	toolCallsTotal?: number;
	toolCallsByName?: Record<string, { succeeded?: number; failed?: number }>;
	totalLlmTimeS?: number;
	totalToolTimeS?: number;
	llmCalls?: number;
	compactions?: number;
	estimatedCostUsd?: number;
	lastReviewFeedback?: string;
	answer?: string;
	model?: string;
	provider?: string;
	/** `mode` is written from argv and proves nothing; `agentfsVersion` / `nonoVersion`
	 *  are re-exec-only evidence that the sandbox actually engaged. */
	sandbox?: {
		mode?: string;
		agentfsVersion?: string;
		diffHint?: string;
		nonoVersion?: string;
		nonoProfile?: string;
		nonoRollback?: boolean;
	};
	network?: string;
	promptCache?: { cachedTokens?: number; cacheWriteTokens?: number };
	security?: { commandPolicyBlocks?: number; commandPolicyApprovals?: number; untrustedInputs?: number };
	stormedCalls?: number;
	truncationRepairs?: number;
	exposure?: {
		toolResults?: number;
		toolSchemas?: number;
		history?: number;
		summaries?: number;
		totalEstimatedInputTokens?: number;
	};
	providerTimeout?: number;
	initialToolChoice?: "auto" | "required";
	raw?: Record<string, unknown>;
}

export interface TraceToolCall {
	type: "toolCall";
	name: string;
	args: Record<string, unknown>;
	sessionId?: string;
	toolUseId?: string;
	ok?: boolean; // set when a matching tool_result arrives
}
export interface TraceText {
	type: "text";
	text: string;
}
export type TraceEvent = TraceToolCall | TraceText;

/** Short, stable machine code describing why a run failed. */
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

/** Terminal lifecycle state of a run; orthogonal to ReasonCode. */
export type RunStatus = "running" | "accepted" | "completed" | "rejected" | "failed" | "error";

export interface FailureReason {
	code: ReasonCode;
	text: string;
}

export interface SwivalResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	exitCode: number; // -1 still running, 0 ok, >0 failure
	finalOutput: string;
	stderrTail: string[];
	durationMs: number;
	report?: ReportSummary;
	nativeAudit?: NativeAuditResult;
	errorMessage?: string;
	/** Populated only on failure. */
	reason?: FailureReason;
	traceEvents?: TraceEvent[];
	artifactDir?: string;
	effectiveMaxTurns?: number;
	versionAdvisory?: string;
	outputPath?: string;
	outputMode?: "inline" | "file-only";
	outputBytes?: number;
	outputLineCount?: number;
}

export interface SwivalDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SwivalResult[];
	diagnostics?: AgentDiscoveryDiagnostic[];
	diagnosticsTotal?: number;
	diagnosticsOmitted?: number;
}

export interface SwivalExtensionOptions {
	artifactRoot?: string;
	trustProjectAgents?: boolean;
	observationAdapter?: AsyncObservationAdapter;
	onObservationDiagnostic?(message: string): void;
	nativePython?: string;
	nativeMaxTimeoutMs?: number;
}

// ------------------------------------------------------- native audit --

export interface NativeAuditOptions {
	paths: string[];
	all: boolean;
	workers: number;
	patchMaxTurns: number;
}

export interface NativeAuthStore { directory: string; filename: string }

export interface NativeRoute {
	version: 2;
	runtime: { swival: string; litellm: string };
	provider: string;
	model: string;
	endpoint: string | null;
	profile: string | null;
	reasoningEffort: string | null;
	options: Record<string, number | null>;
	selection: { profileSource: "active" | "explicit" | null; explicitFields: string[] };
	reportIdentity: { provider: string; model: string };
	project?: string;
	location?: string;
}

export interface NativeRuntime {
	python?: string;
	cli?: string;
	agentfs?: string;
	nono?: string;
	git?: string;
	searchPath?: string;
	environment?: NodeJS.ProcessEnv;
}

export interface TrustedGit { executable: string; env: NodeJS.ProcessEnv }

export interface SnapshotIdentity {
	sourceRoot: string;
	sourceGitDir: string;
	sourceWorktreeGitDir: string;
	sourceCommit: string;
	sourceTree: string;
	snapshotCommit: string;
	/** Every tracked leaf path in HEAD^{tree}, including accepted 120000 directory aliases. */
	committedEntries: string[];
	/** Regular files written into the snapshot working copy (excludes 120000 aliases). */
	materializedFiles: string[];
}

export interface SnapshotManifest extends SnapshotIdentity {
	/** Compatibility alias of materializedFiles for existing snapshot consumers. */
	files: string[];
	excluded: string;
}

export interface NativeTerminal {
	exitCode: number;
	exitedAt: string;
	shutdown: "not-started" | "verified" | "unverified";
	boundary?: "agentfs-cli";
	stopped?: string;
	shutdownFailure?: string;
	preservationFailure?: string;
	cleanupFailure?: string;
	persistenceFailure?: string;
	retainedResources?: string[];
}

export interface NativeOwnership {
	/** Live child process-group authority only. Never reconstruct it from disk. */
	signal: (signal: NodeJS.Signals | 0) => unknown;
	verify: () => Promise<boolean>;
}

export interface NativeAuditLaunch {
	route: NativeRoute;
	meta: RunMeta;
	proc: ChildProcess;
	completion: Promise<NativeTerminal>;
	cancel: (reason?: string) => void;
}

export interface NativeAuditResult {
	route?: NativeRoute;
	status: "completed" | "failed" | "partial" | "empty_scope";
	answer?: string;
	error?: string;
	statePath?: string;
}
