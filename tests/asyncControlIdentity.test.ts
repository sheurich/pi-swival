import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import registerExtension, {
	pruneOldArtifacts,
	resetSwivalVersionCache,
	runSingleSwivalAsync,
	type RunMeta,
} from "../extensions/index.js";
import type { SwivalAgentConfig } from "../extensions/agents.js";
import { nativeScratch } from "./nativeFixtures.js";

const roots: string[] = [];
const groups: number[] = [];
const ordinaryNames = ["native-audit", "native-audit-helper"] as const;
const nativeEvidence = ["metadata", "snapshot", "request.json", "evidence/native-state"] as const;
const waitFor = async (condition: () => boolean) => {
	const deadline = Date.now() + 3000;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Fixture condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};
const groupExists = (pid: number) => {
	try { process.kill(-pid, 0); return true; } catch { return false; }
};
afterEach(async () => {
	vi.restoreAllMocks();
	for (const pid of groups.splice(0)) {
		try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ }
		await waitFor(() => !groupExists(pid));
	}
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	resetSwivalVersionCache();
});

function fixture() {
	const root = nativeScratch("async-control-identity-"); roots.push(root);
	const artifactRoot = path.join(root, "artifacts"); fs.mkdirSync(artifactRoot);
	let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
	registerExtension({ registerTool: (value: typeof tool) => { tool = value; } } as any, { artifactRoot });
	const control = (action: "status" | "resume" | "interrupt", id: string) =>
		tool!.execute("identity-test", { action, id, agentScope: "project" }, undefined, undefined, { cwd: root, hasUI: false });
	return { root, artifactRoot, control };
}

async function startOrdinary(name: string) {
	const f = fixture();
	const bin = path.join(f.root, "bin"); fs.mkdirSync(bin);
	// Fixed local synthetic CLI; no shell, provider, credentials, or network.
	fs.writeFileSync(path.join(bin, "swival"), `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
if (process.argv.includes("--version")) { console.log("1.0.46"); process.exit(0); }
const report = process.argv[process.argv.indexOf("--report") + 1];
const dir = path.dirname(report);
fs.writeFileSync(path.join(dir, "ready"), "ready");
const timeout = setTimeout(() => process.exit(2), 5000);
const timer = setInterval(() => {
 if (!fs.existsSync(path.join(dir, "release"))) return;
 clearInterval(timer); clearTimeout(timeout);
 fs.writeFileSync(report, JSON.stringify({result: {outcome: "success", answer: "ordinary completed answer"}, sandbox: {mode: "builtin"}}));
 console.log("ordinary stdout");
}, 10);
`, { mode: 0o700 });
	const agent: SwivalAgentConfig = { name, description: "ordinary fixture", systemPrompt: "", source: "user", filePath: path.join(f.root, "agent.md") };
	const originalPath = process.env.PATH;
	process.env.PATH = bin;
	resetSwivalVersionCache();
	let started: Awaited<ReturnType<typeof runSingleSwivalAsync>>;
	try {
		started = await runSingleSwivalAsync(f.root, [agent], name, "fixed fixture task", undefined, {}, f.artifactRoot);
		const meta: RunMeta = JSON.parse(fs.readFileSync(path.join(started.artifactDir, "run-meta.json"), "utf8"));
		groups.push(meta.pid!);
		await waitFor(() => fs.existsSync(path.join(started.artifactDir, "ready")));
	} finally { process.env.PATH = originalPath; }
	return { ...f, ...started! };
}

function writeOrdinary(f: ReturnType<typeof fixture>, name: string) {
	const artifactDir = path.join(f.artifactRoot, `${name}-123456-abcd`); fs.mkdirSync(artifactDir);
	const meta: RunMeta = { runId: "swival-run-123456-abcd", agent: name, task: "fixed fixture task", startedAt: 123456,
		pid: process.pid, artifactDir, stdoutFile: path.join(artifactDir, "stdout.txt"), stderrFile: path.join(artifactDir, "stderr.txt") };
	fs.writeFileSync(path.join(artifactDir, "run-meta.json"), JSON.stringify(meta));
	fs.writeFileSync(path.join(artifactDir, "completed.json"), JSON.stringify({ exitCode: 0, exitedAt: "2026-10-01T00:00:00Z" }));
	fs.writeFileSync(path.join(artifactDir, "report.json"), JSON.stringify({ result: { outcome: "success", answer: "ordinary completed answer" }, sandbox: { mode: "builtin" } }));
	fs.writeFileSync(meta.stdoutFile, "ordinary stdout"); fs.writeFileSync(meta.stderrFile, "");
	return meta;
}
function addNativeEvidence(meta: RunMeta, evidence: typeof nativeEvidence[number]) {
	if (evidence === "metadata") {
		fs.writeFileSync(path.join(meta.artifactDir, "run-meta.json"), JSON.stringify({ ...meta, nativeAuditRequested: true }));
	} else if (evidence === "request.json") {
		fs.writeFileSync(path.join(meta.artifactDir, evidence), "{}");
	} else fs.mkdirSync(path.join(meta.artifactDir, evidence), { recursive: true });
}

describe.each(ordinaryNames)("ordinary async controls for %s", (name) => {
	it("reports live status despite the artifact name prefix", async () => {
		const f = await startOrdinary(name);
		const result = await f.control("status", f.runId);
		expect(result.content[0].text).toContain("is still running");
		expect(result.isError).not.toBe(true);
	});
	it("interrupts its same-process owned process group", async () => {
		const f = await startOrdinary(name);
		const result = await f.control("interrupt", f.runId);
		expect(result.content[0].text).toContain("Sent SIGTERM to process group");
		expect(result.isError).not.toBe(true);
		const meta: RunMeta = JSON.parse(fs.readFileSync(path.join(f.artifactDir, "run-meta.json"), "utf8"));
		await waitFor(() => !groupExists(meta.pid!));
	});
	it("resumes completed output from the same process", async () => {
		const f = await startOrdinary(name);
		fs.writeFileSync(path.join(f.artifactDir, "release"), "release");
		await waitFor(() => fs.existsSync(path.join(f.artifactDir, "completed.json")));
		await vi.waitFor(async () => {
			const result = await f.control("resume", f.runId);
			expect(result.content[0].text).toContain("ordinary completed answer");
			expect(result.isError).not.toBe(true);
		}, { timeout: 1000, interval: 10 });
	});
	it("recovers completed ordinary status and output from disk", async () => {
		const f = fixture(); const meta = writeOrdinary(f, name);
		const status = await f.control("status", meta.runId);
		const resume = await f.control("resume", meta.runId);
		expect.soft(status.content[0].text).toContain("completed (exit 0");
		expect.soft(resume.content[0].text).toContain("ordinary completed answer");
		expect(status.isError).not.toBe(true); expect(resume.isError).not.toBe(true);
	});
});

describe("native refusal is based on metadata and native-only evidence", () => {
	it.each(nativeEvidence)("refuses all disk controls with %s even under an ordinary name", async (evidence) => {
		const f = fixture(); const meta = writeOrdinary(f, "ordinary-helper");
		addNativeEvidence(meta, evidence);
		const kill = vi.spyOn(process, "kill");
		for (const completed of [true, false]) {
			if (!completed) fs.unlinkSync(path.join(meta.artifactDir, "completed.json"));
			for (const action of ["status", "resume", "interrupt"] as const) {
				const result = await f.control(action, meta.runId);
				expect(result.isError).toBe(true);
				expect(result.content[0].text).toContain("Native async and disk recovery are unsupported");
				expect(result.content[0].text).not.toContain("ordinary completed answer");
			}
		}
		expect(kill).not.toHaveBeenCalled();
	});
	it("still refuses legacy native run IDs without metadata", async () => {
		const f = fixture(); const kill = vi.spyOn(process, "kill");
		for (const action of ["status", "resume", "interrupt"] as const) {
			const result = await f.control(action, "native-audit-crashed");
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("Native async and disk recovery are unsupported");
		}
		expect(kill).not.toHaveBeenCalled();
	});
	it.each(ordinaryNames)("never signals disk-recovered ordinary %s PIDs", async (name) => {
		const f = fixture(); const meta = writeOrdinary(f, name);
		fs.unlinkSync(path.join(meta.artifactDir, "completed.json"));
		const kill = vi.spyOn(process, "kill");
		const result = await f.control("interrupt", meta.runId);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("cannot safely interrupt the recorded PID");
		expect(kill).not.toHaveBeenCalled();
	});
});

describe("conservative native artifact retention", () => {
	it.each([...ordinaryNames, ...nativeEvidence, "ordinary"])("retains native prefixes/evidence but prunes ordinary completed artifacts: %s", async (kind) => {
		const f = fixture(); const meta = writeOrdinary(f, ordinaryNames.includes(kind as any) ? kind : "ordinary-helper");
		if (nativeEvidence.includes(kind as any)) addNativeEvidence(meta, kind as typeof nativeEvidence[number]);
		const old = new Date(Date.now() - 10 * 24 * 60 * 60_000);
		fs.utimesSync(meta.artifactDir, old, old);
		await pruneOldArtifacts(f.artifactRoot);
		expect(fs.existsSync(meta.artifactDir)).toBe(kind !== "ordinary");
	});
});
