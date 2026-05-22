import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(TEST_DIR, "..");
const AGENTS_DIR = join(PACKAGE_ROOT, "agents");

function bundledAgentFiles(): string[] {
	return readdirSync(AGENTS_DIR)
		.filter((name) => name.endsWith(".md"))
		.sort();
}

function readAgent(fileName: string): string {
	return readFileSync(join(AGENTS_DIR, fileName), "utf8");
}

function frontmatter(content: string): string {
	const match = content.match(/^---\n([\s\S]*?)\n---\n/);
	expect(match, "agent should have frontmatter").not.toBeNull();
	return match?.[1] ?? "";
}

describe("bundled swival agents", () => {
	it.each(bundledAgentFiles())("%s inherits model routing from swival config", (fileName) => {
		expect(frontmatter(readAgent(fileName))).not.toMatch(/^model:/m);
	});
});
