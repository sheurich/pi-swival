import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REQUIRED_PEERS = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
];

function isPiPackage(path) {
	try {
		return JSON.parse(readFileSync(join(path, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent";
	} catch {
		return false;
	}
}

function managedPiPackage(home) {
	const install = join(home, ".pi", "agent", "install");
	try {
		const version = readFileSync(join(install, "current-version"), "utf8").trim();
		const candidate = join(install, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
		return isPiPackage(candidate) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

export function findPiPackage({ explicit = process.env.PI_CODING_AGENT_PACKAGE ?? process.env.PI_PACKAGE_DIR, home = process.env.HOME, globalRoots = [] } = {}) {
	if (explicit) {
		const candidate = resolve(explicit);
		if (!isPiPackage(candidate)) throw new Error(`PI_CODING_AGENT_PACKAGE is not a Pi package: ${candidate}`);
		return candidate;
	}
	const managed = home && managedPiPackage(home);
	if (managed) return managed;
	for (const root of globalRoots) {
		const candidate = join(root, "@earendil-works", "pi-coding-agent");
		if (isPiPackage(candidate)) return candidate;
	}
	throw new Error("Could not find Pi. Set PI_CODING_AGENT_PACKAGE or PI_PACKAGE_DIR to the selected @earendil-works/pi-coding-agent package.");
}

function packageRoot(resolvedFile, packageName) {
	let current = dirname(resolvedFile);
	while (dirname(current) !== current) {
		try {
			if (JSON.parse(readFileSync(join(current, "package.json"), "utf8")).name === packageName) return current;
		} catch {
			// Keep walking to the package root.
		}
		current = dirname(current);
	}
	throw new Error(`Resolved ${packageName} outside a package directory: ${resolvedFile}`);
}

export async function resolvePeerPackages(piPackage) {
	const peers = {};
	const missing = [];
	for (const peer of REQUIRED_PEERS) {
		try {
			// Resolve from the selected host's module context. createRequire cannot
			// resolve Pi's import-only exports, so use ESM resolution in a short,
			// fixed-argument Node subprocess with a bounded output buffer.
			const resolved = execFileSync(
				process.execPath,
				["--input-type=module", "--eval", "console.log(await import.meta.resolve(process.argv[1]))", peer],
				{ cwd: piPackage, encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024, stdio: ["ignore", "pipe", "pipe"] },
			).trim();
			peers[peer] = packageRoot(fileURLToPath(resolved), peer);
		} catch (error) {
			missing.push(`${peer} (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	if (missing.length) throw new Error(`Missing Pi host peers:\n${missing.join("\n")}`);
	return peers;
}

export function linkPeerPackages(nodeModules, peers) {
	for (const [peer, target] of Object.entries(peers)) {
		const link = join(nodeModules, ...peer.split("/"));
		mkdirSync(dirname(link), { recursive: true });
		if (existsSync(link) || (() => { try { return lstatSync(link).isSymbolicLink(); } catch { return false; } })()) rmSync(link, { recursive: true, force: true });
		symlinkSync(target, link, "junction");
	}
}

async function main() {
	if (process.argv[2] !== "--link" || !process.argv[3]) throw new Error("Usage: test-peer-bootstrap.mjs --link <tests/node_modules>");
	const globalRoot = process.env.NPM_GLOBAL_ROOT ? [process.env.NPM_GLOBAL_ROOT] : [];
	const piPackage = findPiPackage({ globalRoots: globalRoot });
	const peers = await resolvePeerPackages(piPackage);
	linkPeerPackages(resolve(process.argv[3]), peers);
	console.log(`Linked Pi peers from ${piPackage}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
	console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
