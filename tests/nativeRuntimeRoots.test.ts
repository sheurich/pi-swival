import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { captureNativeRuntime, prepareNativeAudit, type NativeRuntime } from "../extensions/native-audit.js";
import { fixtureGit, fixtureRepository, nativeScratch } from "./nativeFixtures.js";

// Permit real, fixed Git plumbing only. Stop before Python/configuration imports,
// AgentFS availability checks, or a worker can run; never call a provider.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: vi.fn(actual.execFile), spawn: vi.fn() };
});
vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return { ...actual, randomBytes: () => Buffer.alloc(16, 1) };
});
const roots: string[] = [];
const hostPlatform = process.platform;
afterEach(() => {
	Object.defineProperty(process, "platform", { value: hostPlatform });
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture() {
	// Explicitly exercise the non-Darwin path even when developing on macOS.
	Object.defineProperty(process, "platform", { value: "linux" });
	const root = nativeScratch("native-runtime-roots-"); roots.push(root);
	const main = fixtureRepository(root);
	const source = path.join(root, "worktree");
	fixtureGit(main, "worktree", "add", "--detach", source);
	const commonGit = fixtureGit(source, "rev-parse", "--path-format=absolute", "--git-common-dir");
	const worktreeGit = fixtureGit(source, "rev-parse", "--absolute-git-dir");
	const bin = path.join(root, "bin"); fs.mkdirSync(bin);
	const python = path.join(bin, "python");
	const cli = path.join(bin, "swival");
	const agentfs = path.join(bin, "agentfs");
	const nono = path.join(bin, "nono");
	for (const executable of [python, cli, agentfs, nono]) {
		fs.writeFileSync(executable, `#!${python}\n`, { mode: 0o700 });
	}
	const home = path.join(root, "home"); fs.mkdirSync(home);
	const runtime: NativeRuntime = { ...captureNativeRuntime(), python, cli, agentfs, nono,
		searchPath: ["/usr/bin", "/bin"].join(path.delimiter),
		environment: { HOME: home, OPENROUTER_API_KEY: "synthetic-presence-only" } };
	const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
	const started: string[] = [];
	let preflightEnv: NodeJS.ProcessEnv | undefined;
	vi.mocked(execFile).mockClear().mockImplementation(((exe: string, args: string[], options: any, callback: any) => {
		if (exe === fs.realpathSync(runtime.git!) && args[0] === "--no-pager") return actual.execFile(exe, args, options, callback);
		started.push(exe);
		preflightEnv = options.env;
		throw new Error("intercepted configuration preflight");
	}) as typeof execFile);
	vi.mocked(spawn).mockReset().mockImplementation(() => { throw new Error("intercepted native worker"); });
	const artifacts = path.join(root, "artifacts");
	const start = () => prepareNativeAudit(source, { audit: {} }, { paths: [], all: true, workers: 1, patchMaxTurns: 5 },
		runtime, artifacts, "runtime-roots", 10_000);
	return { root, source, commonGit, worktreeGit, runtime, artifacts, start, started, environment: () => preflightEnv };
}

async function refused(f: Awaited<ReturnType<typeof fixture>>) {
	const error = await f.start().then(() => undefined, (failure: unknown) => failure);
	// Check interception first: a later unrelated refusal is not isolation evidence.
	expect(f.started, "configuration/preflight/AgentFS must not start").toEqual([]);
	expect(spawn).not.toHaveBeenCalled();
	expect(fs.existsSync(f.artifacts)).toBe(false);
	expect(String(error)).toMatch(/runtime configuration.*(?:root|source|Git)/i);
}

// No Darwin guard: Linux CI must exercise the same trust boundary.
describe("native runtime configuration roots", () => {
	it.each((["HOME", "XDG_CONFIG_HOME"] as const).flatMap((key) =>
		(["source", "commonGit", "worktreeGit"] as const).flatMap((root) =>
			["direct", "future", "symlink", "future-symlink", "case", "dangling"].map((alias) => [key, root, alias] as const))))(
		"refuses %s under %s via %s before preflight on Linux", async (key, root, kind) => {
			const f = await fixture(); const protectedRoot = f[root];
			const alias = path.join(f.root, "alias"); fs.symlinkSync(protectedRoot, alias);
			const caseAlias = path.join(path.dirname(protectedRoot), path.basename(protectedRoot).toUpperCase());
			// On case-sensitive CI, use a fixture-local symlink as the alias instead.
			const resolvedCaseAlias = fs.existsSync(caseAlias) ? caseAlias : alias;
			const dangling = path.join(f.root, "future-alias");
			fs.symlinkSync(path.join(protectedRoot, "not-created"), dangling);
			const locations: Record<string, string> = { direct: protectedRoot, future: path.join(protectedRoot, "future", "config"),
				symlink: alias, "future-symlink": path.join(alias, "future", "config"), case: path.join(resolvedCaseAlias, "future"), dangling };
			f.runtime.environment![key] = locations[kind];
			await refused(f);
		});
	it.each((["HOME", "XDG_CONFIG_HOME"] as const).flatMap((key) =>
		["empty", "dot", "relative", "tilde", "nul", "file", "loop"].map((kind) => [key, kind] as const)))(
		"rejects invalid %s (%s) before preflight", async (key, kind) => {
			const f = await fixture();
			const file = path.join(f.root, "not-a-directory"); fs.writeFileSync(file, "inert");
			const loop = path.join(f.root, "loop"); fs.symlinkSync(loop, loop);
			const locations: Record<string, string> = { empty: "", dot: ".", relative: "relative/config", tilde: "~/config",
				nul: "/invalid\x00root", file, loop };
			f.runtime.environment![key] = locations[kind];
			await refused(f);
		});
	it.each(["source", "commonGit", "worktreeGit"] as const)(
		"refuses the effective default XDG root aliased into %s before preflight", async (root) => {
			const f = await fixture();
			fs.symlinkSync(f[root], path.join(f.runtime.environment!.HOME!, ".config"));
			await refused(f);
		});
	it.each((["source", "commonGit", "worktreeGit"] as const).flatMap((root) =>
		["swival", "config-file", "nono", "agentfs", "agentfs-run"].flatMap((derived) =>
			["direct", "future", "dangling", "case"].flatMap((alias) =>
				["default", "explicit"].map((xdg) => [root, derived, alias, xdg] as const)))))(
		"refuses derived %s %s via %s with %s XDG before preflight on Linux", async (root, derived, alias, xdg) => {
			const f = await fixture(); const home = f.runtime.environment!.HOME!;
			const config = path.join(home, xdg === "default" ? ".config" : "operator-config");
			if (xdg === "explicit") f.runtime.environment!.XDG_CONFIG_HOME = config;
			const locations: Record<string, string> = { swival: path.join(config, "swival"),
				"config-file": path.join(config, "swival", "config.toml"), nono: path.join(config, "nono"),
				agentfs: path.join(home, ".agentfs"), "agentfs-run": path.join(home, ".agentfs", "run") };
			const location = locations[derived]; fs.mkdirSync(path.dirname(location), { recursive: true });
			let target = f[root];
			if (derived === "config-file") {
				target = path.join(target, "runtime-config.toml"); fs.writeFileSync(target, "# inert\n");
			}
			if (alias === "future" || alias === "dangling") target = path.join(target, "not-created", "future");
			if (alias === "case") {
				const casePath = path.join(path.dirname(f[root]), path.basename(f[root]).toUpperCase());
				if (!fs.existsSync(casePath)) fs.symlinkSync(f[root], casePath);
				target = derived === "config-file" ? path.join(casePath, "runtime-config.toml") : casePath;
			}
			if (alias === "dangling") {
				const link = path.join(f.root, "dangling-derived"); fs.symlinkSync(target, link); target = link;
			}
			fs.symlinkSync(target, location);
			await refused(f);
		});
	it("refuses a Nono root containing the source, not only descendants", async () => {
		const f = await fixture(); const config = path.join(f.runtime.environment!.HOME!, ".config");
		fs.mkdirSync(config); fs.symlinkSync(f.root, path.join(config, "nono")); await refused(f);
	});
	it.each(["source", "commonGit", "worktreeGit", "ancestor"] as const)(
		"refuses the generated AgentFS session aliased to %s before preflight", async (root) => {
			const f = await fixture(); const run = path.join(f.runtime.environment!.HOME!, ".agentfs", "run");
			fs.mkdirSync(run, { recursive: true });
			fs.symlinkSync(root === "ancestor" ? f.root : f[root], path.join(run, `native-${"01".repeat(16)}`));
			await refused(f);
		});
	it.each([null, "https://caller.invalid/v1", "http://127.0.0.1:8444/v1"])(
		"rejects caller baseUrlOverride %s before all execution and artifacts", async (baseUrlOverride) => {
			const f = await fixture();
			await expect(prepareNativeAudit(f.source, { audit: {}, baseUrlOverride },
				{ paths: [], all: true, workers: 1, patchMaxTurns: 5 }, f.runtime, f.artifacts, "override", 10_000))
				.rejects.toThrow(/cannot be combined with baseUrlOverride/);
			expect(execFile).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
			expect(fs.existsSync(f.artifacts)).toBe(false);
		});
	it.each(["preflight-config", "preflight-nono", "preflight-agentfs", "preflight-safe", "agentfs-version", "nono-version"])(
		"refuses runtime path retargeting after %s without a native launch", async (stage) => {
			const f = await fixture(); const home = f.runtime.environment!.HOME!;
			const config = path.join(home, ".config"); fs.mkdirSync(config);
			const selected = stage === "preflight-config" ? path.join(config, "swival") :
				stage === "preflight-agentfs" ? path.join(home, ".agentfs") : path.join(config, "nono");
			const safe = path.join(f.root, "trusted-runtime"); fs.mkdirSync(safe); fs.symlinkSync(safe, selected);
			const original = vi.mocked(execFile).getMockImplementation()!;
			const probes: string[] = [];
			const route = { version: 2, runtime: { swival: "1.0.48", litellm: "1.105.3" }, provider: "openrouter",
				model: "example/concrete", endpoint: null, profile: null, reasoningEffort: null, options: {},
				selection: { profileSource: null, explicitFields: [] }, reportIdentity: { provider: "openrouter", model: "example/concrete" } };
			vi.mocked(execFile).mockImplementation(((exe: string, args: string[], options: any, callback: any) => {
				if (exe === fs.realpathSync(f.runtime.git!)) return (original as any)(exe, args, options, callback);
				probes.push(path.basename(exe));
				const retarget = stage.startsWith("preflight-") ? exe === f.runtime.python :
					exe === (stage === "agentfs-version" ? f.runtime.agentfs : f.runtime.nono);
				if (retarget) {
					const target = stage === "preflight-safe" ? path.join(f.root, "other-runtime") : f.source;
					if (stage === "preflight-safe") fs.mkdirSync(target);
					fs.unlinkSync(selected); fs.symlinkSync(target, selected);
				}
				if (exe === f.runtime.python) callback(null, JSON.stringify(route));
				else if (args[0] === "--version") callback(null, Buffer.from("0.6.4"));
				else throw new Error("unexpected subsequent native probe");
				return {};
			}) as typeof execFile);
			await expect(f.start()).rejects.toThrow(/runtime configuration.*(?:changed|source|Git)/i);
			expect(probes).toEqual(stage.startsWith("preflight-") ? ["python"] :
				stage === "agentfs-version" ? ["python", "agentfs"] : ["python", "agentfs", "nono"]);
			expect(spawn).not.toHaveBeenCalled(); expect(fs.existsSync(f.artifacts)).toBe(false);
		});
	it.each(["regular-config", "swival", "nono", "agentfs"])(
		"accepts trusted external derived path %s without launching", async (derived) => {
			const f = await fixture(); const home = f.runtime.environment!.HOME!;
			const config = path.join(home, ".config"); fs.mkdirSync(config);
			if (derived === "regular-config") {
				fs.mkdirSync(path.join(config, "swival")); fs.writeFileSync(path.join(config, "swival", "config.toml"), "# inert\n");
			} else {
				const safe = path.join(f.root, "operator-runtime"); fs.mkdirSync(safe);
				fs.symlinkSync(safe, derived === "agentfs" ? path.join(home, ".agentfs") : path.join(config, derived));
			}
			await expect(f.start()).rejects.toThrow("intercepted configuration preflight");
			expect(f.started).toEqual([f.runtime.python]); expect(spawn).not.toHaveBeenCalled();
			expect(fs.existsSync(f.artifacts)).toBe(false);
		});
	it.each(["unset", "separate", "aliased"])("accepts an ancestor HOME with %s external configuration", async (kind) => {
		const f = await fixture();
		f.runtime.environment!.HOME = f.root; // Ordinary /home/user containing its repository.
		const config = path.join(f.root, "operator-config"); fs.mkdirSync(config);
		if (kind === "separate") f.runtime.environment!.XDG_CONFIG_HOME = config;
		if (kind === "aliased") {
			const alias = path.join(f.root, "operator-alias"); fs.symlinkSync(config, alias);
			f.runtime.environment!.XDG_CONFIG_HOME = path.join(alias, "future");
		}
		await expect(f.start()).rejects.toThrow("intercepted configuration preflight");
		expect(f.started).toEqual([f.runtime.python]);
		expect(f.environment()).toMatchObject({ HOME: f.root, OPENROUTER_API_KEY: "present" });
		if (kind !== "unset") expect(f.environment()!.XDG_CONFIG_HOME).toBe(kind === "aliased" ? path.join(config, "future") : config);
		expect(spawn).not.toHaveBeenCalled();
		expect(fs.existsSync(f.artifacts)).toBe(false);
	});
});
