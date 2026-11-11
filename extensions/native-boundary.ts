/**
 * Native audit trust boundary: runtime capture, trusted-path and Git
 * validation, AgentFS write-root isolation, credential-state inspection,
 * and import of the committed tree into an independent snapshot repository.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { deflateSync } from "node:zlib";
import {
	NATIVE_FILE_LIMIT,
	NATIVE_MAX_ENTRIES,
	NATIVE_TOTAL_LIMIT,
	type NativeAuthStore,
	type NativeRuntime,
	type SnapshotManifest,
	type TrustedGit,
} from "./contracts.js";
import { canonicalFuturePath, pathIsWithin } from "./paths.js";

// ------------------------------------------------------- runtime capture --

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

// -------------------------------------------------------- trusted paths --

/** Resolve directory metadata, including future descendants and dangling directory aliases. */
export async function canonicalRuntimePath(directory: string, directoryOnly = true, links = 0): Promise<string> {
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

/** Check every symlink hop before Git or Python can load repository-controlled code. */
export async function assertTrustedRuntimePath(location: string, roots: string[]): Promise<void> {
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

// -------------------------------------------------------- credentials --

/** Validate metadata only; never read, copy, or export an authentication record. */
export async function prepareNativeAuthStore(input: NodeJS.ProcessEnv, forbiddenRoots: string[]): Promise<NativeAuthStore> {
	const home = input.HOME;
	const filename = input.CHATGPT_AUTH_FILE ?? "auth.json";
	if (!home || !path.isAbsolute(home) || path.normalize(home) !== home || !(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).test(filename)) {
		throw new Error("Native auth requires an absolute home and a safe auth filename basename.");
	}
	const directory = input.CHATGPT_TOKEN_DIR ?? path.join(home, ".config", "litellm", "chatgpt");
	const relative = path.relative(home, directory);
	const broadRoots = [home, path.join(home, ".config"), path.join(home, ".config", "litellm")];
	if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || directory.length > 4096 || directory.split(path.sep).length > 64 ||
		/[\x00-\x1f\x7f\\]/.test(directory) || !relative || path.isAbsolute(relative) || relative.split(path.sep).includes("..") ||
		broadRoots.includes(directory)) {
		throw new Error("Native auth requires a dedicated directory inside home, outside source and artifact scope.");
	}
	for (const broad of broadRoots) {
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
			foldedAuth === foldedRoot || foldedAuth.startsWith(foldedRoot + path.sep) || foldedRoot.startsWith(foldedAuth + path.sep)) {
			throw new Error("Native auth directory overlaps source, artifact, or runtime scope.");
		}
	}
	let current = path.parse(directory).root;
	for (const component of directory.slice(current.length).split(path.sep)) {
		current = path.join(current, component);
		let stat;
		try { stat = await fs.lstat(current); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !(current.startsWith(home + path.sep))) throw error;
			await fs.mkdir(current, { mode: 0o700 });
			stat = await fs.lstat(current);
		}
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Native auth refuses symlinked or non-directory paths.");
		if ((current === home || current.startsWith(home + path.sep)) && (stat.uid !== process.getuid?.() || (stat.mode & 0o022))) {
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

/**
 * Host credential CLIs run outside AgentFS, load HOME-derived configuration
 * that can select credential_process or external-account executables, and
 * read or write caches anywhere beneath their state root. Refuse a state root
 * that aliases, contains, or holds any symlink or directory aliasing source or
 * Git, then return the validated bindings for the host call only.
 */
export async function resolveTrustedCredentialState(tool: "aws" | "gcloud", home: string, protectedRoots: string[]): Promise<NodeJS.ProcessEnv> {
	const stateRoot = tool === "aws" ? path.join(home, ".aws") : path.join(home, ".config", "gcloud");
	const bindings: NodeJS.ProcessEnv = tool === "aws"
		? { AWS_CONFIG_FILE: path.join(stateRoot, "config"), AWS_SHARED_CREDENTIALS_FILE: path.join(stateRoot, "credentials") }
		: { CLOUDSDK_CONFIG: stateRoot, CLOUDSDK_CORE_DISABLE_FILE_LOGGING: "1" };
	const refusal = () => new Error("Native audit refuses repository-owned runtime paths.");
	/** Check every symlink hop and the resolved target; return the target when it exists. */
	const assertTrustedState = async (location: string): Promise<string | undefined> => {
		try {
			await assertTrustedRuntimePath(location, protectedRoots);
			const target = await fs.realpath(location);
			for (const root of protectedRoots) if (await pathIsWithin(root, target)) throw refusal();
			return target;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return undefined;
		}
	};
	const realStateRoot = await assertTrustedState(stateRoot);
	if (!realStateRoot || !(await fs.stat(realStateRoot)).isDirectory()) return bindings;
	const identities = await Promise.all(protectedRoots.map((root) => fs.stat(root)));
	let budget = 65_536;
	// Every subtree is inspected uniformly, including gcloud `logs`: file logging
	// is disabled, but gcloud still prunes dated log directories beneath it and a
	// `configurations -> logs` alias makes it configuration input. Directory
	// symlinks are followed so their descendants are inspected too; visited
	// identities keep symlink cycles from looping or exhausting the budget.
	const visited = new Set<string>();
	const walk = async (directory: string): Promise<void> => {
		const dirStat = await fs.stat(directory);
		if (identities.some((root) => dirStat.dev === root.dev && dirStat.ino === root.ino)) throw refusal();
		const identity = `${dirStat.dev}:${dirStat.ino}`;
		if (visited.has(identity)) return;
		visited.add(identity);
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			if (--budget < 0) throw new Error("Native audit credential state exceeds the verifiable entry limit.");
			const location = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) {
				const target = await assertTrustedState(location);
				if (target && (await fs.stat(target)).isDirectory()) await walk(target);
			} else if (entry.isDirectory()) await walk(location);
		}
	};
	await walk(realStateRoot);
	return bindings;
}

// --------------------------------------------------------- Git plumbing --

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

export const gitArgs = (args: string[]) => ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
	"-c", "core.attributesFile=/dev/null", "-c", "commit.gpgsign=false", "-c", "protocol.allow=never", ...args];
const runGit = (trusted: TrustedGit, cwd: string, args: string[], input?: Buffer | string, timeout?: number, maxBuffer?: number) =>
	boundedExec(trusted.executable, gitArgs(args), cwd, input, trusted.env, timeout, maxBuffer);

export async function sourceIdentity(cwd: string, trusted: TrustedGit) {
	const git = (dir: string, args: string[]) => runGit(trusted, dir, args);
	const sourceRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).toString().trim();
	const sourceGitDir = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toString().trim();
	const sourceWorktreeGitDir = (await git(cwd, ["rev-parse", "--absolute-git-dir"])).toString().trim();
	return { sourceRoot: await fs.realpath(sourceRoot), sourceGitDir: await fs.realpath(sourceGitDir),
		sourceWorktreeGitDir: await fs.realpath(sourceWorktreeGitDir) };
}

/** Validate startup selections without executing Git or any repository code. */
export async function resolveTrustedGit(cwd: string, runtime: NativeRuntime): Promise<TrustedGit> {
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

// ------------------------------------------------ committed snapshot --

const secretPath = (file: string) => file.split("/").some((part) =>
	/^\.env(?:\.|$)|\.(?:pem|key)$/i.test(part) || [".ssh", ".aws", ".gnupg", ".git-credentials"].includes(part));
const unsafePath = (file: string) => {
	const folded = file.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
	return /[\x00-\x1f\x7f\\]/.test(file) || path.isAbsolute(file) ||
		file.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
		["audit-findings", ".swival/audit", "native-cli-report.json"].some((reserved) => folded === reserved || folded.startsWith(reserved + "/"));
};

/** True when a committed symlink is a relative alias of an existing directory inside the same tree. */
const inRepoDirectoryAlias = (file: string, linkTarget: string, treeDirectories: ReadonlySet<string>) => {
	if (!linkTarget || /[\x00-\x1f\x7f\\]/.test(linkTarget) || linkTarget.startsWith("/") || linkTarget.includes("\ufffd")) return false;
	const components = file.split("/").slice(0, -1);
	for (const component of linkTarget.split("/")) {
		if (!component || component === ".") continue;
		if (component === "..") {
			if (components.length === 0) return false;
			components.pop();
			continue;
		}
		components.push(component);
		const directory = components.join("/");
		// Validate before a later dot-dot can erase an invalid intermediate.
		if (!treeDirectories.has(directory) || unsafePath(directory) || secretPath(directory)) return false;
	}
	return components.length > 0;
};

interface TreeEntry { mode: string; type: string; oid: string; file: string }

const CREDENTIAL_CONTENT = /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})/;

/**
 * Parse one `git cat-file --batch` response stream for the exact object
 * sequence requested. Every object must be present, in order, of the expected
 * type, within the per-object and aggregate byte limits, and followed by the
 * terminating newline, so a truncated, reordered, or substituted stream fails.
 */
export function parseCatFileBatch(output: Buffer, requested: ReadonlyArray<{ oid: string; type: string }>): Map<string, Buffer> {
	const malformed = () => new Error("Native audit snapshot object stream is malformed.");
	const objects = new Map<string, Buffer>();
	let offset = 0;
	let total = 0;
	for (const want of requested) {
		const newline = output.indexOf(0x0a, offset);
		if (newline === -1) throw malformed();
		const header = /^([a-f0-9]+) (blob|tree|commit|tag) ([0-9]{1,15})$/.exec(output.toString("latin1", offset, newline));
		if (!header) throw malformed();
		if (header[1] !== want.oid || header[2] !== want.type) throw new Error("Native audit object identity changed during import.");
		const size = Number(header[3]);
		total += size;
		if (!Number.isSafeInteger(size) || size > NATIVE_FILE_LIMIT || total > NATIVE_TOTAL_LIMIT) {
			throw new Error("Native audit snapshot exceeds object resource limits.");
		}
		const start = newline + 1;
		const end = start + size;
		if (end >= output.length || output[end] !== 0x0a) throw malformed();
		objects.set(want.oid, Buffer.from(output.subarray(start, end)));
		offset = end + 1;
	}
	if (offset !== output.length) throw malformed();
	return objects;
}

/**
 * Import only the committed `HEAD^{tree}` into a fresh repository at
 * `destination` using fixed Git plumbing: one `ls-tree`, one `cat-file --batch`,
 * hash-verified loose-object writes, then `commit-tree` / `update-ref` /
 * `read-tree`. Regular blobs are materialized into the working copy; accepted
 * in-repo directory symlinks stay committed evidence only. The working-copy
 * `swival.toml` is replaced by an inert file without touching the committed tree.
 */
export async function createCommittedSnapshot(cwd: string, destination: string, selectedGit?: TrustedGit): Promise<SnapshotManifest> {
	const trusted = selectedGit ?? await resolveTrustedGit(cwd, captureNativeRuntime());
	const git = (dir: string, args: string[], input?: Buffer | string, timeout?: number, maxBuffer?: number) =>
		runGit(trusted, dir, args, input, timeout, maxBuffer);
	const identity = await sourceIdentity(cwd, trusted);
	const dest = path.resolve(destination);
	for (const source of [identity.sourceRoot, identity.sourceGitDir, identity.sourceWorktreeGitDir]) {
		if (await pathIsWithin(dest, source) || await pathIsWithin(source, dest)) {
			throw new Error("Native audit snapshot must be outside source checkout and Git metadata.");
		}
	}
	const sourceCommit = (await git(identity.sourceRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).toString().trim();
	const sourceTree = (await git(identity.sourceRoot, ["rev-parse", `${sourceCommit}^{tree}`])).toString().trim();
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCommit) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceTree) ||
		sourceCommit.length !== sourceTree.length) throw new Error("Unsupported Git object identity.");
	const listing = (await git(identity.sourceRoot, ["ls-tree", "-r", "-t", "-z", sourceTree])).toString("utf8");
	const entries: TreeEntry[] = listing.split("\0").filter(Boolean).map((line) => {
		const match = /^(\d+) (blob|tree|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
		if (!match) throw new Error("Unsupported Git tree entry.");
		const [, mode, type, oid, file] = match;
		if (unsafePath(file) || file.includes("\ufffd") || !["040000", "100644", "100755", "120000"].includes(mode) ||
			oid.length !== sourceTree.length) throw new Error("Unsupported native audit path or file mode.");
		if (secretPath(file)) throw new Error("Native audit refuses secret-shaped tracked paths.");
		return { mode, type, oid, file };
	});
	if (entries.length > NATIVE_MAX_ENTRIES) throw new Error(`Native audit snapshot exceeds the ${NATIVE_MAX_ENTRIES}-entry limit.`);
	const treeDirectories = new Set(entries.filter((e) => e.mode === "040000").map((e) => e.file));
	const requested = new Map<string, string>([[sourceTree, "tree"]]);
	for (const entry of entries) {
		const known = requested.get(entry.oid);
		if (known !== undefined && known !== entry.type) throw new Error("Native audit object identity changed during import.");
		requested.set(entry.oid, entry.type);
	}
	const order = [...requested].map(([oid, type]) => ({ oid, type }));
	const batch = await git(identity.sourceRoot, ["cat-file", "--batch"], `${order.map((o) => o.oid).join("\n")}\n`,
		60_000, NATIVE_TOTAL_LIMIT + 6 * 1024 * 1024);
	const objects = parseCatFileBatch(batch, order);
	for (const entry of entries) {
		if (entry.type === "blob" && CREDENTIAL_CONTENT.test(objects.get(entry.oid)!.toString("utf8"))) {
			throw new Error("Native audit refuses recognized credential content; protected routes are unsupported.");
		}
	}
	// Only benign in-repo directory aliases are accepted; they stay in the committed
	// tree as evidence but are never written into the snapshot working copy.
	for (const entry of entries.filter((e) => e.mode === "120000")) {
		if (!inRepoDirectoryAlias(entry.file, objects.get(entry.oid)!.toString("utf8"), treeDirectories)) {
			throw new Error("Unsupported native audit path or file mode.");
		}
	}
	const regularFiles = entries.filter((e) => e.type === "blob" && e.mode !== "120000");
	const objectFormat = sourceTree.length === 64 ? "sha256" : "sha1";
	await fs.mkdir(dest, { mode: 0o700 });
	await git(dest, ["init", "--template=", `--object-format=${objectFormat}`]);
	for (const { oid, type } of order) {
		const bytes = objects.get(oid)!;
		const raw = Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`, "latin1"), bytes]);
		if (createHash(objectFormat).update(raw).digest("hex") !== oid) throw new Error("Native audit object identity changed during import.");
		const directory = path.join(dest, ".git", "objects", oid.slice(0, 2));
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(path.join(directory, oid.slice(2)), deflateSync(raw), { mode: 0o444, flag: "wx" })
			.catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
	}
	const env = { ...trusted.env, GIT_AUTHOR_NAME: "Native audit snapshot", GIT_AUTHOR_EMAIL: "audit@example.invalid",
		GIT_COMMITTER_NAME: "Native audit snapshot", GIT_COMMITTER_EMAIL: "audit@example.invalid",
		GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };
	const snapshotCommit = (await boundedExec(trusted.executable, gitArgs(["commit-tree", sourceTree]), dest,
		"Independent committed audit snapshot\n", env)).toString().trim();
	await git(dest, ["update-ref", "HEAD", snapshotCommit]);
	await git(dest, ["read-tree", snapshotCommit]);
	for (const entry of regularFiles) {
		const target = path.join(dest, entry.file);
		await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
		await fs.writeFile(target, objects.get(entry.oid)!, { mode: entry.mode === "100755" ? 0o700 : 0o600, flag: "wx" });
	}
	// Upstream reads audit configuration from the working copy. Keep its committed
	// tree as evidence, but do not activate repository-supplied runtime settings.
	await fs.writeFile(path.join(dest, "swival.toml"), "# Native audit runtime configuration is inert.\n", { mode: 0o600 });
	const materializedFiles = regularFiles.map((e) => e.file);
	return { ...identity, sourceCommit, sourceTree, snapshotCommit,
		committedEntries: entries.filter((e) => e.type === "blob").map((e) => e.file),
		materializedFiles,
		files: materializedFiles,
		excluded: "All staged, unstaged, and untracked content is excluded; only the committed tree is imported." };
}
