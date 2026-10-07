import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
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
	python?: string; agentfs?: string; nono?: string; git?: string; searchPath?: string;
}
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts");
export interface NativeTerminal {
	exitCode: number;
	exitedAt: string;
	shutdown: "not-started" | "verified" | "unverified";
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
}
interface NativeFinalizationOptions {
	runDir: string;
	ownership?: NativeOwnership;
	sessionDir?: string;
	sessionOwned?: boolean;
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
	return { python, agentfs: executable("agentfs"), nono: executable("nono"),
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
	const agentfs = await pinRuntime(runtime.agentfs);
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
	const request: Record<string, any> = { source: identity.sourceRoot, routing, audit, timeoutMs,
		python, agentfs, session: `native-audit-${runId}` };
	const preflight = async () => JSON.parse((await boundedExec(python, ["-I", "-B",
		path.join(scriptRoot, "native_audit.py"), "--preflight"], identity.sourceRoot, JSON.stringify(request),
		{ ...trustedGit.env, PATH: request.runtimePath ?? trustedGit.env.PATH },
		10_000, 64 * 1024)).toString());
	// Do not create workers, snapshots, or artifact directories until protected
	// and unknown requirements have been rejected without a provider transport.
	let route: Record<string, unknown>;
	try { route = await preflight(); }
	catch { throw new Error("Native audit configuration preflight failed: protected, unknown, or unsupported requirements. No native worker/provider was started."); }
	checkCancelled();
	if (!agentfs || !nono) throw new Error("Native audit requires AgentFS and nono for provider-only network policy; no fallback.");
	const version = (await boundedExec(agentfs, ["--version"], cwd, undefined, trustedGit.env, 5000, 16384)).toString();
	request.agentfsVersion = /\d+\.\d+\.\d+/.exec(version)?.[0];
	if (!request.agentfsVersion) throw new Error("Native audit cannot verify the AgentFS installation.");
	if (process.platform === "darwin" && request.agentfsVersion === "0.6.4") {
		throw new Error("Native audit is blocked on Darwin/macOS with AgentFS 0.6.4: writable temporary roots expose source and Git metadata. Ordinary delegation remains available; no sandbox fallback.");
	}
	if (process.platform !== "linux" || request.agentfsVersion !== "0.6.4") {
		throw new Error("Native audit is blocked for this unverified AgentFS/platform combination. Require a reviewed native isolation canary before enabling it; no fallback.");
	}
	await boundedExec(nono, ["--version"], cwd, undefined, trustedGit.env, 5000, 16384);
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
		request.runtimePath = [runtimeBin, trustedGit.env.PATH].join(path.delimiter);
		const manifest = await createCommittedSnapshot(identity.sourceRoot, request.snapshot, trustedGit);
		checkCancelled();
		const scoped = await preflight();
		checkCancelled();
		request.expectedScope = scoped.scope;
		await fs.mkdir(request.evidence, { mode: 0o700 });
		await fs.mkdir(path.join(runDir, "sandbox"), { mode: 0o700 });
		await fs.writeFile(path.join(runDir, "manifest.json"), JSON.stringify({ ...manifest, scope: scoped.scope, audit, route }, null, 2), { mode: 0o600 });
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
	return finalizeNativeAudit({ runDir: meta.artifactDir, ownership, startupBarrier,
		sessionDir: path.join(os.homedir(), ".agentfs", "run", `native-audit-${meta.runId}`),
		sessionOwned: ownership !== undefined }, { exitCode: 1, stopped });
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

export async function inspectNativeAudit(artifactDir: string, exitCode: number): Promise<NativeAuditResult> {
	try {
		const completed = readNativeTerminal(artifactDir);
		if (!completed) return { status: "failed", error: "Native audit state is unknown: no valid terminal evidence." };
		const failures = [completed.stopped, completed.shutdownFailure, completed.preservationFailure,
			completed.cleanupFailure, completed.persistenceFailure].filter(Boolean);
		if (failures.length || completed.shutdown !== "verified") {
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
		if (!["completed", "partial"].includes(result.status) || result.sandbox?.agentfs !== true || !result.sandbox?.agentfsVersion || result.network !== "provider-only") {
			return { status: "failed", error: "Native runtime/sandbox completion evidence is missing." };
		}
		const manifest = await regularJson(path.join(artifactDir, "manifest.json"), artifactDir);
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
		if (!state.verification_state || !state.artifact_state || !Array.isArray(state.verified_findings) ||
			!Array.isArray(state.proposed_findings) || Object.keys(state.verification_state).length < state.proposed_findings.length ||
			Object.values(state.verification_state).some((entry: any) => !["verified", "discarded"].includes(entry.status)) ||
			Object.keys(state.artifact_state).length !== state.verified_findings.length) {
			return { status: "partial", error: "Native verification/artifact coverage is incomplete.", statePath };
		}
		for (const entry of Object.values(state.artifact_state) as Record<string, any>[]) {
			if (entry.status !== "written") return { status: "partial", error: "Native findings have unfinished artifacts.", statePath };
			for (const [field, extension] of [["report_filename", "md"], ["patch_filename", "patch"]]) {
				const name = entry[field];
				if (typeof name !== "string" || !new RegExp(`^[0-9]+-[a-zA-Z0-9_-]+\\.${extension}$`).test(name)) throw new Error("Unsupported native artifact filename.");
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
