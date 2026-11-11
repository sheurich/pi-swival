import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync, spawn } from "node:child_process";
import { nativeTestPython } from "./nativePython.js";

vi.mock("node:child_process", async (importOriginal) => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn() }));
const deliveries: string[] = [];
const defaultSpawnMock = ((executable: string, args: string[]) => {
	const proc: any = new EventEmitter();
	proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough();
	proc.kill = vi.fn(); proc.unref = vi.fn();
	let stdin = ""; proc.stdin.on("data", (chunk: Buffer) => { stdin += chunk.toString(); });
	queueMicrotask(() => {
		if (args.includes("--version")) proc.stdout.write("1.9.3");
		else {
			const positional = args[args.indexOf("--") + 1];
			// Async wrapper argv: [async-runner.cjs, "--scratch-dir", <scratch>, <artifactDir>, ...swivalArgs].
			const wrapperBody = executable === process.execPath ? args.slice(1) : undefined;
			const artifactDir = wrapperBody ? (wrapperBody[0] === "--scratch-dir" ? wrapperBody[2] : wrapperBody[0]) : undefined;
			deliveries.push(positional ?? (artifactDir ? fs.readFileSync(path.join(artifactDir, "task.txt"), "utf8") : stdin));
			const report = args[args.indexOf("--report") + 1];
			fs.writeFileSync(report, JSON.stringify({ result: { outcome: "success", answer: "literal $100 $& $' $`" }, sandbox: { mode: "agentfs", agentfs_version: "0.6.4" } }));
		}
		proc.stdout.end(); proc.stderr.end(); proc.emit("close", 0);
	});
	return proc;
}) as any;
vi.mocked(spawn).mockImplementation(defaultSpawnMock);

// Offline host doubles: these tests exercise dispatch, not Pi rendering or loading.
vi.mock("@earendil-works/pi-ai", () => ({ StringEnum: (values: string[]) => ({ enum: values }) }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ getMarkdownTheme: () => ({}), getAgentDir: () => process.env.PI_CODING_AGENT_DIR ?? "/nonexistent-ordinary-safety-agent-dir" }));
vi.mock("@earendil-works/pi-tui", () => ({ Container: class {}, Markdown: class {}, Spacer: class {}, Text: class {} }));
vi.mock("typebox", () => ({ Type: new Proxy({}, { get: (_target, key) => (...args: unknown[]) => key === "Object" ? { properties: args[0] } : {} }) }));
import registerExtension, { findRunMeta, isMutatingCwdAgent, preflightSwivalVersion, pruneOldArtifacts, resetSwivalVersionCache, runSingleSwivalAsync } from "../extensions/index.js";
import type { SwivalAgentConfig } from "../extensions/agents.js";

const roots: string[] = [];
function fixture() {
	const scratch = new URL("./.scratch/ordinary-safety/", import.meta.url);
	fs.mkdirSync(scratch, { recursive: true });
	const root = fs.realpathSync(fs.mkdtempSync(new URL("run-", scratch)));
	roots.push(root);
	const home = path.join(root, "home"); fs.mkdirSync(home);
	vi.stubEnv("HOME", home);
	vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "config"));
	const artifactRoot = path.join(root, "artifacts"); fs.mkdirSync(artifactRoot);
	return { root, artifactRoot };
}
const agent: SwivalAgentConfig = { name: "test", description: "test", systemPrompt: "", source: "user", filePath: "/unused" };
const spawnedPids: number[] = [];
afterEach(() => {
	deliveries.length = 0;
	for (const pid of spawnedPids.splice(0)) {
		try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
	}
	vi.restoreAllMocks();
	vi.mocked(spawn).mockReset().mockImplementation(defaultSpawnMock);
	resetSwivalVersionCache();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ordinary cwd write capability", () => {
	it.each(["git", "ls,rg", "git,ls,find,rg,grep,head,tail,wc,pwd"])("treats command-name allowlist %s as write-capable", (commands) => {
		expect(isMutatingCwdAgent({ ...agent, files: "none", commands })).toBe(true);
	});
	it("does not exempt fresh AgentFS sessions with write-through base access", () => {
		expect(isMutatingCwdAgent({ ...agent, sandbox: "agentfs", noSandboxAutoSession: true })).toBe(true);
	});
	it("allows shared cwd only with both write surfaces disabled", () => {
		expect(isMutatingCwdAgent({ ...agent, files: "none", commands: "none" })).toBe(false);
	});
});

describe("durable async option validation", () => {
	it("rejects unsupported options without starting retention cleanup", async () => {
		const f = fixture(); const { meta } = writeMeta(f); let tool: any;
		fs.writeFileSync(path.join(meta.artifactDir, "completed.json"), "{}");
		const old = new Date(Date.now() - 10 * 86400000);
		fs.utimesSync(meta.artifactDir, old, old);
		registerExtension({ registerTool: (value: any) => { tool = value; } } as any,
			{ artifactRoot: f.artifactRoot });
		const reads = vi.spyOn(fs.promises, "readdir");
		try {
			const result = await tool.execute("test",
				{ agent: "swival", task: "task", async: true, timeoutMs: 1 },
				undefined, undefined, { cwd: f.root, hasUI: false });
			expect(result.isError).toBe(true);
			expect(reads.mock.calls.some(([directory]) => directory === f.artifactRoot)).toBe(false);
			expect(fs.existsSync(meta.artifactDir)).toBe(true);
			expect(fs.readFileSync(path.join(meta.artifactDir, "completed.json"), "utf8")).toBe("{}");
		} finally { reads.mockRestore(); }
	});
	it.each([{ timeoutMs: 1 }, { timeoutMs: 0 }, { output: "answer.txt" }, { output: "" }, { outputMode: "file-only" }])("rejects unsupported tool options before creating artifacts: %j", async (option) => {
		const f = fixture(); let tool: any;
		registerExtension({ registerTool: (value: any) => { tool = value; } } as any, { artifactRoot: f.artifactRoot });
		const before = vi.mocked(spawn).mock.calls.length;
		const result = await tool.execute("test", { agent: "swival", task: "task", async: true, ...option }, undefined, undefined, { cwd: f.root, hasUI: false });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/async.*(timeoutMs|output)/i);
		expect(vi.mocked(spawn).mock.calls.length).toBe(before);
		expect(fs.readdirSync(f.artifactRoot)).toEqual([]);
	});
	it("also rejects timeoutMs at the direct durable-runner boundary", async () => {
		const f = fixture();
		await expect(runSingleSwivalAsync(f.root, [agent], agent.name, "task", undefined, { timeoutMs: 1 }, f.artifactRoot)).rejects.toThrow(/async.*timeoutMs/i);
		expect(fs.readdirSync(f.artifactRoot)).toEqual([]);
	});
});

function writeMeta(f: ReturnType<typeof fixture>) {
	const artifactDir = path.join(f.artifactRoot, "ordinary"); fs.mkdirSync(artifactDir);
	const meta = { runId: "swival-run-test", agent: "test", task: "literal task", startedAt: 1, pid: 1234, artifactDir,
		stdoutFile: path.join(artifactDir, "stdout.txt"), stderrFile: path.join(artifactDir, "stderr.txt") };
	const save = () => fs.writeFileSync(path.join(artifactDir, "run-meta.json"), JSON.stringify(meta));
	save(); return { meta, save };
}
describe("explicit async recovery containment", () => {
	it.each((["artifactDir", "stdoutFile", "stderrFile"] as const).flatMap((field) => [true, false].map((existing) => ({ field, existing }))))("rejects symlink escapes through $field with existing target=$existing and a nonexistent suffix", async ({ field, existing }) => {
		const f = fixture(); const { meta, save } = writeMeta(f);
		const outside = path.join(f.root, "outside"); if (existing) fs.mkdirSync(outside);
		const link = path.join(field === "artifactDir" ? f.artifactRoot : meta.artifactDir, "escape"); fs.symlinkSync(outside, link);
		meta[field] = path.join(link, "not-created", "file");
		if (field === "artifactDir") { meta.stdoutFile = path.join(meta.artifactDir, "stdout.txt"); meta.stderrFile = path.join(meta.artifactDir, "stderr.txt"); }
		save();
		expect(await findRunMeta(meta.runId, f.artifactRoot)).toBeUndefined();
	});
	it.each((["stdoutFile", "stderrFile"] as const).flatMap((field) => ["", "/missing"].map((suffix) => ({ field, suffix }))))("rejects dangling $field aliases whose parent traversal follows a symlink: $suffix", async ({ field, suffix }) => {
		const f = fixture(); const { meta, save } = writeMeta(f);
		const outside = path.join(f.root, "outside", "child"); fs.mkdirSync(outside, { recursive: true });
		fs.symlinkSync(outside, path.join(meta.artifactDir, "hop"));
		const alias = path.join(meta.artifactDir, "alias"); fs.symlinkSync("hop/../future", alias);
		meta[field] = alias + suffix; save();
		expect(await findRunMeta(meta.runId, f.artifactRoot)).toBeUndefined();
	});
	it("accepts a legitimate root alias and contained nonexistent streams", async () => {
		const f = fixture(); const { meta } = writeMeta(f);
		const alias = path.join(f.root, "alias"); fs.symlinkSync(f.artifactRoot, alias);
		expect(await findRunMeta(meta.runId, alias)).toMatchObject({ runId: meta.runId });
	});
});

describe("conservative artifact pruning", () => {
	it.each(["malformed", "oversized", "null", "array", "scalar", "symlink", "missing", "ordinary"])("retains uncertain metadata and removes only ordinary completed artifacts: %s", async (kind) => {
		const f = fixture(); const { meta } = writeMeta(f);
		const file = path.join(meta.artifactDir, "run-meta.json");
		if (kind === "malformed") fs.writeFileSync(file, "{");
		if (kind === "scalar") fs.writeFileSync(file, "42");
		if (kind === "oversized") fs.writeFileSync(file, " ".repeat(65537));
		if (kind === "null" || kind === "array") fs.writeFileSync(file, kind === "null" ? "null" : "[]");
		if (kind === "symlink") { fs.unlinkSync(file); const target = path.join(f.root, "meta.json"); fs.writeFileSync(target, "{}"); fs.symlinkSync(target, file); }
		if (kind === "missing") fs.unlinkSync(file);
		fs.writeFileSync(path.join(meta.artifactDir, "completed.json"), "{}");
		const old = new Date(Date.now() - 10 * 86400000); fs.utimesSync(meta.artifactDir, old, old);
		await pruneOldArtifacts(f.artifactRoot);
		expect(fs.existsSync(meta.artifactDir)).toBe(kind !== "ordinary");
	});
});

const envelope = "Delegated task (plain text):\n\n";
describe("plain-text task delivery", () => {
	it.each(["builtin", "agentfs", "ambient"])("wraps sync and async %s tasks while preserving metadata and literal chain substitution", async (sandbox) => {
		const f = fixture(); const agentDir = path.join(f.root, "agents"); const definitions = path.join(agentDir, "swival-agents");
		fs.mkdirSync(definitions, { recursive: true }); vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		fs.writeFileSync(path.join(definitions, "literal.md"), ["---", "name: literal", "description: test", ...(sandbox === "ambient" ? [] : [`sandbox: ${sandbox}`]), "---", "test"].join("\n"));
		let tool: any; registerExtension({ registerTool: (value: any) => { tool = value; } } as any, { artifactRoot: f.artifactRoot });
		const task = "/audit --all\n!literal $&";
		const result = await tool.execute("test", { chain: [{ agent: "literal", task }, { agent: "literal", task: "!{previous} {previous}" }] }, undefined, undefined, { cwd: f.root, hasUI: false });
		expect(result.isError).not.toBe(true);
		expect(deliveries).toEqual([envelope + task, envelope + "!literal $100 $& $' $` literal $100 $& $' $`"]);
		expect(result.details.results.map((r: any) => r.task)).toEqual([task, "!literal $100 $& $' $` literal $100 $& $' $`"]);
		deliveries.length = 0;
		const asyncAgent = { ...agent, ...(sandbox === "ambient" ? {} : { sandbox: sandbox as "builtin" | "agentfs" }) };
		const started = await runSingleSwivalAsync(f.root, [asyncAgent], agent.name, task, undefined, {}, f.artifactRoot);
		expect(deliveries).toEqual([envelope + task]);
		expect(JSON.parse(fs.readFileSync(path.join(started.artifactDir, "run-meta.json"), "utf8")).task).toBe(task);
	});
	it("uses the installed released parser offline to classify enveloped slash and bang tasks as plain prompts", () => {
		const inputs = ["/audit --all", "!echo should-not-run", "  /reset", "\n!literal", "--help"].map((task) => envelope + task);
		const script = new URL("./ordinary_parser_fixture.py", import.meta.url);
		expect(JSON.parse(execFileSync(nativeTestPython, [script.pathname], { input: JSON.stringify(inputs), encoding: "utf8", timeout: 10000 }))).toEqual(inputs);
	});
});

describe("ordinary safety guidance", () => {
	it("refuses shared-cwd explorer dispatch without recommending an ineffective overlay remedy", async () => {
		const f = fixture(); let tool: any;
		registerExtension({ registerTool: (value: any) => { tool = value; } } as any, { artifactRoot: f.artifactRoot });
		const result = await tool.execute("test", { tasks: [{ agent: "sandboxed-explorer", task: "one" }, { agent: "sandboxed-explorer", task: "two" }] }, undefined, undefined, { cwd: f.root, hasUI: false });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Refusing to dispatch");
		expect(result.content[0].text).not.toContain("own overlay");
		expect(result.content[0].text).toContain("commands: none");
	});
	it("describes explorer base access as write-through, without promising changes await application", () => {
		const doc = fs.readFileSync(new URL("../agents/sandboxed-explorer.md", import.meta.url), "utf8");
		expect(doc).toContain("write-through");
		expect(doc).not.toContain("not applied to the real filesystem");
		expect(doc).not.toContain("instead of real files");
	});
	it("preserves synchronous timeout and output-file behavior", async () => {
		const f = fixture(); let tool: any;
		registerExtension({ registerTool: (value: any) => { tool = value; } } as any, { artifactRoot: f.artifactRoot });
		const timer = vi.spyOn(globalThis, "setTimeout");
		try {
			const result = await tool.execute("test", { agent: "swival", task: "task", timeoutMs: 1234, output: "answer.txt", outputMode: "file-only" }, undefined, undefined, { cwd: f.root, hasUI: false });
			expect(result.isError).not.toBe(true);
			expect(fs.readFileSync(path.join(f.root, "answer.txt"), "utf8")).toContain("literal $100 $& $' $`");
			expect(timer.mock.calls.some((call) => call[1] === 1234)).toBe(true);
		} finally { timer.mockRestore(); }
	});
});


describe("preserved retention and canonical alias behavior", () => {
	it.each(["metadata", "snapshot", "request.json", "evidence/native-state", "prefix"])("retains native sentinel %s", async (sentinel) => {
		const f = fixture(); const { meta } = writeMeta(f);
		if (sentinel === "metadata") {
			fs.writeFileSync(path.join(meta.artifactDir, "run-meta.json"), JSON.stringify({ ...meta, nativeAuditRequested: true }));
		} else if (sentinel !== "prefix") {
			const marker = path.join(meta.artifactDir, sentinel);
			if (sentinel === "request.json") fs.writeFileSync(marker, "{}");
			else fs.mkdirSync(marker, { recursive: true });
		}
		if (sentinel === "prefix") {
			const renamed = path.join(f.artifactRoot, "native-audit-legacy");
			fs.renameSync(meta.artifactDir, renamed); meta.artifactDir = renamed;
		}
		fs.writeFileSync(path.join(meta.artifactDir, "completed.json"), "{}");
		const old = new Date(Date.now() - 10 * 86400000); fs.utimesSync(meta.artifactDir, old, old);
		await pruneOldArtifacts(f.artifactRoot);
		expect(fs.existsSync(meta.artifactDir)).toBe(true);
	});
	it("returns canonical paths for metadata written through a legitimate root alias", async () => {
		const f = fixture(); const { meta, save } = writeMeta(f);
		const canonicalDir = meta.artifactDir;
		const alias = path.join(f.root, "alias"); fs.symlinkSync(f.artifactRoot, alias);
		meta.artifactDir = path.join(alias, "ordinary"); meta.stdoutFile = path.join(meta.artifactDir, "stdout.txt"); meta.stderrFile = path.join(meta.artifactDir, "stderr.txt"); save();
		expect(await findRunMeta(meta.runId, f.artifactRoot)).toMatchObject({ artifactDir: canonicalDir, stdoutFile: path.join(canonicalDir, "stdout.txt"), stderrFile: path.join(canonicalDir, "stderr.txt") });
	});
	it("resolves a contained dangling stream alias to its future canonical target", async () => {
		const f = fixture(); const { meta, save } = writeMeta(f);
		const alias = path.join(meta.artifactDir, "alias"); fs.symlinkSync("future", alias);
		meta.stdoutFile = path.join(alias, "stdout.txt"); save();
		expect(await findRunMeta(meta.runId, f.artifactRoot)).toMatchObject({ stdoutFile: path.join(meta.artifactDir, "future", "stdout.txt") });
	});
});

describe("synchronous process-group cleanup and UTF-8 streaming", () => {
	function installFakeSwival(binDir: string, mode: "hang" | "exit-0-with-grandchild") {
		const swivalPath = path.join(binDir, "swival");
		fs.writeFileSync(swivalPath, [
			`#!${process.execPath}`,
			'import * as fs from "node:fs";',
			'import * as path from "node:path";',
			'import { spawn } from "node:child_process";',
			'const args = process.argv.slice(2);',
			'if (args.includes("--version")) { process.stdout.write("1.9.3\\n"); process.exit(0); }',
			'const baseDir = args[args.indexOf("--base-dir") + 1];',
			'const reportPath = args[args.indexOf("--report") + 1];',
			'const pidFile = path.join(baseDir, "grandchild.pid");',
			'spawn(process.execPath, [',
			'  "--input-type=module", "-e",',
			'  "import * as fs from \\"node:fs\\"; process.on(\\"SIGTERM\\", () => {}); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);",',
			'  pidFile,',
			'], { stdio: "inherit" });',
			`if (${JSON.stringify(mode)} === "exit-0-with-grandchild") {`,
			'  const waitPid = setInterval(() => {',
			'    if (!fs.existsSync(pidFile)) return;',
			'    clearInterval(waitPid);',
			'    fs.writeFileSync(reportPath, JSON.stringify({ result: { outcome: "success", answer: "leader-done", exit_code: 0 } }));',
			'    process.exit(0);',
			'  }, 10);',
			'} else {',
			'  setInterval(() => {}, 1000);',
			'}',
		].join("\n") + "\n", { mode: 0o755 });
	}

	const waitPidFile = async (pidFile: string): Promise<number> => {
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			if (fs.existsSync(pidFile)) {
				const raw = fs.readFileSync(pidFile, "utf8").trim();
				const pid = Number(raw);
				if (Number.isInteger(pid) && pid > 1) {
					spawnedPids.push(pid);
					return pid;
				}
			}
			await new Promise((r) => setTimeout(r, 15));
		}
		throw new Error(`Timed out waiting for grandchild PID at ${pidFile}`);
	};

	const assertProcessGone = (pid: number) => {
		expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
	};

	it("terminates a SIGTERM-ignoring grandchild holding stdio open on synchronous timeoutMs", async () => {
		const actualCp = await vi.importActual<typeof import("node:child_process")>("node:child_process");
		vi.mocked(spawn).mockImplementation(actualCp.spawn);
		const f = fixture();
		const binDir = path.join(f.root, "bin"); fs.mkdirSync(binDir);
		installFakeSwival(binDir, "hang");
		vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);

		let tool: any;
		registerExtension({ registerTool: (value: any) => { tool = value; } } as any, { artifactRoot: f.artifactRoot });
		const runPromise = tool.execute("sync-timeout", { agent: "swival", task: "hang", timeoutMs: 200 }, undefined, undefined, { cwd: f.root, hasUI: false });
		const grandchildPid = await waitPidFile(path.join(f.root, "grandchild.pid"));
		const result = await runPromise;

		expect(result.isError).toBe(true);
		expect(result.details.results[0].exitCode).not.toBe(0);
		assertProcessGone(grandchildPid);
	}, 15_000);

	it("terminates SIGTERM-ignoring grandchildren holding stdio open on AbortSignal in parallel mode", async () => {
		const actualCp = await vi.importActual<typeof import("node:child_process")>("node:child_process");
		vi.mocked(spawn).mockImplementation(actualCp.spawn);
		const f = fixture();
		const binDir = path.join(f.root, "bin"); fs.mkdirSync(binDir);
		installFakeSwival(binDir, "hang");
		vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);

		const cwdA = path.join(f.root, "wt-a"); fs.mkdirSync(cwdA);
		const cwdB = path.join(f.root, "wt-b"); fs.mkdirSync(cwdB);
		let tool: any;
		registerExtension({ registerTool: (value: any) => { tool = value; } } as any, { artifactRoot: f.artifactRoot });
		const controller = new AbortController();
		const runPromise = tool.execute("sync-abort", {
			tasks: [
				{ agent: "swival", task: "one", cwd: cwdA },
				{ agent: "swival", task: "two", cwd: cwdB },
			],
		}, controller.signal, undefined, { cwd: f.root, hasUI: false });

		const [pidA, pidB] = await Promise.all([
			waitPidFile(path.join(cwdA, "grandchild.pid")),
			waitPidFile(path.join(cwdB, "grandchild.pid")),
		]);
		controller.abort();
		const result = await runPromise;

		expect(result.details.results.every((r: any) => r.exitCode !== 0)).toBe(true);
		assertProcessGone(pidA);
		assertProcessGone(pidB);
	}, 15_000);

	it("reaps a SIGTERM-ignoring grandchild holding stdout/stderr open after normal leader exit 0", async () => {
		const actualCp = await vi.importActual<typeof import("node:child_process")>("node:child_process");
		vi.mocked(spawn).mockImplementation(actualCp.spawn);
		const f = fixture();
		const binDir = path.join(f.root, "bin"); fs.mkdirSync(binDir);
		installFakeSwival(binDir, "exit-0-with-grandchild");
		vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);

		let tool: any;
		registerExtension({ registerTool: (value: any) => { tool = value; } } as any, { artifactRoot: f.artifactRoot });
		const startedAt = Date.now();
		const result = await tool.execute("sync-normal-exit", { agent: "swival", task: "complete-with-orphan" }, undefined, undefined, { cwd: f.root, hasUI: false });
		const grandchildPid = Number(fs.readFileSync(path.join(f.root, "grandchild.pid"), "utf8").trim());

		expect(Date.now() - startedAt).toBeLessThan(5000);
		expect(result.isError).not.toBe(true);
		expect(result.details.results[0]).toMatchObject({ exitCode: 0, finalOutput: "leader-done" });
		assertProcessGone(grandchildPid);
	}, 15_000);

	it("fails closed when terminateProcessGroup cannot verify descendant shutdown despite leader exit 0", async () => {
		const f = fixture();
		await preflightSwivalVersion(async () => "1.9.3");
		const killSpy = vi.spyOn(process, "kill").mockImplementation(((targetPid: number) => {
			if (targetPid === -43210) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
			return true;
		}) as any);
		vi.mocked(spawn).mockImplementation(((_exe: string, args: string[]) => {
			const proc: any = new EventEmitter();
			proc.pid = 43210;
			proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough();
			proc.kill = vi.fn(); proc.unref = vi.fn();
			queueMicrotask(() => {
				fs.writeFileSync(args[args.indexOf("--report") + 1], JSON.stringify({
					result: { outcome: "success", answer: "unverified-answer", exit_code: 0 },
				}));
				proc.stdout.end(); proc.stderr.end();
				proc.emit("exit", 0, null);
				proc.emit("close", 0, null);
			});
			return proc;
		}) as any);

		let tool: any;
		registerExtension({ registerTool: (value: any) => { tool = value; } } as any, { artifactRoot: f.artifactRoot });
		const result = await tool.execute("unverified-group", { agent: "swival", task: "task" }, undefined, undefined, { cwd: f.root, hasUI: false });
		expect(killSpy).toHaveBeenCalledWith(-43210, "SIGTERM");
		expect(result.isError).toBe(true);
		expect(result.details.results[0].exitCode).toBe(1);
		expect(result.details.results[0].reason).toEqual({
			code: "non_zero_exit",
			text: "Swival process group could not be verified as terminated; descendants may remain.",
		});
	});

	it.each(["timeout", "abort"] as const)("settles in bounded time with an explicit unverified-shutdown failure when a non-exiting child group throws EPERM on %s", async (trigger) => {
		const f = fixture();
		await preflightSwivalVersion(async () => "1.9.3");
		const killSpy = vi.spyOn(process, "kill").mockImplementation(((targetPid: number) => {
			if (targetPid === -54321) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
			return true;
		}) as any);
		let createdProc: any;
		vi.mocked(spawn).mockImplementation((() => {
			const proc: any = new EventEmitter();
			proc.pid = 54321;
			proc.stdout = new PassThrough();
			proc.stderr = new PassThrough();
			proc.stdin = new PassThrough();
			proc.kill = vi.fn();
			proc.unref = vi.fn();
			// Leader never emits exit or close and leaves stdio pipes open.
			proc.stdout.write("partial output before stuck leader");
			createdProc = proc;
			return proc;
		}) as any);

		let tool: any;
		registerExtension({ registerTool: (value: any) => { tool = value; } } as any, { artifactRoot: f.artifactRoot });
		const controller = new AbortController();
		const startedAt = Date.now();
		const runPromise = tool.execute(
			`unverified-${trigger}`,
			{ agent: "swival", task: "never-exits", ...(trigger === "timeout" ? { timeoutMs: 50 } : {}) },
			controller.signal,
			undefined,
			{ cwd: f.root, hasUI: false },
		);
		if (trigger === "abort") {
			setTimeout(() => controller.abort(), 30);
		}
		const result = await runPromise;

		expect(Date.now() - startedAt).toBeLessThan(5000);
		expect(killSpy).toHaveBeenCalledWith(-54321, "SIGTERM");
		expect(createdProc.stdout.destroyed).toBe(true);
		expect(createdProc.stderr.destroyed).toBe(true);
		expect(createdProc.unref).toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(result.details.results[0].exitCode).toBe(1);
		expect(result.details.results[0].reason).toEqual({
			code: "non_zero_exit",
			text: "Swival process group could not be verified as terminated; descendants may remain.",
		});
		expect(result.content[0].text).toContain("Swival process group could not be verified as terminated; descendants may remain.");
	}, 10_000);

	it("preserves 4-byte UTF-8 characters split across separate stdout and stderr chunks", async () => {
		const f = fixture();
		await preflightSwivalVersion(async () => "1.9.3");
		const crab = Buffer.from("crab 🦀 ok\n", "utf8");
		const splitIdx = crab.indexOf(0xf0) + 2;
		vi.mocked(spawn).mockImplementation(((_exe: string, args: string[]) => {
			const proc: any = new EventEmitter();
			proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough();
			proc.kill = vi.fn(); proc.unref = vi.fn();
			queueMicrotask(() => {
				proc.stdout.write(crab.subarray(0, splitIdx));
				proc.stderr.write(crab.subarray(0, splitIdx));
				setTimeout(() => {
					proc.stdout.write(crab.subarray(splitIdx));
					proc.stderr.write(crab.subarray(splitIdx));
					fs.writeFileSync(args[args.indexOf("--report") + 1], JSON.stringify({
						result: { outcome: "success", answer: "", exit_code: 0 },
					}));
					proc.stdout.end(); proc.stderr.end();
					proc.emit("close", 0);
				}, 10);
			});
			return proc;
		}) as any);

		let tool: any;
		registerExtension({ registerTool: (value: any) => { tool = value; } } as any, { artifactRoot: f.artifactRoot });
		const result = await tool.execute("utf8-split", { agent: "swival", task: "task" }, undefined, undefined, { cwd: f.root, hasUI: false });
		expect(result.isError).not.toBe(true);
		expect(result.details.results[0].finalOutput).toBe("crab 🦀 ok");
		expect(result.details.results[0].stderrTail).toEqual(["crab 🦀 ok"]);
		expect(result.details.results[0].finalOutput).not.toContain("\ufffd");
	});
});
