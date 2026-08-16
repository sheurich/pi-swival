import { describe, expect, it } from "vitest";
import { ensureCacheGuard, resolveCacheDir } from "../extensions/cache.js";
import { credentialPreflight } from "../extensions/preflight.js";

const env = {};

describe("cache resolution", () => {
	it("uses a stable extension-owned path outside the repository", () => {
		const a = resolveCacheDir({ baseDir: "/work/repo", stateRoot: "/state", env });
		const b = resolveCacheDir({ baseDir: "/work/repo", stateRoot: "/state", env });
		expect(a.dir).toBe(b.dir);
		expect(a.dir.startsWith("/work/repo/")).toBe(false);
		expect(a.dir).toContain("repo-");
	});
	it("applies override, frontmatter, environment precedence", () => {
		expect(resolveCacheDir({ baseDir: "/repo", cacheDirOverride: "/call", agentCacheDir: "/agent", env: { PI_SWIVAL_CACHE_DIR: "/env" } }).dir).toBe("/call");
		expect(resolveCacheDir({ baseDir: "/repo", agentCacheDir: "/agent", env: { PI_SWIVAL_CACHE_DIR: "/env" } }).dir).toBe("/agent");
		expect(resolveCacheDir({ baseDir: "/repo", env: { PI_SWIVAL_CACHE_DIR: "/env" } }).dir).toBe("/env");
	});
	it("guards an in-repository cache with a single-star gitignore", async () => {
		const files = new Map<string, string>();
		const fake = { mkdir: async () => {}, readFile: async (f: string) => { const v = files.get(f); if (v === undefined) throw new Error("missing"); return v; }, writeFile: async (f: string, v: string) => { files.set(f, v); } };
		await ensureCacheGuard("/repo/.swival", "/repo", fake);
		expect(files.get("/repo/.swival/.gitignore")).toBe("*\n");
		await ensureCacheGuard("/repo/.swival", "/repo", fake);
		expect(files.get("/repo/.swival/.gitignore")).toBe("*\n");
	});
});

describe("credential preflight", () => {
	it("passes unknown providers", async () => {
		expect((await credentialPreflight({ provider: "mystery", env })).status).toBe("pass");
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
