import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import registerExtension from "../extensions/index.js";
import { nativeTestPython as python } from "./nativePython.js";

vi.mock("node:fs", async (load) => {
	const actual = await load<typeof import("node:fs")>();
	return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

vi.mock("node:fs/promises", async (load) => {
	const actual = await load<typeof import("node:fs/promises")>();
	return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
vi.mock("node:child_process", async (load) => {
	const actual = await load<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

const ROOT = path.resolve(import.meta.dirname, "..");
const actualFs = createRequire(import.meta.url)("node:fs") as typeof fs;
const dirs: string[] = [];
const scratch = () => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-lifecycle-"))); dirs.push(dir); return dir; };
const original = { HOME: process.env.HOME, PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
const originalPlatform = process.platform;
const trustedPath = (original.PATH ?? "").split(path.delimiter).filter(path.isAbsolute).join(path.delimiter);
// These transport stubs exercise the Linux dispatch path, not kernel isolation.
beforeEach(() => { Object.defineProperty(process, "platform", { value: "linux" }); });
afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform });
	for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});


function fixture(behavior = "complete") {
	const root = scratch();
	const source = path.join(root, "source");
	const artifacts = path.join(root, "artifacts");
	const bin = path.join(root, "bin");
	fs.mkdirSync(source); fs.mkdirSync(artifacts); fs.mkdirSync(bin);
	const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: source, timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
	git("init", "--template="); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
	fs.writeFileSync(path.join(source, "code.py"), behavior === "lost-expansion"
		? 'def authorize(role):\n    """Role access-control decision: allow only admin."""\n    return True\n'
		: "def answer(): return 42\n"); git("add", "."); git("commit", "-m", "fixture");
	const before = git("show-ref");
	fs.writeFileSync(path.join(bin, "nono"), "#!/bin/sh\necho 'nono 0.4.1'\n", { mode: 0o755 });
	// This is an offline sandbox/transport stub, not proof of real AgentFS or a provider.
	fs.writeFileSync(path.join(bin, "agentfs"), `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
if (process.argv.includes('--version')) { console.log('agentfs 0.6.4'); process.exit(0); }
let input=''; process.stdin.on('data', x=>input+=x); process.stdin.on('end', ()=> {
const request = JSON.parse(input);
if (${JSON.stringify(behavior)} === 'nono-lookup') {
 const {spawnSync} = require('node:child_process');
 const lookup = spawnSync(request.python, ['-I','-B','-c', [
  "import json, os, subprocess",
  "from swival.sandbox_nono import build_block_net_wrapper",
  "wrapper = build_block_net_wrapper(base_dir=os.getcwd())",
  "version = subprocess.check_output([wrapper[0], '--version'], timeout=5, text=True).strip()",
  "print(json.dumps({'executable':os.path.realpath(wrapper[0]), 'version':version, 'wrapper':wrapper}))",
 ].join('; ')],
  {timeout:10000,maxBuffer:65536,env:{...process.env,LITELLM_LOCAL_MODEL_COST_MAP:'True'}});
 if (lookup.error || lookup.status !== 0) {process.stderr.write(lookup.stderr ?? ''); process.exit(1);}
 fs.writeFileSync(path.join(request.evidence,'nono-lookup.json'),lookup.stdout);
}
if (${JSON.stringify(behavior)} === 'lost-expansion') {
 const {spawnSync} = require('node:child_process');
 const result = spawnSync(${JSON.stringify(python)}, ['-I','-B',${JSON.stringify(path.join(ROOT, "tests", "native_audit_test.py"))},'--run-finding'],
  {input,timeout:20000,maxBuffer:65536,env:{...process.env,LITELLM_LOCAL_MODEL_COST_MAP:'True'}});
 process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
 process.exit(result.error ? 1 : result.status ?? 1);
}
fs.writeFileSync(path.join(request.evidence, 'launch.json'), JSON.stringify({args:process.argv.slice(2), cwd:process.cwd(), pid:process.pid, path:process.env.PATH,
 git:fs.realpathSync(path.join(process.env.PATH.split(path.delimiter)[0],'git'))}));
const stateDir = path.join(request.snapshot, '.swival', 'audit', 'abc12345'); fs.mkdirSync(stateDir, {recursive:true});
const state = {scope:request.expectedScope, reviewed_files:request.expectedScope.mandatory_files,
 candidate_files:request.expectedScope.mandatory_files, deep_reviewed_files:request.expectedScope.mandatory_files,
 phase:'done', artifact_state:{}, verification_state:{}, verified_findings:[], proposed_findings:[], truncated_files:{}, metrics:{}};
if (${JSON.stringify(behavior)} === 'partial') {state.phase='triage'; state.reviewed_files=[];}
if (${JSON.stringify(behavior)} === 'truncate') state.truncated_files={'code.py':1};
if (${JSON.stringify(behavior)} === 'missing-deep') { state.candidate_files=[]; state.deep_reviewed_files=[]; }
if (['patch','empty-report','blank-report','kill-evidence','disconnect-evidence'].includes(${JSON.stringify(behavior)})) {
 const findings=path.join(request.snapshot,'audit-findings'); fs.mkdirSync(findings);
 fs.writeFileSync(path.join(findings,'001-test.md'), ${JSON.stringify(behavior)} === 'empty-report' ? '' : ${JSON.stringify(behavior)} === 'blank-report' ? ' \\n\\t' : 'report'); fs.writeFileSync(path.join(findings,'001-test.patch'),'patch');
 state.artifact_state={'finding':{status:'written',report_filename:'001-test.md',patch_filename:'001-test.patch'}};
 state.verified_findings=[{finding:{title:'test'}}];
}
fs.writeFileSync(path.join(stateDir,'state.json'),JSON.stringify(state));
fs.writeFileSync(path.join(request.evidence,'native-result.json'), JSON.stringify({status:'completed', answer:'Native audit result',
 sandbox:{agentfs:true,agentfsVersion:'0.6.4'}, network:'provider-only', scope:request.expectedScope,
 route:request.expectedRoute,provider:request.expectedRoute.provider,model:request.expectedRoute.model,
 requestedEffort:request.expectedRoute.reasoningEffort}));
if (${JSON.stringify(behavior)} === 'ordinary') fs.rmSync(stateDir,{recursive:true});
if (${JSON.stringify(behavior)} === 'missing-patch') {
 state.artifact_state={'finding':{status:'written',report_filename:'001-test.md',patch_filename:'001-test.patch'}};
 state.verified_findings=[{finding:{title:'test'}}];
 fs.writeFileSync(path.join(stateDir,'state.json'),JSON.stringify(state));
}
if (${JSON.stringify(behavior)} === 'symlink-state') {
 fs.rmSync(path.join(stateDir,'state.json')); fs.symlinkSync(path.join(request.source,'code.py'),path.join(stateDir,'state.json'));
}
if (${JSON.stringify(behavior)} === 'symlink-parent') {
 const external=path.join(request.evidence,'external-state'); fs.mkdirSync(external);
 fs.writeFileSync(path.join(external,'state.json'),JSON.stringify(state));
 fs.rmSync(stateDir,{recursive:true}); fs.symlinkSync(external,stateDir);
}
if (${JSON.stringify(behavior)} === 'disconnect-evidence') {
 process.on('SIGTERM',()=>{});
 const {spawn}=require('node:child_process');
 const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],
  {stdio:['ignore','inherit','inherit','ipc']});
 descendant.once('message',()=>fs.writeFileSync(path.join(request.evidence,'request-delivered.json'),'true'));
 setInterval(()=>{},1000);return;
}
if (['timeout','kill-evidence'].includes(${JSON.stringify(behavior)})) {setInterval(()=>{},1000); return;}
if (${JSON.stringify(behavior)} === 'noisy') {process.stdout.write('x'.repeat(3*1024*1024)); setInterval(()=>{},1000); return;}
if (${JSON.stringify(behavior)} === 'error') {process.exit(1);}
process.exit(0);
});
`, { mode: 0o755 });
	process.env.HOME = root;
	process.env.XDG_CONFIG_HOME = path.join(root, "config");
	process.env.PATH = `${bin}:${trustedPath}`;
	let tool: any;
	registerExtension({ registerTool: (registered: any) => { tool = registered; } } as any,
		{ artifactRoot: artifacts, nativePython: python, nativeMaxTimeoutMs: 10_000 } as any);
	const params = { audit: { all: true, workers: 1 }, modelOverride: "offline-model", providerOverride: "lmstudio", timeoutMs: 5000 };
	const call = (input = params, signal?: AbortSignal) => tool.execute("native", input, signal, undefined, { cwd: source, hasUI: false });
	return { root, source, artifacts, tool, params, call, git, before };
}

function recover(f: ReturnType<typeof fixture>, runId: string, artifactRoot = f.artifacts): any[] {
	const pi = fs.realpathSync(path.join(ROOT, "tests", "node_modules", "@earendil-works", "pi-coding-agent"));
	// Pi supplies the host peers to this adapter and its imported extension.
	const adapter = path.join(f.root, "recover-extension.ts");
	fs.writeFileSync(adapter, `import register from ${JSON.stringify(path.join(ROOT, "extensions", "index.ts"))};
export default (pi) => register(pi, {artifactRoot:${JSON.stringify(artifactRoot)}});
`);
	const child = path.join(f.root, "recover.mjs");
	fs.writeFileSync(child, `import {DefaultResourceLoader, SettingsManager} from
  ${JSON.stringify(pathToFileURL(path.join(pi, "dist", "index.js")).href)};
try {
  const loader = new DefaultResourceLoader({
    cwd:${JSON.stringify(f.root)}, agentDir:process.env.PI_CODING_AGENT_DIR,
    settingsManager:SettingsManager.inMemory(), additionalExtensionPaths:[${JSON.stringify(adapter)}],
    noExtensions:true, noSkills:true, noPromptTemplates:true, noThemes:true, noContextFiles:true,
  });
  await loader.reload();
  const {extensions, errors} = loader.getExtensions();
  if (errors.length) throw new Error('Pi resource loader diagnostics: ' + JSON.stringify(errors));
  if (extensions.length !== 1) throw new Error('Expected one recovery extension');
  const tool = extensions[0].tools.get('swival-subagent')?.definition;
  if (!tool) throw new Error('Recovery extension did not register swival-subagent');
  const results = [];
  let signals = 0;
  process.kill = () => { signals++; throw new Error('Disk recovery must not signal or probe'); };
  for (const action of ['status', 'resume']) {
    results.push(await tool.execute('recovered', {action, id:${JSON.stringify(runId)}},
      undefined, undefined, {cwd:${JSON.stringify(f.source)}, hasUI:false}));
  }
  if (signals !== 0) throw new Error('Disk recovery attempted signalling');
  console.log(JSON.stringify(results));
} catch (error) {
  console.error(String(error.stack ?? error).slice(0, 8192));
  process.exitCode = 1;
}
`);
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: f.root, XDG_CONFIG_HOME: path.join(f.root, "config"),
		PI_CODING_AGENT_DIR: path.join(f.root, "agent"), PI_OFFLINE: "1" };
	delete env.NODE_PATH;
	for (const key of Object.keys(env)) if (key.startsWith("JITI_")) delete env[key];
	const recovered = spawnSync(process.execPath, [child], {
		cwd: f.root, env, timeout: 15000, maxBuffer: 65536, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
	});
	const diagnostics = [recovered.error?.message, recovered.stderr].filter(Boolean).join("\n").slice(0, 8192);
	expect(recovered.error, diagnostics).toBeUndefined();
	expect(recovered.status, diagnostics).toBe(0);
	const results = JSON.parse(recovered.stdout);
	expect(results).toHaveLength(2);
	return results;
}

async function disconnectedOrigin(f: ReturnType<typeof fixture>, failure: string) {
	const pi = fs.realpathSync(path.join(ROOT, "tests", "node_modules", "@earendil-works", "pi-coding-agent"));
	const adapter = path.join(f.root, "origin-extension.ts");
	fs.writeFileSync(adapter, `import register from ${JSON.stringify(path.join(ROOT, "extensions", "index.ts"))};
export default (pi) => register(pi, {artifactRoot:${JSON.stringify(f.artifacts)},nativePython:${JSON.stringify(python)},nativeMaxTimeoutMs:10000});`);
	const preload = path.join(f.root, "origin-fault.cjs");
	fs.writeFileSync(preload, `const cp=require('node:child_process'), fs=require('node:fs');
if(process.argv.some(arg=>arg.endsWith('native-audit-runner.cjs'))) {
 const rename=fs.renameSync;fs.renameSync=(from,to)=>{
  if(String(to).endsWith('completed.json')||(${JSON.stringify(failure)}==='both'&&String(to).endsWith('spawn-error.txt')))throw new Error('test marker ENOSPC');
  return rename(from,to);};
} else {
 const spawn=cp.spawn;cp.spawn=(...args)=>{const child=spawn(...args);
  if(args[1]?.[0]?.endsWith('native-audit-runner.cjs')) child.on('message',message=>{
   if(message.type==='native-child')process.send({type:'live-group',pid:message.pid});});
  return child;};
}`);
	const origin = path.join(f.root, "origin.mjs");
	fs.writeFileSync(origin, `import fs from 'node:fs';
import {DefaultResourceLoader, SettingsManager} from ${JSON.stringify(pathToFileURL(path.join(pi, "dist", "index.js")).href)};
// Offline dispatch only: the fixed local AgentFS transport does not test Linux isolation.
Object.defineProperty(process,'platform',{value:'linux'});
try {
 const loader=new DefaultResourceLoader({cwd:${JSON.stringify(f.root)},agentDir:process.env.PI_CODING_AGENT_DIR,
  settingsManager:SettingsManager.inMemory(),additionalExtensionPaths:[${JSON.stringify(adapter)}],
  noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
 await loader.reload();const {extensions,errors}=loader.getExtensions();
 if(errors.length||extensions.length!==1)throw new Error('Origin extension loader failed');
 const tool=extensions[0].tools.get('swival-subagent')?.definition;
 const result=await tool.execute('origin',{...${JSON.stringify(f.params)},async:true},undefined,undefined,{cwd:${JSON.stringify(f.source)},hasUI:false});
 if(result.isError)throw new Error(result.content[0].text);
 const requestMarker=${JSON.stringify(f.artifacts)}+'/'+fs.readdirSync(${JSON.stringify(f.artifacts)})[0]+'/evidence/request-delivered.json';
 for(let tries=0;tries<100&&!fs.existsSync(requestMarker);tries++)await new Promise(resolve=>setTimeout(resolve,20));
 if(!fs.existsSync(requestMarker))throw new Error('Native request/evidence/descendant did not become ready');
 process.send({type:'result',result},()=>process.exit(0));
} catch(error){console.error(String(error).slice(0,8192));process.exit(1);}
`);
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: f.root, XDG_CONFIG_HOME: path.join(f.root, "config"),
		PI_CODING_AGENT_DIR: path.join(f.root, "agent"), PI_OFFLINE: "1", NODE_OPTIONS: `--require=${preload}` };
	delete env.NODE_PATH;
	const proc = spawn(process.execPath, [origin], { cwd: f.root, env, shell: false, stdio: ["ignore", "pipe", "pipe", "ipc"] });
	let result: any; let pid: number | undefined; let output = "";
	for (const stream of [proc.stdout, proc.stderr]) stream?.on("data", (chunk) => {
		output += chunk; if (output.length > 65536) proc.kill("SIGKILL");
	});
	proc.on("message", (message: any) => {
		if (message.type === "result") result = message.result;
		if (message.type === "live-group") pid = message.pid;
	});
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("Origin test timed out")); }, 15000);
		proc.once("error", reject);
		proc.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(output)); });
	});
	return { result, pid };
}

describe("native audit durable lifecycle (offline transport stub)", () => {
	it("prunes expired artifacts during synchronous native-only dispatch while retaining uncertain runs", async () => {
		const f = fixture();
		const removable = ["verified", "verified-fallback", "not-started", "ordinary"];
		const retained = ["missing", "malformed", "unverified", "recent"];
		for (const kind of [...removable, ...retained]) {
			const runDir = path.join(f.artifacts, kind); fs.mkdirSync(runDir);
			fs.writeFileSync(path.join(runDir, "run-meta.json"), JSON.stringify({ nativeAuditRequested: kind !== "ordinary" }));
			if (kind !== "missing") fs.writeFileSync(path.join(runDir,
				kind === "verified-fallback" ? "spawn-error.txt" : "completed.json"), kind === "malformed" ? "{" :
				JSON.stringify({ exitCode: 1, exitedAt: new Date().toISOString(),
					...(kind !== "ordinary" ? { shutdown: kind === "unverified" ? "unverified" :
						kind === "not-started" ? "not-started" : "verified" } : {}) }));
			if (kind !== "recent") {
				const old = new Date(Date.now() - 10 * 24 * 60 * 60_000); fs.utimesSync(runDir, old, old);
			}
		}
		const result = await f.call();
		expect(result.isError, result.content[0].text).not.toBe(true);
		await vi.waitFor(() => {
			for (const kind of removable) expect(fs.existsSync(path.join(f.artifacts, kind)), kind).toBe(false);
		});
		for (const kind of retained) expect(fs.existsSync(path.join(f.artifacts, kind)), kind).toBe(true);
	});

	it("retains an expired active native run during another synchronous native dispatch", async () => {
		const active = fixture("timeout");
		const started = await active.call({ ...active.params, async: true, timeoutMs: 10000 } as any);
		expect(started.isError, started.content[0].text).not.toBe(true);
		const runDir = path.join(active.artifacts, fs.readdirSync(active.artifacts)[0]);
		try {
			const old = new Date(Date.now() - 10 * 24 * 60 * 60_000); fs.utimesSync(runDir, old, old);
			const sync = fixture();
			let tool: any;
			registerExtension({ registerTool: (value: any) => { tool = value; } } as any,
				{ artifactRoot: active.artifacts, nativePython: python });
			const result = await tool.execute("native-prune", sync.params, undefined, undefined,
				{ cwd: sync.source, hasUI: false });
			expect(result.isError, result.content[0].text).not.toBe(true);
			expect(fs.existsSync(path.join(runDir, "snapshot"))).toBe(true);
			expect(fs.existsSync(path.join(runDir, "completed.json"))).toBe(false);
		} finally {
			await active.tool.execute("interrupt", { action: "interrupt", id: started.details.runId },
				undefined, undefined, { cwd: active.source, hasUI: false });
			await vi.waitFor(() => expect(fs.existsSync(path.join(runDir, "completed.json"))).toBe(true), { timeout: 5000 });
		}
	}, 15000);

	it.each(["invalid-audit", "invalid-timeout", "invalid-ceiling", "pre-aborted", "cancel-preparation"])(
		"does not prune retained evidence or launch after native %s rejection", async (kind) => {
			const f = fixture(); const stale = path.join(f.artifacts, "verified"); fs.mkdirSync(stale);
			fs.writeFileSync(path.join(stale, "run-meta.json"), JSON.stringify({ nativeAuditRequested: true }));
			fs.writeFileSync(path.join(stale, "completed.json"), JSON.stringify({ exitCode: 0,
				exitedAt: new Date().toISOString(), shutdown: "verified" }));
			const old = new Date(Date.now() - 10 * 24 * 60 * 60_000); fs.utimesSync(stale, old, old);
			const params = { ...f.params, ...(kind === "invalid-audit" ? { audit: { workers: 9 } } : {}),
				...(kind === "invalid-timeout" ? { timeoutMs: 0 } : {}) };
			const controller = new AbortController();
			if (kind === "pre-aborted") controller.abort();
			let tool = f.tool;
			if (kind === "invalid-ceiling") registerExtension({ registerTool: (value: any) => { tool = value; } } as any,
				{ artifactRoot: f.artifacts, nativePython: python, nativeMaxTimeoutMs: 0 });
			const launches = vi.mocked(spawn).mock.calls.length;
			const pending = tool.execute("native-rejected", params, controller.signal, undefined,
				{ cwd: f.source, hasUI: false });
			if (kind === "cancel-preparation") queueMicrotask(() => controller.abort());
			const result = await pending;
			expect(result.isError, result.content[0].text).toBe(true);
			expect(fs.readdirSync(f.artifacts)).toEqual(["verified"]);
			expect(vi.mocked(spawn).mock.calls.slice(launches)).toEqual([]);
		});

	it.each(["completion", "both"])("persists disconnected wrapper %s failure independently of a real Pi origin lifetime", async (failure) => {
		const f = fixture("disconnect-evidence");
		const { result: started, pid } = await disconnectedOrigin(f, failure);
		try {
			expect(pid).toBeGreaterThan(1); expect(started.details.runId).toMatch(/^swival-run-/);
			const runDir = path.join(f.artifacts, fs.readdirSync(f.artifacts)[0]);
			for (let tries = 0; tries < 200; tries++) {
				try { process.kill(-pid!, 0); } catch { break; }
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(() => process.kill(-pid!, 0)).toThrow();
			for (let tries = 0; tries < 100 && fs.existsSync(path.join(runDir, "snapshot")); tries++) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(fs.existsSync(path.join(runDir, "snapshot"))).toBe(false);
			for (const name of ["001-test.md", "001-test.patch"]) expect(fs.existsSync(path.join(runDir, "evidence", "audit-findings", name))).toBe(true);
			if (failure === "completion") {
				for (let tries = 0; tries < 100 && !fs.existsSync(path.join(runDir, "spawn-error.txt")); tries++) {
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				const fallback = JSON.parse(fs.readFileSync(path.join(runDir, "spawn-error.txt"), "utf8"));
				expect(fallback.exitCode).not.toBe(0); expect(fallback.shutdown).toBe("verified");
				expect(fallback.stopped).toMatch(/disconnect/); expect(fallback.persistenceFailure).toMatch(/completion/);
			} else expect(fs.existsSync(path.join(runDir, "spawn-error.txt"))).toBe(false);
			for (const recovered of recover(f, started.details.runId)) {
				expect(recovered.isError, recovered.content[0].text).toBe(true);
				expect(recovered.content[0].text).not.toMatch(/still running|in progress/);
				expect(recovered.content[0].text).toContain(failure === "both" ? "state is unknown" : "completion marker could not be persisted");
			}
		} finally { if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* live origin IPC identity already stopped */ } } }
	}, 25000);

	it.each(["model", "endpoint", "options"])("rejects %s route drift between preflights without launching", async (field) => {
		const f = fixture();
		const configDir = path.join(f.root, "config", "swival"); fs.mkdirSync(configDir, { recursive: true });
		const config = path.join(configDir, "config.toml");
		fs.writeFileSync(config, '[profiles.test]\nprovider="lmstudio"\nmodel="offline-A"\nbase_url="http://route-a.invalid"\n');
		const params: any = { ...f.params, profileOverride: "test" }; delete params.modelOverride;
		const write = vi.mocked(fsPromises.writeFile).getMockImplementation()!;
		const launches = vi.mocked(spawn).mock.calls.length;
		const spy = vi.spyOn(fsPromises, "writeFile").mockImplementation(async (file, data, options) => {
			await write(file, data, options);
			if (String(file).endsWith(`${path.sep}snapshot${path.sep}swival.toml`)) {
				fs.writeFileSync(config, '[profiles.test]\nprovider="lmstudio"\n' +
					`model="${field === "model" ? "offline-B" : "offline-A"}"\n` +
					`base_url="http://${field === "endpoint" ? "route-b" : "route-a"}.invalid"\n` +
					(field === "options" ? 'temperature=0.25\n' : ''));
			}
		});
		try {
			const result = await f.call(params);
			expect(result.isError, result.content[0].text).toBe(true);
			expect(result.content[0].text).toMatch(/route.*changed|routing.*changed/i);
			expect(fs.readdirSync(f.artifacts)).toEqual([]);
			expect(vi.mocked(spawn).mock.calls.slice(launches)).toEqual([]);
			expect(f.git("show-ref")).toBe(f.before);
		} finally { spy.mockRestore(); }
	});

	it.each(["model", "endpoint", "options", "top-model", "missing", "request"])("rejects %s completion route evidence drift", async (field) => {
		const f = fixture(); const initial = await f.call();
		expect(initial.isError, initial.content[0].text).not.toBe(true);
		const runDir = initial.details.results[0].artifactDir;
		const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
		const target = path.join(runDir, field === "request" ? "request.json" : "evidence/native-result.json");
		const record = JSON.parse(fs.readFileSync(target, "utf8"));
		const route = structuredClone(manifest.route);
		if (field === "model" || field === "request") route.model = "offline-drift";
		if (field === "endpoint") route.destination = { ...route.destination, apiBase: "http://drift.invalid/v1" };
		if (field === "options") route.options = { ...route.options, max_turns: 1 };
		if (field === "request") record.expectedRoute = route;
		else if (field === "missing") delete record.route;
		else if (field === "top-model") record.model = "offline-drift";
		else record.route = route;
		fs.writeFileSync(target, JSON.stringify(record));
		const { inspectNativeAudit } = await import("../extensions/native-audit.js");
		expect((await inspectNativeAudit(runDir, 0)).status).toBe("failed");
	});

	it("writes native metadata once and preserves its original bytes for fresh recovery", async () => {
		const f = fixture();
		const write = vi.mocked(fsPromises.writeFile).getMockImplementation()!;
		const records: string[] = [];
		const spy = vi.spyOn(fsPromises, "writeFile").mockImplementation(async (file, data, options) => {
			if (String(file).endsWith("run-meta.json")) {
				records.push(String(data));
				if (records.length > 1) {
					await write(file, "{", options);
					throw new Error("test truncation on redundant metadata write");
				}
			}
			return write(file, data, options);
		});
		try {
			const result = await f.call();
			expect(result.isError, result.content[0].text).not.toBe(true);
			expect(records).toHaveLength(1);
			const persisted = fs.readFileSync(path.join(result.details.results[0].artifactDir, "run-meta.json"), "utf8");
			expect(persisted).toBe(records[0]);
			expect(JSON.parse(persisted).pid).toBeUndefined();
			for (const recovered of recover(f, result.details.runId)) expect(recovered.isError).not.toBe(true);
		} finally { spy.mockRestore(); }
	}, 20000);

	it.each(["missing", "malformed", "invalid-exit", "missing-shutdown", "invalid-fallback"])(
		"reports unknown disk-only native state for %s terminal evidence without signalling", (kind) => {
			const f = fixture();
			const runDir = path.join(f.artifacts, "recovered-native"); fs.mkdirSync(runDir);
			const runId = `recovered-${kind}`;
			fs.writeFileSync(path.join(runDir, "run-meta.json"), JSON.stringify({ runId, agent: "native-audit",
				task: "/audit", startedAt: Date.now(), pid: 12345, nativeAuditRequested: true, artifactDir: runDir,
				stdoutFile: path.join(runDir, "stdout.txt"), stderrFile: path.join(runDir, "stderr.txt") }));
			if (kind !== "missing") fs.writeFileSync(path.join(runDir,
				kind === "invalid-fallback" ? "spawn-error.txt" : "completed.json"), kind === "malformed" ? "{" :
				JSON.stringify({ exitCode: kind === "invalid-exit" ? "0" : 0, exitedAt: new Date().toISOString(),
					...(kind === "invalid-exit" || kind === "invalid-fallback" ? { shutdown: "verified" } : {}) }));
			for (const recovered of recover(f, runId)) {
				expect(recovered.isError, recovered.content[0].text).toBe(true);
				expect(recovered.content[0].text).toMatch(/state is unknown/i);
				expect(recovered.content[0].text).toContain(runDir);
				expect(recovered.content[0].text).not.toMatch(/still running|in progress|completed/i);
			}
		}, 20000,
	);
	it("preserves real native state/report/patch writes after killing the wrapper, then recovers failure fresh", async () => {
		const f = fixture("kill-evidence");
		const actualSpawn = vi.mocked(spawn).getMockImplementation()!;
		let wrapper: ChildProcess | undefined; let childPid: number | undefined;
		vi.mocked(spawn).mockImplementation((command, args, options) => {
			const proc = actualSpawn(command, args, options);
			if (String(args?.[0]).endsWith("native-audit-runner.cjs")) {
				wrapper = proc;
				proc.on("message", (message: any) => { if (message.type === "native-child") childPid = message.pid; });
			}
			return proc;
		});
		try {
			const started = await f.call({ ...f.params, async: true } as any);
			expect(started.isError, started.content[0].text).not.toBe(true);
			const runDir = path.join(f.artifacts, fs.readdirSync(f.artifacts)[0]);
			const sourceFiles = [path.join(".swival", "audit", "abc12345", "state.json"),
				path.join("audit-findings", "001-test.md"), path.join("audit-findings", "001-test.patch")];
			for (let tries = 0; tries < 100 && !sourceFiles.every((file) => fs.existsSync(path.join(runDir, "snapshot", file))); tries++) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			const original = sourceFiles.map((file) => fs.readFileSync(path.join(runDir, "snapshot", file)));
			wrapper!.kill("SIGKILL");
			let status: any;
			for (let tries = 0; tries < 200; tries++) {
				status = await f.tool.execute("status", { action: "status", id: started.details.runId }, undefined,
					undefined, { cwd: f.source, hasUI: false });
				if (!status.content[0].text.includes("still running")) break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(status.isError, status.content[0].text).toBe(true);
			const retained = [path.join("native-state", "abc12345", "state.json"),
				path.join("audit-findings", "001-test.md"), path.join("audit-findings", "001-test.patch")];
			retained.forEach((file, i) => expect(fs.readFileSync(path.join(runDir, "evidence", file))).toEqual(original[i]));
			for (const name of ["snapshot", "runtime-bin", "sandbox"]) expect(fs.existsSync(path.join(runDir, name))).toBe(false);
			expect(childPid).toBeGreaterThan(1); expect(() => process.kill(-childPid!, 0)).toThrow();
			for (const result of recover(f, started.details.runId)) {
				expect(result.isError).toBe(true); expect(result.content[0].text).not.toMatch(/unknown|still running|in progress/);
			}
		} finally {
			vi.mocked(spawn).mockImplementation(actualSpawn);
			if (childPid) { try { process.kill(-childPid, "SIGKILL"); } catch { /* live test channel already stopped */ } }
			if (wrapper?.pid) { try { process.kill(-wrapper.pid, "SIGKILL"); } catch { /* retained handle already exited */ } }
		}
	}, 20000);

	it.each([false, true])("rolls back metadata write failure without a worker (async=%s)", async (async) => {
		const f = fixture();
		const launches = vi.mocked(spawn).mock.calls.length;
		const write = vi.mocked(fsPromises.writeFile).getMockImplementation()!;
		let runId = "";
		const spy = vi.spyOn(fsPromises, "writeFile").mockImplementation((file, data, options) => {
			if (String(file).endsWith("run-meta.json")) {
				runId = JSON.parse(String(data)).runId;
				return Promise.reject(new Error("Native metadata write failed (test ENOSPC)."));
			}
			return write(file, data, options);
		});
		try {
			const result = await f.call({ ...f.params, async } as any);
			expect(result.isError, result.content[0].text).toBe(true);
			expect(result.content[0].text).toContain("metadata");
			expect(result.content[0].text).not.toContain("started.");
			expect(fs.readdirSync(f.artifacts)).toEqual([]);
			expect(vi.mocked(spawn).mock.calls.slice(launches)).toEqual([]);
			expect(runId).toMatch(/^swival-run-/);
			for (const recovered of recover(f, runId)) {
				expect(recovered.isError).toBe(true);
				expect(recovered.content[0].text).toContain("not found");
			}
		} finally { spy.mockRestore(); }
	}, 20000);

	it.each([false, true].flatMap((async) =>
		["EAGAIN", "throw", "early-exit", "early-success", "before-notify", "awaiting-ack", "channel-disconnect", "invalid-ownership", "after-ack", "completion-io", "evidence-io"].map((failure) => [async, failure] as const)))
		("persists %s async launch failure: %s", async (async, failure) => {
		const f = fixture("timeout");
		const actualSpawn = vi.mocked(spawn).getMockImplementation()!;
		const preload = path.join(f.root, "exit-wrapper.cjs");
		fs.writeFileSync(preload, `const cp=require('node:child_process'); const spawn=cp.spawn;
cp.spawn=(...args)=>{const child=spawn(...args);
 if(${JSON.stringify(failure)}==='before-notify') process.send({type:'test-launcher',pid:child.pid},()=>process.exit(23));
 if(${JSON.stringify(failure)}==='after-ack') {const end=child.stdin.end.bind(child.stdin);child.stdin.end=(...values)=>{process.exit(23);return end(...values);};}
 return child;};
if (${JSON.stringify(failure)}==='awaiting-ack') {
 const send=process.send;process.send=(...args)=>{const result=send.apply(process,args);setTimeout(()=>process.exit(23),50);return result;};
}
if (${JSON.stringify(failure)}==='invalid-ownership') {
 const send=process.send;process.send=(message,...args)=>{send.call(process,{type:'test-launcher',pid:message.pid});return send.call(process,{...message,pid:0},...args);};
}`);
		// Patch the actual CJS filesystem used by shared finalization, not an ESM mock.
		const write = actualFs.writeFileSync;
		const writeSpy = vi.spyOn(actualFs, "writeFileSync").mockImplementation((file, data, options) => {
			if (failure === "evidence-io" && /completed\.json|spawn-error\.txt/.test(String(file))) throw new Error("test ENOSPC");
			return write(file, data, options);
		});
		let wrapper: ChildProcess | undefined; let childPid: number | undefined;
		// Replace only the fixed durable wrapper launch; all preflight/Git calls stay real.
		vi.mocked(spawn).mockImplementation((command, args, options) => {
			if (!String(args?.[0]).endsWith("native-audit-runner.cjs")) return actualSpawn(command, args, options);
			if (failure === "throw") throw new Error("test spawn EAGAIN");
			if (failure === "EAGAIN") {
				wrapper = new ChildProcess();
				setImmediate(() => { wrapper!.emit("error", new Error("test spawn EAGAIN")); wrapper!.emit("close", null); });
				return wrapper;
			}
			if (["before-notify", "awaiting-ack", "channel-disconnect", "invalid-ownership", "after-ack"].includes(failure)) {
				wrapper = actualSpawn(command, ["--require", preload, ...args!], options);
				if (failure === "awaiting-ack") wrapper.send = (() => true) as typeof wrapper.send;
				if (failure === "channel-disconnect") {
					wrapper.send = (() => { wrapper!.disconnect(); return true; }) as typeof wrapper.send;
				}
			} else {
				if (failure === "completion-io") fs.mkdirSync(path.join(String(args?.[1]), "completed.json"));
				wrapper = actualSpawn(command, ["-e", `process.exit(${failure === "early-success" ? 0 : 23})`], options);
			}
			wrapper.on("message", (message: any) => {
				if (["native-child", "test-launcher"].includes(message.type) && message.pid > 1) childPid = message.pid;
			});
			return wrapper;
		});
		let result: any;
		try {
			result = await f.call({ ...f.params, async } as any);
			expect(result.isError, `${failure}: ${result.content[0].text}`).toBe(true);
			expect(result.content[0].text).not.toContain("started.");
			const runDir = path.join(f.artifacts, fs.readdirSync(f.artifacts)[0]);
			expect(fs.existsSync(path.join(runDir, "snapshot")), failure).toBe(false);
			expect(fs.existsSync(path.join(runDir, "runtime-bin")), failure).toBe(false);
			expect(fs.existsSync(path.join(runDir, "sandbox")), failure).toBe(false);
			expect(fs.existsSync(path.join(runDir, "evidence", "launch.json")), failure).toBe(false);
			if (!["completion-io", "evidence-io"].includes(failure)) {
				const completed = JSON.parse(fs.readFileSync(path.join(runDir, "completed.json"), "utf8"));
				expect(completed.exitCode, failure).not.toBe(0);
				expect(completed.stopped, failure).toMatch(failure === "invalid-ownership" ? /interrupt/i : /start|exit|lifecycle|ownership/i);
			}
			const meta = JSON.parse(fs.readFileSync(path.join(runDir, "run-meta.json"), "utf8"));
			if (failure === "evidence-io") expect(result.content[0].text).toMatch(/could not.*persist|persist.*failed/i);
			for (const recovered of recover(f, meta.runId)) {
				expect(recovered.isError, `${failure}: ${recovered.content[0].text}`).toBe(true);
				expect(recovered.content[0].text).not.toMatch(/still running|in progress/);
				if (failure === "evidence-io") expect(recovered.content[0].text).toContain("state is unknown");
			}
			if (childPid) expect(() => process.kill(-childPid!, 0), failure).toThrow();
			expect(f.git("show-ref")).toBe(f.before);
		} finally {
			vi.mocked(spawn).mockImplementation(actualSpawn);
			writeSpy.mockRestore();
			if (childPid) { try { process.kill(-childPid, "SIGKILL"); } catch { /* identity came from live test IPC */ } }
			if (wrapper?.pid) { try { process.kill(-wrapper.pid, "SIGKILL"); } catch {} }
		}
	}, 20000);

	it.each(["source", "source-link-out", "external-link-in", "metadata-link-in", "relative"])(
		"rejects %s Git lookup before any repository executable runs", async (kind) => {
			const f = fixture();
			const marker = path.join(f.root, "git-executed");
			const external = path.join(f.root, "marker-git");
			fs.writeFileSync(external, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');`, { mode: 0o755 });
			const owned = path.join(f.source, kind === "metadata-link-in" ? ".git" : "bin");
			fs.mkdirSync(owned, { recursive: true });
			const target = path.join(owned, "git");
			if (kind === "source-link-out") fs.symlinkSync(external, target);
			else fs.copyFileSync(external, target);
			fs.chmodSync(target, 0o755);
			let entry = owned;
			if (kind.includes("link-in")) {
				entry = path.join(f.root, "bin"); fs.symlinkSync(target, path.join(entry, "git"));
			}
			if (kind === "relative") {
				fs.copyFileSync(external, path.join(f.source, "git"));
				entry = ".";
			}
			process.env.PATH = `${entry}:${trustedPath}`;
			let tool: any;
			registerExtension({ registerTool: (value: any) => { tool = value; } } as any,
				{ artifactRoot: f.artifacts, nativePython: python });
			const result = await tool.execute("git-boundary", f.params, undefined, undefined,
				{ cwd: f.source, hasUI: false });
			expect(result.isError).toBe(true);
			expect(fs.existsSync(marker)).toBe(false);
			expect(fs.readdirSync(f.artifacts)).toEqual([]);
		},
	);

	it("pins the external virtualenv entry under -I and the canonical AgentFS executable", async () => {
		const f = fixture();
		const pythonDir = path.join(f.root, "python-install"); fs.symlinkSync(path.dirname(python), pythonDir);
		const agentfsEntry = path.join(f.root, "bin", "agentfs");
		const agentfsTarget = path.join(f.root, "installed-agentfs"); fs.renameSync(agentfsEntry, agentfsTarget);
		fs.symlinkSync(agentfsTarget, agentfsEntry);
		let tool: any;
		registerExtension({ registerTool: (value: any) => { tool = value; } } as any,
			{ artifactRoot: f.artifacts, nativePython: path.join(pythonDir, "python") });
		const result = await tool.execute("runtime-pin", f.params, undefined, undefined, { cwd: f.source, hasUI: false });
		expect(result.isError, result.content[0].text).not.toBe(true);
		const request = JSON.parse(fs.readFileSync(path.join(result.details.results[0].artifactDir, "request.json"), "utf8"));
		expect(request.python).toBe(path.join(fs.realpathSync(path.dirname(python)), path.basename(python)));
		expect(request.agentfs).toBe(agentfsTarget);
		const imported = execFileSync(request.python, ["-I", "-B", "-c", "import importlib.metadata; print(importlib.metadata.version('swival'))"],
			{ timeout: 5000, maxBuffer: 16384, env: { ...process.env, PYTHONPATH: f.source } }).toString().trim();
		expect(imported).toBe("1.0.46");
	}, 15000);

	it.each(["source-entry-link-out", "external-link-source", "external-link-metadata"])(
		"rejects %s Python without executing it", async (kind) => {
			const f = fixture(); const marker = path.join(f.root, "python-executed");
			const external = path.join(f.root, "external-python");
			fs.writeFileSync(external, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');`, { mode: 0o755 });
			const owned = path.join(f.source, kind.endsWith("metadata") ? ".git" : "bin"); fs.mkdirSync(owned, { recursive: true });
			const entry = path.join(owned, "python");
			let selected = entry;
			if (kind === "source-entry-link-out") fs.symlinkSync(external, entry);
			else { fs.copyFileSync(external, entry); selected = path.join(f.root, "python"); fs.symlinkSync(entry, selected); }
			let tool: any;
			registerExtension({ registerTool: (value: any) => { tool = value; } } as any,
				{ artifactRoot: f.artifacts, nativePython: selected });
			const result = await tool.execute("runtime-denied", f.params, undefined, undefined, { cwd: f.source, hasUI: false });
			expect(result.isError).toBe(true); expect(fs.existsSync(marker)).toBe(false); expect(fs.readdirSync(f.artifacts)).toEqual([]);
		},
	);

	it("pins a trusted external installation symlink for upstream Git calls", async () => {
		const f = fixture();
		const trusted = fs.realpathSync(execFileSync("/usr/bin/which", ["git"], { timeout: 5000 }).toString().trim());
		fs.symlinkSync(trusted, path.join(f.root, "bin", "git"));
		let tool: any;
		registerExtension({ registerTool: (value: any) => { tool = value; } } as any,
			{ artifactRoot: f.artifacts, nativePython: python });
		const result = await tool.execute("git-pin", f.params, undefined, undefined, { cwd: f.source, hasUI: false });
		expect(result.isError, result.content[0].text).not.toBe(true);
		const runDir = result.details.results[0].artifactDir;
		const launch = JSON.parse(fs.readFileSync(path.join(runDir, "evidence", "launch.json"), "utf8"));
		expect(launch.path.split(path.delimiter)[0]).toBe(path.join(runDir, "runtime-bin"));
		expect(launch.git).toBe(trusted);
		expect(fs.existsSync(path.join(runDir, "runtime-bin"))).toBe(false);
	});

	it.each(["retarget", "replace"])("pins canonical nono for released wrapper lookup after startup entry %s", async (change) => {
		const f = fixture("nono-lookup");
		const entry = path.join(f.root, "bin", "nono");
		const canonical = path.join(f.root, "installed-nono"); fs.renameSync(entry, canonical); fs.symlinkSync(canonical, entry);
		const unverified = path.join(f.root, "unverified-nono");
		fs.writeFileSync(unverified, "#!/bin/sh\necho 'unverified nono'\n", { mode: 0o755 });
		const write = vi.mocked(fsPromises.writeFile).getMockImplementation()!;
		let replaced = false;
		const spy = vi.spyOn(fsPromises, "writeFile").mockImplementation(async (file, data, options) => {
			await write(file, data, options);
			if (String(file).endsWith(`${path.sep}snapshot${path.sep}swival.toml`)) {
				fs.rmSync(entry);
				if (change === "retarget") fs.symlinkSync(unverified, entry); else fs.copyFileSync(unverified, entry);
				replaced = true;
			}
		});
		try {
			const result = await f.call();
			expect(replaced).toBe(true);
			expect(result.isError, result.content[0].text).not.toBe(true);
			const runDir = result.details.results[0].artifactDir;
			const lookup = JSON.parse(fs.readFileSync(path.join(runDir, "evidence", "nono-lookup.json"), "utf8"));
			expect(lookup.executable).toBe(canonical);
			expect(lookup.version).toBe("nono 0.4.1");
			expect(lookup.wrapper[0]).toBe(path.join(runDir, "runtime-bin", "nono"));
			expect(lookup.wrapper).toContain("--block-net");
			expect(fs.readFileSync(canonical, "utf8")).toBe("#!/bin/sh\necho 'nono 0.4.1'\n");
			expect(fs.existsSync(path.join(runDir, "runtime-bin"))).toBe(false);
		} finally { spy.mockRestore(); }
	}, 15000);

	it.each(["before-ack", "handoff"])("cancels async native launch at %s and awaits cleanup", async (phase) => {
		const f = fixture("timeout"); const controller = new AbortController();
		const actualSpawn = vi.mocked(spawn).getMockImplementation()!;
		let wrapper: ChildProcess | undefined; let childPid: number | undefined;
		vi.mocked(spawn).mockImplementation((command, args, options) => {
			const proc = actualSpawn(command, args, options);
			if (String(args?.[0]).endsWith("native-audit-runner.cjs")) {
				wrapper = proc;
				proc.prependListener("message", (message: any) => {
					if (message.type === "native-child") {
						childPid = message.pid;
						if (phase === "before-ack") controller.abort();
					}
					if (message.type === "native-started" && phase === "handoff") controller.abort();
				});
			}
			return proc;
		});
		try {
			const result = await f.call({ ...f.params, async: true } as any, controller.signal);
			expect(result.isError, result.content[0].text).toBe(true);
			expect(result.content[0].text).toMatch(/cancel/i);
			const runDir = path.join(f.artifacts, fs.readdirSync(f.artifacts)[0]);
			expect(fs.existsSync(path.join(runDir, "completed.json"))).toBe(true);
			expect(fs.existsSync(path.join(runDir, "snapshot"))).toBe(false);
			expect(childPid).toBeGreaterThan(1); expect(() => process.kill(-childPid!, 0)).toThrow();
		} finally {
			vi.mocked(spawn).mockImplementation(actualSpawn);
			if (childPid) { try { process.kill(-childPid, "SIGKILL"); } catch { /* live test channel already stopped */ } }
			if (wrapper?.pid) { try { process.kill(-wrapper.pid, "SIGKILL"); } catch { /* retained handle already exited */ } }
		}
	}, 15000);

	it("recovers status and resume from a fresh process through an external artifact-root symlink", async () => {
		const f = fixture("patch");
		const link = path.join(f.root, "artifact-link"); fs.symlinkSync(f.artifacts, link);
		let tool: any;
		registerExtension({ registerTool: (value: any) => { tool = value; } } as any,
			{ artifactRoot: link, nativePython: python });
		const finished = await tool.execute("finish", f.params, undefined, undefined, { cwd: f.source, hasUI: false });
		expect(finished.isError, finished.content[0].text).not.toBe(true);
		const results = recover(f, finished.details.runId, link);
		expect(results).toHaveLength(2);
		for (const result of results) {
			expect(result.isError, result.content[0].text).not.toBe(true);
			expect(result.details.results[0].nativeAudit.status).toBe("completed");
			expect(result.details.results[0].artifactDir).toBe(finished.details.results[0].artifactDir);
		}
		expect(results[0].content[0].text).toContain("completed");
		expect(results[1].content[0].text).toContain("Native audit result");
	});
	it.each(["complete", "patch"])("persists validated native %s evidence without changing source or Git refs", async (behavior) => {
		const f = fixture(behavior);
		const result = await f.call();
		expect(result.isError, result.content[0].text).not.toBe(true);
		const run = result.details.results[0];
		expect(run.nativeAudit.status).toBe("completed");
		expect(run.artifactDir.startsWith(f.artifacts)).toBe(true);
		expect(fs.existsSync(path.join(run.artifactDir, "evidence", "native-state", "abc12345", "state.json"))).toBe(true);
		expect(f.git("show-ref")).toBe(f.before);
		expect(f.git("status", "--porcelain")).toBe("");
		const launch = JSON.parse(fs.readFileSync(path.join(run.artifactDir, "evidence", "launch.json"), "utf8"));
		expect(launch.args).toContain("--no-default-allows");
		expect(launch.args).not.toContain(f.source);
		expect(launch.cwd).toBe(path.join(run.artifactDir, "sandbox"));
		if (behavior === "patch") expect(fs.existsSync(path.join(run.artifactDir, "evidence", "audit-findings", "001-test.patch"))).toBe(true);
	});
	it.each([false, true])("rejects unrecovered released finding expansion through dispatch (async=%s)", async (async) => {
		const f = fixture("lost-expansion");
		let result = await f.call({ ...f.params, timeoutMs: 10000, reasoningEffortOverride: "xhigh", async } as any);
		if (async && !result.isError) {
			const runId = result.details.runId;
			for (let tries = 0; tries < 200; tries++) {
				result = await f.tool.execute("resume", { action: "resume", id: runId }, undefined, undefined,
					{ cwd: f.source, hasUI: false });
				if (!result.content[0].text.includes("in progress")) break;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		expect(result.isError, result.content[0].text).toBe(true);
		const run = result.details.results[0];
		const diagnostics = fs.readFileSync(path.join(run.artifactDir, "stderr.txt"), "utf8");
		expect(run.nativeAudit.status, `${result.content[0].text}\n${diagnostics}`).toBe("partial");
		expect(result.content[0].text).toContain("expansion");
		const nativeResult = JSON.parse(fs.readFileSync(path.join(run.artifactDir, "evidence", "native-result.json"), "utf8"));
		expect(nativeResult.status).toBe("partial"); expect(nativeResult.unrecoveredExpansionFailures).toBe(1);
		const state = JSON.parse(fs.readFileSync(run.nativeAudit.statePath, "utf8"));
		expect(state.phase).toBe("done"); expect(state.verified_findings).toHaveLength(1);
		const terminal = JSON.parse(fs.readFileSync(path.join(run.artifactDir, "completed.json"), "utf8"));
		expect(terminal.shutdown).toBe("verified"); expect(terminal.stopped).toBeUndefined();
		expect(f.git("show-ref")).toBe(f.before);
		expect(f.git("status", "--porcelain")).toBe("");
	}, 15000);

	it.each(["partial", "ordinary", "truncate", "error", "missing-patch", "symlink-state", "symlink-parent", "missing-deep", "empty-report", "blank-report"])("does not accept %s state or a mocked ordinary answer", async (behavior) => {
		const f = fixture(behavior);
		const result = await f.call();
		expect(result.isError).toBe(true);
		expect(fs.readdirSync(f.artifacts)).toHaveLength(1);
		expect(f.git("show-ref")).toBe(f.before);
	});
	it.each(["timeout", "noisy"])("bounds %s native subprocesses and keeps partial state", async (behavior) => {
		const f = fixture(behavior);
		const result = await f.call({ ...f.params, timeoutMs: 500 });
		expect(result.isError).toBe(true);
		const run = result.details.results[0];
		expect(fs.existsSync(path.join(run.artifactDir, "evidence", "native-state", "abc12345", "state.json"))).toBe(true);
		expect(fs.statSync(path.join(run.artifactDir, "stdout.txt")).size).toBeLessThanOrEqual(2 * 1024 * 1024);
		expect(fs.existsSync(path.join(run.artifactDir, "snapshot"))).toBe(false);
	}, 15000);
	it.each([false, true])("blocks Darwin/AgentFS 0.6.4 before source materialization (resolved links=%s)", async (links) => {
		const f = fixture();
		Object.defineProperty(process, "platform", { value: "darwin" });
		let cwd = f.source;
		let artifactRoot = f.artifacts;
		if (links) {
			const metadata = path.join(f.root, "git-metadata"); fs.renameSync(path.join(f.source, ".git"), metadata);
			fs.symlinkSync(metadata, path.join(f.source, ".git"));
			cwd = path.join(f.root, "source-link"); fs.symlinkSync(f.source, cwd);
			artifactRoot = path.join(f.root, "artifact-link"); fs.symlinkSync(f.artifacts, artifactRoot);
		}
		let tool: any;
		registerExtension({ registerTool: (registered: any) => { tool = registered; } } as any,
			{ artifactRoot, nativePython: python } as any);
		const result = await tool.execute("native", f.params, undefined, undefined, { cwd, hasUI: false });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/Darwin.*0\.6\.4|macOS.*0\.6\.4/);
		expect(result.content[0].text).toMatch(/temporary.*writ|writ.*temporary/);
		expect(fs.readdirSync(f.artifacts)).toEqual([]);
		expect(f.git("status", "--porcelain")).toBe("");
		expect(f.git("show-ref")).toBe(f.before);
	});

	it("does not assume newer AgentFS versions provide safe native isolation", async () => {
		const f = fixture();
		const bin = path.join(f.root, "bin", "agentfs");
		fs.writeFileSync(bin, fs.readFileSync(bin, "utf8").replace("agentfs 0.6.4", "agentfs 0.6.5"));
		const result = await f.call();
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/unverified AgentFS|native isolation canary/i);
		expect(fs.readdirSync(f.artifacts)).toEqual([]);
	});

	it("cancels during preparation without launching a worker or retaining snapshots", async () => {
		const f = fixture();
		const controller = new AbortController();
		const pending = f.call(f.params, controller.signal);
		queueMicrotask(() => controller.abort());
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/cancel/i);
		expect(fs.readdirSync(f.artifacts)).toEqual([]);
		expect(f.git("status", "--porcelain")).toBe("");
		expect(f.git("show-ref")).toBe(f.before);
	});

	it("interrupts an async native process tree and preserves partial evidence", async () => {
		const f = fixture("timeout");
		const started = await f.call({ ...f.params, async: true } as any);
		expect(started.isError, started.content[0].text).not.toBe(true);
		const runId = started.details.runId;
		const interrupt = await f.tool.execute("interrupt", { action: "interrupt", id: runId }, undefined, undefined, { cwd: f.source, hasUI: false });
		expect(interrupt.isError).not.toBe(true);
		let status: any;
		for (let tries = 0; tries < 100; tries++) {
			status = await f.tool.execute("status", { action: "status", id: runId }, undefined, undefined, { cwd: f.source, hasUI: false });
			if (!status.content[0].text.includes("still running")) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(status.isError).toBe(true);
		expect(status.content[0].text).toMatch(/interrupt/i);
		const run = status.details.results[0];
		expect(fs.existsSync(path.join(run.artifactDir, "completed.json"))).toBe(true);
		expect(fs.existsSync(path.join(run.artifactDir, "snapshot"))).toBe(false);
		expect(f.git("show-ref")).toBe(f.before);
	}, 15000);

	it("fails before artifacts when nono is unavailable; never falls back to unrestricted network", async () => {
		const f = fixture();
		fs.rmSync(path.join(f.root, "bin", "nono"));
		fs.symlinkSync(execFileSync("/usr/bin/which", ["git"], { timeout: 5000, maxBuffer: 16384 }).toString().trim(), path.join(f.root, "bin", "git"));
		process.env.PATH = path.join(f.root, "bin");
		let tool: any;
		registerExtension({ registerTool: (registered: any) => { tool = registered; } } as any,
			{ artifactRoot: f.artifacts, nativePython: python } as any);
		const result = await tool.execute("native", f.params, undefined, undefined, { cwd: f.source, hasUI: false });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/nono.*provider-only|provider-only.*nono/);
		expect(fs.readdirSync(f.artifacts)).toEqual([]);
	});

	it("refuses repository-supplied Python before configuration preflight", async () => {
		const f = fixture();
		const localPython = path.join(f.source, "python");
		const marker = path.join(f.source, "executed");
		fs.writeFileSync(localPython, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');`, { mode: 0o755 });
		let tool: any;
		registerExtension({ registerTool: (registered: any) => { tool = registered; } } as any,
			{ artifactRoot: f.artifacts, nativePython: localPython } as any);
		const result = await tool.execute("native", f.params, undefined, undefined, { cwd: f.source, hasUI: false });
		expect(result.isError).toBe(true);
		expect(fs.existsSync(marker)).toBe(false);
		expect(fs.readdirSync(f.artifacts)).toEqual([]);
	});

	it.each(["source", "metadata"])("rejects an artifact-root symlink into %s before any write", async (target) => {
		const f = fixture();
		let destination = f.source;
		if (target === "metadata") {
			destination = path.join(f.root, "git-metadata");
			fs.renameSync(path.join(f.source, ".git"), destination);
			fs.symlinkSync(destination, path.join(f.source, ".git"));
		}
		const link = path.join(f.root, "linked-artifacts"); fs.symlinkSync(destination, link);
		let tool: any;
		registerExtension({ registerTool: (registered: any) => { tool = registered; } } as any,
			{ artifactRoot: link, nativePython: python } as any);
		const result = await tool.execute("native", f.params, undefined, undefined, { cwd: f.source, hasUI: false });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/outside source checkout/);
		expect(f.git("status", "--porcelain")).toBe("");
	});

	it("uses the same persisted result for async status and resume after extension reload", async () => {
		const f = fixture("patch");
		const started = await f.call({ ...f.params, async: true } as any);
		expect(started.isError, started.content[0].text).not.toBe(true);
		const runId = started.details.runId;
		expect(runId).toMatch(/^swival-run-/);
		let resumed: any;
		for (let tries = 0; tries < 100; tries++) {
			resumed = await f.tool.execute("resume", { action: "resume", id: runId }, undefined, undefined, { cwd: f.source, hasUI: false });
			if (!resumed.content[0].text.includes("in progress")) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(resumed.isError, resumed.content[0].text).not.toBe(true);
		expect(resumed.content[0].text).toContain("Native audit result");
		let reloaded: any;
		registerExtension({ registerTool: (registered: any) => { reloaded = registered; } } as any, { artifactRoot: f.artifacts, nativePython: python } as any);
		const status = await reloaded.execute("status", { action: "status", id: runId }, undefined, undefined, { cwd: f.source, hasUI: false });
		expect(status.isError, status.content[0].text).not.toBe(true);
		expect(status.content[0].text).toContain("completed");
	});
});

it("runs released native entry-point regressions with stubbed LLM calls and a socket denial", () => {
	// Match nativeEntry.test.ts: this whole suite includes five cold subprocesses.
	const output = execFileSync(python, ["-I", path.join(ROOT, "tests", "native_audit_test.py")], {
		cwd: ROOT, timeout: 60_000, maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "pipe"],
	});
	expect(output.toString()).not.toContain("provider/network forbidden");
}, 65_000);
