import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerExtension, {
	enforceCompletedAsyncAgentFs,
	findRunMeta,
	summarizeReport,
	type RunMeta,
} from "../extensions/index.js";

const makeReport = (sandbox?: Record<string, unknown>) =>
	summarizeReport({ result: { outcome: "success", answer: "completed answer" }, sandbox });

const makeMeta = (artifactDir: string, agentFsRequested?: boolean): RunMeta => ({
	runId: "swival-run-test",
	agent: "test-agent",
	task: "test task",
	startedAt: 1,
	pid: 1234,
	artifactDir,
	stdoutFile: path.join(artifactDir, "stdout.txt"),
	stderrFile: path.join(artifactDir, "stderr.txt"),
	...(agentFsRequested === undefined ? {} : { agentFsRequested }),
});

describe("completed async AgentFS enforcement", () => {
	it("fails closed when persisted AgentFS intent has no bootstrap evidence", () => {
		const report = makeReport({ mode: "agentfs" });
		const enforced = enforceCompletedAsyncAgentFs({ agentFsRequested: true }, report);

		expect(enforced.reason?.text).toMatch(/agentfs_version/);
		expect(enforced.report?.outcome).toBe("error");
		expect(enforced.report?.answer).toBe("completed answer");
	});

	it("preserves a completed AgentFS report with re-exec evidence", () => {
		const report = makeReport({ mode: "agentfs", agentfs_version: "0.6.4" });
		const enforced = enforceCompletedAsyncAgentFs({ agentFsRequested: true }, report);

		expect(enforced.reason).toBeUndefined();
		expect(enforced.report).toBe(report);
	});

	it("enforces AgentFS when the report records it despite persisted false intent", () => {
		const report = makeReport({ mode: "agentfs" });
		expect(enforceCompletedAsyncAgentFs({ agentFsRequested: false }, report).reason?.text).toMatch(/agentfs_version/);
	});

	it("does not enforce AgentFS when persisted intent is false and the report is builtin", () => {
		const report = makeReport({ mode: "builtin" });
		expect(enforceCompletedAsyncAgentFs({ agentFsRequested: false }, report).reason).toBeUndefined();
	});

	it("enforces legacy metadata when the report says AgentFS", () => {
		const report = makeReport({ mode: "agentfs" });
		expect(enforceCompletedAsyncAgentFs({}, report).reason?.text).toMatch(/agentfs_version/);
	});

	it("does not infer AgentFS from a missing report for legacy metadata", () => {
		expect(enforceCompletedAsyncAgentFs({}, undefined).reason).toBeUndefined();
	});
});

describe("status and resume consumption", () => {
	const artifactRoots: string[] = [];

	afterEach(() => {
		for (const dir of artifactRoots) fs.rmSync(dir, { recursive: true, force: true });
		artifactRoots.length = 0;
	});

	const executeAction = async (
		action: "status" | "resume" | "interrupt",
		options: {
			sandbox?: Record<string, unknown>;
			outcome?: "success" | "failed" | "error";
			exitCode?: number;
			includeReport?: boolean;
			agentFsRequested?: boolean;
			completed?: boolean;
		} = {},
	) => {
		const runId = `swival-run-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-artifacts-test-"));
		artifactRoots.push(artifactRoot);
		const artifactDir = fs.mkdtempSync(path.join(artifactRoot, "async-agentfs-test-"));
		const meta = { ...makeMeta(artifactDir, options.agentFsRequested ?? true), runId };
		fs.writeFileSync(path.join(artifactDir, "run-meta.json"), JSON.stringify(meta));
		if (options.completed !== false) {
			fs.writeFileSync(path.join(artifactDir, "completed.json"), JSON.stringify({
				exitCode: options.exitCode ?? 0,
				exitedAt: "2026-08-27T00:00:00Z",
			}));
		}
		if (options.includeReport !== false) {
			fs.writeFileSync(path.join(artifactDir, "report.json"), JSON.stringify({
				result: {
					outcome: options.outcome ?? "success",
					answer: "must not be presented as success",
				},
				sandbox: options.sandbox,
			}));
		}
		fs.writeFileSync(meta.stdoutFile, "stdout answer");
		fs.writeFileSync(meta.stderrFile, "stderr details");

		let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
		registerExtension(
			{ registerTool: (registered: typeof tool) => { tool = registered; } } as any,
			{ artifactRoot },
		);
		const result = await tool!.execute("test-call", { action, id: runId }, undefined, undefined, {
			cwd: process.cwd(),
			hasUI: false,
		});
		return { artifactDir, result };
	};

	it.each(["status", "resume"] as const)("%s fails closed with the artifact path when evidence is absent", async (action) => {
		const { artifactDir, result } = await executeAction(action, { sandbox: { mode: "agentfs" } });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/failed AgentFS bootstrap validation/);
		expect(result.content[0].text).toMatch(/agentfs_version/);
		expect(result.content[0].text).toContain(`Artifact dir: ${artifactDir}`);
		if (action === "resume") expect(result.content[0].text).not.toContain("must not be presented as success");
	});

	it.each(["status", "resume"] as const)("%s preserves success with valid AgentFS evidence", async (action) => {
		const { result } = await executeAction(action, {
			sandbox: { mode: "agentfs", agentfs_version: "0.6.4" },
		});
		expect(result.isError).not.toBe(true);
		if (action === "resume") expect(result.content[0].text).toContain("must not be presented as success");
	});

	it.each(["status", "resume"] as const)("%s rejects failed outcomes and hides partial output", async (action) => {
		for (const outcome of ["failed", "error"] as const) {
			const { result } = await executeAction(action, {
				agentFsRequested: false,
				outcome,
			});
			expect(result.isError).toBe(true);
			expect(result.content[0].text).not.toContain("must not be presented as success");
		}
	});

	it.each(["status", "resume"] as const)("%s rejects non-zero exits and missing reports", async (action) => {
		const nonZero = await executeAction(action, {
			agentFsRequested: false,
			exitCode: 1,
		});
		expect(nonZero.result.isError).toBe(true);
		expect(nonZero.result.content[0].text).not.toContain("must not be presented as success");

		const missing = await executeAction(action, {
			agentFsRequested: false,
			includeReport: false,
		});
		expect(missing.result.isError).toBe(true);
		expect(missing.result.content[0].text).not.toContain("stdout answer");
	});

	it("refuses to signal a disk-recovered PID without verified identity", async () => {
		const { result } = await executeAction("interrupt", {
			agentFsRequested: false,
			completed: false,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/cannot safely interrupt/i);
	});
});

describe("async RunMeta AgentFS intent", () => {
	const tmpDirs: string[] = [];

	afterEach(() => {
		for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
		tmpDirs.length = 0;
	});

	const writeMeta = (agentFsRequested: unknown, includeField = true) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "swival-run-meta-"));
		tmpDirs.push(root);
		const artifactDir = path.join(root, "test-agent-1-abcd");
		fs.mkdirSync(artifactDir);
		const meta = makeMeta(artifactDir);
		const raw = includeField ? { ...meta, agentFsRequested } : meta;
		fs.writeFileSync(path.join(artifactDir, "run-meta.json"), JSON.stringify(raw));
		return { root, meta };
	};

	it.each([true, false])("round-trips persisted agentFsRequested=%s", async (requested) => {
		const { root } = writeMeta(requested);
		await expect(findRunMeta("swival-run-test", root)).resolves.toMatchObject({ agentFsRequested: requested });
	});

	it("accepts legacy metadata without agentFsRequested", async () => {
		const { root } = writeMeta(undefined, false);
		await expect(findRunMeta("swival-run-test", root)).resolves.toMatchObject({ runId: "swival-run-test" });
	});

	it.each(["true", 1, null, {}, []])("rejects malformed agentFsRequested=%j", async (value) => {
		const { root } = writeMeta(value);
		await expect(findRunMeta("swival-run-test", root)).resolves.toBeUndefined();
	});
});
