import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCacheGuard, resolveCacheDir } from "../extensions/cache.js";
import { credentialPreflight, resolveCredentialPreflightRoute } from "../extensions/preflight.js";

const env = {};
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swival-cache-test-"));
	tempDirs.push(dir);
	return dir;
}

async function expectUnsafeCache(cacheDir: string, baseDir: string): Promise<void> {
	await expect(ensureCacheGuard(cacheDir, baseDir)).rejects.toThrow(/cache.*checkout|checkout.*cache|unsafe/i);
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(async (dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("cache resolution", () => {
	it("uses a stable, repo-specific extension-owned path outside each repository", () => {
		const firstRepo = "/work/repo-one";
		const secondRepo = "/work/repo-two";
		const first = resolveCacheDir({ baseDir: firstRepo, stateRoot: "/state", env });
		const firstAgain = resolveCacheDir({ baseDir: firstRepo, stateRoot: "/state", env });
		const second = resolveCacheDir({ baseDir: secondRepo, stateRoot: "/state", env });

		expect(first.dir).toBe(firstAgain.dir);
		expect(first.dir).not.toBe(second.dir);
		expect(first.dir).not.toBe(firstRepo);
		expect(second.dir).not.toBe(secondRepo);
		expect(first.dir.startsWith(`${firstRepo}/`)).toBe(false);
		expect(second.dir.startsWith(`${secondRepo}/`)).toBe(false);
		expect(first.dir).toContain("repo-one-");
		expect(second.dir).toContain("repo-two-");
	});

	it("applies override, frontmatter, environment precedence", () => {
		expect(resolveCacheDir({ baseDir: "/repo", cacheDirOverride: "/call", agentCacheDir: "/agent", env: { PI_SWIVAL_CACHE_DIR: "/env" } }).dir).toBe("/call");
		expect(resolveCacheDir({ baseDir: "/repo", agentCacheDir: "/agent", env: { PI_SWIVAL_CACHE_DIR: "/env" } }).dir).toBe("/agent");
		expect(resolveCacheDir({ baseDir: "/repo", env: { PI_SWIVAL_CACHE_DIR: "/env" } }).dir).toBe("/env");
	});

	it("rejects cache paths at the checkout root or inside it without writing", async () => {
		const scratch = await makeTempDir();
		const repo = path.join(scratch, "repo");
		await fs.mkdir(repo);

		await expectUnsafeCache(repo, repo);
		await expectUnsafeCache(path.join(repo, ".swival"), repo);

		await expect(fs.access(path.join(repo, ".swival", ".gitignore"))).rejects.toThrow();
	});

	it("rejects cache roots that contain the checkout, without creating files", async () => {
		const scratch = await makeTempDir();
		const cacheRoot = path.join(scratch, "cache-root");
		const repo = path.join(cacheRoot, "repo");
		await fs.mkdir(repo, { recursive: true });

		await expectUnsafeCache(cacheRoot, repo);
		await expect(fs.access(path.join(cacheRoot, ".gitignore"))).rejects.toThrow();
	});

	it("rejects lexical aliases into the checkout, including non-existent descendants", async () => {
		const scratch = await makeTempDir();
		const repoParent = path.join(scratch, "repos");
		const repo = path.join(repoParent, "repo");
		await fs.mkdir(repo, { recursive: true });
		const aliasBase = path.join(repoParent, ".", "repo", "nested", "..", ".");
		const aliasCache = path.join(aliasBase, "cache", "missing", "db");

		await expectUnsafeCache(aliasCache, repo);
		await expect(fs.access(path.join(repo, "cache"))).rejects.toThrow();
	});

	it("rejects a cache symlink inside the checkout that points outside", async () => {
		const scratch = await makeTempDir();
		const repo = path.join(scratch, "repo");
		const outside = path.join(scratch, "outside-cache");
		const link = path.join(repo, "cache-link");
		await fs.mkdir(repo);
		await fs.mkdir(outside);
		await fs.symlink(outside, link, "dir");

		await expectUnsafeCache(link, repo);
	});

	it("rejects an external symlink that targets the checkout", async () => {
		const scratch = await makeTempDir();
		const repo = path.join(scratch, "repo");
		const outside = path.join(scratch, "outside-link");
		await fs.mkdir(repo);
		await fs.symlink(path.join(repo, ".swival"), outside, "dir");

		await expectUnsafeCache(outside, repo);
	});

	it("rejects cache symlink loops without recursing forever or creating files", async () => {
		const scratch = await makeTempDir();
		const repo = path.join(scratch, "repo");
		const loopA = path.join(scratch, "loop-a");
		const loopB = path.join(scratch, "loop-b");
		await fs.mkdir(repo);
		await fs.symlink(loopB, loopA, "dir");
		await fs.symlink(loopA, loopB, "dir");

		const outcome = await Promise.race([
			ensureCacheGuard(loopA, repo).then(() => "resolved", (error) => error),
			new Promise<Error>((resolve) => setTimeout(() => resolve(new Error("__CACHE_LOOP_TIMEOUT__")), 250)),
		]);
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).not.toBe("__CACHE_LOOP_TIMEOUT__");
		expect((outcome as Error).message).toMatch(/loop|symlink|unsafe/i);
		await expect(fs.access(path.join(repo, ".swival"))).rejects.toThrow();
	});

	it("preserves valid external cache paths", async () => {
		const scratch = await makeTempDir();
		const repo = path.join(scratch, "repo");
		const outside = path.join(scratch, "cache-root", "swival-cache");
		await fs.mkdir(repo, { recursive: true });

		await expect(ensureCacheGuard(outside, repo)).resolves.toBeUndefined();
		await expect(fs.access(outside)).rejects.toThrow();
	});
});

describe("credential preflight", () => {
	it("leaves unknown providers unvalidated and indeterminate", async () => {
		const result = await credentialPreflight({ provider: "mystery", env });
		expect(result.status).toBe("indeterminate");
		expect(result.provider).toBe("mystery");
	});
	it("checks ChatGPT device-code-only files as unauthenticated", async () => {
		const result = await credentialPreflight({ provider: "chatgpt", homeDir: "/home", fileSystem: { readFile: async () => JSON.stringify({ device_code_requested_at: 1 }) }, env, nowMs: 100 });
		expect(result.status).toBe("failure");
		expect(result.message).toMatch(/chatgpt/i);
	});
	it("reports expired ChatGPT access tokens without exposing tokens", async () => {
		const result = await credentialPreflight({ provider: "chatgpt", fileSystem: { readFile: async () => JSON.stringify({ access_token: "SECRET", refresh_token: "REFRESH", expires_at: 50 }) }, env, nowMs: 100000 });
		expect(result.status).toBe("failure");
		expect(result.message).not.toContain("SECRET");
		expect(result.message).toMatch(/expired|chatgpt/i);
	});
	it("passes valid Bedrock and reports missing Bedrock credentials", async () => {
		expect((await credentialPreflight({ provider: "bedrock", execFile: (_f, _a, _o, cb) => cb(null, "", ""), env })).status).toBe("pass");
		const failure = await credentialPreflight({ provider: "bedrock", execFile: (_f, _a, _o, cb) => cb(new Error("missing"), "", ""), env });
		expect(failure.status).toBe("failure");
		expect(failure.message).not.toContain("no adc");
	});
	it("checks ADC providers from credential artifacts, never from a printed token", async () => {
		const readable = { readFile: async () => "{}" };
		const absent = { readFile: async () => { throw new Error("missing"); } };
		expect((await credentialPreflight({ provider: "vertexai", fileSystem: readable, env: { GOOGLE_APPLICATION_CREDENTIALS: "/creds.json" } })).status).toBe("pass");
		const broken = await credentialPreflight({ provider: "vertexai", fileSystem: absent, env: { GOOGLE_APPLICATION_CREDENTIALS: "/creds.json" } });
		expect(broken.status).toBe("failure");
		expect(broken.message).toMatch(/GOOGLE_APPLICATION_CREDENTIALS/);
		expect((await credentialPreflight({ provider: "geap", homeDir: "/home", fileSystem: readable, env })).status).toBe("pass");
		// Nothing on disk stays indeterminate: a GCE host resolves ADC from the
		// metadata server, so blocking the dispatch there would be wrong.
		expect((await credentialPreflight({ provider: "geap", homeDir: "/home", fileSystem: absent, env })).status).toBe("indeterminate");
	});
	it("reports throwing checks as indeterminate", async () => {
		const result = await credentialPreflight({ provider: "generic", baseUrl: "http://local", connect: async () => { throw new Error("secret"); }, env });
		expect(result.status).toBe("indeterminate");
		expect(result.message).not.toContain("secret");
	});
	it("checks local providers through the injected TCP boundary", async () => {
		expect((await credentialPreflight({ provider: "lmstudio", baseUrl: "http://local", connect: async () => true, env })).status).toBe("pass");
		expect((await credentialPreflight({ provider: "llamacpp", baseUrl: "http://local", connect: async () => false, env })).status).toBe("failure");
	});
});

describe("profile-based credential routing", () => {
	const agent = {
		name: "swival",
		description: "test agent",
		systemPrompt: "",
		source: "bundled" as const,
		filePath: "/agents/swival.md",
	};

	it("prefers explicit provider and base URL overrides without profile lookup", async () => {
		const calls: Array<{ file: string; args: string[]; options: { timeout: number; maxBuffer: number } }> = [];
		const route = await resolveCredentialPreflightRoute({
			agent,
			overrides: { provider: "lmstudio", baseUrl: "http://127.0.0.1:1234" },
			cwd: "/repo/worktree",
			execFile: (file, args, options, callback) => {
				calls.push({ file, args, options });
				callback(null, "", "");
			},
		});
		expect(route).toEqual({
			provider: "lmstudio",
			baseUrl: "http://127.0.0.1:1234",
			routingStatus: "resolved-explicit",
		});
		expect(calls).toEqual([]);
	});

	it("resolves an explicit profile via the exact swival list-profiles command contract", async () => {
		const calls: Array<{ file: string; args: string[]; options: { timeout: number; maxBuffer: number } }> = [];
		const route = await resolveCredentialPreflightRoute({
			agent,
			overrides: { profile: "fast" },
			cwd: "/repo/worktree",
			execFile: (file, args, options, callback) => {
				calls.push({ file, args, options });
				callback(null, [
					"  default      openai      / gpt-4.1  reasoning=medium",
					"→ fast         vertexai    / gemini-2.5-pro  base=https://vertex.example.test, reasoning=high  (active from cli)",
				].join("\n"), "");
			},
		});
		expect(route).toEqual({
			provider: "vertexai",
			baseUrl: "https://vertex.example.test",
			routingStatus: "resolved-profile",
		});
		expect(calls).toEqual([
			{
				file: "swival",
				args: ["--base-dir", "/repo/worktree", "--profile", "fast", "--list-profiles"],
				options: { timeout: 1500, maxBuffer: 64 * 1024 },
			},
		]);
	});

	it("resolves the configured active profile from the effective base dir", async () => {
		const calls: Array<{ file: string; args: string[] }> = [];
		const route = await resolveCredentialPreflightRoute({
			agent: { ...agent, baseDir: "/agent/base" },
			overrides: {},
			cwd: "/ignored/cwd",
			execFile: (file, args, _options, callback) => {
				calls.push({ file, args });
				callback(null, [
					"  fallback      openai      / gpt-4.1",
					"→ active        bedrock     / claude-sonnet-4  reasoning=medium  (active from config)",
				].join("\n"), "");
			},
		});
		expect(route).toEqual({
			provider: "bedrock",
			baseUrl: undefined,
			routingStatus: "resolved-profile",
		});
		expect(calls).toEqual([
			{ file: "swival", args: ["--base-dir", "/agent/base", "--list-profiles"] },
		]);
	});

	it("returns indeterminate when no selected profile can be resolved safely", async () => {
		const route = await resolveCredentialPreflightRoute({
			agent,
			overrides: {},
			cwd: "/repo/worktree",
			execFile: (_file, _args, _options, callback) => {
				callback(null, "  default      openai      / gpt-4.1\n  heavy        anthropic   / claude", "sensitive stderr");
			},
		});
		expect(route).toMatchObject({
			provider: undefined,
			baseUrl: undefined,
			routingStatus: "indeterminate",
		});
		expect(route.message).toMatch(/indeterminate/i);
	});
});
