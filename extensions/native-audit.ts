import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type { RunMeta } from "./index.js";

export interface NativeAuditOptions {
	paths: string[];
	all: boolean;
	workers: number;
	patchMaxTurns: number;
}

const NATIVE_FIELDS = new Set([
	"audit", "async", "timeoutMs", "maxInlineBytes", "profileOverride", "modelOverride",
	"providerOverride", "baseUrlOverride", "reasoningEffortOverride", "temperatureOverride",
	"topPOverride", "seedOverride", "maxTurnsOverride", "maxOutputTokensOverride",
	"providerTimeoutOverride",
]);

export function validateNativeAuditParams(params: Record<string, unknown>): NativeAuditOptions {
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
	return { sourceRoot: await fs.realpath(sourceRoot), sourceGitDir: await fs.realpath(sourceGitDir) };
}

const secretPath = (file: string) => file.split("/").some((part) =>
	/^\.env(?:\.|$)|\.(?:pem|key)$/i.test(part) || [".ssh", ".aws", ".gnupg", ".git-credentials"].includes(part));
const unsafePath = (file: string) => /[\x00-\x1f\x7f\\]/.test(file) || path.isAbsolute(file) ||
	file.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
	file === "audit-findings" || file.startsWith("audit-findings/") || file.startsWith(".swival/audit/");

export async function createCommittedSnapshot(cwd: string, destination: string,
	selectedGit?: TrustedGit): Promise<SnapshotManifest> {
	const trusted = selectedGit ?? await resolveTrustedGit(cwd, captureNativeRuntime());
	const git = (dir: string, args: string[], input?: Buffer | string) => runGit(trusted, dir, args, input);
	const identity = await sourceIdentity(cwd, trusted);
	const dest = path.resolve(destination);
	for (const source of [identity.sourceRoot, identity.sourceGitDir]) {
		if (dest === source || dest.startsWith(source + path.sep) || source.startsWith(dest + path.sep)) {
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
	python?: string; unshare?: string; bwrap?: string; nono?: string; git?: string; searchPath?: string;
}
const PINNED_UNSHARE_IDENTITY = Object.freeze({
	path: "/usr/bin/unshare",
	version: "unshare from util-linux 2.41.5",
	package: "util-linux",
	packageVersion: "2.41.5-0+deb13u1",
	architecture: "arm64",
	sha256: "285119fd3989039d50f8904b619b2abb8b795cb56753eb0235c8c031eb880a21",
});
const PINNED_BWRAP_IDENTITY = Object.freeze({
	path: "/usr/bin/bwrap",
	version: "bubblewrap 0.12.0",
	package: "bubblewrap",
	packageVersion: "0.12.0-1~deb13u1",
	architecture: "arm64",
	sha256: "b3b829e18a7d43ee589dc37e351cb9480ff7301b493d8227b8c754294638b976",
});
// Reviewed regular member of the authenticated 0.79.0 ARM64 GNU release archive
// with SHA-256 c4a4f4b9ae318574d30d352127a34dcc919c4d6682ee8fbd30bb8d2bd2e0e85d.
const PINNED_NONO_ARTIFACT_IDENTITY = Object.freeze({
	version: "0.79.0",
	architecture: "aarch64-unknown-linux-gnu",
	bytes: 26141064,
	sha256: "667fdaea93f77c9f8f45b04a80f4e2fb7e7d7fb104fa1da189ea38f41fbcf57b",
});
const pinnedNonoIdentity = (value: unknown, executable?: string): value is Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const identity = value as Record<string, unknown>;
	if (Object.keys(identity).sort().join(",") !== "architecture,bytes,path,sha256,version") return false;
	if (typeof identity.path !== "string" || !path.isAbsolute(identity.path) ||
		path.resolve(identity.path) !== identity.path || (executable !== undefined && identity.path !== executable)) return false;
	return Object.entries(PINNED_NONO_ARTIFACT_IDENTITY).every(([key, expected]) => identity[key] === expected);
};
// Nono 0.79.0 copies these reviewed jedisct1/swival@0.1.2 subjects
// byte-for-byte. Native evidence accepts no alternate policy serialization.
const PINNED_NONO_PROFILE_ARTIFACT_IDENTITIES = Object.freeze({
	manifest: Object.freeze({ bytes: 968,
		sha256: "c4873794dd83781a1309f4bbb5ca37c285d19728dcfc5be4c90edc748165dbd2" }),
	profile: Object.freeze({ bytes: 1747,
		sha256: "719a0a2396377cc9d05b2a9d4d2f39d8c0f07ba5080ff96e1619806794bf338c" }),
});
const PINNED_NONO_DEFAULT_POLICY_IDENTITY = Object.freeze({
	name: "default",
	source: "authenticated-nono-0.79.0-embedded-policy",
	extends: Object.freeze([]),
	nonoSha256: PINNED_NONO_ARTIFACT_IDENTITY.sha256,
});
const localNonoFileIdentity = (value: unknown, expectedPath: string,
	expected: Readonly<{ bytes: number; sha256: string }>): boolean => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const identity = value as Record<string, unknown>;
	return Object.keys(identity).sort().join(",") === "bytes,path,sha256" && identity.path === expectedPath &&
		identity.bytes === expected.bytes && identity.sha256 === expected.sha256;
};
const localNonoProfileIdentity = (value: unknown): value is Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const identity = value as Record<string, any>;
	if (Object.keys(identity).sort().join(",") !== "config,defaultPolicy,manifest,pack,profile" ||
		typeof identity.config !== "string" || typeof identity.pack !== "string" ||
		!path.isAbsolute(identity.config) || path.resolve(identity.config) !== identity.config ||
		identity.pack !== path.join(identity.config, "nono", "packages", "jedisct1", "swival")) return false;
	return localNonoFileIdentity(identity.manifest, path.join(identity.pack, "package.json"),
		PINNED_NONO_PROFILE_ARTIFACT_IDENTITIES.manifest) &&
		localNonoFileIdentity(identity.profile, path.join(identity.pack, "profiles", "swival.json"),
			PINNED_NONO_PROFILE_ARTIFACT_IDENTITIES.profile) &&
		isDeepStrictEqual(identity.defaultPolicy, PINNED_NONO_DEFAULT_POLICY_IDENTITY);
};
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts");
export interface NativeTerminal {
	exitCode: number;
	exitedAt: string;
	shutdown: "not-started" | "verified" | "unverified";
	boundary?: "bubblewrap-pidfd";
	stopped?: string;
	shutdownFailure?: string;
	preservationFailure?: string;
	cleanupFailure?: string;
	persistenceFailure?: string;
	retainedResources?: string[];
}
export interface NativeOwnership {
	/** Authority from a live ChildProcess or its inherited IPC channel, never disk. */
	signal: (signal: NodeJS.Signals | 0) => unknown;
	/** Live trusted supervisor proof, never a persisted PID or payload report. */
	verify?: () => Promise<boolean>;
}
interface NativeFinalizationOptions {
	runDir: string;
	ownership?: NativeOwnership;
	startupBarrier?: () => Promise<void>;
	closeLogs?: (shutdown: NativeTerminal["shutdown"]) => Promise<void> | void;
}
const nativeLifecycle = createRequire(import.meta.url)(path.join(scriptRoot, "native-audit-lifecycle.cjs")) as {
	readNativeTerminal: (runDir: string) => NativeTerminal | undefined;
	finalizeNativeAudit: (options: NativeFinalizationOptions,
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

/** Capture installation paths at registration, never from model arguments. */
export function captureNativeRuntime(configuredPython?: string): NativeRuntime {
	let python = configuredPython;
	if (!python) {
		const entry = executable("swival");
		if (entry) {
			try {
				const contents = fsSync.readFileSync(entry, "utf8");
				if (contents.includes("from swival.agent import main")) python = contents.split("\n")[0].slice(2);
			} catch { /* unavailable installation */ }
		}
	}
	if (!python || !path.isAbsolute(python) || !/^python(?:\d+(?:\.\d+)*)?$/.test(path.basename(python))) python = undefined;
	const unshareEntry = executable("unshare");
	let unshare: string | undefined;
	try { if (unshareEntry) unshare = fsSync.realpathSync(unshareEntry); } catch { /* unavailable installation */ }
	return { python, unshare, bwrap: executable("bwrap"), nono: executable("nono"),
		git: executable("git"), searchPath: process.env.PATH };
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
	const owned = (location: string) => roots.some((root) => location === root || location.startsWith(root + path.sep));
	const search: string[] = [];
	for (const entry of (runtime.searchPath ?? "").split(path.delimiter)) {
		if (!path.isAbsolute(entry)) throw new Error("Native audit refuses relative executable search paths.");
		if (owned(path.resolve(entry))) throw new Error("Native audit refuses repository-owned executable search paths.");
		try {
			const resolved = await fs.realpath(entry);
			if (owned(resolved)) throw new Error("Native audit refuses repository-owned executable search paths.");
			search.push(resolved);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const executablePath = await fs.realpath(runtime.git);
	if (owned(path.resolve(runtime.git)) || owned(executablePath)) {
		throw new Error("Native audit refuses repository-supplied Git executables.");
	}
	await fs.access(executablePath, fsSync.constants.X_OK);
	if (!(await fs.stat(executablePath)).isFile()) throw new Error("Unsupported native Git executable.");
	return { executable: executablePath, env: { ...gitEnvironment(), PATH: search.join(path.delimiter) } };
}

export async function canonicalFuturePath(target: string): Promise<string> {
	let parent = path.resolve(target);
	const suffix: string[] = [];
	while (true) {
		try { return path.join(await fs.realpath(parent), ...suffix.reverse()); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			suffix.push(path.basename(parent));
			const next = path.dirname(parent);
			if (next === parent) throw error;
			parent = next;
		}
	}
}

export async function prepareNativeAudit(
	cwd: string, params: Record<string, unknown>, audit: NativeAuditOptions, runtime: NativeRuntime,
	artifactDir: string, runId: string, maxTimeoutMs: number, signal?: AbortSignal,
): Promise<{ meta: RunMeta; proc: ChildProcess }> {
	const checkCancelled = () => { if (signal?.aborted) throw new Error("Native audit was cancelled before launch."); };
	checkCancelled();
	if (!runtime.python) throw new Error("Native audit requires a verifiable installed Swival Python interpreter.");
	const trustedGit = await resolveTrustedGit(cwd, runtime);
	const identity = await sourceIdentity(cwd, trustedGit);
	if (await fs.realpath(cwd) !== identity.sourceRoot) throw new Error("Native audit must start from the configured repository root cwd.");
	const pinRuntime = async (bin: string | undefined, virtualenv = false) => {
		if (!bin) return undefined;
		if (!path.isAbsolute(bin)) throw new Error("Native audit requires absolute startup runtime executables.");
		const target = await fs.realpath(bin);
		// Python selects its virtualenv through the interpreter entry. Preserve
		// that basename under a canonical parent, while validating its target.
		const entry = path.join(await fs.realpath(path.dirname(bin)), path.basename(bin));
		for (const location of [bin, path.resolve(bin), entry, target]) {
			if ([identity.sourceRoot, identity.sourceGitDir].some((root) =>
				location === root || location.startsWith(root + path.sep))) {
				throw new Error("Native audit refuses repository-supplied runtime executables.");
			}
		}
		await fs.access(entry, fsSync.constants.X_OK);
		if (!(await fs.stat(entry)).isFile()) throw new Error("Unsupported native runtime executable.");
		return virtualenv ? entry : target;
	};
	const python = (await pinRuntime(runtime.python, true))!;
	const unshare = await pinRuntime(runtime.unshare);
	const bwrap = await pinRuntime(runtime.bwrap);
	const nono = await pinRuntime(runtime.nono);
	const runDir = await canonicalFuturePath(artifactDir);
	for (const source of [identity.sourceRoot, identity.sourceGitDir]) {
		if (runDir === source || runDir.startsWith(source + path.sep) || source.startsWith(runDir + path.sep)) {
			throw new Error("Native artifact root must be outside source checkout and Git metadata.");
		}
	}
	const timeoutMs = params.timeoutMs ?? Math.min(15 * 60_000, maxTimeoutMs);
	if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > maxTimeoutMs) {
		throw new Error(`Native timeoutMs must be an integer from 1 to ${maxTimeoutMs}.`);
	}
	const routing: Record<string, unknown> = {};
	for (const field of NATIVE_FIELDS) {
		if (field.endsWith("Override") && params[field] !== undefined) routing[field.slice(0, -8)] = params[field];
	}
	const request: Record<string, any> = { source: identity.sourceRoot, sourceGitDir: identity.sourceGitDir,
		routing, audit, timeoutMs, python, unshare, bwrap, nono, sandbox: "bubblewrap", sessionSandbox: "builtin" };
	const preflight = async () => JSON.parse((await boundedExec(python, ["-I", "-B",
		path.join(scriptRoot, "native_audit.py"), "--preflight"], identity.sourceRoot, JSON.stringify(request),
		{ ...trustedGit.env, PATH: request.runtimePath ?? trustedGit.env.PATH },
		10_000, 64 * 1024)).toString());
	// Do not create workers, snapshots, or artifact directories until protected
	// and unknown requirements have been rejected without a provider transport.
	let route: Record<string, unknown>;
	try { route = await preflight(); }
	catch { throw new Error("Native audit configuration preflight failed: protected, unknown, or unsupported requirements. No native worker/provider was started."); }
	request.expectedRoute = route;
	checkCancelled();
	if (!unshare || !bwrap || !nono) throw new Error("Native audit requires pinned util-linux unshare, bubblewrap, and nono for provider-only policy; ordinary delegation remains available. No fallback.");
	if (process.platform !== "linux") throw new Error("Native audit requires verified Linux unshare and bubblewrap isolation; ordinary delegation remains available. No fallback.");
	let unshareIdentity: Record<string, unknown>;
	try {
		unshareIdentity = JSON.parse((await boundedExec(python, ["-I", "-B",
			path.join(scriptRoot, "native_audit.py"), "--validate-unshare"], cwd,
			JSON.stringify({ unshare }), trustedGit.env, 10_000, 16 * 1024)).toString());
	} catch {
		throw new Error("Native audit requires the pinned root-owned util-linux unshare package and executable identity; no fallback.");
	}
	if (!isDeepStrictEqual(unshareIdentity, PINNED_UNSHARE_IDENTITY)) {
		throw new Error("Native audit unshare identity did not match the reviewed installation; no fallback.");
	}
	request.unshareIdentity = unshareIdentity;
	let bwrapIdentity: Record<string, unknown>;
	try {
		bwrapIdentity = JSON.parse((await boundedExec(python, ["-I", "-B",
			path.join(scriptRoot, "native_audit.py"), "--validate-bwrap"], cwd,
			JSON.stringify({ bwrap }), trustedGit.env, 10_000, 16 * 1024)).toString());
	} catch {
		throw new Error("Native audit requires the pinned root-owned bubblewrap package and executable identity; no fallback.");
	}
	if (!isDeepStrictEqual(bwrapIdentity, PINNED_BWRAP_IDENTITY)) {
		throw new Error("Native audit bubblewrap identity did not match the reviewed installation; no fallback.");
	}
	request.bwrapIdentity = bwrapIdentity;
	request.bwrapVersion = "0.12.0";
	let nonoIdentity: Record<string, unknown>;
	try {
		nonoIdentity = JSON.parse((await boundedExec(python, ["-I", "-B",
			path.join(scriptRoot, "native_audit.py"), "--validate-nono"], cwd,
			JSON.stringify({ nono }), trustedGit.env, 10_000, 16 * 1024)).toString());
	} catch {
		throw new Error("Native audit requires the reviewed nono 0.79.0 ARM64 GNU executable identity; no fallback.");
	}
	if (!pinnedNonoIdentity(nonoIdentity, nono)) {
		throw new Error("Native audit nono identity did not match the reviewed artifact; no fallback.");
	}
	request.nonoIdentity = nonoIdentity;
	let nonoProfileIdentity: Record<string, unknown>;
	try {
		nonoProfileIdentity = JSON.parse((await boundedExec(python, ["-I", "-B",
			path.join(scriptRoot, "native_audit.py"), "--validate-nono-profile"], cwd,
			JSON.stringify({}), trustedGit.env, 10_000, 16 * 1024)).toString());
	} catch {
		throw new Error("Native audit requires the safe local jedisct1/swival nono profile in the default store; no pull or fallback.");
	}
	if (!localNonoProfileIdentity(nonoProfileIdentity)) {
		throw new Error("Native audit local nono profile identity is unsupported; no pull or fallback.");
	}
	request.nonoProfileIdentity = nonoProfileIdentity;
	const visible = [identity.sourceRoot, identity.sourceGitDir, scriptRoot,
		path.dirname(path.dirname(python)), path.dirname(path.dirname(await fs.realpath(python))),
		path.dirname(trustedGit.executable), path.dirname(nono), nonoProfileIdentity.pack as string];
	for (const target of [path.join(os.homedir(), ".config", "swival"),
		process.env.CHATGPT_TOKEN_DIR ?? path.join(os.homedir(), ".config", "litellm", "chatgpt")]) {
		try { visible.push(await fs.realpath(target)); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	request.readOnlyPaths = [...new Set(await Promise.all(visible.map((target) => fs.realpath(target))))]
		.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
	try {
		await boundedExec(python, ["-I", "-B", path.join(scriptRoot, "native_audit.py"), "--probe"], cwd,
			JSON.stringify(request), trustedGit.env, 10_000, 64 * 1024);
	} catch {
		throw new Error("Native bubblewrap capability check failed. Require a propagation-free Linux environment (no shared/slave mounts), PID namespaces, pidfds, and disabled nested user namespaces. No provider started.");
	}
	checkCancelled();
	await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
	request.snapshot = path.join(runDir, "snapshot");
	request.evidence = path.join(runDir, "evidence");
	const meta: RunMeta = { runId, agent: "native-audit", task: "/audit (structured committed scope)",
		startedAt: Date.now(), pid: undefined, artifactDir: runDir, stdoutFile: path.join(runDir, "stdout.txt"),
		stderrFile: path.join(runDir, "stderr.txt"), nativeAuditRequested: true };
	try {
		const runtimeBin = path.join(runDir, "runtime-bin");
		await fs.mkdir(runtimeBin, { mode: 0o700 });
		await fs.symlink(trustedGit.executable, path.join(runtimeBin, "git"));
		await fs.symlink(nono, path.join(runtimeBin, "nono"));
		request.runtimePath = [runtimeBin, trustedGit.env.PATH].join(path.delimiter);
		const manifest = await createCommittedSnapshot(identity.sourceRoot, request.snapshot, trustedGit);
		checkCancelled();
		const scoped = await preflight();
		checkCancelled();
		const { scope, ...secondRoute } = scoped;
		if (!isDeepStrictEqual(route, secondRoute)) throw new Error("Native route changed after preflight; no fallback.");
		request.expectedScope = scope;
		await fs.mkdir(request.evidence, { mode: 0o700 });
		await fs.mkdir(path.join(runDir, "sandbox"), { mode: 0o700 });
		request.readOnlyPaths.push(runtimeBin);
		await fs.writeFile(path.join(runDir, "manifest.json"), JSON.stringify({ ...manifest,
			sandbox: "bubblewrap", bwrapVersion: request.bwrapVersion,
			bwrapIdentity: request.bwrapIdentity, unshareIdentity: request.unshareIdentity,
			nono: request.nono, nonoIdentity: request.nonoIdentity,
			nonoProfileIdentity: request.nonoProfileIdentity, sessionSandbox: "builtin",
			scope: scoped.scope, audit, route }, null, 2), { mode: 0o600 });
		await fs.writeFile(path.join(runDir, "request.json"), JSON.stringify(request), { mode: 0o600 });
		await fs.writeFile(path.join(runDir, "run-meta.json"), JSON.stringify(meta), { mode: 0o600 });
		checkCancelled();
	} catch (error) {
		await fs.rm(runDir, { recursive: true, force: true });
		throw error;
	}
	let proc: ChildProcess;
	try {
		proc = spawn(process.execPath, [path.join(scriptRoot, "native-audit-runner.cjs"), runDir], {
			cwd: path.join(runDir, "sandbox"), shell: false, detached: true,
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
	} catch {
		await recordNativeAuditFailure(meta, "Native runner failed to start.");
		throw new Error(`Native runner failed to start. Artifacts: ${runDir}.`);
	}
	meta.pid = proc.pid;
	return { meta, proc };
}

/** Called only after wrapper exit, with authority retained from its live channel. */
export function recordNativeAuditFailure(meta: RunMeta, stopped: string, ownership?: NativeOwnership,
	startupBarrier?: () => Promise<void>): Promise<NativeTerminal> {
	return finalizeNativeAudit({ runDir: meta.artifactDir, ownership, startupBarrier }, { exitCode: 1, stopped });
}

export interface NativeAuditResult {
	status: "completed" | "failed" | "partial" | "empty_scope";
	answer?: string;
	error?: string;
	statePath?: string;
}

async function regularJson(file: string, root: string): Promise<Record<string, any>> {
	let current = path.resolve(file);
	const anchor = path.resolve(root);
	if (!current.startsWith(anchor + path.sep)) throw new Error("Uncontained native evidence.");
	while (current !== anchor) {
		if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Symlinked native evidence.");
		current = path.dirname(current);
	}
	const stat = await fs.lstat(file);
	if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("Unsupported native evidence.");
	return JSON.parse(await fs.readFile(file, "utf8"));
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

const pythonAsciiString = (value: string) => JSON.stringify(value).replace(/[\u0080-\uffff]/g,
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
		if (failures.length || completed.shutdown !== "verified" || completed.boundary !== "bubblewrap-pidfd") {
			return { status: "failed", error: [...failures,
				...(completed.retainedResources?.length ? [`Retained resources: ${completed.retainedResources.join(", ")}.`] : [])]
				.join(" ") || "Native shutdown was not verified." };
		}
		const result = await regularJson(path.join(artifactDir, "evidence", "native-result.json"), artifactDir);
		if (result.status === "empty_scope") return { status: "empty_scope", error: "No auditable committed files in scope." };
		const expansionLoss = Number.isSafeInteger(result.unrecoveredExpansionFailures) &&
			result.unrecoveredExpansionFailures > 0;
		if ((exitCode !== 0 || completed.exitCode !== 0) && !(result.status === "partial" && expansionLoss)) {
			return { status: "failed", error: "Native pipeline exited unsuccessfully." };
		}
		if (!["completed", "partial"].includes(result.status) || result.sandbox?.external !== "bubblewrap" ||
			result.sandbox?.bwrapVersion !== "0.12.0" ||
			!isDeepStrictEqual(result.sandbox?.bwrapIdentity, PINNED_BWRAP_IDENTITY) ||
			!pinnedNonoIdentity(result.sandbox?.nonoIdentity) ||
			!localNonoProfileIdentity(result.sandbox?.nonoProfileIdentity) ||
			result.sandbox?.session !== "builtin" || result.network !== "provider-only") {
			return { status: "failed", error: "Native runtime/sandbox completion evidence is missing." };
		}
		const manifest = await regularJson(path.join(artifactDir, "manifest.json"), artifactDir);
		const request = await regularJson(path.join(artifactDir, "request.json"), artifactDir);
		if (manifest.sandbox !== "bubblewrap" || manifest.bwrapVersion !== "0.12.0" ||
			manifest.sessionSandbox !== "builtin" || request.sandbox !== "bubblewrap" ||
			request.bwrapVersion !== "0.12.0" || request.sessionSandbox !== "builtin" ||
			!isDeepStrictEqual(manifest.bwrapIdentity, PINNED_BWRAP_IDENTITY) ||
			!isDeepStrictEqual(request.bwrapIdentity, PINNED_BWRAP_IDENTITY) ||
			!isDeepStrictEqual(manifest.unshareIdentity, PINNED_UNSHARE_IDENTITY) ||
			!isDeepStrictEqual(request.unshareIdentity, PINNED_UNSHARE_IDENTITY) ||
			typeof request.nono !== "string" ||
			!pinnedNonoIdentity(request.nonoIdentity, request.nono) || manifest.nono !== request.nono ||
			!localNonoProfileIdentity(request.nonoProfileIdentity) ||
			!isDeepStrictEqual(manifest.nonoIdentity, request.nonoIdentity) ||
			!isDeepStrictEqual(result.sandbox?.nonoIdentity, request.nonoIdentity) ||
			!isDeepStrictEqual(manifest.nonoProfileIdentity, request.nonoProfileIdentity) ||
			!isDeepStrictEqual(result.sandbox?.nonoProfileIdentity, request.nonoProfileIdentity) ||
			!isDeepStrictEqual(result.sandbox?.startup,
				{ executable: "unshare", identity: PINNED_UNSHARE_IDENTITY }) ||
			manifest.route?.version !== 1 || !isDeepStrictEqual(manifest.route, request.expectedRoute) ||
			!isDeepStrictEqual(manifest.route, result.route) || result.provider !== manifest.route.provider ||
			result.model !== manifest.route.model || result.requestedEffort !== manifest.route.reasoningEffort) {
			return { status: "failed", error: "Native route completion evidence does not match preflight." };
		}
		const scope = manifest.scope;
		const statesDir = path.join(artifactDir, "evidence", "native-state");
		const entries = await fs.readdir(statesDir);
		if (entries.length !== 1 || !/^[a-f0-9]{8}$/.test(entries[0])) throw new Error("Expected one new native audit state.");
		const statePath = path.join(statesDir, entries[0], "state.json");
		const state = await regularJson(statePath, artifactDir);
		if (scope.commit !== manifest.snapshotCommit || JSON.stringify(state.scope) !== JSON.stringify(scope) ||
			JSON.stringify(result.scope) !== JSON.stringify(scope)) throw new Error("Native snapshot/scope identity mismatch.");
		const mandatory = scope.mandatory_files;
		if (!Array.isArray(mandatory) || !mandatory.length) return { status: "empty_scope", error: "No auditable committed files in scope." };
		if (expansionLoss) {
			return { status: "partial", error: "Native audit lost findings to unrecovered expansion failures.", statePath };
		}
		if (result.status !== "completed") return { status: "partial", error: "Native pipeline is incomplete.", statePath };
		const covers = (wanted: unknown, actual: unknown) => Array.isArray(wanted) && Array.isArray(actual) &&
			wanted.every((file) => actual.includes(file));
		if (state.phase !== "done" || !covers(mandatory, state.reviewed_files) ||
			!Array.isArray(state.candidate_files) ||
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
				if (extension === "md" && !(await fs.readFile(file, "utf8")).trim()) {
					return { status: "partial", error: "Native finding report is empty.", statePath };
				}
			}
		}
		return { status: "completed", answer: typeof result.answer === "string" ? result.answer : "Native audit completed.", statePath };
	} catch { return { status: "failed", error: "Native audit lacks valid state, scope, or report/patch evidence." }; }
}
