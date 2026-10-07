import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { findPiPackage } from "../scripts/test-peer-bootstrap.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));

async function runProcess(
	executable: string,
	args: string[],
	cwd: string,
	env = process.env,
	timeoutMs = 30_000,
	outputCap = 256 * 1024,
): Promise<{ status: number | null; output: string; timedOut?: boolean; outputExceeded?: boolean }> {
	const { spawn } = await import("node:child_process");
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let bytes = 0;
		let timedOut = false;
		let outputExceeded = false;
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
		const collect = (chunk: Buffer) => {
			const remaining = Math.max(0, outputCap - bytes);
			chunks.push(chunk.subarray(0, remaining));
			bytes += Math.min(chunk.length, remaining);
			if (chunk.length > remaining) { outputExceeded = true; child.kill("SIGKILL"); }
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve({ status, output: Buffer.concat(chunks).toString(), timedOut, outputExceeded });
		});
	});
}

async function runSmoke(packageRoot = ROOT) {
	const scratch = mkdtempSync(join(tmpdir(), "pi-swival smoke "));
	try {
		const globalRoot = execFileSync("npm", ["root", "-g"], { timeout: 5_000, maxBuffer: 16_384 }).toString().trim();
		return await runProcess(process.execPath, [join(ROOT, "scripts", "smoke-loader.mjs"), packageRoot], scratch, {
			...process.env, NPM_GLOBAL_ROOT: globalRoot, PI_CODING_AGENT_DIR: join(scratch, "agent"), PI_OFFLINE: "1",
		});
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

describe("offline loader smoke", () => {
	it("discovers a global-only Pi installation through the production shell", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "global Pi smoke "));
		try {
			const root = execFileSync("npm", ["root", "-g"], { timeout: 5_000, maxBuffer: 16_384 }).toString().trim();
			const pi = findPiPackage({ globalRoots: [root] });
			const global = join(scratch, "global", "@earendil-works");
			const bin = join(scratch, "bin");
			mkdirSync(global, { recursive: true });
			mkdirSync(bin);
			symlinkSync(pi, join(global, "pi-coding-agent"), "dir");
			symlinkSync(process.execPath, join(bin, "node"));
			writeFileSync(join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$SMOKE_GLOBAL_ROOT"\n', { mode: 0o755 });
			const env = { ...process.env, HOME: scratch, PATH: `${bin}:/usr/bin:/bin`, SMOKE_GLOBAL_ROOT: join(scratch, "global") };
			delete env.PI_CODING_AGENT_PACKAGE;
			delete env.PI_PACKAGE_DIR;
			const result = await runProcess("/bin/bash", [join(ROOT, "scripts", "smoke-test.sh")], scratch, env);
			expect(result.status, result.output).toBe(0);
			expect(result.output).toContain("tools=swival-subagent");
		} finally { rmSync(scratch, { recursive: true, force: true }); }
	});

	it("bounds smoke subprocess duration and waits for termination", async () => {
		const result = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 500)"], ROOT, process.env, 50);
		expect(result.timedOut).toBe(true);
		expect(result.status).not.toBe(0);
	});

	it("bounds combined stdout and stderr from a noisy subprocess", async () => {
		const result = await runProcess(process.execPath, ["-e", 'process.stdout.write("x".repeat(10000)); process.stderr.write("y".repeat(10000))'], ROOT, process.env, 5000, 128);
		expect(result.outputExceeded).toBe(true);
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(128);
	});

	it("loads only the declared package resources without a session or model", async () => {
		const result = await runSmoke();

		expect(result.status, result.output).toBe(0);
		expect(result.output).toContain("swival-subagent");
		expect(result.output).toContain("extensions=1");
		expect(result.output).toContain("skills=3");
		expect(result.output).toContain("prompts=1");
		expect(result.output).toContain("agents=5");
	});

	it("keeps loader diagnostics when declared resources are invalid", async () => {
		const fixture = mkdtempSync(join(tmpdir(), "broken pi package "));
		try {
			await (await import("node:fs/promises")).cp(ROOT, fixture, { recursive: true, filter: (source) => !["node_modules", ".venv", "__pycache__"].some((entry) => source.split("/").includes(entry)) });
			await (await import("node:fs/promises")).rm(join(fixture, "extensions", "index.ts"));
			const result = await runSmoke(fixture);

			expect(result.status).not.toBe(0);
			expect(result.output).toMatch(/Pi resource loader diagnostics:[\s\S]*Extension/i);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});
});
