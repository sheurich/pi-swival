import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { captureAgentYamlWarnings, yamlWarningFixtures } from "./fixtures/agentYamlWarnings.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
import { discoverSwivalAgents } from "../extensions/agents.js";

let root: string;
let userDir: string;
let projectDir: string;
let savedAgentDir: string | undefined;

function write(dir: string, file: string, frontmatter: string): void {
	fs.writeFileSync(path.join(dir, file), `---\n${frontmatter}\n---\nPRIVATE_PROMPT\n`);
}

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swival-discovery-")));
	userDir = path.join(root, "user", "swival-agents");
	projectDir = path.join(root, ".pi", "swival-agents");
	fs.mkdirSync(userDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.dirname(userDir);
});

afterEach(() => {
	vi.restoreAllMocks();
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	fs.rmSync(root, { recursive: true, force: true });
});

describe("discoverSwivalAgents definition isolation", () => {
	it.each(yamlWarningFixtures)("contains $label without emitting source text", async ({ frontmatter }) => {
		write(userDir, "warning.md", frontmatter);
		write(userDir, "valid.md", "name: valid\ndescription: visible sibling");
		const captured = await captureAgentYamlWarnings(() => discoverSwivalAgents(root, "user"));
		expect(captured.emitted.length).toBe(0);
		expect(captured.stderr.length).toBe(0);
		expect(captured.warningEvents).toEqual([]);
		expect(captured.result.agents.some((a) => a.name === "valid")).toBe(true);
		expect(captured.result.diagnostics).toEqual([{ code: "invalid_yaml", source: "user" }]);
		expect(captured.result.dispatchBlocked).toBe(true);
		expect(JSON.stringify(captured.result.diagnostics)).not.toMatch(/C1_|private|unrecognized/);
	});

	it("keeps unrelated process warnings observable and restores capture after failure", async () => {
		const originalEmit = process.emitWarning;
		const originalWrite = process.stderr.write;
		const captured = await captureAgentYamlWarnings(() => {
			process.emitWarning("UNRELATED_SYNTHETIC_WARNING", { code: "C1_CONTROL" });
			return discoverSwivalAgents(root, "user");
		});
		expect(captured.emitted).toContain("UNRELATED_SYNTHETIC_WARNING");
		expect(captured.stderr).toContain("UNRELATED_SYNTHETIC_WARNING");
		expect(captured.warningEvents).toContain("UNRELATED_SYNTHETIC_WARNING");
		expect(captured.result.diagnostics).toEqual([]);
		await expect(captureAgentYamlWarnings(() => { throw new Error("synthetic failure"); }))
			.rejects.toThrow("synthetic failure");
		expect(process.emitWarning).toBe(originalEmit);
		expect(process.stderr.write).toBe(originalWrite);
	});

	it("bounds warning diagnostics while retaining the fail-closed identity state", async () => {
		for (let i = 0; i < 20; i++) write(userDir, `${i}.md`, yamlWarningFixtures[0].frontmatter);
		const captured = await captureAgentYamlWarnings(() => discoverSwivalAgents(root, "user"));
		expect(captured.emitted.length + captured.stderr.length).toBe(0);
		expect(captured.result).toMatchObject({
			diagnosticsTotal: 20, diagnosticsOmitted: 8, dispatchBlocked: true,
		});
		expect(captured.result.diagnostics).toEqual(
			Array.from({ length: 12 }, () => ({ code: "invalid_yaml", source: "user" })),
		);
	});

	it("contains a real YAML parser failure and keeps valid siblings", () => {
		write(projectDir, "broken.md", "name: [unclosed\nPRIVATE_YAML: [");
		write(projectDir, "first.md", "name: first\ndescription: first helper");
		write(projectDir, "second.md", "name: second\ndescription: second helper");

		const result = discoverSwivalAgents(root, "project");
		expect(result.agents.filter((a) => a.source === "project").map((a) => a.name))
			.toEqual(["first", "second"]);
		expect(result.diagnostics).toEqual([{ code: "invalid_yaml", source: "project" }]);
		expect(result.dispatchBlocked).toBe(true);
		expect(JSON.stringify(result.diagnostics)).not.toMatch(/PRIVATE|unclosed|\.md|\//);
	});

	it.each(["false", "42", '"text"', "[one, two]", "- name: array-agent"])(
		"rejects non-object frontmatter: %s", (frontmatter) => {
			write(userDir, "invalid.md", frontmatter);
			write(userDir, "valid.md", "name: valid\ndescription: helper");
			const result = discoverSwivalAgents(root, "user");
			expect(result.agents.some((a) => a.name === "valid")).toBe(true);
			expect(result.diagnostics).toEqual([{ code: "invalid_frontmatter", source: "user" }]);
			expect(result.dispatchBlocked).toBe(true);
		},
	);

	it.each([
		"description: []", "description: ''", "requiresReviewer: []", "sandbox: unknown",
		"maxTurns: {}", "provider: []", "extraArgs: [{toString: false}]",
	])("blocks a same-name bundled fallback for invalid fields: %s", (field) => {
		const description = field.startsWith("description:") ? "" : "description: override\n";
		write(userDir, "override.md", `name: swival\n${description}${field}`);
		const result = discoverSwivalAgents(root, "user");
		expect(result.agents.some((a) => a.name === "swival")).toBe(false);
		expect(result.invalidAgentNames).toContain("swival");
		expect(result.dispatchBlocked).toBe(false);
		expect(result.diagnostics).toEqual([{ code: "invalid_definition", source: "user" }]);
	});

	it("does not use a filename as a malformed definition's identity", () => {
		write(userDir, "swival.md", "description: missing name");
		const result = discoverSwivalAgents(root, "user");
		expect(result.dispatchBlocked).toBe(true);
		expect(result.invalidAgentNames).toEqual([]);
		expect(result.agents.some((a) => a.name === "swival")).toBe(true);
	});

	it("bounds diagnostics without losing unresolved identity state", () => {
		for (let i = 0; i < 30; i++) {
			write(userDir, `${String(i).padStart(2, "0")}.md`, `name: invalid-${i}`);
		}
		write(userDir, "zz-unknown.md", "name: [");
		const result = discoverSwivalAgents(root, "user");
		expect(result.diagnostics).toHaveLength(12);
		expect(result.diagnosticsTotal).toBe(31);
		expect(result.diagnosticsOmitted).toBe(19);
		expect(result.invalidAgentNames).toHaveLength(30);
		expect(result.dispatchBlocked).toBe(true);
	});
});

describe("discoverSwivalAgents exact catalogue identities", () => {
	it.each([
		"ordinary-helper", "alpha beta", "助手 café", "cafe\u0301", "😀 helper",
		"a".repeat(80), "😀".repeat(40), `${"a".repeat(78)}😀`,
	])("admits the exact selector %j without Unicode normalization", (name) => {
		write(userDir, "identity.md", `name: ${JSON.stringify(name)}\ndescription: helper`);
		const result = discoverSwivalAgents(root, "user");
		expect(result.agents.find((a) => a.name === name)).toMatchObject({ name, source: "user" });
		expect(result.diagnostics).toEqual([]);
	});

	it.each([
		"a".repeat(81), "😀".repeat(41), `${"a".repeat(79)}😀`,
		" leading", "trailing ", "alpha  beta", "alpha\tbeta", "alpha\nbeta",
		"alpha\u0000beta", "alpha\u0007beta", "alpha\u007fbeta", "alpha\u0085beta",
		"\u001b[31malpha\u001b[0m", "\u001b]0;alpha\u0007", "alpha\u202ebeta", "alpha\u2066beta",
		"alpha\u00a0beta", "", "   ", "\t\u0007",
	])("rejects a changed or overlong selector and retains its raw identity: %j", (name) => {
		write(userDir, "identity.md", `name: ${JSON.stringify(name)}\ndescription: helper`);
		const result = discoverSwivalAgents(root, "user");
		expect(result.agents.some((a) => a.name === name)).toBe(false);
		expect(result.invalidAgentNames).toEqual([name]);
		expect(result.dispatchBlocked).toBe(false);
		expect(result.diagnostics).toEqual([{ code: "invalid_definition", source: "user" }]);
	});

	it("keeps alpha beta distinct from a rejected alpha  beta override", () => {
		write(userDir, "valid.md", 'name: "alpha beta"\ndescription: original');
		write(projectDir, "invalid.md", 'name: "alpha  beta"\ndescription: override');
		const result = discoverSwivalAgents(root, "both");
		expect(result.agents.find((a) => a.name === "alpha beta")).toMatchObject({ source: "user" });
		expect(result.agents.some((a) => a.name === "alpha  beta")).toBe(false);
		expect(result.invalidAgentNames).toEqual(["alpha  beta"]);
	});

	it("blocks the raw whitespace identity of an invalid higher-priority override", () => {
		write(userDir, "lower.md", 'name: "  "\ndescription: lower');
		write(projectDir, "higher.md", 'name: "  "\ndescription: []');
		const result = discoverSwivalAgents(root, "both");
		expect(result.agents.some((a) => a.name === "  ")).toBe(false);
		expect(result.invalidAgentNames).toEqual(["  "]);
		expect(result.dispatchBlocked).toBe(false);
	});
});

describe("discoverSwivalAgents frontmatter compatibility", () => {
	it.each(["----", "---suffix", "--- ", "---\t"])(
		"rejects an opening delimiter that is not a whole --- line: %j", (delimiter) => {
			fs.writeFileSync(path.join(userDir, "invalid.md"), [
				delimiter, "name: invalid", "description: helper", "---", "PRIVATE_PROMPT",
			].join("\n"));
			const result = discoverSwivalAgents(root, "user");
			expect(result.agents.some((a) => a.name === "invalid")).toBe(false);
			expect(result.diagnostics).toEqual([{ code: "invalid_definition", source: "user" }]);
			expect(result.dispatchBlocked).toBe(true);
		},
	);

	it.each(["----", "---suffix", "--- ", "---\t"])(
		"rejects a closing delimiter that is not a whole --- line: %j", (delimiter) => {
			fs.writeFileSync(path.join(userDir, "invalid.md"), [
				"---", "name: invalid", "description: helper", delimiter, "PRIVATE_PROMPT",
			].join("\n"));
			const result = discoverSwivalAgents(root, "user");
			expect(result.agents.some((a) => a.name === "invalid")).toBe(false);
			expect(result.diagnostics).toEqual([{ code: "invalid_definition", source: "user" }]);
			expect(result.dispatchBlocked).toBe(true);
		},
	);

	it("accepts an exact closing delimiter at end of file", () => {
		fs.writeFileSync(path.join(userDir, "compatible.md"),
			"---\nname: compatible\ndescription: helper\n---");
		const result = discoverSwivalAgents(root, "user");
		expect(result.diagnostics).toEqual([]);
		expect(result.agents.find((a) => a.name === "compatible"))
			.toMatchObject({ systemPrompt: "" });
	});

	it.each(["\n", "\r\n", "\r"])("preserves BOM, newline and trimmed-body semantics for %j", (newline) => {
		fs.writeFileSync(path.join(userDir, "compatible.md"), [
			"\ufeff---", "name: compatible", "description: helper", "---", "", " First line", "", "Last line  ", "",
		].join(newline));
		expect(discoverSwivalAgents(root, "user").agents.find((a) => a.name === "compatible"))
			.toMatchObject({ systemPrompt: "First line\n\nLast line" });
	});

	it("preserves YAML scalars, block strings, collections and ordinary aliases", () => {
		write(userDir, "compatible.md", [
			"name: compatible", "description: >", "  folded helper", "  description",
			"flag: &flag true", "selfReview: *flag", 'requiresReviewer: "yes"',
			'maxTurns: "12"', "temperature: 0.5", 'extraArgs: ["--fixture", "literal:value"]',
			"network: none", "unused: {nested: [one, two]}",
		].join("\n"));
		const result = discoverSwivalAgents(root, "user");
		expect(result.diagnostics).toEqual([]);
		expect(result.agents.find((a) => a.name === "compatible")).toMatchObject({
			description: "folded helper description\n", selfReview: true, requiresReviewer: true,
			maxTurns: 12, temperature: 0.5, extraArgs: ["--fixture", "literal:value"], network: "none",
		});
	});

	it("contains conversion warnings for collection keys without changing ordinary YAML values", async () => {
		write(userDir, "compatible.md", [
			"name: compatible", "description: helper", "? [C1_RAW_YAML, /private/C1_PATH]", ": C1_COMMAND",
		].join("\n"));
		const captured = await captureAgentYamlWarnings(() => discoverSwivalAgents(root, "user"));
		expect(captured.emitted.length + captured.stderr.length).toBe(0);
		expect(captured.result.diagnostics).toEqual([]);
		expect(captured.result.agents.some((a) => a.name === "compatible")).toBe(true);
	});

	it.each(["name: no-frontmatter\ndescription: helper", "---\nname: no-closing-marker\ndescription: helper"])(
		"keeps absent or unclosed frontmatter outside YAML parsing: %j", (content) => {
			fs.writeFileSync(path.join(userDir, "plain.md"), content);
			const result = discoverSwivalAgents(root, "user");
			expect(result.diagnostics).toEqual([{ code: "invalid_definition", source: "user" }]);
			expect(result.dispatchBlocked).toBe(true);
		},
	);

	it.each([
		["duplicate keys", "name: swival\nname: duplicate\ndescription: rejected"],
		["multiple documents", "name: swival\ndescription: rejected\n...\nname: second\ndescription: rejected"],
		["unresolved aliases", "name: swival\ndescription: *absent"],
		["excessive aliases", "name: swival\ndescription: rejected\nseed: &seed [x]\n" +
			`first: &first [${Array(10).fill("*seed").join(", ")}]\n` +
			`second: [${Array(11).fill("*first").join(", ")}]`],
	])("fails closed for %s", (_label, frontmatter) => {
		write(userDir, "invalid.md", frontmatter);
		write(userDir, "valid.md", "name: valid\ndescription: visible sibling");
		const result = discoverSwivalAgents(root, "user");
		expect(result.diagnostics).toEqual([{ code: "invalid_yaml", source: "user" }]);
		expect(result.dispatchBlocked).toBe(true);
		expect(result.agents.some((a) => a.name === "valid")).toBe(true);
	});
});

describe("discoverSwivalAgents precedence and containment", () => {
	it("keeps scope precedence, reviewer inheritance and deterministic name order", () => {
		write(userDir, "one.md", "name: swival\ndescription: user override\nrequiresReviewer: true");
		write(projectDir, "one.md", "name: swival\ndescription: project override\nrequiresReviewer: false");
		write(projectDir, "02.md", "name: zebra\ndescription: last");
		write(projectDir, "03.md", "name: alpha\ndescription: first");
		expect(discoverSwivalAgents(root, "user").agents.find((a) => a.name === "swival")?.source)
			.toBe("user");
		const result = discoverSwivalAgents(root, "both");
		expect(result.agents.find((a) => a.name === "swival"))
			.toMatchObject({ source: "project", description: "project override", requiresReviewer: true });
		expect(result.agents.map((a) => a.name)).toEqual(result.agents.map((a) => a.name).sort());
	});

	it("lets a valid higher-priority definition replace an identifiable invalid lower one", () => {
		write(userDir, "override.md", "name: test-runner");
		write(projectDir, "override.md", "name: test-runner\ndescription: repaired");
		const result = discoverSwivalAgents(root, "both");
		expect(result.agents.find((a) => a.name === "test-runner"))
			.toMatchObject({ source: "project", requiresReviewer: true });
		expect(result.invalidAgentNames).not.toContain("test-runner");
	});

	it("rejects invalid project overrides instead of selecting a valid user definition", () => {
		write(userDir, "trusted.md", "name: shared\ndescription: user helper");
		write(projectDir, "invalid.md", "name: shared\ndescription: {} ");
		write(projectDir, "valid.md", "name: sibling\ndescription: valid sibling");
		const result = discoverSwivalAgents(root, "both");
		expect(result.agents.some((a) => a.name === "shared")).toBe(false);
		expect(result.agents.some((a) => a.name === "sibling")).toBe(true);
		expect(result.invalidAgentNames).toContain("shared");
	});

	it("excludes outside-directory symlinks without reading their targets or blocking dispatch", () => {
		write(root, "outside.md", "name: swival\ndescription: untrusted target");
		const outside = path.join(root, "outside.md");
		fs.symlinkSync(outside, path.join(userDir, "outside.md"));
		const reads = vi.mocked(fs.readFileSync).mockClear();
		const result = discoverSwivalAgents(root, "user");
		expect(result.diagnostics).toEqual([{ code: "outside_directory", source: "user" }]);
		expect(result.dispatchBlocked).toBe(false);
		expect(result.agents.find((a) => a.name === "swival")?.source).toBe("bundled");
		expect(reads).toHaveBeenCalled();
		expect(reads.mock.calls.some(([file]) => file === outside)).toBe(false);
	});

	it("contains symlinks and returns safe diagnostics for outside or broken targets", () => {
		write(userDir, "inside.md", "name: inside\ndescription: allowed");
		fs.symlinkSync(path.join(userDir, "inside.md"), path.join(userDir, "alias.md"));
		write(root, "outside.md", "name: outside\ndescription: forbidden");
		fs.symlinkSync(path.join(root, "outside.md"), path.join(userDir, "outside.md"));
		fs.symlinkSync(path.join(root, "absent.md"), path.join(userDir, "broken.md"));
		const result = discoverSwivalAgents(root, "user");
		expect(result.agents.some((a) => a.name === "inside")).toBe(true);
		expect(result.agents.some((a) => a.name === "outside")).toBe(false);
		expect(result.diagnostics).toEqual([
			{ code: "unreadable_definition", source: "user" },
			{ code: "outside_directory", source: "user" },
		]);
		expect(result.dispatchBlocked).toBe(true);
	});
});
