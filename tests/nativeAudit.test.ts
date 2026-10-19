import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { nativeScratch, completeNativeFixture } from "./nativeFixtures.js";
import * as path from "node:path";
import registerExtension from "../extensions/index.js";
import { nativeTestPython as python } from "./nativePython.js";

const ROOT = path.resolve(import.meta.dirname, "..");
// Cold pinned-upstream imports need a subprocess budget below the test deadline.
const PREFLIGHT_PROCESS_TIMEOUT_MS = 15_000;
const startupPath = process.env.PATH;
beforeEach(() => {
	process.env.PATH = (startupPath ?? "").split(path.delimiter).filter(path.isAbsolute).join(path.delimiter);
});
afterEach(() => { process.env.PATH = startupPath; });
const scratchDirs: string[] = [];
const scratch = () => {
	const dir = nativeScratch("native-audit-test-");
	scratchDirs.push(dir);
	return dir;
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", [
	"-c", "core.hooksPath=/dev/null", "-c", "core.excludesFile=/dev/null", "-c", "commit.gpgsign=false", ...args,
], { cwd, timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).toString();
const repository = () => {
	const dir = scratch();
	git(dir, "init", "--template=");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "user.email", "test@example.invalid");
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "src", "code.py"), "def answer(): return 42\n");
	git(dir, "add", ".");
	git(dir, "commit", "-m", "fixture");
	return dir;
};

afterEach(() => { for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("native audit dispatch boundary", () => {
	let tool: any;
	let root: string;
	const originalPath = process.env.PATH;
	afterEach(() => { process.env.PATH = originalPath; });
	beforeEach(() => {
		root = scratch();
		const bin = scratch();
		fs.writeFileSync(path.join(bin, "swival"), `#!${python}\nfrom pathlib import Path\nPath(${JSON.stringify(path.join(root, "generic-dispatch"))}).write_text("forbidden")\n`, { mode: 0o755 });
		process.env.PATH = `${bin}:${(originalPath ?? "").split(path.delimiter).filter(path.isAbsolute).join(path.delimiter)}`;
		registerExtension({ registerTool: (registered: any) => { tool = registered; } } as any,
			{ artifactRoot: root, nativePython: python } as any);
	});
	it("describes native and ordinary isolation without conflating them", () => {
		expect(tool.description).toContain("Native mode uses synchronous upstream AgentFS CLI");
		expect(tool.description).toContain("Native async is unsupported");
	});

	it.each([
		[{}, "configured defaults"], [{ profileOverride: "synthetic-unvalidated-secret" }, "explicit profile"],
		[{ modelOverride: "synthetic-unvalidated-secret" }, "explicit overrides"],
	])("renders the native selection kind without unvalidated override values", (selection, label) => {
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const text = tool.renderCall({ audit: { all: true }, ...selection }, theme, {}).render(200).join("\n");
		expect(text).toContain(label); expect(text).not.toContain("synthetic-unvalidated-secret");
	});
	it("renders validated endpoint and partial status without trusting malformed route details", () => {
		const { route } = completeNativeFixture(scratch());
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const selected = { ...route, provider: "openrouter", model: "example/concrete", endpoint: "http://127.0.0.1:8444/v1",
			reportIdentity: { provider: "openrouter", model: "example/concrete" } };
		const render = (value: unknown) => tool.renderResult({ content: [], details: { mode: "single", results: [{
			agent: "native-audit", task: "/audit", exitCode: 0, durationMs: 1, stderrTail: [], finalOutput: "",
			nativeAudit: { status: "partial", route: value },
		}] } }, { expanded: false }, theme, {}).render(200).join("\n");
		expect(render(selected)).toContain("partial"); expect(render(selected)).toContain(selected.endpoint);
		expect(render({ ...selected, model: "synthetic-unvalidated\nsecret" })).not.toContain("synthetic-unvalidated");
	});
	it.each([
		{ paths: ["src\n/!rm"] }, { paths: ["../escape"] }, { paths: ["/etc"] },
		{ paths: ["--debug"] }, { paths: ["src with space"] }, { paths: ["src\\..\\out"] },
		{ paths: ["src;id"] }, { paths: ["src\u0000"] }, { workers: 9 }, { workers: 1.5 },
		{ patchMaxTurns: 101 }, { command: "/!id" },
	])("rejects malformed structured audit input without artifacts: %j", async (audit) => {
		const result = await tool.execute("audit", { audit }, undefined, undefined, { cwd: ROOT, hasUI: false });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/native audit|audit\./i);
		expect(fs.readdirSync(root)).toEqual([]);
	});
	it.each([
		{ agent: "swival" }, { task: "/audit src" }, { tasks: [] }, { chain: [] }, { cwd: "/tmp" },
		{ selfReviewOverride: false }, { reviewerOverride: "/bin/true" }, { encryptSecretsOverride: false },
		{ networkOverride: "full" }, { extraArgs: ["--yolo"] }, { subagentsOverride: true },
		{ instructionsFullOverride: true }, { output: "/tmp/out" },
		{ baseUrlOverride: "https://caller.invalid/v1" }, { baseUrlOverride: "http://127.0.0.1:8444/v1" },
		{ baseUrlOverride: null },
	])("rejects incompatible or bypass fields without native launch: %j", async (other) => {
		const result = await tool.execute("audit", { audit: {}, ...other }, undefined, undefined, { cwd: ROOT, hasUI: false });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/native audit|cannot be combined/i);
		expect(fs.existsSync(path.join(root, "generic-dispatch"))).toBe(false);
		expect(fs.readdirSync(root)).toEqual([]);
	});
	it("registered native tool rejects an ambient proxy before artifacts, workers, or providers", async () => {
		const source = repository(); const home = scratch(); const bin = scratch();
		// Satisfy executable discovery without an installed sandbox or any launch.
		for (const name of ["agentfs", "nono"]) {
			fs.writeFileSync(path.join(bin, name), [
				`#!${python}`, "from pathlib import Path",
				`Path(${JSON.stringify(path.join(root, `${name}-dispatch`))}).write_text("forbidden")`,
				"raise SystemExit(1)", "",
			].join("\n"), { mode: 0o755 });
		}
		process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
		fs.mkdirSync(path.join(home, ".config"), { recursive: true });
		const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
			hTtP_pRoXy: process.env.hTtP_pRoXy };
		process.env.HOME = home; process.env.XDG_CONFIG_HOME = path.join(home, ".config");
		process.env.hTtP_pRoXy = "";
		registerExtension({ registerTool: (registered: any) => { tool = registered; } } as any,
			{ artifactRoot: root, nativePython: python });
		try {
			const result = await tool.execute("audit", { audit: { all: true }, modelOverride: "gpt-offline", providerOverride: "chatgpt" },
				undefined, undefined, { cwd: source, hasUI: false });
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/preflight failed.*No native worker\/provider was started/i);
			expect(result.content[0].text).toContain("Unsupported native transport proxy requirements.");
			expect(fs.readdirSync(root)).toEqual([]);
			expect(fs.existsSync(path.join(root, "generic-dispatch"))).toBe(false);
		} finally {
			for (const [name, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[name]; else process.env[name] = value;
			}
		}
	});
});

describe("native preflight protection requirements (no worker, no provider)", {
	timeout: PREFLIGHT_PROCESS_TIMEOUT_MS + 5000,
}, () => {
	it.each([
		["global", 'encrypt_secrets = true'], ["project", 'llm_filter = "required-filter"'],
		["global", 'encrypt_secrets_key = "synthetic-never-log-this"'],
		["project", 'unrecognized_shield = true'], ["global", 'nono_audit_integrity = true'],
		["global", 'nono_rollback = true'], ["project", 'lifecycle_fail_closed = true'], ["global", '[profiles.protected]\nprovider="chatgpt"\nllm_filter="required"'],
		...["global", "project"].map((where) => [where, 'sandbox_session="required"']),
	])("rejects protected or unknown %s configuration before native launch", async (where, config) => {
		const dir = repository();
		const home = scratch();
		fs.mkdirSync(path.join(home, ".config", "swival"), { recursive: true });
		fs.writeFileSync(where === "global" ? path.join(home, ".config", "swival", "config.toml") : path.join(dir, "swival.toml"), config);
		const result = await runPreflight(dir, home, {}, { model: "gpt-offline", provider: "chatgpt" });
		expect(result.code).toBe(1);
		expect(JSON.parse(result.output).reason).toMatch(/^(POLICY_NOT_PROPAGATED|CONFIG_INVALID)$/);
		expect(result.output).not.toContain("synthetic-never-log-this");
	});
	it.each(Object.entries({
		network: '"none"', files: '"none"', sandbox: '"nono"', sandbox_strict_read: "true",
		sandbox_session: '"required"',
		lifecycle_fail_closed: "true", nono_profile: '"required-profile"', nono_rollback: "true",
		nono_block_net: "true", nono_allow_domain: '["offline.invalid"]',
		nono_network_profile: '"required-profile"', nono_credential: '["required-reference"]',
		nono_audit_integrity: "true",
	}).flatMap(([key, value]) => ["explicit", "active"].map((selection) => [key, selection, value])))
		("keeps released restrictive-profile rejection for %s under %s selection", async (key, selection, value) => {
			const home = scratch(); fs.mkdirSync(path.join(home, ".config", "swival"), { recursive: true });
			fs.writeFileSync(path.join(home, ".config", "swival", "config.toml"),
				`${selection === "active" ? 'active_profile="test"\n' : ''}[profiles.test]\n` +
				`provider="chatgpt"\nmodel="gpt-offline"\ndescription="synthetic-never-log-this"\n${key}=${value}\n`);
			const result = await runPreflight(repository(), home, {}, selection === "explicit" ? { profile: "test" } : {});
			expect(result.code).toBe(1); expect(JSON.parse(result.output).reason).toMatch(/^(POLICY_NOT_PROPAGATED|CONFIG_INVALID)$/);
			expect(result.output).not.toContain("synthetic-never-log-this");
		});
	it("rejects SWIVAL_ENCRYPT_KEY presence without inspecting or logging its value", async () => {
		const result = await runPreflight(repository(), scratch(), { SWIVAL_ENCRYPT_KEY: "synthetic-never-log-this" });
		expect(result.code).toBe(1);
		expect(JSON.parse(result.output)).toMatchObject({ ok: false, reason: "POLICY_NOT_PROPAGATED", field: "encrypt_secrets" });
		expect(result.output).not.toContain("synthetic-never-log-this");
	});
	it.each([
		"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
		"hTtP_pRoXy", "hTtPs_PrOxY", "aLl_PrOxY",
	].flatMap((name) => [[name, ""], [name, "http://synthetic-proxy.invalid"]]))
		("rejects %s by presence for %s without a provider", async (name, value) => {
			const result = await runPreflight(repository(), scratch(), { [name]: value }, { model: "gpt-offline", provider: "chatgpt" });
			expect(result.code).toBe(1);
			expect(JSON.parse(result.output)).toEqual({ ok: false, reason: "TRANSPORT_REQUIREMENT_UNSUPPORTED" });
			expect(result.output).not.toContain("synthetic-proxy.invalid");
		});
	it("resolves global profile and explicit model/provider/effort without initializing a provider", async () => {
		const home = scratch();
		fs.mkdirSync(path.join(home, ".config", "swival"), { recursive: true });
		fs.writeFileSync(path.join(home, ".config", "swival", "config.toml"), '[profiles.test]\nprovider="chatgpt"\nmodel="gpt-profile"\nreasoning_effort="high"\n');
		const result = await runPreflight(repository(), home, {}, { profile: "test", model: "gpt-override", reasoningEffort: "xhigh" });
		expect(result.code, result.output).toBe(0);
		expect(JSON.parse(result.output)).toMatchObject({ provider: "chatgpt", model: "gpt-override", reasoningEffort: "xhigh", profile: "test" });
	});
	it("preserves released ChatGPT profile routing without opening OAuth credentials", async () => {
		const home = scratch(); fs.mkdirSync(path.join(home, ".config", "swival"), { recursive: true });
		fs.writeFileSync(path.join(home, ".config", "swival", "config.toml"),
			'active_profile="test"\n[profiles.test]\nprovider="chatgpt"\nmodel="chatgpt/gpt-offline"\n');
		const result = await runPreflight(repository(), home);
		expect(result.code, result.output).toBe(0);
		expect(JSON.parse(result.output)).toMatchObject({ provider: "chatgpt", profile: "test",
			model: "chatgpt/gpt-offline", endpoint: null });
		expect(fs.existsSync(path.join(home, ".config", "litellm"))).toBe(false);
	});
	it.each(["missing", "", false])("rejects missing or invalid profiles without fallback: %s", async (profile) => {
		const result = await runPreflight(repository(), scratch(), {}, { profile, model: "gpt-offline", provider: "chatgpt" });
		expect(result.code).toBe(1);
		expect(JSON.parse(result.output)).toEqual({ ok: false, reason: "PROFILE_UNAVAILABLE" });
	});
});

describe("profile-scoped requirements", {
	timeout: PREFLIGHT_PROCESS_TIMEOUT_MS + 5000,
}, () => {
	const profileConfig = [
		'provider = "chatgpt"', 'model = "gpt-default"',
		'[profiles.audit]', 'provider = "chatgpt"', 'model = "gpt-audit"',
		'[profiles.local]', 'provider = "lmstudio"', 'model = "synthetic-local"', 'sanitize_thinking = true',
		'[profiles.protected]', 'provider = "chatgpt"', 'model = "gpt-protected"', 'sanitize_thinking = true',
		'',
	].join("\n");
	it.each([
		{ name: "explicit allowed profile despite unused sanitizer profiles", prefix: "", routing: { profile: "audit" },
			model: "gpt-audit", profile: "audit", profileSource: "explicit" },
		{ name: "allowed active profile despite unused policy", prefix: 'active_profile = "audit"\n', routing: {},
			model: "gpt-audit", profile: "audit", profileSource: "active" },
		{ name: "explicit allowed profile overrides protected active profile", prefix: 'active_profile = "protected"\n', routing: { profile: "audit" },
			model: "gpt-audit", profile: "audit", profileSource: "explicit" },
		{ name: "no selected profile uses global provider and model defaults", prefix: "", routing: {},
			model: "gpt-default", profile: null, profileSource: null },
	])("admits $name without auth-store or provider initialization", async ({ prefix, routing, model, profile, profileSource }) => {
		const home = scratch(); fs.mkdirSync(path.join(home, ".config", "swival"), { recursive: true });
		fs.writeFileSync(path.join(home, ".config", "swival", "config.toml"), prefix + profileConfig);
		const result = await runPreflight(repository(), home, {}, routing);
		expect(result.code, result.output).toBe(0);
		expect(JSON.parse(result.output)).toMatchObject({ provider: "chatgpt", model, profile,
			reportIdentity: { provider: "chatgpt", model }, selection: { profileSource } });
		expect(fs.readdirSync(home)).toEqual([".config"]);
		expect(fs.readdirSync(path.join(home, ".config"))).toEqual(["swival"]);
	});
	it.each([
		{ name: "explicit selected sanitizer profile", prefix: "", routing: { profile: "local" }, config: profileConfig,
			project: "", reason: "POLICY_NOT_PROPAGATED", field: "sanitize_thinking" },
		{ name: "active selected sanitizer profile", prefix: 'active_profile = "protected"\n', routing: {}, config: profileConfig,
			project: "", reason: "POLICY_NOT_PROPAGATED", field: "sanitize_thinking" },
		{ name: "global unsupported requirement", prefix: 'llm_filter = "synthetic-required-filter"\n', routing: { profile: "audit" }, config: profileConfig,
			project: "", reason: "POLICY_NOT_PROPAGATED", field: "llm_filter" },
		{ name: "project unsupported requirement", prefix: "", routing: { profile: "audit" }, config: profileConfig,
			project: 'llm_filter = "synthetic-required-filter"\n', reason: "POLICY_NOT_PROPAGATED", field: "llm_filter" },
		{ name: "global requirement cannot be disabled by selected profile", prefix: 'sanitize_thinking = true\n', routing: { profile: "audit" },
			config: profileConfig.replace('[profiles.audit]\n', '[profiles.audit]\nsanitize_thinking = false\n'),
			project: "", reason: "POLICY_NOT_PROPAGATED", field: "sanitize_thinking" },
		{ name: "malformed type in unused profile via released validation", prefix: "", routing: { profile: "audit" },
			config: profileConfig.replace('model = "synthetic-local"', 'model = 42'),
			project: "", reason: "CONFIG_INVALID", field: undefined },
		{ name: "unknown key in unused profile via released validation", prefix: "", routing: { profile: "audit" },
			config: profileConfig.replace('[profiles.local]\n', '[profiles.local]\nunknown_policy = true\n'),
			project: "", reason: "CONFIG_INVALID", field: undefined },
		{ name: "missing selected profile without fallback", prefix: 'active_profile = "audit"\n', routing: { profile: "missing" }, config: profileConfig,
			project: "", reason: "PROFILE_UNAVAILABLE", field: undefined },
	])("rejects $name", async ({ prefix, routing, config, project, reason, field }) => {
		const source = repository(); const home = scratch();
		fs.mkdirSync(path.join(home, ".config", "swival"), { recursive: true });
		fs.writeFileSync(path.join(home, ".config", "swival", "config.toml"), prefix + config);
		if (project) fs.writeFileSync(path.join(source, "swival.toml"), project);
		const result = await runPreflight(source, home, {}, routing);
		expect(result.code, result.output).toBe(1);
		expect(JSON.parse(result.output)).toEqual({ ok: false, reason, ...(field ? { field } : {}) });
	});
});

async function runPreflight(source: string, home: string, environment = {}, routing = {}) {
	const { execFile } = await import("node:child_process");
	return new Promise<{ code: number; output: string }>((resolve) => {
		const child = execFile(python, ["-I", path.join(ROOT, "scripts", "native_audit.py"), "--preflight"], {
			cwd: home, env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), LITELLM_LOCAL_MODEL_COST_MAP: "True", NONO_NO_UPDATE_CHECK: "1", ...environment },
			timeout: PREFLIGHT_PROCESS_TIMEOUT_MS, maxBuffer: 64 * 1024,
		}, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, output: stdout + stderr }));
		child.stdin!.end(JSON.stringify({ source, routing }));
	});
}

describe("independent committed snapshot", () => {
	it.each(["source", "git"])("refuses a snapshot inside a symlinked %s root", async (kind) => {
		const { createCommittedSnapshot } = await import("../extensions/native-audit.js");
		const source = repository(); const alias = path.join(scratch(), "alias");
		const target = kind === "source" ? source : path.join(source, ".git");
		fs.symlinkSync(target, alias);
		await expect(createCommittedSnapshot(source, path.join(alias, "snapshot"))).rejects.toThrow(/outside|source|Git/);
		expect(fs.existsSync(path.join(target, "snapshot"))).toBe(false);
	});
	it("imports committed contents without source hooks, filters, refs, dirty or untracked data", async () => {
		const native = await import("../extensions/native-audit.js").catch(() => undefined);
		expect(native?.createCommittedSnapshot).toBeTypeOf("function");
		const source = repository();
		fs.writeFileSync(path.join(source, "src", "code.py"), "dirty\n");
		fs.writeFileSync(path.join(source, "untracked.py"), "untracked\n");
		fs.mkdirSync(path.join(source, ".git", "hooks"));
		fs.writeFileSync(path.join(source, ".git", "hooks", "post-checkout"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
		git(source, "config", "filter.hostile.smudge", "false");
		git(source, "config", "filter.hostile.clean", "false");
		git(source, "config", "core.fsmonitor", "false");
		git(source, "config", "diff.external", "false");
		const before = git(source, "show-ref");
		const head = git(source, "rev-parse", "HEAD").trim();
		const dest = path.join(scratch(), "snapshot");
		const manifest = await native!.createCommittedSnapshot(source, dest);
		expect(manifest.sourceCommit).toBe(head);
		expect(git(dest, "rev-parse", "HEAD^{tree}").trim()).toBe(git(source, "rev-parse", "HEAD^{tree}").trim());
		expect(fs.readFileSync(path.join(dest, "src", "code.py"), "utf8")).toBe("def answer(): return 42\n");
		expect(fs.existsSync(path.join(dest, "untracked.py"))).toBe(false);
		expect(git(dest, "remote").trim()).toBe("");
		expect(fs.existsSync(path.join(dest, ".git", "objects", "info", "alternates"))).toBe(false);
		expect(git(source, "show-ref")).toBe(before);
		expect(fs.readFileSync(path.join(source, "src", "code.py"), "utf8")).toBe("dirty\n");
	});
	it("keeps tracked swival.toml HEAD bytes in released phases while its runtime copy stays inert", async () => {
		const { createCommittedSnapshot } = await import("../extensions/native-audit.js");
		const source = repository();
		const original = '# committed-content-sentinel\n[audit]\nforce_review=["src/code.py"]\n';
		fs.writeFileSync(path.join(source, "swival.toml"), original);
		git(source, "add", "swival.toml"); git(source, "commit", "-m", "tracked config fixture");
		const before = { refs: git(source, "show-ref"), status: git(source, "status", "--porcelain=v1") };
		const dest = path.join(scratch(), "snapshot");
		const manifest = await createCommittedSnapshot(source, dest);
		expect(manifest.files).toContain("swival.toml");
		expect(git(dest, "show", "HEAD:swival.toml")).toBe(original);
		expect(git(dest, "rev-parse", "HEAD^{tree}").trim()).toBe(manifest.sourceTree);
		expect(fs.readFileSync(path.join(dest, "swival.toml"), "utf8")).toBe("# Native audit runtime configuration is inert.\n");
		const output = execFileSync(python, ["-I", "-B", path.join(ROOT, "tests", "native_audit_test.py"), "--check-content", dest], {
			timeout: 15000, maxBuffer: 64 * 1024,
			env: { PATH: process.env.PATH, HOME: scratch(), LITELLM_LOCAL_MODEL_COST_MAP: "True" },
			stdio: ["ignore", "pipe", "pipe"],
		}).toString();
		expect(output).toContain("Released committed config phases passed");
		expect(git(source, "show-ref")).toBe(before.refs);
		expect(git(source, "status", "--porcelain=v1")).toBe(before.status);
		expect(fs.readFileSync(path.join(source, "swival.toml"), "utf8")).toBe(original);
	}, 20000);
	it.each(["AUDIT-FINDINGS/injected.md", ".SWIVAL/AUDIT/state.json", "NATIVE-CLI-REPORT.JSON",
		"Native-Cli-Report.Json/descendant.md"])("refuses reserved evidence alias %s before snapshot import", async (file) => {
		const { createCommittedSnapshot } = await import("../extensions/native-audit.js");
		const source = repository(); const target = path.join(source, file);
		fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "source-controlled evidence");
		git(source, "add", "--", file); git(source, "commit", "-m", "reserved evidence fixture");
		expect(git(source, "show", `HEAD:${file}`)).toBe("source-controlled evidence");
		const destination = path.join(scratch(), "snapshot");
		await expect(createCommittedSnapshot(source, destination)).rejects.toThrow(/unsupported|path/i);
		expect(fs.existsSync(destination)).toBe(false);
	});
	it.each(["link", "credential", "control"])('rejects unsupported %s paths before native dispatch', async (kind) => {
		const native = await import("../extensions/native-audit.js").catch(() => undefined);
		expect(native?.createCommittedSnapshot).toBeTypeOf("function");
		const source = repository();
		if (kind === "link") fs.symlinkSync("src/code.py", path.join(source, "link.py"));
		else fs.writeFileSync(path.join(source, kind === "credential" ? "private.key" : "newline\nname.py"), "fixture\n");
		git(source, "add", "."); git(source, "commit", "-m", "unsupported fixture");
		await expect(native!.createCommittedSnapshot(source, path.join(scratch(), "snapshot"))).rejects.toThrow(/unsupported|secret|credential/i);
	});
});
