import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

function tempDir(name: string): string {
	const directory = mkdtempSync(join(tmpdir(), `${name}-`));
	temporaryDirectories.push(directory);
	return directory;
}

function packageAt(root: string, name: string, importOnly = false): string {
	const directory = join(root, "node_modules", ...name.split("/"));
	mkdirSync(join(directory, "dist"), { recursive: true });
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({ name, type: "module", exports: importOnly ? { ".": { import: "./dist/index.js" } } : "./dist/index.js" }),
	);
	writeFileSync(join(directory, "dist", "index.js"), "export {};");
	return directory;
}

function piHost(root: string, peerRoot = root): string {
	const host = packageAt(root, "@earendil-works/pi-coding-agent");
	for (const name of [
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-tui",
		"typebox",
	]) {
		packageAt(peerRoot, name, true);
	}
	return host;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("test peer bootstrap", () => {
	it("pins local typecheck dependencies and never installs them during test or typecheck", () => {
		const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
		const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		expect(manifest.devDependencies.typescript).toBe("5.9.3");
		expect(manifest.devDependencies["@types/node"]).toBe("24.10.1");
		expect(root.scripts.typecheck).toContain("./node_modules/.bin/tsc");
		expect(root.scripts.typecheck).not.toMatch(/install|npx/);
		expect(root.scripts.test).not.toMatch(/install|npx/);
		const setup = readFileSync(new URL("./setup.sh", import.meta.url), "utf8");
		expect(setup).toContain("node_modules/typescript/package.json");
		expect(setup).toContain("--ignore-scripts");
		expect(setup).not.toMatch(/--allow-scripts|--unsafe-perm/);
	});
	it("prepares Python 3.13 in CI before bootstrap without allowing runtime downloads", () => {
		const workflow = readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");
		const prepare = workflow.indexOf("run: uv --no-config python install 3.13\n");
		const bootstrap = workflow.indexOf("run: ./tests/setup.sh\n");
		expect(prepare).toBeGreaterThanOrEqual(0);
		expect(workflow.slice(0, prepare)).toContain("uses: astral-sh/setup-uv@");
		expect(bootstrap).toBeGreaterThan(prepare);

		const setup = readFileSync(new URL("./setup.sh", import.meta.url), "utf8");
		expect(setup).toContain("uv --no-config venv --python 3.13 --no-python-downloads .venv");
		expect(setup).not.toMatch(/\bpython\s+install\b/);
	});
	it("prefers an explicit Pi package and resolves its import-only nested peers", async () => {
		const root = tempDir("pi host with spaces");
		const explicit = piHost(root);
		const managed = piHost(tempDir("managed host"));
		const { findPiPackage, resolvePeerPackages } = await import("../scripts/test-peer-bootstrap.mjs");

		expect(findPiPackage({ explicit, home: root, globalRoots: [managed] })).toBe(explicit);
		await expect(resolvePeerPackages(explicit)).resolves.toMatchObject({
		"@earendil-works/pi-ai": realpathSync(join(root, "node_modules", "@earendil-works", "pi-ai")),
		"typebox": realpathSync(join(root, "node_modules", "typebox")),
		});
	});

	it("resolves import-only peers nested under the selected host", async () => {
		const root = tempDir("nested Pi");
		const host = piHost(root);
		const nestedAi = packageAt(host, "@earendil-works/pi-ai", true);
		for (const name of ["@earendil-works/pi-agent-core", "@earendil-works/pi-tui", "typebox"]) packageAt(host, name, true);
		const { resolvePeerPackages } = await import("../scripts/test-peer-bootstrap.mjs");

		await expect(resolvePeerPackages(host)).resolves.toMatchObject({ "@earendil-works/pi-ai": realpathSync(nestedAi) });
	});

	it("uses the managed current-version release before a global fallback", async () => {
		const home = tempDir("managed Pi");
		const managed = piHost(join(home, ".pi", "agent", "install", "releases", "1.0.4"));
		mkdirSync(join(home, ".pi", "agent", "install"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "install", "current-version"), "1.0.4\n");
		const global = piHost(tempDir("global Pi"));
		const { findPiPackage } = await import("../scripts/test-peer-bootstrap.mjs");

		expect(findPiPackage({ explicit: "", home, globalRoots: [global] })).toBe(managed);
	});

	it("resolves hoisted peers and replaces a stale peer link", async () => {
		const hostRoot = tempDir("host");
		const host = packageAt(hostRoot, "@earendil-works/pi-coding-agent");
		const hoistedRoot = tempDir("hoisted");
		for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-tui", "typebox"]) packageAt(hostRoot, name, true);
		const output = tempDir("test node modules");
		mkdirSync(join(output, "@earendil-works"), { recursive: true });
		symlinkSync(join(hoistedRoot, "missing"), join(output, "@earendil-works", "pi-ai"));
		const { linkPeerPackages, resolvePeerPackages } = await import("../scripts/test-peer-bootstrap.mjs");

		const peers = await resolvePeerPackages(host);
		linkPeerPackages(output, { ...peers, "@earendil-works/pi-ai": join(hostRoot, "node_modules", "@earendil-works", "pi-ai") });
		expect(readlinkSync(join(output, "@earendil-works", "pi-ai"))).toBe(join(hostRoot, "node_modules", "@earendil-works", "pi-ai"));
	});

	it("reports every missing required peer", async () => {
		const root = tempDir("missing peer");
		const host = packageAt(root, "@earendil-works/pi-coding-agent");
		const { resolvePeerPackages } = await import("../scripts/test-peer-bootstrap.mjs");

		await expect(resolvePeerPackages(host)).rejects.toThrow("Missing Pi host peers");
	});
});
