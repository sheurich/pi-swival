import * as fs from "node:fs/promises";
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
				const target = path.resolve(path.dirname(parent), await fs.readlink(parent));
				return path.join(await canonicalFuturePath(target, links + 1), ...suffix.reverse());
			}
			suffix.push(path.basename(parent));
			const next = path.dirname(parent);
			if (next === parent) throw error;
			parent = next;
		}
	}
}
