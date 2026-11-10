import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { classifyFailure, parseEffectiveProviderTimeout, resolveEffectiveProviderTimeout, terminalFailureReason } from "../extensions/index.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function setup(global = "", project = "") {
	const homeDir = mkdtempSync(join(tmpdir(), "timeout-fixture-")); roots.push(homeDir);
	const runCwd = join(homeDir, "repo"); mkdirSync(runCwd); mkdirSync(join(homeDir, ".config", "swival"), { recursive: true });
	if (global) writeFileSync(join(homeDir, ".config", "swival", "config.toml"), global);
	if (project) writeFileSync(join(runCwd, "swival.toml"), project);
	return { homeDir, runCwd, env: {} };
}

describe("effective provider timeout hints", () => {
	it("validates persisted metadata, uses report ground truth and avoids legacy guesses", () => {
		for (const value of [null, {}, { seconds: -1, source: "default" }, { seconds: 600, source: "untrusted-value" }]) expect(parseEffectiveProviderTimeout(value)).toBeUndefined();
		const errorMessage = "litellm.Timeout: None seconds";
		expect(classifyFailure([], { errorMessage, providerTimeout: 300 }, { seconds: 600, source: "providerTimeoutOverride" })?.text).toContain("300s (report.settings)");
		expect(classifyFailure([errorMessage])?.text).toContain("timeout unresolved");
		expect(classifyFailure([errorMessage], undefined, { seconds: 800, source: "agent extraArgs" })?.text).toContain("raise the agent extraArgs --provider-timeout");
	});
	it("reports default, root config, project and selected-profile precedence", () => {
		expect(resolveEffectiveProviderTimeout(setup())).toEqual({ seconds: 900, source: "default" });
		expect(resolveEffectiveProviderTimeout(setup("provider_timeout=120\n"))).toEqual({ seconds: 120, source: "config.toml" });
		expect(resolveEffectiveProviderTimeout(setup("provider_timeout=120\n", "provider_timeout=240\n"))).toEqual({ seconds: 240, source: "swival.toml" });
		expect(resolveEffectiveProviderTimeout(setup('provider_timeout=120\nactive_profile="slow"\n[profiles.slow]\nprovider_timeout=600\n', "provider_timeout=240\n"))).toEqual({ seconds: 600, source: "config.toml selected profile" });
	});
	it("CLI selection and final extraArgs outrank config and frontmatter", () => {
		const options = setup('active_profile="slow"\n[profiles.slow]\nprovider_timeout=600\n[profiles.fast]\nprovider_timeout=60\n');
		expect(resolveEffectiveProviderTimeout({ ...options, args: ["--profile", "fast"] })).toEqual({ seconds: 60, source: "config.toml selected profile" });
		expect(resolveEffectiveProviderTimeout({ ...options, overrides: { providerTimeout: 400 }, agent: { providerTimeout: 300 } })).toEqual({ seconds: 400, source: "providerTimeoutOverride" });
		expect(resolveEffectiveProviderTimeout({ ...options, overrides: { providerTimeout: 400 }, agent: { extraArgs: ["--provider-timeout=800"] } })).toEqual({ seconds: 800, source: "agent extraArgs" });
	});
	it("labels unrecognized TOML as unresolved rather than inventing 900s", () => {
		expect(resolveEffectiveProviderTimeout(setup('"provider_timeout"=120\n')).seconds).toBeNull();
	});
	it("returns unresolved for a FIFO swival.toml without blocking the event loop", async () => {
		// A blocked synchronous open would freeze this worker and defeat Vitest's
		// own timeout, so resolve in a child process under a hard kill timeout.
		const { homeDir, runCwd } = setup();
		const mkfifo = promisify(execFile);
		await mkfifo("mkfifo", [join(runCwd, "swival.toml")]);
		const extensionsDir = fileURLToPath(new URL("../extensions/", import.meta.url));
		const modulesDir = fileURLToPath(new URL("./node_modules/", import.meta.url));
		// Node loads the TypeScript sources directly; the hook maps the `.js` import
		// specifiers to `.ts` siblings and the Pi peers to the test node_modules.
		const hook = `
			import { existsSync } from "node:fs";
			import { fileURLToPath } from "node:url";
			const extensions = ${JSON.stringify(pathToFileURL(extensionsDir).href)};
			const modules = ${JSON.stringify(pathToFileURL(modulesDir).href)};
			export async function resolve(specifier, context, next) {
				if (!context.parentURL?.startsWith(extensions) || specifier.startsWith("node:")) return next(specifier, context);
				if (!specifier.startsWith("./")) return next(specifier, { ...context, parentURL: modules });
				const sibling = new URL(specifier.replace(/\\.js$/, ".ts"), context.parentURL);
				return next(existsSync(fileURLToPath(sibling)) ? sibling.href : specifier, context);
			}`;
		const script = `
			import { register } from "node:module";
			register("data:text/javascript," + encodeURIComponent(${JSON.stringify(hook)}), import.meta.url);
			const { resolveEffectiveProviderTimeout } = await import(${JSON.stringify(pathToFileURL(join(extensionsDir, "index.ts")).href)});
			process.stdout.write(JSON.stringify(resolveEffectiveProviderTimeout({ runCwd: ${JSON.stringify(runCwd)}, homeDir: ${JSON.stringify(homeDir)}, env: {} })));`;
		const child = join(homeDir, "resolve-timeout.mjs"); writeFileSync(child, script);
		const { stdout } = await promisify(execFile)(process.execPath, ["--no-warnings", child],
			{ timeout: 15_000, killSignal: "SIGKILL", encoding: "utf8", env: { ...process.env, HOME: homeDir } });
		expect(JSON.parse(stdout)).toEqual({ seconds: null, source: "unresolved configuration" });
	}, 20_000);
	it("adds hint for terminal report and stderr timeout, not prior retried timeouts", () => {
		const hint = { seconds: 600, source: "providerTimeoutOverride" };
		const msg = "LLM call failed: litellm.Timeout: Connection timed out after None seconds.";
		expect(classifyFailure([msg], undefined, hint)?.text).toContain("effective provider timeout 600s (providerTimeoutOverride); raise `providerTimeoutOverride`");
		expect(terminalFailureReason(1, { outcome: "error", errorMessage: msg }, [], undefined, hint)?.text).toContain("600s");
		expect(classifyFailure([msg, "OSError: other failure"], undefined, hint)).toBeUndefined();
	});
});
