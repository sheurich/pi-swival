import { expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import registerExtension, { runSingleSwivalAsync } from "../extensions/index.js";
import type { SwivalAgentConfig } from "../extensions/agents.js";
import { nativeTestPython } from "./nativePython.js";

function realAgentfs(): string {
	const candidates = (process.env.PATH ?? "").split(path.delimiter).filter(path.isAbsolute).map((dir) => path.join(dir, "agentfs"));
	const agentfs = candidates.find((file) => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
	expect(agentfs, "Real AgentFS is required for this integration gate").toBeDefined();
	return fs.realpathSync(agentfs!);
}

function scratchRoot(prefix: string): string {
	const temporary = path.resolve(import.meta.dirname, ".scratch/tmp");
	fs.mkdirSync(temporary, { recursive: true });
	expect(fs.realpathSync(temporary)).toBe(temporary);
	return fs.mkdtempSync(path.join(temporary, prefix));
}

async function awaitCompleted(artifactDir: string, timeoutMs: number): Promise<{ exitCode: number | null }> {
	const completed = path.join(artifactDir, "completed.json");
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(completed)) {
		if (Date.now() > deadline) throw new Error("AgentFS evidence export timed out");
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	return JSON.parse(fs.readFileSync(completed, "utf8"));
}

it("exports ordinary async evidence through actual TMPDIR under real AgentFS without an artifact-root grant", async () => {
	const agentfs = realAgentfs();
	const root = scratchRoot("async-real-agentfs-");
	const base = path.join(root, "base"), artifacts = path.join(root, "artifacts"), bin = path.join(root, "bin"), home = path.join(root, "home");
	for (const dir of [base, artifacts, bin, home]) fs.mkdirSync(dir);
	const session = `async-evidence-${randomBytes(16).toString("hex")}`;
	const originalTmp = process.env.TMPDIR;
	const canonicalTmp = fs.realpathSync(os.tmpdir());
	const worker = path.join(root, "writer.cjs");
	const forbidden = path.join(artifacts, "unexported.txt");
	fs.writeFileSync(worker, `const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
assert.equal(process.env.AGENTFS, "1");
const args = process.argv.slice(2), value = (flag) => args[args.indexOf(flag)+1];
assert.equal(process.env.PI_SWIVAL_EVIDENCE_DIR, path.dirname(value("--report")));
assert.equal(process.env.TMPDIR, ${JSON.stringify(originalTmp)});
assert(!args.includes("--scratch-dir"));
try { fs.writeFileSync(${JSON.stringify(forbidden)}, "must not reach host"); } catch { }
fs.writeFileSync(value("--report"), JSON.stringify({version:1, sandbox:{mode:"agentfs",agentfs_version:"0.6.4"}, result:{outcome:"success", answer:"offline async evidence", exit_code:0}}));
fs.writeFileSync(path.join(value("--trace-dir"), "offline-session.jsonl"), JSON.stringify({event: "offline", report: value("--report"), trace: value("--trace-dir")}) + '\\n');
console.log("offline async evidence");`);
	fs.writeFileSync(path.join(bin, "swival"), `#!${process.execPath}
import { spawnSync } from "node:child_process";
if (process.argv[2] === "--version") { console.log("1.9.3"); process.exit(0); }
const evidenceAllow = process.env.PI_SWIVAL_EVIDENCE_DIR ? ['--allow', process.env.PI_SWIVAL_EVIDENCE_DIR] : [];
const result = spawnSync(${JSON.stringify(agentfs)}, ["run", "--no-default-allows", "--allow", ${JSON.stringify(base)}, "--session", ${JSON.stringify(session)}, ...evidenceAllow, "--", process.execPath, ${JSON.stringify(worker)}, ...process.argv.slice(2)], {stdio:"inherit", timeout:20000});
process.exit(result.status ?? 1);`, { mode: 0o700 });
	vi.stubEnv("HOME", home);
	vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
	let tool: any;
	registerExtension({ registerTool: (value: any) => { tool = value; } } as any, { artifactRoot: artifacts });
	let runId: string | undefined;
	try {
		const agent: SwivalAgentConfig = { name: "real-agentfs", description: "offline fixture", source: "user", filePath: "fixture.md", systemPrompt: "", sandbox: "agentfs", noSandboxAutoSession: true };
		const started = await runSingleSwivalAsync(base, [agent], agent.name, "offline task", undefined, {}, artifacts);
		runId = started.runId;
		const completed = await awaitCompleted(started.artifactDir, 25000);
		const stderr = fs.readFileSync(path.join(started.artifactDir, "stderr.txt"), "utf8");
		expect(completed.exitCode, stderr).toBe(0);
		const paths = JSON.parse(fs.readFileSync(path.join(started.artifactDir, "trace/offline-session.jsonl"), "utf8"));
		expect(paths.event).toBe("offline");
		expect(path.dirname(path.dirname(paths.report))).toBe(canonicalTmp);
		expect(fs.existsSync(path.dirname(paths.report))).toBe(false);
		expect(fs.existsSync(forbidden)).toBe(false);
		for (const action of ["status", "resume"]) {
			await vi.waitFor(async () => {
				const result = await tool.execute("offline", { action, id: runId }, undefined, undefined, { cwd: base, hasUI: false });
				expect(result.content[0].text).not.toMatch(/still running/);
				expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
			}, { timeout: 3000 });
		}
	} finally {
		if (runId) await tool.execute("cleanup", { action: "interrupt", id: runId }, undefined, undefined, { cwd: base, hasUI: false });
		vi.unstubAllEnvs();
		fs.rmSync(root, { recursive: true, force: true });
	}
}, 35000);

// Real pinned Swival bootstraps itself under real AgentFS. Only the model is
// replaced, by Swival's own `command` provider; the shim on PYTHONPATH must
// add the evidence grant to Swival's AgentFS argv so the report and trace
// Swival writes inside the sandbox reach host artifacts.
it("exports report and trace from a real Swival AgentFS re-exec through the evidence grant", async () => {
	const agentfs = realAgentfs();
	const root = scratchRoot("async-real-swival-agentfs-");
	const base = path.join(root, "base"), artifacts = path.join(root, "artifacts"), bin = path.join(root, "bin"), home = path.join(root, "home");
	const config = path.join(home, ".config");
	for (const dir of [base, artifacts, bin, path.join(config, "swival"), path.join(home, ".cache")]) fs.mkdirSync(dir, { recursive: true });
	const session = `async-real-swival-${randomBytes(16).toString("hex")}`;
	const recordedArgv = path.join(root, "agentfs-run-argv.txt");
	// Pass-through recorder: Swival resolves `agentfs` from PATH, so capture the
	// `run` argv it built before the real binary takes over the process.
	fs.writeFileSync(path.join(bin, "agentfs"), `#!/bin/sh
if [ "$1" = run ]; then printf '%s\\n' "$@" > ${JSON.stringify(recordedArgv)}; fi
exec ${JSON.stringify(agentfs)} "$@"
`, { mode: 0o700 });
	const answer = path.join(root, "answer.sh");
	fs.writeFileSync(answer, "#!/bin/sh\ncat >/dev/null\nprintf 'offline async evidence\\n'\n", { mode: 0o700 });
	// An unrelated quoted key must not make the conservative TOML reader drop the grant.
	fs.writeFileSync(path.join(config, "swival", "config.toml"), '"max_context_tokens" = 128000\n');
	vi.stubEnv("HOME", home);
	vi.stubEnv("XDG_CONFIG_HOME", config);
	vi.stubEnv("XDG_CACHE_HOME", path.join(home, ".cache"));
	vi.stubEnv("LITELLM_LOCAL_MODEL_COST_MAP", "True");
	vi.stubEnv("PATH", [bin, path.dirname(nativeTestPython), process.env.PATH].join(path.delimiter));
	let tool: any;
	registerExtension({ registerTool: (value: any) => { tool = value; } } as any, { artifactRoot: artifacts });
	let runId: string | undefined;
	try {
		const agent: SwivalAgentConfig = { name: "real-swival-agentfs", description: "offline command-provider fixture", source: "user",
			filePath: "fixture.md", systemPrompt: "", provider: "command", model: answer, sandbox: "agentfs", sandboxSession: session,
			commands: "none", noInstructions: true, noSkills: true };
		const started = await runSingleSwivalAsync(base, [agent], agent.name, "offline task", undefined, {}, artifacts);
		runId = started.runId;
		const completed = await awaitCompleted(started.artifactDir, 50000);
		const stderr = fs.readFileSync(path.join(started.artifactDir, "stderr.txt"), "utf8");
		expect(completed.exitCode, stderr).toBe(0);
		const report = JSON.parse(fs.readFileSync(path.join(started.artifactDir, "report.json"), "utf8"));
		expect(report.sandbox?.mode, stderr).toBe("agentfs");
		expect(report.result).toMatchObject({ outcome: "success", answer: expect.stringContaining("offline async evidence") });
		const traces = fs.readdirSync(path.join(started.artifactDir, "trace")).filter((name) => name.endsWith(".jsonl"));
		expect(traces, stderr).not.toHaveLength(0);
		const runArgv = fs.readFileSync(recordedArgv, "utf8").split("\n");
		const boundary = runArgv.indexOf("--");
		expect(boundary).toBeGreaterThan(0);
		const allowed = runArgv.slice(0, boundary).flatMap((value, index, argv) => (value === "--allow" ? [argv[index + 1]] : []));
		const evidenceDir = path.dirname(runArgv[runArgv.indexOf("--report") + 1]);
		expect(allowed, "Swival's AgentFS argv must carry the evidence grant").toContain(evidenceDir);
		expect(path.dirname(evidenceDir)).toBe(fs.realpathSync(os.tmpdir()));
		expect(allowed).not.toContain(artifacts);
		expect(runArgv.slice(0, boundary)).toContain(session);
		expect(fs.existsSync(evidenceDir), "scratch evidence is removed after export").toBe(false);
		expect(execFileSync(agentfs, ["ps"], { encoding: "utf8", timeout: 10_000 })).not.toContain(session);
		// completed.json can land slightly before the runner's close event is observed.
		for (const action of ["status", "resume"]) {
			await vi.waitFor(async () => {
				const result = await tool.execute("offline", { action, id: runId }, undefined, undefined, { cwd: base, hasUI: false });
				expect(result.content[0].text).not.toMatch(/still running/);
				expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
			}, { timeout: 3000 });
		}
	} finally {
		if (runId) await tool.execute("cleanup", { action: "interrupt", id: runId }, undefined, undefined, { cwd: base, hasUI: false });
		vi.unstubAllEnvs();
		fs.rmSync(root, { recursive: true, force: true });
	}
}, 90000);
