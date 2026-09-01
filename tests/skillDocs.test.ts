import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(TEST_DIR, "..");
const SKILLS_DIR = join(PACKAGE_ROOT, "skills");
const SWIVAL_SKILL_DIR = join(SKILLS_DIR, "swival");
const SWIVAL_SKILL = join(SWIVAL_SKILL_DIR, "SKILL.md");
const SETUP_DOC = join(SWIVAL_SKILL_DIR, "references", "setup.md");
const AUDIT_SKILL_DIR = join(SKILLS_DIR, "auditing-with-swival");
const AUDIT_SKILL = join(AUDIT_SKILL_DIR, "SKILL.md");
const AGENTS_DIR = join(PACKAGE_ROOT, "agents");

const SWIVAL_VERSION = "1.0.40";

function read(file: string): string {
	return readFileSync(file, "utf8");
}

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.isFile()) out.push(full);
	}
	return out;
}

/** Every file users read for setup guidance. */
function documentationFiles(): string[] {
	return [
		join(PACKAGE_ROOT, "README.md"),
		join(PACKAGE_ROOT, "examples", "demo.md"),
		...walk(SKILLS_DIR),
	];
}

function bundledAgentNames(): string[] {
	return readdirSync(AGENTS_DIR)
		.filter((name) => name.endsWith(".md"))
		.map((name) => name.replace(/\.md$/, ""))
		.sort();
}

/** Fenced code blocks tagged `toml`, returned as raw block bodies. */
function tomlBlocks(markdown: string): string[] {
	return [...markdown.matchAll(/^```toml\n([\s\S]*?)^```/gm)].map((m) => m[1]);
}

/** The rows of the `### Agent selection` table in the swival SKILL.md. */
function agentSelectionSection(markdown: string): string {
	const start = markdown.indexOf("### Agent selection");
	expect(start, "SKILL.md should have an '### Agent selection' section").toBeGreaterThan(-1);
	const rest = markdown.slice(start + "### Agent selection".length);
	const next = rest.search(/^#{2,3} /m);
	return next === -1 ? rest : rest.slice(0, next);
}

const OBSOLETE_PROXY_PATTERNS: Array<[string, RegExp]> = [
	["LiteLLM proxy guidance", /litellm\s+proxy|litellm\[proxy/i],
	["swival-proxy", /swival-proxy/i],
	["LiteLLM proxy config", /\.config\/litellm\/config\.ya?ml/i],
	["synthetic proxy key", /sk-unused/i],
	["proxy port 4000", /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):4000/],
];

describe("documentation is free of obsolete proxy artifacts", () => {
	it.each(OBSOLETE_PROXY_PATTERNS)("no %s reference in user documentation", (label, pattern) => {
		const offenders = documentationFiles()
			.filter((file) => pattern.test(read(file)))
			.map((file) => relative(PACKAGE_ROOT, file));
		expect(offenders, `${label} still referenced`).toEqual([]);
	});

	it("the skill ships no scripts directory at all", () => {
		const scripts = join(SWIVAL_SKILL_DIR, "scripts");
		expect(existsSync(scripts) && statSync(scripts).isDirectory() ? readdirSync(scripts) : []).toEqual([]);
	});
});

describe("setup.md documents native provider routing", () => {
	const setup = () => read(SETUP_DOC);

	it("documents native Bedrock", () => {
		expect(setup()).toContain('provider = "bedrock"');
	});

	it("documents native Vertex with project and location", () => {
		const blocks = tomlBlocks(setup()).filter((b) => b.includes('provider = "vertexai"'));
		expect(blocks.length, 'a toml block should set provider = "vertexai"').toBeGreaterThan(0);
		for (const block of blocks) {
			expect(block).toMatch(/^project\s*=/m);
			expect(block).toMatch(/^location\s*=/m);
			expect(/api_key/.test(block), "Vertex profiles reject api_key").toBe(false);
		}
	});

	it("never shows api_key outside a named local profile", () => {
		const offenders = tomlBlocks(setup()).filter(
			(block) => /api_key/.test(block) && !/^\[profiles\.[^\]]+\]/m.test(block),
		);
		expect(offenders, "global api_key breaks bedrock and vertexai").toEqual([]);
	});

	it("warns that bedrock rejects api_key", () => {
		expect(setup()).toMatch(/api_key[\s\S]{0,200}bedrock|bedrock[\s\S]{0,200}api_key/i);
	});

	it("keeps generic-provider guidance for direct local servers", () => {
		const blocks = tomlBlocks(setup()).filter((b) => b.includes('provider = "generic"'));
		expect(blocks.length, "local OpenAI-compatible servers still use generic").toBeGreaterThan(0);
	});
});

describe("swival SKILL.md preserves package mechanics", () => {
	const skill = () => read(SWIVAL_SKILL);

	it(`tracks Swival ${SWIVAL_VERSION}`, () => {
		expect(skill()).toContain(`Tracked against Swival ${SWIVAL_VERSION}.`);
	});

	it("documents the bundled agent path relative to the loaded skill", () => {
		expect(skill()).toContain("../../agents/<name>.md");
	});

	it.each([
		["discovery priority", /project\s*>\s*user\s*>\s*bundled/],
		["requiresReviewer", /requiresReviewer/],
		["noSandboxAutoSession", /noSandboxAutoSession/],
		["no-inheritance rule", /do not inherit/i],
		["nested-invocation hygiene", /nested-invocation hygiene/i],
	])("documents %s", (_label, pattern) => {
		expect(skill()).toMatch(pattern);
	});

	it("names every bundled agent in the selection table", () => {
		const section = agentSelectionSection(skill());
		for (const name of bundledAgentNames()) {
			expect(section, `selection table should list ${name}`).toContain(`\`${name}\``);
		}
	});

	it("covers all seven bundled agents", () => {
		expect(bundledAgentNames()).toHaveLength(7);
	});

	it("stays under 500 lines", () => {
		expect(skill().split("\n").length).toBeLessThan(500);
	});
});

describe("auditing-with-swival points at the bundled audit-worker", () => {
	const skill = () => read(AUDIT_SKILL);

	it("uses the bundled relative source path", () => {
		expect(skill()).toContain("../../agents/audit-worker.md");
	});

	it("drops the stale user-scope source pointer", () => {
		expect(skill().includes("~/.pi/agent/swival-agents/audit-worker.md")).toBe(false);
	});

	it("keeps the noSandboxAutoSession guidance", () => {
		expect(skill()).toContain("noSandboxAutoSession: true");
	});
});

describe("documented bundled agent paths resolve on disk", () => {
	it.each([
		["skills/swival/SKILL.md", SWIVAL_SKILL, SWIVAL_SKILL_DIR],
		["skills/auditing-with-swival/SKILL.md", AUDIT_SKILL, AUDIT_SKILL_DIR],
	])("%s", (_label, file, skillDir) => {
		const refs = [...read(file).matchAll(/\.\.\/\.\.\/agents\/([a-z0-9-]+)\.md/g)].map((m) => m[1]);
		for (const name of refs) {
			expect(existsSync(resolve(skillDir, "..", "..", "agents", `${name}.md`)), `${name} should exist`).toBe(true);
		}
	});
});
