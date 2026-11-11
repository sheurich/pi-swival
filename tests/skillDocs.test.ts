import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(TEST_DIR, "..");
const SKILLS_DIR = join(PACKAGE_ROOT, "skills");
const PROMPTS_DIR = join(PACKAGE_ROOT, "prompts");
const AGENTS_DIR = join(PACKAGE_ROOT, "agents");
const SWIVAL_SKILL_DIR = join(SKILLS_DIR, "swival");
const SWIVAL_SKILL = join(SWIVAL_SKILL_DIR, "SKILL.md");
const SETUP_DOC = join(SWIVAL_SKILL_DIR, "references", "setup.md");
const AUDIT_SKILL_DIR = join(SKILLS_DIR, "auditing-with-swival");
const AUDIT_SKILL = join(AUDIT_SKILL_DIR, "SKILL.md");
const BRIEFS_SKILL_DIR = join(SKILLS_DIR, "swival-worker-briefs");
const BRIEFS_SKILL = join(BRIEFS_SKILL_DIR, "SKILL.md");

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
	return out.sort();
}

function documentationFiles(): string[] {
	return [
		join(PACKAGE_ROOT, "README.md"),
		join(PACKAGE_ROOT, "examples", "demo.md"),
		...walk(SKILLS_DIR),
		...walk(PROMPTS_DIR),
	];
}

function bundledAgentNames(): string[] {
	return readdirSync(AGENTS_DIR)
		.filter((name) => name.endsWith(".md"))
		.map((name) => name.replace(/\.md$/, ""))
		.sort();
}

function parseFrontmatter(file: string): Record<string, unknown> {
	const match = read(file).match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
	expect(match, `${relative(PACKAGE_ROOT, file)} must start with YAML frontmatter`).not.toBeNull();
	const doc = parseDocument(match![1]);
	expect(doc.errors, `${relative(PACKAGE_ROOT, file)} YAML errors`).toEqual([]);
	const data = doc.toJS();
	expect(data && typeof data === "object" && !Array.isArray(data)).toBe(true);
	return data as Record<string, unknown>;
}

function fencedBlocks(markdown: string, tag: string): string[] {
	const pattern = new RegExp(`^\`\`\`${tag}\\n([\\s\\S]*?)^\`\`\``, "gm");
	return [...markdown.matchAll(pattern)].map((m) => m[1]);
}

interface ParsedTomlTable {
	header: string | null;
	entries: Record<string, string | number | boolean>;
}

function parseTomlBlock(block: string, label: string): ParsedTomlTable[] {
	const tables: ParsedTomlTable[] = [{ header: null, entries: {} }];
	for (const rawLine of block.split("\n")) {
		const line = rawLine.replace(/#.*$/, "").trim();
		if (!line) continue;
		const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
		if (sectionMatch) {
			tables.push({ header: sectionMatch[1], entries: {} });
			continue;
		}
		const kvMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
		expect(kvMatch, `${label}: invalid TOML line '${rawLine}'`).not.toBeNull();
		const [, key, rawVal] = kvMatch!;
		const current = tables[tables.length - 1]!;
		expect(Object.hasOwn(current.entries, key), `${label}: duplicate key '${key}'`).toBe(false);
		if (/^"[^"]*"$/.test(rawVal)) {
			current.entries[key] = JSON.parse(rawVal) as string;
		} else if (rawVal === "true" || rawVal === "false") {
			current.entries[key] = rawVal === "true";
		} else if (/^-?\d+$/.test(rawVal)) {
			current.entries[key] = Number(rawVal);
		} else {
			throw new Error(`${label}: unsupported TOML value '${rawVal}'`);
		}
	}
	return tables;
}

function agentSelectionSection(markdown: string): string {
	const start = markdown.indexOf("### Agent selection");
	expect(start, "SKILL.md must have an '### Agent selection' section").toBeGreaterThan(-1);
	const rest = markdown.slice(start + "### Agent selection".length);
	const next = rest.search(/^#{2,3} /m);
	return next === -1 ? rest : rest.slice(0, next);
}

describe("YAML frontmatter on skills and prompts", () => {
	const skillDirs = readdirSync(SKILLS_DIR).filter((d) => statSync(join(SKILLS_DIR, d)).isDirectory()).sort();

	it("validates frontmatter on all three packaged skills", () => {
		expect(skillDirs).toEqual(["auditing-with-swival", "swival", "swival-worker-briefs"]);
		for (const dir of skillDirs) {
			const fm = parseFrontmatter(join(SKILLS_DIR, dir, "SKILL.md"));
			expect(fm.name).toBe(dir);
			expect(typeof fm.description === "string" && fm.description.trim().length > 0).toBe(true);
		}
	});

	it("validates frontmatter on prompt templates", () => {
		const promptFiles = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".md")).sort();
		expect(promptFiles).toEqual(["swival-audit.md"]);
		for (const file of promptFiles) {
			const fm = parseFrontmatter(join(PROMPTS_DIR, file));
			expect(typeof fm.description === "string" && fm.description.trim().length > 0).toBe(true);
			for (const key of Object.keys(fm)) {
				expect(["description", "argument-hint"]).toContain(key);
			}
		}
	});
});

describe("fenced JSON and YAML config snippets parse cleanly", () => {
	it("parses every json code fence across documentation", () => {
		for (const file of documentationFiles()) {
			const blocks = fencedBlocks(read(file), "json");
			blocks.forEach((block, index) => {
				expect(() => JSON.parse(block), `${relative(PACKAGE_ROOT, file)} json block #${index + 1}`).not.toThrow();
			});
		}
	});

	it.each([
		["skills/auditing-with-swival/SKILL.md", AUDIT_SKILL],
		["prompts/swival-audit.md", join(PROMPTS_DIR, "swival-audit.md")],
	])("%s includes parseable default and profileOverride audit examples", (_label, file) => {
		const examples = fencedBlocks(read(file), "json").map((b) => JSON.parse(b));
		expect(examples).toContainEqual({ audit: { all: true } });
		expect(examples).toContainEqual({ audit: { all: true }, profileOverride: "security-specialist" });
	});

	it("parses YAML agent-authoring examples in swival SKILL.md", () => {
		for (const block of fencedBlocks(read(SWIVAL_SKILL), "yaml")) {
			const cleaned = block.replace(/^---\n/, "").replace(/\n---[\s\S]*$/, "");
			const doc = parseDocument(cleaned);
			expect(doc.errors).toEqual([]);
		}
	});
});

describe("setup.md TOML provider blocks", () => {
	it("parses all TOML blocks in setup.md and swival SKILL.md", () => {
		for (const file of [SETUP_DOC, SWIVAL_SKILL]) {
			const blocks = fencedBlocks(read(file), "toml");
			expect(blocks.length).toBeGreaterThan(0);
			blocks.forEach((block, idx) => {
				parseTomlBlock(block, `${relative(PACKAGE_ROOT, file)}#${idx + 1}`);
			});
		}
	});

	it("configures bedrock, vertexai (with project and location, without api_key), chatgpt, and named local generic profile", () => {
		const parsedBlocks = fencedBlocks(read(SETUP_DOC), "toml").map((b, i) => parseTomlBlock(b, `setup.md#${i + 1}`));
		const tables = parsedBlocks.flat();

		expect(tables.some((t) => t.entries.provider === "bedrock")).toBe(true);
		expect(tables.some((t) => t.entries.provider === "chatgpt")).toBe(true);

		const vertexTables = tables.filter((t) => t.entries.provider === "vertexai");
		expect(vertexTables.length).toBeGreaterThan(0);
		for (const table of vertexTables) {
			expect(typeof table.entries.project).toBe("string");
			expect(typeof table.entries.location).toBe("string");
			expect(table.entries.api_key).toBeUndefined();
		}

		const genericTables = tables.filter((t) => t.entries.provider === "generic");
		expect(genericTables.length).toBeGreaterThan(0);
		for (const table of genericTables) {
			expect(table.header).toMatch(/^profiles\./);
		}

		const unscopedApiKeys = tables.filter((t) => t.entries.api_key !== undefined && !t.header?.startsWith("profiles."));
		expect(unscopedApiKeys).toEqual([]);
	});
});

describe("relative links, bundled agents, and skill inventory", () => {
	it("resolves every relative Markdown link across documentation", () => {
		for (const file of documentationFiles()) {
			const content = read(file).replace(/^```[\s\S]*?^```/gm, "");
			for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
				const rawTarget = match[1].trim();
				if (/^(?:https?:|mailto:|#)/.test(rawTarget)) continue;
				const relPath = rawTarget.split("#")[0];
				if (!relPath) continue;
				const resolved = resolve(dirname(file), relPath);
				expect(existsSync(resolved), `${relative(PACKAGE_ROOT, file)} -> ${rawTarget}`).toBe(true);
			}
		}
	});

	it("resolves all ../../agents/<name>.md references on disk", () => {
		expect(read(SWIVAL_SKILL)).toContain("../../agents/<name>.md");
		expect(read(BRIEFS_SKILL)).toContain("../../agents/self-review-worker.md");
		expect(read(BRIEFS_SKILL)).toContain("../../agents/test-runner.md");
		for (const [skillFile, skillDir] of [
			[SWIVAL_SKILL, SWIVAL_SKILL_DIR],
			[AUDIT_SKILL, AUDIT_SKILL_DIR],
			[BRIEFS_SKILL, BRIEFS_SKILL_DIR],
		] as const) {
			const refs = [...read(skillFile).matchAll(/\.\.\/\.\.\/agents\/([a-z0-9-]+)\.md/g)].map((m) => m[1]);
			for (const name of refs) {
				expect(existsSync(resolve(skillDir, "..", "..", "agents", `${name}.md`)), `${name}.md must exist`).toBe(true);
			}
		}
	});

	it("documents all six bundled agents and three skills in README.md and swival SKILL.md", () => {
		const agents = bundledAgentNames();
		expect(agents).toHaveLength(6);
		const readme = read(join(PACKAGE_ROOT, "README.md"));
		const selection = agentSelectionSection(read(SWIVAL_SKILL));
		for (const name of agents) {
			expect(readme).toContain(`\`${name}\``);
			expect(selection).toContain(`\`${name}\``);
		}
		for (const skill of ["swival", "auditing-with-swival", "swival-worker-briefs"]) {
			expect(readme).toContain(`\`${skill}\``);
		}
	});

	it("uses distinct cwd directories in parallel worker-brief examples", () => {
		const cwds = [...read(BRIEFS_SKILL).matchAll(/cwd:\s*"([^"]+)"/g)].map((m) => m[1]);
		expect(new Set(cwds).size).toBeGreaterThanOrEqual(2);
	});
});

describe("absence of retired names, obsolete proxy artifacts, and codename leaks", () => {
	it("ships no skills/swival/scripts directory", () => {
		const scripts = join(SWIVAL_SKILL_DIR, "scripts");
		expect(existsSync(scripts) && statSync(scripts).isDirectory() ? readdirSync(scripts) : []).toEqual([]);
	});

	it.each([
		["LiteLLM proxy guidance", /litellm\s+proxy|litellm\[proxy/i],
		["swival-proxy", /swival-proxy/i],
		["LiteLLM proxy config", /\.config\/litellm\/config\.ya?ml/i],
		["synthetic proxy key", /sk-unused/i],
		["proxy port 4000", /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):4000/],
		["retired custom audit agents", /audit-worker|security-recon|security-consolidator|recon-contract|consolidation-contract/],
		["private model codenames", /gpt-daybreak|daybreak-blue-latest/i],
	])("contains no %s across documentation", (label, pattern) => {
		const offenders = documentationFiles()
			.filter((file) => pattern.test(read(file)))
			.map((file) => relative(PACKAGE_ROOT, file));
		expect(offenders, label).toEqual([]);
	});
});
