import * as fs from "node:fs/promises";
import * as path from "node:path";

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
