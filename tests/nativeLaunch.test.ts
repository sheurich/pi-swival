import { describe, expect, it } from "vitest";
import { validateNativeAuditParams } from "../extensions/native-audit.js";
import * as native from "../extensions/native-audit.js";

describe("native CLI launch contract", () => {
	it("refuses native async before preparation", () => {
		expect(() => validateNativeAuditParams({ audit: {}, async: true })).toThrow(/synchronous|async.*unsupported/i);
	});
	it("builds a single source-only /audit argv item after --", () => {
		const build = (native as any).buildNativeAuditArgs;
		expect(build, "The native adapter must invoke the public CLI").toBeTypeOf("function");
		const args = build("/owned/snapshot", { provider: "chatgpt", model: "gpt-offline", options: {} },
			{ paths: ["src/*"], all: true, workers: 2, patchMaxTurns: 5 });
		expect(args.slice(-2)).toEqual(["--", "/audit src/* --all --workers 2 --patch-max-turns 5"]);
		for (const flag of ["--no-instructions", "--no-skills", "--no-metaskills", "--no-mcp", "--no-a2a",
			"--no-subagents", "--no-lifecycle", "--no-history", "--no-continue", "--no-memory", "--oneshot-commands"]) {
			expect(args).toContain(flag);
		}
		expect(args).toEqual(expect.arrayContaining(["--sandbox", "builtin", "--network", "provider-only", "--commands", "none", "--files", "some"]));
		expect(args).not.toContain("--add-dir"); expect(args).not.toContain("--sandbox-session");
		const outer = (native as any).buildNativeAgentfsArgs;
		expect(outer).toBeTypeOf("function");
		expect(outer("/trusted/swival", "/owned/snapshot", "/owned/home/auth", "native-123", args)).toEqual([
			"run", "--no-default-allows", "--allow", "/owned/snapshot", "--allow", "/owned/home/auth",
			"--session", "native-123", "--", "/trusted/swival", ...args,
		]);
	});
	it.each([null, "https://openrouter.ai/api/v1", "http://127.0.0.1:8444/v1"])(
		"keeps API route endpoint %s and grants no auth directory", (endpoint) => {
			const args = native.buildNativeAuditArgs("/owned/snapshot", { provider: "openrouter", model: "example/concrete", endpoint, options: {} },
				{ paths: [], all: true, workers: 1, patchMaxTurns: 5 });
			expect(args.includes("--base-url")).toBe(endpoint !== null);
			if (endpoint) expect(args[args.indexOf("--base-url") + 1]).toBe(endpoint);
			expect(native.buildNativeAgentfsArgs("/trusted/swival", "/owned/snapshot", undefined as any, "native-123", args))
				.toEqual(["run", "--no-default-allows", "--allow", "/owned/snapshot", "--session", "native-123", "--", "/trusted/swival", ...args]);
		});
	it("forwards only selected credentials and gives preflight presence markers", () => {
		const input = { HOME: "/synthetic/home", CHATGPT_TOKEN_DIR: "/synthetic/auth", CHATGPT_API_KEY: "synthetic-chatgpt",
			OPENROUTER_API_KEY: "synthetic-api", UNRELATED_TOKEN: "synthetic-other" };
		const environment = native.nativeEnvironment as any;
		const api = environment(input, "/trusted/bin", "openrouter");
		expect(api.OPENROUTER_API_KEY).toBe("synthetic-api");
		for (const name of ["CHATGPT_TOKEN_DIR", "CHATGPT_AUTH_FILE", "CHATGPT_API_KEY", "UNRELATED_TOKEN"]) expect(api[name]).toBeUndefined();
		const chatgpt = environment(input, "/trusted/bin", "chatgpt");
		expect(chatgpt.OPENROUTER_API_KEY).toBeUndefined();
		expect(chatgpt.CHATGPT_API_KEY).toBe("synthetic-chatgpt");
		const preflight = (native as any).nativePreflightEnvironment;
		expect(preflight).toBeTypeOf("function");
		const env = preflight(input, "/trusted/bin");
		expect(env.OPENROUTER_API_KEY).toBe("present"); expect(env.CHATGPT_API_KEY).toBe("present");
		expect(JSON.stringify(env)).not.toContain("synthetic-api"); expect(JSON.stringify(env)).not.toContain("synthetic-chatgpt");
		expect(env.LITELLM_MODE).toBe("PRODUCTION");
	});
	it("rejects malformed route metadata and unknown failure codes without echoing values", () => {
		const parse = (native as any).parseNativePreflight;
		expect(parse).toBeTypeOf("function");
		for (const output of ['{}', '{"version":1}', '{"ok":false,"reason":"synthetic-secret"}',
			'{"ok":false,"reason":"POLICY_NOT_PROPAGATED","field":"synthetic-secret"}']) {
			expect(() => parse(output, false)).toThrow(/preflight|configuration/i);
			try { parse(output, false); } catch (error) { expect(String(error)).not.toContain("synthetic-secret"); }
		}
		const route = { version: 2, runtime: { swival: "1.0.46", litellm: "1.103.4" }, provider: "openrouter", model: "example/concrete",
			endpoint: null, profile: null, reasoningEffort: null, options: {}, selection: { profileSource: null, explicitFields: [] },
			reportIdentity: { provider: "openrouter", model: "example/concrete" } };
		expect(parse(JSON.stringify(route), true).route).toEqual(route);
		for (const mutation of [{ version: 1 }, { endpoint: "http://user:synthetic-secret@offline.invalid" },
			{ provider: "synthetic\nsecret" }, { options: { api_key: "synthetic-secret" } },
			{ runtime: { swival: "unproved", litellm: "1.103.4" } }, { selection: { profileSource: "explicit", explicitFields: [] } },
			{ reportIdentity: { provider: "openrouter", model: "replacement" } },
			{ selection: { profileSource: null, explicitFields: ["baseUrl"] } }]) {
			expect(() => parse(JSON.stringify({ ...route, ...mutation }), true)).toThrow(/preflight/i);
		}
		expect(() => parse('{"ok":false,"reason":"PROFILE_UNAVAILABLE"}', false)).toThrow(/profile.*unavailable.*no fallback/i);
		expect(() => parse('{"ok":false,"reason":"POLICY_NOT_PROPAGATED","field":"extra_body"}', false)).toThrow(/extra_body.*not propagated/i);
	});
	it("strips inherited execution and sandbox markers without changing standard auth", () => {
		const environment = (native as any).nativeEnvironment;
		expect(environment).toBeTypeOf("function");
		const env = environment({ HOME: "/synthetic/home", PATH: "/trusted/bin", CHATGPT_TOKEN_DIR: "/synthetic/auth",
			NODE_OPTIONS: "hostile", PYTHONPATH: "/hostile", AGENTFS: "1", NONO_ACTIVE: "1", SWIVAL_AGENTFS_ACTIVE: "1",
			LITELLM_LOCAL_MODEL_COST_MAP: "False", UNRELATED_TOKEN: "synthetic" }, "/trusted/bin", "chatgpt");
		expect(env).toMatchObject({ HOME: "/synthetic/home", PATH: "/trusted/bin", CHATGPT_TOKEN_DIR: "/synthetic/auth",
			LITELLM_LOCAL_MODEL_COST_MAP: "True", NONO_NO_UPDATE_CHECK: "1" });
		for (const name of ["NODE_OPTIONS", "PYTHONPATH", "AGENTFS", "NONO_ACTIVE", "SWIVAL_AGENTFS_ACTIVE", "UNRELATED_TOKEN"]) expect(env[name]).toBeUndefined();
	});
});
