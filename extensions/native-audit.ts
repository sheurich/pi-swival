/**
 * Native audit orchestration: parameter admission, CLI and AgentFS argument
 * construction, host credential bridging, preparation of the isolated run,
 * live process-group ownership with diagnostic collection, and fail-closed
 * finalization that exports evidence only after verified shutdown.
 *
 * Trust-boundary primitives live in native-boundary.ts and evidence judgment
 * in native-inspect.ts; both are re-exported here for native callers.
 */

import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	ANTHROPIC_OAUTH_SHIM_DIR,
	MIN_AGENTFS_VERSION,
	NATIVE_FILE_LIMIT,
	NATIVE_MAX_ENTRIES,
	NATIVE_PARAM_NAMES,
	NATIVE_TOTAL_LIMIT,
	SCRIPT_ROOT,
	type NativeAuditLaunch,
	type NativeAuditOptions,
	type NativeOwnership,
	type NativeRoute,
	type NativeRuntime,
	type NativeTerminal,
	type RunMeta,
} from "./contracts.js";
import {
	agentfsDarwinWriteRoots,
	assertNativeSourceIsolation,
	assertTrustedRuntimePath,
	boundedExec,
	canonicalRuntimePath,
	createCommittedSnapshot,
	prepareNativeAuthStore,
	resolveTrustedCredentialState,
	resolveTrustedGit,
	sourceIdentity,
} from "./native-boundary.js";
import { checkedPath, isPlainRecord, parseNativePreflight, readNativeTerminal, regularBytes, validTerminal } from "./native-inspect.js";
import { canonicalFuturePath, compareSemver, parseSemver, pathIsWithin, readAnthropicAuthToken } from "./paths.js";

export type {
	NativeAuditLaunch, NativeAuditOptions, NativeAuditResult, NativeAuthStore, NativeOwnership, NativeRoute, NativeRuntime,
	NativeTerminal, SnapshotIdentity, SnapshotManifest, TrustedGit,
} from "./contracts.js";
export {
	agentfsDarwinWriteRoots, assertNativeSourceIsolation, boundedExec, captureNativeRuntime, createCommittedSnapshot,
	gitEnvironment, parseCatFileBatch, prepareNativeAuthStore, resolveTrustedGit, sourceIdentity,
} from "./native-boundary.js";
export { inspectNativeAudit, nativeFindingKey, parseNativePreflight, parseNativeRoute, readNativeTerminal, regularBytes } from "./native-inspect.js";

const NATIVE_AUDIT_SCRIPT = path.join(SCRIPT_ROOT, "native_audit.py");
const DIAGNOSTICS_LIMIT = 2 * 1024 * 1024;
const ADJUDICATION_ERROR_SENTINEL = "PI_SWIVAL_ADJUDICATION_ERROR";
const SHIM_INSTALL_FAILED_SENTINEL = "PI_SWIVAL_SHIM_INSTALL_FAILED";
const CREDENTIAL_EXPIRED_SENTINEL = "PI_SWIVAL_CREDENTIAL_EXPIRED";
const credentialUnavailable = () => new Error("Native audit configuration preflight failed: Selected provider credential is unavailable; no fallback. No native worker/provider was started.");

// --------------------------------------------------------- parameters --

export function validateNativeAuditParams(params: Record<string, unknown>): NativeAuditOptions {
	if (params.async === true) throw new Error("Native async is unsupported; native audits are synchronous.");
	for (const key of Object.keys(params)) {
		if (!NATIVE_PARAM_NAMES.has(key)) throw new Error(`Native audit cannot be combined with ${key}.`);
	}
	if (params.encryptSecretsOverride !== undefined && params.encryptSecretsOverride !== false) {
		throw new Error("Native audit cannot be combined with encryptSecretsOverride unless false.");
	}
	const audit = params.audit;
	if (!audit || typeof audit !== "object" || Array.isArray(audit)) throw new Error("Native audit requires an audit object.");
	const input = audit as Record<string, unknown>;
	for (const key of Object.keys(input)) {
		if (!["paths", "all", "workers", "patchMaxTurns"].includes(key)) throw new Error(`Unknown audit.${key} option.`);
	}
	const paths = input.paths ?? [];
	if (!Array.isArray(paths) || paths.length > 64) throw new Error("audit.paths must contain at most 64 path tokens.");
	for (const token of paths) {
		if (typeof token !== "string" || !token || token.length > 256 ||
			!/^[\p{L}\p{N}_.*?\[\]/-]+$/u.test(token) || token.startsWith("/") || token.startsWith("-") ||
			token.split("/").some((part: string, i: number, parts: string[]) => part === "." || part === ".." ||
				(part === "" && i !== parts.length - 1))) {
			throw new Error("Native audit paths must be relative, single path/glob tokens without traversal or command syntax.");
		}
	}
	const integer = (key: string, fallback: number, max: number) => {
		const value = input[key] ?? fallback;
		if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
			throw new Error(`audit.${key} must be an integer from 1 to ${max}.`);
		}
		return value as number;
	};
	if (input.all !== undefined && typeof input.all !== "boolean") throw new Error("audit.all must be boolean.");
	return { paths: [...new Set(paths)], all: input.all === true, workers: integer("workers", 4, 8),
		patchMaxTurns: integer("patchMaxTurns", 50, 100) };
}

export function buildNativeAuditArgs(snapshot: string, route: Record<string, any>, audit: NativeAuditOptions): string[] {
	const args = ["--base-dir", snapshot, "--sandbox", "builtin", "--network", "provider-only",
		"--commands", "none", "--files", "some", "--oneshot-commands",
		"--no-sandbox-auto-session", "--no-instructions", "--no-skills", "--no-metaskills", "--no-mcp",
		"--no-a2a", "--no-subagents", "--no-lifecycle", "--no-history", "--no-continue", "--no-memory",
		"--no-web-search", "--no-model-routing", "--no-decisions",
		"--provider", route.provider, "--model", route.model, "--report", path.join(snapshot, "native-cli-report.json")];
	if (route.endpoint != null) args.push("--base-url", route.endpoint);
	if (route.provider === "geap") args.push("--gcp-project", route.project, "--location", route.location);
	if (route.reasoningEffort != null) args.push("--reasoning-effort", route.reasoningEffort);
	for (const [key, value] of Object.entries(route.options ?? {})) {
		if (value != null) args.push(`--${key.replaceAll("_", "-")}`, String(value));
	}
	const request = ["/audit", ...audit.paths, ...(audit.all ? ["--all"] : []), "--workers", String(audit.workers),
		"--patch-max-turns", String(audit.patchMaxTurns)].join(" ");
	return [...args, "--", request];
}

/** The auth directory is an OS-runtime grant, never a Swival model-tool root. */
export function buildNativeAgentfsArgs(cli: string, snapshot: string, authDirectory: string | undefined,
	session: string, swivalArgs: string[]): string[] {
	return ["run", "--no-default-allows", "--allow", snapshot, ...(authDirectory ? ["--allow", authDirectory] : []),
		"--session", session, "--", cli, ...swivalArgs];
}

// -------------------------------------------------------- environment --

/** Forward only the selected upstream credential interface, never execution hooks. */
export function nativeEnvironment(input: NodeJS.ProcessEnv, searchPath: string, provider?: string,
	anthropicShimDir?: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	const credentials = provider === "chatgpt" ? ["CHATGPT_TOKEN_DIR", "CHATGPT_AUTH_FILE", "CHATGPT_API_KEY"] :
		provider === "openrouter" ? ["OPENROUTER_API_KEY"] :
		provider === "anthropic" ? ["ANTHROPIC_API_KEY"] :
		provider === "bedrock" ? ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"] :
		provider === "geap" ? ["GOOGLE_OAUTH_ACCESS_TOKEN", "GOOGLE_OAUTH_ACCESS_TOKEN_NOT_AFTER"] : [];
	for (const key of ["HOME", "TMPDIR", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", ...credentials]) {
		if (input[key] !== undefined) env[key] = input[key];
	}
	if ((provider === "anthropic" || provider === "bedrock" || provider === "geap") && anthropicShimDir) {
		env.PYTHONPATH = anthropicShimDir;
		env.PYTHONDONTWRITEBYTECODE = "1";
		env.PI_SWIVAL_SHIM_REQUIRED = "1";
	}
	if (provider === "bedrock") {
		env.AWS_CONFIG_FILE = "/dev/null";
		env.AWS_SHARED_CREDENTIALS_FILE = "/dev/null";
		env.AWS_EC2_METADATA_DISABLED = "true";
	}
	if (provider === "geap") {
		env.GOOGLE_APPLICATION_CREDENTIALS = "/dev/null";
		if (input.XDG_CONFIG_HOME) env.CLOUDSDK_CONFIG = path.join(input.XDG_CONFIG_HOME, "gcloud-empty");
	}
	return { ...env, PATH: searchPath, LITELLM_MODE: "PRODUCTION", LITELLM_LOCAL_MODEL_COST_MAP: "True", NONO_NO_UPDATE_CHECK: "1",
		NO_COLOR: "1", TERM: "dumb", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
}

const PREFLIGHT_PRESENCE_KEYS = new Set(["USE_LITELLM_PROXY", "SWIVAL_ENCRYPT_KEY", "SWIVAL_LLM_FILTER", "SWIVAL_SECRET_SHIELD",
	"CHATGPT_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY",
	"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "PI_SWIVAL_AWS_PROFILE_MINTED", "GOOGLE_OAUTH_ACCESS_TOKEN",
	"AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE",
	"GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG", "VERTEXAI_CREDENTIALS",
	"CHATGPT_API_BASE", "OPENAI_CHATGPT_API_BASE", "OPENAI_API_BASE", "OPENAI_BASE_URL", "OPENROUTER_API_BASE", "LITELLM_API_BASE",
	"ANTHROPIC_API_BASE", "ANTHROPIC_BASE_URL", "AWS_BEDROCK_RUNTIME_ENDPOINT", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
	"VERTEXAI_API_BASE"]);

/** Preflight needs credential/requirement presence, never credential values or auth paths. */
export function nativePreflightEnvironment(input: NodeJS.ProcessEnv, searchPath: string): NodeJS.ProcessEnv {
	const env = nativeEnvironment(input, searchPath);
	for (const key of Object.keys(input)) {
		if (["http_proxy", "https_proxy", "all_proxy"].includes(key.toLowerCase()) || PREFLIGHT_PRESENCE_KEYS.has(key)) {
			env[key] = input[key] ? "present" : "";
		}
	}
	return env;
}

// -------------------------------------------------------- credentials --

/** Host-side credential bridge. The caller supplies a bounded trusted CLI runner.
 * No route parsing, credential persistence, retries, or account fallback here. */
export async function bridgeNativeCredentials(
	route: NativeRoute, awsProfile: string | undefined, input: NodeJS.ProcessEnv, timeoutMs: number,
	execute: (tool: "aws" | "gcloud", args: string[]) => Promise<string>, now: () => number = Date.now,
): Promise<{ bedrockExpirationMs?: number; vertexNotAfterSec?: number }> {
	const singleValue = (value: unknown): value is string => typeof value === "string" &&
		value.length > 0 && value.length <= 16_384 && !/[\s\x00-\x1f\x7f]/.test(value);
	delete input.PI_SWIVAL_AWS_PROFILE_MINTED;
	if (route.provider === "bedrock") {
		// Configured identity outranks ambient keys. Export the default chain only
		// when there is no explicit profile and no complete env session.
		if (awsProfile === undefined && input.AWS_ACCESS_KEY_ID && input.AWS_SECRET_ACCESS_KEY && input.AWS_SESSION_TOKEN) return {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(await execute("aws", ["configure", "export-credentials", ...(awsProfile ? ["--profile", awsProfile] : []), "--format", "process"]));
		} catch { throw credentialUnavailable(); }
		if (!isPlainRecord(parsed) || !singleValue(parsed.AccessKeyId) || !singleValue(parsed.SecretAccessKey) ||
			!singleValue(parsed.SessionToken) || typeof parsed.Expiration !== "string") throw credentialUnavailable();
		const expiration = Date.parse(parsed.Expiration);
		if (!Number.isFinite(expiration) || expiration - now() < Math.max(timeoutMs, 300_000)) throw credentialUnavailable();
		input.AWS_ACCESS_KEY_ID = parsed.AccessKeyId;
		input.AWS_SECRET_ACCESS_KEY = parsed.SecretAccessKey;
		input.AWS_SESSION_TOKEN = parsed.SessionToken;
		if (awsProfile) input.PI_SWIVAL_AWS_PROFILE_MINTED = "1";
		return { bedrockExpirationMs: expiration };
	}
	if (route.provider === "geap") {
		if (!input.GOOGLE_OAUTH_ACCESS_TOKEN) {
			try { input.GOOGLE_OAUTH_ACCESS_TOKEN = (await execute("gcloud", ["auth", "application-default", "print-access-token"])).trim(); }
			catch { throw credentialUnavailable(); }
		}
		if (!singleValue(input.GOOGLE_OAUTH_ACCESS_TOKEN)) throw credentialUnavailable();
		// gcloud may return a cached token; this is a local use limit, not a claim
		// that the token has 55 minutes left. HTTP 401 also stops the run.
		const notAfter = Math.min(Number(input.GOOGLE_OAUTH_ACCESS_TOKEN_NOT_AFTER ?? Infinity), Math.floor(now() / 1000) + 3300);
		if (!Number.isFinite(notAfter) || notAfter * 1000 <= now()) throw credentialUnavailable();
		input.GOOGLE_OAUTH_ACCESS_TOKEN_NOT_AFTER = String(notAfter);
		return { vertexNotAfterSec: notAfter };
	}
	return {};
}

export function assertNativeCredentialLifetime(
	deadline: { bedrockExpirationMs?: number; vertexNotAfterSec?: number }, timeoutMs: number, now = Date.now(),
): void {
	if ((deadline.bedrockExpirationMs !== undefined && deadline.bedrockExpirationMs - now < Math.max(timeoutMs, 300_000)) ||
		(deadline.vertexNotAfterSec !== undefined && deadline.vertexNotAfterSec * 1000 <= now)) throw credentialUnavailable();
}

function nativePreflight(executable: string, cwd: string, request: string, env: NodeJS.ProcessEnv) {
	return new Promise<ReturnType<typeof parseNativePreflight>>((resolve, reject) => {
		const child = execFile(executable, ["-I", "-B", NATIVE_AUDIT_SCRIPT, "--preflight"],
			{ cwd, env, timeout: 10_000, maxBuffer: 64 * 1024, encoding: "utf8", shell: false }, (error, stdout) => {
				try { resolve(parseNativePreflight(stdout, !error)); } catch (failure) { reject(failure); }
			});
		child.stdin?.on("error", () => {}); child.stdin?.end(request);
	});
}

// -------------------------------------------------------- diagnostics --

interface NativeDiagnostics {
	bytes: number;
	closed: boolean;
	expansionFailures: number;
	ambiguous: boolean;
	authPersistenceFailure: boolean;
	adjudicationFailure: boolean;
	adjudicationRepairFailure: boolean;
	reviewerErrors: number;
	consolidateErrors: number;
	adjudicationSentinelErrors: number;
	recoveredReviewerErrors: number;
}

interface StreamState { adjudicating: boolean; terminalPrefix?: "reviewer" | "consolidate" }

/** Phase 4.5 metrics from the snapshot's single released state; zeros when absent or unreadable. */
function snapshotAdjudicationMetrics(runDir: string): { lensRetries: number; repairFailures: number; adjudicationErrors: number } {
	const zero = { lensRetries: 0, repairFailures: 0, adjudicationErrors: 0 };
	try {
		const states = path.join(runDir, "snapshot", ".swival", "audit");
		const entries = fsSync.readdirSync(states).filter((name) => /^[a-f0-9]{8}$/.test(name));
		if (entries.length !== 1) return zero;
		const state = JSON.parse(regularBytes(runDir, path.join(states, entries[0], "state.json"), NATIVE_FILE_LIMIT).toString("utf8"));
		if (!isPlainRecord(state) || !isPlainRecord(state.metrics)) return zero;
		const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0);
		return { lensRetries: count(state.metrics.phase45_lens_retries), repairFailures: count(state.metrics.repair_failures),
			adjudicationErrors: count(state.metrics.pi_swival_adjudication_errors) };
	} catch { return zero; }
}

/**
 * Released Phase 4.5 retries a lens once after an exception, printing
 * `reviewer error:` even when the retry succeeds. Reconcile printed reviewer
 * errors against recorded lens retries only when no format repair failed, so a
 * recovered transient error completes while any unrecovered lens, consolidate
 * error, or hook-recorded adjudication error fails closed.
 */
function reconcileAdjudication(runDir: string, diagnostics: NativeDiagnostics): void {
	const metrics = snapshotAdjudicationMetrics(runDir);
	const unrecovered = metrics.repairFailures === 0
		? Math.max(0, diagnostics.reviewerErrors - metrics.lensRetries) : diagnostics.reviewerErrors;
	diagnostics.recoveredReviewerErrors = diagnostics.reviewerErrors - unrecovered;
	diagnostics.adjudicationFailure = diagnostics.consolidateErrors > 0 || diagnostics.adjudicationSentinelErrors > 0 ||
		metrics.adjudicationErrors > 0 || unrecovered > 0;
}

// -------------------------------------------------------- preparation --

export async function prepareNativeAudit(
	cwd: string, params: Record<string, unknown>, audit: NativeAuditOptions, runtime: NativeRuntime,
	artifactDir: string, runId: string, maxTimeoutMs: number, signal?: AbortSignal,
): Promise<NativeAuditLaunch> {
	const cancelledBeforeLaunch = () => new Error("Native audit was cancelled before launch.");
	const checkCancelled = () => { if (signal?.aborted) throw cancelledBeforeLaunch(); };
	validateNativeAuditParams(params);
	checkCancelled();
	if (!runtime.python || !runtime.cli || !runtime.agentfs || !runtime.nono) {
		throw new Error("Native audit requires installed Swival CLI, Python, AgentFS and nono. No fallback.");
	}
	const trustedGit = await resolveTrustedGit(cwd, runtime);
	const identity = await sourceIdentity(cwd, trustedGit);
	if (await fs.realpath(cwd) !== identity.sourceRoot) throw new Error("Native audit requires repository-root cwd.");
	const protectedRoots = [identity.sourceRoot, identity.sourceGitDir, identity.sourceWorktreeGitDir];
	const input = { ...(runtime.environment ?? process.env) };
	// These roots select operator configuration and AgentFS runtime state. Validate
	// before any configuration import or native executable, on every platform.
	for (const key of ["HOME", "XDG_CONFIG_HOME"] as const) {
		const configured = key === "HOME" ? input.HOME : input.XDG_CONFIG_HOME ?? path.join(input.HOME!, ".config");
		try {
			if (!configured || !path.isAbsolute(configured) || /[\x00-\x1f\x7f]/.test(configured)) throw new Error();
			const canonical = await canonicalRuntimePath(configured);
			// A normal home containing the repository is valid; only refuse roots
			// at or beneath source/Git, not ancestors of those protected paths.
			for (const root of protectedRoots) if (await pathIsWithin(canonical, root)) throw new Error();
			input[key] = canonical;
		} catch {
			throw new Error("Native audit runtime configuration roots must be absolute directories outside source/Git.");
		}
	}
	const session = `native-${randomBytes(16).toString("hex")}`;
	// XDG/HOME themselves may be innocent while these descendants alias source
	// or Git. Resolve dangling aliases too, before imports or native probes.
	const effectivePaths = Object.freeze({
		configFile: path.join(input.XDG_CONFIG_HOME!, "swival", "config.toml"),
		nonoRoot: path.join(input.XDG_CONFIG_HOME!, "nono"),
		sessionRoot: path.join(input.HOME!, ".agentfs", "run", session),
	});
	const resolveRuntimePaths = async () => {
		try {
			const resolved = {
				configFile: await canonicalRuntimePath(effectivePaths.configFile, false),
				nonoRoot: await canonicalRuntimePath(effectivePaths.nonoRoot),
				sessionRoot: await canonicalRuntimePath(effectivePaths.sessionRoot),
			};
			for (const [key, target] of Object.entries(resolved)) {
				for (const root of protectedRoots) {
					if (await pathIsWithin(target, root) || key !== "configFile" && await pathIsWithin(root, target)) throw new Error();
				}
			}
			return Object.freeze(resolved);
		} catch {
			throw new Error("Native audit runtime configuration paths must be outside source/Git and non-overlapping writable roots.");
		}
	};
	const runtimePaths = await resolveRuntimePaths();
	const assertRuntimePaths = async () => {
		if (!isDeepStrictEqual(runtimePaths, await resolveRuntimePaths())) {
			throw new Error("Native audit runtime configuration paths changed during preparation.");
		}
	};
	if (process.platform === "darwin") await assertNativeSourceIsolation(protectedRoots, agentfsDarwinWriteRoots(input.HOME!, session));
	const pin = async (bin: string, virtualenv = false) => {
		if (!path.isAbsolute(bin)) throw new Error("Native runtime paths must be absolute.");
		await assertTrustedRuntimePath(bin, protectedRoots);
		const target = await fs.realpath(bin);
		const entry = path.join(await fs.realpath(path.dirname(bin)), path.basename(bin));
		await fs.access(entry, fsSync.constants.X_OK);
		if (!(await fs.stat(entry)).isFile()) throw new Error("Unsupported native runtime executable.");
		return virtualenv ? entry : target;
	};
	const python = await pin(runtime.python, true);
	const cli = await pin(runtime.cli);
	const agentfs = await pin(runtime.agentfs);
	const nono = await pin(runtime.nono);
	const cliStat = await fs.stat(cli);
	if (cliStat.size > 64 * 1024 || (await fs.readFile(cli, "utf8")).split("\n")[0] !== `#!${python}`) {
		throw new Error("Native CLI must use the preflighted installed Python interpreter.");
	}
	await assertTrustedRuntimePath(NATIVE_AUDIT_SCRIPT, protectedRoots);
	const shimEntryPath = path.join(ANTHROPIC_OAUTH_SHIM_DIR, "sitecustomize.py");
	const resolveTrustedShim = async () => {
		await assertTrustedRuntimePath(ANTHROPIC_OAUTH_SHIM_DIR, protectedRoots);
		await assertTrustedRuntimePath(shimEntryPath, protectedRoots);
		const dir = await canonicalRuntimePath(ANTHROPIC_OAUTH_SHIM_DIR);
		await assertTrustedRuntimePath(dir, protectedRoots);
		const dirShim = path.join(dir, "sitecustomize.py");
		await assertTrustedRuntimePath(dirShim, protectedRoots);
		const file = await canonicalRuntimePath(dirShim, false);
		await assertTrustedRuntimePath(file, protectedRoots);
		return { dir, file };
	};
	const validatedShim = await resolveTrustedShim();
	const runDir = await canonicalFuturePath(artifactDir);
	for (const source of protectedRoots) {
		if (await pathIsWithin(runDir, source) || await pathIsWithin(source, runDir)) {
			throw new Error("Native artifact root must be outside source checkout and Git metadata.");
		}
	}
	const timeoutMs = params.timeoutMs ?? Math.min(15 * 60_000, maxTimeoutMs);
	if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > maxTimeoutMs) {
		throw new Error(`Native timeoutMs must be an integer from 1 to ${maxTimeoutMs}.`);
	}
	if (!input.ANTHROPIC_API_KEY) {
		try {
			await assertTrustedRuntimePath(path.join(input.HOME!, ".pi", "agent", "auth.json"), protectedRoots);
			const bridgedAnthropic = readAnthropicAuthToken(input.HOME!);
			if (bridgedAnthropic) input.ANTHROPIC_API_KEY = bridgedAnthropic;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	let preflightEnv = nativePreflightEnvironment(input, trustedGit.env.PATH!);
	const routing: Record<string, unknown> = {};
	for (const field of NATIVE_PARAM_NAMES) {
		if (field.endsWith("Override") && params[field] !== undefined) routing[field.slice(0, -8)] = params[field];
	}
	const request: Record<string, any> = { source: identity.sourceRoot, routing, audit, shimPath: validatedShim.file, deferCredentials: true };
	const preflight = async () => {
		await assertRuntimePaths();
		return nativePreflight(python, identity.sourceRoot, JSON.stringify(request), preflightEnv);
	};
	const { route, awsProfile } = await preflight();
	delete request.deferCredentials;
	checkCancelled();
	const resolveTrustedCliTool = async (name: string): Promise<string> => {
		for (const dir of (trustedGit.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
			const candidate = path.join(dir, name);
			try {
				await assertTrustedRuntimePath(candidate, protectedRoots);
				const resolved = await fs.realpath(candidate);
				await fs.access(resolved, fsSync.constants.X_OK);
				if ((await fs.stat(resolved)).isFile()) return resolved;
			} catch { /* continue */ }
		}
		throw credentialUnavailable();
	};
	let callbackFailure: unknown;
	const credentialDeadline = await bridgeNativeCredentials(route, awsProfile, input, Number(timeoutMs), async (tool, argv) => {
		// Inspect host credential state only when the host CLI actually runs. The
		// bridge reports every callback failure as unavailable, so surface a state
		// refusal or cancellation; only a genuine host CLI failure stays unavailable.
		try {
			checkCancelled();
			const credentialState = await resolveTrustedCredentialState(tool, input.HOME!, protectedRoots)
				.catch((error: unknown) => { callbackFailure = error; throw error; });
			const executable = await resolveTrustedCliTool(tool);
			checkCancelled();
			return (await boundedExec(executable, argv, input.HOME!, undefined,
				{ ...nativeEnvironment(input, trustedGit.env.PATH!), ...credentialState, AWS_PAGER: "", AWS_EC2_METADATA_DISABLED: "true", CLOUDSDK_CORE_DISABLE_PROMPTS: "1" },
				10_000, 16_384, signal)).toString("utf8");
		} catch (error) {
			if (signal?.aborted) callbackFailure = cancelledBeforeLaunch();
			throw error;
		}
	}).catch((error: unknown) => { throw callbackFailure ?? error; });
	preflightEnv = nativePreflightEnvironment(input, trustedGit.env.PATH!);
	let anthropicShimDir: string | undefined;
	if (route.provider === "anthropic" || route.provider === "bedrock" || route.provider === "geap") {
		const currentShim = await resolveTrustedShim();
		if (currentShim.dir !== validatedShim.dir || currentShim.file !== validatedShim.file) {
			throw new Error("Native compatibility shim path changed during preparation.");
		}
		anthropicShimDir = currentShim.dir;
	}
	const env = nativeEnvironment(input, trustedGit.env.PATH!, route.provider, anthropicShimDir);
	const authStore = route.provider === "chatgpt" ? await prepareNativeAuthStore(input, [...protectedRoots, runDir]) : undefined;
	if (authStore) {
		env.CHATGPT_TOKEN_DIR = authStore.directory;
		env.CHATGPT_AUTH_FILE = authStore.filename;
	}
	await assertRuntimePaths();
	const agentfsVersion = (await boundedExec(agentfs, ["--version"], cwd, undefined, env, 5000, 16384)).toString();
	if (!parseSemver(agentfsVersion) || compareSemver(agentfsVersion, MIN_AGENTFS_VERSION) < 0) {
		throw new Error(`Native audit requires AgentFS ${MIN_AGENTFS_VERSION} or newer. No fallback.`);
	}
	await assertRuntimePaths();
	await boundedExec(nono, ["--version"], cwd, undefined, env, 5000, 16384);
	await assertRuntimePaths();
	if ((await boundedExec(agentfs, ["ps"], cwd, undefined, env, 5000, 65536)).toString().includes(session)) {
		throw new Error("Refusing a reused native AgentFS session.");
	}
	try {
		await fs.lstat(runtimePaths.sessionRoot);
		throw new Error("Refusing a pre-existing native AgentFS session.");
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	checkCancelled();
	await fs.mkdir(path.dirname(runDir), { recursive: true, mode: 0o700 });
	await fs.mkdir(runDir, { mode: 0o700 });
	const snapshot = path.join(runDir, "snapshot");
	// Linux AgentFS overlays cwd even when it is also explicitly allowed.
	// Keep the host-visible snapshot outside that disposable overlay.
	const sandboxCwd = path.join(runDir, "sandbox-cwd");
	let args: string[];
	const meta: RunMeta = { runId, agent: "native-audit", task: "/audit (committed source-only scope)",
		startedAt: Date.now(), pid: undefined, artifactDir: runDir, stdoutFile: path.join(runDir, "diagnostics.json"),
		stderrFile: path.join(runDir, "diagnostics.json"), nativeAuditRequested: true };
	try {
		await fs.mkdir(sandboxCwd, { mode: 0o700 });
		const manifest = await createCommittedSnapshot(cwd, snapshot, trustedGit);
		request.snapshot = snapshot;
		const { scope, route: secondRoute, awsProfile: secondAwsProfile } = await preflight();
		if (!isDeepStrictEqual(route, secondRoute) || awsProfile !== secondAwsProfile) throw new Error("Native route changed during preparation. No fallback.");
		if (!isPlainRecord(scope) || !scope.mandatory_files?.length) throw new Error("No auditable committed files in scope.");
		checkCancelled();
		const config = path.join(runDir, "config");
		await fs.mkdir(path.join(config, "swival"), { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(config, "swival", "config.toml"), "# Inert native configuration.\n", { mode: 0o600 });
		if (route.provider === "geap") {
			const gcloudEmpty = path.join(config, "gcloud-empty");
			await fs.mkdir(gcloudEmpty, { mode: 0o700 });
			env.CLOUDSDK_CONFIG = gcloudEmpty;
			const adcDisabled = path.join(gcloudEmpty, "adc-disabled.json");
			await fs.writeFile(adcDisabled, "{}\n", { mode: 0o600 });
			env.GOOGLE_APPLICATION_CREDENTIALS = adcDisabled;
		}
		// Upstream checks the operator's installed nono profile. Do not copy it,
		// replace its policy, or claim authenticity from an availability check.
		await fs.symlink(runtimePaths.nonoRoot, path.join(config, "nono"));
		env.XDG_CONFIG_HOME = config;
		const bin = path.join(runDir, "runtime-bin"); await fs.mkdir(bin, { mode: 0o700 });
		for (const [name, target] of [["git", trustedGit.executable], ["agentfs", agentfs], ["nono", nono]]) {
			await fs.symlink(target, path.join(bin, name));
		}
		env.PATH = [bin, trustedGit.env.PATH].join(path.delimiter);
		args = buildNativeAuditArgs(snapshot, route, audit);
		await fs.mkdir(path.join(runDir, "evidence"), { mode: 0o700 });
		await fs.writeFile(path.join(runDir, "manifest.json"), JSON.stringify({ ...manifest,
			sandbox: "agentfs", session, authStore, route, scope, audit, command: args.at(-1) }, null, 2), { mode: 0o600 });
		await fs.writeFile(path.join(runDir, "run-meta.json"), JSON.stringify(meta), { mode: 0o600 });
		checkCancelled();
		await assertRuntimePaths();
		assertNativeCredentialLifetime(credentialDeadline, Number(timeoutMs));
		// No asynchronous work may separate this final check from spawn.
		checkCancelled();
	} catch (error) {
		await fs.rm(runDir, { recursive: true, force: true });
		throw error;
	}
	// The pinned interpreter runs the CLI through the launcher so the Phase 4.5
	// adjudication hook installs lazily without touching PYTHONPATH.
	const launcherArgs = ["-B", NATIVE_AUDIT_SCRIPT, "--launch", cli, ...args];
	const proc = spawn(agentfs, buildNativeAgentfsArgs(python, snapshot, authStore?.directory, session, launcherArgs), {
		cwd: sandboxCwd, env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	meta.pid = proc.pid;
	const diagnostics: NativeDiagnostics = { bytes: 0, closed: false, expansionFailures: 0, ambiguous: false,
		authPersistenceFailure: false, adjudicationFailure: false, adjudicationRepairFailure: false,
		reviewerErrors: 0, consolidateErrors: 0, adjudicationSentinelErrors: 0, recoveredReviewerErrors: 0 };
	const pending = ["", ""];
	const streamState: StreamState[] = pending.map(() => ({ adjudicating: false }));
	let stopped: string | undefined;
	let finalization: Promise<NativeTerminal> | undefined;
	let settle!: (terminal: NativeTerminal) => void;
	let fail!: (error: unknown) => void;
	const completion = new Promise<NativeTerminal>((resolve, reject) => { settle = resolve; fail = reject; });
	const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
	const consumeLine = (line: string, index: number) => {
		const text = line.trim();
		// LiteLLM 1.106.6 prints this fixed header before its device-code challenge.
		if (text === "Sign in with ChatGPT using device code:") {
			cancel("Native ChatGPT login is required. Authenticate with upstream Swival outside Pi, then rerun the audit.");
		}
		if (text === CREDENTIAL_EXPIRED_SENTINEL) cancel("CREDENTIAL_EXPIRED: short-lived provider credential expired during native audit; no fallback.");
		if (line.includes(SHIM_INSTALL_FAILED_SENTINEL)) cancel("Native compatibility shim installation failed; refusing unverified route execution.");
		if (line.includes("Failed to write ChatGPT auth file")) {
			diagnostics.authPersistenceFailure = true;
			cancel("Native ChatGPT auth-state persistence failed; completion is refused.");
		}
		if (text === ADJUDICATION_ERROR_SENTINEL) diagnostics.adjudicationSentinelErrors++;
		const state = streamState[index];
		// Rich wraps these fixed markers between words, even on non-TTY streams.
		const marker = /\b(reviewer|consolidate)\s+error:/.exec(line)?.[1] ??
			(state.terminalPrefix && text.startsWith("error:") ? state.terminalPrefix : undefined);
		if (marker === "reviewer") diagnostics.reviewerErrors++;
		else if (marker === "consolidate") diagnostics.consolidateErrors++;
		state.terminalPrefix = /\b(reviewer|consolidate)\s*$/.exec(line)?.[1] as StreamState["terminalPrefix"];
		if (text.startsWith("phase 4.5: adjudicating ")) state.adjudicating = true;
		if (text.startsWith("phase 4.5 complete.")) state.adjudicating = false;
		// Parallel output cannot associate later reviewer recovery with an exhausted repair.
		if (state.adjudicating && text === "repair failed") diagnostics.adjudicationRepairFailure = true;
		if (!line.includes("expansion(s) failed")) return;
		const match = /^\s*.+: ([0-9]+)\/([0-9]+) expansion\(s\) failed, ([0-9]+) finding\(s\) retained\s*$/.exec(line);
		if (!match || !(Number(match[1]) > 0 && Number(match[1]) < Number(match[2]) &&
			Number(match[3]) > 0 && Number(match[3]) <= Number(match[2]) - Number(match[1]))) diagnostics.ambiguous = true;
		else diagnostics.expansionFailures += Number(match[1]);
	};
	const finish = (code: number) => {
		if (finalization) return;
		clearTimeout(timer);
		const ownership: NativeOwnership | undefined = proc.pid ? {
			signal: (value) => process.kill(-proc.pid!, value),
			verify: async () => !(await boundedExec(agentfs, ["ps"], runDir, undefined, env, 5000, 65536)).toString().includes(session),
		} : undefined;
		finalization = finalizeNativeAudit({ runDir, ownership, cancellationReason: () => stopped,
			closeLogs: async (shutdown) => {
				let drainTimer: ReturnType<typeof setTimeout> | undefined;
				try {
					if (shutdown !== "verified") throw new Error("Shutdown not verified");
					await Promise.race([closed, new Promise<never>((_, reject) => {
						drainTimer = setTimeout(() => reject(new Error("Diagnostic drain timeout")), 2000);
					})]);
					diagnostics.closed = true;
				} finally {
					clearTimeout(drainTimer);
					for (const [index, line] of pending.entries()) if (line) consumeLine(line, index);
					proc.stdout?.destroy(); proc.stderr?.destroy();
					if (shutdown !== "verified") proc.unref();
					reconcileAdjudication(runDir, diagnostics);
					await fs.writeFile(path.join(runDir, "diagnostics.json"), JSON.stringify(diagnostics), { mode: 0o600 });
				}
			},
		}, { exitCode: code, stopped });
		void finalization.then(settle, fail).finally(() => signal?.removeEventListener("abort", abort));
	};
	const cancel = (reason = "Native audit was cancelled.") => { stopped ??= reason; finish(1); };
	const timer = setTimeout(() => cancel(`Native audit timed out after ${timeoutMs}ms.`), timeoutMs as number);
	const abort = () => cancel();
	for (const [index, stream] of [proc.stdout!, proc.stderr!].entries()) {
		stream.setEncoding("utf8");
		stream.on("data", (chunk: string) => {
			diagnostics.bytes += Buffer.byteLength(chunk);
			if (diagnostics.bytes > DIAGNOSTICS_LIMIT) { cancel("Native diagnostics exceeded the 2 MiB cap."); return; }
			pending[index] += chunk;
			const lines = pending[index].split("\n"); pending[index] = lines.pop()!;
			for (const line of lines) consumeLine(line, index);
			if (pending[index].length > 65536) { diagnostics.ambiguous = true; cancel("Native diagnostic line exceeded its bound."); }
		});
		stream.on("error", () => cancel("Native diagnostic I/O failed."));
	}
	proc.once("error", () => cancel("Native CLI failed to start."));
	proc.once("exit", (code) => finish(code ?? 1));
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) cancel();
	return { route, meta, proc, completion, cancel };
}

// ------------------------------------------------------- finalization --

const TERMINAL_DIAGNOSTICS = ["stopped", "shutdownFailure", "preservationFailure", "cleanupFailure", "persistenceFailure"] as const;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Terminate the owned group and prove absence through ESRCH only; EPERM never counts as shutdown. */
async function shutdownGroup(ownership: NativeOwnership): Promise<{ shutdown: "verified" | "unverified"; wasAlive: boolean }> {
	const absent = () => {
		try { ownership.signal(0); return false; }
		catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
	};
	if (absent()) return { shutdown: "verified", wasAlive: false };
	try { ownership.signal("SIGTERM"); } catch { /* Only a later ESRCH probe proves absence. */ }
	for (let attempt = 0; attempt < 20; attempt++) {
		if (absent()) return { shutdown: "verified", wasAlive: true };
		await delay(50);
	}
	try { ownership.signal("SIGKILL"); } catch { /* Do not treat EPERM as shutdown. */ }
	for (let attempt = 0; attempt < 20; attempt++) {
		if (absent()) return { shutdown: "verified", wasAlive: true };
		await delay(50);
	}
	return { shutdown: absent() ? "verified" : "unverified", wasAlive: true };
}

interface EvidenceBudget { entries: number; bytes: number; paths: Set<string> }

function ensureDirectory(root: string, target: string): void {
	if (target !== path.resolve(root)) ensureDirectory(root, path.dirname(target));
	try {
		if (!checkedPath(root, target).isDirectory()) throw new Error("Unsafe native evidence directory.");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		fsSync.mkdirSync(target, { mode: 0o700 });
		if (!checkedPath(root, target).isDirectory()) throw new Error("Unsafe native evidence directory.");
	}
}
const temporary = (target: string) => `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
const exclusiveWrite = (target: string, bytes: Buffer | string) => fsSync.writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
function scanned(budget: { entries: number }): void {
	if (++budget.entries > NATIVE_MAX_ENTRIES) throw new Error("Native evidence entry limit.");
}
function accountRetained(target: string, size: number, budget: EvidenceBudget): void {
	if (budget.paths.has(target)) return;
	scanned(budget);
	budget.bytes += size;
	if (budget.bytes > NATIVE_TOTAL_LIMIT) throw new Error("Native evidence byte limit.");
	budget.paths.add(target);
}
function publishEvidence(runDir: string, source: string, target: string, budget: EvidenceBudget): void {
	const bytes = regularBytes(runDir, source, NATIVE_FILE_LIMIT);
	try {
		const existing = regularBytes(runDir, target, NATIVE_FILE_LIMIT);
		if (!existing.equals(bytes)) throw new Error("Conflicting retained native evidence.");
		accountRetained(target, existing.length, budget);
		return;
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	// Charge the destination union, including new directories. Matching retry
	// files are already charged by the retained-tree scan, never twice.
	accountRetained(target, bytes.length, budget);
	const evidence = path.join(runDir, "evidence");
	for (let parent = path.dirname(target); parent !== evidence; parent = path.dirname(parent)) accountRetained(parent, 0, budget);
	ensureDirectory(runDir, path.dirname(target));
	const temp = temporary(target);
	try {
		exclusiveWrite(temp, bytes);
		// link is exclusive: a retry cannot overwrite a conflicting destination.
		fsSync.linkSync(temp, target);
	} finally {
		if (fsSync.existsSync(temp)) fsSync.unlinkSync(temp);
	}
}
function scanDirectory(runDir: string, directory: string, budget: { entries: number }, visit: (name: string) => void): void {
	let stat: fsSync.Stats;
	try { stat = checkedPath(runDir, directory); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	if (!stat.isDirectory()) throw new Error("Unsupported native evidence directory.");
	const entries = fsSync.opendirSync(directory);
	try {
		for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
			scanned(budget);
			visit(entry.name);
		}
	} finally { entries.closeSync(); }
}

/** Copy the released report, audit state, and finding report/patch pairs out of the snapshot within fixed budgets. */
function preserveEvidence(runDir: string): void {
	const snapshot = path.join(runDir, "snapshot");
	const evidence = path.join(runDir, "evidence");
	const budget: EvidenceBudget = { entries: 0, bytes: 0, paths: new Set() };
	const retainedScan = { entries: 0 };
	const retained = (directory: string) => scanDirectory(runDir, directory, retainedScan, (name) => {
		const target = path.join(directory, name);
		const stat = checkedPath(runDir, target);
		if (stat.isDirectory()) {
			accountRetained(target, 0, budget);
			retained(target);
		} else {
			if (!stat.isFile() || stat.size > NATIVE_FILE_LIMIT) throw new Error("Unsupported retained native evidence.");
			accountRetained(target, stat.size, budget);
		}
	});
	// Every retained entry counts, including unmatched files in export namespaces.
	retained(evidence);
	publishEvidence(runDir, path.join(snapshot, "native-cli-report.json"), path.join(evidence, "native-cli-report.json"), budget);
	// Bound source traversal independently from the logical destination union.
	const sourceScan = { entries: 0 };
	const states = path.join(snapshot, ".swival", "audit");
	scanDirectory(runDir, states, sourceScan, (name) => {
		if (!/^[a-f0-9]{8}$/.test(name)) return;
		scanned(sourceScan);
		publishEvidence(runDir, path.join(states, name, "state.json"), path.join(evidence, "native-state", name, "state.json"), budget);
	});
	const findings = (source: string, target: string) => scanDirectory(runDir, source, sourceScan, (name) => {
		const file = path.join(source, name);
		const stat = checkedPath(runDir, file);
		if (stat.isDirectory()) findings(file, path.join(target, name));
		else {
			if (!stat.isFile()) throw new Error("Nonregular native evidence.");
			if (/\.(?:md|patch)$/.test(name)) publishEvidence(runDir, file, path.join(target, name), budget);
		}
	});
	findings(path.join(snapshot, "audit-findings"), path.join(evidence, "audit-findings"));
}

function atomicTerminal(runDir: string, name: string, record: NativeTerminal): void {
	checkedPath(runDir, runDir);
	const target = path.join(runDir, name);
	const temp = temporary(target);
	try {
		exclusiveWrite(temp, JSON.stringify(record, null, 2));
		fsSync.renameSync(temp, target);
	} finally {
		if (fsSync.existsSync(temp)) fsSync.unlinkSync(temp);
	}
}

function immutable(record: NativeTerminal): NativeTerminal {
	if (record.retainedResources) Object.freeze(record.retainedResources);
	return Object.freeze(record);
}

export interface NativeFinalizationOptions {
	runDir: string;
	/** Live child process-group authority; disk-recovered runs pass none and are never signalled. */
	ownership?: NativeOwnership;
	closeLogs?: (shutdown: NativeTerminal["shutdown"]) => Promise<void>;
	cancellationReason?: () => string | undefined;
}

/**
 * Terminate, verify, export, and record one native run exactly once. Evidence
 * leaves the snapshot only after verified AgentFS teardown; otherwise every
 * run-scoped resource is retained and the terminal record says why.
 */
export async function finalizeNativeAudit(options: NativeFinalizationOptions,
	outcome: { exitCode: number; stopped?: string }): Promise<NativeTerminal> {
	const { runDir, ownership, closeLogs, cancellationReason } = options;
	const existing = readNativeTerminal(runDir);
	if (existing && (existing.shutdown !== "unverified" || !ownership)) return existing;
	const record: NativeTerminal = { exitedAt: new Date().toISOString(), ...(existing ?? {}), ...outcome,
		exitCode: outcome.exitCode ?? 1, shutdown: "unverified" };
	delete record.shutdownFailure;
	if (ownership) {
		const stopped = await shutdownGroup(ownership);
		record.shutdown = stopped.shutdown;
		if (stopped.wasAlive && !record.stopped) record.stopped = "Native process left running descendants.";
		let verified = false;
		try { verified = await ownership.verify?.() === true; } catch { /* Keep resources on lost proof. */ }
		if (!verified) record.shutdown = "unverified";
		if (record.shutdown === "verified") record.boundary = "agentfs-cli";
	}
	if (closeLogs) {
		try { await closeLogs(record.shutdown); }
		catch { record.cleanupFailure = "Native diagnostic drain failed."; }
	}
	const retained: string[] = [];
	const snapshot = path.join(runDir, "snapshot");
	if (record.shutdown === "unverified") {
		record.shutdownFailure = "Native CLI/process/AgentFS shutdown could not be verified.";
		for (const name of ["snapshot", "runtime-bin", "config", "sandbox-cwd"]) retained.push(path.join(runDir, name));
	} else {
		try { preserveEvidence(runDir); }
		catch { record.preservationFailure = "Native evidence preservation failed or exceeded resource limits."; }
		const removable = [path.join(runDir, "runtime-bin"), path.join(runDir, "config"), path.join(runDir, "sandbox-cwd")];
		if (record.preservationFailure) retained.push(snapshot);
		else removable.unshift(snapshot);
		for (const target of removable) {
			try {
				// Remove only run-scoped resources, never disk-recovered AgentFS sessions.
				if (fsSync.existsSync(target)) checkedPath(runDir, path.dirname(target));
				fsSync.rmSync(target, { recursive: true, force: true });
			} catch {
				record.cleanupFailure = [record.cleanupFailure, "Owned native temporary-resource cleanup failed."].filter(Boolean).join(" ");
				retained.push(target);
			}
		}
	}
	delete record.retainedResources;
	if (retained.length) record.retainedResources = retained;
	if (cancellationReason) record.stopped ??= cancellationReason();
	if (record.shutdown !== "verified" || TERMINAL_DIAGNOSTICS.some((key) => record[key])) record.exitCode ||= 1;
	if (!validTerminal(record, false)) throw new Error("Invalid native terminal outcome.");
	try {
		atomicTerminal(runDir, "completed.json", record);
		return immutable(record);
	} catch {
		const fallback = immutable({ ...record, exitCode: record.exitCode || 1, persistenceFailure: "Native completion marker could not be persisted." });
		try { atomicTerminal(runDir, "spawn-error.txt", fallback); return fallback; }
		catch { throw new Error(`Native terminal failure evidence could not be persisted. Artifacts: ${runDir}.`); }
	}
}
