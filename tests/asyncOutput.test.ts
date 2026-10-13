import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import registerExtension, { resetSwivalVersionCache } from "../extensions/index.js";

const outputFiles = createRequire(import.meta.url)("../scripts/output-file.cjs");
const runner = fileURLToPath(new URL("../scripts/async-runner.cjs", import.meta.url));
const committer = fileURLToPath(new URL("../scripts/output-committer.cjs", import.meta.url));

const roots: string[] = [];
const originalPath = process.env.PATH;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalNodeOptions = process.env.NODE_OPTIONS;
const originalRaceConfig = process.env.PI_ASYNC_OUTPUT_RACE_CONFIG;
const processGroups: number[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const processAlive = (pid: number) => {
	try { process.kill(pid, 0); return true; } catch { return false; }
};
const waitForExit = async (pid: number, timeoutMs = 3000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && processAlive(pid)) await sleep(10);
	expect(processAlive(pid), `fixture process ${pid} must exit`).toBe(false);
};
const hashFile = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// These fixed fixtures run only Node, never caller task text as a command.
// The toggler is a real worker child, with bounded time and no output streams.
const directoryToggleFixture = `
"use strict";
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.length !== 3) process.exit(2);
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const { root, directory, swap, moved, outside, outsideDirectory, phase } = config;
if (!["rename", "cleanup", "stress"].includes(phase) ||
    [directory, swap, moved, outside, outsideDirectory].some(p => !p.startsWith(root + path.sep))) process.exit(2);
const marker = name => path.join(root, name);
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
let swapped = false;
let cycles = 0;
function replace() {
  fs.renameSync(swap, moved);
  fs.symlinkSync(outside, swap, "dir");
  swapped = true;
  cycles++;
}
function restore() {
  if (!swapped) return;
  fs.unlinkSync(swap);
  fs.renameSync(moved, swap);
  swapped = false;
}
fs.writeFileSync(marker("toggler-pid"), String(process.pid));
const temporary = fs.readdirSync(directory).find(name => name.startsWith(".tmp-output-"));
fs.writeFileSync(path.join(outsideDirectory, temporary), "OUTSIDE_TEMP_UNCHANGED");
fs.writeFileSync(marker("outside-temporary"), temporary);
const deadline = Date.now() + 2500;
try {
  // First attack while Swival is running. Then force a lookup interleaving
  // at rename/unlink so the regression does not depend on scheduler luck.
  const attackUntil = Date.now() + 80;
  fs.writeFileSync(marker("race-active"), "active");
  while (Date.now() < attackUntil || (phase === "stress" && Date.now() < deadline && !fs.existsSync(marker("stop-race")))) {
    replace();
    pause();
    restore();
    pause();
  }
  fs.writeFileSync(marker("race-ready"), "ready");
  while (Date.now() < deadline && !fs.existsSync(marker("stop-race"))) {
    if (fs.existsSync(marker("lookup-trigger"))) {
      replace();
      fs.writeFileSync(marker("lookup-swapped"), "swapped");
      while (Date.now() < deadline && !fs.existsSync(marker("stop-race"))) pause();
      break;
    }
    pause();
  }
} finally {
  restore();
  fs.writeFileSync(marker("race-stopped"), JSON.stringify({ cycles, pid: process.pid }));
}
`;

// The preload only schedules the real child at a specific filesystem lookup.
// It forwards the production paths unchanged, including relative basenames.
const lookupInterleavingFixture = `
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const role = path.basename(process.argv[1] || "");
if (["async-runner.cjs", "output-committer.cjs"].includes(role)) {
  const config = JSON.parse(fs.readFileSync(process.env.PI_ASYNC_OUTPUT_RACE_CONFIG, "utf8"));
  if (!path.isAbsolute(config.root) || !["rename", "cleanup", "stress", "mode", "leaf", "replacement", "relocated", "dispatch-after", "observe",
       "helper-eof", "helper-write-fail", "helper-startup-fail", "helper-ready-timeout", "helper-control-overflow",
       "helper-early-terminal-written", "helper-early-terminal-discarded", "helper-stdout-eof"].includes(config.phase)) process.exit(2);
  if (config.phase === "dispatch-after" &&
      [config.dispatch, config.movedDispatch].some(p => !p.startsWith(config.root + path.sep))) process.exit(2);
  const marker = name => path.join(config.root, name);
  if (role === "output-committer.cjs") {
    fs.writeFileSync(marker("committer-started"), JSON.stringify({ pid: process.pid,
      identity: { dev: fs.lstatSync(".").dev, ino: fs.lstatSync(".").ino } }));
    if (config.phase === "helper-eof") {
      const deadline = Date.now() + 2000;
      const timer = setInterval(() => {
        if (fs.existsSync(marker("worker-started")) || Date.now() >= deadline) {
          clearInterval(timer);
          process.stdin.emit("end");
        }
      }, 10);
    }
    if (config.phase === "helper-startup-fail") {
      const fstat = fs.fstatSync;
      fs.fstatSync = fd => { if (fd === 3) throw new Error("injected committer startup failure"); return fstat(fd); };
    }
    if (["helper-ready-timeout", "helper-control-overflow"].includes(config.phase)) {
      const write = fs.writeSync;
      fs.writeSync = (fd, data, ...rest) => {
        if (fd === 1 && String(data).includes('"status":"ready"')) {
          if (config.phase === "helper-control-overflow") write(1, Buffer.alloc(65537, "x"));
          return Buffer.byteLength(data);
        }
        return write(fd, data, ...rest);
      };
    }
  }
  if (role === "output-committer.cjs" && ["helper-early-terminal-written", "helper-early-terminal-discarded"].includes(config.phase)) {
    // Replace the fixed helper's input listeners only in this test fixture: it
    // emits a plausible terminal response before the runner transfers its
    // empty body, then consumes that frame and exits without materializing.
    const on = process.stdin.on.bind(process.stdin);
    process.stdin.on = (event, listener) => {
      if (["data", "end", "error"].includes(event)) return process.stdin;
      return on(event, listener);
    };
    const binding = JSON.parse(fs.readFileSync(4, "utf8")).binding;
    const write = fs.writeSync;
    fs.writeSync = (fd, data, ...rest) => {
      const result = write(fd, data, ...rest);
      if (fd === 1 && String(data).includes('"status":"ready"')) {
        write(1, JSON.stringify(config.phase.endsWith("discarded") ? { status: "discarded" } :
          { status: "written", outputPath: binding.outputPath, outputBytes: 0, outputLineCount: 0 }) + "\\n");
      }
      return result;
    };
    let receivedInput = false;
    on("data", () => { receivedInput = true; process.stdin.resume(); });
    on("end", () => {
      if (receivedInput) process.exit(0);
      try { fs.closeSync(3); } catch {}
      try { fs.unlinkSync(path.basename(binding.temporary)); } catch {}
      process.exit(1);
    });
  }
  if (role === "output-committer.cjs" && config.phase === "helper-stdout-eof") {
    const write = fs.writeSync;
    fs.writeSync = (fd, data, ...rest) => {
      const result = write(fd, data, ...rest);
      if (fd === 1 && String(data).includes('"status":"ready"')) {
        const timer = setInterval(() => {
          if (fs.existsSync(marker("worker-started"))) {
            clearInterval(timer);
            process.stdout.end();
            const keepAlive = setInterval(() => {}, 1000);
            process.on("SIGTERM", () => clearInterval(keepAlive));
          }
        }, 10);
      }
      return result;
    };
  }
  if (role === "async-runner.cjs" && config.phase === "dispatch-after") {
    const childProcess = require("node:child_process");
    const spawn = childProcess.spawn;
    childProcess.spawn = (executable, args, options) => {
      if (executable === "swival") {
        fs.renameSync(config.dispatch, config.movedDispatch);
        fs.mkdirSync(config.dispatch);
        fs.writeFileSync(path.join(config.dispatch, "worker-relative.txt"), "REPLACEMENT_UNCHANGED");
        fs.writeFileSync(marker("dispatch-replaced"), "replaced");
      }
      return spawn(executable, args, options);
    };
  }
  let triggered = false;
  function interleave() {
    triggered = true;
    fs.writeFileSync(marker("lookup-trigger"), "trigger");
    const deadline = Date.now() + 1500;
    while (!fs.existsSync(marker("lookup-swapped"))) {
      if (Date.now() >= deadline) throw new Error("fixture lookup interleaving timed out");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (path.basename(String(source)).startsWith(".tmp-output-") && path.basename(String(target)) === "out.txt") {
      if (config.phase === "rename" && !triggered) interleave();
      if (config.phase === "helper-write-fail") throw new Error("injected committer rename failure");
      const result = rename(source, target);
      if (config.phase === "mode") fs.chmodSync(target, 0o644);
      if (config.phase === "relocated") {
        rename(target, source);
        fs.writeFileSync(marker("relocated-temp"), path.resolve(source));
        fs.writeFileSync(target, "replacement-marker", { mode: 0o600 });
      }
      if (config.phase === "replacement") {
        unlink(target);
        fs.writeFileSync(target, "replacement-marker", { mode: 0o600 });
      }
      if (config.phase === "leaf") {
        unlink(target);
        fs.symlinkSync(path.join(config.outsideDirectory, "out.txt"), target);
      }
      return result;
    }
    return rename(source, target);
  };
  const unlink = fs.unlinkSync;
  fs.unlinkSync = target => {
    if (config.phase === "relocated" && path.basename(String(target)).startsWith(".tmp-output-")) {
      fs.writeFileSync(marker("post-publication-temp-unlink"), "attempted");
    }
    if (["mode", "leaf", "replacement"].includes(config.phase) && path.basename(String(target)) === "out.txt") {
      fs.writeFileSync(marker("target-unlink-attempt"), "attempted");
    }
    if (config.phase === "cleanup" && !triggered && path.basename(String(target)).startsWith(".tmp-output-")) interleave();
    return unlink(target);
  };
}
`;

const waitFor = async (file: string, timeoutMs = 5000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(file)) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${file}`);
};

function makeFixture() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-async-output-")));
	roots.push(root);
	const bin = path.join(root, "bin");
	const dispatchCwd = path.join(root, "dispatch");
	const piCwd = path.join(root, "pi-cwd");
	const artifactRoot = path.join(root, "artifacts");
	fs.mkdirSync(bin);
	fs.mkdirSync(dispatchCwd);
	fs.mkdirSync(piCwd);
	fs.mkdirSync(artifactRoot);
	const fakeSwival = path.join(bin, "swival");
	fs.writeFileSync(fakeSwival, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("1.0.46"); process.exit(0); }
const reportAt = args.lastIndexOf("--report");
const report = reportAt >= 0 ? args[reportAt + 1] : undefined;
const path = require("node:path");
const root = path.join(__dirname, "..");
fs.writeFileSync(path.join(root, "worker-started"), JSON.stringify({ pid: process.pid, cwd: process.cwd(),
  identity: { dev: fs.lstatSync(".").dev, ino: fs.lstatSync(".").ino }, args }));
fs.writeFileSync("worker-relative.txt", "ORIGINAL_WORKER_WRITE");
const lastArg = args[args.length - 1];
const task = lastArg === "--" ? fs.readFileSync(0, "utf8") : lastArg || "";
if (task.includes("ignore-term")) process.on("SIGTERM", () => {});
const race = task.includes("directory-race");
if (race) {
  const { spawn } = require("node:child_process");
  spawn(process.execPath, [path.join(__dirname, "directory-toggle.cjs"), path.join(root, "race-config.json")],
    { cwd: root, shell: false, stdio: "ignore", timeout: 3000 });
}
const delay = task.includes("ignore-term") ? 2500 : task.includes("delay-output") ? 250 : 20;
const deadline = Date.now() + 2000;
function complete() {
  if (race && !fs.existsSync(path.join(root, task.includes("stress-race") ? "race-active" : "race-ready"))) {
    if (Date.now() >= deadline) process.exit(2);
    setTimeout(complete, 5);
    return;
  }
  if (task.includes("missing-report")) { /* no terminal evidence */ }
  else if (task.includes("malformed-report")) fs.writeFileSync(report, "{");
  else {
    const failed = task.includes("failed-outcome") || task.includes("review-rejected");
    const successWithBadExit = task.includes("bad-result-exit");
    const selfReview = args.includes("--self-review");
    const answer = task.includes("whitespace-answer") ? " \\n\\t " : task.includes("empty-answer") ? "" : "ASYNC_OUTPUT_FIXTURE";
    fs.writeFileSync(report, JSON.stringify({
      result: { outcome: failed ? "failed" : "success", answer: failed ? "PARTIAL_MUST_NOT_EXPORT" : answer, exit_code: successWithBadExit ? 4 : 0 },
      settings: { self_review: selfReview },
      timeline: selfReview ? [{ type: "review", exit_code: task.includes("review-rejected") ? 1 : 0 }] : [],
      sandbox: args.includes("agentfs") ? { mode: "agentfs" } : undefined
    }));
  }
  const stdout = task.includes("empty-stdout") ? "" : task.includes("whitespace-answer") || task.includes("empty-answer")
    ? "STDOUT_ONLY_MUST_NOT_INLINE" : "ASYNC_OUTPUT_FIXTURE";
  process.stdout.write(task.includes("failed-outcome") ? "PARTIAL_MUST_NOT_EXPORT" : stdout);
  process.exit(task.includes("nonzero-exit") ? 7 : 0);
}
setTimeout(complete, delay);
`, { mode: 0o755 });
	fs.writeFileSync(path.join(bin, "directory-toggle.cjs"), directoryToggleFixture);
	fs.writeFileSync(path.join(bin, "lookup-interleaving.cjs"), lookupInterleavingFixture);
	process.env.PATH = `${bin}:${originalPath ?? ""}`;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent-home");
	const userAgents = path.join(process.env.PI_CODING_AGENT_DIR, "swival-agents");
	fs.mkdirSync(userAgents, { recursive: true });
	fs.writeFileSync(path.join(userAgents, "agentfs-output.md"), `---\nname: agentfs-output\ndescription: async output sandbox fixture\nsandbox: agentfs\n---\n`);
	resetSwivalVersionCache();

	let tool: any;
	registerExtension({ registerTool: (registered: any) => { tool = registered; } } as any, { artifactRoot });
	const call = async (params: any) => {
		const result = await tool.execute("async-output", params, undefined, undefined, { cwd: piCwd, hasUI: false });
		const artifactDir = result.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		if (artifactDir) {
			const meta = JSON.parse(fs.readFileSync(path.join(artifactDir, "run-meta.json"), "utf8"));
			if (Number.isInteger(meta.pid) && meta.pid > 1) processGroups.push(meta.pid);
		}
		return result;
	};
	const reload = () => {
		let reloaded: any;
		registerExtension({ registerTool: (registered: any) => { reloaded = registered; } } as any, { artifactRoot });
		return (params: any) => reloaded.execute("async-output-reload", params, undefined, undefined,
			{ cwd: path.join(root, "different-reload-cwd"), hasUI: false });
	};
	const restart = async () => {
		// A new module registry has no asyncRuns entries and must recover from disk.
		vi.resetModules();
		const { default: restartedExtension } = await import("../extensions/index.js");
		let restarted: any;
		restartedExtension({ registerTool: (registered: any) => { restarted = registered; } } as any, { artifactRoot });
		return (params: any) => restarted.execute("async-output-restart", params, undefined, undefined,
			{ cwd: path.join(root, "different-restart-cwd"), hasUI: false });
	};
	return { root, dispatchCwd, piCwd, artifactRoot, call, reload, restart };
}

function observeProcesses(f: ReturnType<typeof makeFixture>, phase: string) {
	const configPath = path.join(f.root, "process-config.json");
	fs.writeFileSync(configPath, JSON.stringify({ root: f.root, phase, dispatch: f.dispatchCwd,
		movedDispatch: path.join(f.root, "moved-dispatch") }));
	process.env.PI_ASYNC_OUTPUT_RACE_CONFIG = configPath;
	process.env.NODE_OPTIONS = `${originalNodeOptions ?? ""} --require ${JSON.stringify(path.join(f.root, "bin", "lookup-interleaving.cjs"))}`;
}

function makeRace(f: ReturnType<typeof makeFixture>, kind: "parent" | "ancestor", phase: string) {
	const directory = kind === "ancestor" ? path.join(f.root, "anchor", "exports") : path.join(f.root, "exports");
	const outside = path.join(f.root, "outside");
	const outsideDirectory = kind === "ancestor" ? path.join(outside, "exports") : outside;
	const swap = kind === "ancestor" ? path.dirname(directory) : directory;
	const moved = path.join(f.root, "moved");
	fs.mkdirSync(directory, { recursive: true });
	fs.mkdirSync(outsideDirectory, { recursive: true });
	fs.writeFileSync(path.join(outsideDirectory, "out.txt"), "OUTSIDE_SENTINEL_UNCHANGED", { mode: 0o600 });
	const configPath = path.join(f.root, "race-config.json");
	fs.writeFileSync(configPath, JSON.stringify({ root: f.root, directory, swap, moved, outside, outsideDirectory, phase }));
	if (phase !== "stress") {
		process.env.PI_ASYNC_OUTPUT_RACE_CONFIG = configPath;
		process.env.NODE_OPTIONS = `${originalNodeOptions ?? ""} --require ${JSON.stringify(path.join(f.root, "bin", "lookup-interleaving.cjs"))}`;
	}
	return { directory, outsideDirectory, swap, moved, outside, output: path.join(directory, "out.txt") };
}

beforeEach(() => resetSwivalVersionCache());
afterEach(async () => {
	for (const root of roots) {
		if (fs.existsSync(path.join(root, "race-config.json"))) fs.writeFileSync(path.join(root, "stop-race"), "stop");
	}
	for (const pid of processGroups) {
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && processAlive(-pid)) await sleep(10);
		if (processAlive(-pid)) process.kill(-pid, "SIGKILL");
		await waitForExit(-pid);
	}
	processGroups.length = 0;
	process.env.PATH = originalPath;
	if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
	else process.env.NODE_OPTIONS = originalNodeOptions;
	if (originalRaceConfig === undefined) delete process.env.PI_ASYNC_OUTPUT_RACE_CONFIG;
	else process.env.PI_ASYNC_OUTPUT_RACE_CONFIG = originalRaceConfig;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
	roots.length = 0;
	resetSwivalVersionCache();
});

describe("ordinary async single-mode output", () => {
	it("materializes a secure cwd-relative output after detached completion without status or resume", async () => {
		const f = makeFixture();
		const output = path.join(f.dispatchCwd, "reports", "summary.txt");
		const started = await f.call({ task: "successful output", cwd: f.dispatchCwd, async: true, output: "reports/summary.txt" });

		expect(started.isError, started.content[0].text).not.toBe(true);
		expect(started.content[0].text).toContain(`Output will be written to: ${output}`);
		await waitFor(output);
		expect(fs.readFileSync(output, "utf8")).toBe("ASYNC_OUTPUT_FIXTURE");
		expect(fs.statSync(output).mode & 0o777).toBe(0o600);

		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		expect(artifactDir).toBeTruthy();
		await waitFor(path.join(artifactDir!, "completed.json"));
		const evidence = JSON.parse(fs.readFileSync(path.join(artifactDir!, "output-result.json"), "utf8"));
		expect(evidence).toMatchObject({ status: "written", outputPath: output, outputMode: "file-only" });

		const reloaded = f.reload();
		const status = await reloaded({ action: "status", id: started.content[0].text.match(/runId:\s+(\S+)/)?.[1] });
		expect(status.isError, status.content[0].text).not.toBe(true);
		expect(status.content[0].text).toContain(`Output: ${output}`);
		const resumed = await reloaded({ action: "resume", id: started.content[0].text.match(/runId:\s+(\S+)/)?.[1] });
		expect(resumed.isError, resumed.content[0].text).not.toBe(true);
		expect(resumed.content[0].text).toContain(`→ ${output}`);
		expect(resumed.content[0].text).not.toContain("ASYNC_OUTPUT_FIXTURE");
	});

	it("renders outputMode=inline consistently after reload", async () => {
		const f = makeFixture();
		const output = path.join(f.dispatchCwd, "inline.txt");
		const started = await f.call({ task: "inline output", cwd: f.dispatchCwd, async: true,
			output: "inline.txt", outputMode: "inline" });
		await waitFor(output);
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		await waitFor(path.join(artifactDir!, "completed.json"));
		const meta = JSON.parse(fs.readFileSync(path.join(artifactDir!, "run-meta.json"), "utf8"));
		await waitForExit(meta.pid);
		const runId = started.content[0].text.match(/runId:\s+(\S+)/)?.[1];
		const resumed = await f.reload()({ action: "resume", id: runId });
		expect(resumed.isError, resumed.content[0].text).not.toBe(true);
		expect(resumed.content[0].text).toContain("ASYNC_OUTPUT_FIXTURE");
		expect(resumed.content[0].text).toContain(`Output: ${output}`);
	});

	it.each([
		["whitespace-answer", "file-only"],
		["whitespace-answer", "inline"],
		["empty-answer", "file-only"],
		["empty-answer", "inline"],
	] as const)("keeps %s output canonical in %s mode across resume and restart", async (task, outputMode) => {
		const f = makeFixture();
		const output = path.join(f.dispatchCwd, "empty.txt");
		const started = await f.call({ task, cwd: f.dispatchCwd, async: true, output: "empty.txt", outputMode });
		expect(started.isError, started.content[0].text).not.toBe(true);
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		const runId = started.content[0].text.match(/runId:\s+(\S+)/)?.[1];
		await waitFor(path.join(artifactDir!, "completed.json"));
		expect(fs.readFileSync(output, "utf8")).toBe("");
		expect(fs.statSync(output).mode & 0o777).toBe(0o600);
		expect(fs.readFileSync(path.join(artifactDir!, "stdout.txt"), "utf8")).toBe("STDOUT_ONLY_MUST_NOT_INLINE");
		const evidence = JSON.parse(fs.readFileSync(path.join(artifactDir!, "output-result.json"), "utf8"));
		expect(evidence).toMatchObject({ status: "written", outputMode, outputBytes: 0, outputLineCount: 0 });

		for (const call of [f.call, f.reload(), await f.restart()]) {
			const status = await call({ action: "status", id: runId });
			expect(status.isError, status.content[0].text).not.toBe(true);
			expect(status.content[0].text).toContain(`Output: ${output} (0 lines, 0 bytes; ${outputMode})`);
			expect(status.content[0].text).not.toContain("STDOUT_ONLY_MUST_NOT_INLINE");
			const resumed = await call({ action: "resume", id: runId });
			expect(resumed.isError, resumed.content[0].text).not.toBe(true);
			expect(resumed.content[0].text).not.toContain("STDOUT_ONLY_MUST_NOT_INLINE");
			expect(resumed.content[0].text).not.toContain("(no output)");
			expect(resumed.content[0].text.split("\n\n").at(-1)).toBe(outputMode === "inline" ? "" : `→ ${output}`);
		}
	});

	it.each([
		["whitespace-answer", "STDOUT_ONLY_MUST_NOT_INLINE"],
		["empty-answer empty-stdout", "(no output)"],
	] as const)("preserves no-output resume rendering for %s", async (task, expectedBody) => {
		const f = makeFixture();
		const started = await f.call({ task, cwd: f.dispatchCwd, async: true });
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		const runId = started.content[0].text.match(/runId:\s+(\S+)/)?.[1];
		await waitFor(path.join(artifactDir!, "completed.json"));
		const resumed = await (await f.restart())({ action: "resume", id: runId });
		expect(resumed.isError, resumed.content[0].text).not.toBe(true);
		expect(resumed.content[0].text.split("\n\n").at(-1)).toBe(expectedBody);
	});

	it.each([
		["failed-outcome", {}],
		["malformed-report", {}],
		["missing-report", {}],
		["nonzero-exit", {}],
		["bad-result-exit", {}],
		["review-rejected", { selfReviewOverride: true }],
		["unverified-agentfs", { agent: "agentfs-output" }],
	] as const)("does not export partial output for %s", async (task, extra) => {
		const f = makeFixture();
		const output = path.join(f.dispatchCwd, `${task}.txt`);
		const started = await f.call({ task, cwd: f.dispatchCwd, async: true, output, ...extra });
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		await waitFor(path.join(artifactDir!, "completed.json"));
		expect(fs.existsSync(output)).toBe(false);
		const evidence = JSON.parse(fs.readFileSync(path.join(artifactDir!, "output-result.json"), "utf8"));
		expect(evidence.status).toBe("not-written");
		const runId = started.content[0].text.match(/runId:\s+(\S+)/)?.[1];
		const resumed = await f.reload()({ action: "resume", id: runId });
		expect(resumed.isError).toBe(true);
		expect(resumed.content[0].text).not.toContain("PARTIAL_MUST_NOT_EXPORT");
	});

	it("rejects a pre-existing output symlink before launch", async () => {
		const f = makeFixture();
		const outside = path.join(f.root, "outside.txt");
		const output = path.join(f.dispatchCwd, "linked.txt");
		fs.writeFileSync(outside, "UNCHANGED");
		fs.symlinkSync(outside, output);
		const result = await f.call({ task: "must not launch", cwd: f.dispatchCwd, async: true, output: "linked.txt" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/symlink/i);
		expect(fs.readFileSync(outside, "utf8")).toBe("UNCHANGED");
	});

	it.each(["absolute", "cwd-relative"] as const)("rejects an out-of-anchor parent symlink for %s output before worker launch", async (kind) => {
		const f = makeFixture();
		const outside = path.join(f.root, "outside-dir");
		const link = path.join(f.root, "parent-link");
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, "out.txt"), "UNCHANGED");
		fs.symlinkSync(outside, link);
		const output = kind === "absolute" ? path.join(link, "out.txt") : "../parent-link/out.txt";
		const result = await f.call({ task: "must not launch", cwd: f.dispatchCwd, async: true, output });
		// Drain an unexpected launch before fixture cleanup in the red phase.
		const artifactDir = result.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		if (artifactDir) await waitFor(path.join(artifactDir, "completed.json"));
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/symlink/i);
		expect(fs.existsSync(path.join(f.root, "worker-started"))).toBe(false);
		expect(fs.readFileSync(path.join(outside, "out.txt"), "utf8")).toBe("UNCHANGED");
		expect(fs.readdirSync(outside)).toEqual(["out.txt"]);
	});

	it.each(["absolute", "cwd-relative"] as const)("allows an ordinary out-of-anchor directory for %s output", async (kind) => {
		const f = makeFixture();
		const output = path.join(f.root, "unrelated", "out.txt");
		const requested = kind === "absolute" ? output : "../unrelated/out.txt";
		const started = await f.call({ task: "ordinary output", cwd: f.dispatchCwd, async: true, output: requested });
		expect(started.isError, started.content[0].text).not.toBe(true);
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		await waitFor(path.join(artifactDir!, "completed.json"));
		expect(fs.readFileSync(output, "utf8")).toBe("ASYNC_OUTPUT_FIXTURE");
		expect(fs.statSync(output).mode & 0o777).toBe(0o600);
	});

	it("allows async absolute output through the normal os.tmpdir() platform alias", async () => {
		const f = makeFixture();
		const output = path.join(os.tmpdir(), path.basename(f.root), "platform-output.txt");
		const started = await f.call({ task: "platform output", cwd: f.dispatchCwd, async: true, output });
		expect(started.isError, started.content[0].text).not.toBe(true);
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		await waitFor(path.join(artifactDir!, "completed.json"));
		expect(fs.readFileSync(output, "utf8")).toBe("ASYNC_OUTPUT_FIXTURE");
		expect(fs.statSync(output).mode & 0o777).toBe(0o600);
	});

	it("keeps detached output authority in inherited descriptors when disk metadata changes", async () => {
		const f = makeFixture();
		const output = path.join(f.dispatchCwd, "bound.txt");
		const unrelated = path.join(f.root, "unrelated.txt");
		fs.writeFileSync(unrelated, "UNCHANGED");
		const started = await f.call({ task: "delay-output", cwd: f.dispatchCwd, async: true, output: "bound.txt" });
		expect(started.isError, started.content[0].text).not.toBe(true);
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		const runId = started.content[0].text.match(/runId:\s+(\S+)/)?.[1];
		const metaPath = path.join(artifactDir!, "run-meta.json");
		const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
		fs.writeFileSync(metaPath, JSON.stringify({ ...meta, outputPath: unrelated, outputMode: "inline" }));
		await waitFor(path.join(artifactDir!, "completed.json"));
		expect(fs.readFileSync(output, "utf8")).toBe("ASYNC_OUTPUT_FIXTURE");
		expect(fs.readFileSync(unrelated, "utf8")).toBe("UNCHANGED");
		const evidence = JSON.parse(fs.readFileSync(path.join(artifactDir!, "output-result.json"), "utf8"));
		expect(evidence).toMatchObject({ status: "written", outputPath: output, outputMode: "file-only" });
		const resumed = await (await f.restart())({ action: "resume", id: runId });
		expect(resumed.isError).toBe(true);
		expect(resumed.content[0].text).toMatch(/output evidence is missing or invalid/i);
		expect(resumed.content[0].text).not.toContain("ASYNC_OUTPUT_FIXTURE");
	});

	it("rejects a replaced startup output directory even when the temporary inode is preserved", async () => {
		const f = makeFixture();
		const directory = path.join(f.root, "exports");
		const moved = path.join(f.root, "moved-exports");
		fs.mkdirSync(directory);
		fs.writeFileSync(path.join(directory, "out.txt"), "ORIGINAL_UNCHANGED");
		const started = await f.call({ task: "delay-output", cwd: f.dispatchCwd, async: true,
			output: path.join(directory, "out.txt") });
		expect(started.isError, started.content[0].text).not.toBe(true);
		const temporary = fs.readdirSync(directory).find((name) => name.startsWith(".tmp-output-"));
		expect(temporary).toBeTruthy();
		await waitFor(path.join(f.root, "worker-started"));
		fs.renameSync(directory, moved);
		fs.mkdirSync(directory);
		fs.linkSync(path.join(moved, temporary!), path.join(directory, temporary!));
		fs.writeFileSync(path.join(directory, "out.txt"), "REPLACEMENT_UNCHANGED");
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		await waitFor(path.join(artifactDir!, "completed.json"));
		const evidence = JSON.parse(fs.readFileSync(path.join(artifactDir!, "output-result.json"), "utf8"));
		expect(evidence.status).toBe("error");
		expect(evidence.error).toMatch(/directory identity changed/i);
		expect(fs.readFileSync(path.join(directory, "out.txt"), "utf8")).toBe("REPLACEMENT_UNCHANGED");
		expect(fs.readFileSync(path.join(moved, "out.txt"), "utf8")).toBe("ORIGINAL_UNCHANGED");
	});

	it("records a completion-time output write refusal without claiming materialization", async () => {
		const f = makeFixture();
		const outside = path.join(f.root, "outside.txt");
		const output = path.join(f.dispatchCwd, "raced-link.txt");
		fs.writeFileSync(outside, "UNCHANGED");
		const started = await f.call({ task: "delay-output", cwd: f.dispatchCwd, async: true, output: "raced-link.txt" });
		fs.symlinkSync(outside, output);
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		await waitFor(path.join(artifactDir!, "completed.json"));
		const evidence = JSON.parse(fs.readFileSync(path.join(artifactDir!, "output-result.json"), "utf8"));
		expect(evidence.status).toBe("error");
		expect(evidence.error).toMatch(/symlink/i);
		expect(fs.readFileSync(outside, "utf8")).toBe("UNCHANGED");
		const runId = started.content[0].text.match(/runId:\s+(\S+)/)?.[1];
		const status = await f.reload()({ action: "status", id: runId });
		expect(status.isError).toBe(true);
		expect(status.content[0].text).toMatch(/failed to write output/i);
		expect(status.content[0].text).not.toMatch(/Output: .*raced-link/);
	});
});

describe("async output stable directory capability", () => {
	it("inherits the original dispatch inode when its path is replaced after runner startup", async () => {
		const f = makeFixture();
		observeProcesses(f, "dispatch-after");
		const original = fs.lstatSync(f.dispatchCwd);
		const output = path.join(f.root, "exports", "out.txt");
		const started = await f.call({ task: "dispatch replacement", cwd: f.dispatchCwd, async: true, output });
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		await waitFor(path.join(artifactDir!, "completed.json"));
		expect(fs.existsSync(path.join(f.root, "dispatch-replaced"))).toBe(true);
		const worker = JSON.parse(fs.readFileSync(path.join(f.root, "worker-started"), "utf8"));
		expect(worker.identity).toEqual({ dev: original.dev, ino: original.ino });
		expect(worker.args[worker.args.indexOf("--base-dir") + 1]).toBe(f.dispatchCwd);
		expect(fs.readFileSync(path.join(f.dispatchCwd, "worker-relative.txt"), "utf8")).toBe("REPLACEMENT_UNCHANGED");
		expect(fs.readFileSync(path.join(f.root, "moved-dispatch", "worker-relative.txt"), "utf8")).toBe("ORIGINAL_WORKER_WRITE");
		expect(fs.readFileSync(output, "utf8")).toBe("ASYNC_OUTPUT_FIXTURE");
	});

	it("rejects an original dispatch path replaced before runner startup without hostile writes", async () => {
		const f = makeFixture();
		const output = path.join(f.root, "exports", "out.txt");
		const prepare = outputFiles.prepareOutputFile;
		const spy = vi.spyOn(outputFiles, "prepareOutputFile").mockImplementation((...args: any[]) => {
			const binding = prepare(...args);
			fs.renameSync(f.dispatchCwd, path.join(f.root, "moved-dispatch"));
			fs.mkdirSync(f.dispatchCwd);
			fs.writeFileSync(path.join(f.dispatchCwd, "worker-relative.txt"), "REPLACEMENT_UNCHANGED");
			return binding;
		});
		let started: any;
		try { started = await f.call({ task: "must not start", cwd: f.dispatchCwd, async: true, output }); }
		finally { spy.mockRestore(); }
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		await waitFor(path.join(artifactDir!, "completed.json"));
		expect(fs.existsSync(path.join(f.root, "worker-started"))).toBe(false);
		expect(fs.existsSync(output)).toBe(false);
		expect(fs.readFileSync(path.join(f.dispatchCwd, "worker-relative.txt"), "utf8")).toBe("REPLACEMENT_UNCHANGED");
		expect(JSON.parse(fs.readFileSync(path.join(artifactDir!, "output-result.json"), "utf8")).error).toMatch(/dispatch.*identity/i);
		expect(fs.readdirSync(path.dirname(output)).filter(name => name.startsWith(".tmp-output-"))).toEqual([]);
	});

	it.each(["relative", "absolute", "no-output"] as const)("keeps the original dispatch cwd for %s runs", async (kind) => {
		const f = makeFixture();
		observeProcesses(f, "observe");
		const piProcessCwd = process.cwd();
		const output = path.join(f.root, "exports", "out.txt");
		const requested = kind === "absolute" ? output : path.relative(f.dispatchCwd, output);
		const started = await f.call({ task: "cwd evidence", cwd: f.dispatchCwd, async: true,
			...(kind === "no-output" ? {} : { output: requested }) });
		expect(started.isError, started.content[0].text).not.toBe(true);
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		await waitFor(path.join(artifactDir!, "completed.json"));
		const worker = JSON.parse(fs.readFileSync(path.join(f.root, "worker-started"), "utf8"));
		expect(worker.cwd).toBe(f.dispatchCwd);
		expect(worker.args[worker.args.indexOf("--base-dir") + 1]).toBe(f.dispatchCwd);
		expect(process.cwd()).toBe(piProcessCwd);
		await waitForExit(worker.pid);
		if (kind === "no-output") expect(fs.existsSync(path.join(f.root, "committer-started"))).toBe(false);
		else {
			const helper = JSON.parse(fs.readFileSync(path.join(f.root, "committer-started"), "utf8"));
			const directory = fs.lstatSync(path.dirname(output));
			expect(helper.identity).toEqual({ dev: directory.dev, ino: directory.ino });
			await waitForExit(helper.pid);
			expect(fs.readFileSync(output, "utf8")).toBe("ASYNC_OUTPUT_FIXTURE");
			expect(fs.lstatSync(output).mode & 0o777).toBe(0o600);
			const runId = started.content[0].text.match(/runId:\s+(\S+)/)?.[1];
			const resumed = await (await f.restart())({ action: "resume", id: runId });
			expect(resumed.isError, resumed.content[0].text).not.toBe(true);
			expect(resumed.content[0].text).toContain(`→ ${output}`);
		}
	});

	it.each(["parent", "ancestor"] as const)("never renames through a %s symlink toggled by a live worker child", async (kind) => {
		const f = makeFixture();
		const race = makeRace(f, kind, "rename");
		const sentinel = path.join(race.outsideDirectory, "out.txt");
		const sentinelHash = hashFile(sentinel);
		const requested = kind === "parent" ? path.relative(f.dispatchCwd, race.output) : race.output;
		const started = await f.call({ task: "directory-race", cwd: f.dispatchCwd, async: true, output: requested });
		expect(started.isError, started.content[0].text).not.toBe(true);
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		try {
			await waitFor(path.join(artifactDir!, "completed.json"));
			expect(fs.existsSync(path.join(f.root, "lookup-swapped"))).toBe(true);
			expect(hashFile(sentinel)).toBe(sentinelHash);
			const temporary = fs.readFileSync(path.join(f.root, "outside-temporary"), "utf8");
			expect(fs.readFileSync(path.join(race.outsideDirectory, temporary), "utf8")).toBe("OUTSIDE_TEMP_UNCHANGED");
			const evidence = JSON.parse(fs.readFileSync(path.join(artifactDir!, "output-result.json"), "utf8"));
			expect(evidence.status).toBe("error");
			expect(evidence.error).toMatch(/symlink|directory identity changed/i);
			const runId = started.content[0].text.match(/runId:\s+(\S+)/)?.[1];
			for (const action of ["status", "resume"]) {
				const result = await (await f.restart())({ action, id: runId });
				expect(result.isError).toBe(true);
				expect(result.content[0].text).not.toContain(`Output: ${race.output}`);
			}
		} finally {
			fs.writeFileSync(path.join(f.root, "stop-race"), "stop");
			await waitFor(path.join(f.root, "race-stopped"));
		}
		const attack = JSON.parse(fs.readFileSync(path.join(f.root, "race-stopped"), "utf8"));
		expect(attack.cycles).toBeGreaterThan(1);
		await waitForExit(attack.pid);
		await waitForExit(JSON.parse(fs.readFileSync(path.join(f.root, "worker-started"), "utf8")).pid);
		expect(hashFile(sentinel)).toBe(sentinelHash);
		// Restoring the caller path makes a subsequent ordinary export usable.
		delete process.env.NODE_OPTIONS;
		const positive = await f.call({ task: "valid export after race", cwd: f.dispatchCwd, async: true, output: requested });
		const positiveArtifacts = positive.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		await waitFor(path.join(positiveArtifacts!, "completed.json"));
		expect(fs.readFileSync(race.output, "utf8")).toBe("ASYNC_OUTPUT_FIXTURE");
		expect(fs.lstatSync(race.output).mode & 0o777).toBe(0o600);
		expect(hashFile(sentinel)).toBe(sentinelHash);
	});

	it.each(["parent", "ancestor"] as const)("never cleans up through a %s symlink at the final unlink lookup", async (kind) => {
		const f = makeFixture();
		const race = makeRace(f, kind, "cleanup");
		const sentinel = path.join(race.outsideDirectory, "out.txt");
		const sentinelHash = hashFile(sentinel);
		const started = await f.call({ task: "directory-race failed-outcome", cwd: f.dispatchCwd,
			async: true, output: race.output });
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		try {
			await waitFor(path.join(artifactDir!, "completed.json"));
			expect(fs.existsSync(path.join(f.root, "lookup-swapped"))).toBe(true);
			const temporary = fs.readFileSync(path.join(f.root, "outside-temporary"), "utf8");
			expect(fs.existsSync(path.join(race.outsideDirectory, temporary))).toBe(true);
			expect(fs.readFileSync(path.join(race.outsideDirectory, temporary), "utf8")).toBe("OUTSIDE_TEMP_UNCHANGED");
			expect(hashFile(sentinel)).toBe(sentinelHash);
			expect(JSON.parse(fs.readFileSync(path.join(artifactDir!, "output-result.json"), "utf8")).status).toBe("not-written");
		} finally {
			fs.writeFileSync(path.join(f.root, "stop-race"), "stop");
			await waitFor(path.join(f.root, "race-stopped"));
		}
		const attack = JSON.parse(fs.readFileSync(path.join(f.root, "race-stopped"), "utf8"));
		expect(attack.cycles).toBeGreaterThan(1);
		await waitForExit(attack.pid);
		expect(fs.readdirSync(race.directory).filter(name => name.startsWith(".tmp-output-"))).toEqual([]);
	});

	it.each(["parent", "ancestor"] as const)("keeps outside sentinels unchanged during continuous %s toggling at worker exit", async (kind) => {
		const f = makeFixture();
		const race = makeRace(f, kind, "stress");
		const sentinel = path.join(race.outsideDirectory, "out.txt");
		const sentinelHash = hashFile(sentinel);
		const started = await f.call({ task: "directory-race stress-race", cwd: f.dispatchCwd, async: true, output: race.output });
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		try {
			await waitFor(path.join(artifactDir!, "completed.json"));
			expect(hashFile(sentinel)).toBe(sentinelHash);
			const temporary = fs.readFileSync(path.join(f.root, "outside-temporary"), "utf8");
			expect(fs.readFileSync(path.join(race.outsideDirectory, temporary), "utf8")).toBe("OUTSIDE_TEMP_UNCHANGED");
		} finally {
			fs.writeFileSync(path.join(f.root, "stop-race"), "stop");
			await waitFor(path.join(f.root, "race-stopped"));
		}
		const attack = JSON.parse(fs.readFileSync(path.join(f.root, "race-stopped"), "utf8"));
		expect(attack.cycles).toBeGreaterThan(1);
		await waitForExit(attack.pid);
		expect(hashFile(sentinel)).toBe(sentinelHash);
	});

	it("rejects a changed directory before wrapper startup without starting Swival", async () => {
		const f = makeFixture();
		const race = makeRace(f, "parent", "stress");
		const prepare = outputFiles.prepareOutputFile;
		let replaced = false;
		const spy = vi.spyOn(outputFiles, "prepareOutputFile").mockImplementation((...args: any[]) => {
			const binding = prepare(...args);
			replaced = true;
			fs.renameSync(race.swap, race.moved);
			fs.symlinkSync(race.outside, race.swap);
			return binding;
		});
		let started: any;
		try {
			started = await f.call({ task: "must not start", cwd: f.dispatchCwd, async: true, output: race.output });
		} finally { spy.mockRestore(); }
		expect(replaced).toBe(true);
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		await waitFor(path.join(artifactDir!, "completed.json"));
		expect(fs.existsSync(path.join(f.root, "worker-started"))).toBe(false);
		expect(JSON.parse(fs.readFileSync(path.join(artifactDir!, "output-result.json"), "utf8")).status).toBe("error");
		expect(fs.readFileSync(path.join(race.outsideDirectory, "out.txt"), "utf8")).toBe("OUTSIDE_SENTINEL_UNCHANGED");
		expect(fs.readdirSync(race.outsideDirectory)).toEqual(["out.txt"]);
	});

	it("rejects an inherited temporary descriptor with the wrong inode before starting Swival", () => {
		const f = makeFixture();
		const output = path.join(f.root, "exports", "out.txt");
		const binding = outputFiles.prepareOutputFile(output, f.dispatchCwd);
		const artifactDir = path.join(f.artifactRoot, "wrong-fd");
		fs.mkdirSync(artifactDir);
		const config = path.join(artifactDir, "binding.json");
		const dispatchStat = fs.statSync(f.dispatchCwd);
		fs.writeFileSync(config, JSON.stringify({ outputMode: "file-only", dispatchIdentity: {
			dev: dispatchStat.dev, ino: dispatchStat.ino }, binding }), { mode: 0o600 });
		const configFd = fs.openSync(config, "r");
		fs.unlinkSync(config);
		const unrelated = path.join(f.root, "unrelated.txt");
		fs.writeFileSync(unrelated, "UNRELATED_UNCHANGED");
		const wrongFd = fs.openSync(unrelated, "r+");
		try {
			const result = spawnSync(process.execPath, [runner, artifactDir, "--async-output-v1", "--report",
				path.join(artifactDir, "report.json"), "--", "must not start"], {
				cwd: f.dispatchCwd, env: process.env, shell: false, timeout: 5000, maxBuffer: 65536,
				stdio: ["ignore", "pipe", "pipe", wrongFd, configFd], encoding: "utf8",
			});
			expect(result.status).toBe(2);
			expect(fs.existsSync(path.join(f.root, "worker-started"))).toBe(false);
			expect(fs.readFileSync(unrelated, "utf8")).toBe("UNRELATED_UNCHANGED");
			expect(JSON.parse(fs.readFileSync(path.join(artifactDir, "output-result.json"), "utf8")).error).toMatch(/temporary.*identity/i);
		} finally {
			fs.closeSync(wrongFd);
			fs.closeSync(configFd);
			outputFiles.discardOutputFile(binding);
		}
	});

	it.each(["bad\\name.txt", "line\nbreak.txt", "."])("rejects an invalid output basename %j without starting Swival", async (output) => {
		const f = makeFixture();
		const result = await f.call({ task: "must not start", cwd: f.dispatchCwd, async: true, output });
		const artifactDir = result.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		if (artifactDir) await waitFor(path.join(artifactDir, "completed.json"));
		expect(result.isError).toBe(true);
		expect(fs.existsSync(path.join(f.root, "worker-started"))).toBe(false);
	});

	it("retains the erased captured inode when publication relocates it to the temporary name", async () => {
		const f = makeFixture();
		const race = makeRace(f, "parent", "relocated");
		const sentinel = path.join(race.outsideDirectory, "out.txt");
		const sentinelHash = hashFile(sentinel);
		const started = await f.call({ task: "relocated publication", cwd: f.dispatchCwd, async: true, output: race.output });
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		await waitFor(path.join(artifactDir!, "completed.json"));
		const evidence = JSON.parse(fs.readFileSync(path.join(artifactDir!, "output-result.json"), "utf8"));
		expect(evidence.status).toBe("error");
		const relocated = fs.readFileSync(path.join(f.root, "relocated-temp"), "utf8");
		expect(fs.existsSync(relocated)).toBe(true);
		expect(fs.readFileSync(relocated, "utf8")).toBe("");
		expect(fs.statSync(relocated).mode & 0o7777).toBe(0o600);
		expect(fs.readFileSync(race.output, "utf8")).toBe("replacement-marker");
		expect(hashFile(sentinel)).toBe(sentinelHash);
		expect(fs.existsSync(path.join(f.root, "post-publication-temp-unlink"))).toBe(false);
	});

	it.each(["mode", "leaf", "replacement"] as const)("rejects a final output %s change without following the target leaf", async (phase) => {
		const f = makeFixture();
		const race = makeRace(f, "parent", phase);
		const sentinel = path.join(race.outsideDirectory, "out.txt");
		const sentinelHash = hashFile(sentinel);
		const started = await f.call({ task: "final verification", cwd: f.dispatchCwd, async: true, output: race.output });
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		await waitFor(path.join(artifactDir!, "completed.json"));
		const evidence = JSON.parse(fs.readFileSync(path.join(artifactDir!, "output-result.json"), "utf8"));
		expect(evidence.status).toBe("error");
		expect(evidence.error).toMatch(phase === "mode" ? /mode|0600/i : /symlink|identity/i);
		expect(hashFile(sentinel)).toBe(sentinelHash);
		if (phase === "mode") {
			expect(fs.existsSync(race.output)).toBe(true);
			expect(fs.readFileSync(race.output, "utf8")).toBe("");
			expect(fs.statSync(race.output).mode & 0o7777).toBe(0o600);
		} else if (phase === "leaf") expect(fs.lstatSync(race.output).isSymbolicLink()).toBe(true);
		else expect(fs.readFileSync(race.output, "utf8")).toBe("replacement-marker");
		expect(fs.existsSync(path.join(f.root, "target-unlink-attempt"))).toBe(false);
	});
});

describe("async output committer lifecycle", () => {
	it.each([
		["helper-startup-fail", /injected committer startup failure/],
		["helper-ready-timeout", /startup timed out/],
		["helper-control-overflow", /response exceeds/],
	] as const)("rejects %s before hostile launch and reaps the helper", async (phase, error) => {
		const f = makeFixture();
		observeProcesses(f, phase);
		const output = path.join(f.root, "exports", "out.txt");
		const started = await f.call({ task: "must not start", cwd: f.dispatchCwd, async: true, output });
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		await waitFor(path.join(artifactDir!, "completed.json"), 8000);
		const helper = JSON.parse(fs.readFileSync(path.join(f.root, "committer-started"), "utf8"));
		await waitForExit(helper.pid);
		expect(fs.existsSync(path.join(f.root, "worker-started"))).toBe(false);
		expect(fs.existsSync(output)).toBe(false);
		const temporary = fs.readdirSync(path.dirname(output)).filter(name => name.startsWith(".tmp-output-"));
		if (phase === "helper-startup-fail") {
			// An injected fstat failure prevents proof of cleanup authority.
			expect(temporary).toHaveLength(1);
			const retained = path.join(path.dirname(output), temporary[0]);
			expect(fs.readFileSync(retained, "utf8")).toBe("");
			expect(fs.statSync(retained).mode & 0o7777).toBe(0o600);
		} else expect(temporary).toEqual([]);
		const evidence = JSON.parse(fs.readFileSync(path.join(artifactDir!, "output-result.json"), "utf8"));
		expect(evidence.status).toBe("error");
		expect(evidence.error).toMatch(error);
	}, 10000);

	it.each([
		["disconnect EOF", Buffer.alloc(0)],
		["partial body EOF", Buffer.from([1, 0, 0, 0, 4, 65])],
		["invalid operation", Buffer.from([2, 0, 0, 0, 0])],
		["oversized body", Buffer.from([1, 4, 0, 0, 1])],
		["trailing bytes", Buffer.from([0, 0, 0, 0, 0, 65])],
	] as const)("fails closed and cleans its held temporary file on %s", (_name, input) => {
		const f = makeFixture();
		const output = path.join(f.root, "exports", "out.txt");
		const binding = outputFiles.prepareOutputFile(output, f.dispatchCwd);
		const config = path.join(f.root, "binding.json");
		fs.writeFileSync(config, JSON.stringify({ binding }), { mode: 0o600 });
		const configFd = fs.openSync(config, "r");
		fs.unlinkSync(config);
		try {
			const result = spawnSync(process.execPath, [committer], { cwd: binding.directory,
				env: process.env, shell: false, timeout: 3000, maxBuffer: 65536,
				stdio: ["pipe", "pipe", "pipe", binding.fd, configFd], input, encoding: "utf8" });
			expect(result.status).toBe(1);
			expect(result.stdout).toContain('"status":"ready"');
			expect(result.stdout).toContain('"status":"error"');
			expect(result.stdout).not.toContain("ASYNC_OUTPUT_FIXTURE");
			expect(fs.existsSync(output)).toBe(false);
			expect(fs.existsSync(binding.temporary)).toBe(false);
		} finally { fs.closeSync(configFd); outputFiles.discardOutputFile(binding); }
	});

	it.each(["written", "discarded"] as const)("rejects an early %s terminal frame before it transfers an empty body", async (kind) => {
		const f = makeFixture();
		observeProcesses(f, `helper-early-terminal-${kind}`);
		const output = path.join(f.root, "exports", "out.txt");
		const started = await f.call({ task: "empty-answer", cwd: f.dispatchCwd, async: true, output });
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		await waitFor(path.join(artifactDir!, "completed.json"));
		const helper = JSON.parse(fs.readFileSync(path.join(f.root, "committer-started"), "utf8"));
		await waitForExit(helper.pid);
		expect(fs.existsSync(output)).toBe(false);
		expect(fs.readdirSync(path.dirname(output)).filter(name => name.startsWith(".tmp-output-"))).toEqual([]);
		const evidence = JSON.parse(fs.readFileSync(path.join(artifactDir!, "output-result.json"), "utf8"));
		expect(evidence.status).toBe("error");
		expect(evidence.status).not.toBe("written");
	});

	it("fails immediately when the ready committer closes its response stream", async () => {
		const f = makeFixture();
		observeProcesses(f, "helper-stdout-eof");
		const output = path.join(f.root, "exports", "out.txt");
		const began = Date.now();
		const started = await f.call({ task: "ignore-term", cwd: f.dispatchCwd, async: true, output });
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		await waitFor(path.join(artifactDir!, "completed.json"));
		const elapsed = Date.now() - began;
		const helper = JSON.parse(fs.readFileSync(path.join(f.root, "committer-started"), "utf8"));
		const worker = JSON.parse(fs.readFileSync(path.join(f.root, "worker-started"), "utf8"));
		await waitForExit(helper.pid);
		await waitForExit(worker.pid);
		expect(elapsed).toBeLessThan(2000);
		expect(fs.existsSync(output)).toBe(false);
		expect(fs.readdirSync(path.dirname(output)).filter(name => name.startsWith(".tmp-output-"))).toEqual([]);
		expect(JSON.parse(fs.readFileSync(path.join(artifactDir!, "output-result.json"), "utf8")).status).toBe("error");
	});

	it("reaps a committer that loses its input before worker completion and stops hostile work", async () => {
		const f = makeFixture();
		observeProcesses(f, "helper-eof");
		const output = path.join(f.root, "exports", "out.txt");
		const started = await f.call({ task: "delay-output ignore-term", cwd: f.dispatchCwd, async: true, output });
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		await waitFor(path.join(artifactDir!, "completed.json"));
		const helper = JSON.parse(fs.readFileSync(path.join(f.root, "committer-started"), "utf8"));
		await waitForExit(helper.pid);
		const workerFile = path.join(f.root, "worker-started");
		expect(fs.existsSync(workerFile)).toBe(true);
		await waitForExit(JSON.parse(fs.readFileSync(workerFile, "utf8")).pid);
		expect(fs.existsSync(output)).toBe(false);
		expect(fs.readdirSync(path.dirname(output)).filter(name => name.startsWith(".tmp-output-"))).toEqual([]);
		expect(JSON.parse(fs.readFileSync(path.join(artifactDir!, "output-result.json"), "utf8")).status).toBe("error");
	});

	it("cleans and reaps the committer on cancellation without exporting an answer", async () => {
		const f = makeFixture();
		observeProcesses(f, "observe");
		const output = path.join(f.root, "exports", "out.txt");
		const started = await f.call({ task: "delay-output", cwd: f.dispatchCwd, async: true, output });
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		const runId = started.content[0].text.match(/runId:\s+(\S+)/)?.[1];
		await waitFor(path.join(f.root, "worker-started"));
		const helper = JSON.parse(fs.readFileSync(path.join(f.root, "committer-started"), "utf8"));
		const interrupted = await f.call({ action: "interrupt", id: runId });
		expect(interrupted.isError, interrupted.content[0].text).not.toBe(true);
		await waitFor(path.join(artifactDir!, "completed.json"));
		await waitForExit(helper.pid);
		await waitForExit(JSON.parse(fs.readFileSync(path.join(f.root, "worker-started"), "utf8")).pid);
		expect(fs.existsSync(output)).toBe(false);
		expect(fs.readdirSync(path.dirname(output)).filter(name => name.startsWith(".tmp-output-"))).toEqual([]);
		expect(JSON.parse(fs.readFileSync(path.join(artifactDir!, "output-result.json"), "utf8")).status).not.toBe("written");
	});

	it("cleans the held output temporary file when the runner disconnects", async () => {
		const f = makeFixture();
		observeProcesses(f, "observe");
		const output = path.join(f.root, "exports", "out.txt");
		const started = await f.call({ task: "delay-output", cwd: f.dispatchCwd, async: true, output });
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		await waitFor(path.join(f.root, "worker-started"));
		const helper = JSON.parse(fs.readFileSync(path.join(f.root, "committer-started"), "utf8"));
		const meta = JSON.parse(fs.readFileSync(path.join(artifactDir!, "run-meta.json"), "utf8"));
		process.kill(meta.pid, "SIGKILL");
		await waitForExit(helper.pid);
		await waitForExit(JSON.parse(fs.readFileSync(path.join(f.root, "worker-started"), "utf8")).pid);
		expect(fs.existsSync(output)).toBe(false);
		expect(fs.existsSync(path.join(artifactDir!, "output-result.json"))).toBe(false);
		expect(fs.readdirSync(path.dirname(output)).filter(name => name.startsWith(".tmp-output-"))).toEqual([]);
	});

	it("does not fall back to a pathname writer after committer failure", async () => {
		const f = makeFixture();
		observeProcesses(f, "helper-write-fail");
		const output = path.join(f.root, "exports", "out.txt");
		const started = await f.call({ task: "successful output", cwd: f.dispatchCwd, async: true, output });
		const artifactDir = started.content[0].text.match(/artifactDir:\s+(.*)/)?.[1];
		await waitFor(path.join(artifactDir!, "completed.json"));
		const helper = JSON.parse(fs.readFileSync(path.join(f.root, "committer-started"), "utf8"));
		await waitForExit(helper.pid);
		expect(fs.existsSync(output)).toBe(false);
		expect(fs.readdirSync(path.dirname(output)).filter(name => name.startsWith(".tmp-output-"))).toEqual([]);
		const evidence = JSON.parse(fs.readFileSync(path.join(artifactDir!, "output-result.json"), "utf8"));
		expect(evidence.status).toBe("error");
		expect(evidence.error).toMatch(/injected committer rename failure/);
		const runId = started.content[0].text.match(/runId:\s+(\S+)/)?.[1];
		const resumed = await (await f.restart())({ action: "resume", id: runId });
		expect(resumed.isError).toBe(true);
		expect(resumed.content[0].text).not.toContain("ASYNC_OUTPUT_FIXTURE");
	});

	it("reaps the verified helper and removes metadata when producer metadata persistence fails", async () => {
		const f = makeFixture();
		observeProcesses(f, "observe");
		const output = path.join(f.root, "exports", "out.txt");
		let wrapperPid: number | undefined;
		const writeFile = fs.promises.writeFile.bind(fs.promises);
		const spy = vi.spyOn(fs.promises, "writeFile").mockImplementation(async (file, data, ...rest) => {
			if (String(file).endsWith("run-meta.json")) {
				wrapperPid = JSON.parse(String(data)).pid;
				if (wrapperPid) processGroups.push(wrapperPid);
				await waitFor(path.join(f.root, "worker-started"));
				throw new Error("injected output metadata failure");
			}
			return writeFile(file, data, ...rest);
		});
		let result: any;
		try { result = await f.call({ task: "delay-output", cwd: f.dispatchCwd, async: true, output }); }
		finally { spy.mockRestore(); }
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/injected output metadata failure/);
		expect(wrapperPid).toBeTypeOf("number");
		await waitForExit(-wrapperPid!);
		const helper = JSON.parse(fs.readFileSync(path.join(f.root, "committer-started"), "utf8"));
		await waitForExit(helper.pid);
		expect(fs.readdirSync(f.artifactRoot)).toEqual([]);
		expect(fs.existsSync(output)).toBe(false);
		expect(fs.readdirSync(path.dirname(output)).filter(name => name.startsWith(".tmp-output-"))).toEqual([]);
	});
});
