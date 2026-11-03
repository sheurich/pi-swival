import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import registerExtension, { registerNativeAuditTool } from "../extensions/index.js";
import { inspectNativeAudit, prepareNativeAudit, validateNativeAuditParams,
	type NativeAuditLaunch, type NativeTerminal } from "../extensions/native-audit.js";
import { nativeScratch } from "./nativeFixtures.js";

// The producer is the only mocked seam: validation, artifact minting, option
// inheritance, and the result shape run through the real shared native path.
vi.mock("../extensions/native-audit.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../extensions/native-audit.js")>(),
	prepareNativeAudit: vi.fn(), inspectNativeAudit: vi.fn(),
}));

const GENERAL_SCHEMA_KEYS = [
	"audit", "agent", "task", "tasks", "chain", "agentScope", "cwd", "modelOverride", "profileOverride",
	"providerOverride", "baseUrlOverride", "selfReviewOverride", "reviewerOverride", "reviewPromptOverride",
	"maxReviewRoundsOverride", "maxTurnsOverride", "maxOutputTokensOverride", "temperatureOverride", "topPOverride",
	"seedOverride", "reasoningEffortOverride", "instructionsFullOverride", "networkOverride", "a2aConfigOverride",
	"providerTimeoutOverride", "initialToolChoiceOverride", "nonoRollbackOverride", "nonoBlockNetOverride",
	"commandMiddlewareOverride", "maxOutputKbOverride", "maxOutputLinesOverride", "skillsDirOverride", "shareSkills",
	"subagentsOverride", "cacheOverride", "cacheDirOverride", "verifyOverride", "encryptSecretsOverride", "concurrency",
	"maxInlineBytes", "output", "outputMode", "timeoutMs", "async", "action", "id",
];
const NATIVE_SCHEMA_KEYS = [
	"audit", "modelOverride", "profileOverride", "providerOverride", "maxTurnsOverride", "maxOutputTokensOverride",
	"temperatureOverride", "topPOverride", "seedOverride", "reasoningEffortOverride", "providerTimeoutOverride",
	"maxInlineBytes", "timeoutMs", "encryptSecretsOverride",
];
const packageRoot = path.resolve(import.meta.dirname, "..");
// The selected installed Pi package, as the smoke loader and lifecycle tests use it.
const piPackage = process.env.PI_CODING_AGENT_PACKAGE
	?? fs.realpathSync(path.join(packageRoot, "tests", "node_modules", "@earendil-works", "pi-coding-agent"));

const roots: string[] = [];
afterEach(() => {
	vi.resetAllMocks();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function register(registrar: typeof registerNativeAuditTool | typeof registerExtension, options: Record<string, unknown> = {}) {
	const tools: any[] = []; const events: string[] = [];
	// Only tool registration and event subscription may be touched at registration time.
	const pi = new Proxy({}, {
		get(_target, key) {
			if (key === "registerTool") return (tool: unknown) => { tools.push(tool); };
			if (key === "on") return (event: string) => { events.push(event); };
			if (key === "events") return { emit() {} };
			throw new Error(`unexpected ExtensionAPI access: ${String(key)}`);
		},
	});
	registrar(pi as any, options as any);
	return { tools, events };
}
function toolContext(cwd: string): ExtensionToolContext {
	// Native execution needs only cwd; session, UI, or model access fails loudly.
	return new Proxy({ cwd }, {
		get(target, key) {
			if (key === "cwd") return target.cwd;
			throw new Error(`unexpected tool context access: ${String(key)}`);
		},
	}) as ExtensionToolContext;
}
function liveRun() {
	let resolve!: (terminal: NativeTerminal) => void;
	const completion = new Promise<NativeTerminal>((yes) => { resolve = yes; });
	const run = { route: { provider: "openrouter", model: "example/concrete", endpoint: null, profile: null, reasoningEffort: null },
		meta: { task: "/audit --all --workers 4 --patch-max-turns 50", startedAt: Date.now() }, proc: {},
		completion, cancel: vi.fn() } as unknown as NativeAuditLaunch;
	return { run, resolve };
}
const completed = { exitCode: 0, shutdown: "verified", boundary: "agentfs-cli", exitedAt: new Date().toISOString() } as NativeTerminal;
const entries = (root: string) => (fs.existsSync(root) ? fs.readdirSync(root) : []);

describe("default registrar is unchanged", () => {
	it("registers exactly swival-subagent with the general optional-audit schema", () => {
		const root = nativeScratch("native-only-default-"); roots.push(root);
		const { tools, events } = register(registerExtension, { artifactRoot: root });
		expect(tools.map((tool) => tool.name)).toEqual(["swival-subagent"]);
		expect(events).toEqual(["session_start", "session_shutdown"]);
		const { parameters } = tools[0];
		expect(Object.keys(parameters.properties).sort()).toEqual([...GENERAL_SCHEMA_KEYS].sort());
		expect(parameters.required).toBeUndefined();
		expect(parameters.additionalProperties).toBeUndefined();
		expect(tools[0].description).toContain("Native async is unsupported");
	});
});

describe("registerNativeAuditTool", () => {
	it("registers exactly one native tool with a strict, bounded schema and only a shutdown hook", () => {
		const root = nativeScratch("native-only-register-"); roots.push(root);
		const { tools, events } = register(registerNativeAuditTool, { artifactRoot: root });
		expect(tools.map((tool) => tool.name)).toEqual(["swival-native-audit"]);
		expect(events).toEqual(["session_shutdown"]);
		const tool = tools[0];
		expect(tool.parameters.required).toEqual(["audit"]);
		expect(tool.parameters.additionalProperties).toBe(false);
		expect(Object.keys(tool.parameters.properties).sort()).toEqual([...NATIVE_SCHEMA_KEYS].sort());
		expect(tool.parameters.properties.encryptSecretsOverride).toMatchObject({ type: "boolean", const: false });
		expect(tool.description.length).toBeLessThan(512);
		expect(tool.description).toMatch(/synchronous/i); expect(tool.description).toMatch(/source-only/);
		expect(tool.description).toContain("encryptSecretsOverride accepts only false.");
		expect(tool.promptGuidelines.join(" ")).toContain("swival-native-audit");
		expect(tool.renderCall).toBeUndefined(); expect(tool.renderResult).toBeUndefined();
	});

	it("declares the general tool's audit and native field types and bounds, narrowing only encryption", () => {
		const root = nativeScratch("native-only-parity-"); roots.push(root);
		const general = register(registerExtension, { artifactRoot: root }).tools[0].parameters.properties;
		const native = register(registerNativeAuditTool, { artifactRoot: root }).tools[0].parameters.properties;
		const json = (value: unknown) => JSON.parse(JSON.stringify(value));
		for (const key of NATIVE_SCHEMA_KEYS) {
			if (key === "encryptSecretsOverride") {
				expect(json(general[key])).toMatchObject({ type: "boolean" });
				expect(json(general[key])).not.toHaveProperty("const");
				expect(json(native[key])).toMatchObject({ type: "boolean", const: false });
			} else {
				// Descriptions and property ordering are presentation, not permission or bounding constraints.
				const { description: _generalText, ...generalConstraints } = json(general[key]);
				const { description: _nativeText, ...nativeConstraints } = json(native[key]);
				expect(nativeConstraints, key).toEqual(generalConstraints);
			}
		}
	});

	it("runs a valid native call through the shared path with ctx.cwd and inherited options", async () => {
		const root = nativeScratch("native-only-run-"); roots.push(root);
		const source = path.join(root, "source"); fs.mkdirSync(source);
		const artifactRoot = path.join(root, "artifacts");
		const live = liveRun();
		vi.mocked(prepareNativeAudit).mockImplementation(async (...args) => {
			expect(args[7]?.aborted).toBe(false);
			return live.run;
		});
		vi.mocked(inspectNativeAudit).mockResolvedValue({ status: "completed", answer: "synthetic native answer" });
		const { tools } = register(registerNativeAuditTool,
			{ artifactRoot, nativePython: "/synthetic/runtime/bin/python3.13", nativeMaxTimeoutMs: 12_345 });
		const input = { audit: { paths: ["src/**"], workers: 2 }, profileOverride: "operator-profile", timeoutMs: 5_000, maxInlineBytes: 8,
			encryptSecretsOverride: false };
		const execution = tools[0].execute("native-only", input, undefined, undefined, toolContext(source));
		await new Promise<void>((resolve) => setImmediate(resolve));
		live.resolve(completed);
		const result = await execution;
		expect(prepareNativeAudit).toHaveBeenCalledTimes(1);
		const [cwd, params, audit, runtime, artifactDir, runId, maxTimeoutMs] = vi.mocked(prepareNativeAudit).mock.calls[0];
		expect(cwd).toBe(source);
		expect(params).toEqual(input);
		expect(params.encryptSecretsOverride).toBe(false);
		expect(audit).toEqual(validateNativeAuditParams(input));
		expect(runtime.python).toBe("/synthetic/runtime/bin/python3.13");
		expect(path.dirname(artifactDir)).toBe(artifactRoot);
		expect(path.basename(artifactDir)).toMatch(/^native-audit-\d+-[0-9a-f]{8}$/);
		expect(runId).toMatch(/^swival-run-\d+-[0-9a-f]{8}$/);
		expect(maxTimeoutMs).toBe(12_345);
		expect(inspectNativeAudit).toHaveBeenCalledWith(artifactDir, 0);
		expect(result.isError).toBe(false);
		expect(result.content[0].text).toContain("Native audit status: completed");
		expect(result.content[0].text).toContain("Resolved native route: openrouter/example/concrete");
		expect(result.content[0].text).toContain("[truncated");
		expect(result.content[0].text).toContain(`Artifact dir: ${artifactDir}`);
		expect(result.details).toMatchObject({ mode: "single", agentScope: "user", projectAgentsDir: null,
			results: [{ agent: "native-audit", exitCode: 0, artifactDir, nativeAudit: { status: "completed" } }] });
		expect(live.run.cancel).not.toHaveBeenCalled();
	});

	it.each([
		{}, { audit: null }, { audit: "all" }, { audit: [] },
		{ agent: "swival", task: "do work" }, { task: "/audit src" }, { tasks: [] }, { chain: [] },
		{ action: "list" }, { action: "status", id: "swival-run-1" }, { action: "interrupt", id: "swival-run-1" },
		{ audit: {}, agent: "swival" }, { audit: {}, task: "/audit" }, { audit: {}, cwd: "/tmp" },
		{ audit: {}, agentScope: "both" }, { audit: {}, async: true }, { audit: {}, async: false },
		{ audit: {}, encryptSecretsOverride: true }, { audit: {}, encryptSecretsOverride: "false" },
		{ audit: {}, encryptSecretsOverride: 0 }, { audit: {}, encryptSecretsOverride: null }, { audit: {}, encryptSecretsOverride: {} },
		{ audit: {}, networkOverride: "full" }, { audit: {}, baseUrlOverride: "http://127.0.0.1:1/v1" },
		{ audit: {}, subagentsOverride: true }, { audit: {}, reviewerOverride: "/bin/true" },
		{ audit: {}, selfReviewOverride: false }, { audit: {}, a2aConfigOverride: "a2a.toml" },
		{ audit: {}, commandMiddlewareOverride: "/bin/sh" }, { audit: {}, instructionsFullOverride: true },
		{ audit: {}, output: "/tmp/out.md" }, { audit: {}, extraArgs: ["--yolo"] }, { audit: {}, id: "swival-run-1" },
		{ audit: { paths: ["../escape"] } }, { audit: { paths: ["/etc"] } }, { audit: { paths: ["src;id"] } },
		{ audit: { workers: 9 } }, { audit: { patchMaxTurns: 0 } }, { audit: { command: "/!id" } },
	])("fails closed before preparation for %j even when the schema is bypassed", async (input) => {
		const root = nativeScratch("native-only-reject-"); roots.push(root);
		const artifactRoot = path.join(root, "artifacts");
		const { tools } = register(registerNativeAuditTool, { artifactRoot });
		const result = await tools[0].execute("native-only", input, undefined, undefined, toolContext(root));
		expect(result.isError).toBe(true);
		expect(result.details).toBeUndefined();
		expect(result.content[0].text).toMatch(/native audit|audit\./i);
		expect(prepareNativeAudit).not.toHaveBeenCalled();
		expect(inspectNativeAudit).not.toHaveBeenCalled();
		expect(entries(artifactRoot)).toEqual([]);
	});

	it("rejects a JSON own __proto__ key before preparation without touching artifacts", async () => {
		const root = nativeScratch("native-only-proto-"); roots.push(root);
		const artifactRoot = path.join(root, "artifacts");
		const { tools } = register(registerNativeAuditTool, { artifactRoot });
		const input = JSON.parse('{"audit":{"all":true},"__proto__":{"async":true,"cwd":"/tmp"}}');
		expect(Object.hasOwn(input, "__proto__")).toBe(true);
		const result = await tools[0].execute("native-only", input, undefined, undefined, toolContext(root));
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("remove __proto__");
		expect(prepareNativeAudit).not.toHaveBeenCalled();
		expect(entries(artifactRoot)).toEqual([]);
	});

	it("passes an already-cancelled signal to preparation and reports its refusal without a run", async () => {
		const root = nativeScratch("native-only-cancel-"); roots.push(root);
		const artifactRoot = path.join(root, "artifacts");
		vi.mocked(prepareNativeAudit).mockImplementation(async (...args) => {
			if (args[7]?.aborted) throw new Error("Native audit was cancelled before launch.");
			throw new Error("preparation must observe the cancelled signal");
		});
		const { tools } = register(registerNativeAuditTool, { artifactRoot });
		const controller = new AbortController(); controller.abort();
		const result = await tools[0].execute("native-only", { audit: { all: true } }, controller.signal, undefined, toolContext(root));
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("cancelled before launch");
		expect(inspectNativeAudit).not.toHaveBeenCalled();
		expect(entries(artifactRoot)).toEqual([]);
	});
});

describe("registerNativeAuditTool through the installed Pi extension loader", () => {
	it("loads the README wrapper offline, registers only swival-native-audit, and enforces the schema", async () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swival-native-only-load-")));
		const cwd = path.join(root, "project");
		const home = path.join(root, "home");
		const agentDir = path.join(home, ".pi", "agent");
		const wrapperDir = path.join(agentDir, "swival-native-audit");
		for (const dir of [cwd, path.join(wrapperDir, "node_modules")]) fs.mkdirSync(dir, { recursive: true });
		const section = fs.readFileSync(path.join(packageRoot, "README.md"), "utf8")
			.split("#### Native-only tool: `swival-native-audit`\n")[1]!.split("\n## Layout")[0]!;
		const wrapper = section.match(/```typescript\n([\s\S]*?)\n```/)![1]!;
		expect(wrapper).toContain("registerNativeAuditTool(pi, {})");
		// The wrapper imports only the named registrar, never the package default export.
		expect(wrapper.split("\n").filter((line) => line.includes("pi-swival")))
			.toEqual(['import { registerNativeAuditTool } from "pi-swival/extensions/index.ts";']);
		const wrapperPath = path.join(wrapperDir, "index.ts");
		fs.symlinkSync(packageRoot, path.join(wrapperDir, "node_modules", "pi-swival"));
		fs.writeFileSync(wrapperPath, wrapper);
		// Block the real child-process boundary before any import, as catalogueLoad does.
		const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
		const launches: string[] = [];
		const restore: Array<() => void> = [];
		const block = (method: string) => () => { launches.push(method); throw new Error(`nativeAuditOnly blocked ${method}`); };
		try {
			for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) {
				const spy = vi.spyOn(childProcess, method).mockImplementation(block(method));
				restore.push(() => spy.mockRestore());
			}
			const spawn = vi.spyOn(childProcess.ChildProcess.prototype, "spawn").mockImplementation(block("ChildProcess.spawn"));
			restore.push(() => spawn.mockRestore());
			const nativeOs = createRequire(import.meta.url)("node:os") as typeof import("node:os");
			const homedir = vi.spyOn(nativeOs, "homedir").mockReturnValue(home);
			restore.push(() => homedir.mockRestore());
			syncBuiltinESMExports();
			vi.stubEnv("HOME", home);
			vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
			vi.stubEnv("PI_PACKAGE_DIR", undefined);
			vi.stubEnv("JITI_FS_CACHE", path.join(root, "jiti-cache"));
			vi.stubEnv("PI_OFFLINE", "1");
			const pi = await import(pathToFileURL(path.join(piPackage, "dist", "index.js")).href) as
				typeof import("@earendil-works/pi-coding-agent");
			expect(pi.getAgentDir()).toBe(agentDir);
			const loaded = await pi.discoverAndLoadExtensions([wrapperPath], cwd, agentDir);
			expect(loaded.errors).toEqual([]);
			if ("warnings" in loaded) expect(loaded.warnings).toEqual([]);
			expect(loaded.extensions.map((extension) => extension.resolvedPath)).toEqual([wrapperPath]);
			const extension = loaded.extensions[0]!;
			expect([...extension.tools.keys()]).toEqual(["swival-native-audit"]);
			expect([...extension.handlers.keys()]).toEqual(["session_shutdown"]);
			expect(extension.commands.size).toBe(0); expect(extension.flags.size).toBe(0);
			expect(extension.shortcuts.size).toBe(0); expect(extension.messageRenderers.size).toBe(0);
			const definition = extension.tools.get("swival-native-audit")!.definition;
			expect(definition.parameters).toMatchObject({ type: "object", required: ["audit"], additionalProperties: false,
				properties: { encryptSecretsOverride: { type: "boolean", const: false } } });
			expect(Object.keys(definition.parameters.properties).sort()).toEqual([...NATIVE_SCHEMA_KEYS].sort());

			// The host validator from the same installation: what a model call passes through before execute.
			const ai = await import(pathToFileURL(path.join(piPackage, "..", "pi-ai", "dist", "index.js")).href) as
				typeof import("@earendil-works/pi-ai");
			const tool = { name: definition.name, description: definition.description, parameters: definition.parameters };
			const validate = (args: Record<string, unknown>) => {
				try { return { ok: true as const, value: ai.validateToolArguments(tool, { type: "toolCall", id: "call", name: tool.name, arguments: args }) }; }
				catch (error) { return { ok: false as const, message: (error as Error).message }; }
			};
			expect(validate({ audit: { all: true }, profileOverride: "operator-profile", encryptSecretsOverride: false }))
				.toEqual({ ok: true, value: { audit: { all: true }, profileOverride: "operator-profile", encryptSecretsOverride: false } });
			// Message wording differs across installed Pi validators; the rejection and its field do not.
			for (const [args, field] of [
				[{ audit: {}, encryptSecretsOverride: true }, "encryptSecretsOverride"],
				[{ audit: {}, encryptSecretsOverride: {} }, "encryptSecretsOverride"],
				[{ audit: {}, agent: "swival", task: "x" }, "agent"],
				[{ audit: {}, async: true }, "async"],
				[{ audit: {}, cwd: "/tmp" }, "cwd"],
				[{ audit: {}, action: "list" }, "action"],
				[{ audit: { command: "/!id" } }, "command"],
				[{}, "audit"],
				[JSON.parse('{"audit":{},"__proto__":{"async":true}}'), "__proto__"],
			] as const) {
				const outcome = validate(args as Record<string, unknown>);
				expect(outcome.ok, JSON.stringify(args)).toBe(false);
				if (!outcome.ok) expect(outcome.message, JSON.stringify(args)).toContain(field);
			}
			// Documented host coercion may turn loosely typed values into exact false or drop a null;
			// whatever the installed validator does, nothing other than exact false can reach execute.
			for (const loose of ["false", 0, null]) {
				const outcome = validate({ audit: {}, encryptSecretsOverride: loose });
				if (outcome.ok) expect([false, undefined], JSON.stringify(loose)).toContain(outcome.value.encryptSecretsOverride);
			}

			// Direct execute on the loaded tool still fails closed without the host validator.
			const ctx = new Proxy({ cwd }, {
				get(target, key) {
					if (key === "cwd") return target.cwd;
					throw new Error(`nativeAuditOnly unexpected context access: ${String(key)}`);
				},
			}) as ExtensionToolContext;
			for (const input of [{ audit: {}, agent: "swival" }, { audit: {}, async: false }, { audit: {}, encryptSecretsOverride: "false" }, {}]) {
				const result = await definition.execute("native-only-load", input as never, undefined, undefined, ctx);
				expect(result.isError, JSON.stringify(input)).toBe(true);
				expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(/native audit/i) }]);
			}
			for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" } as never, ctx as never);
			expect(launches).toEqual([]);
			expect(fs.existsSync(path.join(agentDir, "swival-artifacts"))).toBe(false);
			expect(fs.readdirSync(agentDir)).toEqual(["swival-native-audit"]);
			expect(fs.readdirSync(home)).toEqual([".pi"]);
			expect(fs.existsSync(path.join(cwd, ".pi"))).toBe(false);
		} finally {
			for (const undo of restore.reverse()) undo();
			syncBuiltinESMExports();
			vi.unstubAllEnvs();
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 20000);
});
