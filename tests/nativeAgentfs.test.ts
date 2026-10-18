import { describe, expect, it } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { nativeTestPython } from "./nativePython.js";
import { captureNativeRuntime, prepareNativeAudit, inspectNativeAudit } from "../extensions/native-audit.js";
import { fixtureRepository, fixtureSearchPath, nativeScratch } from "./nativeFixtures.js";

// This probes CLI bootstrap and write-through snapshot collection, not audit completion.
// Upstream --allow base_dir makes the independent snapshot writable on the host.
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
		const source = path.join(root, "source");
		const findings = path.join(snapshot, "audit-findings");
		const session = `native-probe-${randomBytes(16).toString("hex")}`;
		const python = process.env.NATIVE_AGENTFS_TEST_PYTHON ?? nativeTestPython;
		const search = (process.env.PATH ?? "").split(path.delimiter).filter(path.isAbsolute);
		const agentfsEntry = search.map((entry) => path.join(entry, "agentfs"))
			.find((entry) => { try { fs.accessSync(entry, fs.constants.X_OK); return true; } catch { return false; } });
		expect(agentfsEntry, "The real AgentFS binary is required; no skipped native mechanism gate.").toBeDefined();
		const agentfs = fs.realpathSync(agentfsEntry!);
		for (const directory of [home, snapshot, source, path.join(root, "tmp")]) fs.mkdirSync(directory);
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
		fs.writeFileSync(path.join(snapshot, "swival.toml"), "# Inert fixture configuration.\n");
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
    from swival import agent, sandbox_agentfs
    def stop_before_provider(**_kwargs):
        assert sandbox_agentfs.is_sandboxed(), "real upstream bootstrap did not engage"
        assert os.environ.get("AGENTFS") == "1"
        assert sandbox_agentfs.get_agentfs_session() == ${JSON.stringify(session)}
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
		const args = ["--base-dir", snapshot, "--sandbox", "agentfs", "--network", "provider-only",
			"--commands", "none", "--files", "some", "--oneshot-commands", "--sandbox-session", session,
			"--no-sandbox-auto-session", "--no-instructions", "--no-skills", "--no-metaskills", "--no-mcp",
			"--no-a2a", "--no-subagents", "--no-lifecycle", "--no-history", "--no-continue", "--no-memory",
			"--provider", "chatgpt", "--model", "offline-fixture", "--", "/audit --all --workers 1"];
		const proc = spawn(entry, args, { cwd: snapshot, env, shell: false, detached: true,
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
				exitCode: code, stopped, diagnostics: output, session, agentfs, entry, args, cwd: snapshot,
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
  with httpx.Client(transport=httpx.MockTransport(auth_http)) as client, patch.object(authenticator, '_get_httpx_client', return_value=client):
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
});

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
