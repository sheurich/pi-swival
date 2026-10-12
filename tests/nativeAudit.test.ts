import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerExtension from "../extensions/index.js";
import { nativeTestPython as python } from "./nativePython.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const startupPath = process.env.PATH;
beforeEach(() => {
	process.env.PATH = (startupPath ?? "").split(path.delimiter).filter(path.isAbsolute).join(path.delimiter);
});
afterEach(() => { process.env.PATH = startupPath; });
const scratchDirs: string[] = [];
const scratch = () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-audit-test-")));
	scratchDirs.push(dir);
	return dir;
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", [
	"-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args,
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
		fs.writeFileSync(path.join(bin, "swival"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(path.join(root, "generic-dispatch"))}, 'forbidden'); process.exit(1);`, { mode: 0o755 });
		process.env.PATH = `${bin}:${(originalPath ?? "").split(path.delimiter).filter(path.isAbsolute).join(path.delimiter)}`;
		registerExtension({ registerTool: (registered: any) => { tool = registered; } } as any,
			{ artifactRoot: root, nativePython: python } as any);
	});
	it("describes native and ordinary isolation without conflating them", () => {
		expect(tool.description).toContain("Native mode uses Linux unshare and bubblewrap with builtin Session isolation");
		expect(tool.description).toContain("Ordinary delegation uses AgentFS");
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
	])("rejects incompatible or bypass fields without native launch: %j", async (other) => {
		const result = await tool.execute("audit", { audit: {}, ...other }, undefined, undefined, { cwd: ROOT, hasUI: false });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/native audit|cannot be combined/i);
		expect(fs.existsSync(path.join(root, "generic-dispatch"))).toBe(false);
		expect(fs.readdirSync(root)).toEqual([]);
	});
	it("registered native tool rejects an ambient proxy before artifacts, workers, or providers", async () => {
		const source = repository(); const home = scratch();
		fs.mkdirSync(path.join(home, ".config"), { recursive: true });
		const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
			hTtP_pRoXy: process.env.hTtP_pRoXy };
		process.env.HOME = home; process.env.XDG_CONFIG_HOME = path.join(home, ".config");
		process.env.hTtP_pRoXy = "";
		try {
			const result = await tool.execute("audit", { audit: { all: true }, modelOverride: "offline-model" },
				undefined, undefined, { cwd: source, hasUI: false });
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/preflight failed.*No native worker\/provider was started/i);
			expect(fs.readdirSync(root)).toEqual([]);
			expect(fs.existsSync(path.join(root, "generic-dispatch"))).toBe(false);
		} finally {
			for (const [name, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[name]; else process.env[name] = value;
			}
		}
	});
});

describe("native preflight protection requirements (no worker, no provider)", () => {
	it.each([
		["global", 'encrypt_secrets = true'], ["project", 'llm_filter = "required-filter"'],
		["global", 'encrypt_secrets_key = "synthetic-never-log-this"'],
		["project", 'unrecognized_shield = true'], ["global", 'nono_audit_integrity = true'],
		["global", 'nono_rollback = true'], ["project", 'lifecycle_fail_closed = true'], ["global", '[profiles.protected]\nprovider="lmstudio"\nllm_filter="required"'],
		...["global", "project"].flatMap((where) => [
			[where, 'sandbox="agentfs"'], [where, 'sandbox_auto_session=true'],
			[where, 'sandbox_session="required"'],
		]),
	])("rejects protected or unknown %s configuration before native launch", async (where, config) => {
		const dir = repository();
		const home = scratch();
		fs.mkdirSync(path.join(home, ".config", "swival"), { recursive: true });
		fs.writeFileSync(where === "global" ? path.join(home, ".config", "swival", "config.toml") : path.join(dir, "swival.toml"), config);
		const result = await runPreflight(dir, home, {}, { model: "offline-model" });
		expect(result.code).toBe(1);
		expect(result.output).toMatch(/protected|unknown|unsupported/i);
		expect(result.output).not.toContain("synthetic-never-log-this");
	});
	it.each(Object.entries({
		network: '"none"', files: '"none"', sandbox: '"nono"', sandbox_strict_read: "true",
		sandbox_session: '"required"', sandbox_auto_session: "true",
		lifecycle_fail_closed: "true", nono_profile: '"required-profile"', nono_rollback: "true",
		nono_block_net: "true", nono_allow_domain: '["offline.invalid"]',
		nono_network_profile: '"required-profile"', nono_credential: '["required-reference"]',
		nono_audit_integrity: "true",
	}).flatMap(([key, value]) => ["explicit", "active"].map((selection) => [key, selection, value])))
		("keeps released restrictive-profile rejection for %s under %s selection", async (key, selection, value) => {
			const home = scratch(); fs.mkdirSync(path.join(home, ".config", "swival"), { recursive: true });
			fs.writeFileSync(path.join(home, ".config", "swival", "config.toml"),
				`${selection === "active" ? 'active_profile="test"\n' : ''}[profiles.test]\n` +
				`provider="lmstudio"\nmodel="offline-model"\ndescription="synthetic-never-log-this"\n${key}=${value}\n`);
			const result = await runPreflight(repository(), home, {}, selection === "explicit" ? { profile: "test" } : {});
			expect(result.code).toBe(1); expect(result.output).toMatch(/unknown|unsupported/i);
			expect(result.output).not.toContain("synthetic-never-log-this");
		});
	it("rejects SWIVAL_ENCRYPT_KEY presence without inspecting or logging its value", async () => {
		const result = await runPreflight(repository(), scratch(), { SWIVAL_ENCRYPT_KEY: "synthetic-never-log-this" });
		expect(result.code).toBe(1);
		expect(result.output).toMatch(/protected/i);
		expect(result.output).not.toContain("synthetic-never-log-this");
	});
	it.each([
		"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
		"hTtP_pRoXy", "hTtPs_PrOxY", "aLl_PrOxY",
	].flatMap((name) => [[name, ""], [name, "http://synthetic-proxy.invalid"]]))
		("rejects %s by presence for %s without a provider", async (name, value) => {
			const result = await runPreflight(repository(), scratch(), { [name]: value }, { model: "offline-model" });
			expect(result.code).toBe(1);
			expect(result.output).toContain("Unsupported native transport proxy requirements.");
			expect(result.output).not.toContain("synthetic-proxy.invalid");
		});
	it("resolves global profile and explicit model/provider/effort without initializing a provider", async () => {
		const home = scratch();
		fs.mkdirSync(path.join(home, ".config", "swival"), { recursive: true });
		fs.writeFileSync(path.join(home, ".config", "swival", "config.toml"), '[profiles.test]\nprovider="lmstudio"\nmodel="profile-model"\nreasoning_effort="high"\n');
		const result = await runPreflight(repository(), home, {}, { profile: "test", model: "override-model", reasoningEffort: "xhigh" });
		expect(result.code, result.output).toBe(0);
		expect(JSON.parse(result.output)).toMatchObject({ provider: "lmstudio", model: "override-model", reasoningEffort: "xhigh", profile: "test" });
	});
	it("preserves released ChatGPT profile routing without opening OAuth credentials", async () => {
		const home = scratch(); fs.mkdirSync(path.join(home, ".config", "swival"), { recursive: true });
		fs.writeFileSync(path.join(home, ".config", "swival", "config.toml"),
			'active_profile="test"\n[profiles.test]\nprovider="chatgpt"\nmodel="chatgpt/gpt-offline"\n');
		const result = await runPreflight(repository(), home);
		expect(result.code, result.output).toBe(0);
		expect(JSON.parse(result.output)).toMatchObject({ provider: "chatgpt", profile: "test",
			model: "chatgpt/gpt-offline", transportModel: "chatgpt/gpt-offline",
			destination: { apiBase: "https://chatgpt.com/backend-api/codex" } });
		expect(fs.existsSync(path.join(home, ".config", "litellm"))).toBe(false);
	});
	it.each(["missing", "", false])("rejects missing or invalid profiles without fallback: %s", async (profile) => {
		const result = await runPreflight(repository(), scratch(), {}, { profile, model: "offline-model" });
		expect(result.code).toBe(1);
		expect(result.output).toMatch(/profile.*missing|profile.*unavailable/i);
	});
});

async function runPreflight(source: string, home: string, environment = {}, routing = {}) {
	const { execFile } = await import("node:child_process");
	return new Promise<{ code: number; output: string }>((resolve) => {
		const child = execFile(python, ["-I", path.join(ROOT, "scripts", "native_audit.py"), "--preflight"], {
			cwd: home, env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), ...environment },
			timeout: 5000, maxBuffer: 64 * 1024,
		}, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, output: stdout + stderr }));
		child.stdin!.end(JSON.stringify({ source, routing }));
	});
}

describe("independent committed snapshot", () => {
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
