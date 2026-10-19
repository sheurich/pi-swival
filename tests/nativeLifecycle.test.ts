import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import registerExtension from "../extensions/index.js";
import { prepareNativeAudit, captureNativeRuntime, type NativeAuditLaunch } from "../extensions/native-audit.js";
import { nativeTestPython as python } from "./nativePython.js";
import { fixtureGit, fixtureRepository, nativeScratch, worktree } from "./nativeFixtures.js";
const roots: string[] = [];
const runs: NativeAuditLaunch[] = [];
const children: ChildProcess[] = [];
const groups: number[] = [];
afterEach(async () => {
	for (const run of runs.splice(0)) run.cancel("Fixture cleanup");
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const pid of groups.splice(0)) { try { process.kill(-pid, "SIGKILL"); } catch { /* live fixture already exited */ } }
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(mode = "complete", diagnosticReplay = "") {
	const root = nativeScratch("native-cli-"); roots.push(root);
	const source = fixtureRepository(root);
	const home = path.join(root, "home"); fs.mkdirSync(home);
	const config = path.join(home, ".config"); fs.mkdirSync(config);
	const temporary = path.join(root, "tmp"); fs.mkdirSync(temporary);
	const bin = path.join(root, "bin"); fs.mkdirSync(bin);
	const selectedPython = path.join(fs.realpathSync(path.dirname(python)), path.basename(python));
	const entry = path.join(bin, "swival");
	fs.writeFileSync(entry, `#!${selectedPython}
# Synthetic CLI only: no sandbox, provider or auth claim.
import json, os, signal, subprocess, sys, time
from pathlib import Path
args = sys.argv[1:]
snapshot = Path(args[args.index('--base-dir') + 1])
root = snapshot.parent
manifest = json.loads((root / 'manifest.json').read_text())
(root / 'launch.json').write_text(json.dumps({'args':args,'cwd':str(Path.cwd()),'stdin':sys.stdin.read(), 'env':dict(os.environ)}))
state = {'scope':manifest['scope'],'reviewed_files':manifest['scope']['mandatory_files'],
 'candidate_files':manifest['scope']['mandatory_files'],'deep_reviewed_files':manifest['scope']['mandatory_files'],
 'phase':'done','artifact_state':{},'verification_state':{},'verified_findings':[],'proposed_findings':[],'metrics':{},'truncated_files':{}}
state_dir = snapshot / '.swival' / 'audit' / 'abc12345'
state_dir.mkdir(parents=True)
(state_dir / 'state.json').write_text(json.dumps(state))
report = {'version':1,'task':args[-1],'provider':manifest['route']['provider'],'model':manifest['route']['model'],
 'settings':{'commands':'none','files':'some','instructions_status':'disabled','skills_discovered':[]},
 'sandbox':{'mode':'builtin'},'network':'provider-only',
 'result':{'outcome':'success','exit_code':0,'answer':'synthetic source-only audit'}}
if ${JSON.stringify(mode)} == 'auth-error': report['result'] = {'outcome':'error','exit_code':1,'error_message':'synthetic auth error'}
(snapshot / 'native-cli-report.json').write_text(json.dumps(report))
print('synthetic CLI diagnostics', flush=True)
if ${JSON.stringify(diagnosticReplay)}:
 output = ${JSON.stringify(diagnosticReplay)}
 stream = sys.stdout if ${JSON.stringify(mode)} in ('reviewer-error', 'malformed-reviewers', 'repaired-reviewers', 'reviewer-retry-recovered') else sys.stderr
 split = output.index('error:') + 3 if 'error:' in output else min(64, len(output))
 stream.write(output[:split]); stream.flush(); time.sleep(.05)
 stream.write(output[split:]); stream.flush()
if ${JSON.stringify(mode)} == 'separate-streams':
 sys.stdout.write('  phase 4.5: adjudicating 1 verified findings...\\nreviewer \\n'); sys.stdout.flush()
 time.sleep(.05)
 sys.stderr.write('error: synthetic unrelated error\\n  repair failed\\n'); sys.stderr.flush()
if ${JSON.stringify(mode)} == 'policy-retry': print('Prompt rejected; retrying in 2s (attempt 2/5)', flush=True)
if ${JSON.stringify(mode)} == 'lost': print('  code.py: 1/2 expansion(s) failed, 1 finding(s) retained', flush=True)
if ${JSON.stringify(mode)} == 'ambiguous': print('expansion(s) failed: unknown', flush=True)
if ${JSON.stringify(mode)} == 'auth-write-error': print('Failed to write ChatGPT auth file: synthetic denial', flush=True)
if ${JSON.stringify(mode)} == 'login-diagnostic': print('Enter code: synthetic-device-code-never-export', flush=True)
if ${JSON.stringify(mode)} in ('login-absent', 'login-expired'):
 import socket
 from unittest.mock import patch
 with patch.object(socket, 'socket', side_effect=AssertionError('network forbidden')), \\
      patch.object(socket, 'create_connection', side_effect=AssertionError('network forbidden')), \\
      patch.object(socket, 'getaddrinfo', side_effect=AssertionError('DNS forbidden')):
  import httpx
  from litellm.llms.chatgpt import authenticator
  auth = authenticator.Authenticator()
  expired = ${JSON.stringify(mode)} == 'login-expired'
  if expired:
   Path(auth.auth_file).write_text(json.dumps({'access_token':'synthetic-expired', 'expires_at':1, 'refresh_token':'synthetic-invalid-refresh'}))
  calls = []
  def auth_http(request):
   calls.append(request)
   if expired and len(calls) == 1: return httpx.Response(400, json={'error':'synthetic-invalid-refresh'})
   if len(calls) == (2 if expired else 1):
    return httpx.Response(200, json={'device_auth_id':'synthetic-device', 'user_code':'synthetic-device-code-never-export', 'interval':1})
   return httpx.Response(403, json={})
  with httpx.Client(transport=httpx.MockTransport(auth_http)) as client, patch.object(authenticator, '_get_httpx_client', return_value=client):
   auth.get_access_token()
if ${JSON.stringify(mode)} == 'noisy': print('x' * (3 * 1024 * 1024), flush=True)
if ${JSON.stringify(mode)} == 'descendant':
 child = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(20)'])
 (root / 'descendant-ready').write_text('ready')
if ${JSON.stringify(mode)} in ('timeout','wait'):
 signal.signal(signal.SIGTERM, signal.SIG_IGN)
 while True: time.sleep(.05)
`, { mode: 0o700 });
	const agentfs = path.join(bin, "agentfs");
	fs.writeFileSync(agentfs, `#!${selectedPython}
import os, sys
if '--version' in sys.argv: print('agentfs 0.6.4')
elif sys.argv[1] == 'run':
 command = sys.argv[sys.argv.index('--')+1:]
 os.execv(command[0], command)
else: print('')
`, { mode: 0o700 });
	const nono = path.join(bin, "nono"); fs.writeFileSync(nono, `#!${selectedPython}\nprint('synthetic nono availability')\n`, { mode: 0o700 });
	const runtime = { ...captureNativeRuntime(), python: selectedPython, cli: entry, agentfs, nono,
		searchPath: (process.env.PATH ?? "").split(path.delimiter).filter(path.isAbsolute).join(path.delimiter),
		environment: { HOME: home, XDG_CONFIG_HOME: config, TMPDIR: temporary,
			AGENTFS: "1", SWIVAL_AGENTFS_ACTIVE: "1", PYTHONPATH: "/hostile", NODE_OPTIONS: "hostile", NONO_NO_UPDATE_CHECK: "1" } };
	const params = { audit: { all: true, workers: 1, patchMaxTurns: 5 }, providerOverride: "chatgpt", modelOverride: "gpt-offline", timeoutMs: 5000 };
	const artifactDir = path.join(root, "artifacts");
	const start = async (overrides = {}, signal?: AbortSignal) => {
		const { validateNativeAuditParams } = await import("../extensions/native-audit.js");
		const input = { ...params, ...overrides };
		const run = await prepareNativeAudit(source, input, validateNativeAuditParams(input), runtime, artifactDir, "synthetic-native", 10_000, signal);
		runs.push(run); return run;
	};
	return { root, source, runtime, params, artifactDir, start };
}
async function launched(f: ReturnType<typeof fixture>) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (fs.existsSync(path.join(f.artifactDir, "launch.json"))) return;
		await wait(20);
	}
	throw new Error("Synthetic CLI did not reach launch");
}

describe("synchronous native CLI lifecycle", () => {
	it.runIf(process.platform === "darwin").each(["Library", ".agentfs"])(
		"refuses a source alias in the upstream %s write exception before launch", async (exception) => {
			const f = fixture();
			fs.symlinkSync(f.source, path.join(f.runtime.environment.HOME, exception));
			// AgentFS descendants now fail the cross-platform runtime-path gate;
			// Library still exercises the Darwin-only built-in write exceptions.
			await expect(f.start()).rejects.toThrow(exception === ".agentfs" ? /runtime configuration.*source\/Git/i : /built-in writable/);
			expect(fs.existsSync(f.artifactDir)).toBe(false);
		}, 20_000);
	it.each(["git", "python", "cli", "agentfs", "nono"] as const)(
		"rejects a case-aliased or symlinked repository-owned %s before Python imports", async (selection) => {
			const f = fixture(); const bin = path.join(f.source, "runtime"); fs.mkdirSync(bin);
			const sentinel = path.join(f.root, "forbidden-runtime-started");
			const name = selection === "python" ? "python3.13" : selection;
			fs.writeFileSync(path.join(bin, name), `#!${f.runtime.python}\nfrom pathlib import Path\nPath(${JSON.stringify(sentinel)}).write_text("forbidden")\n`, { mode: 0o700 });
			const alias = path.join(f.root, "SOURCE");
			if (!fs.existsSync(alias)) fs.symlinkSync(f.source, alias);
			f.runtime[selection] = path.join(alias, "runtime", name);
			await expect(f.start()).rejects.toThrow(/repository/);
			expect(fs.existsSync(sentinel)).toBe(false);
			expect(fs.existsSync(f.artifactDir)).toBe(false);
		}, 20_000);
	it.each(["git", "python", "cli", "agentfs", "nono"] as const)(
		"rejects %s symlink chains through case-aliased repository entries before Python imports", async (selection) => {
			const f = fixture(); const bin = path.join(f.source, "runtime"); fs.mkdirSync(bin);
			const name = selection === "python" ? "python3.13" : selection;
			fs.symlinkSync(f.runtime[selection]!, path.join(bin, name));
			const alias = path.join(f.root, "SOURCE");
			if (!fs.existsSync(alias)) fs.symlinkSync(f.source, alias);
			const external = path.join(f.root, "launch-links"); fs.mkdirSync(external);
			const entry = path.join(external, name); fs.symlinkSync(path.join(alias, "runtime", name), entry);
			f.runtime[selection] = entry;
			await expect(f.start().then(async (run) => { await run.completion; return "launched"; })).rejects.toThrow(/repository/);
			expect(fs.existsSync(f.artifactDir)).toBe(false);
		}, 20_000);
	it("freezes CLI routing, excludes dirty/staged/untracked source, and exports after teardown", async () => {
		const f = fixture(); const before = fixtureGit(f.source, "show-ref");
		fs.writeFileSync(path.join(f.source, "code.py"), "staged\n"); fixtureGit(f.source, "add", "code.py");
		fs.writeFileSync(path.join(f.source, "code.py"), "dirty\n"); fs.writeFileSync(path.join(f.source, "untracked.py"), "untracked\n");
		const status = fixtureGit(f.source, "status", "--porcelain=v1");
		const run = await f.start(); const terminal = await run.completion;
		expect(terminal).toMatchObject({ exitCode: 0, shutdown: "verified", boundary: "agentfs-cli" });
		const launch = JSON.parse(fs.readFileSync(path.join(f.artifactDir, "launch.json"), "utf8"));
		expect(launch.stdin).toBe(""); expect(launch.cwd).toBe(path.join(f.artifactDir, "snapshot"));
		expect(launch.args.slice(-2)).toEqual(["--", "/audit --all --workers 1 --patch-max-turns 5"]);
		for (const key of ["AGENTFS", "SWIVAL_AGENTFS_ACTIVE", "PYTHONPATH", "NODE_OPTIONS"]) expect(launch.env[key]).toBeUndefined();
		expect(launch.env.LITELLM_LOCAL_MODEL_COST_MAP).toBe("True");
		expect(fs.existsSync(path.join(f.artifactDir, "snapshot"))).toBe(false);
		expect(fs.existsSync(path.join(f.artifactDir, "evidence/native-state/abc12345/state.json"))).toBe(true);
		expect(fixtureGit(f.source, "show-ref")).toBe(before); expect(fixtureGit(f.source, "status", "--porcelain=v1")).toBe(status);
		const { inspectNativeAudit } = await import("../extensions/native-audit.js");
		expect((await inspectNativeAudit(f.artifactDir, terminal.exitCode)).status).toBe("completed");
	}, 20_000);
	it.each([null, "http://127.0.0.1:8444/v1"])("freezes API defaults and endpoint %s without ChatGPT authority", async (endpoint) => {
		const f = fixture();
		Object.assign(f.runtime.environment, { OPENROUTER_API_KEY: "synthetic-selected-api", CHATGPT_API_KEY: "synthetic-unrelated-chatgpt" });
		fs.mkdirSync(path.join(f.runtime.environment.XDG_CONFIG_HOME, "swival"));
		fs.writeFileSync(path.join(f.runtime.environment.XDG_CONFIG_HOME, "swival/config.toml"),
			'provider="openrouter"\nmodel="example/concrete"\nmax_context_tokens=128000\n' + (endpoint ? `base_url="${endpoint}"\n` : ""));
		const run = await f.start({ providerOverride: undefined, modelOverride: undefined }); const term = await run.completion;
		const launch = JSON.parse(fs.readFileSync(path.join(f.artifactDir, "launch.json"), "utf8"));
		expect(launch.env.OPENROUTER_API_KEY).toBe("synthetic-selected-api");
		for (const key of ["CHATGPT_API_KEY", "CHATGPT_TOKEN_DIR", "CHATGPT_AUTH_FILE"]) expect(launch.env[key]).toBeUndefined();
		expect(fs.existsSync(path.join(f.runtime.environment.HOME, ".config/litellm/chatgpt"))).toBe(false);
		const manifest = JSON.parse(fs.readFileSync(path.join(f.artifactDir, "manifest.json"), "utf8"));
		expect(manifest.authStore).toBeUndefined(); expect(manifest.route).toMatchObject({ provider: "openrouter", model: "example/concrete", endpoint });
		expect(JSON.stringify(manifest)).not.toContain("synthetic-selected-api");
		const { inspectNativeAudit } = await import("../extensions/native-audit.js");
		expect((await inspectNativeAudit(f.artifactDir, term.exitCode)).status).toBe("completed");
	}, 20_000);
	it("rejects changed selected route on the second preflight before worker launch", async () => {
		const f = fixture(); const filename = path.join(f.runtime.environment.XDG_CONFIG_HOME, "swival/config.toml");
		fs.mkdirSync(path.dirname(filename)); fs.writeFileSync(filename, 'reasoning_effort="high"\n');
		fs.writeFileSync(f.runtime.agentfs!, `#!${f.runtime.python}\nimport sys\nfrom pathlib import Path\nif '--version' in sys.argv:\n Path(${JSON.stringify(filename)}).write_text('reasoning_effort="low"\\n')\n print('agentfs 0.6.4')\nelse: print('')\n`, { mode: 0o700 });
		await expect(f.start()).rejects.toThrow(/route changed.*no fallback/i);
		expect(fs.existsSync(f.artifactDir)).toBe(false);
	}, 20_000);
	it.each(["lost", "ambiguous", "auth-error", "auth-write-error", "noisy"])("cannot complete after %s", async (mode) => {
		const f = fixture(mode); const run = await f.start(); const term = await run.completion;
		const { inspectNativeAudit } = await import("../extensions/native-audit.js");
		expect((await inspectNativeAudit(f.artifactDir, term.exitCode)).status).not.toBe("completed");
	}, 20_000);
	it.each(["reviewer-error", "consolidate-error"])("refuses Rich-wrapped released terminal %s through production diagnostics", async (mode) => {
		const exported = nativeScratch("released-adjudication-"); roots.push(exported);
		const produced = await new Promise<{ code: number; output: string }>((resolve) => {
			execFile(python, ["-I", "-B", path.join(import.meta.dirname, "native_audit_test.py"), "--export-finding", exported, mode], {
				timeout: 30_000, maxBuffer: 64 * 1024, env: { ...process.env, LITELLM_LOCAL_MODEL_COST_MAP: "True", NONO_NO_UPDATE_CHECK: "1" },
			}, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, output: stdout + stderr }));
		});
		expect(produced.code, produced.output).toBe(0);
		const raw = fs.readFileSync(path.join(exported, "released-diagnostics.txt"), "utf8");
		const marker = mode === "reviewer-error" ? "reviewer" : "consolidate";
		expect(raw).not.toContain(`${marker} error:`);
		expect(raw).toContain(`${marker} \nerror:`);
		expect(raw.match(new RegExp(`${marker}\\s+error:`, "g")))
			.toHaveLength(mode === "reviewer-error" ? 6 : 1);
		const report = JSON.parse(fs.readFileSync(path.join(exported, "evidence/native-cli-report.json"), "utf8"));
		expect(report.result).toMatchObject({ outcome: "success", exit_code: 0 });
		const states = fs.readdirSync(path.join(exported, "evidence/native-state"));
		const state = JSON.parse(fs.readFileSync(path.join(exported, "evidence/native-state", states[0], "state.json"), "utf8"));
		expect(state.phase).toBe("done"); expect(state.verified_findings).toHaveLength(1);
		expect(Object.values(state.artifact_state)).toEqual([expect.objectContaining({ status: "written" })]);
		// Replay actual released diagnostics through the production collector, not a copied classifier.
		const f = fixture(mode, raw); const run = await f.start(); const term = await run.completion;
		expect(term).toMatchObject({ exitCode: 0, shutdown: "verified" }); expect(term.stopped).toBeUndefined();
		const diagnostics = fs.readFileSync(path.join(f.artifactDir, "diagnostics.json"), "utf8");
		expect(diagnostics).not.toContain("synthetic-terminal-adjudication-value-never-export");
		fs.writeFileSync(path.join(exported, "diagnostics.json"), diagnostics);
		const { inspectNativeAudit } = await import("../extensions/native-audit.js");
		for (const artifactDir of [exported, f.artifactDir]) {
			const result = await inspectNativeAudit(artifactDir, 0);
			expect(result.status).toBe("partial"); expect(result.error).toContain("adjudication");
			expect(result.answer).toBeUndefined();
			expect(JSON.stringify(result)).not.toContain("synthetic-terminal-adjudication-value-never-export");
		}
		expect(JSON.parse(diagnostics)).toMatchObject({ closed: true, adjudicationFailure: true,
			adjudicationRepairFailure: false });
	}, 45_000);
	it.each(["malformed-reviewers", "malformed-consolidation", "repaired-reviewers",
		"repaired-consolidation", "reviewer-retry-recovered", "triage-promoted"])(
		"classifies released %s after production collection without cancelling recovery", async (mode) => {
			const exported = nativeScratch("released-repair-"); roots.push(exported);
			const produced = await new Promise<{ code: number; output: string }>((resolve) => {
				execFile(python, ["-I", "-B", path.join(import.meta.dirname, "native_audit_test.py"), "--export-finding", exported, mode], {
					timeout: 30_000, maxBuffer: 64 * 1024,
					env: { ...process.env, LITELLM_LOCAL_MODEL_COST_MAP: "True", NONO_NO_UPDATE_CHECK: "1" },
				}, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, output: stdout + stderr }));
			});
			expect(produced.code, produced.output).toBe(0);
			const raw = fs.readFileSync(path.join(exported, "released-diagnostics.txt"), "utf8");
			const exhausted = mode.startsWith("malformed-") || mode === "reviewer-retry-recovered";
			if (exhausted) expect(raw).toContain("repair failed");
			if (mode.startsWith("repaired-")) {
				expect(raw).toContain("repair succeeded"); expect(raw).not.toContain("repair failed");
			}
			if (mode === "triage-promoted") expect(raw).toContain("promoted due to triage infrastructure failure");
			const report = JSON.parse(fs.readFileSync(path.join(exported, "evidence/native-cli-report.json"), "utf8"));
			expect(report.result).toMatchObject({ outcome: "success", exit_code: 0 });
			const states = fs.readdirSync(path.join(exported, "evidence/native-state"));
			const state = JSON.parse(fs.readFileSync(path.join(exported, "evidence/native-state", states[0], "state.json"), "utf8"));
			expect(state.phase).toBe("done"); expect(state.verified_findings).toHaveLength(1);
			expect(Object.values(state.artifact_state)).toEqual([expect.objectContaining({ status: "written" })]);
			const f = fixture(mode, raw); const run = await f.start(); const term = await run.completion;
			expect(term).toMatchObject({ exitCode: 0, shutdown: "verified" }); expect(term.stopped).toBeUndefined();
			const diagnostics = fs.readFileSync(path.join(f.artifactDir, "diagnostics.json"), "utf8");
			expect(diagnostics).not.toContain("synthetic-malformed-adjudication-value-never-export");
			fs.writeFileSync(path.join(exported, "diagnostics.json"), diagnostics);
			const { inspectNativeAudit } = await import("../extensions/native-audit.js");
			for (const artifactDir of [exported, f.artifactDir]) {
				const result = await inspectNativeAudit(artifactDir, 0);
				expect(result.status, result.error).toBe(exhausted ? "partial" : "completed");
				if (exhausted) {
					expect(result.answer).toBeUndefined();
					expect(result.error).toContain("adjudication completeness cannot be verified");
				}
			}
			expect(JSON.parse(diagnostics)).toMatchObject({ closed: true,
				adjudicationFailure: false, adjudicationRepairFailure: exhausted });
		}, 45_000);
	it.each(["reviewer", "consolidate"])("detects an unterminated wrapped %s marker across writes", async (kind) => {
		const f = fixture("complete", `  adjudicate [synthetic]: ${kind} \nerror: synthetic-value-never-export`);
		const run = await f.start(); const term = await run.completion;
		expect(term).toMatchObject({ exitCode: 0, shutdown: "verified" }); expect(term.stopped).toBeUndefined();
		const { inspectNativeAudit } = await import("../extensions/native-audit.js");
		const result = await inspectNativeAudit(f.artifactDir, 0);
		expect(result.status).toBe("partial"); expect(result.answer).toBeUndefined();
		expect(fs.readFileSync(path.join(f.artifactDir, "diagnostics.json"), "utf8"))
			.not.toContain("synthetic-value-never-export");
	}, 20_000);
	it("never joins separate streams into an error marker or repair phase", async () => {
		const f = fixture("separate-streams"); const run = await f.start(); const term = await run.completion;
		const diagnostics = JSON.parse(fs.readFileSync(path.join(f.artifactDir, "diagnostics.json"), "utf8"));
		expect(diagnostics).toMatchObject({ adjudicationFailure: false, adjudicationRepairFailure: false });
		const { inspectNativeAudit } = await import("../extensions/native-audit.js");
		expect((await inspectNativeAudit(f.artifactDir, term.exitCode)).status).toBe("completed");
	}, 20_000);
	it("does not latch generic repair failure outside Phase 4.5", async () => {
		const f = fixture("complete", "  repair failed\n  phase 4.5: adjudicating 1 verified findings...\n  repair succeeded\n  phase 4.5 complete. 1 kept, 0 dropped, 0 recalibrated.\n  repair failed\n");
		const run = await f.start(); const term = await run.completion;
		const diagnostics = JSON.parse(fs.readFileSync(path.join(f.artifactDir, "diagnostics.json"), "utf8"));
		expect(diagnostics).toMatchObject({ adjudicationFailure: false, adjudicationRepairFailure: false });
		const { inspectNativeAudit } = await import("../extensions/native-audit.js");
		expect((await inspectNativeAudit(f.artifactDir, term.exitCode)).status).toBe("completed");
	}, 20_000);
	it("does not treat an intermediate same-route policy retry as terminal adjudication failure", async () => {
		const f = fixture("policy-retry"); const run = await f.start(); const term = await run.completion;
		const diagnostics = JSON.parse(fs.readFileSync(path.join(f.artifactDir, "diagnostics.json"), "utf8"));
		expect(diagnostics).toMatchObject({ adjudicationFailure: false, adjudicationRepairFailure: false });
		const { inspectNativeAudit } = await import("../extensions/native-audit.js");
		expect((await inspectNativeAudit(f.artifactDir, term.exitCode)).status).toBe("completed");
	}, 20_000);
	it.each(["login-absent", "login-expired"])("cancels actual upstream %s challenges without leaking the challenge", async (mode) => {
		const f = fixture(mode); const run = await f.start(); const term = await run.completion;
		expect(term).toMatchObject({ exitCode: 1, shutdown: "verified" });
		expect(term.stopped).toBe("Native ChatGPT login is required. Authenticate with upstream Swival outside Pi, then rerun the audit.");
		const { inspectNativeAudit } = await import("../extensions/native-audit.js");
		const result = await inspectNativeAudit(f.artifactDir, term.exitCode);
		expect(result.status).toBe("failed");
		for (const text of [JSON.stringify(term), JSON.stringify(result),
			fs.readFileSync(path.join(f.artifactDir, "diagnostics.json"), "utf8"),
			fs.readFileSync(path.join(f.artifactDir, "evidence/native-cli-report.json"), "utf8")]) {
			for (const secret of ["synthetic-device-code-never-export", "synthetic-invalid-refresh", "https://auth.openai.com"]) expect(text).not.toContain(secret);
		}
	}, 20_000);
	it("does not retain standard login diagnostic contents in adapter evidence", async () => {
		const f = fixture("login-diagnostic"); const run = await f.start(); await run.completion;
		expect(fs.readFileSync(path.join(f.artifactDir, "diagnostics.json"), "utf8")).not.toContain("synthetic-device-code-never-export");
	}, 20_000);
	it.each(["timeout", "cancel"])("fails a silent wait and stops the live TERM-ignoring group on %s", async (mode) => {
		const f = fixture("timeout"); const controller = new AbortController();
		const run = await f.start({ timeoutMs: mode === "timeout" ? 300 : 5000 }, controller.signal);
		await launched(f); if (mode === "cancel") controller.abort();
		const term = await run.completion;
		expect(term.exitCode).not.toBe(0); expect(term.stopped).toMatch(mode === "timeout" ? /timed out/ : /cancelled/);
		expect(term.shutdown).toBe("verified"); expect(() => process.kill(-run.proc.pid!, 0)).toThrow();
		const { inspectNativeAudit } = await import("../extensions/native-audit.js");
		const result = await inspectNativeAudit(f.artifactDir, term.exitCode);
		expect(result.status).toBe("failed"); expect(result.answer).toBeUndefined();
	}, 20_000);
	it("requires descendant shutdown before export and never treats leftover descendants as success", async () => {
		const f = fixture("descendant"); const run = await f.start(); const term = await run.completion;
		expect(term.exitCode).not.toBe(0); expect(term.stopped).toContain("descendants");
		if (term.shutdown !== "verified") expect(fs.existsSync(path.join(f.artifactDir, "evidence/native-state"))).toBe(false);
	}, 20_000);
	it.each(["status", "resume", "interrupt"])("refuses disk-recovered native %s without signalling a recorded PID", async (action) => {
		const f = fixture(); fs.mkdirSync(f.artifactDir);
		fs.writeFileSync(path.join(f.artifactDir, "run-meta.json"), JSON.stringify({ runId: "crashed", artifactDir: f.artifactDir, nativeAuditRequested: true, pid: process.pid }));
		let tool: any; registerExtension({ registerTool: (value: unknown) => { tool = value; } } as any, { artifactRoot: f.root });
		const result = await tool.execute("native-recovery", { action, id: "crashed" }, undefined, undefined, { cwd: f.source, hasUI: false });
		expect(result.isError).toBe(true); expect(fs.existsSync(path.join(f.artifactDir, "completed.json"))).toBe(false);
	});
	it("stops an active native run through the normal idempotent session-shutdown hook", async () => {
		const f = fixture("wait");
		const artifactRoot = path.join(f.root, "session-runs");
		const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR };
		let hook: (() => Promise<void>) | undefined;
		let tool: any;
		try {
			process.env.HOME = f.runtime.environment.HOME;
			process.env.TMPDIR = f.runtime.environment.TMPDIR;
			process.env.XDG_CONFIG_HOME = f.runtime.environment.XDG_CONFIG_HOME;
			process.env.PATH = `${path.dirname(f.runtime.cli)}${path.delimiter}${f.runtime.searchPath}`;
			registerExtension({ registerTool: (value: unknown) => { tool = value; }, on: (event: string, handler: () => Promise<void>) => {
				if (event === "session_shutdown") hook = handler;
			} } as any, { artifactRoot, nativePython: f.runtime.python, nativeMaxTimeoutMs: 10_000 });
		} finally {
			for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		const resultPromise = tool.execute("normal-shutdown", f.params, undefined, undefined, { cwd: f.source, hasUI: false });
		try {
			let ready = false;
			for (let attempt = 0; attempt < 500; attempt++) {
				const directory = fs.existsSync(artifactRoot) ? fs.readdirSync(artifactRoot)[0] : undefined;
				if (directory && fs.existsSync(path.join(artifactRoot, directory, "launch.json"))) { ready = true; break; }
				await wait(20);
			}
			expect(ready, "Native execution must reach the fixture before shutdown").toBe(true);
			expect(hook).toBeTypeOf("function"); await hook!(); await hook!();
			const result = await resultPromise;
			expect(result.isError).toBe(true); expect(result.content[0].text).toContain("session shutdown");
			const directory = fs.readdirSync(artifactRoot)[0];
			const terminal = JSON.parse(fs.readFileSync(path.join(artifactRoot, directory, "completed.json"), "utf8"));
			expect(terminal.shutdown).toBe("verified"); expect(terminal.exitCode).not.toBe(0);
		} finally { await hook?.(); await resultPromise; }
	}, 20_000);

	it("documents actual parent-loss behavior: the CLI may survive, with no export or completion", async () => {
		const f = fixture("wait");
		const require = createRequire(import.meta.url);
		const piPackage = process.env.PI_CODING_AGENT_PACKAGE ?? fs.realpathSync(path.join(worktree, "tests/node_modules/@earendil-works/pi-coding-agent"));
		const jiti = require.resolve("jiti", { paths: [piPackage] });
		const script = `const jiti=require(${JSON.stringify(jiti)}).createJiti(__filename);
(async()=>{ const native=await jiti.import(${JSON.stringify(path.join(worktree, "extensions/native-audit.ts"))});
const params=${JSON.stringify(f.params)};
const run=await native.prepareNativeAudit(${JSON.stringify(f.source)},params,native.validateNativeAuditParams(params),${JSON.stringify(f.runtime)},${JSON.stringify(f.artifactDir)},'parent-loss',10000);
process.send({pid:run.proc.pid}); await run.completion; })().catch(()=>process.exit(1));`;
		const scriptPath = path.join(f.root, "parent.cjs"); fs.writeFileSync(scriptPath, script);
		const parent = spawn(process.execPath, [scriptPath], { shell: false, env: { PATH: f.runtime.searchPath, HOME: f.runtime.environment.HOME,
			TMPDIR: path.join(worktree, "tests/.scratch/tmp"), XDG_CACHE_HOME: path.join(f.root, "cache"), NONO_NO_UPDATE_CHECK: "1" }, stdio: ["ignore", "ignore", "ignore", "ipc"] }); children.push(parent);
		const pid = await new Promise<number>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Parent fixture startup timed out")), 15_000);
			parent.once("message", (message: any) => { clearTimeout(timer); resolve(message.pid); });
			parent.once("exit", () => { clearTimeout(timer); reject(new Error("Parent fixture failed before live ownership")); });
		}); groups.push(pid);
		await launched(f); parent.kill("SIGKILL"); await wait(200);
		expect(() => process.kill(pid, 0)).not.toThrow();
		expect(fs.existsSync(path.join(f.artifactDir, "completed.json"))).toBe(false);
		expect(fs.existsSync(path.join(f.artifactDir, "evidence/native-state"))).toBe(false);
		expect(fs.existsSync(path.join(f.artifactDir, "snapshot"))).toBe(true);
	}, 25_000);
});
