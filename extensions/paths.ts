import * as fs from "node:fs/promises";
import { lstatSync, readlinkSync } from "node:fs";
import * as path from "node:path";

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
