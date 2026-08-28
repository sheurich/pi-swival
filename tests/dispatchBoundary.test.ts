import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerExtension from "../extensions/index.js";

describe("argument-validation dispatch boundary", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalTmpDir = process.env.TMPDIR;
	let root: string;
	let artifactRoot: string;
	let tool: { execute: (...args: any[]) => Promise<any> };

	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-boundary-")));
		const agentDir = path.join(root, "agent");
		const agentsDir = path.join(agentDir, "swival-agents");
		artifactRoot = path.join(root, "artifacts");
		const tmpDir = path.join(root, "tmp");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.mkdirSync(artifactRoot);
		fs.mkdirSync(tmpDir);
		fs.writeFileSync(
			path.join(agentsDir, "bad-agent.md"),
			[
				"---",
				"name: bad-agent",
				"description: agent with invalid extraArgs",
				"extraArgs:",
				'  - "--"',
				"---",
				"You are a test agent.",
				"",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(agentsDir, "override-agent.md"),
			[
				"---",
				"name: override-agent",
				"description: agent whose reviewer conflict is disabled by an override",
				"selfReview: true",
				"reviewer: /bin/true",
				"---",
				"You are a test agent.",
				"",
			].join("\n"),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.TMPDIR = tmpDir;

		let registered: typeof tool | undefined;
		registerExtension(
			{ registerTool: (candidate: typeof tool) => { registered = candidate; } } as any,
			{ artifactRoot },
		);
		tool = registered!;
	});

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		if (originalTmpDir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = originalTmpDir;
		fs.rmSync(root, { recursive: true, force: true });
	});

	it.each([
		["single", { agent: "bad-agent", task: "task" }],
		["chain", { chain: [{ agent: "bad-agent", task: "task" }] }],
		["parallel", {
			tasks: [
				{ agent: "bad-agent", task: "task one" },
				{ agent: "bad-agent", task: "task two" },
			],
		}],
		["async", { agent: "bad-agent", task: "task", async: true }],
	] as const)("returns a structured error without artifacts for %s dispatch", async (_mode, params) => {
		const result = await tool.execute(
			"test-call",
			{ agentScope: "user", ...params },
			undefined,
			undefined,
			{ cwd: process.cwd(), hasUI: false },
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/option terminator/i);
		expect(fs.readdirSync(artifactRoot)).toEqual([]);
		expect(fs.readdirSync(process.env.TMPDIR!)).toEqual([]);
	});

	it("uses effective overrides in parallel safety guards", async () => {
		const result = await tool.execute(
			"test-call",
			{
				agentScope: "user",
				selfReviewOverride: false,
				tasks: [
					{ agent: "override-agent", task: "task one" },
					{ agent: "override-agent", task: "task two" },
				],
			},
			undefined,
			undefined,
			{ cwd: process.cwd(), hasUI: false },
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/Refusing to dispatch/);
		expect(fs.readdirSync(artifactRoot)).toEqual([]);
		expect(fs.readdirSync(process.env.TMPDIR!)).toEqual([]);
	});
});
