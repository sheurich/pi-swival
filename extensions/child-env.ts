/**
 * Child-process environment, conservative Swival TOML reading, provider
 * timeout precedence, and linked-worktree Git read grants.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SwivalAgentConfig } from "./agents.js";
import {
	ANTHROPIC_OAUTH_SHIM_DIR,
	type EffectiveProviderTimeout,
	type ReportSummary,
	SwivalArgumentError,
	type SwivalOverrides,
	cliOptionEntries,
	hasCliFlag,
	lastCliOptionValue,
} from "./contracts.js";
import {
	parseCanonicalHttpsEndpoint,
	readAnthropicAuthToken,
	readPiAuthToken,
	readSafeRegularText,
	resolvePiCustomProviderForBaseUrl,
	walkCanonicalPathSync,
} from "./paths.js";

// --------------------------------------------------------- TOML subset --

/** Multiline strings can hide table headers or key lines from line-oriented reading. */
const hasTomlMultilineString = (text: string) => text.includes('"""') || text.includes("'''");

interface TomlLine {
	readonly text: string;
	readonly start: number;
	/** The line begins outside every array and inline table, so it can carry a key or header. */
	readonly topLevel: boolean;
}

/**
 * Split TOML into physical lines while tracking single-line strings, comments,
 * array depth, and inline-table depth, so a `[` that continues a multiline
 * array is never mistaken for a table header and array elements are never
 * mistaken for assignments. Returns `null` for anything the subset cannot read
 * line by line: an unclosed string, a line continuation, an inline table
 * spanning lines, unbalanced brackets, or content after a closing bracket.
 */
function scanTomlLines(text: string): TomlLine[] | null {
	if (hasTomlMultilineString(text)) return null;
	const lines: TomlLine[] = [];
	let lineStart = 0, lineTopLevel = true, bracket = 0, brace = 0;
	let quote: '"' | "'" | undefined;
	let inComment = false, tailOnly = false;
	const endLine = (end: number) => {
		if (brace > 0) return false;
		lines.push({ text: text.slice(lineStart, end), start: lineStart, topLevel: lineTopLevel });
		lineStart = end + 1; lineTopLevel = bracket === 0; inComment = false; tailOnly = false;
		return true;
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === "\n" || c === "\r") return null;
			if (c === quote) quote = undefined;
			else if (quote === '"' && c === "\\") {
				const next = text[i + 1];
				if (next === undefined || next === "\n" || next === "\r") return null;
				i++;
			}
			continue;
		}
		if (c === "\n") { if (!endLine(i)) return null; continue; }
		if (inComment) continue;
		if (c === "#") { inComment = true; continue; }
		if (tailOnly && c !== " " && c !== "\t" && c !== "\r") return null;
		if (c === '"' || c === "'") quote = c;
		else if (c === "[") bracket++;
		else if (c === "{") brace++;
		else if (c === "]" || c === "}") {
			if (c === "]" ? --bracket < 0 : --brace < 0) return null;
			if (!lineTopLevel && bracket === 0 && brace === 0) tailOnly = true;
		}
	}
	if (quote || bracket !== 0 || brace !== 0 || !endLine(text.length)) return null;
	return lines;
}

interface TomlHeader {
	/** Header text between the brackets with whitespace around dots removed. */
	readonly inner: string;
	readonly arrayTable: boolean;
	readonly start: number;
	readonly bodyStart: number;
}

/** Real table headers only: a top-level line that opens with `[` must be a complete header. */
function tomlHeaders(raw: string, lines: TomlLine[]): TomlHeader[] | null {
	const headers: TomlHeader[] = [];
	for (const line of lines) {
		if (!line.topLevel || !/^\s*\[/.test(line.text)) continue;
		const header = /^\s*(\[\[?)([^\[\]]+?)(\]\]?)\s*(?:#.*)?$/.exec(line.text);
		if (!header || header[1].length !== header[3].length) return null;
		headers.push({ inner: header[2].trim().replace(/[ \t]*\.[ \t]*/g, "."), arrayTable: header[1] === "[[",
			start: line.start, bodyStart: Math.min(raw.length, line.start + line.text.length + 1) });
	}
	return headers;
}

/**
 * Locate the single top-level `key =` assignment in one section. Returns the
 * line and its index, `undefined` when absent, or `null` when the section
 * cannot be interpreted safely: unreadable layout, a duplicate key, a dotted
 * key, an escaped quoted key, or a quoted key spelling `key`. Unrelated plain
 * quoted keys and multiline arrays are inert.
 */
function uniqueTomlAssignment(lines: TomlLine[], key: string): { line: TomlLine; index: number } | null | undefined {
	let found: { line: TomlLine; index: number } | undefined;
	for (const [index, line] of lines.entries()) {
		if (!line.topLevel || /^\s*(?:#|$)/.test(line.text)) continue;
		if (/^\s*\[/.test(line.text)) return null;
		const bare = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line.text);
		if (bare) {
			if (bare[1] !== key) continue;
			if (found) return null;
			found = { line, index };
			continue;
		}
		const quoted = /^\s*(?:"([^"\\]*)"|'([^']*)')\s*=/.exec(line.text);
		if (!quoted || (quoted[1] ?? quoted[2]) === key) return null;
	}
	return found;
}

function parseUniqueTomlString(sectionText: string, key: string): string | null | undefined {
	const lines = scanTomlLines(sectionText);
	if (!lines) return null;
	const found = uniqueTomlAssignment(lines, key);
	if (!found) return found;
	const m = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"\\\\]*)"|'([^']*)')\\s*(?:#.*)?$`).exec(found.line.text);
	if (!m) return null;
	return m[1] ?? m[2];
}

function parseUniqueTomlPositiveInt(sectionText: string, key: string): number | null | undefined {
	const lines = scanTomlLines(sectionText);
	if (!lines) return null;
	const found = uniqueTomlAssignment(lines, key);
	if (!found) return found;
	const m = new RegExp(`^\\s*${key}\\s*=\\s*([0-9]+)\\s*(?:#.*)?$`).exec(found.line.text);
	if (!m) return null;
	const n = Number(m[1]);
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Exactly one plain `[profiles.<name>]` header selects a profile. Returns
 * `undefined` only when the profile is absent from this file, and `null` when
 * the file addresses profiles in any way this subset cannot attribute: an
 * unsafe name, a bare or quoted `[profiles]` table, a quoted or nested profile
 * header, an array of tables, or a duplicate header.
 */
function extractTomlProfileSection(raw: string, headers: TomlHeader[], profileName: string): string | null | undefined {
	if (!/^[A-Za-z0-9_-]+$/.test(profileName)) return null;
	for (const header of headers) {
		if (!/^(?:profiles|"profiles"|'profiles')(?:\.|$)/.test(header.inner)) continue;
		if (header.arrayTable || !/^profiles\.[A-Za-z0-9_-]+$/.test(header.inner)) return null;
	}
	const matches = headers.filter((header) => header.inner === `profiles.${profileName}`);
	if (matches.length > 1) return null;
	if (matches.length === 0) return undefined;
	const index = headers.indexOf(matches[0]);
	const end = index + 1 < headers.length ? headers[index + 1].start : raw.length;
	return raw.slice(matches[0].bodyStart, end);
}

/** Index of the `]` closing the array opened at `open`, ignoring brackets inside strings and comments; -1 when unclosed. */
function tomlArrayEnd(text: string, open: number): number {
	let depth = 0;
	let quote: '"' | "'" | undefined;
	for (let i = open; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === quote) quote = undefined;
			else if (quote === '"' && c === "\\") i++;
		} else if (c === "#") {
			const newline = text.indexOf("\n", i);
			if (newline === -1) return -1;
			i = newline;
		} else if (c === '"' || c === "'") quote = c;
		else if (c === "[") depth++;
		else if (c === "]" && --depth === 0) return i;
	}
	return -1;
}

function parseTomlRootStringArray(rootSection: string, key: string): string[] | null | undefined {
	const lines = scanTomlLines(rootSection);
	if (!lines) return null;
	const found = uniqueTomlAssignment(lines, key);
	if (!found) return found;
	// The assignment runs until the next top-level line, so a multiline array stays whole.
	let end = found.index + 1;
	while (end < lines.length && !lines[end].topLevel) end++;
	const assignment = lines.slice(found.index, end).map((line) => line.text).join("\n");
	const opening = new RegExp(`^\\s*${key}\\s*=\\s*\\[`).exec(assignment);
	if (!opening) return null;
	const closing = tomlArrayEnd(assignment, opening[0].length - 1);
	if (closing === -1 || !/^\s*(?:#.*)?$/.test(assignment.slice(closing + 1))) return null;
	const body = assignment.slice(opening[0].length, closing);
	const items: string[] = [];
	let i = 0;
	while (i < body.length) {
		const ch = body[i];
		if (/\s|,/.test(ch)) { i++; continue; }
		if (ch === "#") {
			const nl = body.indexOf("\n", i);
			if (nl === -1) break;
			i = nl + 1;
			continue;
		}
		if (ch === "'" || ch === '"') {
			const quote = ch;
			i++;
			let val = "";
			let closed = false;
			while (i < body.length) {
				const c = body[i];
				if (quote === '"' && c === "\\") {
					i++;
					if (i >= body.length) return null;
					const esc = body[i];
					if (esc === '"' || esc === "\\") val += esc;
					else if (esc === "n") val += "\n";
					else if (esc === "t") val += "\t";
					else if (esc === "r") val += "\r";
					else return null;
					i++;
					continue;
				}
				if (c === quote) { closed = true; i++; break; }
				if (c === "\n" || c === "\r" || c === "\0") return null;
				val += c;
				i++;
			}
			if (!closed) return null;
			items.push(val);
			continue;
		}
		return null;
	}
	return items;
}

/**
 * Conservative read of one Swival TOML file. Each accessor returns `null` when
 * the file cannot be interpreted safely so callers fail closed instead of
 * guessing a route, reviewer, or timeout.
 */
export interface SwivalTomlConfig {
	readonly raw: string;
	/** Text before the first table header. */
	readonly root: string;
	string(section: string, key: string): string | null | undefined;
	positiveInt(section: string, key: string): number | null | undefined;
	/** `undefined` when the profile is absent; `null` when profile headers are ambiguous. */
	profile(name: string): string | null | undefined;
	rootStringArray(key: string): string[] | null | undefined;
}

export function readSwivalTomlConfig(file: string, maxBytes = 128 * 1024): SwivalTomlConfig | undefined {
	const raw = readSafeRegularText(file, maxBytes);
	if (raw === undefined) return undefined;
	const lines = scanTomlLines(raw);
	if (!lines) return undefined;
	const headers = tomlHeaders(raw, lines);
	if (!headers) return undefined;
	const root = headers.length ? raw.slice(0, headers[0].start) : raw;
	return {
		raw,
		root,
		string: parseUniqueTomlString,
		positiveInt: parseUniqueTomlPositiveInt,
		profile: (name) => extractTomlProfileSection(raw, headers, name),
		rootStringArray: (key) => parseTomlRootStringArray(root, key),
	};
}

// ------------------------------------------------------- path helpers --

/** Join without normalizing so a later `..` is applied after symlink resolution, not lexically. */
export function expandTildePath(targetPath: string, homeDir: string = os.homedir()): string {
	if (targetPath === "~") return homeDir;
	if (targetPath.startsWith("~/") || targetPath.startsWith(`~${path.sep}`)) {
		return `${homeDir.replace(/[\\/]+$/, "")}${path.sep}${targetPath.slice(2)}`;
	}
	return targetPath;
}

export function canonicalPathOrResolved(targetPath: string, baseDir?: string, homeDir: string = os.homedir()): string {
	const expanded = expandTildePath(targetPath, homeDir);
	const absolute = path.isAbsolute(expanded) ? expanded : `${baseDir ?? process.cwd()}${path.sep}${expanded}`;
	let canonical: string;
	try { canonical = walkCanonicalPathSync(absolute); } catch { return path.resolve(absolute); }
	// Existing paths keep the on-disk spelling that realpath-derived Git directories use.
	try { return fs.realpathSync.native(canonical); } catch { return canonical; }
}

export const PROTECTED_HOME_SUBDIRS = [".ssh", ".gnupg", ".aws", ".config", ".pi", ".agentfs"] as const;

/** Default filesystems on these platforms are case-insensitive. */
export const foldPathCase = (location: string): string =>
	process.platform === "darwin" || process.platform === "win32" ? location.toLowerCase() : location;

/**
 * Read effective root-level `allowed_dirs_ro` from `<baseDir>/swival.toml` or
 * `$XDG_CONFIG_HOME/swival/config.toml` using Swival's precedence and
 * path-resolution rules, so adding `--add-dir-ro <commonGitDir>` does not
 * discard configured read-only directories.
 */
export function readConfiguredAllowedDirsRo(
	baseDir: string | undefined,
	homeDir: string = os.homedir(),
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	// Join without normalizing so a later `..` is applied after symlink resolution.
	const resolveEntries = (entries: string[], configDir: string): string[] =>
		entries.map((entry) => {
			const expanded = expandTildePath(entry, homeDir);
			return path.isAbsolute(expanded) ? expanded : `${configDir.replace(/[\\/]+$/, "")}${path.sep}${expanded}`;
		});
	if (baseDir && path.isAbsolute(baseDir)) {
		let realBaseDir: string | undefined;
		try { realBaseDir = fs.realpathSync.native(baseDir); } catch { /* No project directory: only global configuration applies. */ }
		if (realBaseDir) {
			// A present but unreadable project file fails closed rather than exposing
			// global entries the project may have meant to replace. An empty file
			// configures nothing, matching the evidence-grant reader.
			const projectFile = path.join(realBaseDir, "swival.toml");
			let projectStat: fs.Stats | undefined;
			try { projectStat = fs.lstatSync(projectFile); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return []; }
			if (projectStat && !(projectStat.isFile() && projectStat.size === 0)) {
				const project = readSwivalTomlConfig(projectFile, 65536);
				if (!project) return [];
				const entries = project.rootStringArray("allowed_dirs_ro");
				if (entries === null) return [];
				if (entries !== undefined) return resolveEntries(entries, realBaseDir);
			}
		}
	}
	try {
		const xdg = env.XDG_CONFIG_HOME?.trim();
		const globalDir = xdg ? path.join(xdg, "swival") : path.join(homeDir, ".config", "swival");
		const global = readSwivalTomlConfig(path.join(globalDir, "config.toml"), 65536);
		if (global) {
			const entries = global.rootStringArray("allowed_dirs_ro");
			if (entries === null) return [];
			if (entries !== undefined) return resolveEntries(entries, globalDir);
		}
	} catch { /* ignore */ }
	return [];
}

/**
 * Resolve the shared Git directory (`commondir`) for a linked Git worktree so
 * read-only Git inspection works under `--network provider-only` (`nono --read`).
 * Enforces bidirectional worktree invariants and protected-home exclusion.
 */
export function resolveLinkedWorktreeCommonGitDir(
	baseDir: string | undefined,
	homeDir: string = os.homedir(),
): string | undefined {
	if (!baseDir || !path.isAbsolute(baseDir)) return undefined;
	try {
		const realBaseDir = fs.realpathSync.native(baseDir);
		if (!fs.lstatSync(realBaseDir).isDirectory()) return undefined;
		const dotGitPath = path.join(realBaseDir, ".git");
		const dotGitStat = fs.lstatSync(dotGitPath);
		if (dotGitStat.isSymbolicLink() || !dotGitStat.isFile() || dotGitStat.size <= 0 || dotGitStat.size > 4096) return undefined;
		const dotGitMatch = /^gitdir:\s*([^\r\n\0]+)\r?\n?$/.exec(fs.readFileSync(dotGitPath, "utf-8"));
		if (!dotGitMatch) return undefined;
		const rawWorktreeGitDir = path.resolve(realBaseDir, dotGitMatch[1].trim());
		const rawWtStat = fs.lstatSync(rawWorktreeGitDir);
		if (rawWtStat.isSymbolicLink() || !rawWtStat.isDirectory()) return undefined;
		const worktreeGitDir = fs.realpathSync.native(rawWorktreeGitDir);
		for (const reqFile of ["HEAD", "commondir", "gitdir"] as const) {
			const st = fs.lstatSync(path.join(worktreeGitDir, reqFile));
			if (st.isSymbolicLink() || !st.isFile() || st.size <= 0 || st.size > 4096) return undefined;
		}
		const backGitdirRaw = fs.readFileSync(path.join(worktreeGitDir, "gitdir"), "utf-8").trim();
		if (!backGitdirRaw || /[\r\n\0]/.test(backGitdirRaw)) return undefined;
		const backGitdirResolved = path.resolve(worktreeGitDir, backGitdirRaw);
		const backGitdirDir = fs.realpathSync.native(path.dirname(backGitdirResolved));
		if (backGitdirDir !== realBaseDir || path.basename(backGitdirResolved) !== ".git") return undefined;
		const commondirRaw = fs.readFileSync(path.join(worktreeGitDir, "commondir"), "utf-8").trim();
		if (!commondirRaw || /[\r\n\0]/.test(commondirRaw)) return undefined;
		const rawCommonGitDir = path.resolve(worktreeGitDir, commondirRaw);
		const rawCommonStat = fs.lstatSync(rawCommonGitDir);
		if (rawCommonStat.isSymbolicLink() || !rawCommonStat.isDirectory()) return undefined;
		const commonGitDir = fs.realpathSync.native(rawCommonGitDir);
		if (path.dirname(worktreeGitDir) !== path.join(commonGitDir, "worktrees")) return undefined;
		if (commonGitDir === path.parse(commonGitDir).root) return undefined;
		if (commonGitDir === realBaseDir || commonGitDir.startsWith(realBaseDir + path.sep)) return undefined;
		const headStat = fs.lstatSync(path.join(commonGitDir, "HEAD"));
		if (headStat.isSymbolicLink() || !headStat.isFile() || headStat.size <= 0 || headStat.size > 4096) return undefined;
		for (const reqDir of ["objects", "refs"] as const) {
			const st = fs.lstatSync(path.join(commonGitDir, reqDir));
			if (st.isSymbolicLink() || !st.isDirectory()) return undefined;
		}
		const realHome = fs.existsSync(homeDir) ? fs.realpathSync.native(homeDir) : path.resolve(homeDir);
		const foldedCommonGitDir = foldPathCase(commonGitDir);
		if (foldedCommonGitDir === foldPathCase(realHome)) return undefined;
		for (const sub of PROTECTED_HOME_SUBDIRS) {
			const protectedRoot = foldPathCase(canonicalPathOrResolved(path.join(realHome, sub)));
			if (foldedCommonGitDir === protectedRoot || foldedCommonGitDir.startsWith(protectedRoot + path.sep) ||
				protectedRoot.startsWith(foldedCommonGitDir + path.sep)) return undefined;
		}
		return commonGitDir;
	} catch {
		return undefined;
	}
}

// ----------------------------------------------------- child environment --

export interface RouteSelection {
	provider?: string;
	profile?: string;
	baseUrl?: string;
	externalReviewer?: string;
	baseDir: string;
}

export function routeFromArgs(args: readonly string[], runCwd: string): RouteSelection {
	return {
		provider: lastCliOptionValue(args, "--provider"),
		profile: lastCliOptionValue(args, "--profile"),
		baseUrl: lastCliOptionValue(args, "--base-url"),
		externalReviewer: lastCliOptionValue(args, "--reviewer"),
		baseDir: path.resolve(runCwd, lastCliOptionValue(args, "--base-dir") ?? runCwd),
	};
}

/**
 * Resolve optional child-process environment overrides for a Swival launch.
 * - Bridges the API key of the single Pi custom provider in `~/.pi/agent/models.json`
 *   whose HTTPS `baseUrl` serves the effective `provider = "generic"` route into
 *   `OPENAI_API_KEY`, reading the key from `~/.pi/agent/auth.json`.
 * - Bridges Pi's `anthropic` OAuth/API token into `ANTHROPIC_API_KEY` (and
 *   requires the Anthropic OAuth compatibility shim for `sk-ant-oat...` tokens)
 *   when the route resolves to `provider = "anthropic"` on the canonical endpoint.
 * Fails closed when an external `--reviewer` subprocess or project `swival.toml`
 * is present. Returns `undefined` when no environment override is needed.
 */
export function resolveSwivalChildEnv(
	args: readonly string[],
	baseEnv: NodeJS.ProcessEnv = process.env,
	homeDir: string = os.homedir(),
	runCwd: string = process.cwd(),
): NodeJS.ProcessEnv | undefined {
	if (cliOptionEntries(args).some((entry) => entry.dangling)) return undefined;
	const route = routeFromArgs(args, runCwd);
	// Fail closed when an external --reviewer subprocess is configured, since
	// Swival passes child_env() (including bridged keys) to reviewer processes.
	if (route.externalReviewer !== undefined) return undefined;
	const { provider: cliProvider, profile: cliProfile, baseUrl: cliBaseUrl } = route;
	if (cliProvider !== undefined && cliProvider !== "generic" && cliProvider !== "anthropic") return undefined;
	if (cliBaseUrl !== undefined && !parseCanonicalHttpsEndpoint(cliBaseUrl)) return undefined;
	// Fail closed when <base-dir>/swival.toml exists, since Swival merges project
	// swival.toml with project-wins precedence and could redirect base_url.
	try {
		fs.lstatSync(path.join(route.baseDir, "swival.toml"));
		return undefined;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
	}

	let cfgProvider: string | undefined;
	let cfgBaseUrl: string | undefined;
	let cfgRootBaseUrl: string | undefined;
	const configRoot = baseEnv.XDG_CONFIG_HOME || path.join(homeDir, ".config");
	if (!path.isAbsolute(configRoot)) return undefined;
	const cfgPath = path.join(configRoot, "swival", "config.toml");
	let cfgExists = false;
	try {
		fs.lstatSync(cfgPath);
		cfgExists = true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
	}
	const config = cfgExists ? readSwivalTomlConfig(cfgPath) : undefined;
	if (cfgExists && config === undefined) return undefined;
	if (config) {
		if (config.string(config.root, "reviewer") !== undefined) return undefined;
		const rootActiveProfile = config.string(config.root, "active_profile");
		const rootProvider = config.string(config.root, "provider");
		const rootBaseUrl = config.string(config.root, "base_url");
		if (rootActiveProfile === null || rootProvider === null || rootBaseUrl === null) return undefined;
		cfgRootBaseUrl = rootBaseUrl;
		const selectedProfile = cliProfile ?? rootActiveProfile;
		if (selectedProfile) {
			const section = config.profile(selectedProfile);
			if (!section) return undefined;
			const profProvider = config.string(section, "provider");
			const profBaseUrl = config.string(section, "base_url");
			if (profProvider === null || profBaseUrl === null) return undefined;
			// Require explicit provider (and base_url for generic) in the selected
			// profile section rather than falling back to root values.
			cfgProvider = profProvider;
			cfgBaseUrl = profBaseUrl;
		} else {
			cfgProvider = rootProvider;
			cfgBaseUrl = rootBaseUrl;
		}
	} else if (cliProfile !== undefined) {
		return undefined;
	}

	const effectiveProvider = cliProvider ?? cfgProvider;
	const effectiveBaseUrl = cliBaseUrl ?? cfgBaseUrl;
	if (effectiveProvider === "generic") {
		if (baseEnv.OPENAI_API_KEY) return undefined;
		if (typeof effectiveBaseUrl !== "string") return undefined;
		const providerKey = resolvePiCustomProviderForBaseUrl(homeDir, effectiveBaseUrl);
		if (!providerKey) return undefined;
		const key = readPiAuthToken(homeDir, providerKey);
		return key ? { ...baseEnv, OPENAI_API_KEY: key } : undefined;
	}

	if (effectiveProvider === "anthropic") {
		if (baseEnv.ANTHROPIC_API_BASE !== undefined || baseEnv.ANTHROPIC_BASE_URL !== undefined) return undefined;
		const inheritedAnthropicBaseUrl = effectiveBaseUrl ?? cfgRootBaseUrl;
		if (inheritedAnthropicBaseUrl !== undefined &&
			parseCanonicalHttpsEndpoint(inheritedAnthropicBaseUrl)?.origin !== "https://api.anthropic.com") return undefined;
		const existingKey = typeof baseEnv.ANTHROPIC_API_KEY === "string" ? baseEnv.ANTHROPIC_API_KEY.trim() : "";
		const token = existingKey || readAnthropicAuthToken(homeDir);
		if (!token) return undefined;
		const nextEnv: NodeJS.ProcessEnv = { ...baseEnv };
		let changed = false;
		if (!existingKey) {
			nextEnv.ANTHROPIC_API_KEY = token;
			changed = true;
		}
		if (token.startsWith("sk-ant-oat")) {
			const entries = (baseEnv.PYTHONPATH ?? "").split(path.delimiter).filter(Boolean);
			if (entries[0] !== ANTHROPIC_OAUTH_SHIM_DIR) {
				nextEnv.PYTHONPATH = [ANTHROPIC_OAUTH_SHIM_DIR, ...entries.filter((entry) => entry !== ANTHROPIC_OAUTH_SHIM_DIR)].join(path.delimiter);
				changed = true;
			}
			// The OAuth route only works through the shim's route-identity hooks;
			// require their attestation instead of silently running unpatched.
			for (const [key, value] of [["PYTHONDONTWRITEBYTECODE", "1"], ["LITELLM_LOCAL_MODEL_COST_MAP", "True"], ["PI_SWIVAL_SHIM_REQUIRED", "1"]] as const) {
				if (baseEnv[key] !== value) {
					nextEnv[key] = value;
					changed = true;
				}
			}
		}
		return changed ? nextEnv : undefined;
	}

	return undefined;
}

/** Only AgentFS needs an OS write grant for host-exported evidence. */
export function resolveSwivalEvidenceEnv(
	args: readonly string[], evidenceDir: string, baseEnv: NodeJS.ProcessEnv,
	homeDir: string, runCwd: string,
): NodeJS.ProcessEnv | undefined {
	let sandbox = lastCliOptionValue(args, "--sandbox"), network = lastCliOptionValue(args, "--network");
	const baseDir = path.resolve(runCwd, lastCliOptionValue(args, "--base-dir") ?? runCwd);
	const configDir = baseEnv.XDG_CONFIG_HOME || path.join(homeDir, ".config");
	for (const file of [path.join(baseDir, "swival.toml"), path.join(configDir, "swival", "config.toml")]) {
		if (sandbox !== undefined && network !== undefined) break;
		let config: SwivalTomlConfig | undefined;
		try {
			const resolved = fs.realpathSync(file), stat = fs.lstatSync(resolved);
			if (stat.isFile() && stat.size === 0) continue;
			config = readSwivalTomlConfig(resolved);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return undefined;
		}
		if (config === undefined) return undefined;
		const configuredSandbox = sandbox === undefined ? config.string(config.root, "sandbox") : sandbox;
		const configuredNetwork = network === undefined ? config.string(config.root, "network") : network;
		if (configuredSandbox === null || configuredNetwork === null) return undefined;
		sandbox = configuredSandbox;
		network = configuredNetwork;
	}
	if (sandbox !== "agentfs" || network === "none") return undefined;
	const entries = (baseEnv.PYTHONPATH ?? "").split(path.delimiter).filter((entry) => entry && entry !== ANTHROPIC_OAUTH_SHIM_DIR);
	return { ...baseEnv, PI_SWIVAL_EVIDENCE_DIR: evidenceDir, PYTHONDONTWRITEBYTECODE: "1",
		PYTHONPATH: [ANTHROPIC_OAUTH_SHIM_DIR, ...entries].join(path.delimiter) };
}

/** Swival 1.9.3 does not pass add-dir-ro to the nono re-exec read grants.
 * Require explicit safe sandbox intent rather than silently overriding config. */
export function assertSwivalReviewCompatibility(args: readonly string[], disabled: boolean): void {
	if (!disabled || hasCliFlag(args, "--self-review")) return;
	const sandbox = lastCliOptionValue(args, "--sandbox");
	if ((sandbox !== "builtin" && sandbox !== "agentfs") || lastCliOptionValue(args, "--network") === "none") {
		throw new SwivalArgumentError("Explicit selfReview false requires an explicit sandbox builtin or agentfs and is incompatible with network none. Nono and inherited/unspecified sandbox selection are unsupported; addDirRo cannot grant nono startup-shim access. No silent fallback.");
	}
}

/** Swival 1.9.3 has no negative self-review CLI flag. Suppress inherited
 * self-review only for an explicit false; preserve external reviewer gates. */
export function resolveSwivalReviewEnv(args: readonly string[], disabled: boolean, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
	assertSwivalReviewCompatibility(args, disabled);
	if (!disabled || hasCliFlag(args, "--self-review")) return undefined;
	const entries = (baseEnv.PYTHONPATH ?? "").split(path.delimiter).filter((entry) => entry && entry !== ANTHROPIC_OAUTH_SHIM_DIR);
	return { ...baseEnv, PYTHONPATH: [ANTHROPIC_OAUTH_SHIM_DIR, ...entries].join(path.delimiter),
		PYTHONDONTWRITEBYTECODE: "1", LITELLM_LOCAL_MODEL_COST_MAP: "True",
		PI_SWIVAL_SHIM_REQUIRED: "1", PI_SWIVAL_NO_SELF_REVIEW: "1" };
}

// ------------------------------------------------------ provider timeout --

export function resolveEffectiveProviderTimeout(options: {
	agent?: Pick<SwivalAgentConfig, "providerTimeout" | "baseDir" | "extraArgs" | "profile">;
	overrides?: Pick<SwivalOverrides, "providerTimeout" | "profile">;
	args?: readonly string[];
	runCwd?: string;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	report?: Pick<ReportSummary, "providerTimeout">;
} = {}): EffectiveProviderTimeout {
	const { agent, overrides, args, runCwd, homeDir = os.homedir(), env = process.env, report } = options;
	const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
	const extraVal = lastCliOptionValue(agent?.extraArgs ?? [], "--provider-timeout");
	if (extraVal !== undefined && positive(Number(extraVal))) return { seconds: Number(extraVal), source: "agent extraArgs" };
	if (positive(overrides?.providerTimeout)) return { seconds: overrides!.providerTimeout!, source: "providerTimeoutOverride" };
	if (positive(agent?.providerTimeout)) return { seconds: agent!.providerTimeout!, source: "agent frontmatter" };
	const cliProfile = args ? lastCliOptionValue(args, "--profile") : undefined;
	if (args) {
		const cliVal = lastCliOptionValue(args, "--provider-timeout");
		if (cliVal !== undefined && positive(Number(cliVal))) return { seconds: Number(cliVal), source: "cli" };
	}
	if (positive(report?.providerTimeout)) return { seconds: report!.providerTimeout!, source: "report.settings" };
	const configuredBaseDir = (args ? lastCliOptionValue(args, "--base-dir") : undefined) ?? agent?.baseDir ?? runCwd;
	const effectiveBaseDir = configuredBaseDir
		? (runCwd ? path.resolve(runCwd, configuredBaseDir) : path.resolve(configuredBaseDir))
		: undefined;
	// Diagnostics only: recognize the same conservative TOML subset as the
	// credential bridge. Never claim a default for a file we cannot interpret.
	const unknown: EffectiveProviderTimeout = { seconds: null, source: "unresolved configuration" };
	const xdg = env.XDG_CONFIG_HOME?.trim();
	const globalDir = xdg ? path.join(xdg, "swival") : path.join(homeDir, ".config", "swival");
	const files = [
		{ file: path.join(globalDir, "config.toml"), source: "config.toml" },
		...(effectiveBaseDir ? [{ file: path.join(effectiveBaseDir, "swival.toml"), source: "swival.toml" }] : []),
	];
	let timeout: EffectiveProviderTimeout = { seconds: 900, source: "default" };
	let selectedProfile = cliProfile ?? overrides?.profile ?? agent?.profile;
	const sections: { config: SwivalTomlConfig; source: string }[] = [];
	for (const { file, source } of files) {
		if (!fs.existsSync(file)) continue;
		const config = readSwivalTomlConfig(file);
		if (config === undefined) return unknown;
		const value = config.positiveInt(config.root, "provider_timeout");
		const active = config.string(config.root, "active_profile");
		if (value === null || active === null) return unknown;
		if (value !== undefined) timeout = { seconds: value, source };
		if (!cliProfile && !overrides?.profile && !agent?.profile && active) selectedProfile = active;
		sections.push({ config, source });
	}
	if (selectedProfile) {
		let found = false;
		for (const { config, source } of sections) {
			const section = config.profile(selectedProfile);
			if (section === undefined) continue;
			if (!section) return unknown;
			found = true;
			const value = config.positiveInt(section, "provider_timeout");
			if (value === null) return unknown;
			if (value !== undefined) timeout = { seconds: value, source: `${source} selected profile` };
		}
		if (!found) return unknown;
	}
	return timeout;
}
