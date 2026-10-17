import { expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

it("catalogueLoad: Pi loads the package and lists offline", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swival-catalogue-load-")));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	const userAgents = path.join(agentDir, "swival-agents");
	const projectAgents = path.join(cwd, ".pi", "swival-agents");
	const home = path.join(root, "home");
	for (const dir of [projectAgents, userAgents, home]) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(userAgents, "loader-only.md"), [
		"---", "name: loader-only", "description: Synthetic loader agent", "sandbox: builtin",
		"network: none", "---", "PRIVATE_LOADER_PROMPT",
	].join("\n"));

	// Patch the native builtin, not a Vitest module mock: jiti imports outside Vitest.
	const childProcess = createRequire(import.meta.url)("node:child_process") as
		typeof import("node:child_process");
	const launches: string[] = [];
	const restore: Array<() => void> = [];
	const block = (method: string) => () => {
		launches.push(method);
		throw new Error(`catalogueLoad blocked ${method}`);
	};

	try {
		for (const method of [
			"spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork",
		] as const) {
			const spy = vi.spyOn(childProcess, method).mockImplementation(block(method));
			restore.push(() => spy.mockRestore());
		}
		const spawnSpy = vi.spyOn(childProcess.ChildProcess.prototype, "spawn")
			.mockImplementation(block("ChildProcess.spawn"));
		restore.push(() => spawnSpy.mockRestore());
		syncBuiltinESMExports();
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_PACKAGE_DIR", undefined);
		vi.stubEnv("HOME", home);
		vi.stubEnv("JITI_FS_CACHE", path.join(root, "jiti-cache"));

		const { discoverAndLoadExtensions, getAgentDir } =
			await import("@earendil-works/pi-coding-agent");
		expect(getAgentDir()).toBe(agentDir);
		expect(launches).toEqual([]);

		// Both discovery roots are synthetic and empty; only explicit paths can load.
		const discoveryDirs = [path.join(cwd, ".pi", "extensions"), path.join(agentDir, "extensions")];
		for (const dir of discoveryDirs) expect(fs.existsSync(dir)).toBe(false);
		const invalidExtension = path.join(root, "invalid.ts");
		fs.writeFileSync(invalidExtension, [
			'import { spawn } from "node:child_process";',
			'export default function () { spawn("catalogue-load-must-not-execute", []); }',
		].join("\n"));
		const invalid = await discoverAndLoadExtensions([invalidExtension], cwd, agentDir);
		expect(invalid.extensions).toEqual([]);
		expect(invalid.errors).toEqual([{
			path: invalidExtension,
			error: expect.stringContaining("catalogueLoad blocked spawn"),
		}]);
		expect(launches).toEqual(["spawn"]);
		launches.length = 0;

		// Passing the actual package root exercises its pi.extensions manifest and jiti.
		const loaded = await discoverAndLoadExtensions([packageRoot], cwd, agentDir);
		expect(loaded.errors).toEqual([]);
		if ("warnings" in loaded) expect(loaded.warnings).toEqual([]);
		expect(loaded.extensions.map((extension) => extension.resolvedPath))
			.toEqual([path.join(packageRoot, "extensions")]);
		const extension = loaded.extensions[0];
		expect([...extension.tools.keys()]).toEqual(["swival-subagent"]);
		const tool = extension.tools.get("swival-subagent")!.definition;
		expect(tool.parameters).toMatchObject({
			type: "object",
			properties: {
				action: { enum: ["list", "status", "interrupt", "resume"] },
				agentScope: { enum: ["user", "project", "both"] },
				cwd: { type: "string" },
			},
		});

		// Catalogue access needs only cwd; fail on session, UI, or model access.
		const ctx = new Proxy({ cwd }, {
			get(target, key) {
				if (key === "cwd") return target.cwd;
				throw new Error(`catalogueLoad unexpected context access: ${String(key)}`);
			},
		}) as ExtensionToolContext;
		const result = await tool.execute(
			"catalogue-load", { action: "list", agentScope: "user", cwd }, undefined, undefined, ctx,
		);
		expect(result.isError).not.toBe(true);
		expect(result.content).toEqual([{
			type: "text", text: expect.stringContaining("Swival agent catalogue v1:"),
		}]);
		for (const part of result.content) {
			if (part.type === "text") expect(part.text.length).toBeLessThanOrEqual(8192);
		}
		expect(result.details).toMatchObject({
			mode: "list", schemaVersion: 1, agentScope: "user", total: 6, omitted: 0,
			diagnostics: [], diagnosticsTotal: 0, diagnosticsOmitted: 0, dispatchBlocked: false,
			agents: expect.arrayContaining([
				expect.objectContaining({ name: "swival", source: "bundled" }),
				expect.objectContaining({
					name: "loader-only", source: "user",
					configured: { sandbox: "builtin", network: "none" }, effectiveRuntime: "unknown",
				}),
			]),
		});
		expect(JSON.stringify(result)).not.toContain("PRIVATE_LOADER_PROMPT");
		expect(JSON.stringify(result)).not.toContain(root);
		expect(loaded.runtime.pendingProviderRegistrations).toEqual([]);
		// Newer SDKs expose additional registration state; check it when present.
		if ("pendingNativeProviderRegistrations" in loaded.runtime) {
			expect(loaded.runtime.pendingNativeProviderRegistrations).toEqual([]);
		}
		if ("pendingVirtualModelRegistrations" in loaded.runtime) {
			expect(loaded.runtime.pendingVirtualModelRegistrations).toEqual([]);
		}
		if ("mcpServers" in loaded.runtime) {
			const mcpServers = loaded.runtime.mcpServers as { list(): unknown[] };
			expect(mcpServers.list()).toEqual([]);
		}
		expect(launches).toEqual([]);
		for (const dir of discoveryDirs) expect(fs.existsSync(dir)).toBe(false);
		expect(fs.readdirSync(agentDir)).toEqual(["swival-agents"]);
		expect(fs.readdirSync(home)).toEqual([]);
	} finally {
		for (const undo of restore.reverse()) undo();
		syncBuiltinESMExports();
		vi.unstubAllEnvs();
		fs.rmSync(root, { recursive: true, force: true });
	}
}, 15000);
