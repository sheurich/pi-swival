import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// writeRunOutput is not exported; exercise it through the tool's `output`
// param with a mocked swival process so no real subprocess or model request
// runs.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
import { spawn } from "node:child_process";
import registerExtension from "../extensions/index.js";

let root: string;
let tool: any;
const calls: Array<{ args: string[] }> = [];
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-write-output-")));
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent-home");
	fs.mkdirSync(path.join(root, "workspace"));
	calls.length = 0;
	vi.mocked(spawn).mockImplementation(((exe: string, args: string[]) => {
		const proc: any = new EventEmitter();
		proc.stdout = new PassThrough();
		proc.stderr = new PassThrough();
		proc.stdin = new PassThrough();
		proc.kill = vi.fn();
		proc.unref = vi.fn();
		calls.push({ args: [...args] });
		queueMicrotask(() => {
			if (args.includes("--version")) {
				proc.stdout.write("1.0.45");
			} else {
				const reportIndex = args.indexOf("--report");
				if (reportIndex >= 0) {
					fs.writeFileSync(
						args[reportIndex + 1],
						JSON.stringify({ result: { outcome: "success", answer: "WRITE_OUTPUT_FIXTURE" } }),
					);
				}
			}
			proc.stdout.end();
			proc.stderr.end();
			proc.emit("close", 0);
		});
		return proc;
	}) as any);
	registerExtension({ registerTool: (registered: any) => { tool = registered; } } as any,
		{ artifactRoot: path.join(root, "artifacts") });
});

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	fs.rmSync(root, { recursive: true, force: true });
});

function execute(params: any) {
	return tool.execute("write-output-test", params, undefined, undefined,
		{ cwd: path.join(root, "workspace"), hasUI: false });
}

it("refuses to write output through an existing symlink", async () => {
	const outside = path.join(root, "outside.txt");
	fs.writeFileSync(outside, "UNCHANGED");
	const symlink = path.join(root, "workspace", "linked.txt");
	fs.symlinkSync(outside, symlink);

	const result = await execute({ agent: "swival", task: "fixture", output: "linked.txt" });

	expect(result.isError).not.toBe(true);
	// The symlink target must not be overwritten; writeRunOutput refuses to
	// follow it and records the refusal on stderrTail instead.
	expect(fs.readFileSync(outside, "utf8")).toBe("UNCHANGED");
	expect(result.details.results[0].outputPath).toBeUndefined();
	expect(result.details.results[0].stderrTail.join("\n")).toMatch(/symlink/i);
});

it("still writes output to a plain relative path outside cwd (documented cwd-relative behavior)", async () => {
	const outside = path.join(root, "outside.txt");
	fs.writeFileSync(outside, "UNCHANGED");

	const result = await execute({ agent: "swival", task: "fixture", output: "../outside.txt" });

	expect(result.isError).not.toBe(true);
	expect(fs.readFileSync(outside, "utf8")).toBe("WRITE_OUTPUT_FIXTURE");
});

it("writes the output file with mode 0600 regardless of the process umask", async () => {
	const outputPath = path.join(root, "workspace", "out.txt");

	await execute({ agent: "swival", task: "fixture", output: "out.txt" });

	const mode = fs.statSync(outputPath).mode & 0o777;
	expect(mode).toBe(0o600);
});

it("refuses to write output when a parent directory is an existing symlink", async () => {
	const outsideDir = path.join(root, "outside_dir");
	fs.mkdirSync(outsideDir);
	const parentLink = path.join(root, "workspace", "link_dir");
	fs.symlinkSync(outsideDir, parentLink);

	const result = await execute({ agent: "swival", task: "fixture", output: "link_dir/out.txt" });

	expect(result.isError).not.toBe(true);
	expect(fs.existsSync(path.join(outsideDir, "out.txt"))).toBe(false);
	expect(result.details.results[0].outputPath).toBeUndefined();
	expect(result.details.results[0].stderrTail.join("\n")).toMatch(/symlink/i);
});

it("rolls back output file if chmod fails", async () => {
	const outputPath = path.join(root, "workspace", "chmod-fail.txt");
	const originalChmod = fs.promises.chmod;
	const chmodSpy = vi.spyOn(fs.promises, "chmod").mockImplementation((async (p: any, m: any) => {
		if (String(p).includes(".tmp-output-")) {
			throw new Error("EPERM: operation not permitted, chmod");
		}
		return originalChmod(p, m);
	}) as any);

	try {
		const result = await execute({ agent: "swival", task: "fixture", output: "chmod-fail.txt" });
		expect(fs.existsSync(outputPath)).toBe(false);
		expect(result.details.results[0].outputPath).toBeUndefined();
		expect(result.details.results[0].stderrTail.join("\n")).toMatch(/chmod/i);
	} finally {
		chmodSpy.mockRestore();
	}
});
