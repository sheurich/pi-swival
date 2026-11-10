import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerExtension, { runSingleSwivalAsync } from "../extensions/index.js";
import type { SwivalAgentConfig } from "../extensions/agents.js";

const evidence = createRequire(import.meta.url)("../scripts/async-evidence.cjs");
const runner = path.resolve(import.meta.dirname, "../scripts/async-runner.cjs");
const report = fs.readFileSync(path.join(import.meta.dirname, "fixtures/report-agentfs-success.json"), "utf8");
const roots: string[] = [];
const scratchLeases: any[] = [];
const scratch = () => { const lease = evidence.createScratch(); scratchLeases.push(lease); return lease; };
function fixture() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swival-evidence-test-")));
	roots.push(root);
	for (const name of ["bin", "artifacts"]) fs.mkdirSync(path.join(root, name));
	const artifacts = path.join(root, "artifacts");
	return { root, artifacts, target: evidence.claimArtifacts(artifacts), bin: path.join(root, "bin") };
}
function fakeSwival(bin: string, body: string) {
	fs.writeFileSync(path.join(bin, "swival"), `#!${process.execPath}\nif (process.argv[2] === "--version") { console.log("1.9.3"); process.exit(0); }\n${body}`, { mode: 0o700 });
}
const writer = `const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (args.includes("--scratch-dir")) throw Error("internal option leaked");
fs.writeFileSync(value("--report"), ${JSON.stringify(report)});
fs.mkdirSync(value("--trace-dir"), {recursive:true});
fs.writeFileSync(path.join(value("--trace-dir"), "session-1.jsonl"), '{"event":"test"}\\n');
console.log("answer");`;
const waitForFile = async (file: string) => {
	const deadline = Date.now() + 5000;
	while (!fs.existsSync(file)) {
		if (Date.now() > deadline) throw Error(`missing fixture file: ${file}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const lease of scratchLeases.splice(0)) evidence.cleanupScratch(lease);
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("async evidence boundary", () => {
	it("exports report and trace before completion, removes scratch, and preserves worker exit", () => {
		const f = fixture(), lease = scratch();
		fakeSwival(f.bin, writer + "\nprocess.exit(7);");
		fs.writeFileSync(path.join(f.artifacts, "unrelated.txt"), "retain");
		const checked = path.join(f.root, "checked-completion.cjs");
		fs.writeFileSync(checked, `const fs = require("node:fs"), assert = require("node:assert/strict"); const rename = fs.renameSync;
fs.renameSync = function(a,b) {
 if (b.endsWith("/completed.json")) {
  assert.equal(fs.readFileSync(${JSON.stringify(path.join(f.artifacts, "report.json"))}, "utf8"), ${JSON.stringify(report)});
  assert(fs.existsSync(${JSON.stringify(path.join(f.artifacts, "trace/session-1.jsonl"))}));
  assert(!fs.existsSync(${JSON.stringify(lease.path)}));
 }
 return rename(a,b);
};
process.argv = [process.execPath, ${JSON.stringify(runner)}, ...process.argv.slice(2)]; require(${JSON.stringify(runner)});`);
		const result = spawnSync(process.execPath, [checked, "--scratch-dir", lease.path, f.artifacts,
			"--report", path.join(lease.path, "report.json"), "--trace-dir", path.join(lease.path, "trace"), "--", "task"], {
			env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` }, timeout: 5000,
		});
		expect(result.status, result.stderr.toString()).toBe(7);
		expect(fs.readFileSync(path.join(f.artifacts, "report.json"), "utf8")).toBe(report);
		expect(fs.readFileSync(path.join(f.artifacts, "trace/session-1.jsonl"), "utf8")).toContain("test");
		expect(fs.readFileSync(path.join(f.artifacts, "unrelated.txt"), "utf8")).toBe("retain");
		expect(JSON.parse(fs.readFileSync(path.join(f.artifacts, "completed.json"), "utf8")).exitCode).toBe(7);
		expect(fs.existsSync(lease.path)).toBe(false);
	});

	it.each(["symlink", "hardlink", "oversize", "directory", "missing"])("rejects %s reports and records only value-free errors", (kind) => {
		const f = fixture(), lease = scratch();
		const source = path.join(lease.path, "report.json"), outside = path.join(f.root, "private-source");
		fs.writeFileSync(outside, "must-not-be-exported");
		if (kind === "symlink") fs.symlinkSync(outside, source);
		if (kind === "hardlink") fs.linkSync(outside, source);
		if (kind === "directory") fs.mkdirSync(source);
		if (kind === "oversize") { fs.writeFileSync(source, ""); fs.truncateSync(source, 16 * 1024 * 1024 + 1); }
		fs.writeFileSync(path.join(f.artifacts, "report.json"), "stale report cannot mask rejection");
		expect(evidence.transferEvidence(lease, f.target)).toContain("report_transfer_failed");
		expect(fs.existsSync(path.join(f.artifacts, "report.json"))).toBe(false);
		expect(fs.readFileSync(outside, "utf8")).toBe("must-not-be-exported");
	});

	it("rejects unsafe trace entries and enforces file and total byte budgets", () => {
		const f = fixture(), lease = scratch();
		fs.writeFileSync(path.join(lease.path, "report.json"), report);
		const trace = path.join(lease.path, "trace"); fs.mkdirSync(trace);
		fs.writeFileSync(path.join(trace, "completed.json"), "not a trace");
		fs.symlinkSync(path.join(lease.path, "report.json"), path.join(trace, "link.jsonl"));
		fs.writeFileSync(path.join(trace, "large.jsonl"), "");
		fs.truncateSync(path.join(trace, "large.jsonl"), 4 * 1024 * 1024 + 1);
		const errors = evidence.transferEvidence(lease, f.target);
		expect(errors).toContain("trace_name_rejected"); expect(errors).toContain("trace_transfer_failed");
		expect(fs.existsSync(path.join(f.artifacts, "completed.json"))).toBe(false);
		fs.rmSync(trace, { recursive: true }); fs.mkdirSync(trace);
		for (let i = 0; i < 17; i++) fs.writeFileSync(path.join(trace, `${i}.jsonl`), "{}");
		expect(evidence.transferEvidence(lease, f.target)).toContain("trace_file_limit");
		fs.rmSync(trace, { recursive: true }); fs.mkdirSync(trace);
		for (let i = 0; i < 16; i++) {
			const file = path.join(trace, `${i}.jsonl`); fs.writeFileSync(file, ""); fs.truncateSync(file, 4 * 1024 * 1024);
		}
		expect(evidence.transferEvidence(lease, f.target)).toContain("trace_byte_limit");
	});

	it("rejects symlinked trace directories and never follows cleanup symlinks", () => {
		const f = fixture(), lease = scratch();
		fs.writeFileSync(path.join(lease.path, "report.json"), report);
		fs.writeFileSync(path.join(f.root, "secret.jsonl"), "private");
		fs.symlinkSync(f.root, path.join(lease.path, "trace"));
		expect(evidence.transferEvidence(lease, f.target)).toContain("trace_directory_rejected");
		expect(evidence.cleanupScratch(lease)).toBeUndefined();
		expect(fs.readFileSync(path.join(f.root, "secret.jsonl"), "utf8")).toBe("private");
	});

	it("refuses arbitrary or replaced scratch roots", () => {
		const f = fixture(), lease = scratch();
		expect(() => evidence.claimScratch(f.root)).toThrow();
		fs.rmdirSync(lease.path); fs.symlinkSync(f.root, lease.path);
		expect(evidence.cleanupScratch(lease)).toBe("scratch_cleanup_failed");
		expect(fs.existsSync(f.root)).toBe(true);
		fs.unlinkSync(lease.path);
	});

	it("a killed exporter cannot expose a torn report or completed marker", () => {
		const f = fixture(), lease = scratch();
		fakeSwival(f.bin, writer);
		const wrapper = path.join(f.root, "interrupt-export.cjs");
		fs.writeFileSync(wrapper, `const fs = require("node:fs"); const rename = fs.renameSync;
fs.renameSync = function(a,b) { if (b.endsWith("/report.json")) process.kill(process.pid, "SIGKILL"); return rename(a,b); };
process.argv = [process.execPath, ${JSON.stringify(runner)}, ...process.argv.slice(2)]; require(${JSON.stringify(runner)});`);
		const result = spawnSync(process.execPath, [wrapper, "--scratch-dir", lease.path, f.artifacts,
			"--report", path.join(lease.path, "report.json"), "--trace-dir", path.join(lease.path, "trace"), "--", "task"], {
			env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` }, timeout: 5000,
		});
		expect(result.signal).toBe("SIGKILL");
		expect(fs.existsSync(path.join(f.artifacts, "report.json"))).toBe(false);
		expect(fs.existsSync(path.join(f.artifacts, "completed.json"))).toBe(false);
		expect(evidence.cleanupScratch(lease)).toBeUndefined();
	});

	it("exports a TERM-trapped worker's final report before completion", async () => {
		const f = fixture(), lease = scratch();
		const ready = path.join(f.root, "ready");
		fakeSwival(f.bin, `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "ready");
process.on("SIGTERM", () => { ${writer}\nprocess.exit(42); }); setInterval(() => {}, 1000);`);
		const proc = spawn(process.execPath, [runner, "--scratch-dir", lease.path, f.artifacts,
			"--report", path.join(lease.path, "report.json"), "--trace-dir", path.join(lease.path, "trace"), "--", "task"], {
			env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` }, stdio: "ignore", detached: true,
		});
		const closed = new Promise((resolve) => proc.once("close", resolve));
		const killGroup = () => { try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* Group already exited. */ } };
		const deadline = setTimeout(killGroup, 5000);
		try {
			await waitForFile(ready); proc.kill("SIGTERM"); await closed;
			expect(JSON.parse(fs.readFileSync(path.join(f.artifacts, "completed.json"), "utf8")).exitCode).toBe(42);
			expect(fs.readFileSync(path.join(f.artifacts, "report.json"), "utf8")).toBe(report);
			expect(fs.existsSync(lease.path)).toBe(false);
		} finally { clearTimeout(deadline); killGroup(); }
	}, 7000);

	it("refuses export from worker-widened scratch but still cleans the owned directory", () => {
		const f = fixture(), lease = scratch();
		fakeSwival(f.bin, writer + '\nfs.chmodSync(path.dirname(value("--report")), 0o755);');
		const result = spawnSync(process.execPath, [runner, "--scratch-dir", lease.path, f.artifacts,
			"--report", path.join(lease.path, "report.json"), "--trace-dir", path.join(lease.path, "trace"), "--", "task"], {
			env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` }, timeout: 5000,
		});
		expect(result.status, result.stderr.toString()).toBe(0);
		expect(fs.readFileSync(path.join(f.artifacts, "report.json"), "utf8")).toBe("");
		expect(fs.readFileSync(path.join(f.artifacts, "transfer-error.txt"), "utf8")).toBe("evidence_transfer_failed\n");
		expect(fs.existsSync(lease.path)).toBe(false);
	});

	it("does not claim or delete an arbitrary scratch directory", () => {
		const f = fixture();
		const result = spawnSync(process.execPath, [runner, "--scratch-dir", f.root, f.artifacts], { timeout: 5000 });
		expect(result.status).toBe(2);
		expect(fs.existsSync(f.root)).toBe(true);
		expect(fs.existsSync(path.join(f.artifacts, "completed.json"))).toBe(false);
	});

	it("reclaims scratch after a runner crash before a completion marker", async () => {
		const f = fixture();
		const leaseFile = path.join(f.root, "scratch-path");
		fakeSwival(f.bin, `const fs = require("node:fs"), path = require("node:path");
fs.writeFileSync(${JSON.stringify(leaseFile)}, path.dirname(process.argv[process.argv.indexOf("--report")+1]));
process.kill(process.ppid, "SIGKILL");`);
		vi.stubEnv("PATH", `${f.bin}:${process.env.PATH}`);
		const agent: SwivalAgentConfig = { name: "crash", description: "test", source: "user", filePath: "fixture.md", systemPrompt: "", sandbox: "agentfs" };
		const started = await runSingleSwivalAsync(f.root, [agent], agent.name, "task", undefined, {}, f.artifacts);
		await waitForFile(leaseFile);
		const directory = fs.readFileSync(leaseFile, "utf8");
		await vi.waitFor(() => expect(fs.existsSync(directory)).toBe(false), { timeout: 3000 });
		expect(fs.existsSync(path.join(started.artifactDir, "completed.json"))).toBe(false);
	});

	it("status and resume reject a zero-exit worker with no bootstrap report", async () => {
		const f = fixture(); fakeSwival(f.bin, 'console.log("no report");');
		vi.stubEnv("PATH", `${f.bin}:${process.env.PATH}`);
		const agent: SwivalAgentConfig = { name: "missing", description: "test", source: "user", filePath: "fixture.md", systemPrompt: "", sandbox: "agentfs" };
		const started = await runSingleSwivalAsync(f.root, [agent], agent.name, "task", undefined, {}, f.artifacts);
		await waitForFile(path.join(started.artifactDir, "completed.json"));
		let tool: any; registerExtension({ registerTool: (value: any) => { tool = value; } } as any, { artifactRoot: f.artifacts });
		for (const action of ["status", "resume"]) {
			await vi.waitFor(async () => {
				const result = await tool.execute("missing", { action, id: started.runId }, undefined, undefined, { cwd: f.root, hasUI: false });
				expect(result.content[0].text).not.toMatch(/still running/);
				expect(result.isError).toBe(true);
				expect(result.content[0].text).toMatch(/failed AgentFS bootstrap/);
			}, { timeout: 3000 });
		}
	});

	it("cleans scratch when setup fails before spawn", async () => {
		const f = fixture(); fakeSwival(f.bin, writer);
		vi.stubEnv("TMPDIR", f.root); vi.stubEnv("PATH", `${f.bin}:${process.env.PATH}`);
		const write = fs.promises.writeFile.bind(fs.promises);
		vi.spyOn(fs.promises, "writeFile").mockImplementation(async (file, data, ...rest) => {
			if (String(file).endsWith("task.txt")) throw new Error("fixture pre-spawn failure");
			return write(file, data, ...rest);
		});
		const agent: SwivalAgentConfig = { name: "setup-failure", description: "test", source: "user", filePath: "fixture.md", systemPrompt: "", sandbox: "builtin" };
		await expect(runSingleSwivalAsync(f.root, [agent], agent.name, "task", undefined, {}, f.artifacts)).rejects.toThrow("fixture pre-spawn failure");
		expect(fs.readdirSync(f.root).filter((name) => name.startsWith("pi-swival-async-"))).toEqual([]);
	});

	it("retains an explicit trace destination instead of claiming to export it", async () => {
		const f = fixture(); fakeSwival(f.bin, writer); vi.stubEnv("PATH", `${f.bin}:${process.env.PATH}`);
		const traceDir = path.join(f.root, "caller-trace");
		const agent: SwivalAgentConfig = { name: "custom-trace", description: "test", source: "user", filePath: "fixture.md", systemPrompt: "", sandbox: "builtin" };
		const started = await runSingleSwivalAsync(f.root, [agent], agent.name, "task", undefined, { traceDir }, f.artifacts);
		await waitForFile(path.join(started.artifactDir, "completed.json"));
		expect(fs.existsSync(path.join(traceDir, "session-1.jsonl"))).toBe(true);
		expect(fs.existsSync(path.join(started.artifactDir, "trace"))).toBe(false);
		expect(fs.readFileSync(path.join(started.artifactDir, "report.json"), "utf8")).toBe(report);
	});

	it("production status/resume see exported bootstrap evidence without persisting a scratch path or granting artifacts", async () => {
		const f = fixture(); fakeSwival(f.bin, writer);
		vi.stubEnv("PATH", `${f.bin}:${process.env.PATH}`);
		const agent: SwivalAgentConfig = { name: "fixture", description: "test", source: "user", filePath: "fixture.md", systemPrompt: "", sandbox: "agentfs" };
		const result = await runSingleSwivalAsync(f.root, [agent], "fixture", "task", undefined, {}, f.artifacts);
		await waitForFile(path.join(result.artifactDir, "completed.json"));
		const meta = JSON.parse(fs.readFileSync(path.join(result.artifactDir, "run-meta.json"), "utf8"));
		expect(meta.scratch).toBeUndefined(); expect(meta.scratchDir).toBeUndefined();
		let tool: any; registerExtension({ registerTool: (value: any) => { tool = value; } } as any, { artifactRoot: f.artifacts });
		for (const action of ["status", "resume"]) {
			await vi.waitFor(async () => {
				const response = await tool.execute("fixture", { action, id: result.runId }, undefined, undefined, { cwd: f.root, hasUI: false });
				expect(response.content[0].text).not.toMatch(/still running/);
				expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
				expect(response.content[0].text).not.toMatch(/failed.*bootstrap/);
			}, { timeout: 3000 });
		}
	});
});
