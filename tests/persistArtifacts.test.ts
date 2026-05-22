import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { persistArtifacts } from "../extensions/index.js";

describe("persistArtifacts", () => {
	let tmpDirs: string[] = [];

	afterEach(() => {
		for (const d of tmpDirs) {
			fs.rmSync(d, { recursive: true, force: true });
		}
		tmpDirs = [];
	});

	const mkTmp = (prefix: string): string => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		tmpDirs.push(d);
		return d;
	};

	it("copies report.json and trace/*.jsonl into <artifactRoot>/<agent>-<ts>/", async () => {
		const src = mkTmp("swival-src-");
		const artifactRoot = mkTmp("swival-art-");
		fs.writeFileSync(path.join(src, "report.json"), '{"version":1,"result":{"outcome":"success"}}');
		fs.mkdirSync(path.join(src, "trace"));
		fs.writeFileSync(path.join(src, "trace", "session-abc.jsonl"), '{"type":"assistant"}\n');

		const destDir = await persistArtifacts(src, "my-agent", artifactRoot, new Date("2026-01-15T10:30:45.000Z"));
		expect(destDir).toBeDefined();
		expect(destDir!).toContain(artifactRoot);
		expect(path.basename(destDir!)).toMatch(/^my-agent-1768473045000-[a-z0-9]+$/);

		expect(fs.existsSync(path.join(destDir!, "report.json"))).toBe(true);
		expect(fs.readFileSync(path.join(destDir!, "report.json"), "utf-8")).toContain("success");
		expect(fs.existsSync(path.join(destDir!, "trace", "session-abc.jsonl"))).toBe(true);
	});

	it("returns undefined and skips the empty dir when no artifacts exist", async () => {
		const src = mkTmp("swival-src-");
		const artifactRoot = mkTmp("swival-art-");
		// No report.json, no trace/ entries — swival crashed before writing anything.
		const destDir = await persistArtifacts(src, "my-agent", artifactRoot);
		expect(destDir).toBeUndefined();
		// Any directory we created for the copy must be cleaned up.
		const remaining = fs.readdirSync(artifactRoot);
		expect(remaining).toHaveLength(0);
	});

	it("sanitises unsafe agent-name characters in the dir prefix", async () => {
		const src = mkTmp("swival-src-");
		const artifactRoot = mkTmp("swival-art-");
		fs.writeFileSync(path.join(src, "report.json"), "{}");

		const destDir = await persistArtifacts(src, "../weird/name:with$chars", artifactRoot);
		expect(destDir).toBeDefined();
		const base = path.basename(destDir!);
		// Path-traversal segments and separators must be stripped.
		expect(base).not.toContain("..");
		expect(base).not.toContain("/");
		expect(base).not.toContain(":");
		expect(base).not.toContain("$");
	});

	it("keeps the report when trace/ is missing entirely", async () => {
		const src = mkTmp("swival-src-");
		const artifactRoot = mkTmp("swival-art-");
		fs.writeFileSync(path.join(src, "report.json"), "{}");
		// No trace/ dir at all.

		const destDir = await persistArtifacts(src, "agent", artifactRoot);
		expect(destDir).toBeDefined();
		expect(fs.existsSync(path.join(destDir!, "report.json"))).toBe(true);
		expect(fs.existsSync(path.join(destDir!, "trace"))).toBe(false);
	});
});
