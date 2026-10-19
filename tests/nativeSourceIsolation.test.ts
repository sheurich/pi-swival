import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as native from "../extensions/native-audit.js";
import { nativeScratch } from "./nativeFixtures.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const check = async (protectedRoots: string[], writableRoots: string[]) => {
	const implementation = (native as any).assertNativeSourceIsolation;
	expect(implementation).toBeTypeOf("function");
	return implementation(protectedRoots, writableRoots);
};

describe("AgentFS 0.6.4 built-in write exceptions", () => {
	it("records the reviewed Darwin policy, including paths omitted from its banner", () => {
		const policy = (native as any).agentfsDarwinWriteRoots;
		expect(policy).toBeTypeOf("function");
		expect(policy("/synthetic/home", "native-test")).toEqual([
			"/private/tmp", "/tmp", "/var/tmp", "/private/var/folders", "/dev", "/private/var/db/mds",
			"/synthetic/home/Library", "/Library/Preferences", "/Library/Keychains",
			"/synthetic/home/.agentfs/run/native-test",
		]);
	});
	it.each(["source", "git", "common-git"])("refuses protected %s inside a built-in writable fixture", async (kind) => {
		const root = nativeScratch("native-source-policy-"); roots.push(root);
		const writable = path.join(root, "temporary"); fs.mkdirSync(writable);
		const protectedRoots = ["source", "git", "common-git"].map((name) => {
			const directory = path.join(name === kind ? writable : root, name);
			fs.mkdirSync(directory); return directory;
		});
		await expect(check(protectedRoots, [writable])).rejects.toThrow(/source|Git|writable/);
	});
	it("refuses worktree-owned symlink and case aliases without writing to host temporary roots", async () => {
		const root = nativeScratch("native-source-policy-"); roots.push(root);
		const temporary = path.join(root, "temporary"); fs.mkdirSync(temporary);
		const alias = path.join(root, "alias"); fs.symlinkSync(temporary, alias);
		const protectedRoot = path.join(temporary, "source"); fs.mkdirSync(protectedRoot);
		const caseAlias = path.join(alias, "SOURCE");
		if (!fs.existsSync(caseAlias)) fs.symlinkSync(protectedRoot, caseAlias);
		await expect(check([caseAlias], [temporary])).rejects.toThrow(/source|Git|writable/);
	});
	it("refuses a future session directory inside protected source", async () => {
		const root = nativeScratch("native-source-policy-"); roots.push(root);
		await expect(check([root], [path.join(root, "future-session")])).rejects.toThrow(/source|Git|writable/);
		expect(fs.readdirSync(root)).toEqual([]);
	});
	it("accepts disjoint canonical source and Git paths", async () => {
		const root = nativeScratch("native-source-policy-"); roots.push(root);
		const protectedRoot = path.join(root, "source"); fs.mkdirSync(protectedRoot);
		await expect(check([protectedRoot], [path.join(root, "temporary")])).resolves.toBeUndefined();
		expect(fs.readdirSync(protectedRoot)).toEqual([]);
	});
});
