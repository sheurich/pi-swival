import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
import { spawn } from "node:child_process";
import registerExtension from "../extensions/index.js";

describe("chain execution {previous} substitution", () => {
	let tmp: string;
	const executedTasks: string[] = [];

	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-chain-replace-")));
		executedTasks.length = 0;

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
					const taskIndex = args.indexOf("--");
					const taskArg = taskIndex >= 0 ? args[taskIndex + 1] : "";
					executedTasks.push(taskArg);

					const reportIndex = args.indexOf("--report");
					if (reportIndex >= 0) {
						// Step 1 outputs special regex replacement patterns: $100, $&, $', $`
						const answer = executedTasks.length === 1 ? "Price: $100 & $& and $'" : "Step 2 done";
						fs.writeFileSync(
							args[reportIndex + 1],
							JSON.stringify({ result: { outcome: "success", answer, exit_code: 0 } }),
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
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("preserves special replacement patterns ($100, $&, $') without regex substitution corruption", async () => {
		let tool: any;
		registerExtension(
			{
				registerTool: (t: any) => {
					tool = t;
				},
			} as any,
			{ artifactRoot: path.join(tmp, "artifacts") },
		);

		const result = await tool.execute(
			"test-chain-id",
			{
				chain: [
					{ agent: "swival", task: "Step 1" },
					{ agent: "swival", task: "Verify {previous} exactly" },
				],
			},
			undefined,
			undefined,
			{ cwd: tmp, hasUI: false },
		);

		expect(result.isError).not.toBe(true);
		expect(executedTasks).toHaveLength(2);
		expect(executedTasks[0]).toBe("Step 1");
		// Verify that {previous} was replaced literally with the exact string from Step 1
		expect(executedTasks[1]).toBe("Verify Price: $100 & $& and $' exactly");
	});
});
