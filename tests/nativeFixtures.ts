import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export const worktree = fs.realpathSync(path.resolve(import.meta.dirname, ".."));
export function nativeScratch(prefix: string): string {
	const root = path.join(worktree, "tests", ".scratch", "tmp");
	fs.mkdirSync(root, { recursive: true });
	if (fs.realpathSync(root) !== root) throw new Error("Fixture temp root escaped the worktree");
	return fs.mkdtempSync(path.join(root, prefix));
}
// Fixture runtimes must not inherit cwd-relative executable search entries.
export function fixtureSearchPath(searchPath = process.env.PATH ?? ""): string {
	return searchPath.split(path.delimiter).filter(path.isAbsolute).join(path.delimiter);
}
export function fixtureGit(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
		"-c", "core.excludesFile=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, timeout: 5000, maxBuffer: 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}
export function fixtureRepository(root: string): string {
	const source = path.join(root, "source"); fs.mkdirSync(source);
	fixtureGit(source, "init", "--template=");
	fixtureGit(source, "config", "user.name", "Test");
	fixtureGit(source, "config", "user.email", "test@example.invalid");
	fs.writeFileSync(path.join(source, "code.py"), "def answer(): return 42\n");
	fixtureGit(source, "add", "."); fixtureGit(source, "commit", "-m", "synthetic fixture");
	return source;
}
export function completeNativeFixture(root: string, stateOverride: Record<string, unknown> = {}) {
	const scope = { branch: "main", commit: "1".repeat(40), tracked_files: ["code.py"], mandatory_files: ["code.py"], focus: [] };
	const route = { version: 2, runtime: { swival: "1.0.46", litellm: "1.103.4" }, provider: "chatgpt", model: "gpt-offline", options: {}, reasoningEffort: null,
		endpoint: null, profile: null, selection: { profileSource: null, explicitFields: [] }, reportIdentity: { provider: "chatgpt", model: "gpt-offline" } };
	const state = { scope, reviewed_files: ["code.py"], candidate_files: ["code.py"], deep_reviewed_files: ["code.py"],
		phase: "done", truncated_files: {}, metrics: {}, artifact_state: {}, proposed_findings: [], verification_state: {}, verified_findings: [], ...stateOverride };
	const command = "/audit --all --workers 1 --patch-max-turns 5";
	const session = "native-" + "1".repeat(32);
	const stateDir = path.join(root, "evidence", "native-state", "abc12345"); fs.mkdirSync(stateDir, { recursive: true });
	const write = (relative: string, value: unknown) => fs.writeFileSync(path.join(root, relative), JSON.stringify(value));
	write("manifest.json", { snapshotCommit: scope.commit, files: scope.tracked_files, sandbox: "agentfs", session, scope, route, audit: { all: true }, command });
	write("completed.json", { exitCode: 0, exitedAt: new Date().toISOString(), shutdown: "verified", boundary: "agentfs-cli" });
	write("evidence/native-state/abc12345/state.json", state);
	write("evidence/native-cli-report.json", { version: 1, task: command, provider: route.provider, model: route.model,
		settings: { commands: "none", files: "some", instructions_status: "disabled", skills_discovered: [] }, network: "provider-only",
		sandbox: { mode: "builtin" }, result: { outcome: "success", exit_code: 0, answer: "Native source-only result" } });
	write("diagnostics.json", { closed: true, bytes: 123, expansionFailures: 0, ambiguous: false,
		authPersistenceFailure: false, adjudicationFailure: false, adjudicationRepairFailure: false });
	return { state, scope, route, write, stateDir, command, session };
}
