import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "setup offline fixture "));
	roots.push(root);
	for (const dir of ["bin", "tests/.venv/bin", "tests/node_modules/vitest", "tests/node_modules/typescript", "tests/node_modules/@types/node", "node_modules/yaml"]) {
		mkdirSync(join(root, dir), { recursive: true });
	}
	copyFileSync(new URL("./setup.sh", import.meta.url), join(root, "tests/setup.sh"));
	for (const prefix of ["", "tests/"]) {
		copyFileSync(new URL(`../${prefix}package.json`, import.meta.url), join(root, prefix, "package.json"));
		copyFileSync(new URL(`../${prefix}package-lock.json`, import.meta.url), join(root, prefix, "package-lock.json"));
	}
	for (const [name, version] of [["tests/node_modules/typescript", "5.9.3"], ["tests/node_modules/@types/node", "24.10.1"], ["node_modules/yaml", "2.9.0"]]) {
		writeFileSync(join(root, name, "package.json"), JSON.stringify({ version }));
	}
	writeFileSync(join(root, "calls"), "");
	// Isolate every bootstrap executable before running the copied script.
	// No real npm, Node, uv, Python, network, or worker process can run.
	const stub = (path: string, body: string) => writeFileSync(join(root, path), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
	stub("bin/npm", 'printf "npm %s %s\\n" "$PWD" "$*" >> "$LOG"\nif [[ "$*" == "root -g" ]]; then printf "/selected/pi\\n"; fi\nif [[ "$1" == "ci" && "$PWD" == "${FAIL_CI_DIR:-}" ]]; then exit 42; fi');
	stub("bin/node", 'printf "node %s %s\\n" "$PWD" "$*" >> "$LOG"');
	stub("bin/uv", 'printf "uv %s %s\\n" "$PWD" "$*" >> "$LOG"');
	stub("tests/.venv/bin/python", 'printf "python %s %s\\n" "$PWD" "$*" >> "$LOG"');
	symlinkSync("/usr/bin/dirname", join(root, "bin/dirname"));
	symlinkSync("/bin/cat", join(root, "bin/cat"));
	const run = (env: Record<string, string> = {}) => spawnSync("/bin/bash", [join(root, "tests/setup.sh")], {
		cwd: root, env: { PATH: join(root, "bin"), HOME: root, LOG: join(root, "calls"), ...env },
		encoding: "utf8", timeout: 5_000, maxBuffer: 16_384,
	});
	return { root, run, calls: () => readFileSync(join(root, "calls"), "utf8").trim().split("\n").filter(Boolean) };
}

describe("immutable standalone setup", () => {
	it("runs ci for both complete dependency trees on every invocation, then relinks selected Pi peers", () => {
		const { root, run, calls } = fixture();
		const locks = ["package-lock.json", "tests/package-lock.json"];
		const before = locks.map((lock) => readFileSync(join(root, lock), "utf8"));
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = run();
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
		}
		const log = calls();
		const installs = log.filter((line) => line.startsWith("npm ") && !line.endsWith(" root -g"));
		const ci = "ci --ignore-scripts --no-audit --no-fund --legacy-peer-deps";
		expect(installs).toEqual([
			`npm ${root}/tests ${ci}`, `npm ${root} ${ci}`,
			`npm ${root}/tests ${ci}`, `npm ${root} ${ci}`,
		]);
		for (const line of installs) {
			expect(line).toMatch(/ ci /);
			expect(line).toContain("--ignore-scripts");
			expect(line).toContain("--legacy-peer-deps");
			expect(line).not.toMatch(/--package-lock=false|\binstall\b/);
		}
		for (const chunk of [log.slice(0, log.length / 2), log.slice(log.length / 2)]) {
			const link = chunk.findIndex((line) => line.includes("test-peer-bootstrap.mjs --link"));
			expect(link).toBeGreaterThan(chunk.findIndex((line) => line === installs[0]));
			expect(link).toBeGreaterThan(chunk.findIndex((line) => line === installs[1]));
			expect(chunk[link]).toContain(`${root}/tests/node_modules`);
			expect(chunk.find((line) => line.startsWith("uv "))).toContain("--require-hashes requirements.txt");
		}
		expect(locks.map((lock) => readFileSync(join(root, lock), "utf8"))).toEqual(before);
	});

	it.each(["tests", ""])("stops before relinking when ci fails in %s", (directory) => {
		const { root, run, calls } = fixture();
		const result = run({ FAIL_CI_DIR: directory ? join(root, directory) : root });
		expect(result.status).toBe(42);
		expect(calls().some((line) => /test-peer-bootstrap|^uv |^python /.test(line))).toBe(false);
	});

	it.each(["npm_lifecycle_event", "npm_config_allow_scripts"])("rejects %s before installing anything", (variable) => {
		const { run, calls } = fixture();
		const result = run({ [variable]: "test" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("must be run directly, outside an npm lifecycle");
		expect(calls()).toEqual([]);
	});

	it("preserves hash-checked uv pins and Python 3.13 without runtime downloads", () => {
		const setup = readFileSync(new URL("./setup.sh", import.meta.url), "utf8");
		expect(setup).toContain("set -euo pipefail");
		expect(setup).toContain("uv --no-config venv --python 3.13 --no-python-downloads .venv");
		expect(setup).toContain("--only-binary :all:");
		expect(setup).toContain("--require-hashes requirements.txt");
		expect(setup).toContain('sys.version_info[:2] == (3, 13)');
		expect(setup).toContain('importlib.metadata.version("swival") == "1.9.3"');
		expect(setup).toContain('[[ -L .venv ]]');
	});

	it("keeps the reviewed root lock consistent with the manifest and locks only the runtime dependency", () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
		expect(lock.lockfileVersion).toBe(3);
		expect(lock.packages[""].dependencies).toEqual(manifest.dependencies);
		expect(lock.packages[""].peerDependencies).toEqual(manifest.peerDependencies);
		expect(Object.keys(lock.packages)).toEqual(["", "node_modules/yaml"]);
		expect(lock.packages["node_modules/yaml"]).toMatchObject({
			version: "2.9.0", resolved: "https://registry.npmjs.org/yaml/-/yaml-2.9.0.tgz",
			integrity: "sha512-2AvhNX3mb8zd6Zy7INTtSpl1F15HW6Wnqj0srWlkKLcpYl/gMIMJiyuGq2KeI2YFxUPjdlB+3Lc10seMLtL4cA==",
		});
	});
});
