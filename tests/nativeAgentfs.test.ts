import { describe, expect, it } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { nativeTestPython } from "./nativePython.js";
import { buildNativeAgentfsArgs, captureNativeRuntime, prepareNativeAudit, inspectNativeAudit } from "../extensions/native-audit.js";
import { fixtureRepository, fixtureSearchPath, nativeScratch } from "./nativeFixtures.js";
import { resolveSwivalReviewEnv } from "../extensions/index.js";

// Probe the production external-AgentFS boundary and host-visible snapshot collection.
// AgentFS overlays a separate empty cwd; only the snapshot receives a write-through grant.
// Only provider resolution is replaced. The fixture never reaches a provider or auth.
describe("native upstream AgentFS mechanism", () => {
	it("bootstraps the real CLI and collects bounded snapshot files after teardown", async () => {
		const worktree = fs.realpathSync(path.resolve(import.meta.dirname, ".."));
		const temporary = path.join(worktree, "tests", ".scratch", "tmp");
		fs.mkdirSync(temporary, { recursive: true });
		expect(fs.realpathSync(temporary), "The fixture temp directory must stay inside this worktree.")
			.toBe(temporary);
		const root = fs.mkdtempSync(path.join(temporary, "native-agentfs-"));
		const home = path.join(root, "home");
		const snapshot = path.join(root, "snapshot");
		const sandboxCwd = path.join(root, "sandbox-cwd");
		const source = path.join(root, "source");
		const findings = path.join(snapshot, "audit-findings");
		const session = `native-probe-${randomBytes(16).toString("hex")}`;
		const python = process.env.NATIVE_AGENTFS_TEST_PYTHON ?? nativeTestPython;
		const search = (process.env.PATH ?? "").split(path.delimiter).filter(path.isAbsolute);
		const agentfsEntry = search.map((entry) => path.join(entry, "agentfs"))
			.find((entry) => { try { fs.accessSync(entry, fs.constants.X_OK); return true; } catch { return false; } });
		expect(agentfsEntry, "The real AgentFS binary is required; no skipped native mechanism gate.").toBeDefined();
		const agentfs = fs.realpathSync(agentfsEntry!);
		for (const directory of [home, snapshot, sandboxCwd, source, path.join(root, "tmp")]) fs.mkdirSync(directory);
		const pack = path.join(home, ".config", "nono", "packages", "jedisct1", "swival");
		fs.mkdirSync(path.join(pack, "profiles"), { recursive: true });
		const reviewedPack = path.join(worktree, "tests", "fixtures", "nono-availability");
		fs.copyFileSync(path.join(reviewedPack, "package.json"), path.join(pack, "package.json"));
		fs.copyFileSync(path.join(reviewedPack, "policy.json"), path.join(pack, "profiles", "swival.json"));
		// Availability precheck only: no authenticated pack or nono enforcement claim.
		// nono e5ff57f916b528c38ee00d20556d86902215e3d8, package.rs:108–134,355–371.
		fs.writeFileSync(path.join(path.dirname(path.dirname(pack)), "lockfile.json"), JSON.stringify({
			lockfile_version: 4,
			packages: { "jedisct1/swival": { version: "0.1.2", installed_at: "2000-01-01T00:00:00Z" } },
		}));
		fs.writeFileSync(path.join(source, "sentinel"), "original-source");
		fs.mkdirSync(path.join(source, ".git"));
		fs.writeFileSync(path.join(source, ".git", "HEAD"), "original-git");
		fs.writeFileSync(path.join(snapshot, "swival.toml"), 'self_review = true\nreviewer = "external.sh"\n');
		const env: NodeJS.ProcessEnv = {
			PATH: search.join(path.delimiter), HOME: home, TMPDIR: path.join(root, "tmp"),
			XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
			LITELLM_LOCAL_MODEL_COST_MAP: "True", NONO_NO_UPDATE_CHECK: "1",
			GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
		};
		const local = (args: string[]) => execFileSync(agentfs, args, {
			cwd: root, env, timeout: 10_000, maxBuffer: 16_384, encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const entry = path.join(root, "offline-cli");
		fs.writeFileSync(entry, `#!${python}
import json, os, socket, sys
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode = True
with patch.object(socket, "socket", side_effect=AssertionError("network forbidden")), \\
     patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden")), \\
     patch.object(socket, "getaddrinfo", side_effect=AssertionError("DNS forbidden")):
    from swival import agent, config, sandbox_agentfs
    assert getattr(config.apply_config_to_args, "_pi_swival_no_self_review", False)
    original_apply = config.apply_config_to_args
    applied = False
    def checked_apply(args, values):
        global applied
        result = original_apply(args, values)
        assert args.self_review is False, "inherited self-review was re-enabled"
        assert args.reviewer == "external.sh", "external reviewer gate was lost"
        applied = True
        return result
    config.apply_config_to_args = checked_apply
    def stop_before_provider(**_kwargs):
        assert applied, "real main did not apply the shim in the final process"
        assert sandbox_agentfs.is_inside_agentfs(), "real AgentFS boundary did not engage"
        assert os.environ.get("AGENTFS") == "1"
        assert not os.environ.get("SWIVAL_AGENTFS_ACTIVE"), "must not re-exec inside the snapshot"
        findings = Path(${JSON.stringify(findings)})
        findings.mkdir()
        (findings / "report.md").write_text("synthetic snapshot report\\n")
        (findings / "link.md").symlink_to(Path(${JSON.stringify(source)}) / "sentinel")
        for relative in ("sentinel", ".git/HEAD"):
            try:
                (Path(${JSON.stringify(source)}) / relative).write_text("forbidden-write-attempt")
            except OSError:
                pass
        print("REAL_UPSTREAM_BOOTSTRAP_REACHED", flush=True)
        raise SystemExit(0)
    agent.resolve_provider = stop_before_provider
    agent.main()
`, { mode: 0o700 });
		const args = ["--base-dir", snapshot, "--sandbox", "builtin", "--network", "provider-only",
			"--commands", "none", "--files", "some", "--oneshot-commands",
			"--no-sandbox-auto-session", "--no-instructions", "--no-skills", "--no-metaskills", "--no-mcp",
			"--no-a2a", "--no-subagents", "--no-lifecycle", "--no-history", "--no-continue", "--no-memory",
			"--provider", "chatgpt", "--model", "offline-fixture", "--", "/audit --all --workers 1"];
		Object.assign(env, resolveSwivalReviewEnv(args, true, env));
		const proc = spawn(agentfs, buildNativeAgentfsArgs(entry, snapshot, undefined, session, args), {
			cwd: sandboxCwd, env, shell: false, detached: true,
			stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		let stopped: string | undefined;
		const stop = (reason: string) => {
			stopped ??= reason;
			try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* Live group already exited. */ }
		};
		const timer = setTimeout(() => stop("CLI bootstrap exceeded 30 seconds"), 30_000);
		for (const stream of [proc.stdout, proc.stderr]) stream.on("data", (chunk: Buffer) => {
			const remaining = 32_768 - Buffer.byteLength(output);
			output += chunk.subarray(0, Math.max(0, remaining)).toString();
			if (chunk.length > remaining) stop("CLI diagnostics exceeded 32 KiB");
		});
		try {
			const code = await new Promise<number | null>((resolve, reject) => {
				proc.once("error", reject);
				proc.once("close", resolve);
			});
			clearTimeout(timer);
			fs.writeFileSync(path.join(root, "probe-result.json"), JSON.stringify({
				exitCode: code, stopped, diagnostics: output, session, agentfs, entry, args, cwd: sandboxCwd,
			}, null, 2), { mode: 0o600 });
			expect(stopped, output).toBeUndefined();
			expect(code, output).toBe(0);
			expect(output).toContain("REAL_UPSTREAM_BOOTSTRAP_REACHED");
			let groupError: NodeJS.ErrnoException | undefined;
			try { process.kill(-proc.pid!, 0); } catch (error) { groupError = error as NodeJS.ErrnoException; }
			expect(groupError?.code, "Live CLI process group must be absent before collection").toBe("ESRCH");
			expect(fs.readFileSync(path.join(source, "sentinel"), "utf8")).toBe("original-source");
			expect(fs.readFileSync(path.join(source, ".git", "HEAD"), "utf8")).toBe("original-git");
			const sessionStatus = local(["ps"]);
			expect(sessionStatus).not.toContain(session);
			expect(fs.lstatSync(findings).isDirectory()).toBe(true);
			expect(fs.realpathSync(findings)).toBe(findings);
			let entries = 0;
			const directory = fs.opendirSync(findings);
			try {
				while (directory.readSync()) {
					if (++entries > 4096) throw new Error("Snapshot collection entry limit");
				}
			} finally { directory.closeSync(); }
			let total = 0;
			const readRegular = (name: string) => {
				const target = path.join(findings, name);
				const before = fs.lstatSync(target);
				if (!before.isFile() || before.size > 8 * 1024 * 1024) {
					throw new Error("Nonregular or oversized snapshot evidence");
				}
				const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
				try {
					const opened = fs.fstatSync(fd);
					if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev ||
						opened.size !== before.size) throw new Error("Snapshot evidence changed during open");
					total += opened.size;
					if (total > 64 * 1024 * 1024) throw new Error("Snapshot collection byte limit");
					return fs.readFileSync(fd);
				} finally { fs.closeSync(fd); }
			};
			expect(() => readRegular("link.md")).toThrow(/Nonregular/);
			const bytes = readRegular("report.md");
			expect(bytes.toString()).toBe("synthetic snapshot report\n");
			const evidence = path.join(root, "evidence");
			fs.mkdirSync(evidence);
			fs.writeFileSync(path.join(evidence, "report.md"), bytes, { mode: 0o600, flag: "wx" });
			fs.writeFileSync(path.join(root, "collection-result.json"), JSON.stringify({
				sessionStatus, entries, bytes: total, sourceUnchanged: true, gitUnchanged: true,
				groupAbsent: true, symlinkRejected: true,
			}, null, 2), { mode: 0o600 });
		} finally {
			clearTimeout(timer);
			try { process.kill(-proc.pid!, 0); stop("fixture cleanup"); } catch { /* No live group. */ }
			// Retain the owned session until independent lifecycle validation proves cleanup safe.
			console.log(`Native AgentFS probe evidence: ${root}`);
		}
	}, 60_000);
});

it("uses the production launcher/finalizer with real upstream bootstrap and synthetic evidence", async () => {
	const root = nativeScratch("native-production-agentfs-");
	const source = fixtureRepository(root);
	const home = path.join(root, "home"); fs.mkdirSync(home);
	const config = path.join(home, ".config");
	const pack = path.join(config, "nono/packages/jedisct1/swival"); fs.mkdirSync(path.join(pack, "profiles"), { recursive: true });
	const reviewed = path.resolve(import.meta.dirname, "fixtures/nono-availability");
	fs.copyFileSync(path.join(reviewed, "package.json"), path.join(pack, "package.json"));
	fs.copyFileSync(path.join(reviewed, "policy.json"), path.join(pack, "profiles/swival.json"));
	// Synthetic registration proves availability only, never authenticity/enforcement.
	fs.writeFileSync(path.join(config, "nono/packages/lockfile.json"), JSON.stringify({ lockfile_version: 4,
		packages: { "jedisct1/swival": { version: "0.1.2", installed_at: "2000-01-01T00:00:00Z" } } }));
	const syntheticAuth = path.join(home, ".config/litellm/chatgpt");
	fs.mkdirSync(syntheticAuth, { recursive: true });
	fs.writeFileSync(path.join(syntheticAuth, "auth.json"), JSON.stringify({ access_token: "synthetic-expired",
		expires_at: 1, refresh_token: "synthetic-refresh" }), { mode: 0o600 });
	const selected = path.join(fs.realpathSync(path.dirname(nativeTestPython)), path.basename(nativeTestPython));
	const cli = path.join(root, "offline-cli");
	fs.writeFileSync(cli, `#!${selected}
import json, os, socket, sys
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode = True
with patch.object(socket, 'socket', side_effect=AssertionError('network forbidden')), \\
     patch.object(socket, 'create_connection', side_effect=AssertionError('network forbidden')), \\
     patch.object(socket, 'getaddrinfo', side_effect=AssertionError('DNS forbidden')):
 from swival import agent, sandbox_agentfs
 def fixture_only(**_kwargs):
  assert sandbox_agentfs.is_inside_agentfs()
  assert not os.environ.get('SWIVAL_AGENTFS_ACTIVE')
  import httpx
  from litellm.llms.chatgpt import authenticator
  requests = []
  def auth_http(request):
   requests.append(request)
   return httpx.Response(200, json={'access_token':'synthetic-refreshed','id_token':'synthetic-id','refresh_token':'synthetic-new-refresh'})
  with httpx.Client(transport=httpx.MockTransport(auth_http)) as client, patch.object(authenticator, 'get_httpx_client', return_value=client):
   auth = authenticator.Authenticator()
   returned = auth.get_access_token() == 'synthetic-refreshed'
   persisted = auth._read_auth_file().get('access_token') == 'synthetic-refreshed'
  snapshot = Path(sys.argv[sys.argv.index('--base-dir') + 1])
  from swival.session import Session
  from swival import tools
  session = Session(base_dir=str(snapshot), files='some', commands='none', network='provider-only',
   no_instructions=True, no_skills=True, memory=False, history=False, subagents=False, lifecycle_enabled=False)
  with patch.object(agent, 'resolve_provider', return_value=('gpt-offline',None,None,128000,{'provider':'chatgpt'})):
   session._setup()
  context = session._make_input_context(session._make_per_run_state(system_content='synthetic'))
  tool_options = {key:value for key,value in context.loop_kwargs.items() if key != 'base_dir'}
  assert not tools.dispatch('read_file', {'file_path':str(snapshot / 'code.py')}, str(snapshot), **tool_options).startswith('error:')
  assert not tools.dispatch('write_file', {'file_path':str(snapshot / 'tool-control.txt'),'content':'synthetic'}, str(snapshot), **tool_options).startswith('error:')
  denied_read = tools.dispatch('read_file', {'file_path':auth.auth_file}, str(snapshot), **tool_options).startswith('error:')
  denied_write = tools.dispatch('write_file', {'file_path':auth.auth_file,'content':'forbidden'}, str(snapshot), **tool_options).startswith('error:')
  assert auth._read_auth_file().get('access_token') == 'synthetic-refreshed'
  session.close()
  manifest = json.loads((snapshot.parent / 'manifest.json').read_text())
  state = {'scope':manifest['scope'],'reviewed_files':manifest['scope']['mandatory_files'],
   'candidate_files':manifest['scope']['mandatory_files'],'deep_reviewed_files':manifest['scope']['mandatory_files'],
   'phase':'done','proposed_findings':[],'verified_findings':[],'verification_state':{},'artifact_state':{},'metrics':{},'truncated_files':{}}
  directory = snapshot / '.swival/audit/abc12345'
  directory.mkdir(parents=True)
  (directory / 'state.json').write_text(json.dumps(state))
  report = {'version':1,'task':manifest['command'],'provider':'chatgpt','model':'gpt-offline',
   'synthetic_auth_probe':{'refresh_called':len(requests)==1,'token_returned':returned,'store_updated':persisted,'model_read_denied':denied_read,'model_write_denied':denied_write},
   'settings':{'commands':'none','files':'some','instructions_status':'disabled','skills_discovered':[]},
   'sandbox':{'mode':'builtin'},'network':'provider-only',
   'result':{'outcome':'success','exit_code':0,'answer':'synthetic result after real bootstrap'}}
  (snapshot / 'native-cli-report.json').write_text(json.dumps(report))
  print('REAL_PRODUCTION_LAUNCHER_BOOTSTRAP_REACHED', flush=True)
  raise SystemExit(0)
 agent.resolve_provider = fixture_only
 agent.main()
`, { mode: 0o700 });
	const runtime = { ...captureNativeRuntime(), python: selected, cli,
		searchPath: fixtureSearchPath(),
		environment: { HOME: home, XDG_CONFIG_HOME: config, TMPDIR: path.join(root, "tmp"), NONO_NO_UPDATE_CHECK: "1" } };
	fs.mkdirSync(runtime.environment.TMPDIR);
	const params = { audit: { all: true, workers: 1, patchMaxTurns: 5 }, providerOverride: "chatgpt", modelOverride: "gpt-offline", timeoutMs: 30_000 };
	const artifactDir = path.join(root, "artifacts");
	const run = await prepareNativeAudit(source, params, { paths: [], all: true, workers: 1, patchMaxTurns: 5 }, runtime,
		artifactDir, "real-bootstrap", 35_000);
	let fixtureDiagnostics = "";
	for (const stream of [run.proc.stdout, run.proc.stderr]) stream?.on("data", (chunk) => {
		fixtureDiagnostics = (fixtureDiagnostics + chunk).slice(0, 65536);
	});
	try {
		const term = await run.completion;
		fs.writeFileSync(path.join(root, "production-result.json"), JSON.stringify({ terminal: term, fixtureDiagnostics,
			completion: await inspectNativeAudit(artifactDir, term.exitCode), source: fs.readFileSync(path.join(source, "code.py"), "utf8") }, null, 2));
		expect(term, JSON.stringify({ term, fixtureDiagnostics })).toMatchObject({ exitCode: 0, shutdown: "verified", boundary: "agentfs-cli" });
		expect((await inspectNativeAudit(artifactDir, term.exitCode)).status).toBe("completed");
		const report = JSON.parse(fs.readFileSync(path.join(artifactDir, "evidence/native-cli-report.json"), "utf8"));
		expect(report.synthetic_auth_probe).toEqual({ refresh_called: true, token_returned: true,
			store_updated: true, model_read_denied: true, model_write_denied: true });
		const evidence = fs.readFileSync(path.join(artifactDir, "evidence/native-cli-report.json"), "utf8");
		for (const value of ["synthetic-refreshed", "synthetic-new-refresh", "synthetic-login-access", "synthetic-login-refresh"]) expect(evidence).not.toContain(value);
		expect(fs.existsSync(path.join(artifactDir, "snapshot"))).toBe(false);
		expect(fs.readFileSync(path.join(source, "code.py"), "utf8")).toBe("def answer(): return 42\n");
	} finally {
		run.cancel("Fixture cleanup"); await run.completion;
		console.log(`Production native AgentFS evidence: ${root}`);
	}
}, 60_000);

it.each(["auth-runtime", "evidence-alias"])("rejects %s before real AgentFS receives a grant", async (kind) => {
	const root = nativeScratch("native-agentfs-refusal-"); const source = fixtureRepository(root);
	const home = path.join(root, "home"); fs.mkdirSync(home);
	const selected = path.join(fs.realpathSync(path.dirname(nativeTestPython)), path.basename(nativeTestPython));
	const marker = path.join(root, "worker-started"); const cli = path.join(root, "offline-cli");
	fs.writeFileSync(cli, `#!${selected}\nfrom pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('forbidden')\n`, { mode: 0o700 });
	if (kind === "evidence-alias") {
		fs.mkdirSync(path.join(source, "AUDIT-FINDINGS")); fs.writeFileSync(path.join(source, "AUDIT-FINDINGS/injected.md"), "source-controlled evidence");
		const { fixtureGit } = await import("./nativeFixtures.js");
		fixtureGit(source, "add", "."); fixtureGit(source, "commit", "-m", "evidence alias fixture");
	}
	const directory = path.join(home, ".agentfs/run");
	const runtime = { ...captureNativeRuntime(), python: selected, cli, searchPath: fixtureSearchPath(),
		environment: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), TMPDIR: path.join(root, "tmp"),
			...(kind === "auth-runtime" ? { CHATGPT_TOKEN_DIR: directory } : {}) } };
	fs.mkdirSync(runtime.environment.TMPDIR);
	const artifacts = path.join(root, "artifacts");
	await expect(prepareNativeAudit(source, { audit: { all: true }, providerOverride: "chatgpt", modelOverride: "gpt-offline" },
		{ paths: [], all: true, workers: 1, patchMaxTurns: 5 }, runtime, artifacts, "refused", 30_000))
		.rejects.toThrow(kind === "auth-runtime" ? /auth.*runtime scope/i : /unsupported.*path/i);
	expect(fs.existsSync(marker)).toBe(false); expect(fs.existsSync(artifacts)).toBe(false);
	if (kind === "auth-runtime") expect(fs.existsSync(directory)).toBe(false);
}, 30_000);

it.each([null, "http://127.0.0.1:8444/v1"])("runs the released API /audit producer through real AgentFS at endpoint %s with HTTP doubles", async (endpoint) => {
	const root = nativeScratch("native-api-agentfs-"); const source = fixtureRepository(root);
	const home = path.join(root, "home"); fs.mkdirSync(home); const config = path.join(home, ".config");
	const pack = path.join(config, "nono/packages/jedisct1/swival"); fs.mkdirSync(path.join(pack, "profiles"), { recursive: true });
	const reviewed = path.resolve(import.meta.dirname, "fixtures/nono-availability");
	fs.copyFileSync(path.join(reviewed, "package.json"), path.join(pack, "package.json"));
	fs.copyFileSync(path.join(reviewed, "policy.json"), path.join(pack, "profiles/swival.json"));
	fs.writeFileSync(path.join(config, "nono/packages/lockfile.json"), JSON.stringify({ lockfile_version: 4,
		packages: { "jedisct1/swival": { version: "0.1.2", installed_at: "2000-01-01T00:00:00Z" } } }));
	fs.mkdirSync(path.join(config, "swival"));
	fs.writeFileSync(path.join(config, "swival/config.toml"), 'provider="openrouter"\nmodel="example/concrete"\nmax_context_tokens=128000\n' +
		(endpoint ? `base_url="${endpoint}"\n` : ""));
	const selected = path.join(fs.realpathSync(path.dirname(nativeTestPython)), path.basename(nativeTestPython));
	const cli = path.join(root, "offline-cli");
	fs.writeFileSync(cli, `#!${selected}
import json, socket, sys
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode = True
with patch.object(socket, 'socket', side_effect=AssertionError('network forbidden')), \\
     patch.object(socket, 'create_connection', side_effect=AssertionError('network forbidden')), \\
     patch.object(socket, 'getaddrinfo', side_effect=AssertionError('DNS forbidden')):
 from swival import agent, audit, sandbox_agentfs
 import httpx
 assert sandbox_agentfs.is_inside_agentfs()
 requests = []
 def response(request, **_kwargs):
  payload = json.loads(request.content)
  requests.append({'model':payload['model'],'endpoint':str(request.url)})
  text = audit._PHASE1_WORKED_EXAMPLE if len(requests) == 1 else '@@ none @@'
  return httpx.Response(200, request=request, json={'id':'synthetic','object':'chat.completion','created':1,
   'model':'example/concrete','choices':[{'index':0,'message':{'role':'assistant','content':text},'finish_reason':'stop'}]})
 with patch.object(httpx.Client, 'send', side_effect=response):
  try: agent.main()
  except SystemExit as exc:
   if exc.code not in (0, None): raise
 assert requests
 assert not agent._MODEL_AUTOFIX
 snapshot = Path(sys.argv[sys.argv.index('--base-dir')+1])
 report_path = snapshot / 'native-cli-report.json'
 report = json.loads(report_path.read_text())
 report['offline_transport_capture'] = requests
 report_path.write_text(json.dumps(report))
 print('REAL_RELEASED_API_AUDIT_WITH_HTTP_DOUBLES', flush=True)
`, { mode: 0o700 });
	const runtime = { ...captureNativeRuntime(), python: selected, cli, searchPath: fixtureSearchPath(),
		environment: { HOME: home, XDG_CONFIG_HOME: config, TMPDIR: path.join(root, "tmp"),
			OPENROUTER_API_KEY: "synthetic-dedicated-fixture-key", CHATGPT_API_KEY: "synthetic-unrelated-key" } };
	fs.mkdirSync(runtime.environment.TMPDIR);
	const artifacts = path.join(root, "artifacts");
	const run = await prepareNativeAudit(source, { audit: { all: true }, timeoutMs: 30_000 },
		{ paths: [], all: true, workers: 1, patchMaxTurns: 5 }, runtime, artifacts, "released-api", 35_000);
	try {
		const terminal = await run.completion; const result = await inspectNativeAudit(artifacts, terminal.exitCode);
		fs.writeFileSync(path.join(root, "production-result.json"), JSON.stringify({ terminal, result }, null, 2));
		expect(terminal).toMatchObject({ exitCode: 0, shutdown: "verified" });
		expect(result.status, result.error).toBe("completed");
		const report = JSON.parse(fs.readFileSync(path.join(artifacts, "evidence/native-cli-report.json"), "utf8"));
		expect(report.offline_transport_capture.length).toBeGreaterThan(0);
		expect(new Set(report.offline_transport_capture.map((request: any) => request.endpoint)))
			.toEqual(new Set([(endpoint ?? "https://openrouter.ai/api/v1") + "/chat/completions"]));
		expect(new Set(report.offline_transport_capture.map((request: any) => request.model))).toEqual(new Set(["example/concrete"]));
		const manifest = fs.readFileSync(path.join(artifacts, "manifest.json"), "utf8");
		expect(JSON.parse(manifest).authStore).toBeUndefined(); expect(manifest).not.toContain("synthetic-dedicated-fixture-key");
		expect(fs.existsSync(path.join(home, ".config/litellm/chatgpt"))).toBe(false);
		expect(fs.readFileSync(path.join(source, "code.py"), "utf8")).toBe("def answer(): return 42\n");
	} finally { run.cancel("Fixture cleanup"); await run.completion; console.log(`Released API AgentFS evidence: ${root}`); }
}, 60_000);


type CloudProvider = "bedrock" | "geap";
const CREDENTIAL_SENTINELS = ["ASIASYNTHETIC", "SENTINEL_BRIDGED_", "SENTINEL_HOST_", "SENTINEL_AMBIENT_", "SENTINEL_UNRELATED_", "SENTINEL_"];

/** Every regular file retained under the artifact root, including a retained snapshot. */
function retainedFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const target = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...retainedFiles(target));
		else { expect(entry.isFile(), target).toBe(true); files.push(target); }
	}
	return files;
}

/**
 * Synthetic HOME with sentinel host credential state, the selected cloud route, and
 * host `aws`/`gcloud` doubles that record their invocation and mint bridged credentials.
 * Ambient keys cover the other route and unrelated providers only; preflight refuses the
 * selected route's own fallback interface, so that is not an ambient fixture here.
 */
function cloudFixture(provider: CloudProvider) {
	const root = nativeScratch("native-cloud-agentfs-"); const source = fixtureRepository(root);
	const home = path.join(root, "home"); fs.mkdirSync(home); const config = path.join(home, ".config");
	const pack = path.join(config, "nono/packages/jedisct1/swival"); fs.mkdirSync(path.join(pack, "profiles"), { recursive: true });
	const reviewed = path.resolve(import.meta.dirname, "fixtures/nono-availability");
	fs.copyFileSync(path.join(reviewed, "package.json"), path.join(pack, "package.json"));
	fs.copyFileSync(path.join(reviewed, "policy.json"), path.join(pack, "profiles/swival.json"));
	fs.writeFileSync(path.join(config, "nono/packages/lockfile.json"), JSON.stringify({ lockfile_version: 4,
		packages: { "jedisct1/swival": { version: "0.1.2", installed_at: "2000-01-01T00:00:00Z" } } }));
	const hostAws = path.join(home, ".aws"); const hostGcloud = path.join(config, "gcloud");
	fs.mkdirSync(hostAws); fs.mkdirSync(path.join(hostGcloud, "configurations"), { recursive: true });
	const hostCredentialFiles = {
		[path.join(hostAws, "config")]: "[profile selected-bedrock]\nregion = us-east-2\nsso_session = SENTINEL_HOST_AWS_SECRET_NEVER_READ\n",
		[path.join(hostAws, "credentials")]: "[selected-bedrock]\naws_access_key_id = AKIAHOSTSENTINEL\naws_secret_access_key = SENTINEL_HOST_AWS_SECRET_NEVER_READ\n",
		[path.join(hostGcloud, "application_default_credentials.json")]: JSON.stringify({ type: "authorized_user", client_id: "synthetic",
			client_secret: "SENTINEL_HOST_GCLOUD_SECRET_NEVER_READ", refresh_token: "SENTINEL_HOST_GCLOUD_SECRET_NEVER_READ" }),
		[path.join(hostGcloud, "configurations/config_default")]: "[core]\naccount = SENTINEL_HOST_GCLOUD_SECRET_NEVER_READ\nproject = synthetic-project\n",
	};
	for (const [file, content] of Object.entries(hostCredentialFiles)) {
		fs.writeFileSync(file, content, { mode: 0o600 });
		const stat = fs.lstatSync(file); expect(stat.isFile()).toBe(true); expect(stat.nlink).toBe(1); expect(stat.mode & 0o777).toBe(0o600);
	}
	fs.mkdirSync(path.join(config, "swival"));
	fs.writeFileSync(path.join(config, "swival/config.toml"), provider === "bedrock"
		? 'provider = "bedrock"\naws_profile = "selected-bedrock"\nbase_url = "us-east-2"\nmodel = "global.anthropic.claude-sonnet-5-5"\nmax_context_tokens = 128000\n'
		: 'provider = "geap"\nproject = "synthetic-project"\nlocation = "global"\nmodel = "gemini-3.8-flash"\nmax_context_tokens = 128000\n');
	const selected = path.join(fs.realpathSync(path.dirname(nativeTestPython)), path.basename(nativeTestPython));
	const hostBin = path.join(root, "host-bin"); fs.mkdirSync(hostBin);
	const hostCalls = path.join(root, "host-cli-calls.jsonl");
	const expiration = new Date(Date.now() + 2 * 3600_000).toISOString();
	fs.writeFileSync(path.join(hostBin, "aws"), `#!${selected}
import json, os, sys
bindings = {key: os.environ.get(key) for key in ('AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'CLOUDSDK_CONFIG', 'HOME')}
with open(${JSON.stringify(hostCalls)}, 'a') as log: log.write(json.dumps({'tool': 'aws', 'argv': sys.argv[1:], 'bindings': bindings}) + '\\n')
print(json.dumps({'Version': 1, 'AccessKeyId': 'ASIASYNTHETIC', 'SecretAccessKey': 'SENTINEL_BRIDGED_AWS_SECRET',
 'SessionToken': 'SENTINEL_BRIDGED_AWS_SESSION', 'Expiration': ${JSON.stringify(expiration)}}))
`, { mode: 0o700 });
	fs.writeFileSync(path.join(hostBin, "gcloud"), `#!${selected}
import json, os, sys
bindings = {key: os.environ.get(key) for key in ('AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'CLOUDSDK_CONFIG', 'HOME')}
with open(${JSON.stringify(hostCalls)}, 'a') as log: log.write(json.dumps({'tool': 'gcloud', 'argv': sys.argv[1:], 'bindings': bindings}) + '\\n')
sys.stdout.write('SENTINEL_BRIDGED_GOOGLE_BEARER\\n')
`, { mode: 0o700 });
	const ambient = provider === "bedrock"
		? { GOOGLE_APPLICATION_CREDENTIALS: path.join(hostGcloud, "application_default_credentials.json"), VERTEXAI_CREDENTIALS: "SENTINEL_AMBIENT_VERTEX", OPENROUTER_API_KEY: "SENTINEL_UNRELATED_OPENROUTER" }
		: { AWS_ACCESS_KEY_ID: "SENTINEL_AMBIENT_AWS_OVERRIDDEN", AWS_SECRET_ACCESS_KEY: "SENTINEL_AMBIENT_AWS_KEY", AWS_SESSION_TOKEN: "SENTINEL_AMBIENT_AWS_TOK",
			AWS_PROFILE: "SENTINEL_AMBIENT_PROFILE", OPENROUTER_API_KEY: "SENTINEL_UNRELATED_OPENROUTER" };
	const cli = path.join(root, "offline-cli");
	const runtime = { ...captureNativeRuntime(), python: selected, cli, searchPath: [hostBin, fixtureSearchPath()].join(path.delimiter),
		environment: { HOME: home, XDG_CONFIG_HOME: config, TMPDIR: path.join(root, "tmp"), NONO_NO_UPDATE_CHECK: "1", ...ambient } };
	fs.mkdirSync(runtime.environment.TMPDIR);
	const expectedHostCall = provider === "bedrock"
		? { tool: "aws", argv: ["configure", "export-credentials", "--profile", "selected-bedrock", "--format", "process"],
			bindings: { AWS_CONFIG_FILE: path.join(hostAws, "config"), AWS_SHARED_CREDENTIALS_FILE: path.join(hostAws, "credentials"), CLOUDSDK_CONFIG: null, HOME: home } }
		: { tool: "gcloud", argv: ["auth", "application-default", "print-access-token"],
			bindings: { AWS_CONFIG_FILE: null, AWS_SHARED_CREDENTIALS_FILE: null, CLOUDSDK_CONFIG: hostGcloud, HOME: home } };
	const artifacts = path.join(root, "artifacts");
	/** Host-side proof after completion: one host CLI call, torn-down session, untouched host state,
	 * and zero credential leakage across retained files, the terminal record, the inspection
	 * result, and the child's captured stdout/stderr. */
	const assertHostBoundary = (term: unknown, result: unknown, fixtureDiagnostics: string) => {
		const calls = fs.readFileSync(hostCalls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(calls).toEqual([expectedHostCall]);
		expect(execFileSync(runtime.agentfs!, ["ps"], { env: { PATH: runtime.searchPath, HOME: home }, encoding: "utf8", timeout: 10_000 }))
			.not.toContain(JSON.parse(fs.readFileSync(path.join(artifacts, "manifest.json"), "utf8")).session);
		expect(fs.readFileSync(path.join(source, "code.py"), "utf8")).toBe("def answer(): return 42\n");
		for (const [file, content] of Object.entries(hostCredentialFiles)) expect(fs.readFileSync(file, "utf8")).toBe(content);
		const retained = retainedFiles(artifacts);
		expect(retained.length).toBeGreaterThanOrEqual(5);
		const productionResult = path.join(root, "production-result.json");
		fs.writeFileSync(productionResult, JSON.stringify({ term, result, fixtureDiagnostics }, null, 2), { mode: 0o600 });
		for (const text of [...retained.map((file) => fs.readFileSync(file, "utf8")), fs.readFileSync(productionResult, "utf8"),
			fixtureDiagnostics, JSON.stringify(term), JSON.stringify(result)]) {
			for (const sentinel of CREDENTIAL_SENTINELS) expect(text).not.toContain(sentinel);
		}
		return retained;
	};
	const cliHeader = `#!${selected}
import json, os, socket, sys
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode = True
provider = ${JSON.stringify(provider)}
`;
	return { root, source, home, config, hostAws, hostGcloud, selected, cli, cliHeader, runtime, artifacts, assertHostBoundary };
}

// Host-side sentinels prove the bridged credential never leaves the host CLI boundary
// except through the selected route's env interface, and never reaches retained evidence.
it.each(["bedrock", "geap"] as const)("runs the released %s /audit producer through real AgentFS with a bridged host credential and HTTP doubles", async (provider) => {
	const f = cloudFixture(provider);
	fs.writeFileSync(f.cli, f.cliHeader + `
with patch.object(socket, 'socket', side_effect=AssertionError('network forbidden')), \\
     patch.object(socket, 'create_connection', side_effect=AssertionError('network forbidden')), \\
     patch.object(socket, 'getaddrinfo', side_effect=AssertionError('DNS forbidden')):
 from swival import agent, audit, sandbox_agentfs, tools
 import httpx
 assert sandbox_agentfs.is_inside_agentfs()
 assert os.environ.get('PI_SWIVAL_SHIM_REQUIRED') == '1'
 env = os.environ
 absent = ['AWS_PROFILE', 'VERTEXAI_CREDENTIALS', 'OPENROUTER_API_KEY']
 if provider == 'bedrock':
  assert env.get('AWS_ACCESS_KEY_ID') == 'ASIASYNTHETIC', 'bridged AWS access key id'
  assert env.get('AWS_SECRET_ACCESS_KEY') == 'SENTINEL_BRIDGED_AWS_SECRET', 'bridged AWS secret'
  assert env.get('AWS_SESSION_TOKEN') == 'SENTINEL_BRIDGED_AWS_SESSION', 'bridged AWS session'
  assert env.get('AWS_CONFIG_FILE') == '/dev/null' and env.get('AWS_SHARED_CREDENTIALS_FILE') == '/dev/null'
  assert env.get('AWS_EC2_METADATA_DISABLED') == 'true'
  absent += ['GOOGLE_OAUTH_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN_NOT_AFTER', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_CONFIG']
 else:
  assert env.get('GOOGLE_OAUTH_ACCESS_TOKEN') == 'SENTINEL_BRIDGED_GOOGLE_BEARER', 'bridged Google bearer'
  assert env.get('GOOGLE_OAUTH_ACCESS_TOKEN_NOT_AFTER', '').isdigit(), 'bounded bearer lifetime'
  adc = env.get('GOOGLE_APPLICATION_CREDENTIALS', '')
  assert adc.endswith('/adc-disabled.json') and Path(adc).read_text().strip() == '{}', 'inert ADC file'
  assert env.get('CLOUDSDK_CONFIG', '').endswith('/gcloud-empty') and set(Path(env['CLOUDSDK_CONFIG']).iterdir()) == {Path(adc)}, 'empty gcloud config'
  absent += ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']
 for key in absent: assert key not in env, key
 requests = []
 def response(request, **_kwargs):
  headers = request.headers
  requests.append({'host': request.url.host,
   'sigv4': headers.get('authorization', '').startswith('AWS4-HMAC-SHA256'),
   'session_token_bridged': headers.get('x-amz-security-token') == 'SENTINEL_BRIDGED_AWS_SESSION',
   'bearer_bridged': headers.get('authorization') == 'Bearer SENTINEL_BRIDGED_GOOGLE_BEARER'})
  text = audit._PHASE1_WORKED_EXAMPLE if len(requests) == 1 else '@@ none @@'
  if provider == 'bedrock':
   payload = {'output': {'message': {'role': 'assistant', 'content': [{'text': text}]}}, 'stopReason': 'end_turn',
    'usage': {'inputTokens': 10, 'outputTokens': 5, 'totalTokens': 15}, 'metrics': {'latencyMs': 10}}
  else:
   payload = {'candidates': [{'content': {'role': 'model', 'parts': [{'text': text}]}, 'finishReason': 'STOP'}],
    'usageMetadata': {'promptTokenCount': 10, 'candidatesTokenCount': 5, 'totalTokenCount': 15}}
  return httpx.Response(200, request=request, json=payload)
 # On macOS the outer AgentFS boundary does not isolate host-file reads; inner Swival
 # --sandbox builtin --files some is what denies these host and parent paths to model tools.
 # The probes run against the audit's own InputContext, captured as released main() hands
 # it to /audit, so the policy under test is the one the launched CLI arguments produced.
 snapshot = Path(sys.argv[sys.argv.index('--base-dir') + 1])
 home = Path(os.environ['HOME'])
 released_run_audit_command = audit.run_audit_command
 audit_contexts = []
 def probing_run_audit_command(cmd_arg, ctx):
  tool_options = {key: value for key, value in ctx.loop_kwargs.items() if key != 'base_dir'}
  def dispatch(name, args): return tools.dispatch(name, args, ctx.base_dir, **tool_options)
  denied = {}
  for label, target in (('aws_credentials', home / '.aws/credentials'), ('aws_config', home / '.aws/config'),
    ('gcloud_adc', home / '.config/gcloud/application_default_credentials.json'), ('parent_manifest', snapshot.parent / 'manifest.json')):
   results = [dispatch('read_file', {'file_path': str(target)}),
    dispatch('write_file', {'file_path': str(target), 'content': 'forbidden'}),
    dispatch('grep', {'pattern': 'SENTINEL', 'path': str(target.parent)}),
    dispatch('list_files', {'pattern': target.name, 'path': str(target.parent)})]
   denied[label] = all(result.startswith('error:') for result in results)
   assert not any('SENTINEL_' in result for result in results), label
  denied['relative_parent_manifest'] = dispatch('read_file', {'file_path': '../manifest.json'}).startswith('error:')
  snapshot_read = dispatch('read_file', {'file_path': str(Path(ctx.base_dir) / 'code.py')})
  audit_contexts.append({**denied,
   'snapshot_read': not snapshot_read.startswith('error:') and 'return 42' in snapshot_read,
   'context_policy': Path(ctx.base_dir).resolve() == snapshot.resolve() and tool_options.get('files_mode') == 'some'
    and tool_options.get('network_mode') == 'provider-only' and getattr(tool_options.get('command_policy'), 'mode', None) == 'none'})
  return released_run_audit_command(cmd_arg, ctx)
 with patch('google.auth.default', side_effect=AssertionError('ADC forbidden')) as adc_default, \\
      patch.object(httpx.Client, 'send', side_effect=response), \\
      patch.object(audit, 'run_audit_command', probing_run_audit_command):
  try: agent.main()
  except SystemExit as exc:
   if exc.code not in (0, None): raise
 assert requests
 assert not adc_default.called
 assert not agent._MODEL_AUTOFIX
 assert len(audit_contexts) == 1, 'released /audit must hand exactly one InputContext to run_audit_command'
 hosts = {entry['host'] for entry in requests}
 every = lambda key: all(entry[key] for entry in requests)
 none = lambda key: not any(entry[key] for entry in requests)
 transport = {'request_count': len(requests),
  'single_host': hosts == ({'bedrock-runtime.us-east-2.amazonaws.com'} if provider == 'bedrock' else {'aiplatform.googleapis.com'}),
  'model_discovery_disabled': agent._list_server_models('bedrock' if provider == 'bedrock' else 'vertex_ai', None, None) == []}
 if provider == 'bedrock':
  transport.update(sigv4=every('sigv4'), session_token_bridged=every('session_token_bridged'), bearer_absent=none('bearer_bridged'))
 else:
  transport.update(bearer_bridged=every('bearer_bridged'), sigv4_absent=none('sigv4'), session_token_absent=none('session_token_bridged'))
 report_path = snapshot / 'native-cli-report.json'
 report = json.loads(report_path.read_text())
 report['cloud_transport_probe'] = transport
 report['model_tool_probe'] = audit_contexts[0]
 report_path.write_text(json.dumps(report))
 print('REAL_RELEASED_CLOUD_AUDIT_WITH_HTTP_DOUBLES', flush=True)
`, { mode: 0o700 });
	const run = await prepareNativeAudit(f.source, { audit: { all: true }, timeoutMs: 30_000 },
		{ paths: [], all: true, workers: 1, patchMaxTurns: 5 }, f.runtime, f.artifacts, "released-cloud", 35_000);
	let fixtureDiagnostics = "";
	for (const stream of [run.proc.stdout, run.proc.stderr]) stream?.on("data", (chunk) => { fixtureDiagnostics = (fixtureDiagnostics + chunk).slice(0, 65536); });
	try {
		const term = await run.completion; const result = await inspectNativeAudit(f.artifacts, term.exitCode);
		expect(term, fixtureDiagnostics).toMatchObject({ exitCode: 0, shutdown: "verified", boundary: "agentfs-cli" });
		expect(result.status, result.error).toBe("completed");
		expect(run.route.provider).toBe(provider);
		const report = JSON.parse(fs.readFileSync(path.join(f.artifacts, "evidence/native-cli-report.json"), "utf8"));
		expect(report.cloud_transport_probe.request_count).toBeGreaterThan(0);
		expect(report.cloud_transport_probe).toEqual({ request_count: expect.any(Number), single_host: true, model_discovery_disabled: true,
			...(provider === "bedrock" ? { sigv4: true, session_token_bridged: true, bearer_absent: true }
				: { bearer_bridged: true, sigv4_absent: true, session_token_absent: true }) });
		expect(report.model_tool_probe).toEqual({ aws_credentials: true, aws_config: true, gcloud_adc: true, parent_manifest: true,
			relative_parent_manifest: true, snapshot_read: true, context_policy: true });
		expect(fs.existsSync(path.join(f.artifacts, "snapshot"))).toBe(false);
		f.assertHostBoundary(term, result, fixtureDiagnostics);
	} finally { run.cancel("Fixture cleanup"); await run.completion; console.log(`Released cloud AgentFS evidence: ${f.root}`); }
}, 90_000);

// Released agent.main() handles the provider's auth rejection itself and writes its own
// error report; the fixture never touches native-cli-report.json. The rejection body echoes
// the bridged credential next to a PROVIDER_ECHO marker: the marker must survive into the
// released report (proving it came from released code, not a fixture rewrite) while the
// credential value is scrubbed. The marker precedes the credential so LiteLLM's own shape
// heuristics cannot partially mangle the value before the shim scrubs it exactly.
// On geap the shim's expiry sentinel reaches the parent before Swival writes that report, so
// the live cancel usually tears the AgentFS group down first; preservation then fails closed
// and the inert committed snapshot stays inside the artifact root, where it is scanned too.
// Transport observations are printed inside the HTTP double, before any exception or signal,
// so the parent verifies single-attempt/no-fallback evidence even when SIGTERM wins the race.
it.each(["bedrock", "geap"] as const)("fails the released %s /audit producer closed on a raw HTTP auth rejection without retaining any credential", async (provider) => {
	const f = cloudFixture(provider);
	fs.writeFileSync(f.cli, f.cliHeader + `
with patch.object(socket, 'socket', side_effect=AssertionError('network forbidden')), \\
     patch.object(socket, 'create_connection', side_effect=AssertionError('network forbidden')), \\
     patch.object(socket, 'getaddrinfo', side_effect=AssertionError('DNS forbidden')):
 from swival import agent, sandbox_agentfs
 import httpx
 assert sandbox_agentfs.is_inside_agentfs()
 assert os.environ.get('PI_SWIVAL_SHIM_REQUIRED') == '1'
 attempts = []
 def rejection(request, **_kwargs):
  attempts.append(request)
  print('CLOUD_REJECTION_OBSERVED:' + json.dumps({'attempt': len(attempts), 'adc_called': adc_default.called,
   'autofix': bool(agent._MODEL_AUTOFIX), 'host': request.url.host}), flush=True)
  if provider == 'bedrock':
   return httpx.Response(400, request=request, json={'__type': 'ExpiredTokenException',
    'message': 'Token expired PROVIDER_ECHO_BEDROCK_REJECTION: SENTINEL_BRIDGED_AWS_SECRET'})
  return httpx.Response(401, request=request, json={'error': {'code': 401, 'status': 'UNAUTHENTICATED',
   'message': 'Invalid credential PROVIDER_ECHO_GEAP_REJECTION: SENTINEL_BRIDGED_GOOGLE_BEARER'}})
 with patch('google.auth.default', side_effect=AssertionError('ADC forbidden')) as adc_default, \\
      patch.object(httpx.Client, 'send', side_effect=rejection):
  try: agent.main()
  except SystemExit as exc: code = exc.code
  else: code = 0
 assert code not in (0, None), 'released CLI must exit unsuccessfully'
 raise SystemExit(code)
`, { mode: 0o700 });
	const run = await prepareNativeAudit(f.source, { audit: { all: true }, timeoutMs: 30_000 },
		{ paths: [], all: true, workers: 1, patchMaxTurns: 5 }, f.runtime, f.artifacts, "released-cloud-rejection", 35_000);
	let fixtureDiagnostics = "";
	for (const stream of [run.proc.stdout, run.proc.stderr]) stream?.on("data", (chunk) => { fixtureDiagnostics = (fixtureDiagnostics + chunk).slice(0, 65536); });
	try {
		const term = await run.completion; const result = await inspectNativeAudit(f.artifacts, term.exitCode);
		expect(run.route.provider).toBe(provider);
		const observations = [...fixtureDiagnostics.matchAll(/CLOUD_REJECTION_OBSERVED:(\{[^\n]*\})/g)].map((match) => JSON.parse(match[1]));
		expect(observations, fixtureDiagnostics).toEqual([{ attempt: 1, adc_called: false, autofix: false,
			host: provider === "bedrock" ? "bedrock-runtime.us-east-2.amazonaws.com" : "aiplatform.googleapis.com" }]);
		expect(term.exitCode, fixtureDiagnostics).not.toBe(0);
		expect(term.shutdown, fixtureDiagnostics).toBe("verified");
		if (provider === "geap") expect(term.stopped).toBe("CREDENTIAL_EXPIRED: short-lived provider credential expired during native audit; no fallback.");
		else expect(term.stopped).toBeUndefined();
		expect(result.status).toBe("failed"); expect(result.answer).toBeUndefined();
		const snapshot = path.join(f.artifacts, "snapshot"); const evidenceReport = path.join(f.artifacts, "evidence/native-cli-report.json");
		const retained = f.assertHostBoundary(term, result, fixtureDiagnostics);
		if (term.preservationFailure) {
			// The group was torn down before the released report landed: nothing is exported
			// and the committed-tree snapshot is retained as the only evidence.
			expect(provider).toBe("geap");
			expect(term.retainedResources).toEqual([snapshot]);
			expect(fs.existsSync(evidenceReport)).toBe(false);
			expect(fs.existsSync(path.join(snapshot, "native-cli-report.json"))).toBe(false);
			expect(retained).toContain(path.join(snapshot, "code.py"));
		} else {
			expect(fs.existsSync(snapshot)).toBe(false);
			const report = JSON.parse(fs.readFileSync(evidenceReport, "utf8"));
			expect(report.result).toMatchObject({ outcome: "error", exit_code: 1 });
			expect(report.result.answer).toContain(`PROVIDER_ECHO_${provider.toUpperCase()}_REJECTION: [REDACTED]`);
			expect(retained).toContain(evidenceReport);
		}
	} finally { run.cancel("Fixture cleanup"); await run.completion; console.log(`Released cloud rejection AgentFS evidence: ${f.root}`); }
}, 90_000);
