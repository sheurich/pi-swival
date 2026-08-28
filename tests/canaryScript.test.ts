import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const canary = path.resolve(here, "../scripts/agentfs-integration-test.sh");
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

describe("AgentFS canary safety", () => {
	it("fails required runs when AgentFS is unavailable", () => {
		const result = spawnSync("/bin/bash", [canary], {
			env: { ...process.env, PATH: makeTmp("pi-swival-empty-path-"), REQUIRE_AGENTFS: "1" },
			encoding: "utf-8",
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/required AgentFS canary cannot run/);
	});

	it("preserves a pre-existing session directory", () => {
		const home = makeTmp("pi-swival-canary-home-");
		const bin = makeTmp("pi-swival-canary-bin-");
		const fakeAgentFs = path.join(bin, "agentfs");
		fs.writeFileSync(fakeAgentFs, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
		const session = "existing-session";
		const runDir = path.join(home, ".agentfs", "run", session);
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(path.join(runDir, "keep"), "sentinel");

		const result = spawnSync("/bin/bash", [canary], {
			env: {
				...process.env,
				HOME: home,
				PATH: `${bin}:${process.env.PATH ?? ""}`,
				AGENTFS_CANARY_SESSION: session,
			},
			encoding: "utf-8",
		});

		expect(result.status).not.toBe(0);
		expect(fs.readFileSync(path.join(runDir, "keep"), "utf-8")).toBe("sentinel");
	});
});
