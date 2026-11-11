import { expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import registerExtension, { runSingleSwivalAsync } from "../extensions/index.js";
import type { SwivalAgentConfig } from "../extensions/agents.js";

it("exports ordinary async evidence through actual TMPDIR under real AgentFS without an artifact-root grant", async () => {
	const candidates = (process.env.PATH ?? "").split(path.delimiter).filter(path.isAbsolute).map((dir) => path.join(dir, "agentfs"));
	const agentfs = candidates.find((file) => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
	expect(agentfs, "Real AgentFS is required for this integration gate").toBeDefined();
	const temporary = path.resolve(import.meta.dirname, ".scratch/tmp");
	fs.mkdirSync(temporary, { recursive: true });
	expect(fs.realpathSync(temporary)).toBe(temporary);
	const root = fs.mkdtempSync(path.join(temporary, "async-real-agentfs-"));
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
		const completed = path.join(started.artifactDir, "completed.json");
		const deadline = Date.now() + 25000;
		while (!fs.existsSync(completed)) {
			if (Date.now() > deadline) throw new Error("ordinary AgentFS export timed out");
			await new Promise((resolve) => setTimeout(resolve, 30));
		}
		const stderr = fs.readFileSync(path.join(started.artifactDir, "stderr.txt"), "utf8");
		expect(JSON.parse(fs.readFileSync(completed, "utf8")).exitCode, stderr).toBe(0);
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
