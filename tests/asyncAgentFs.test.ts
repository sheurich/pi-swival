import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerExtension, {
	enforceCompletedAsyncAgentFs,
	findRunMeta,
	isAgentFsRequested,
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

	it("does not enforce AgentFS for persisted non-AgentFS or yolo intent", () => {
		const report = makeReport({ mode: "agentfs" });
		expect(enforceCompletedAsyncAgentFs({ agentFsRequested: false }, report).reason).toBeUndefined();
		expect(isAgentFsRequested({ sandbox: "agentfs", yolo: true })).toBe(false);
		expect(isAgentFsRequested({ sandbox: "agentfs", yolo: false })).toBe(true);
		expect(isAgentFsRequested({ sandbox: "builtin", yolo: false })).toBe(false);
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
	const artifactRoot = path.join(os.homedir(), ".pi", "agent", "swival-artifacts");
	const artifactDirs: string[] = [];

	afterEach(() => {
		for (const dir of artifactDirs) fs.rmSync(dir, { recursive: true, force: true });
		artifactDirs.length = 0;
	});

	const executeAction = async (action: "status" | "resume", sandbox: Record<string, unknown>) => {
		const runId = `swival-run-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		fs.mkdirSync(artifactRoot, { recursive: true });
		const artifactDir = fs.mkdtempSync(path.join(artifactRoot, "async-agentfs-test-"));
		artifactDirs.push(artifactDir);
		const meta = { ...makeMeta(artifactDir, true), runId };
		fs.writeFileSync(path.join(artifactDir, "run-meta.json"), JSON.stringify(meta));
		fs.writeFileSync(path.join(artifactDir, "completed.json"), JSON.stringify({ exitCode: 0, exitedAt: "2026-08-27T00:00:00Z" }));
		fs.writeFileSync(path.join(artifactDir, "report.json"), JSON.stringify({
			result: { outcome: "success", answer: "must not be presented as success" },
			sandbox,
		}));
		fs.writeFileSync(meta.stdoutFile, "stdout answer");

		let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
		registerExtension({ registerTool: (registered: typeof tool) => { tool = registered; } } as any);
		const result = await tool!.execute("test-call", { action, id: runId }, undefined, undefined, {
			cwd: process.cwd(),
			hasUI: false,
		});
		return { artifactDir, result };
	};

	it.each(["status", "resume"] as const)("%s fails closed with the artifact path when evidence is absent", async (action) => {
		const { artifactDir, result } = await executeAction(action, { mode: "agentfs" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/failed AgentFS bootstrap validation/);
		expect(result.content[0].text).toMatch(/agentfs_version/);
		expect(result.content[0].text).toContain(`Artifact dir: ${artifactDir}`);
		if (action === "resume") expect(result.content[0].text).not.toContain("must not be presented as success");
	});

	it.each(["status", "resume"] as const)("%s preserves success with valid AgentFS evidence", async (action) => {
		const { result } = await executeAction(action, { mode: "agentfs", agentfs_version: "0.6.4" });
		expect(result.isError).not.toBe(true);
		if (action === "resume") expect(result.content[0].text).toContain("must not be presented as success");
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
