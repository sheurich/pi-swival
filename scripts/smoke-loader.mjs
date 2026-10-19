import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findPiPackage } from "./test-peer-bootstrap.mjs";

const packageRoot = resolve(process.argv[2] ?? ".");
const scratch = mkdtempSync(join(tmpdir(), "pi-swival-loader-"));
const agentDir = join(scratch, "agent");

function fail(message) {
	throw new Error(message);
}

function formatDiagnostics(diagnostics) {
	return diagnostics.map((diagnostic) => `${diagnostic.path ?? "resource"}: ${diagnostic.message ?? diagnostic.error ?? String(diagnostic)}`);
}

try {
	const piPackage = findPiPackage({ globalRoots: process.env.NPM_GLOBAL_ROOT ? [process.env.NPM_GLOBAL_ROOT] : [] });
	process.env.HOME = scratch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(join(piPackage, "dist", "index.js")).href);
	const loader = new DefaultResourceLoader({
		cwd: scratch,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
		additionalExtensionPaths: [packageRoot],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();

	const extensions = loader.getExtensions();
	const skills = loader.getSkills();
	const prompts = loader.getPrompts();
	const diagnostics = [
		...extensions.errors.map((error) => `${error.path}: ${error.error}`),
		...formatDiagnostics(skills.diagnostics),
		...formatDiagnostics(prompts.diagnostics),
	];
	if (diagnostics.length) fail(`Pi resource loader diagnostics:\n${diagnostics.join("\n")}`);
	if (extensions.extensions.length !== 1) fail(`Expected one extension, found ${extensions.extensions.length}`);
	const extension = extensions.extensions[0];
	if (!extension.tools.has("swival-subagent")) fail("Loaded extension did not register swival-subagent");
	if (skills.skills.length !== 3) fail(`Expected 3 skills, found ${skills.skills.length}`);
	if (prompts.prompts.length !== 1) fail(`Expected 1 prompt, found ${prompts.prompts.length}`);
	const agentFiles = readdirSync(join(packageRoot, "agents")).filter((name) => name.endsWith(".md")).sort();
	if (agentFiles.length !== 5) fail(`Expected 5 bundled agents, found ${agentFiles.length}`);
	for (const file of agentFiles) {
		const content = readFileSync(join(packageRoot, "agents", file), "utf8");
		if (!/^---\n[\s\S]*?^name:/m.test(content) || !/^---\n[\s\S]*?^description:/m.test(content)) fail(`Invalid bundled agent frontmatter: ${file}`);
	}
	console.log(`offline loader smoke: extensions=${extensions.extensions.length} tools=swival-subagent skills=${skills.skills.length} prompts=${prompts.prompts.length} agents=${agentFiles.length}`);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
