/**
 * Low-level path, bounded-read, and version helpers shared by CLI planning,
 * artifact I/O, and the native audit boundary. This module has no runtime
 * dependency on any other extension module; its only sibling import is erased
 * type metadata from contracts.ts.
 */

import * as fs from "node:fs/promises";
import { constants, closeSync, fstatSync, lstatSync, openSync, readlinkSync, readSync } from "node:fs";
import * as path from "node:path";
import type { EffectiveProviderTimeout } from "./contracts.js";

export async function canonicalFuturePath(target: string, links = 0): Promise<string> {
	if (links > 40) throw new Error("Too many symlinks while resolving path");
	let parent = path.resolve(target);
	const suffix: string[] = [];
	while (true) {
		try { return path.join(await fs.realpath(parent), ...suffix.reverse()); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// realpath reports ENOENT for dangling links too. Resolve their target
			// before appending missing components instead of treating them as leaves.
			const stat = await fs.lstat(parent).catch((cause: NodeJS.ErrnoException) => {
				if (cause.code !== "ENOENT") throw cause;
				return undefined;
			});
			if (stat?.isSymbolicLink()) {
				const link = await fs.readlink(parent);
				// Lexical normalization can erase a symlink before its following `..`.
				// Missing targets cannot be canonicalized by realpath; reject that ambiguity.
				if (link.split(/[\\/]/).includes("..")) throw new Error("Ambiguous dangling symlink target");
				const target = path.resolve(path.dirname(parent), link);
				return path.join(await canonicalFuturePath(target, links + 1), ...suffix.reverse());
			}
			suffix.push(path.basename(parent));
			const next = path.dirname(parent);
			if (next === parent) throw error;
			parent = next;
		}
	}
}

/**
 * Resolve an absolute path component by component, following each symlink
 * before applying the `..` that follows it. Lexical normalization would
 * collapse `link/../..` relative to the link's location rather than its
 * target, which is how the kernel and Python's realpath resolve it. Missing
 * components are appended unchanged; a `..` that steps back into an existing
 * ancestor resumes symlink resolution there. Any error other than a missing
 * component (ENOTDIR, ELOOP, EACCES, ...) propagates.
 */
export function walkCanonicalPathSync(target: string): string {
	if (!path.isAbsolute(target)) throw new Error("walkCanonicalPathSync requires an absolute path");
	let current = path.parse(target).root;
	let pending = target.slice(current.length).split(path.sep);
	let links = 0;
	while (pending.length) {
		const component = pending.shift()!;
		if (!component || component === ".") continue;
		if (component === "..") { current = path.dirname(current); continue; }
		current = path.join(current, component);
		let stat;
		try { stat = lstatSync(current); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			continue;
		}
		if (stat.isSymbolicLink()) {
			if (++links > 40) throw new Error("Too many symlinks while resolving path");
			const linkTarget = readlinkSync(current);
			current = path.isAbsolute(linkTarget) ? path.parse(linkTarget).root : path.dirname(current);
			pending = [...linkTarget.slice(path.isAbsolute(linkTarget) ? current.length : 0).split(path.sep), ...pending];
		}
	}
	return current;
}

/** Compare directory identities as well as spelling on case-insensitive filesystems. */
export async function pathIsWithin(location: string, root: string): Promise<boolean> {
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

export interface SafeReadOptions {
	/** Reject group/world-writable files (mode & 0o022). */
	requirePrivatePerms?: boolean;
}

/**
 * Read one owned regular file without following a leaf symlink, blocking on a
 * FIFO, or accepting a hard-linked or oversized file. Returns undefined on any
 * refusal so callers fail closed.
 */
export function readSafeRegularBytes(filePath: string, maxBytes: number, options: SafeReadOptions = {}): Buffer | undefined {
	if (typeof constants.O_NOFOLLOW !== "number") return undefined;
	let fd: number | undefined;
	try {
		const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0);
		fd = openSync(filePath, flags);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > maxBytes) return undefined;
		if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return undefined;
		if (options.requirePrivatePerms && (stat.mode & 0o022) !== 0) return undefined;
		const buffer = Buffer.alloc(stat.size);
		const bytesRead = readSync(fd, buffer, 0, stat.size, 0);
		return buffer.subarray(0, bytesRead);
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
	}
}

export function readSafeRegularText(filePath: string, maxBytes: number, options: SafeReadOptions = {}): string | undefined {
	return readSafeRegularBytes(filePath, maxBytes, options)?.toString("utf-8");
}

/**
 * Read one provider credential from Pi's `~/.pi/agent/auth.json`. Anthropic
 * OAuth tokens must be unexpired `sk-ant-oat...` values; API keys pass through.
 * OAuth entries for any other provider are refused.
 */
export function readPiAuthToken(homeDir: string, provider: string): string | undefined {
	if (!provider) return undefined;
	const raw = readSafeRegularText(path.join(homeDir, ".pi", "agent", "auth.json"), 65536, { requirePrivatePerms: true });
	if (raw === undefined) return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.hasOwn(parsed, provider)) return undefined;
		const entry = (parsed as Record<string, unknown>)[provider] as Record<string, unknown> | undefined;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
		if (provider === "anthropic" && entry.type === "oauth") {
			const expires = entry.expires;
			if (typeof expires === "number" && Number.isFinite(expires) && expires <= Date.now()) return undefined;
			const access = typeof entry.access === "string" ? entry.access.trim() : "";
			return access.startsWith("sk-ant-oat") ? access : undefined;
		}
		if (entry.type === undefined || entry.type === "api_key") {
			const key = typeof entry.key === "string" ? entry.key.trim() : "";
			return key || undefined;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export function readAnthropicAuthToken(homeDir: string): string | undefined {
	return readPiAuthToken(homeDir, "anthropic");
}

export interface CanonicalHttpsEndpoint {
	/** Lower-cased `https://host[:port]`. */
	origin: string;
	/** Pathname without trailing slashes; `/` when empty. */
	pathPrefix: string;
}

/**
 * Parse a provider base URL into a comparable origin and path prefix. Accepts
 * only trimmed `https:` URLs without userinfo, query, fragment, backslashes, or
 * raw/percent-encoded dot segments and slashes, so a credential bridge can
 * never match through normalization tricks.
 */
export function parseCanonicalHttpsEndpoint(raw: string): CanonicalHttpsEndpoint | undefined {
	if (typeof raw !== "string" || raw !== raw.trim() || !raw || raw.includes("\\")) return undefined;
	if (/%2e|%2f|%5c/i.test(raw) || raw.split("/").some((segment) => segment === "." || segment === "..")) return undefined;
	let url: URL;
	try { url = new URL(raw); } catch { return undefined; }
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname) return undefined;
	return { origin: url.origin.toLowerCase(), pathPrefix: url.pathname.replace(/\/+$/, "") || "/" };
}

/**
 * Resolve the Pi custom-provider key in `~/.pi/agent/models.json` whose
 * `baseUrl` serves `targetBaseUrl`. A provider matches on identical origin when
 * its path prefix equals or is an ancestor of the target path. Returns the key
 * only when exactly one non-Anthropic HTTPS provider matches; zero or several
 * matches fail closed.
 */
export function resolvePiCustomProviderForBaseUrl(homeDir: string, targetBaseUrl: string): string | undefined {
	const target = parseCanonicalHttpsEndpoint(targetBaseUrl);
	if (!target) return undefined;
	const raw = readSafeRegularText(path.join(homeDir, ".pi", "agent", "models.json"), 262144, { requirePrivatePerms: true });
	if (raw === undefined) return undefined;
	let providers: unknown;
	try { providers = (JSON.parse(raw) as { providers?: unknown })?.providers; } catch { return undefined; }
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;
	const matches: string[] = [];
	for (const [name, entry] of Object.entries(providers as Record<string, unknown>)) {
		if (name === "anthropic" || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const baseUrl = (entry as { baseUrl?: unknown }).baseUrl;
		if (typeof baseUrl !== "string") continue;
		const candidate = parseCanonicalHttpsEndpoint(baseUrl);
		if (!candidate || candidate.origin !== target.origin) continue;
		if (candidate.pathPrefix === target.pathPrefix || candidate.pathPrefix === "/" ||
			target.pathPrefix.startsWith(candidate.pathPrefix + "/")) matches.push(name);
	}
	return matches.length === 1 ? matches[0] : undefined;
}

export function parseSemver(v: string): [number, number, number] | null {
	const match = v.match(/\bv?(\d+)\.(\d+)\.(\d+)\b/);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(a: string, b: string): number {
	const pa = parseSemver(a);
	const pb = parseSemver(b);
	if (!pa || !pb) return 0;
	if (pa[0] !== pb[0]) return pa[0] - pb[0];
	if (pa[1] !== pb[1]) return pa[1] - pb[1];
	return pa[2] - pb[2];
}

const PROVIDER_TIMEOUT_SOURCES = new Set(["agent extraArgs", "providerTimeoutOverride", "agent frontmatter", "cli",
	"report.settings", "swival.toml", "config.toml", "swival.toml selected profile", "config.toml selected profile",
	"default", "unresolved configuration"]);

export function parseEffectiveProviderTimeout(value: unknown): EffectiveProviderTimeout | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	if (Object.keys(v).length !== 2 || typeof v.source !== "string" || !PROVIDER_TIMEOUT_SOURCES.has(v.source) ||
		!(v.seconds === null || typeof v.seconds === "number" && Number.isFinite(v.seconds) && v.seconds > 0)) return undefined;
	return { seconds: v.seconds as number | null, source: v.source };
}
