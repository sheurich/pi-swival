import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { captureAgentYamlWarnings, yamlWarningFixtures } from "./fixtures/agentYamlWarnings.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
import { spawn } from "node:child_process";
import registerExtension from "../extensions/index.js";
import { discoverSwivalAgents } from "../extensions/agents.js";

let root: string;
let userDir: string;
let projectDir: string;
let artifactRoot: string;
let tool: any;
let savedAgentDir: string | undefined;

function write(dir: string, file: string, frontmatter: string): void {
	fs.writeFileSync(path.join(dir, file), `---\n${frontmatter}\n---\nPRIVATE_PROMPT\n`);
}

function execute(params: Record<string, unknown>): Promise<any> {
	return tool.execute("catalogue-test", params, undefined, undefined, {
		cwd: root, hasUI: true, ui: { confirm: vi.fn(() => { throw new Error("Unexpected confirmation"); }) },
	});
}

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swival-catalogue-")));
	userDir = path.join(root, "user", "swival-agents");
	projectDir = path.join(root, ".pi", "swival-agents");
	artifactRoot = path.join(root, "artifacts");
	fs.mkdirSync(userDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	fs.mkdirSync(artifactRoot);
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.dirname(userDir);
	vi.mocked(spawn).mockReset().mockImplementation(() => { throw new Error("Unexpected child process"); });
	registerExtension({ registerTool: (candidate: any) => { tool = candidate; } } as any, { artifactRoot });
});

afterEach(() => {
	vi.restoreAllMocks();
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	fs.rmSync(root, { recursive: true, force: true });
});

describe("swival-subagent action:list", () => {
	it.each(yamlWarningFixtures)("contains $label without leaking source or launching", async ({ frontmatter }) => {
		write(userDir, "warning.md", frontmatter);
		write(userDir, "valid.md", "name: valid\ndescription: visible sibling");
		const captured = await captureAgentYamlWarnings(() => execute({ action: "list" }));
		expect(captured.emitted.length + captured.stderr.length).toBe(0);
		expect(captured.warningEvents).toEqual([]);
		expect(captured.result.details).toMatchObject({
			mode: "list", schemaVersion: 1, dispatchBlocked: true,
			diagnostics: [{ code: "invalid_yaml", source: "user" }],
			diagnosticsTotal: 1, diagnosticsOmitted: 0,
		});
		expect(captured.result.details.agents.some((a: any) => a.name === "valid")).toBe(true);
		expect(JSON.stringify(captured.result)).not.toMatch(/C1_|private|unrecognized|warning\.md/);
		expect(JSON.stringify(captured.result)).not.toContain(root);
		expect(spawn).not.toHaveBeenCalled();
		expect(fs.readdirSync(artifactRoot)).toEqual([]);
	});

	it("bounds warning diagnostics without emitting omitted source text", async () => {
		for (let i = 0; i < 20; i++) write(userDir, `${i}.md`, yamlWarningFixtures[0].frontmatter);
		const captured = await captureAgentYamlWarnings(() => execute({ action: "list" }));
		expect(captured.emitted.length + captured.stderr.length).toBe(0);
		expect(captured.result.details).toMatchObject({
			mode: "list", schemaVersion: 1, diagnosticsTotal: 20, diagnosticsOmitted: 8, dispatchBlocked: true,
		});
		expect(captured.result.details.diagnostics).toHaveLength(12);
		expect(captured.result.content[0].text.length).toBeLessThanOrEqual(8192);
		expect(JSON.stringify(captured.result)).not.toMatch(/C1_|private|unrecognized/);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("adds list to the existing tool and returns a versioned bounded catalogue without id", async () => {
		expect(tool.name).toBe("swival-subagent");
		expect(tool.parameters.properties.action.enum).toContain("list");
		const result = await execute({ action: "list" });
		expect(result.isError).not.toBe(true);
		expect(result.details).toMatchObject({
			mode: "list", schemaVersion: 1, agentScope: "user", omitted: 0,
			diagnostics: [], diagnosticsTotal: 0, diagnosticsOmitted: 0, dispatchBlocked: false,
		});
		expect(result.details.total).toBe(result.details.agents.length);
		expect(result.details.agents.find((a: any) => a.name === "test-runner"))
			.toMatchObject({ reviewer: { required: true } });
		expect(result.content[0].text).toMatch(/runtime.*unknown/i);
	});

	it("exposes only capability metadata, not prompts, routing, commands or paths", async () => {
		write(userDir, "helper.md", [
			"name: helper", "description: Short helper description", "requiresReviewer: true",
			"selfReview: true", "reviewer: PRIVATE_REVIEW_COMMAND", "verify: PRIVATE_VERIFY",
			"commands: PRIVATE_COMMAND", "commandMiddleware: PRIVATE_MIDDLEWARE",
			"provider: PRIVATE_PROVIDER", "profile: PRIVATE_PROFILE", "baseUrl: https://private.invalid",
			"baseDir: /private/fixture", "extraArgs: [PRIVATE_EXTRA]", "sandbox: agentfs", "network: none",
		].join("\n"));
		const result = await execute({ action: "list" });
		const row = result.details.agents.find((a: any) => a.name === "helper");
		expect(row).toEqual({
			name: "helper", description: "Short helper description", source: "user",
			reviewer: { required: true, selfReview: true, externalReviewer: true },
			configured: { sandbox: "agentfs", network: "none" }, effectiveRuntime: "unknown",
			modes: ["single", "parallel", "chain"], async: "single-only",
			controls: { status: true, resume: "completed-output-only", interrupt: "same-process-only", liveSteering: false },
		});
		expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|private\.invalid|\/private\/fixture|filePath|systemPrompt/);
		expect(JSON.stringify(result)).not.toContain(root);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("does not claim missing configuration is an effective runtime guarantee", async () => {
		write(userDir, "plain.md", "name: plain\ndescription: plain helper");
		const result = await execute({ action: "list" });
		expect(result.details.agents.find((a: any) => a.name === "plain")).toMatchObject({
			reviewer: { required: false, selfReview: "unknown", externalReviewer: "unknown" },
			configured: { sandbox: "unknown", network: "unknown" }, effectiveRuntime: "unknown",
		});
		expect(result.content[0].text).toMatch(/async.*single.only/i);
		expect(result.content[0].text).toMatch(/resume.*completed.*output/i);
		expect(result.content[0].text).toMatch(/steering.*unsupported/i);
		expect(result.content[0].text).toMatch(/interrupt.*same.process/i);
	});

	it("caps rows, descriptions and text, with exact omitted counts and stable order", async () => {
		for (let i = 39; i >= 0; i--) {
			write(userDir, `${40 - i}.md`, `name: agent-${String(i).padStart(2, "0")}-${"n".repeat(71)}\ndescription: ${"d".repeat(1000)}`);
		}
		const result = await execute({ action: "list" });
		const total = discoverSwivalAgents(root, "user").agents.length;
		expect(result.details.total).toBe(total);
		expect(result.details.agents).toHaveLength(20);
		expect(result.details.omitted).toBe(total - 20);
		const names = result.details.agents.map((a: any) => a.name);
		expect(names).toEqual([...names].sort());
		for (const row of result.details.agents) {
			expect(row.name.length).toBeLessThanOrEqual(80);
			expect(row.description.length).toBeLessThanOrEqual(160);
		}
		expect(result.content[0].text.length).toBeLessThanOrEqual(8192);
		expect(result.content[0].text).toContain(`${total - 20} omitted`);
		expect((await execute({ action: "list" })).details).toEqual(result.details);
	});

	it.each([
		"ordinary-helper", "alpha beta", "助手 café", "cafe\u0301",
		"a".repeat(80), "😀".repeat(40), `${"a".repeat(78)}😀`,
	])("lists the exact admitted selector %j", async (name) => {
		write(userDir, "identity.md", `name: ${JSON.stringify(name)}\ndescription: helper`);
		const result = await execute({ action: "list" });
		expect(result.details.agents.find((a: any) => a.name === name)).toMatchObject({ name, source: "user" });
		expect(result.content[0].text).toContain(`${name} (user):`);
		expect(spawn).not.toHaveBeenCalled();
	});

	it.each([
		"a".repeat(81), `${"a".repeat(79)}😀`, "😀".repeat(41),
		" leading", "trailing ", "alpha  beta", "alpha\tbeta", "alpha\u0007beta",
		"\u001b[31malpha\u001b[0m", "   ",
	])("omits invalid selectors without silently renaming them: %j", async (name) => {
		write(userDir, "valid.md", 'name: "alpha beta"\ndescription: valid sibling');
		write(projectDir, "invalid.md", `name: ${JSON.stringify(name)}\ndescription: invalid override`);
		const result = await execute({ action: "list", agentScope: "both" });
		expect(result.details.agents.filter((a: any) => a.source !== "bundled"))
			.toEqual([expect.objectContaining({ name: "alpha beta", source: "user" })]);
		expect(result.details).toMatchObject({
			dispatchBlocked: false, diagnostics: [{ code: "invalid_definition", source: "project" }],
		});
		expect(JSON.stringify(result)).not.toContain("invalid override");
		expect(spawn).not.toHaveBeenCalled();
		expect(fs.readdirSync(artifactRoot)).toEqual([]);
	});

	it("removes control characters from catalogue display fields", async () => {
		write(userDir, "display.md", 'name: display\ndescription: "one\\nline\\u001b[31m\\u0007"');
		const result = await execute({ action: "list" });
		const row = result.details.agents.find((a: any) => a.name === "display");
		expect(row.description).not.toMatch(/[\x00-\x1f\x7f]/);
		expect(row.description).toContain("one line");
	});

	it("honors cwd and scope while preserving sanitized project metadata and reviewer inheritance", async () => {
		write(userDir, "helper.md", "name: swival\ndescription: user\nrequiresReviewer: true");
		write(projectDir, "helper.md", "name: swival\ndescription: project\nnetwork: full\nsandbox: nono");
		const nested = path.join(root, "nested");
		fs.mkdirSync(nested);
		const result = await execute({ action: "list", cwd: nested, agentScope: "both" });
		expect(result.details.agents.find((a: any) => a.name === "swival")).toMatchObject({
			source: "project", description: "project", reviewer: { required: true },
			configured: { sandbox: "agentfs", network: "unknown" },
		});
		expect((await execute({ action: "list", agentScope: "user" })).details.agents
			.find((a: any) => a.name === "swival").source).toBe("user");
	});

	it("never spawns, probes, writes, prunes artifacts or asks for confirmation", async () => {
		write(projectDir, "local.md", "name: local\ndescription: repo helper");
		const stale = path.join(artifactRoot, "old-artifact");
		fs.mkdirSync(stale);
		fs.utimesSync(stale, 0, 0);
		const mutations = ["mkdir", "writeFile", "rm", "unlink", "chmod", "rename"] as const;
		const spies = mutations.map((method) => vi.spyOn(fs.promises, method));
		const artifactReads = vi.spyOn(fs.promises, "readdir");
		const result = await execute({ action: "list", agentScope: "project" });
		await new Promise((resolve) => setImmediate(resolve));
		expect(result.isError).not.toBe(true);
		expect(spawn).not.toHaveBeenCalled();
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		expect(artifactReads).not.toHaveBeenCalled();
		expect(fs.existsSync(stale)).toBe(true);
	});

	it("rejects every dispatch or control field, even when false, empty or unknown", async () => {
		const fields = Object.keys(tool.parameters.properties)
			.filter((key) => !["action", "agentScope", "cwd"].includes(key));
		for (const field of [...fields, "unrecognized"]) {
			const result = await execute({ action: "list", [field]: false });
			expect(result.isError, field).toBe(true);
			expect(result.content[0].text, field).toMatch(/list.*cannot be combined/i);
		}
		for (const params of [{ tasks: [] }, { chain: [] }, { task: "" }, { id: "" }]) {
			expect((await execute({ action: "list", ...params })).isError).toBe(true);
		}
		expect(spawn).not.toHaveBeenCalled();
	});

	it("lists valid siblings and bounded fixed diagnostics when parsing fails", async () => {
		write(userDir, "broken.md", "name: [\nPRIVATE_YAML: [");
		write(userDir, "valid.md", "name: valid\ndescription: visible helper");
		const result = await execute({ action: "list" });
		expect(result.isError).not.toBe(true);
		expect(result.details.agents.some((a: any) => a.name === "valid")).toBe(true);
		expect(result.details).toMatchObject({
			dispatchBlocked: true, diagnostics: [{ code: "invalid_yaml", source: "user" }],
		});
		expect(result.content[0].text).toMatch(/invalid_yaml/);
		expect(JSON.stringify(result)).not.toMatch(/PRIVATE|YAMLParseError|broken\.md/);
		expect(JSON.stringify(result)).not.toContain(root);
	});

	it("renders list calls and results without changing dispatch rendering", async () => {
		const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
		const result = await execute({ action: "list" });
		expect(tool.renderCall({ action: "list" }, theme, {}).render(120).join("\n")).toContain("list");
		for (const expanded of [false, true]) {
			expect(() => tool.renderResult(result, { expanded }, theme, {}).render(120)).not.toThrow();
		}
		for (const mode of ["single", "parallel", "chain"]) {
			expect(() => tool.renderResult({ content: [], details: {
				mode, results: [{ agent: "plain", task: "task", exitCode: 0,
					finalOutput: "", stderrTail: [], report: { outcome: "success" } }],
			} }, { expanded: false }, theme, {}).render(120)).not.toThrow();
		}
	});
});

const modes = [
	["single", { agent: "valid", task: "task" }],
	["chain", { chain: [{ agent: "valid", task: "one" }, { agent: "swival", task: "two" }] }],
	["parallel", { tasks: [{ agent: "valid", task: "one" }, { agent: "swival", task: "two" }] }],
	["async", { agent: "swival", task: "task", async: true }],
] as const;

describe("discovery dispatch validation", () => {
	it.each(["alpha  beta", "   ", "alpha\tbeta", "alpha\u0007beta", "a".repeat(81)])(
		"blocks the exact invalid identity before launch: %j", async (name) => {
			write(userDir, "lower.md", `name: ${JSON.stringify(name)}\ndescription: lower`);
			write(projectDir, "higher.md", `name: ${JSON.stringify(name)}\ndescription: []`);
			const result = await execute({ agent: name, task: "task", agentScope: "both" });
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/invalid agent definition shadows a requested name/i);
			expect(spawn).not.toHaveBeenCalled();
		},
	);

	it("blocks an invalid same-name project override instead of launching the listed user definition", async () => {
		write(userDir, "custom.md", 'name: "alpha beta"\ndescription: user helper\nfiles: none\ncommands: none');
		const listed = await execute({ action: "list" });
		const name = listed.details.agents.find((a: any) => a.source === "user").name;
		write(projectDir, "custom.md", `name: ${JSON.stringify(name)}\ndescription: []`);
		const result = await execute({ agent: name, task: "task", agentScope: "both" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/invalid agent definition shadows a requested name/i);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("dispatches a listed normal custom selector using its higher-priority repair's prompt and config", async () => {
		write(userDir, "custom.md", 'name: "alpha beta"\ndescription: broken lower\nmaxTurns: []');
		fs.writeFileSync(path.join(projectDir, "custom.md"), [
			"---", 'name: "alpha beta"', "description: repaired helper", "files: none", "commands: none",
			"maxTurns: 17", "temperature: 0.25", "---", "SELECTED_REPAIR_PROMPT",
		].join("\n"));
		const listed = await execute({ action: "list", agentScope: "both" });
		const row = listed.details.agents.find((a: any) => a.name === "alpha beta");
		expect(row).toMatchObject({ source: "project" });
		expect(spawn).not.toHaveBeenCalled();
		const launches: string[][] = [];
		vi.mocked(spawn).mockImplementation(((_exe: string, args: string[], options: any) => {
			const proc: any = new EventEmitter();
			proc.stdout = new PassThrough();
			proc.stderr = new PassThrough();
			proc.stdin = new PassThrough();
			proc.kill = vi.fn();
			if (!args.includes("--version")) {
				launches.push(args);
				expect(options).toMatchObject({ cwd: root, shell: false });
			}
			queueMicrotask(() => {
				if (args.includes("--version")) proc.stdout.write("1.0.45");
				else fs.writeFileSync(args[args.indexOf("--report") + 1], JSON.stringify({
					result: { outcome: "success", answer: "SELECTED_REPAIR_OK", exit_code: 0 },
					sandbox: { mode: "agentfs", agentfs_version: "synthetic-test-version" },
				}));
				proc.stdout.end();
				proc.stderr.end();
				proc.emit("close", 0);
			});
			return proc;
		}) as any);
		const result = await tool.execute("identity-dispatch", {
			agent: row.name, task: "exercise listed selector", agentScope: "both",
		}, undefined, undefined, { cwd: root, hasUI: true, ui: { confirm: vi.fn(async () => true) } });
		expect(result.isError, JSON.stringify(result)).not.toBe(true);
		expect(result.details.results[0]).toMatchObject({ agent: row.name, finalOutput: "SELECTED_REPAIR_OK" });
		expect(launches).toHaveLength(1);
		const args = launches[0];
		expect(args[args.indexOf("--system-prompt") + 1]).toBe("SELECTED_REPAIR_PROMPT");
		expect(args[args.indexOf("--max-turns") + 1]).toBe("17");
		expect(args[args.indexOf("--temperature") + 1]).toBe("0.25");
		expect(args).not.toContain("PRIVATE_PROMPT");
	});
	for (const { label, frontmatter } of yamlWarningFixtures) {
		it.each(modes)(`blocks ${label} before any child process in %s`, async (_mode, params) => {
			write(userDir, "warning.md", frontmatter);
			write(userDir, "valid.md", "name: valid\ndescription: visible helper");
			const captured = await captureAgentYamlWarnings(() => execute(params));
			expect(captured.emitted.length + captured.stderr.length).toBe(0);
			expect(captured.result.isError).toBe(true);
			expect(captured.result.content[0].text).toMatch(/discovery.*invalid_yaml/i);
			expect(JSON.stringify(captured.result)).not.toMatch(/C1_|private|unrecognized/);
			expect(spawn).not.toHaveBeenCalled();
			expect(fs.readdirSync(artifactRoot)).toEqual([]);
		});
	}

	it.each([
		{ agent: "swival", task: "task" },
		{ agent: "swival", task: "task", chain: [], tasks: [] },
		{ task: "task", tasks: [] },
		{ chain: [], tasks: [{ agent: "valid", task: "one" }, { agent: "swival", task: "two" }] },
	])("validates invalid requested names even with inert mode arrays: %j", async (params) => {
		write(userDir, "invalid.md", "name: swival\ndescription: []");
		write(userDir, "valid.md", "name: valid\ndescription: visible helper");
		const result = await execute(params);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/discovery.*invalid.*definition/i);
		expect(spawn).not.toHaveBeenCalled();
	});

	it.each(modes)("fails closed before any child process for unresolved identity in %s", async (_mode, params) => {
		write(userDir, "broken.md", "name: [");
		write(userDir, "valid.md", "name: valid\ndescription: visible helper");
		const result = await execute(params);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/discovery.*invalid_yaml/i);
		expect(result.content[0].text).toMatch(/identity|identities/i);
		expect(spawn).not.toHaveBeenCalled();
		expect(fs.readdirSync(artifactRoot)).toEqual([]);
	});

	it.each(modes.filter(([mode]) => mode !== "single"))(
		"blocks invalid overrides before starting any %s step", async (_mode, params) => {
			write(userDir, "invalid.md", "name: swival\ndescription: []");
			write(userDir, "valid.md", "name: valid\ndescription: visible helper");
			const result = await execute(params);
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/invalid.*definition/i);
			expect(spawn).not.toHaveBeenCalled();
			expect(fs.readdirSync(artifactRoot)).toEqual([]);
		},
	);

	it.each(modes)("preserves valid %s dispatch with an unrelated identifiable invalid sibling", async (_mode, params) => {
		write(userDir, "invalid.md", "name: unrelated\ndescription: []");
		write(root, "excluded.md", "name: swival\ndescription: must stay unread");
		fs.symlinkSync(path.join(root, "excluded.md"), path.join(userDir, "excluded.md"));
		write(userDir, "valid.md", "name: valid\ndescription: helper\nfiles: none\ncommands: none");
		write(userDir, "swival.md", "name: swival\ndescription: helper\nfiles: none\ncommands: none");
		vi.mocked(spawn).mockImplementation(((_exe: string, args: string[]) => {
			const proc: any = new EventEmitter();
			proc.stdout = new PassThrough();
			proc.stderr = new PassThrough();
			proc.stdin = new PassThrough();
			proc.kill = vi.fn();
			proc.unref = vi.fn();
			queueMicrotask(() => {
				if (args.includes("--version")) proc.stdout.write("1.0.45");
				else {
					const reportIndex = args.indexOf("--report");
					fs.writeFileSync(args[reportIndex + 1], JSON.stringify({
						result: { outcome: "success", answer: "OK", exit_code: 0 },
					}));
				}
				proc.stdout.end();
				proc.stderr.end();
				proc.emit("close", 0);
			});
			return proc;
		}) as any);
		const result = await execute(params);
		expect(result.isError).not.toBe(true);
		expect(spawn).toHaveBeenCalled();
	});
});
