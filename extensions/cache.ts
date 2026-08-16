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

export interface CacheGuardFs {
	mkdir(dir: string, options: { recursive: true }): Promise<void>;
	readFile(file: string, encoding: "utf8"): Promise<string>;
	writeFile(file: string, contents: string, encoding: "utf8"): Promise<void>;
}

const nodeCacheFs: CacheGuardFs = {
	mkdir: (dir, options) => fs.promises.mkdir(dir, options),
	readFile: (file, encoding) => fs.promises.readFile(file, encoding),
	writeFile: (file, contents, encoding) => fs.promises.writeFile(file, contents, encoding),
};

function isInside(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Ensure a cache inside a checkout cannot add cache files to git. */
export async function ensureCacheGuard(
	cacheDir: string,
	baseDir: string,
	fileSystem: CacheGuardFs = nodeCacheFs,
): Promise<void> {
	const resolvedCache = path.resolve(cacheDir);
	const resolvedBase = path.resolve(baseDir);
	if (!isInside(resolvedCache, resolvedBase)) return;
	await fileSystem.mkdir(resolvedCache, { recursive: true });
	const ignoreFile = path.join(resolvedCache, ".gitignore");
	let existing: string | undefined;
	try {
		existing = await fileSystem.readFile(ignoreFile, "utf8");
	} catch {
		// A missing ignore file is the normal case.
	}
	if (existing !== undefined) {
		const ignoresEverything = existing.split(/\r?\n/).some((line) => line.trim() === "*");
		if (ignoresEverything) return;
		// Preserve a user's existing rules; the final rule is the belt-and-braces
		// cache guard. We never replace an existing .gitignore wholesale.
		await fileSystem.writeFile(ignoreFile, `${existing.replace(/\s*$/, "")}\n*\n`, "utf8");
		return;
	}
	await fileSystem.writeFile(ignoreFile, "*\n", "utf8");
}

export { isInside as isCacheInside };
