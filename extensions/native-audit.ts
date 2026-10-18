import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type { RunMeta } from "./index.js";
import { canonicalFuturePath } from "./paths.js";

export interface NativeAuditOptions {
	paths: string[];
	all: boolean;
	workers: number;
	patchMaxTurns: number;
}

const NATIVE_FIELDS = new Set([
	"audit", "async", "timeoutMs", "maxInlineBytes", "profileOverride", "modelOverride",
	"providerOverride", "reasoningEffortOverride", "temperatureOverride",
	"topPOverride", "seedOverride", "maxTurnsOverride", "maxOutputTokensOverride",
	"providerTimeoutOverride",
]);

export function validateNativeAuditParams(params: Record<string, unknown>): NativeAuditOptions {
	if (params.async === true) throw new Error("Native async is unsupported; native audits are synchronous.");
	for (const key of Object.keys(params)) {
		if (!NATIVE_FIELDS.has(key)) throw new Error(`Native audit cannot be combined with ${key}.`);
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
		"--provider", route.provider, "--model", route.model, "--report", path.join(snapshot, "native-cli-report.json")];
	if (route.endpoint != null) args.push("--base-url", route.endpoint);
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

export interface NativeAuthStore { directory: string; filename: string }

/** Compare directory identities as well as spelling on case-insensitive filesystems. */
async function pathIsWithin(location: string, root: string): Promise<boolean> {
	let identity;
	try { identity = await fs.stat(root); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	for (let current = path.resolve(location); ; current = path.dirname(current)) {
		if (current === path.resolve(root)) return true;
		if (identity) {
			try {
				const stat = await fs.stat(current);
				if (stat.dev === identity.dev && stat.ino === identity.ino) return true;
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		if (path.dirname(current) === current) return false;
	}
}

/** Resolve directory metadata, including future descendants and dangling directory aliases. */
async function canonicalRuntimePath(directory: string, directoryOnly = true, links = 0): Promise<string> {
	let stat;
	try { stat = await fs.lstat(directory); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return path.join(await canonicalRuntimePath(path.dirname(directory), true, links), path.basename(directory));
	}
	if (stat.isSymbolicLink()) {
		if (links >= 40) throw new Error("Runtime configuration symlink limit exceeded.");
		const target = await fs.readlink(directory);
		return canonicalRuntimePath(path.isAbsolute(target) ? target : `${path.dirname(directory)}${path.sep}${target}`, directoryOnly, links + 1);
	}
	if (directoryOnly ? !stat.isDirectory() : !stat.isFile()) throw new Error("Runtime configuration path has an unsupported type.");
	return fs.realpath(directory);
}

/** Validate metadata only; never read, copy, or export an authentication record. */
export async function prepareNativeAuthStore(input: NodeJS.ProcessEnv,
	forbiddenRoots: string[]): Promise<NativeAuthStore> {
	const home = input.HOME;
	const filename = input.CHATGPT_AUTH_FILE ?? "auth.json";
	if (!home || !path.isAbsolute(home) || path.normalize(home) !== home ||
		!(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).test(filename)) {
		throw new Error("Native auth requires an absolute home and a safe auth filename basename.");
	}
	const directory = input.CHATGPT_TOKEN_DIR ?? path.join(home, ".config", "litellm", "chatgpt");
	const relative = path.relative(home, directory);
	if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || directory.length > 4096 || directory.split(path.sep).length > 64 ||
		/[\x00-\x1f\x7f\\]/.test(directory) || !relative || path.isAbsolute(relative) ||
		relative.split(path.sep).includes("..") ||
		[home, path.join(home, ".config"), path.join(home, ".config", "litellm")].includes(directory)) {
		throw new Error("Native auth requires a dedicated directory inside home, outside source and artifact scope.");
	}
	for (const broad of [home, path.join(home, ".config"), path.join(home, ".config", "litellm")]) {
		if (broad.toLowerCase() === directory.toLowerCase() || await pathIsWithin(broad, directory)) {
			throw new Error("Native auth refuses a broad directory grant.");
		}
	}
	// Reserve future runtime state before creating an otherwise empty auth store.
	const authPath = await canonicalFuturePath(directory);
	const reservedRoots = [...forbiddenRoots, path.join(home, ".agentfs"), path.join(home, ".pi"),
		input.XDG_CACHE_HOME ?? path.join(home, ".cache"), ...(input.TMPDIR ? [input.TMPDIR] : []),
		...agentfsDarwinWriteRoots(home, "")];
	for (const root of reservedRoots) {
		const reserved = await canonicalFuturePath(root);
		const foldedAuth = authPath.toLowerCase(); const foldedRoot = reserved.toLowerCase();
		if (await pathIsWithin(authPath, reserved) || await pathIsWithin(reserved, authPath) ||
			foldedAuth === foldedRoot || foldedAuth.startsWith(foldedRoot + path.sep) ||
			foldedRoot.startsWith(foldedAuth + path.sep)) {
			throw new Error("Native auth directory overlaps source, artifact, or runtime scope.");
		}
	}
	let current = path.parse(directory).root;
	for (const component of directory.slice(current.length).split(path.sep)) {
		current = path.join(current, component);
		let stat;
		try { stat = await fs.lstat(current); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" ||
				!(current.startsWith(home + path.sep))) throw error;
			await fs.mkdir(current, { mode: 0o700 });
			stat = await fs.lstat(current);
		}
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Native auth refuses symlinked or non-directory paths.");
		if ((current === home || current.startsWith(home + path.sep)) &&
			(stat.uid !== process.getuid?.() || (stat.mode & 0o022))) {
			throw new Error("Native auth directory ownership or write permissions are unsafe.");
		}
	}
	const entries = await fs.opendir(directory);
	try {
		for await (const entry of entries) {
			if (entry.name !== filename) throw new Error("Native auth requires a dedicated single-store directory.");
			const stat = await fs.lstat(path.join(directory, filename));
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536 ||
				stat.uid !== process.getuid?.() || (stat.mode & 0o022) || !(stat.mode & 0o200)) {
				throw new Error("Native auth refuses ambiguous auth file metadata.");
			}
		}
	} finally { await entries.close().catch(() => {}); }
	return { directory, filename };
}

/** Forward only the selected upstream credential interface, never execution hooks. */
export function nativeEnvironment(input: NodeJS.ProcessEnv, searchPath: string, provider?: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	const credentials = provider === "chatgpt" ? ["CHATGPT_TOKEN_DIR", "CHATGPT_AUTH_FILE", "CHATGPT_API_KEY"] :
		provider === "openrouter" ? ["OPENROUTER_API_KEY"] : [];
	for (const key of ["HOME", "TMPDIR", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", ...credentials]) {
		if (input[key] !== undefined) env[key] = input[key];
	}
	return { ...env, PATH: searchPath, LITELLM_MODE: "PRODUCTION", LITELLM_LOCAL_MODEL_COST_MAP: "True", NONO_NO_UPDATE_CHECK: "1",
		NO_COLOR: "1", TERM: "dumb", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
}

/** Preflight needs credential/requirement presence, never credential values or auth paths. */
export function nativePreflightEnvironment(input: NodeJS.ProcessEnv, searchPath: string): NodeJS.ProcessEnv {
	const env = nativeEnvironment(input, searchPath);
	for (const key of Object.keys(input)) {
		if (["http_proxy", "https_proxy", "all_proxy"].includes(key.toLowerCase()) ||
			["USE_LITELLM_PROXY", "SWIVAL_ENCRYPT_KEY", "SWIVAL_LLM_FILTER", "SWIVAL_SECRET_SHIELD",
				"CHATGPT_API_KEY", "OPENROUTER_API_KEY", "CHATGPT_API_BASE", "OPENAI_CHATGPT_API_BASE",
				"OPENAI_API_BASE", "OPENAI_BASE_URL", "OPENROUTER_API_BASE", "LITELLM_API_BASE"].includes(key)) {
			env[key] = input[key] ? "present" : "";
		}
	}
	return env;
}

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
}

const routeIdentifier = (value: unknown, limit = 160): value is string => typeof value === "string" &&
	value.length > 0 && value.length <= limit && /^[A-Za-z0-9][A-Za-z0-9_./:-]*$/.test(value) &&
	!/[A-Za-z0-9]{40,}|(?:^|\/)\.\.?(?:\/|$)/.test(value);
const routeOptions = new Set(["max_output_tokens", "max_turns", "provider_timeout", "retries",
	"temperature", "top_p", "seed", "max_context_tokens"]);
const explicitRouteFields = new Set(["profile", "provider", "model", "reasoningEffort",
	"temperature", "topP", "seed", "maxOutputTokens", "maxTurns", "providerTimeout"]);
const routeFailure = () => new Error("Native audit configuration preflight failed: invalid or unsupported metadata. No native worker/provider was started.");

export function parseNativeRoute(value: unknown): NativeRoute {
	if (!isPlainRecord(value) || value.version !== 2 ||
		!hasOnlyFields(value, new Set(["version", "runtime", "provider", "model", "endpoint", "profile",
			"reasoningEffort", "options", "selection", "reportIdentity"])) ||
		!isDeepStrictEqual(value.runtime, { swival: "1.0.46", litellm: "1.103.4" }) ||
		!routeIdentifier(value.provider, 40) || !routeIdentifier(value.model) ||
		!(value.profile === null || routeIdentifier(value.profile, 80)) ||
		!(value.reasoningEffort === null || ["none", "minimal", "low", "medium", "high", "xhigh", "default"].includes(value.reasoningEffort)) ||
		!isPlainRecord(value.options) || !isPlainRecord(value.selection) || !isPlainRecord(value.reportIdentity)) throw routeFailure();
	if (value.endpoint !== null) {
		if (typeof value.endpoint !== "string" || value.endpoint.length > 512 ||
			!/^https?:\/\/[A-Za-z0-9.:[\]-]+(?::[0-9]+)?(?:\/[A-Za-z0-9_./-]*)?$/.test(value.endpoint) ||
			/[A-Za-z0-9]{40,}/.test(value.endpoint)) throw routeFailure();
		try {
			const endpoint = new URL(value.endpoint);
			if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
				(endpoint.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) throw routeFailure();
		} catch { throw routeFailure(); }
	}
	const selection = value.selection;
	if (!hasOnlyFields(selection, new Set(["profileSource", "explicitFields"])) ||
		![null, "active", "explicit"].includes(selection.profileSource) ||
		!Array.isArray(selection.explicitFields) || selection.explicitFields.length > explicitRouteFields.size ||
		selection.explicitFields.some((field: unknown) => typeof field !== "string" || !explicitRouteFields.has(field)) ||
		new Set(selection.explicitFields).size !== selection.explicitFields.length ||
		(value.profile === null) !== (selection.profileSource === null) ||
		(selection.profileSource === "explicit") !== selection.explicitFields.includes("profile") ||
		!hasOnlyFields(value.reportIdentity, new Set(["provider", "model"])) ||
		value.reportIdentity.provider !== value.provider || value.reportIdentity.model !== value.model) throw routeFailure();
	const options: Record<string, number | null> = {};
	for (const [key, option] of Object.entries(value.options)) {
		if (!routeOptions.has(key) || !(option === null || typeof option === "number" && Number.isFinite(option) && Math.abs(option) <= Number.MAX_SAFE_INTEGER)) throw routeFailure();
		options[key] = option;
	}
	return { version: 2, runtime: { swival: "1.0.46", litellm: "1.103.4" }, provider: value.provider,
		model: value.model, endpoint: value.endpoint, profile: value.profile, reasoningEffort: value.reasoningEffort,
		options, selection: { profileSource: selection.profileSource, explicitFields: [...selection.explicitFields] },
		reportIdentity: { provider: value.reportIdentity.provider, model: value.reportIdentity.model } };
}

const preflightReasons: Record<string, string> = {
	PROFILE_UNAVAILABLE: "Selected profile is unavailable; no fallback.",
	ROUTE_INCOMPLETE: "Configured provider and model are required; no implicit route or fallback.",
	CREDENTIAL_INTERFACE_UNSUPPORTED: "Selected route needs an unsupported credential interface or grant.",
	CREDENTIAL_UNAVAILABLE: "Selected provider credential is unavailable; no fallback.",
	MODEL_REPLACEMENT_UNCONTROLLABLE: "This runtime can replace the selected model after model-not-found; no launch.",
	ROUTE_SELECTOR_UNSUPPORTED: "Automatic or multi-model selection is unsupported; select a concrete model.",
	COMMAND_EXECUTION_REQUIRED: "Selected provider requires command execution, incompatible with commands-none.",
	CONFIG_INVALID: "Native configuration is invalid or contains unknown requirements.",
	RUNTIME_UNSUPPORTED: "Native runtime is unsupported; require Swival 1.0.46 and LiteLLM 1.103.4.",
	TRANSPORT_REQUIREMENT_UNSUPPORTED: "Unsupported native transport proxy requirements.",
	ENDPOINT_REQUIREMENT_UNSUPPORTED: "Selected or ambient endpoint requirements are unsupported; no fallback.",
	PROJECT_ROUTING_UNSUPPORTED: "Project-supplied native routing is unsupported.",
};
const policyFields = new Set(["encrypt_secrets", "secret_shield", "llm_filter", "extra_body", "user_agent", "prompt_cache",
	"sanitize_thinking", "show_thinking", "sandbox_strict_read", "sandbox_session", "lifecycle_fail_closed",
	"reasoning_effort_all_phases", "retries_all_phases", "retries", "network", "files", "sandbox", "max_context_tokens",
	"nono_profile", "nono_rollback", "nono_block_net", "nono_allow_domain", "nono_network_profile", "nono_credential", "nono_audit_integrity"]);

export function parseNativePreflight(output: string, success: boolean): { route: NativeRoute; scope?: unknown } {
	let value: unknown;
	try { value = JSON.parse(output); } catch { throw routeFailure(); }
	if (isPlainRecord(value) && value.ok === false && hasOnlyFields(value, new Set(["ok", "reason", "field"]))) {
		let message = typeof value.reason === "string" && Object.hasOwn(preflightReasons, value.reason) ? preflightReasons[value.reason] : undefined;
		if (value.reason === "POLICY_NOT_PROPAGATED" && typeof value.field === "string" && policyFields.has(value.field)) {
			message = `Required policy ${value.field} is not propagated to every native phase.`;
		} else if (value.field !== undefined && !["api_key", ...policyFields].includes(value.field)) message = undefined;
		if (message) throw new Error(`Native audit configuration preflight failed: ${message} No native worker/provider was started.`);
		throw routeFailure();
	}
	if (!success || !isPlainRecord(value)) throw routeFailure();
	const { scope, ...route } = value;
	return { route: parseNativeRoute(route), ...(scope === undefined ? {} : { scope }) };
}

function nativePreflight(executable: string, cwd: string, request: string, env: NodeJS.ProcessEnv) {
	return new Promise<{ route: NativeRoute; scope?: unknown }>((resolve, reject) => {
		const child = execFile(executable, ["-I", "-B", path.join(scriptRoot, "native_audit.py"), "--preflight"],
			{ cwd, env, timeout: 10_000, maxBuffer: 64 * 1024, encoding: "utf8", shell: false }, (error, stdout) => {
				try { resolve(parseNativePreflight(stdout, !error)); } catch (failure) { reject(failure); }
			});
		child.stdin?.on("error", () => {}); child.stdin?.end(request);
	});
}

/** Fixed Git plumbing only. No checkout, archive, source hook, filter, or lazy fetch. */
export function gitEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
	return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1",
		GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" };
}

export function boundedExec(executable: string, args: string[], cwd: string, input?: string | Buffer,
	env = process.env, timeout = 5000, maxBuffer = 8 * 1024 * 1024): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = execFile(executable, args, { cwd, env, timeout, maxBuffer, encoding: "buffer", shell: false },
			(error, stdout) => { if (error) reject(new Error(`Native audit local ${path.basename(executable)} check failed.`)); else resolve(stdout); });
		child.stdin?.on("error", () => {});
		child.stdin?.end(input);
	});
}

const gitArgs = (args: string[]) => ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
	"-c", "core.attributesFile=/dev/null", "-c", "commit.gpgsign=false", "-c", "protocol.allow=never", ...args];
interface TrustedGit { executable: string; env: NodeJS.ProcessEnv }
const runGit = (trusted: TrustedGit, cwd: string, args: string[], input?: Buffer | string) =>
	boundedExec(trusted.executable, gitArgs(args), cwd, input, trusted.env);

export interface SnapshotManifest {
	sourceRoot: string;
	sourceGitDir: string;
	sourceWorktreeGitDir: string;
	sourceCommit: string;
	sourceTree: string;
	snapshotCommit: string;
	files: string[];
	excluded: string;
}

export async function sourceIdentity(cwd: string, trusted: TrustedGit) {
	const git = (dir: string, args: string[]) => runGit(trusted, dir, args);
	const sourceRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).toString().trim();
	const sourceGitDir = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toString().trim();
	const sourceWorktreeGitDir = (await git(cwd, ["rev-parse", "--absolute-git-dir"])).toString().trim();
	return { sourceRoot: await fs.realpath(sourceRoot), sourceGitDir: await fs.realpath(sourceGitDir),
		sourceWorktreeGitDir: await fs.realpath(sourceWorktreeGitDir) };
}

/** AgentFS v0.6.4 cli/src/sandbox/darwin.rs:98–157, commit 3a5ed2b88e5d. */
export function agentfsDarwinWriteRoots(home: string, session: string): string[] {
	return ["/private/tmp", "/tmp", "/var/tmp", "/private/var/folders", "/dev", "/private/var/db/mds",
		path.join(home, "Library"), "/Library/Preferences", "/Library/Keychains",
		path.join(home, ".agentfs", "run", session)];
}

export async function assertNativeSourceIsolation(protectedRoots: string[], writableRoots: string[]): Promise<void> {
	const protectedPaths = await Promise.all(protectedRoots.map((root) => fs.realpath(root)));
	for (const writable of writableRoots) {
		const target = await canonicalFuturePath(writable);
		for (const source of protectedPaths) {
			if (await pathIsWithin(source, target) || await pathIsWithin(target, source)) {
				throw new Error("Native source/Git overlaps an upstream built-in writable path. Use a repository outside AgentFS write exceptions.");
			}
		}
	}
}

const secretPath = (file: string) => file.split("/").some((part) =>
	/^\.env(?:\.|$)|\.(?:pem|key)$/i.test(part) || [".ssh", ".aws", ".gnupg", ".git-credentials"].includes(part));
const unsafePath = (file: string) => {
	const folded = file.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
	return /[\x00-\x1f\x7f\\]/.test(file) || path.isAbsolute(file) ||
		file.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
		["audit-findings", ".swival/audit", "native-cli-report.json"]
			.some((reserved) => folded === reserved || folded.startsWith(reserved + "/"));
};

export async function createCommittedSnapshot(cwd: string, destination: string,
	selectedGit?: TrustedGit): Promise<SnapshotManifest> {
	const trusted = selectedGit ?? await resolveTrustedGit(cwd, captureNativeRuntime());
	const git = (dir: string, args: string[], input?: Buffer | string) => runGit(trusted, dir, args, input);
	const identity = await sourceIdentity(cwd, trusted);
	const dest = path.resolve(destination);
	for (const source of [identity.sourceRoot, identity.sourceGitDir, identity.sourceWorktreeGitDir]) {
		if (await pathIsWithin(dest, source) || await pathIsWithin(source, dest)) {
			throw new Error("Native audit snapshot must be outside source checkout and Git metadata.");
		}
	}
	const sourceCommit = (await git(identity.sourceRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).toString().trim();
	const sourceTree = (await git(identity.sourceRoot, ["rev-parse", `${sourceCommit}^{tree}`])).toString().trim();
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCommit) || !/^[a-f0-9]+$/.test(sourceTree)) throw new Error("Unsupported Git object identity.");
	const listing = (await git(identity.sourceRoot, ["ls-tree", "-r", "-t", "-z", sourceTree])).toString("utf8");
	const entries = listing.split("\0").filter(Boolean).map((line) => {
		const match = /^(\d+) (blob|tree|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
		if (!match) throw new Error("Unsupported Git tree entry.");
		const [, mode, type, oid, file] = match;
		if (unsafePath(file) || file.includes("\ufffd") || !["040000", "100644", "100755"].includes(mode)) throw new Error("Unsupported native audit path or file mode.");
		if (secretPath(file)) throw new Error("Native audit refuses secret-shaped tracked paths.");
		return { mode, type, oid, file };
	});
	if (entries.length > 4096) throw new Error("Native audit snapshot exceeds the 4096-entry limit.");
	const objects = new Map<string, { type: string; bytes: Buffer }>();
	objects.set(sourceTree, { type: "tree", bytes: Buffer.alloc(0) });
	for (const entry of entries) objects.set(entry.oid, { type: entry.type, bytes: Buffer.alloc(0) });
	let total = 0;
	const preparationDeadline = Date.now() + 120_000;
	for (const [oid, object] of objects) {
		if (Date.now() > preparationDeadline) throw new Error("Native committed snapshot preparation exceeded its two-minute budget.");
		const size = Number((await git(identity.sourceRoot, ["cat-file", "-s", oid])).toString().trim());
		total += size;
		if (!Number.isSafeInteger(size) || size > 8 * 1024 * 1024 || total > 64 * 1024 * 1024) throw new Error("Native audit snapshot exceeds object resource limits.");
		object.bytes = await git(identity.sourceRoot, ["cat-file", object.type, oid]);
		if (object.type === "blob" && /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})/.test(object.bytes.toString("utf8"))) {
			throw new Error("Native audit refuses recognized credential content; protected routes are unsupported.");
		}
	}
	await fs.mkdir(dest, { mode: 0o700 });
	await git(dest, ["init", "--template=", `--object-format=${sourceTree.length === 64 ? "sha256" : "sha1"}`]);
	for (const [oid, object] of objects) {
		if (Date.now() > preparationDeadline) throw new Error("Native committed snapshot preparation exceeded its two-minute budget.");
		const imported = (await git(dest, ["hash-object", "-w", "-t", object.type, "--stdin"], object.bytes)).toString().trim();
		if (imported !== oid) throw new Error("Native audit object identity changed during import.");
	}
	const env = { ...trusted.env, GIT_AUTHOR_NAME: "Native audit snapshot", GIT_AUTHOR_EMAIL: "audit@example.invalid",
		GIT_COMMITTER_NAME: "Native audit snapshot", GIT_COMMITTER_EMAIL: "audit@example.invalid",
		GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };
	const snapshotCommit = (await boundedExec(trusted.executable, gitArgs(["commit-tree", sourceTree]), dest,
		"Independent committed audit snapshot\n", env)).toString().trim();
	await git(dest, ["update-ref", "HEAD", snapshotCommit]);
	await git(dest, ["read-tree", snapshotCommit]);
	for (const entry of entries.filter((e) => e.type === "blob")) {
		const target = path.join(dest, entry.file);
		await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
		await fs.writeFile(target, objects.get(entry.oid)!.bytes, { mode: entry.mode === "100755" ? 0o700 : 0o600, flag: "wx" });
	}
	// Upstream reads audit configuration from the working copy. Keep its committed
	// tree as evidence, but do not activate repository-supplied runtime settings.
	await fs.writeFile(path.join(dest, "swival.toml"), "# Native audit runtime configuration is inert.\n", { mode: 0o600 });
	return { ...identity, sourceCommit, sourceTree, snapshotCommit,
		files: entries.filter((e) => e.type === "blob").map((e) => e.file),
		excluded: "All staged, unstaged, and untracked content is excluded; only the committed tree is imported." };
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
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts");
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
const nativeLifecycle = createRequire(import.meta.url)(path.join(scriptRoot, "native-audit-lifecycle.cjs")) as {
	readNativeTerminal: (runDir: string) => NativeTerminal | undefined;
	regularBytes: (root: string, target: string, limit: number) => Buffer;
	finalizeNativeAudit: (options: { runDir: string; ownership?: NativeOwnership;
		closeLogs?: (shutdown: string) => Promise<void>; cancellationReason?: () => string | undefined },
		outcome: { exitCode: number; stopped?: string }) => Promise<NativeTerminal>;
};
export const { readNativeTerminal, finalizeNativeAudit } = nativeLifecycle;
const executable = (name: string): string | undefined => {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!path.isAbsolute(dir)) continue;
		const candidate = path.join(dir, name);
		try { fsSync.accessSync(candidate, fsSync.constants.X_OK); return candidate; } catch { /* next */ }
	}
	return undefined;
};

/** Capture installation paths and environment at registration, never from tool arguments. */
export function captureNativeRuntime(configuredPython?: string): NativeRuntime {
	const cli = executable("swival");
	let python = configuredPython;
	if (!python && cli) {
		try {
			const stat = fsSync.statSync(cli);
			if (stat.isFile() && stat.size < 64 * 1024) {
				const contents = fsSync.readFileSync(cli, "utf8");
				if (contents.includes("from swival.agent import main")) python = contents.split("\n")[0].slice(2);
			}
		} catch { /* unavailable installation */ }
	}
	if (!python || !path.isAbsolute(python) || !/^python(?:\d+(?:\.\d+)*)?$/.test(path.basename(python))) python = undefined;
	return { python, cli, agentfs: executable("agentfs"), nono: executable("nono"), git: executable("git"),
		searchPath: process.env.PATH, environment: { ...process.env } };
}

/** Check every symlink hop before Git or Python can load repository-controlled code. */
async function assertTrustedRuntimePath(location: string, roots: string[]): Promise<void> {
	const identities = await Promise.all(roots.map((root) => fs.stat(root)));
	let current = path.parse(location).root;
	let pending = location.slice(current.length).split(path.sep);
	let links = 0;
	while (pending.length) {
		const component = pending.shift()!;
		if (!component || component === ".") continue;
		if (component === "..") { current = path.dirname(current); continue; }
		current = path.join(current, component);
		if (roots.some((root) => current === root || current.startsWith(root + path.sep))) {
			throw new Error("Native audit refuses repository-owned runtime paths.");
		}
		const stat = await fs.lstat(current);
		if (identities.some((root) => stat.dev === root.dev && stat.ino === root.ino)) {
			throw new Error("Native audit refuses repository-owned runtime paths.");
		}
		if (stat.isSymbolicLink()) {
			if (++links > 40) throw new Error("Native runtime symlink limit exceeded.");
			const target = await fs.readlink(current);
			current = path.isAbsolute(target) ? path.parse(target).root : path.dirname(current);
			pending = [...target.slice(path.isAbsolute(target) ? current.length : 0).split(path.sep), ...pending];
		}
	}
}

/** Validate startup selections without executing Git or any repository code. */
async function resolveTrustedGit(cwd: string, runtime: NativeRuntime): Promise<TrustedGit> {
	if (!runtime.git || !path.isAbsolute(runtime.git)) throw new Error("Native audit requires trusted startup Git.");
	const source = await fs.realpath(cwd);
	let metadata = path.join(source, ".git");
	const marker = await fs.stat(metadata);
	if (marker.isFile()) {
		if (marker.size > 4096) throw new Error("Unsupported native Git metadata.");
		const match = /^gitdir: ([^\r\n]+)\s*$/.exec(await fs.readFile(metadata, "utf8"));
		if (!match) throw new Error("Unsupported native Git metadata.");
		metadata = path.resolve(source, match[1]);
	}
	metadata = await fs.realpath(metadata);
	const roots = [source, path.resolve(cwd), metadata];
	try {
		const commonFile = path.join(metadata, "commondir");
		const stat = await fs.lstat(commonFile);
		if (!stat.isFile() || stat.size > 4096) throw new Error("Unsupported native Git metadata.");
		roots.push(await fs.realpath(path.resolve(metadata, (await fs.readFile(commonFile, "utf8")).trim())));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const search: string[] = [];
	for (const entry of (runtime.searchPath ?? "").split(path.delimiter)) {
		if (!path.isAbsolute(entry)) throw new Error("Native audit refuses relative executable search paths.");
		try {
			await assertTrustedRuntimePath(entry, roots);
			search.push(await fs.realpath(entry));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	await assertTrustedRuntimePath(runtime.git, roots);
	const executablePath = await fs.realpath(runtime.git);
	await fs.access(executablePath, fsSync.constants.X_OK);
	if (!(await fs.stat(executablePath)).isFile()) throw new Error("Unsupported native Git executable.");
	return { executable: executablePath, env: { ...gitEnvironment(), PATH: search.join(path.delimiter) } };
}


export interface NativeAuditLaunch {
	route: NativeRoute;
	meta: RunMeta;
	proc: ChildProcess;
	completion: Promise<NativeTerminal>;
	cancel: (reason?: string) => void;
}

export async function prepareNativeAudit(
	cwd: string, params: Record<string, unknown>, audit: NativeAuditOptions, runtime: NativeRuntime,
	artifactDir: string, runId: string, maxTimeoutMs: number, signal?: AbortSignal,
): Promise<NativeAuditLaunch> {
	const checkCancelled = () => { if (signal?.aborted) throw new Error("Native audit was cancelled before launch."); };
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
			for (const root of protectedRoots) {
				// A normal home containing the repository is valid; only refuse roots
				// at or beneath source/Git, not ancestors of those protected paths.
				if (await pathIsWithin(canonical, root)) throw new Error();
			}
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
	if (process.platform === "darwin") {
		await assertNativeSourceIsolation(protectedRoots, agentfsDarwinWriteRoots(input.HOME!, session));
	}
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
	const preflightEnv = nativePreflightEnvironment(input, trustedGit.env.PATH!);
	const routing: Record<string, unknown> = {};
	for (const field of NATIVE_FIELDS) {
		if (field.endsWith("Override") && params[field] !== undefined) routing[field.slice(0, -8)] = params[field];
	}
	const request: Record<string, any> = { source: identity.sourceRoot, routing, audit };
	const preflight = async () => {
		await assertRuntimePaths();
		return nativePreflight(python, identity.sourceRoot, JSON.stringify(request), preflightEnv);
	};
	const { route } = await preflight();
	checkCancelled();
	const env = nativeEnvironment(input, trustedGit.env.PATH!, route.provider);
	const authStore = route.provider === "chatgpt" ? await prepareNativeAuthStore(input, [...protectedRoots, runDir]) : undefined;
	if (authStore) {
		env.CHATGPT_TOKEN_DIR = authStore.directory;
		env.CHATGPT_AUTH_FILE = authStore.filename;
	}
	await assertRuntimePaths();
	if (!(await boundedExec(agentfs, ["--version"], cwd, undefined, env, 5000, 16384)).toString().match(/(?:^|\s)v?0\.6\.4(?:\s|$)/)) {
		throw new Error("Native audit requires tested AgentFS 0.6.4. No fallback.");
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
	let args: string[];
	const meta: RunMeta = { runId, agent: "native-audit", task: "/audit (committed source-only scope)",
		startedAt: Date.now(), pid: undefined, artifactDir: runDir, stdoutFile: path.join(runDir, "diagnostics.json"),
		stderrFile: path.join(runDir, "diagnostics.json"), nativeAuditRequested: true };
	try {
		const manifest = await createCommittedSnapshot(cwd, snapshot, trustedGit);
		request.snapshot = snapshot;
		const { scope, route: secondRoute } = await preflight();
		if (!isDeepStrictEqual(route, secondRoute)) throw new Error("Native route changed during preparation. No fallback.");
		if (!isPlainRecord(scope) || !scope.mandatory_files?.length) throw new Error("No auditable committed files in scope.");
		checkCancelled();
		const config = path.join(runDir, "config");
		await fs.mkdir(path.join(config, "swival"), { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(config, "swival", "config.toml"), "# Inert native configuration.\n", { mode: 0o600 });
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
	} catch (error) {
		await fs.rm(runDir, { recursive: true, force: true });
		throw error;
	}
	const proc = spawn(agentfs, buildNativeAgentfsArgs(cli, snapshot, authStore?.directory, session, args), {
		cwd: snapshot, env, shell: false, detached: true,
		stdio: ["ignore", "pipe", "pipe"] });
	meta.pid = proc.pid;
	const diagnostics = { bytes: 0, closed: false, expansionFailures: 0, ambiguous: false,
		authPersistenceFailure: false, adjudicationFailure: false, adjudicationRepairFailure: false };
	const pending = ["", ""];
	const streamState = pending.map(() => ({ adjudicating: false, terminalPrefix: false }));
	let stopped: string | undefined;
	let finalization: Promise<NativeTerminal> | undefined;
	let settle!: (terminal: NativeTerminal) => void;
	let fail!: (error: unknown) => void;
	const completion = new Promise<NativeTerminal>((resolve, reject) => { settle = resolve; fail = reject; });
	const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
	const consumeLine = (line: string, index: number) => {
		// LiteLLM 1.103.4 prints this fixed header before its device-code challenge.
		if (line.trim() === "Sign in with ChatGPT using device code:") {
			cancel("Native ChatGPT login is required. Authenticate with upstream Swival outside Pi, then rerun the audit.");
		}
		if (line.includes("Failed to write ChatGPT auth file")) {
			diagnostics.authPersistenceFailure = true;
			cancel("Native ChatGPT auth-state persistence failed; completion is refused.");
		}
		const text = line.trim();
		const state = streamState[index];
		// Rich wraps these fixed markers between words, even on non-TTY streams.
		if (/\b(?:reviewer|consolidate)\s+error:/.test(line) ||
			(state.terminalPrefix && text.startsWith("error:"))) diagnostics.adjudicationFailure = true;
		state.terminalPrefix = /\b(?:reviewer|consolidate)\s*$/.test(line);
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
		finalization = finalizeNativeAudit({ runDir, cancellationReason: () => stopped,
			ownership: proc.pid ? { signal: (value) => process.kill(-proc.pid!, value), verify: async () =>
				!(await boundedExec(agentfs, ["ps"], runDir, undefined, env, 5000, 65536)).toString().includes(session) } : undefined,
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
			if (diagnostics.bytes > 2 * 1024 * 1024) { cancel("Native diagnostics exceeded the 2 MiB cap."); return; }
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

export interface NativeAuditResult {
	route?: NativeRoute;
	status: "completed" | "failed" | "partial" | "empty_scope";
	answer?: string;
	error?: string;
	statePath?: string;
}

async function regularJson(file: string, root: string): Promise<Record<string, any>> {
	return JSON.parse(nativeLifecycle.regularBytes(root, file, 8 * 1024 * 1024).toString("utf8"));
}

type ReleasedFindingRecord = {
	title: string; finding_type: string; severity: string; locations: string[];
	preconditions: string[]; proof: string[]; fix_outline: string; source_file: string;
	triage_decision: string | null; threat_model: string;
};
const findingFields = new Set(["title", "finding_type", "severity", "locations", "preconditions",
	"proof", "fix_outline", "source_file", "triage_decision", "threat_model"]);
const isPlainRecord = (value: unknown): value is Record<string, any> => value !== null &&
	typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const hasOnlyFields = (value: Record<string, any>, fields: Set<string>) =>
	Object.keys(value).every((key) => fields.has(key));
const stringList = (value: unknown): value is string[] => Array.isArray(value) &&
	value.every((item) => typeof item === "string");

function releasedFinding(value: unknown): ReleasedFindingRecord | undefined {
	if (!isPlainRecord(value) || !hasOnlyFields(value, findingFields)) return undefined;
	const triage = Object.hasOwn(value, "triage_decision") ? value.triage_decision : null;
	const threat = Object.hasOwn(value, "threat_model") ? value.threat_model : "";
	if (!["title", "finding_type", "severity", "fix_outline", "source_file"].every(
		(key) => typeof value[key] === "string") || !stringList(value.locations) ||
		!stringList(value.preconditions) || !stringList(value.proof) ||
		!(triage === null || typeof triage === "string") || typeof threat !== "string") return undefined;
	return { title: value.title, finding_type: value.finding_type, severity: value.severity,
		locations: value.locations, preconditions: value.preconditions, proof: value.proof,
		fix_outline: value.fix_outline, source_file: value.source_file,
		triage_decision: triage, threat_model: threat };
}

const pythonAsciiString = (value: string) => JSON.stringify(value).replace(/[\u007f-\uffff]/g,
	(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
const pythonStringList = (value: string[]) => `[${value.map(pythonAsciiString).join(", ")}]`;

/** Match Swival 1.0.46 `_finding_key` for the released FindingRecord schema only. */
export function nativeFindingKey(value: unknown): string | undefined {
	const finding = releasedFinding(value);
	if (!finding) return undefined;
	const fields: [string, string][] = [
		["finding_type", pythonAsciiString(finding.finding_type)],
		["fix_outline", pythonAsciiString(finding.fix_outline)],
		["locations", pythonStringList(finding.locations)],
		["preconditions", pythonStringList(finding.preconditions)],
		["proof", pythonStringList(finding.proof)],
		["severity", pythonAsciiString(finding.severity)],
		["source_file", pythonAsciiString(finding.source_file)],
		["threat_model", pythonAsciiString(finding.threat_model)],
		["title", pythonAsciiString(finding.title)],
		["triage_decision", finding.triage_decision === null ? "null" : pythonAsciiString(finding.triage_decision)],
	];
	const serialized = `{${fields.map(([key, encoded]) => `${pythonAsciiString(key)}: ${encoded}`).join(", ")}}`;
	return createHash("sha256").update(serialized, "utf8").digest("hex").slice(0, 12);
}

type ReleasedAdjudicationDrop = { title: string; severity: string; source_file: string; reason: string };
const adjudicationDropFields = new Set(["title", "severity", "source_file", "reason"]);
const MAX_VERIFIED_LINEAGE_FINDINGS = 512;
const MAX_LINEAGE_RESIDUAL_EDGE_VISITS = 1_000_000;

function releasedAdjudicationDrops(value: unknown): ReleasedAdjudicationDrop[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const drops: ReleasedAdjudicationDrop[] = [];
	for (const item of value) {
		if (!isPlainRecord(item) || !hasOnlyFields(item, adjudicationDropFields) ||
			![...adjudicationDropFields].every((field) => Object.hasOwn(item, field) && typeof item[field] === "string")) {
			return undefined;
		}
		drops.push({ title: item.title, severity: item.severity, source_file: item.source_file, reason: item.reason });
	}
	return drops;
}

const survivorProjection = (finding: ReleasedFindingRecord) => JSON.stringify([
	finding.locations, finding.proof, finding.source_file, finding.triage_decision,
]);
const dropProjection = (finding: ReleasedFindingRecord | ReleasedAdjudicationDrop) => JSON.stringify([
	finding.title, finding.severity, finding.source_file,
]);

type ResidualEdge = { to: number; reverse: number; capacity: number };

/** Check existence of a one-to-one released Phase 4.5 lineage without claiming a unique historical assignment. */
function hasFeasibleFindingLineage(verifiedProposals: ReleasedFindingRecord[], survivors: ReleasedFindingRecord[],
	drops: ReleasedAdjudicationDrop[]): boolean {
	if (verifiedProposals.length > MAX_VERIFIED_LINEAGE_FINDINGS ||
		verifiedProposals.length !== survivors.length + drops.length) return false;
	const cells = new Map<string, Map<string, number>>();
	const survivorDemand = new Map<string, number>();
	const dropDemand = new Map<string, number>();
	const dropCapacity = new Map<string, number>();
	for (const proposal of verifiedProposals) {
		const survivor = survivorProjection(proposal);
		const drop = dropProjection(proposal);
		const row = cells.get(survivor) ?? new Map<string, number>();
		row.set(drop, (row.get(drop) ?? 0) + 1);
		cells.set(survivor, row);
		dropCapacity.set(drop, (dropCapacity.get(drop) ?? 0) + 1);
	}
	for (const survivor of survivors) {
		const projection = survivorProjection(survivor);
		survivorDemand.set(projection, (survivorDemand.get(projection) ?? 0) + 1);
	}
	for (const drop of drops) {
		const projection = dropProjection(drop);
		dropDemand.set(projection, (dropDemand.get(projection) ?? 0) + 1);
	}
	const survivorColumns = new Map<string, number>();
	for (const projection of new Set([...dropCapacity.keys(), ...dropDemand.keys()])) {
		const demand = dropDemand.get(projection) ?? 0;
		const capacity = dropCapacity.get(projection) ?? 0;
		if (demand > capacity) return false;
		survivorColumns.set(projection, capacity - demand);
	}
	if ([...survivorColumns.values()].reduce((sum, value) => sum + value, 0) !== survivors.length) return false;

	const survivorRows = [...new Set([...cells.keys(), ...survivorDemand.keys()])];
	const dropColumns = [...survivorColumns.keys()];
	const source = 0;
	const rowStart = 1;
	const columnStart = rowStart + survivorRows.length;
	const sink = columnStart + dropColumns.length;
	const graph: ResidualEdge[][] = Array.from({ length: sink + 1 }, () => []);
	const addEdge = (from: number, to: number, capacity: number) => {
		const forward = { to, reverse: graph[to].length, capacity };
		const reverse = { to: from, reverse: graph[from].length, capacity: 0 };
		graph[from].push(forward);
		graph[to].push(reverse);
	};
	const rowNodes = new Map(survivorRows.map((projection, index) => [projection, rowStart + index]));
	const columnNodes = new Map(dropColumns.map((projection, index) => [projection, columnStart + index]));
	for (const projection of survivorRows) addEdge(source, rowNodes.get(projection)!, survivorDemand.get(projection) ?? 0);
	for (const [survivor, row] of cells) {
		for (const [drop, capacity] of row) addEdge(rowNodes.get(survivor)!, columnNodes.get(drop)!, capacity);
	}
	for (const [projection, demand] of survivorColumns) addEdge(columnNodes.get(projection)!, sink, demand);

	let edgeVisits = 0;
	let flow = 0;
	while (flow < survivors.length) {
		const levels = Array<number>(graph.length).fill(-1);
		const queue = [source];
		levels[source] = 0;
		for (let index = 0; index < queue.length; index++) {
			const node = queue[index];
			for (const edge of graph[node]) {
				if (++edgeVisits > MAX_LINEAGE_RESIDUAL_EDGE_VISITS) return false;
				if (edge.capacity > 0 && levels[edge.to] < 0) {
					levels[edge.to] = levels[node] + 1;
					queue.push(edge.to);
				}
			}
		}
		if (levels[sink] < 0) return false;
		const next = Array<number>(graph.length).fill(0);
		const send = (node: number, available: number): number => {
			if (node === sink) return available;
			for (; next[node] < graph[node].length; next[node]++) {
				const edge = graph[node][next[node]];
				if (++edgeVisits > MAX_LINEAGE_RESIDUAL_EDGE_VISITS) return 0;
				if (edge.capacity <= 0 || levels[edge.to] !== levels[node] + 1) continue;
				const sent = send(edge.to, Math.min(available, edge.capacity));
				if (sent > 0) {
					edge.capacity -= sent;
					graph[edge.to][edge.reverse].capacity += sent;
					return sent;
				}
			}
			return 0;
		};
		for (let sent = send(source, survivors.length - flow); sent > 0;
			sent = send(source, survivors.length - flow)) flow += sent;
		if (edgeVisits > MAX_LINEAGE_RESIDUAL_EDGE_VISITS) return false;
	}
	return true;
}

export async function inspectNativeAudit(artifactDir: string, exitCode: number): Promise<NativeAuditResult> {
	try {
		const completed = readNativeTerminal(artifactDir);
		if (!completed) return { status: "failed", error: "Native audit state is unknown: no valid terminal evidence." };
		const failures = [completed.stopped, completed.shutdownFailure, completed.preservationFailure,
			completed.cleanupFailure, completed.persistenceFailure].filter(Boolean);
		if (failures.length || completed.shutdown !== "verified" || completed.boundary !== "agentfs-cli") {
			return { status: "failed", error: failures.join(" ") || "Native shutdown was not verified; resources are retained." };
		}
		if (exitCode !== 0 || completed.exitCode !== 0) return { status: "failed", error: "Native CLI exited unsuccessfully." };
		const manifest = await regularJson(path.join(artifactDir, "manifest.json"), artifactDir);
		const report = await regularJson(path.join(artifactDir, "evidence", "native-cli-report.json"), artifactDir);
		const diagnostics = await regularJson(path.join(artifactDir, "diagnostics.json"), artifactDir);
		if (diagnostics.closed !== true || !Number.isSafeInteger(diagnostics.bytes) || diagnostics.bytes < 1 ||
			diagnostics.bytes > 2 * 1024 * 1024 || diagnostics.ambiguous !== false ||
			diagnostics.authPersistenceFailure !== false || typeof diagnostics.adjudicationFailure !== "boolean" ||
			typeof diagnostics.adjudicationRepairFailure !== "boolean" ||
			!Number.isSafeInteger(diagnostics.expansionFailures) || diagnostics.expansionFailures < 0) {
			return { status: "failed", error: "Native diagnostics are missing, truncated, or ambiguous." };
		}
		if (diagnostics.adjudicationFailure) return { status: "partial", error: "Native audit has terminal adjudication failures." };
		if (diagnostics.adjudicationRepairFailure) return { status: "partial",
			error: "Native adjudication completeness cannot be verified after exhausted format repair." };
		if (diagnostics.expansionFailures > 0) return { status: "partial", error: "Native audit lost findings to unrecovered expansion failures." };
		const route = parseNativeRoute(manifest.route);
		if (manifest.sandbox !== "agentfs" || !/^native-[a-f0-9]{32}$/.test(manifest.session) ||
			report.version !== 1 || report.task !== manifest.command || report.provider !== route.reportIdentity.provider ||
			report.model !== route.reportIdentity.model ||
			report.result?.outcome !== "success" || report.result.exit_code !== 0 ||
			report.sandbox?.mode !== "builtin" || report.sandbox.session !== undefined ||
			report.network !== "provider-only" || report.settings?.commands !== "none" || report.settings.files !== "some" ||
			report.settings.instructions_status !== "disabled" || !Array.isArray(report.settings.skills_discovered) ||
			report.settings.skills_discovered.length || typeof report.result.answer !== "string" || !report.result.answer.trim()) {
			return { status: "failed", error: "Native CLI route, policy, or result evidence does not match preparation." };
		}
		const scope = manifest.scope;
		const statesDir = path.join(artifactDir, "evidence", "native-state");
		const entries = await fs.readdir(statesDir);
		if (entries.length !== 1 || !/^[a-f0-9]{8}$/.test(entries[0])) throw new Error("Expected one new native audit state.");
		const statePath = path.join(statesDir, entries[0], "state.json");
		const state = await regularJson(statePath, artifactDir);
		if (scope.commit !== manifest.snapshotCommit || !isDeepStrictEqual(state.scope, scope) ||
			!stringList(scope.tracked_files) || !stringList(manifest.files) ||
			!scope.tracked_files.every((file: string) => manifest.files.includes(file))) {
			throw new Error("Native snapshot/scope identity mismatch.");
		}
		const mandatory = scope.mandatory_files;
		if (!Array.isArray(mandatory) || !mandatory.length) return { status: "empty_scope", error: "No auditable committed files in scope." };
		const covers = (wanted: unknown, actual: unknown) => Array.isArray(wanted) && Array.isArray(actual) &&
			wanted.every((file) => actual.includes(file));
		if (state.phase !== "done" || !covers(mandatory, state.reviewed_files) ||
			!isPlainRecord(state.metrics) || !isPlainRecord(state.truncated_files) ||
			!Number.isSafeInteger(state.metrics.phase1_profile_failures ?? 0) ||
			(state.metrics.phase1_profile_failures ?? 0) < 0 ||
			!stringList(state.candidate_files) ||
			!covers(state.candidate_files, state.deep_reviewed_files) ||
			(manifest.audit?.all && !covers(mandatory, state.deep_reviewed_files)) ||
			Object.keys(state.truncated_files ?? {}).length || (state.metrics?.phase1_profile_failures ?? 0) > 0) {
			return { status: "partial", error: "Native audit has incomplete or truncated coverage.", statePath };
		}
		const incomplete = () => ({ status: "partial" as const,
			error: "Native verification/artifact coverage is incomplete.", statePath });
		if (!Array.isArray(state.proposed_findings) || !Array.isArray(state.verified_findings) ||
			!isPlainRecord(state.verification_state) || !isPlainRecord(state.artifact_state)) return incomplete();
		const proposedFindings = state.proposed_findings.map(releasedFinding);
		const proposedKeys = state.proposed_findings.map(nativeFindingKey);
		if (proposedFindings.some((finding: ReleasedFindingRecord | undefined) => finding === undefined) ||
			proposedKeys.some((key: string | undefined) => key === undefined) ||
			new Set(proposedKeys).size !== proposedKeys.length) return incomplete();
		const expectedProposalKeys = proposedKeys as string[];
		if (Object.keys(state.verification_state).length !== expectedProposalKeys.length ||
			expectedProposalKeys.some((key) => !Object.hasOwn(state.verification_state, key))) return incomplete();
		const verifiedProposals: ReleasedFindingRecord[] = [];
		for (let index = 0; index < expectedProposalKeys.length; index++) {
			const entry = state.verification_state[expectedProposalKeys[index]];
			if (!isPlainRecord(entry) || !["verified", "discarded"].includes(entry.status)) return incomplete();
			if (entry.status === "verified") verifiedProposals.push(proposedFindings[index]!);
		}
		const verifiedFields = new Set(["finding", "correctness_reason", "rebuttal_reason", "reproducer"]);
		const verifiedKeys: string[] = [];
		const survivorFindings: ReleasedFindingRecord[] = [];
		for (const verified of state.verified_findings) {
			if (!isPlainRecord(verified) || !hasOnlyFields(verified, verifiedFields) ||
				typeof verified.correctness_reason !== "string" || typeof verified.rebuttal_reason !== "string" ||
				!(verified.reproducer == null || isPlainRecord(verified.reproducer))) return incomplete();
			const finding = releasedFinding(verified.finding);
			const key = nativeFindingKey(verified.finding);
			if (!finding || !key) return incomplete();
			survivorFindings.push(finding);
			verifiedKeys.push(key);
		}
		const discardedValue = Object.hasOwn(state, "adjudication_discarded") ? state.adjudication_discarded : [];
		const adjudicationDrops = releasedAdjudicationDrops(discardedValue);
		if (!adjudicationDrops || !hasFeasibleFindingLineage(verifiedProposals, survivorFindings,
			adjudicationDrops)) return incomplete();
		if (new Set(verifiedKeys).size !== verifiedKeys.length ||
			Object.keys(state.artifact_state).length !== verifiedKeys.length ||
			verifiedKeys.some((key) => !Object.hasOwn(state.artifact_state, key))) return incomplete();
		const reportFilenames = new Set<string>();
		const patchFilenames = new Set<string>();
		for (const key of verifiedKeys) {
			const entry = state.artifact_state[key];
			if (!isPlainRecord(entry)) return incomplete();
			if (entry.status !== "written") return { status: "partial", error: "Native findings have unfinished artifacts.", statePath };
			for (const [field, extension] of [["report_filename", "md"], ["patch_filename", "patch"]]) {
				const name = entry[field];
				if (typeof name !== "string" || !new RegExp(`^[0-9]+-[a-zA-Z0-9_-]+\\.${extension}$`).test(name)) throw new Error("Unsupported native artifact filename.");
				const filenames = extension === "md" ? reportFilenames : patchFilenames;
				if (filenames.has(name)) return { status: "failed" as const,
					error: "Native artifact filenames are reused across findings.", statePath };
				filenames.add(name);
				const file = path.join(artifactDir, "evidence", "audit-findings", name);
				const stat = await fs.lstat(file);
				if ((await fs.realpath(file)) !== file || !stat.isFile() || stat.size > 8 * 1024 * 1024) {
					throw new Error("Missing regular bounded native report/patch pair.");
				}
				if (!(await fs.readFile(file, "utf8")).trim()) {
					return { status: "partial", error: `Native finding ${extension === "md" ? "report" : "patch"} is empty.`, statePath };
				}
			}
		}
		if (Object.hasOwn(state.metrics, "truncated_calls") && state.metrics.truncated_calls !== 0) {
			return { status: "partial", error: "Native audit has incomplete or truncated coverage.", statePath };
		}
		return { status: "completed", answer: report.result.answer, statePath };
	} catch { return { status: "failed", error: "Native audit lacks valid state, scope, or report/patch evidence." }; }
}
