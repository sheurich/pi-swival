import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as native from "../extensions/native-audit.js";
import { nativeScratch } from "./nativeFixtures.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = nativeScratch("native-auth-"); roots.push(root);
	const home = path.join(root, "home"); fs.mkdirSync(home);
	const source = path.join(root, "source"); fs.mkdirSync(source);
	const directory = path.join(home, ".config/litellm/chatgpt");
	return { root, home, source, directory };
}
const prepare = async (environment: NodeJS.ProcessEnv, forbidden: string[]) => {
	const implementation = (native as any).prepareNativeAuthStore;
	expect(implementation, "A dedicated auth directory must be validated before granting runtime access").toBeTypeOf("function");
	return implementation(environment, forbidden);
};

describe("native runtime-only ChatGPT auth grant", () => {
	it("creates only the dedicated default store without reading credential contents", async () => {
		const f = fixture();
		const store = await prepare({ HOME: f.home }, [f.source]);
		expect(store).toEqual({ directory: f.directory, filename: "auth.json" });
		expect(fs.statSync(f.directory).isDirectory()).toBe(true);
		expect(fs.readdirSync(f.directory)).toEqual([]);
	});
	it("accepts a dedicated explicit directory and basename without copying its synthetic contents", async () => {
		const f = fixture(); const directory = path.join(f.home, "custom-auth"); fs.mkdirSync(directory);
		fs.writeFileSync(path.join(directory, "account.json"), "synthetic-private-content", { mode: 0o600 });
		expect(await prepare({ HOME: f.home, CHATGPT_TOKEN_DIR: directory, CHATGPT_AUTH_FILE: "account.json" }, [f.source]))
			.toEqual({ directory, filename: "account.json" });
		expect(fs.readFileSync(path.join(directory, "account.json"), "utf8")).toBe("synthetic-private-content");
	});
	it.each(["source", "git", "artifacts"])("refuses an auth store overlapping %s within home", async (kind) => {
		const f = fixture(); const forbidden = path.join(f.home, kind);
		fs.mkdirSync(forbidden);
		await expect(prepare({ HOME: f.home, CHATGPT_TOKEN_DIR: path.join(forbidden, "auth") }, [forbidden]))
			.rejects.toThrow(/scope/);
		expect(fs.existsSync(path.join(forbidden, "auth"))).toBe(false);
	});

	it.each(["source", "git", "artifacts"])("refuses case-aliased or symlinked %s scope before creating an auth store", async (kind) => {
		const f = fixture(); const forbidden = path.join(f.home, kind); fs.mkdirSync(forbidden);
		const alias = path.join(f.home, kind.toUpperCase());
		if (!fs.existsSync(alias)) fs.symlinkSync(forbidden, alias);
		await expect(prepare({ HOME: f.home, CHATGPT_TOKEN_DIR: path.join(alias, "auth") }, [forbidden]))
			.rejects.toThrow(/scope/);
		expect(fs.existsSync(path.join(forbidden, "auth"))).toBe(false);
	});

	it.each([".agentfs/run", ".agentfs", ".AGENTFS/RUN/future", "Library", "Library/Caches/future", ".pi/sessions/future", ".cache/future"])(
		"reserves future runtime namespace %s before auth creation", async (relative) => {
			const f = fixture(); const directory = path.join(f.home, relative);
			await expect(prepare({ HOME: f.home, CHATGPT_TOKEN_DIR: directory }, [f.source]))
				.rejects.toThrow(/auth|scope|runtime/i);
			expect(fs.existsSync(directory)).toBe(false);
		});
	it.each(["TMPDIR", "XDG_CACHE_HOME"])("reserves prospective %s before creating an ancestor auth store", async (variable) => {
		const f = fixture(); const directory = path.join(f.home, "runtime");
		await expect(prepare({ HOME: f.home, CHATGPT_TOKEN_DIR: directory, [variable]: path.join(directory, "future") }, [f.source]))
			.rejects.toThrow(/auth|scope|runtime/i);
		expect(fs.existsSync(directory)).toBe(false);
	});
	it("reserves a symlink alias of future AgentFS state before auth creation", async () => {
		const f = fixture(); fs.mkdirSync(path.join(f.home, ".agentfs"));
		const alias = path.join(f.home, "state-alias"); fs.symlinkSync(path.join(f.home, ".agentfs"), alias);
		await expect(prepare({ HOME: f.home, CHATGPT_TOKEN_DIR: path.join(alias, "run") }, [f.source]))
			.rejects.toThrow(/auth|scope|runtime/i);
		expect(fs.existsSync(path.join(alias, "run"))).toBe(false);
	});
	it.each([".CONFIG", ".CONFIG/LITELLM"])("refuses a case-aliased broad %s grant even before it exists", async (relative) => {
		const f = fixture(); const directory = path.join(f.home, relative);
		await expect(prepare({ HOME: f.home, CHATGPT_TOKEN_DIR: directory }, [f.source])).rejects.toThrow(/auth|broad/);
		expect(fs.existsSync(directory)).toBe(false);
	});

	it.each(["relative", "traversal", "home", "root", "config", "source", "outside-home", "directory-link", "ancestor-link", "file-link", "file-hardlink", "directory-file", "mixed-store", "file-traversal", "file-absolute", "file-empty", "file-readonly", "file-shared", "directory-shared"])(
		"refuses ambiguous or broad %s grants without following the target", async (kind) => {
			const f = fixture(); let directory = f.directory; let filename = "auth.json";
			if (kind === "relative") directory = "relative-auth";
			if (kind === "traversal") directory = `${f.home}/nested/../auth`;
			if (kind === "home") directory = f.home;
			if (kind === "root") directory = path.parse(f.home).root;
			if (kind === "config") directory = path.join(f.home, ".config");
			if (kind === "source") directory = f.source;
			if (kind === "outside-home") directory = path.join(f.root, "outside");
			if (kind === "file-traversal") filename = "../auth.json";
			if (kind === "file-absolute") filename = path.join(f.home, "auth.json");
			if (kind === "file-empty") filename = "";
			if (["directory-link", "ancestor-link", "file-link", "file-hardlink", "directory-file", "mixed-store", "file-readonly", "file-shared", "directory-shared"].includes(kind)) {
				fs.mkdirSync(path.dirname(directory), { recursive: true });
				if (kind === "directory-link") fs.symlinkSync(f.source, directory);
				else if (kind === "ancestor-link") { fs.rmdirSync(path.dirname(directory)); fs.symlinkSync(f.source, path.dirname(directory)); }
				else if (kind === "directory-file") fs.writeFileSync(directory, "not a directory");
				else {
					fs.mkdirSync(directory);
					const target = path.join(f.source, "sentinel"); fs.writeFileSync(target, "protected");
					if (kind === "file-link") fs.symlinkSync(target, path.join(directory, filename));
					if (kind === "file-hardlink") fs.linkSync(target, path.join(directory, filename));
					if (kind === "mixed-store") fs.writeFileSync(path.join(directory, "unrelated.json"), "unrelated");
					if (kind === "file-readonly" || kind === "file-shared") {
						fs.writeFileSync(path.join(directory, filename), "synthetic");
						fs.chmodSync(path.join(directory, filename), kind === "file-readonly" ? 0o400 : 0o666);
					}
					if (kind === "directory-shared") fs.chmodSync(directory, 0o777);
				}
			}
			await expect(prepare({ HOME: f.home, CHATGPT_TOKEN_DIR: directory, CHATGPT_AUTH_FILE: filename }, [f.source]))
				.rejects.toThrow(/auth|dedicated|directory|symlink|scope|path/i);
		});
});
