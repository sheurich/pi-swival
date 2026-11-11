import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	findRunMeta,
	loadRunState,
	persistArtifacts,
	preflightSwivalVersion,
	pruneOldArtifacts,
	readAsyncRunObservations,
	resetSwivalVersionCache,
	runSingleSwival,
} from "../extensions/index.js";

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

	it("writes sync:true run-meta.json + completed.json with real exitCode, hides from async controls/observation, and prunes after 7 days while retaining native-audit", async () => {
		const artifactRoot = fs.realpathSync(mkTmp("swival-art-"));
		const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
		const freshDate = new Date();
		const ownerUuid = "11111111-1111-4111-8111-111111111111";

		// Exercise report+trace (exitCode 17), report-only (exitCode 0), and trace-only (exitCode 1).
		const agedSyncDirs: string[] = [];
		for (const [label, hasReport, hasTrace, exitCode] of [
			["self-review-worker", true, true, 17],
			["report-only", true, false, 0],
			["trace-only", false, true, 1],
		] as const) {
			const src = mkTmp("swival-src-");
			if (hasReport) fs.writeFileSync(path.join(src, "report.json"), '{"version":1,"result":{"outcome":"failed"}}');
			if (hasTrace) {
				fs.mkdirSync(path.join(src, "trace"));
				fs.writeFileSync(path.join(src, "trace", "s1.jsonl"), '{"type":"assistant"}\n');
			}
			const destDir = await persistArtifacts(src, label, artifactRoot, oldDate, exitCode);
			expect(destDir).toBeDefined();
			agedSyncDirs.push(destDir!);

			const metaPath = path.join(destDir!, "run-meta.json");
			const completedPath = path.join(destDir!, "completed.json");
			expect(fs.statSync(metaPath).mode & 0o777).toBe(0o600);
			expect(fs.statSync(completedPath).mode & 0o777).toBe(0o600);
			const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
			const completed = JSON.parse(fs.readFileSync(completedPath, "utf8"));
			expect(meta).toEqual({
				runId: expect.stringMatching(/^swival-run-\d+-[a-f0-9]+$/),
				agent: label,
				startedAt: oldDate.getTime(),
				artifactDir: destDir,
				sync: true,
			});
			expect(completed).toEqual({ exitCode, exitedAt: oldDate.toISOString() });

			// Synchronous metadata is invisible to async lookup, state loading, and Fleet observation.
			expect(await findRunMeta(meta.runId, artifactRoot)).toBeUndefined();
			expect(await loadRunState(meta.runId, artifactRoot)).toBeUndefined();
			fs.utimesSync(destDir!, oldDate, oldDate);
		}
		expect(await readAsyncRunObservations(ownerUuid, artifactRoot)).toEqual([]);

		// Fresh sync dir (within retention window) and aged native-audit dir must both survive pruning.
		const freshSrc = mkTmp("swival-src-");
		fs.writeFileSync(path.join(freshSrc, "report.json"), "{}");
		const freshSyncDir = (await persistArtifacts(freshSrc, "fresh-worker", artifactRoot, freshDate, 0))!;

		const nativeDir = path.join(artifactRoot, `native-audit-${oldDate.getTime()}-deadbeef`);
		fs.mkdirSync(nativeDir, { mode: 0o700 });
		fs.writeFileSync(path.join(nativeDir, "run-meta.json"), JSON.stringify({
			runId: "native-run", agent: "native-audit", startedAt: oldDate.getTime(), artifactDir: nativeDir, nativeAuditRequested: true,
		}));
		fs.writeFileSync(path.join(nativeDir, "completed.json"), JSON.stringify({ exitCode: 0, exitedAt: oldDate.toISOString() }));
		fs.utimesSync(nativeDir, oldDate, oldDate);

		await pruneOldArtifacts(artifactRoot);

		for (const dir of agedSyncDirs) expect(fs.existsSync(dir)).toBe(false);
		expect(fs.existsSync(freshSyncDir)).toBe(true);
		expect(fs.existsSync(nativeDir)).toBe(true);
	});

	it.each([
		"missing",
		"malformed-json",
		"empty-object",
		"invalid-exit-code",
		"invalid-exited-at",
		"before-launch",
		"directory",
		"symlink",
		"oversized",
		"valid",
	] as const)("retains aged sync:true artifacts unless completed.json is a valid regular record (%s)", async (kind) => {
		const artifactRoot = fs.realpathSync(mkTmp("swival-art-"));
		const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
		const src = mkTmp("swival-src-");
		fs.writeFileSync(path.join(src, "report.json"), '{"version":1,"result":{"outcome":"success"}}');
		const destDir = (await persistArtifacts(src, `sync-${kind}`, artifactRoot, oldDate, 0))!;
		const completedPath = path.join(destDir, "completed.json");

		if (kind === "missing") {
			fs.unlinkSync(completedPath);
		} else if (kind === "malformed-json") {
			fs.writeFileSync(completedPath, "{");
		} else if (kind === "empty-object") {
			fs.writeFileSync(completedPath, "{}");
		} else if (kind === "invalid-exit-code") {
			fs.writeFileSync(completedPath, JSON.stringify({ exitCode: -1, exitedAt: oldDate.toISOString() }));
		} else if (kind === "invalid-exited-at") {
			fs.writeFileSync(completedPath, JSON.stringify({ exitCode: 0, exitedAt: "not-iso-8601" }));
		} else if (kind === "before-launch") {
			fs.writeFileSync(completedPath, JSON.stringify({ exitCode: 0, exitedAt: new Date(oldDate.getTime() - 1000).toISOString() }));
		} else if (kind === "directory") {
			fs.unlinkSync(completedPath);
			fs.mkdirSync(completedPath);
		} else if (kind === "symlink") {
			const externalTarget = path.join(mkTmp("swival-ext-"), "completed.json");
			fs.writeFileSync(externalTarget, JSON.stringify({ exitCode: 0, exitedAt: oldDate.toISOString() }));
			fs.unlinkSync(completedPath);
			fs.symlinkSync(externalTarget, completedPath);
		} else if (kind === "oversized") {
			fs.writeFileSync(completedPath, JSON.stringify({ exitCode: 0, exitedAt: oldDate.toISOString(), pad: "x".repeat(2000) }));
		}
		fs.utimesSync(destDir, oldDate, oldDate);

		await pruneOldArtifacts(artifactRoot);
		expect(fs.existsSync(destDir)).toBe(kind !== "valid");
	});

	it("records the actual child exitCode in completed.json when runSingleSwival persists synchronous artifacts", async () => {
		const root = fs.realpathSync(mkTmp("swival-sync-exit-"));
		const binDir = path.join(root, "bin");
		const artifactRoot = path.join(root, "artifacts");
		fs.mkdirSync(binDir);
		fs.mkdirSync(artifactRoot);
		fs.writeFileSync(path.join(binDir, "swival"), [
			`#!${process.execPath}`,
			'const fs = require("node:fs");',
			'const args = process.argv.slice(2);',
			'const report = args[args.indexOf("--report") + 1];',
			'fs.writeFileSync(report, JSON.stringify({ result: { outcome: "error", error_message: "boom", exit_code: 23 } }));',
			'process.exit(23);',
		].join("\n") + "\n", { mode: 0o755 });

		const savedPath = process.env.PATH;
		try {
			process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;
			resetSwivalVersionCache();
			await preflightSwivalVersion(async () => "1.9.3");
			const agent = {
				name: "sync-exit-agent",
				description: "test",
				systemPrompt: "",
				source: "user" as const,
				filePath: "/unused",
				sandbox: "builtin" as const,
			};
			const result = await runSingleSwival(
				root, [agent], agent.name, "fail with 23", root, {}, undefined, undefined,
				(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
				artifactRoot,
			);
			expect(result.exitCode).toBe(23);
			expect(result.artifactDir).toBeDefined();
			const meta = JSON.parse(fs.readFileSync(path.join(result.artifactDir!, "run-meta.json"), "utf8"));
			const completed = JSON.parse(fs.readFileSync(path.join(result.artifactDir!, "completed.json"), "utf8"));
			expect(meta.sync).toBe(true);
			expect(completed.exitCode).toBe(23);
		} finally {
			process.env.PATH = savedPath;
			resetSwivalVersionCache();
		}
	});
});
