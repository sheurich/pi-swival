import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
import { spawn } from "node:child_process";
import registerExtension from "../extensions/index.js";

describe("project-local agent confirmation", () => {
	let tmp: string;
	const savedEnv = process.env.PI_SWIVAL_TRUST_PROJECT_AGENTS;

	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-project-confirm-")));
		delete process.env.PI_SWIVAL_TRUST_PROJECT_AGENTS;

		vi.mocked(spawn).mockImplementation(((exe: string, args: string[]) => {
			const proc: any = new EventEmitter();
			proc.stdout = new PassThrough();
			proc.stderr = new PassThrough();
			proc.stdin = new PassThrough();
			proc.kill = vi.fn();
			proc.unref = vi.fn();
			queueMicrotask(() => {
				if (args.includes("--version")) {
					proc.stdout.write("1.0.45");
				} else {
					const reportIndex = args.indexOf("--report");
					if (reportIndex >= 0) {
						fs.writeFileSync(
							args[reportIndex + 1],
							JSON.stringify({
								result: { outcome: "success", answer: "OK", exit_code: 0 },
								sandbox: { mode: "agentfs", agentfs_version: "0.6.4" },
							}),
						);
					}
				}
				proc.stdout.end();
				proc.stderr.end();
				proc.emit("close", 0);
			});
			return proc;
		}) as any);
	});

	afterEach(() => {
		if (savedEnv !== undefined) process.env.PI_SWIVAL_TRUST_PROJECT_AGENTS = savedEnv;
		else delete process.env.PI_SWIVAL_TRUST_PROJECT_AGENTS;
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("refuses to run project-local agents without UI confirmation", async () => {
		const projectDir = path.join(tmp, ".pi", "swival-agents");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, "local-helper.md"),
			["---", "name: local-helper", "description: test", "---", "Helper prompt"].join("\n"),
		);

		let tool: any;
		registerExtension(
			{
				registerTool: (t: any) => {
					tool = t;
				},
			} as any,
			{ artifactRoot: path.join(tmp, "artifacts") },
		);

		const resultWithoutUI = await tool.execute(
			"test-id",
			{ agent: "local-helper", task: "do work", agentScope: "project" },
			undefined,
			undefined,
			{ cwd: tmp, hasUI: false },
		);
		expect(resultWithoutUI.isError).toBe(true);
		expect(resultWithoutUI.content[0].text).toMatch(/Refusing to run project-local swival agents/);
		expect(resultWithoutUI.content[0].text).toContain("PI_SWIVAL_TRUST_PROJECT_AGENTS=1");
	});

	it("bypasses confirmation when options.trustProjectAgents is true", async () => {
		const projectDir = path.join(tmp, ".pi", "swival-agents");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, "local-helper.md"),
			["---", "name: local-helper", "description: test", "---", "Helper prompt"].join("\n"),
		);

		let tool: any;
		registerExtension(
			{
				registerTool: (t: any) => {
					tool = t;
				},
			} as any,
			{ artifactRoot: path.join(tmp, "artifacts"), trustProjectAgents: true },
		);

		const resultTrusted = await tool.execute(
			"test-id-2",
			{ agent: "local-helper", task: "do work", agentScope: "project" },
			undefined,
			undefined,
			{ cwd: tmp, hasUI: false },
		);
		expect(resultTrusted.isError).not.toBe(true);
	});

	it("bypasses confirmation when PI_SWIVAL_TRUST_PROJECT_AGENTS environment variable is set", async () => {
		process.env.PI_SWIVAL_TRUST_PROJECT_AGENTS = "1";

		const projectDir = path.join(tmp, ".pi", "swival-agents");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, "local-helper.md"),
			["---", "name: local-helper", "description: test", "---", "Helper prompt"].join("\n"),
		);

		let tool: any;
		registerExtension(
			{
				registerTool: (t: any) => {
					tool = t;
				},
			} as any,
			{ artifactRoot: path.join(tmp, "artifacts") },
		);

		const resultEnv = await tool.execute(
			"test-id-3",
			{ agent: "local-helper", task: "do work", agentScope: "project" },
			undefined,
			undefined,
			{ cwd: tmp, hasUI: false },
		);
		expect(resultEnv.isError).not.toBe(true);
	});

	it("does not bypass confirmation when PI_SWIVAL_TRUST_PROJECT_AGENTS is 0 or false", async () => {
		for (const val of ["0", "false"]) {
			process.env.PI_SWIVAL_TRUST_PROJECT_AGENTS = val;

			const projectDir = path.join(tmp, ".pi", "swival-agents");
			fs.mkdirSync(projectDir, { recursive: true });
			fs.writeFileSync(
				path.join(projectDir, "local-helper.md"),
				["---", "name: local-helper", "description: test", "---", "Helper prompt"].join("\n"),
			);

			let tool: any;
			registerExtension(
				{
					registerTool: (t: any) => {
						tool = t;
					},
				} as any,
				{ artifactRoot: path.join(tmp, "artifacts") },
			);

			const resultEnv = await tool.execute(
				`test-id-refuse-${val}`,
				{ agent: "local-helper", task: "do work", agentScope: "project" },
				undefined,
				undefined,
				{ cwd: tmp, hasUI: false },
			);
			expect(resultEnv.isError).toBe(true);
			expect(resultEnv.content[0].text).toMatch(/Refusing to run project-local swival agents/);
		}
	});
});
