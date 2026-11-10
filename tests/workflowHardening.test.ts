import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const source = readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");
const workflow = parse(source);
const { jobs } = workflow;
const nodePin = "actions/setup-node@2028fbc5c25fe9cf00d9f06a71cc4710d4507903";
const uvPin = "astral-sh/setup-uv@37802adc94f370d6bfd71619e3f0bf239e1f3b78";
const digest = "ba314bd58262ca355e16afc3ecf405cfd934995b15af231d32a0426b72d74700";

describe("CI hardening", () => {
	it("preserves existing required jobs, matrix, pins, triggers, and read-only permissions", () => {
		expect(jobs.test.strategy.matrix["node-version"]).toEqual(["22.19.0", "24"]);
		expect(jobs.test.name).toBeUndefined();
		expect(jobs.agentfs.name).toBeUndefined();
		expect(jobs.test["runs-on"]).toBe("ubuntu-latest");
		expect(jobs.agentfs["runs-on"]).toBe("ubuntu-22.04");
		expect(workflow.permissions).toEqual({ contents: "read" });
		expect(workflow.on).toEqual({ push: { branches: ["main"] }, pull_request: { branches: ["main"] } });
		for (const job of Object.values(jobs) as any[]) {
			expect(job.permissions).toBeUndefined();
			for (const step of job.steps) {
				if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
				if (step.uses?.startsWith("actions/checkout@")) {
					expect(step.uses).toBe("actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8");
					expect(step.with?.["persist-credentials"]).toBe(false);
				}
			}
		}
	});

	it("bounds every job", () => {
		for (const job of Object.values(jobs) as any[]) {
			expect(Number.isInteger(job["timeout-minutes"])).toBe(true);
			expect(job["timeout-minutes"]).toBeGreaterThan(0);
			expect(job["timeout-minutes"]).toBeLessThanOrEqual(30);
		}
	});

	it("verifies the pinned AgentFS archive before extraction without fetching a checksum", () => {
		const step = jobs.agentfs.steps.find((step: any) => step.name === "Install pinned AgentFS");
		expect(step.env).toMatchObject({ AGENTFS_VERSION: "v0.6.4", AGENTFS_TRIPLE: "x86_64-unknown-linux-gnu" });
		expect(step.run).toContain(digest);
		expect(step.run).not.toMatch(/curl[^\n]*(?:sha256|checksum)/);
		expect(step.run.match(/\bcurl\b/g)).toHaveLength(1);
		expect(step.run).toContain('"${base}/${archive}"');
		expect(step.run).toContain('"$archive"');
		expect(step.run).toMatch(/printf[^\n]*[\s\S]*sha256sum -c -/);
		expect(step.run.indexOf("sha256sum -c -")).toBeLessThan(step.run.indexOf("tar -xJf"));
	});

	it("installs digest-pinned nono before the native gate requires provider-only isolation", () => {
		const steps = jobs.agentfs.steps;
		const install = steps.findIndex((step: any) => step.name === "Install pinned nono");
		const native = steps.findIndex((step: any) => step.run === "npm run native-agentfs-integration");
		expect(install).toBeGreaterThanOrEqual(0);
		expect(install).toBeLessThan(native);
		const run = steps[install].run;
		expect(run).toContain("nono-v0.80.0-x86_64-unknown-linux-gnu.tar.gz");
		expect(run).toContain("6da665b61999570c10dffc7da78828fe1fb7f3cac53319e505cebecaef17037f");
		expect(run.match(/\bcurl\b/g)).toHaveLength(1);
		expect(run.indexOf("sha256sum -c -")).toBeGreaterThan(0);
		expect(run.indexOf("sha256sum -c -")).toBeLessThan(run.indexOf("tar -xzf"));
		expect(run).toContain('"$HOME/.local/bin/nono"');
		expect(run).toContain('"$GITHUB_PATH"');
	});

	it("bootstraps both test jobs with the selected Pi host, pinned Node/uv, and Python 3.13", () => {
		for (const name of ["test", "agentfs"]) {
			const steps = jobs[name].steps;
			const index = (predicate: (step: any) => boolean) => steps.findIndex(predicate);
			expect(index((step) => step.uses === nodePin)).toBeGreaterThanOrEqual(0);
			if (name === "agentfs") expect(steps.find((step: any) => step.uses === nodePin).with["node-version"]).toBe("22.19.0");
			const uv = steps.find((step: any) => step.uses === uvPin);
			expect(uv?.with).toEqual({ version: "0.12.19", "python-version": "3.13", "enable-cache": false });
			const bootstrap = index((step) => step.run === "./tests/setup.sh");
			const pi = index((step) => step.run === "npm install -g @earendil-works/pi-coding-agent@1.2.0 --ignore-scripts --no-audit --no-fund");
			const python = index((step) => step.run === "uv --no-config python install 3.13");
			expect(pi).toBeGreaterThanOrEqual(0);
			expect(python).toBeGreaterThan(index((step) => step.uses === uvPin));
			expect(bootstrap).toBeGreaterThan(Math.max(pi, python));
			expect(jobs[name].env.NONO_NO_UPDATE_CHECK).toBe("1");
		}
		const steps = jobs.agentfs.steps;
		const canary = steps.findIndex((step: any) => step.run === "npm run agentfs-integration");
		const native = steps.findIndex((step: any) => step.run === "npm run native-agentfs-integration");
		expect(steps[canary].env.REQUIRE_AGENTFS).toBe("1");
		expect(native).toBeGreaterThan(canary);
		expect(steps.findIndex((step: any) => step.run === "./tests/setup.sh")).toBeLessThan(native);
	});
});

describe("aggregate CI result", () => {
	it("runs unconditionally after both required jobs", () => {
		expect(jobs.ci?.needs).toEqual(["test", "agentfs"]);
		expect(jobs.ci?.if).toBe("${{ always() }}");
		expect(jobs.ci?.steps).toHaveLength(1);
		expect(jobs.ci?.steps[0].env).toEqual({
			TEST_RESULT: "${{ needs.test.result }}",
			AGENTFS_RESULT: "${{ needs.agentfs.result }}",
		});
	});

	const results = ["success", "failure", "cancelled", "skipped"];
	for (const test of results) for (const agentfs of results) {
		it(`test=${test}, agentfs=${agentfs}`, () => {
			// Execute only the aggregate shell predicate; never import worker dispatch.
			const run = jobs.ci?.steps[0].run;
			expect(typeof run).toBe("string");
			const result = spawnSync("/bin/bash", ["-euo", "pipefail", "-c", run], {
				env: { PATH: "", TEST_RESULT: test, AGENTFS_RESULT: agentfs },
				encoding: "utf8", timeout: 2_000, maxBuffer: 16_384,
			});
			expect(result.error).toBeUndefined();
			expect(result.status === 0).toBe(test === "success" && agentfs === "success");
		});
	}
});
