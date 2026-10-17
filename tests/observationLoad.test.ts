import { expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

it("observationLoad: Pi loads the exact README wrapper with selected local packages offline", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swival-observation-load-")));
	const cwd = path.join(root, "project");
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".pi", "agent");
	const consumer = path.join(root, "selected-pi-subagents");
	for (const dir of [cwd, agentDir, consumer]) fs.mkdirSync(dir, { recursive: true });
	const section = fs.readFileSync(path.join(packageRoot, "README.md"), "utf8")
		.split("### Optional async observation\n")[1]!.split("\n### Skills")[0]!;
	const wrapper = section.match(/```typescript\n([\s\S]*?)\n```/)![1]!;
	const settings = JSON.parse(section.match(/```json\n([\s\S]*?)\n```/)![1]!);
	expect(settings.packages).toEqual([
		{ source: "https://github.com/sheurich/pi-swival", extensions: [] }, "npm:pi-subagents",
	]);
	expect(settings.extensions).toEqual(["./swival-observation/index.ts"]);
	const wrapperPath = path.resolve(agentDir, settings.extensions[0]);
	const modules = path.join(path.dirname(wrapperPath), "node_modules");
	fs.mkdirSync(modules, { recursive: true });
	fs.symlinkSync(packageRoot, path.join(modules, "pi-swival"));
	fs.symlinkSync(consumer, path.join(modules, "pi-subagents"));
	fs.writeFileSync(wrapperPath, wrapper);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
	fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({
		name: "pi-subagents", type: "module", exports: {
			"./external-runs": "./api.js", "./background-work": "./api.js",
		},
	}));
	const callsFile = path.join(root, "public-api-calls.jsonl");
	// A public-contract fixture, not an installed consumer dependency or registry.
	fs.writeFileSync(path.join(consumer, "api.js"), [
		'import * as fs from "node:fs";',
		`const record = (event) => fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(event) + "\\n");`,
		'export function registerExternalRun(run) { record({ type: "run", run }); return run; }',
		'export function updateExternalRun() { throw new Error("Unexpected fixture update"); }',
		'export function unregisterExternalRun(sessionId, id) { record({ type: "unregister", sessionId, id }); return true; }',
		'export function registerBackgroundWorkProvider(provider) {',
		'  record({ type: "provider", name: provider.name, channels: provider.wakeChannels });',
		'  return () => record({ type: "dispose" });',
		'}',
	].join("\n"));
	const owner = "11111111-1111-4111-8111-111111111111";
	const sessionFile = path.join(root, "synthetic-session.jsonl");
	const artifactDir = path.join(agentDir, "swival-artifacts", "synthetic-run");
	fs.mkdirSync(artifactDir, { recursive: true });
	fs.writeFileSync(path.join(artifactDir, "run-meta.json"), JSON.stringify({
		runId: "synthetic-run", agent: "synthetic", startedAt: 1000, artifactDir,
		ownerSessionId: owner, ownerSessionFile: sessionFile,
	}));
	fs.writeFileSync(path.join(artifactDir, "completed.json"), JSON.stringify({
		exitCode: 0, exitedAt: "2026-01-01T00:00:00.000Z",
	}));
	fs.writeFileSync(path.join(artifactDir, "report.json"), JSON.stringify({ result: { outcome: "success" } }));
	const childProcess = createRequire(import.meta.url)("node:child_process") as
		typeof import("node:child_process");
	const launches: string[] = [];
	const restore: Array<() => void> = [];
	const block = (method: string) => () => {
		launches.push(method); throw new Error(`observationLoad blocked ${method}`);
	};
	let shutdown: (() => Promise<void>) | undefined;
	try {
		for (const method of [
			"spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork",
		] as const) {
			const spy = vi.spyOn(childProcess, method).mockImplementation(block(method));
			restore.push(() => spy.mockRestore());
		}
		const spawn = vi.spyOn(childProcess.ChildProcess.prototype, "spawn")
			.mockImplementation(block("ChildProcess.spawn"));
		restore.push(() => spawn.mockRestore());
		// Worker threads keep the native home separate from their scoped environment stub.
		const nativeOs = createRequire(import.meta.url)("node:os") as typeof import("node:os");
		const homedir = vi.spyOn(nativeOs, "homedir").mockReturnValue(home);
		restore.push(() => homedir.mockRestore());
		syncBuiltinESMExports();
		vi.stubEnv("HOME", home);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_PACKAGE_DIR", undefined);
		vi.stubEnv("JITI_FS_CACHE", path.join(root, "jiti-cache"));
		vi.stubEnv("PI_OFFLINE", "1");
		const { discoverAndLoadExtensions, getAgentDir } = await import("@earendil-works/pi-coding-agent");
		expect(getAgentDir()).toBe(agentDir);
		const loaded = await discoverAndLoadExtensions([wrapperPath], cwd, agentDir);
		expect(loaded.errors).toEqual([]);
		if ("warnings" in loaded) expect(loaded.warnings).toEqual([]);
		expect(loaded.extensions.map((extension) => extension.resolvedPath)).toEqual([wrapperPath]);
		const extension = loaded.extensions[0]!;
		expect([...extension.tools.keys()]).toEqual(["swival-subagent"]);
		expect(fs.existsSync(callsFile)).toBe(false);
		const ctx: any = { cwd, hasUI: false, sessionManager: {
			getSessionId: () => owner, getSessionFile: () => sessionFile,
		} };
		shutdown = async () => {
			for (const handler of extension.handlers.get("session_shutdown") ?? []) {
				await handler({ type: "session_shutdown" }, ctx);
			}
		};
		for (const handler of extension.handlers.get("session_start") ?? []) {
			await handler({ type: "session_start" }, ctx);
		}
		await shutdown();
		const calls = fs.readFileSync(callsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(calls).toEqual([
			{ type: "provider", name: "pi-swival", channels: ["pi-swival:async-observation"] },
			{ type: "run", run: expect.objectContaining({
				id: "synthetic-run", sessionId: sessionFile, source: "swival", state: "completed",
			}) },
			{ type: "dispose" },
			{ type: "unregister", sessionId: sessionFile, id: "synthetic-run" },
		]);
		expect(launches).toEqual([]);
	} finally {
		await shutdown?.();
		for (const undo of restore.reverse()) undo();
		syncBuiltinESMExports();
		vi.unstubAllEnvs();
		fs.rmSync(root, { recursive: true, force: true });
	}
}, 15000);
