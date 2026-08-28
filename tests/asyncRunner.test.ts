import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runSingleSwivalAsync } from "../extensions/index.js";
import type { SwivalAgentConfig } from "../extensions/agents.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.resolve(here, "../scripts/async-runner.cjs");
const tmpDirs: string[] = [];

const makeTmp = (prefix: string) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
	tmpDirs.length = 0;
});

const waitForFile = async (file: string, timeoutMs = 3000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(file)) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${file}`);
};

describe("durable async runner", () => {
	it("writes an atomic completion marker with the child exit code", () => {
		const root = makeTmp("pi-swival-async-runner-");
		const bin = path.join(root, "bin");
		const artifacts = path.join(root, "artifacts");
		fs.mkdirSync(bin);
		fs.mkdirSync(artifacts);
		const fakeSwival = path.join(bin, "swival");
		fs.writeFileSync(fakeSwival, "#!/bin/sh\nexit 7\n", { mode: 0o755 });

		const result = spawnSync(process.execPath, [runner, artifacts, "task"], {
			env: { ...process.env, PATH: bin },
			encoding: "utf-8",
		});

		expect(result.status).toBe(7);
		expect(JSON.parse(fs.readFileSync(path.join(artifacts, "completed.json"), "utf-8"))).toMatchObject({
			exitCode: 7,
		});
		expect(fs.readdirSync(artifacts).filter((name) => name.includes(".tmp"))).toEqual([]);
	});

	it("records effective AgentFS intent and immediate completion through the production producer", async () => {
		const root = makeTmp("pi-swival-async-producer-");
		const bin = path.join(root, "bin");
		const artifacts = path.join(root, "artifacts");
		fs.mkdirSync(bin);
		fs.mkdirSync(artifacts);
		const fakeSwival = path.join(bin, "swival");
		fs.writeFileSync(fakeSwival, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const originalPath = process.env.PATH;
		process.env.PATH = `${bin}:${originalPath ?? ""}`;
		try {
			const agent: SwivalAgentConfig = {
				name: "immediate",
				description: "test",
				systemPrompt: "",
				source: "user",
				filePath: path.join(root, "immediate.md"),
				extraArgs: ["--sandbox", "agentfs"],
			};
			const started = await runSingleSwivalAsync(root, [agent], agent.name, "task", undefined, {}, artifacts);
			const meta = JSON.parse(fs.readFileSync(path.join(started.artifactDir, "run-meta.json"), "utf-8"));
			expect(meta.agentFsRequested).toBe(true);
			await waitForFile(path.join(started.artifactDir, "completed.json"));
			expect(JSON.parse(fs.readFileSync(path.join(started.artifactDir, "completed.json"), "utf-8"))).toMatchObject({
				exitCode: 0,
			});
		} finally {
			process.env.PATH = originalPath;
		}
	});

	it("terminates a TERM-ignoring process group when metadata persistence fails", async () => {
		const root = makeTmp("pi-swival-async-meta-failure-");
		const bin = path.join(root, "bin");
		const artifacts = path.join(root, "artifacts");
		fs.mkdirSync(bin);
		fs.mkdirSync(artifacts);
		const fakeSwival = path.join(bin, "swival");
		fs.writeFileSync(fakeSwival, "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n", { mode: 0o755 });
		const originalPath = process.env.PATH;
		process.env.PATH = `${bin}:${originalPath ?? ""}`;
		let wrapperPid: number | undefined;
		const writeFile = fs.promises.writeFile.bind(fs.promises);
		const writeSpy = vi.spyOn(fs.promises, "writeFile").mockImplementation(async (file, data, ...rest) => {
			if (String(file).endsWith("run-meta.json")) {
				wrapperPid = JSON.parse(String(data)).pid;
				throw new Error("injected metadata failure");
			}
			return writeFile(file, data, ...rest);
		});
		try {
			const agent: SwivalAgentConfig = {
				name: "term-ignoring",
				description: "test",
				systemPrompt: "",
				source: "user",
				filePath: path.join(root, "term-ignoring.md"),
			};
			await expect(
				runSingleSwivalAsync(root, [agent], agent.name, "task", undefined, {}, artifacts),
			).rejects.toThrow(/injected metadata failure/);
			expect(wrapperPid).toBeTypeOf("number");
			expect(() => process.kill(-wrapperPid!, 0)).toThrow();
		} finally {
			writeSpy.mockRestore();
			process.env.PATH = originalPath;
		}
	}, 10000);

	it("records a missing swival executable without crashing", () => {
		const root = makeTmp("pi-swival-async-runner-missing-");
		const bin = path.join(root, "bin");
		const artifacts = path.join(root, "artifacts");
		fs.mkdirSync(bin);
		fs.mkdirSync(artifacts);

		const result = spawnSync(process.execPath, [runner, artifacts, "task"], {
			env: { ...process.env, PATH: bin },
			encoding: "utf-8",
		});

		expect(result.status).not.toBe(0);
		expect(fs.readFileSync(path.join(artifacts, "spawn-error.txt"), "utf-8")).toMatch(/failed to start/i);
		expect(JSON.parse(fs.readFileSync(path.join(artifacts, "completed.json"), "utf-8"))).toMatchObject({
			exitCode: null,
		});
	});
});
