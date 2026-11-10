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
			const route = { version: 2, runtime: { swival: "1.9.3", litellm: "1.106.6" }, provider: "openrouter",
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
	// Bedrock and Vertex routes run host-side `aws` / `gcloud` before AgentFS exists.
	async function credentialFixture(provider: "bedrock" | "geap") {
		const f = await fixture(); const home = f.runtime.environment!.HOME!;
		const bin = path.dirname(f.runtime.python!);
		const tool = provider === "bedrock" ? "aws" : "gcloud";
		fs.writeFileSync(path.join(bin, tool), `#!${f.runtime.python}\n`, { mode: 0o700 });
		f.runtime.searchPath = [bin, "/usr/bin", "/bin"].join(path.delimiter);
		const stateRoot = provider === "bedrock" ? path.join(home, ".aws") : path.join(home, ".config", "gcloud");
		const route = { version: 2, runtime: { swival: "1.9.3", litellm: "1.106.6" }, provider, model: "concrete-model",
			endpoint: provider === "bedrock" ? "us-east-2" : null, profile: null, reasoningEffort: null, options: {},
			selection: { profileSource: null, explicitFields: [] }, reportIdentity: { provider, model: "concrete-model" },
			...(provider === "geap" ? { project: "synthetic-project", location: "global" } : {}) };
		const original = vi.mocked(execFile).getMockImplementation()!;
		const probes: string[] = [];
		const credentialEnvironments: NodeJS.ProcessEnv[] = [];
		vi.mocked(execFile).mockImplementation(((exe: string, args: string[], options: any, callback: any) => {
			if (exe === fs.realpathSync(f.runtime.git!)) return (original as any)(exe, args, options, callback);
			probes.push(path.basename(exe));
			if (exe === f.runtime.python) callback(null, JSON.stringify(route));
			else { credentialEnvironments.push(options.env); callback(new Error("intercepted credential export")); }
			return {};
		}) as typeof execFile);
		return { ...f, home, tool, stateRoot, probes, credentialEnvironments };
	}
	// Entries the CLIs read or write beneath their state root. File aliases point at
	// a file inside the protected root; directory aliases point at the root itself.
	const fileAliases = ["config", "credentials", "sso/cache/token.json", "application_default_credentials.json", "configurations/config_default"];
	const nestedAliases = { bedrock: ["config", "credentials", "cli/cache", "sso/cache", "sso/cache/token.json"],
		geap: ["application_default_credentials.json", "logs", "configurations", "configurations/config_default"] };
	async function refusedCredentialState(f: Awaited<ReturnType<typeof credentialFixture>>) {
		await expect(f.start()).rejects.toThrow(/refuses repository-owned runtime paths/);
		expect(f.probes).toEqual(["python"]);
		expect(f.credentialEnvironments).toEqual([]);
		expect(spawn).not.toHaveBeenCalled(); expect(fs.existsSync(f.artifacts)).toBe(false);
	}
	it.each((["bedrock", "geap"] as const).flatMap((provider) =>
		(["source", "commonGit", "worktreeGit"] as const).flatMap((root) =>
			["root", "dangling-root", ...nestedAliases[provider]].map((alias) => [provider, root, alias] as const))))(
		"refuses %s credential state aliased into %s via %s before the host credential CLI runs", async (provider, root, alias) => {
			const f = await credentialFixture(provider);
			fs.mkdirSync(path.dirname(f.stateRoot), { recursive: true });
			if (alias === "root") fs.symlinkSync(f[root], f.stateRoot);
			else if (alias === "dangling-root") fs.symlinkSync(path.join(f[root], "not-created"), f.stateRoot);
			else {
				const location = path.join(f.stateRoot, alias); fs.mkdirSync(path.dirname(location), { recursive: true });
				let target = f[root];
				if (fileAliases.includes(alias)) { target = path.join(target, "aliased-state"); fs.writeFileSync(target, "# inert\n"); }
				fs.symlinkSync(target, location);
			}
			await refusedCredentialState(f);
		});
	it.each((["bedrock", "geap"] as const).flatMap((provider) =>
		["root", provider === "bedrock" ? "cli/cache" : "logs"].map((alias) => [provider, alias] as const)))(
		"refuses %s credential state %s aliased to an ancestor of source and Git", async (provider, alias) => {
			const f = await credentialFixture(provider);
			const location = alias === "root" ? f.stateRoot : path.join(f.stateRoot, alias);
			fs.mkdirSync(path.dirname(location), { recursive: true });
			fs.symlinkSync(f.root, location);
			await refusedCredentialState(f);
		});
	it.each(((["bedrock", "geap"] as const).flatMap((provider) =>
		(["source", "commonGit", "worktreeGit"] as const).map((root) => [provider, root] as const))))(
		"refuses %s credential state reaching %s through a symlinked external directory before the host credential CLI runs", async (provider, root) => {
			const f = await credentialFixture(provider);
			// Stow-style layout: the state entry is a directory symlink to safe external
			// operator state whose own child aliases the protected root.
			const external = path.join(f.root, "operator-state"); fs.mkdirSync(external);
			fs.mkdirSync(f.stateRoot, { recursive: true });
			if (provider === "bedrock") {
				fs.symlinkSync(f[root], path.join(external, "cache"));
				fs.symlinkSync(external, path.join(f.stateRoot, "cli"));
			} else {
				const target = path.join(f[root], "aliased-state"); fs.writeFileSync(target, "# inert\n");
				fs.symlinkSync(target, path.join(external, "config_default"));
				fs.symlinkSync(external, path.join(f.stateRoot, "configurations"));
			}
			await refusedCredentialState(f);
		});
	it.each(((["source", "commonGit", "worktreeGit"] as const).flatMap((root) =>
		(["configurations-alias", "dated-directory"] as const).map((layout) => [root, layout] as const))))(
		"refuses geap credential state reaching %s through the gcloud logs directory via %s before the host credential CLI runs", async (root, layout) => {
			const f = await credentialFixture("geap");
			// Disabled file logging does not make `logs` inert: gcloud reads
			// `configurations/config_default` through a `configurations -> logs` alias,
			// and prunes dated directories beneath an ordinary `logs` regardless.
			const logs = path.join(f.stateRoot, "logs"); fs.mkdirSync(logs, { recursive: true });
			if (layout === "configurations-alias") {
				const target = path.join(f[root], "aliased-state"); fs.writeFileSync(target, "# inert\n");
				fs.symlinkSync(target, path.join(logs, "config_default"));
				fs.symlinkSync(logs, path.join(f.stateRoot, "configurations"));
			} else {
				fs.symlinkSync(f[root], path.join(logs, "2000.01.01"));
			}
			await refusedCredentialState(f);
		});
	it.each(["bedrock", "geap"] as const)("binds validated %s credential state for the host CLI only", async (provider) => {
		const f = await credentialFixture(provider);
		// Ordinary nested state, including a symlink to populated external operator
		// state that contains its own symlink cycle, is accepted without looping.
		for (const nested of provider === "bedrock" ? ["cli/cache", "sso/cache"] : ["logs/2030.01.01", "configurations"]) {
			fs.mkdirSync(path.join(f.stateRoot, nested), { recursive: true });
			fs.writeFileSync(path.join(f.stateRoot, nested, "entry"), "# inert\n");
		}
		const external = path.join(f.root, "operator-state"); fs.mkdirSync(path.join(external, "nested"), { recursive: true });
		fs.writeFileSync(path.join(external, "nested", "entry"), "# inert\n");
		fs.symlinkSync(external, path.join(external, "nested", "loop"));
		fs.symlinkSync(external, path.join(f.stateRoot, "external"));
		await expect(f.start()).rejects.toThrow(/credential is unavailable; no fallback/);
		expect(f.probes).toEqual(["python", f.tool]);
		expect(f.credentialEnvironments).toHaveLength(1);
		const env = f.credentialEnvironments[0];
		if (provider === "bedrock") {
			expect(env).toMatchObject({ AWS_CONFIG_FILE: path.join(f.stateRoot, "config"), AWS_SHARED_CREDENTIALS_FILE: path.join(f.stateRoot, "credentials") });
		} else {
			expect(env).toMatchObject({ CLOUDSDK_CONFIG: f.stateRoot, CLOUDSDK_CORE_DISABLE_FILE_LOGGING: "1" });
		}
		expect(spawn).not.toHaveBeenCalled(); expect(fs.existsSync(f.artifacts)).toBe(false);
	});
	it.each(["bedrock", "geap"] as const)("skips %s credential state inspection when ambient credentials avoid the host CLI", async (provider) => {
		const f = await credentialFixture(provider);
		fs.mkdirSync(path.dirname(f.stateRoot), { recursive: true }); fs.symlinkSync(f.source, f.stateRoot);
		Object.assign(f.runtime.environment!, provider === "bedrock"
			? { AWS_ACCESS_KEY_ID: "synthetic-access", AWS_SECRET_ACCESS_KEY: "synthetic-secret", AWS_SESSION_TOKEN: "synthetic-session" }
			: { GOOGLE_OAUTH_ACCESS_TOKEN: "synthetic-token" });
		// The aliased state is never bound or inspected; preparation proceeds to the AgentFS probe.
		await expect(f.start()).rejects.toThrow(/local agentfs check failed/);
		expect(f.probes).toEqual(["python", "agentfs"]);
		expect(spawn).not.toHaveBeenCalled(); expect(fs.existsSync(f.artifacts)).toBe(false);
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
