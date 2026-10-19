import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fixtureGit, fixtureRepository, fixtureSearchPath, nativeScratch } from "./nativeFixtures.js";

let root: string;
beforeEach(() => {
	root = nativeScratch("native-fixture-isolation-");
	const excludes = path.join(root, "global-ignore");
	fs.writeFileSync(excludes, "code.py\n.SWIVAL/\n");
	const config = path.join(root, "gitconfig");
	fs.writeFileSync(config, `[core]\n\texcludesFile = ${JSON.stringify(excludes)}\n`);
	vi.stubEnv("GIT_CONFIG_GLOBAL", config);
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

it("keeps only absolute fixture PATH entries without changing the inherited PATH", () => {
	const inherited = ["relative-bin", "/usr/bin", "", ".", "~/.dotnet/tools", "/bin"].join(path.delimiter);
	vi.stubEnv("PATH", inherited);
	expect(fixtureSearchPath()).toBe(["/usr/bin", "/bin"].join(path.delimiter));
	expect(process.env.PATH).toBe(inherited);
	expect(fixtureSearchPath("")).toBe("");
});

it("commits the shared fixture repository despite global Git exclusions", () => {
	const source = fixtureRepository(root);
	expect(fixtureGit(source, "show", "HEAD:code.py")).toBe("def answer(): return 42");
});

it("stages reserved evidence bytes despite a synthetic global Git exclusion", () => {
	const source = path.join(root, "source"); fs.mkdirSync(source);
	fixtureGit(source, "init", "--template=");
	fixtureGit(source, "config", "user.name", "Test");
	fixtureGit(source, "config", "user.email", "test@example.invalid");
	const alias = ".SWIVAL/AUDIT/state.json";
	fs.mkdirSync(path.dirname(path.join(source, alias)), { recursive: true });
	fs.writeFileSync(path.join(source, alias), "source-controlled evidence");
	// Prove the synthetic operator configuration really would hide the alias.
	expect(execFileSync("git", ["check-ignore", "--", alias], {
		cwd: source, timeout: 5000, maxBuffer: 16_384, encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim()).toBe(alias);
	fixtureGit(source, "add", "--", alias);
	fixtureGit(source, "commit", "-m", "reserved evidence fixture");
	expect(fixtureGit(source, "show", `HEAD:${alias}`)).toBe("source-controlled evidence");
});
