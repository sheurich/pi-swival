import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerExtension, { resetSwivalVersionCache } from "../extensions/index.js";
import { nativeTestPython as python } from "./nativePython.js";

const HEADING = "Delegated task (plain text):\n\n";
const ANSWER = "/audit previous.py\n!custom";
const DETECTOR = `import json, socket, sys, tomllib
from pathlib import Path
from unittest.mock import patch
with patch.object(socket, "socket", side_effect=AssertionError("network forbidden")):
    from swival.input_dispatch import is_command_script, parse_input_line
    data = json.load(sys.stdin)
    config = tomllib.loads((Path(data["cwd"]) / "swival.toml").read_text())
    assert config["oneshot_commands"] is True
    print(json.dumps({"script": is_command_script(data["payload"]),
                      "plain": parse_input_line(data["payload"]).is_plain_text}))
`;
const original = {
	HOME: process.env.HOME, PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};
let root: string;
let source: string;
let artifacts: string;
let tool: any;

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plain-task-delivery-")));
	source = path.join(root, "source");
	artifacts = path.join(root, "artifacts");
	const bin = path.join(root, "bin");
	const agents = path.join(root, ".pi", "agent", "swival-agents");
	for (const dir of [source, artifacts, bin, agents]) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(source, "swival.toml"), "oneshot_commands = true\n");
	for (const delivery of ["argv", "stdin"]) fs.writeFileSync(path.join(agents, `${delivery}.md`), [
		"---", `name: ${delivery}`, "description: Offline plain-text delivery fixture",
		"files: none", "commands: none", ...(delivery === "stdin" ? ["sandbox: builtin"] : []),
		"---", "",
	].join("\n"));
	// Transport only is stubbed. The released Swival parser classifies the actual
	// argv/stdin payload under an ambient oneshot_commands=true configuration.
	fs.writeFileSync(path.join(bin, "swival"), `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.0.46'); process.exit(0); }
const index = args.indexOf('--');
const delivery = index >= 0 && index + 1 < args.length ? 'argv' : 'stdin';
const payload = delivery === 'argv' ? args[index + 1] : fs.readFileSync(0, 'utf8');
const detection = JSON.parse(execFileSync(${JSON.stringify(python)},
 ['-I', '-B', '-c', ${JSON.stringify(DETECTOR)}], {
 input: JSON.stringify({cwd:process.cwd(), payload}), timeout:5000, maxBuffer:65536,
}));
fs.appendFileSync(path.join(process.cwd(), 'deliveries.jsonl'),
 JSON.stringify({delivery, payload, ...detection}) + '\\n');
fs.writeFileSync(args[args.indexOf('--report') + 1], JSON.stringify({
 result:{outcome:detection.script ? 'failed' : 'success',
         exit_code:0, answer:${JSON.stringify(ANSWER)}}, stats:{review_rounds:0},
}));
console.log(${JSON.stringify(ANSWER)});
`, { mode: 0o755 });
	process.env.HOME = root;
	process.env.XDG_CONFIG_HOME = path.join(root, "config");
	process.env.PATH = `${bin}:${original.PATH ?? ""}`;
	resetSwivalVersionCache();
	registerExtension({ registerTool: (registered: any) => { tool = registered; } } as any,
		{ artifactRoot: artifacts, nativePython: python });
});

afterEach(() => {
	for (const [key, value] of Object.entries(original)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	resetSwivalVersionCache();
	fs.rmSync(root, { recursive: true, force: true });
});

const call = (params: any) => tool.execute("plain-task", params, undefined, undefined,
	{ cwd: source, hasUI: false });
const deliveries = () => fs.readFileSync(path.join(source, "deliveries.jsonl"), "utf8")
	.trim().split("\n").map((line) => JSON.parse(line));

async function completedStatus(id: string) {
	for (let tries = 0; tries < 200; tries++) {
		const result = await call({ action: "status", id });
		if (!result.content[0].text.includes("still running")) return result;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Offline async delivery did not finish within its test budget.");
}

describe("ordinary task delivery never becomes a released command script", () => {
	it("proves the released detector recognizes unprefixed slash and bang scripts", () => {
		for (const payload of ["/audit code.py", "!custom", "\n /audit code.py\n!custom"]) {
			const detection = JSON.parse(execFileSync(python, ["-I", "-B", "-c", DETECTOR], {
				input: JSON.stringify({ cwd: source, payload }), timeout: 5000, maxBuffer: 65536,
			}).toString());
			expect(detection).toMatchObject({ script: true, plain: false });
		}
	});

	const tasks = ["/audit code.py", "!custom", "\n /audit code.py\n!custom\nReview literal lines.",
		"Review literal lines.\n/audit code.py\n!custom"];
	const cases = [false, true].flatMap((async) => ["argv", "stdin"].flatMap((delivery) =>
		tasks.map((task, index) => ({ async, delivery, task, index }))));
	it.each(cases)("keeps task $index plain through $delivery (async=$async)", async (input) => {
		let result = await call({ agent: input.delivery, task: input.task, async: input.async });
		expect(result.isError, result.content[0].text).not.toBe(true);
		if (input.async) {
			const runDir = path.join(artifacts, fs.readdirSync(artifacts)[0]);
			const meta = JSON.parse(fs.readFileSync(path.join(runDir, "run-meta.json"), "utf8"));
			expect(meta.task).toBe(input.task);
			result = await completedStatus(meta.runId);
			if (input.delivery === "stdin") {
				expect(fs.readFileSync(path.join(runDir, "task.txt"), "utf8")).toBe(HEADING + input.task);
			}
		}
		expect(result.isError, result.content[0].text).not.toBe(true);
		if (!input.async) expect(result.details.results[0].task).toBe(input.task);
		expect(deliveries()).toEqual([{
			delivery: input.delivery, payload: HEADING + input.task, script: false, plain: true,
		}]);
	}, 10000);

	it("prefixes once after chain substitution while preserving original task metadata", async () => {
		const result = await call({ chain: [
			{ agent: "argv", task: "Produce prior text." },
			{ agent: "stdin", task: "{previous}\n/audit next.py" },
		] });
		expect(result.isError, result.content[0].text).not.toBe(true);
		const task = ANSWER + "\n/audit next.py";
		expect(result.details.results[1].task).toBe(task);
		expect(deliveries()).toEqual([
			{ delivery: "argv", payload: HEADING + "Produce prior text.", script: false, plain: true },
			{ delivery: "stdin", payload: HEADING + task, script: false, plain: true },
		]);
	});

	it("keeps parallel slash and bang tasks plain in both delivery modes", async () => {
		const result = await call({ tasks: [
			{ agent: "argv", task: "/audit code.py" }, { agent: "stdin", task: "!custom" },
		] });
		expect(result.isError, result.content[0].text).not.toBe(true);
		expect(deliveries()).toEqual(expect.arrayContaining([
			{ delivery: "argv", payload: HEADING + "/audit code.py", script: false, plain: true },
			{ delivery: "stdin", payload: HEADING + "!custom", script: false, plain: true },
		]));
	});
});
