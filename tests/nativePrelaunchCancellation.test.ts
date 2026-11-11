import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as promises from "node:fs/promises";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { captureNativeRuntime, prepareNativeAudit } from "../extensions/native-audit.js";
import { fixtureRepository, nativeScratch } from "./nativeFixtures.js";

// Real fixed Git plumbing and filesystem checks; synthetic preflight/probes only.
// A spawn attempt is intercepted, never allowed to start an audit or provider.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: vi.fn(actual.execFile), spawn: vi.fn() };
});
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, lstat: vi.fn(actual.lstat), writeFile: vi.fn(actual.writeFile) };
});
const roots: string[] = [];
afterEach(() => {
	vi.resetAllMocks();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("refuses spawn when aborted inside the last asynchronous runtime-path check", async () => {
	const root = nativeScratch("native-prelaunch-cancel-"); roots.push(root);
	const source = fixtureRepository(root);
	const bin = path.join(root, "bin"); fs.mkdirSync(bin);
	const python = path.join(bin, "python"); const cli = path.join(bin, "swival");
	const agentfs = path.join(bin, "agentfs"); const nono = path.join(bin, "nono");
	for (const executable of [python, cli, agentfs, nono]) fs.writeFileSync(executable, `#!${python}\n`, { mode: 0o700 });
	const home = path.join(root, "home"); fs.mkdirSync(home);
	const runtime = { ...captureNativeRuntime(), python, cli, agentfs, nono, environment: { HOME: home },
		searchPath: ["/usr/bin", "/bin"].join(path.delimiter) };
	const route = { version: 2, runtime: { swival: "1.9.3", litellm: "1.106.6" }, provider: "openrouter",
		model: "example/concrete", endpoint: null, profile: null, reasoningEffort: null, options: {},
		selection: { profileSource: null, explicitFields: [] }, reportIdentity: { provider: "openrouter", model: "example/concrete" },
		scope: { mandatory_files: ["code.py"] } };
	const actualChild = await vi.importActual<typeof import("node:child_process")>("node:child_process");
	vi.mocked(execFile).mockImplementation(((exe: string, args: string[], options: any, callback: any) => {
		if (exe === fs.realpathSync(runtime.git!)) return actualChild.execFile(exe, args, options, callback);
		const output = exe === python ? JSON.stringify(route) : args[0] === "--version" && exe === agentfs ? "agentfs 0.6.4" : "";
		queueMicrotask(() => callback(null, options.encoding === "buffer" ? Buffer.from(output) : output, ""));
		return { stdin: { on() {}, end() {} } };
	}) as typeof execFile);
	vi.mocked(spawn).mockImplementation(() => { throw new Error("forbidden spawn attempt"); });
	const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	const artifacts = path.join(root, "artifacts");
	let finalCheck = false;
	let entered!: () => void; const reached = new Promise<void>((resolve) => { entered = resolve; });
	let release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; });
	vi.mocked(promises.writeFile).mockImplementation((async (...args: Parameters<typeof promises.writeFile>) => {
		await actualFs.writeFile(...args);
		if (args[0] === path.join(artifacts, "run-meta.json")) finalCheck = true;
	}) as typeof promises.writeFile);
	vi.mocked(promises.lstat).mockImplementation((async (...args: Parameters<typeof promises.lstat>) => {
		if (finalCheck && args[0] === path.join(home, ".config", "swival", "config.toml")) {
			finalCheck = false; entered(); await barrier;
		}
		return actualFs.lstat(...args);
	}) as typeof promises.lstat);
	const controller = new AbortController();
	const execution = prepareNativeAudit(source, { audit: {} }, { paths: [], all: true, workers: 1, patchMaxTurns: 5 },
		runtime, artifacts, "prelaunch-cancellation", 10_000, controller.signal);
	// Surface early fixture failures instead of hanging at a barrier never reached.
	await Promise.race([reached, execution.then(() => { throw new Error("preparation unexpectedly launched"); })]);
	controller.abort(); release();
	const error = await execution.then(() => undefined, (failure: unknown) => failure);
	expect(spawn, "no launch after the final await observes cancellation").not.toHaveBeenCalled();
	expect(String(error)).toMatch(/cancelled before launch/);
	expect(fs.existsSync(artifacts), "cancelled preparation is cleaned before settling").toBe(false);
}, 15_000);

// Bedrock and Vertex run a host credential CLI before AgentFS exists. The
// credential bridge reports every callback failure as unavailable, so a
// cancellation inside the callback must still surface as cancellation.
it.each((["bedrock", "geap"] as const).flatMap((provider) =>
	(["credential-state", "credential-cli"] as const).map((stage) => [provider, stage] as const)))(
	"surfaces %s cancellation during %s instead of credential unavailability", async (provider, stage) => {
		const root = nativeScratch("native-prelaunch-credential-cancel-"); roots.push(root);
		const source = fixtureRepository(root);
		const bin = path.join(root, "bin"); fs.mkdirSync(bin);
		const tool = provider === "bedrock" ? "aws" : "gcloud";
		const python = path.join(bin, "python"); const cli = path.join(bin, "swival");
		const agentfs = path.join(bin, "agentfs"); const nono = path.join(bin, "nono"); const credentialCli = path.join(bin, tool);
		for (const executable of [python, cli, agentfs, nono, credentialCli]) fs.writeFileSync(executable, `#!${python}\n`, { mode: 0o700 });
		const home = path.join(root, "home");
		const stateRoot = provider === "bedrock" ? path.join(home, ".aws") : path.join(home, ".config", "gcloud");
		fs.mkdirSync(stateRoot, { recursive: true });
		fs.writeFileSync(path.join(stateRoot, "entry"), "# inert\n");
		const runtime = { ...captureNativeRuntime(), python, cli, agentfs, nono, environment: { HOME: home },
			searchPath: [bin, "/usr/bin", "/bin"].join(path.delimiter) };
		const route = { version: 2, runtime: { swival: "1.9.3", litellm: "1.106.6" }, provider, model: "concrete-model",
			endpoint: provider === "bedrock" ? "us-east-2" : null, profile: null, reasoningEffort: null, options: {},
			selection: { profileSource: null, explicitFields: [] }, reportIdentity: { provider, model: "concrete-model" },
			...(provider === "geap" ? { project: "synthetic-project", location: "global" } : {}) };
		const controller = new AbortController();
		const started: string[] = [];
		let entered!: () => void; const reached = new Promise<void>((resolve) => { entered = resolve; });
		const actualChild = await vi.importActual<typeof import("node:child_process")>("node:child_process");
		vi.mocked(execFile).mockImplementation(((exe: string, args: string[], options: any, callback: any) => {
			if (exe === fs.realpathSync(runtime.git!)) return actualChild.execFile(exe, args, options, callback);
			started.push(path.basename(exe));
			if (exe === python) { queueMicrotask(() => callback(null, JSON.stringify(route), "")); return { stdin: { on() {}, end() {} } }; }
			// The host credential CLI only settles once the threaded signal aborts it.
			expect(options.signal, "host credential CLI must receive the launch signal").toBe(controller.signal);
			options.signal.addEventListener("abort", () => callback(new Error("aborted"), Buffer.alloc(0), Buffer.alloc(0)), { once: true });
			entered();
			return { stdin: { on() {}, end() {} } };
		}) as typeof execFile);
		vi.mocked(spawn).mockImplementation(() => { throw new Error("forbidden spawn attempt"); });
		const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		vi.mocked(promises.writeFile).mockImplementation(actualFs.writeFile);
		vi.mocked(promises.lstat).mockImplementation((async (...args: Parameters<typeof promises.lstat>) => {
			// Credential state inspection begins by validating every hop of the state root.
			if (stage === "credential-state" && args[0] === stateRoot) entered();
			return actualFs.lstat(...args);
		}) as typeof promises.lstat);
		const artifacts = path.join(root, "artifacts");
		const execution = prepareNativeAudit(source, { audit: {} }, { paths: [], all: true, workers: 1, patchMaxTurns: 5 },
			runtime, artifacts, "prelaunch-credential-cancellation", 10_000, controller.signal);
		await Promise.race([reached, execution.then(() => { throw new Error("preparation unexpectedly launched"); })]);
		controller.abort();
		const error = await execution.then(() => undefined, (failure: unknown) => failure);
		expect(String(error)).toMatch(/cancelled before launch/);
		expect(String(error)).not.toMatch(/credential is unavailable/);
		expect(started).toEqual(stage === "credential-state" ? ["python"] : ["python", tool]);
		expect(spawn).not.toHaveBeenCalled();
		expect(fs.existsSync(artifacts), "cancelled preparation leaves no artifacts").toBe(false);
	}, 15_000);
