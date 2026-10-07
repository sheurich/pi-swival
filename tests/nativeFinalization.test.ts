import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { pruneOldArtifacts } from "../extensions/index.js";

const require = createRequire(import.meta.url);
const library = path.resolve(import.meta.dirname, "../scripts/native-audit-lifecycle.cjs");
const roots: string[] = [];
const children: ChildProcess[] = [];
const actualFs = require("node:fs") as typeof fs;
function lifecycle(): any {
	expect(fs.existsSync(library), "The native callers need one shared lifecycle library").toBe(true);
	return require(library);
}
function fixture() {
	const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-finalization-")));
	roots.push(runDir);
	for (const name of ["snapshot", "runtime-bin", "sandbox", "evidence"]) fs.mkdirSync(path.join(runDir, name));
	const state = path.join(runDir, "snapshot", ".swival", "audit", "abc12345");
	fs.mkdirSync(state, { recursive: true });
	fs.writeFileSync(path.join(state, "state.json"), '{"phase":"triage"}\n');
	const findings = path.join(runDir, "snapshot", "audit-findings"); fs.mkdirSync(findings);
	fs.writeFileSync(path.join(findings, "001-test.md"), "partial report\n");
	fs.writeFileSync(path.join(findings, "001-test.patch"), "partial patch\n");
	fs.writeFileSync(path.join(runDir, "evidence", "native-result.json"), '{"status":"partial"}');
	return { runDir, state, findings };
}
const absent = { signal: () => { throw Object.assign(new Error("absent"), { code: "ESRCH" }); } };
afterEach(() => {
	vi.restoreAllMocks();
	for (const child of children.splice(0)) if (child.pid) {
		try { process.kill(-child.pid, "SIGKILL"); } catch { /* live test handle already exited */ }
	}
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("native-audit-lifecycle shared finalization", () => {
	it("preserves byte-identical stopped evidence before removing all owned temporary resources", async () => {
		const f = fixture();
		const { finalizeNativeAudit, readNativeTerminal } = lifecycle();
		const direct = fs.readFileSync(path.join(f.runDir, "evidence", "native-result.json"));
		const term = await finalizeNativeAudit({ runDir: f.runDir, ownership: absent }, { exitCode: 0 });
		expect(term.shutdown).toBe("verified"); expect(term.exitCode).toBe(0);
		expect(Object.isFrozen(term)).toBe(true);
		expect(fs.readFileSync(path.join(f.runDir, "evidence", "native-state", "abc12345", "state.json"), "utf8")).toBe('{"phase":"triage"}\n');
		for (const [file, text] of [["001-test.md", "partial report\n"], ["001-test.patch", "partial patch\n"]]) {
			expect(fs.readFileSync(path.join(f.runDir, "evidence", "audit-findings", file), "utf8")).toBe(text);
		}
		expect(fs.readFileSync(path.join(f.runDir, "evidence", "native-result.json"))).toEqual(direct);
		for (const name of ["snapshot", "runtime-bin", "sandbox"]) expect(fs.existsSync(path.join(f.runDir, name))).toBe(false);
		expect(readNativeTerminal(f.runDir)).toEqual(term);
	});

	it("escalates a TERM-ignoring live group and requires ESRCH before evidence export", async () => {
		const f = fixture(); const { finalizeNativeAudit } = lifecycle();
		const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); process.send('ready'); setInterval(()=>{},1000)"],
			{ detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }); children.push(child);
		await new Promise<void>((resolve) => child.once("message", () => resolve()));
		const signals: (NodeJS.Signals | 0)[] = [];
		const term = await finalizeNativeAudit({ runDir: f.runDir, ownership: { signal: (signal: NodeJS.Signals | 0) => {
			signals.push(signal); return process.kill(-child.pid!, signal);
		} } }, { exitCode: 1, stopped: "Native audit was interrupted." });
		expect(signals).toContain("SIGTERM"); expect(signals).toContain("SIGKILL");
		expect(term.shutdown).toBe("verified"); expect(() => process.kill(-child.pid!, 0)).toThrow();
		expect(fs.existsSync(path.join(f.runDir, "evidence", "native-state", "abc12345", "state.json"))).toBe(true);
	}, 5000);

	it("does not copy or delete mutable sources when group absence remains unverified", async () => {
		const f = fixture(); const { finalizeNativeAudit } = lifecycle();
		const term = await finalizeNativeAudit({ runDir: f.runDir, ownership: { signal: () => {
			throw Object.assign(new Error("denied"), { code: "EPERM" });
		} } }, { exitCode: 0 });
		expect(term.shutdown).toBe("unverified"); expect(term.exitCode).toBe(1);
		expect(term.shutdownFailure).toMatch(/verified/);
		expect(term.retainedResources).toContain(path.join(f.runDir, "snapshot"));
		expect(fs.existsSync(path.join(f.runDir, "evidence", "native-state"))).toBe(false);
		for (const name of ["snapshot", "runtime-bin", "sandbox"]) expect(fs.existsSync(path.join(f.runDir, name))).toBe(true);
	}, 5000);

	it("retries interrupted export only for matching regular evidence destinations", async () => {
		const f = fixture(); const { finalizeNativeAudit } = lifecycle();
		const link = actualFs.linkSync; let publications = 0;
		const fault = vi.spyOn(actualFs, "linkSync").mockImplementation((from, to) => {
			if (String(to).includes(`${path.sep}evidence${path.sep}`) && ++publications === 2) throw new Error("test interrupted export");
			return link(from, to);
		});
		const failed = await finalizeNativeAudit({ runDir: f.runDir, ownership: absent }, { exitCode: 0 });
		expect(failed.preservationFailure).toBeTruthy();
		expect(fs.existsSync(path.join(f.runDir, "snapshot"))).toBe(true);
		fault.mockRestore(); fs.rmSync(path.join(f.runDir, "completed.json"));
		const retried = await finalizeNativeAudit({ runDir: f.runDir, ownership: absent }, { exitCode: 1 });
		expect(retried.preservationFailure).toBeUndefined();
		expect(fs.existsSync(path.join(f.runDir, "snapshot"))).toBe(false);
	});

	it.each(["symlink-state", "symlink-parent", "symlink-destination", "conflict", "nonregular", "oversize", "entries", "total"])(
		"retains source diagnosis and refuses unsafe or excessive %s evidence", async (kind) => {
			const f = fixture(); const { finalizeNativeAudit } = lifecycle();
			if (kind === "symlink-state") {
				fs.rmSync(path.join(f.state, "state.json")); fs.symlinkSync(path.join(f.runDir, "request.json"), path.join(f.state, "state.json"));
			}
			if (kind === "symlink-parent") {
				fs.rmSync(f.state, { recursive: true }); fs.symlinkSync(f.findings, f.state);
			}
			if (["symlink-destination", "conflict"].includes(kind)) {
				const dest = path.join(f.runDir, "evidence", "native-state", "abc12345"); fs.mkdirSync(dest, { recursive: true });
				if (kind === "conflict") fs.writeFileSync(path.join(dest, "state.json"), "different");
				else fs.symlinkSync(path.join(f.state, "state.json"), path.join(dest, "state.json"));
			}
			if (kind === "nonregular") { fs.rmSync(path.join(f.state, "state.json")); fs.mkdirSync(path.join(f.state, "state.json")); }
			if (kind === "oversize") fs.truncateSync(path.join(f.state, "state.json"), 8 * 1024 * 1024 + 1);
			if (kind === "entries") for (let i = 0; i < 4097; i++) fs.writeFileSync(path.join(f.findings, `${i}.md`), "");
			if (kind === "total") for (let i = 0; i < 9; i++) {
				const file = path.join(f.findings, `${i}.patch`); fs.writeFileSync(file, ""); fs.truncateSync(file, 8 * 1024 * 1024);
			}
			const term = await finalizeNativeAudit({ runDir: f.runDir, ownership: absent }, { exitCode: 0 });
			expect(term.exitCode).toBe(1); expect(term.preservationFailure).toBeTruthy();
			expect(term.retainedResources).toContain(path.join(f.runDir, "snapshot"));
			expect(fs.existsSync(path.join(f.runDir, "snapshot"))).toBe(true);
			for (const name of ["runtime-bin", "sandbox"]) expect(fs.existsSync(path.join(f.runDir, name))).toBe(false);
		}, 10000,
	);

	it("keeps preservation and cleanup diagnostics distinct", async () => {
		const f = fixture(); const { finalizeNativeAudit } = lifecycle();
		fs.truncateSync(path.join(f.state, "state.json"), 8 * 1024 * 1024 + 1);
		const rm = actualFs.rmSync;
		vi.spyOn(actualFs, "rmSync").mockImplementation((file, options) => {
			if (String(file).endsWith("runtime-bin")) throw new Error("test cleanup EIO");
			return rm(file, options);
		});
		const term = await finalizeNativeAudit({ runDir: f.runDir, ownership: absent,
			closeLogs: () => { throw new Error("test log drain EIO"); } }, { exitCode: 0, stopped: "Native audit timed out." });
		expect(term.stopped).toBe("Native audit timed out.");
		expect(term.preservationFailure).toBeTruthy(); expect(term.cleanupFailure).toMatch(/log/);
		expect(term.cleanupFailure).toMatch(/temporary-resource/);
	});

	it("writes atomic fallback failure when only completion persistence fails", async () => {
		const f = fixture(); const { finalizeNativeAudit, readNativeTerminal } = lifecycle();
		fs.mkdirSync(path.join(f.runDir, "completed.json"));
		const term = await finalizeNativeAudit({ runDir: f.runDir, ownership: absent }, { exitCode: 0 });
		expect(term.exitCode).toBe(1); expect(term.persistenceFailure).toMatch(/completion/i);
		expect(readNativeTerminal(f.runDir)).toEqual(term);
		expect(JSON.parse(fs.readFileSync(path.join(f.runDir, "spawn-error.txt"), "utf8"))).toEqual(term);
	});

	it("explicitly fails both persistence paths without inventing disk terminal evidence", async () => {
		const f = fixture(); const { finalizeNativeAudit, readNativeTerminal } = lifecycle();
		for (const name of ["completed.json", "spawn-error.txt"]) fs.mkdirSync(path.join(f.runDir, name));
		await expect(finalizeNativeAudit({ runDir: f.runDir, ownership: absent }, { exitCode: 1 }))
			.rejects.toThrow(/terminal.*could not be persisted/i);
		expect(readNativeTerminal(f.runDir)).toBeUndefined();
	});

	it("does not re-signal or rewrite valid terminal evidence", async () => {
		const f = fixture(); const { finalizeNativeAudit } = lifecycle();
		await finalizeNativeAudit({ runDir: f.runDir, ownership: absent }, { exitCode: 0 });
		const original = fs.readFileSync(path.join(f.runDir, "completed.json"));
		const signal = vi.fn();
		await finalizeNativeAudit({ runDir: f.runDir, ownership: { signal } }, { exitCode: 1 });
		expect(signal).not.toHaveBeenCalled(); expect(fs.readFileSync(path.join(f.runDir, "completed.json"))).toEqual(original);
	});

	it("repairs explicitly unverified shutdown only with retained live ownership", async () => {
		const f = fixture(); const { finalizeNativeAudit } = lifecycle();
		fs.writeFileSync(path.join(f.runDir, "completed.json"), JSON.stringify({ exitCode: 1,
			exitedAt: new Date().toISOString(), shutdown: "unverified", stopped: "interrupted",
			shutdownFailure: "Native process-group cleanup could not be verified." }));
		const term = await finalizeNativeAudit({ runDir: f.runDir, ownership: absent }, { exitCode: 1 });
		expect(term.shutdown).toBe("verified"); expect(term.stopped).toBe("interrupted");
		expect(term.shutdownFailure).toBeUndefined(); expect(fs.existsSync(path.join(f.runDir, "snapshot"))).toBe(false);
	});

	it("preserves pre-existing sessions rather than claiming cleanup ownership", async () => {
		const f = fixture(); const { finalizeNativeAudit } = lifecycle();
		const sessionDir = path.join(f.runDir, "existing-session"); fs.mkdirSync(sessionDir);
		fs.writeFileSync(path.join(sessionDir, "keep"), "existing");
		const term = await finalizeNativeAudit({ runDir: f.runDir, sessionDir, sessionOwned: false },
			{ exitCode: 1, stopped: "Refusing to reuse an existing AgentFS session." });
		expect(term.shutdown).toBe("not-started"); expect(fs.readFileSync(path.join(sessionDir, "keep"), "utf8")).toBe("existing");
	});

	it("does not traverse unsafe session ancestors during owned-resource cleanup", async () => {
		const f = fixture(); const { finalizeNativeAudit } = lifecycle();
		const external = path.join(f.runDir, "external"); const actualSession = path.join(external, "fresh-session");
		fs.mkdirSync(actualSession, { recursive: true }); fs.writeFileSync(path.join(actualSession, "keep"), "unchanged");
		const link = path.join(f.runDir, "linked-session-root"); fs.symlinkSync(external, link);
		const sessionDir = path.join(link, "fresh-session");
		const term = await finalizeNativeAudit({ runDir: f.runDir, ownership: absent, sessionDir, sessionOwned: true }, { exitCode: 1 });
		expect(term.cleanupFailure).toBeTruthy(); expect(term.retainedResources).toContain(sessionDir);
		expect(fs.readFileSync(path.join(actualSession, "keep"), "utf8")).toBe("unchanged");
	});

	it.each(["string-code", "missing-shutdown", "success-fallback", "malformed", "symlink", "oversize"])(
		"rejects %s native terminal records instead of laundering their status", (kind) => {
			const f = fixture(); const { readNativeTerminal } = lifecycle();
			const target = path.join(f.runDir, kind === "success-fallback" ? "spawn-error.txt" : "completed.json");
			fs.writeFileSync(target, kind === "malformed" ? "{" : JSON.stringify({ exitCode: kind === "string-code" ? "0" : 0,
				exitedAt: new Date().toISOString(), ...(kind !== "missing-shutdown" ? { shutdown: "verified" } : {}) }));
			if (kind === "oversize") fs.truncateSync(target, 65537);
			if (kind === "symlink") { fs.renameSync(target, `${target}.other`); fs.symlinkSync(`${target}.other`, target); }
			expect(readNativeTerminal(f.runDir)).toBeUndefined();
		},
	);

	it.each(["missing", "malformed", "unverified", "verified", "verified-fallback"])(
		"prunes native resources only with valid shutdown evidence: %s", async (kind) => {
			const f = fixture(); const root = path.join(f.runDir, "runs"); const runDir = path.join(root, "native");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "run-meta.json"), JSON.stringify({ nativeAuditRequested: true }));
			if (kind !== "missing") fs.writeFileSync(path.join(runDir, kind === "verified-fallback" ? "spawn-error.txt" : "completed.json"),
				kind === "malformed" ? "{" : JSON.stringify({ exitCode: 1, exitedAt: new Date().toISOString(),
					shutdown: kind === "unverified" ? "unverified" : "verified" }));
			const old = new Date(Date.now() - 10 * 24 * 60 * 60_000); fs.utimesSync(runDir, old, old);
			await pruneOldArtifacts(root);
			expect(fs.existsSync(runDir)).toBe(!["verified", "verified-fallback"].includes(kind));
		},
	);

	it.each(["malformed", "symlink", "oversize", "invalid-native-flag", "missing-native-name", "missing-native-layout", "missing-native-name-terminal", "missing-native-layout-terminal"])(
		"retains uncertain artifact directories instead of pruning %s metadata", async (kind) => {
			const f = fixture(); const root = path.join(f.runDir, "runs");
			const runDir = path.join(root, kind.startsWith("missing-native-name") ? "native-audit-test" : "run");
			fs.mkdirSync(runDir, { recursive: true });
			const meta = path.join(runDir, "run-meta.json");
			if (kind.startsWith("missing-native-layout")) fs.mkdirSync(path.join(runDir, "snapshot"));
			else if (!kind.startsWith("missing")) {
				fs.writeFileSync(meta, kind === "malformed" ? "{" : JSON.stringify({ nativeAuditRequested: kind === "invalid-native-flag" ? "true" : false }));
				if (kind === "oversize") fs.truncateSync(meta, 65537);
				if (kind === "symlink") { fs.renameSync(meta, `${meta}.target`); fs.symlinkSync(`${meta}.target`, meta); }
			}
			fs.writeFileSync(path.join(runDir, "completed.json"), JSON.stringify({ exitCode: 0, exitedAt: new Date().toISOString(),
				...(kind.endsWith("terminal") ? { shutdown: "verified" } : {}) }));
			const old = new Date(Date.now() - 10 * 24 * 60 * 60_000); fs.utimesSync(runDir, old, old);
			await pruneOldArtifacts(root); expect(fs.existsSync(runDir)).toBe(true);
		},
	);

	it.each([true, false])("preserves ordinary completion-marker pruning (metadata=%s)", async (metadata) => {
		const f = fixture(); const root = path.join(f.runDir, "runs"); const runDir = path.join(root, "ordinary");
		fs.mkdirSync(runDir, { recursive: true });
		if (metadata) fs.writeFileSync(path.join(runDir, "run-meta.json"), JSON.stringify({ agent: "swival", nativeAuditRequested: false }));
		fs.writeFileSync(path.join(runDir, "completed.json"), JSON.stringify({ exitCode: 0, exitedAt: new Date().toISOString() }));
		const old = new Date(Date.now() - 10 * 24 * 60 * 60_000); fs.utimesSync(runDir, old, old);
		await pruneOldArtifacts(root); expect(fs.existsSync(runDir)).toBe(false);
	});

	it("accepts bounded legacy fallback text only as unverified failure evidence", () => {
		const f = fixture(); const { readNativeTerminal } = lifecycle();
		fs.writeFileSync(path.join(f.runDir, "spawn-error.txt"), "Legacy native launch failed.");
		const term = readNativeTerminal(f.runDir);
		expect(term.exitCode).toBe(1); expect(term.shutdown).toBe("unverified"); expect(term.stopped).toContain("Legacy");
	});
});
