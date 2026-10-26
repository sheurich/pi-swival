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
const BRIEFS_SKILL_DIR = join(SKILLS_DIR, "swival-worker-briefs");
const BRIEFS_SKILL = join(BRIEFS_SKILL_DIR, "SKILL.md");
const AGENTS_DIR = join(PACKAGE_ROOT, "agents");

const SWIVAL_VERSION = "1.0.45";

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

	it("documents uv tool upgrade swival", () => {
		expect(setup()).toContain("uv tool upgrade swival");
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
		["instructionsFullOverride", /instructionsFullOverride/],
		["reasoningEffortOverride", /reasoningEffortOverride/],
		["enforced no-subagents", /--no-subagents/],
	])("documents %s", (_label, pattern) => {
		expect(skill()).toMatch(pattern);
	});

	it("names every bundled agent in the selection table", () => {
		const section = agentSelectionSection(skill());
		for (const name of bundledAgentNames()) {
			expect(section, `selection table should list ${name}`).toContain(`\`${name}\``);
		}
	});

	it("covers all five bundled agents", () => {
		expect(bundledAgentNames()).toHaveLength(5);
	});

	it("stays under 500 lines", () => {
		expect(skill().split("\n").length).toBeLessThan(500);
	});
});

describe("native audit documentation and migration", () => {
	it.each(["README.md", "skills/swival/SKILL.md", "skills/auditing-with-swival/SKILL.md", "prompts/swival-audit.md"])(
		"%s uses defaults or an operator-selected specialist without vendor detection", (file) => {
			const doc = read(join(PACKAGE_ROOT, file));
			const examples = [...doc.matchAll(/```json\n([\s\S]*?)```/g)]
				.filter((match) => /"audit"\s*:/.test(match[1])).map((match) => JSON.parse(match[1]));
			expect(examples).toContainEqual({ audit: { all: true } });
			expect(examples).toContainEqual({ audit: { all: true }, profileOverride: "security-specialist" });
			expect(doc).toMatch(/installation (?:guidance|policy)/i);
			expect(doc).toMatch(/no specialist/i); expect(doc).toMatch(/selected.*(?:fail|stop)|(?:fail|stop).*selected/i);
			expect(doc).not.toMatch(/only ChatGPT|other native providers are unsupported/i);
		});
	it.each(["README.md", "examples/demo.md", "skills/swival/SKILL.md",
		"skills/auditing-with-swival/SKILL.md", "skills/swival/references/setup.md", "prompts/swival-audit.md"])(
		"%s distinguishes inherited same-route policy-error retries from terminal failure", (file) => {
			const doc = read(join(PACKAGE_ROOT, file));
			for (const required of [
				"Swival 1.0.48 can retry the same request on the same provider, model, and endpoint",
				"including recognized policy errors", "A later attempt can succeed.",
				"does not guarantee all-phase fail-fast or uniform retry-budget propagation",
				"Never substitute a route or rewrite a refused request",
				"Terminal failures and incomplete audits cannot attest completion.",
			]) expect(doc.includes(required), `${file}: missing ${required}`).toBe(true);
			expect(/(?:A selected or required|a selected) specialist failure stops/.test(doc)).toBe(false);
		});
	it("documents capability limits without concrete bundled specialist identities", () => {
		const doc = read(AUDIT_SKILL);
		for (const term of ["OpenRouter", "loopback", "max_context_tokens", "MODEL_REPLACEMENT_UNCONTROLLABLE",
			"POLICY_NOT_PROPAGATED", "no fallback", "dedicated", "every route/version"]) expect(doc).toContain(term);
		for (const file of [AUDIT_SKILL, SETUP_DOC, SWIVAL_SKILL, join(PACKAGE_ROOT, "prompts/swival-audit.md")]) {
			expect(read(file)).not.toMatch(/gpt-daybreak|daybreak-blue-latest/i);
		}
	});
	it.each(["README.md", "skills/swival/SKILL.md", "skills/auditing-with-swival/SKILL.md", "prompts/swival-audit.md"])(
		"%s requires standalone login and limits the runtime auth grant", (file) => {
			const doc = read(join(PACKAGE_ROOT, file));
			expect(/login[^\n]{0,140}outside Pi/i.test(doc), `${file} must explain standalone login`).toBe(true);
			expect(/auth[^\n]{0,100}directory/i.test(doc), `${file} must name the narrow auth directory`).toBe(true);
			expect(doc.includes("--add-dir"), `${file} must exclude auth from model-tool roots`).toBe(true);
			expect(/adds? no write grants/i.test(doc)).toBe(false);
		});
	it.each(["README.md", "skills/swival/SKILL.md", "skills/auditing-with-swival/SKILL.md", "prompts/swival-audit.md"])(
		"%s states synchronous lifetime, standard auth, and accepted crash limits", (file) => {
			const doc = read(join(PACKAGE_ROOT, file));
			expect(doc).toMatch(/native async[^\n]{0,50}unsupported/i);
			expect(doc).toMatch(/standard[^\n]{0,40}ChatGPT authentication/i);
			expect(doc).toMatch(/login[^\n]{0,100}refresh[^\n]{0,100}auth[^\n]{0,30}writes/i);
			expect(doc).toMatch(/crash[^\n]{0,100}SIGKILL/i);
			expect(doc).toMatch(/may (?:remain running|continue)/i);
			expect(doc).toMatch(/no (?:artifact )?export[^\n]{0,100}completion/i);
			expect(doc).toMatch(/source-only/);
			expect(doc).not.toMatch(/bubblewrap|pidfd|never logs in|never.*refreshes tokens/);
		});
	it.each(["README.md", "examples/demo.md", "skills/swival/references/setup.md"])("%s names tested native versions", (file) => {
		const doc = read(join(PACKAGE_ROOT, file));
		for (const version of ["1.0.48", "1.105.3", "0.6.4"]) expect(doc).toContain(version);
		expect(doc).toMatch(/macOS/); expect(doc).toMatch(/unverified|not validated/);
	});
	it("documents scope, tool permissions, completion evidence, and manual patch review", () => {
		const doc = read(AUDIT_SKILL);
		for (const term of ["committed", "staged", "untracked", "commands=none", "provider-only", "native-state", "native-cli-report.json", "4096", "8 MiB", "64 MiB", "patch", "encryption", "filtering"]) expect(doc).toContain(term);
		expect(doc).toMatch(/host-read/); expect(doc).toMatch(/egress/); expect(doc).toMatch(/no fallback/i);
	});
	it("documents write-through snapshot collection and refuses strict-read claims", () => {
		const doc = read(join(SWIVAL_SKILL_DIR, "references/agentfs.md"));
		expect(doc).toContain("write-through"); expect(doc).toMatch(/strict-read[^\n]{0,100}(unsupported|refused)/i);
		expect(doc).not.toMatch(/no-op/);
	});
	it("retires custom audit agents and contracts", () => {
		for (const file of documentationFiles()) expect(read(file), file).not.toMatch(/audit-worker|security-recon|security-consolidator|recon-contract|consolidation-contract/);
	});
});

describe("swival-worker-briefs points at the bundled self-review-worker", () => {
	const skill = () => read(BRIEFS_SKILL);

	it("uses the bundled relative source path", () => {
		expect(skill()).toContain("../../agents/self-review-worker.md");
	});

	it("requires distinct cwd for parallel dispatch", () => {
		const matches = [...skill().matchAll(/cwd:\s*"([^"]+)"/g)].map((m) => m[1]);
		expect(new Set(matches).size).toBeGreaterThanOrEqual(2);
	});
});

describe("every packaged skill appears in README.md", () => {
	it("lists all skill directories in README.md", () => {
		const readme = read(join(PACKAGE_ROOT, "README.md"));
		const skillNames = readdirSync(SKILLS_DIR).filter((d) => statSync(join(SKILLS_DIR, d)).isDirectory());
		for (const name of skillNames) {
			expect(readme).toContain(`\`${name}\``);
		}
	});
});

describe("documented bundled agent paths resolve on disk", () => {
	it.each([
		["skills/swival/SKILL.md", SWIVAL_SKILL, SWIVAL_SKILL_DIR],
		["skills/auditing-with-swival/SKILL.md", AUDIT_SKILL, AUDIT_SKILL_DIR],
		["skills/swival-worker-briefs/SKILL.md", BRIEFS_SKILL, BRIEFS_SKILL_DIR],
	])("%s", (_label, file, skillDir) => {
		const refs = [...read(file).matchAll(/\.\.\/\.\.\/agents\/([a-z0-9-]+)\.md/g)].map((m) => m[1]);
		for (const name of refs) {
			expect(existsSync(resolve(skillDir, "..", "..", "agents", `${name}.md`)), `${name} should exist`).toBe(true);
		}
	});
});
