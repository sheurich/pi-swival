import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CacheResolutionInput {
	baseDir: string;
	cacheDirOverride?: string;
	agentCacheDir?: string;
	env?: Readonly<Record<string, string | undefined>>;
	stateRoot?: string;
}

export interface CacheResolution {
	dir: string;
	source: "override" | "frontmatter" | "environment" | "default";
}

/**
 * Cache precedence is explicit per-call override, agent frontmatter, the
 * PI_SWIVAL_CACHE_DIR escape hatch, then the extension-owned default.
 */
export function resolveCacheDir(input: CacheResolutionInput): CacheResolution {
	const baseDir = path.resolve(input.baseDir);
	const supplied = input.cacheDirOverride ?? input.agentCacheDir;
	if (supplied) {
		return {
			dir: path.resolve(baseDir, supplied),
			source: input.cacheDirOverride !== undefined ? "override" : "frontmatter",
		};
	}
	const envDir = input.env?.PI_SWIVAL_CACHE_DIR;
	if (envDir) return { dir: path.resolve(envDir), source: "environment" };

	const stateRoot = input.stateRoot ?? path.join(os.homedir(), ".pi", "agent", "swival-cache");
	const human = path.basename(baseDir).replace(/[^A-Za-z0-9._-]/g, "-") || "root";
	const digest = createHash("sha256").update(baseDir).digest("hex").slice(0, 16);
	return { dir: path.join(stateRoot, `${human}-${digest}`), source: "default" };
}

function isInside(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isSameOrInside(child: string, parent: string): boolean {
	return child === parent || isInside(child, parent);
}

function isMissingPathError(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function canonicalizePath(target: string, seen: ReadonlySet<string> = new Set()): Promise<string> {
	const resolved = path.resolve(target);
	if (seen.has(resolved)) {
		throw new Error(`Unsafe cache path ${target} contains a symlink loop.`);
	}
	const nextSeen = new Set(seen);
	nextSeen.add(resolved);
	const { root } = path.parse(resolved);
	const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
	let current = root;
	for (let index = 0; index < parts.length; index++) {
		const candidate = path.join(current, parts[index]);
		let stats: fs.Stats;
		try {
			stats = await fs.promises.lstat(candidate);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			return path.join(current, ...parts.slice(index));
		}
		if (stats.isSymbolicLink()) {
			const linkTarget = await fs.promises.readlink(candidate);
			const canonicalTarget = await canonicalizePath(path.resolve(current, linkTarget), nextSeen);
			return index + 1 < parts.length
				? canonicalizePath(path.join(canonicalTarget, ...parts.slice(index + 1)), nextSeen)
				: canonicalTarget;
		}
		current = candidate;
	}
	return current;
}

/** Reject cache/checkouts that overlap in either direction, including through symlinks. */
export async function ensureCacheGuard(cacheDir: string, baseDir: string): Promise<void> {
	const resolvedCache = path.resolve(cacheDir);
	const resolvedBase = path.resolve(baseDir);
	const [canonicalCache, canonicalBase] = await Promise.all([
		canonicalizePath(resolvedCache),
		canonicalizePath(resolvedBase),
	]);
	const overlaps =
		isSameOrInside(resolvedCache, resolvedBase)
		|| isSameOrInside(resolvedBase, resolvedCache)
		|| isSameOrInside(canonicalCache, canonicalBase)
		|| isSameOrInside(canonicalBase, canonicalCache);
	if (overlaps) {
		throw new Error(`Unsafe cache path ${cacheDir} overlaps the checkout ${baseDir}. Choose a cache directory outside the checkout.`);
	}
}

export { isInside as isCacheInside };
