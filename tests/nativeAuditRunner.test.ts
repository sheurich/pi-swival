import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { nativeTestPython as python } from "./nativePython.js";
import { installOfflinePython, nativeOfflineBwrapIdentity, nativeOfflineNonoIdentity,
	nativeOfflineUnshareIdentity, recordOfflineNonoIdentity,
	recordOfflineUnshareIdentity } from "./nativeOfflinePython.js";
import { readNativeTerminal } from "../extensions/native-audit.js";

const runner = path.resolve(import.meta.dirname, "../scripts/native-audit-runner.cjs");
const roots: string[] = [];
const children: ChildProcess[] = [];
const liveGroups: number[] = [];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
afterEach(() => {
	for (const pid of liveGroups.splice(0)) { try { process.kill(-pid, "SIGKILL"); } catch { /* live IPC authority already ended */ } }
	for (const child of children.splice(0)) if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* live handle already exited */ } }
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(failure: string, logOutput?: { stdout: Buffer; stderr: Buffer }) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-runner-"))); roots.push(root);
	for (const name of ["snapshot", "runtime-bin", "evidence", "sandbox"]) fs.mkdirSync(path.join(root, name));
	const session = `native-io-${path.basename(root)}`;
	const sessionDir = path.join(root, ".bwrap", "run", session);
	const marker = path.join(root, "external-executed");
	const requestFile = path.join(root, "request-received");
	const worker = path.join(root, "bwrap");
	const unshare = path.join(root, "unshare");
	fs.writeFileSync(unshare, "#!/bin/sh\nexit 97\n", { mode: 0o755 });
	const nono = path.join(root, "nono");
	fs.writeFileSync(nono, "#!/bin/sh\nexit 97\n", { mode: 0o755 });
	fs.symlinkSync(nono, path.join(root, "runtime-bin", "nono"));
	const offlinePython = installOfflinePython(root, python);
	recordOfflineUnshareIdentity(root, unshare);
	recordOfflineNonoIdentity(root, nono);
	if (logOutput) for (const [name, bytes] of Object.entries(logOutput)) {
		fs.writeFileSync(path.join(root, `expected-${name}.bin`), bytes);
	}
	// This fixed executable writes immediately. Stdin EOF cannot conceal an
	// unauthorized external execution. No provider or OS isolation is used.
	fs.writeFileSync(worker, `#!${process.execPath}
const fs=require('node:fs'), path=require('node:path'), logOutput=${JSON.stringify(!!logOutput)};
fs.writeFileSync(${JSON.stringify(marker)},'external execution');
process.on('SIGTERM',()=>{}); if(!logOutput)process.stdout.write('output');
let input=''; process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{
 if (!input) {setInterval(()=>{},1000);return;}
 const request=JSON.parse(input);
 const state=path.join(request.snapshot,'.swival','audit','abc12345');fs.mkdirSync(state,{recursive:true});
 fs.writeFileSync(path.join(state,'state.json'),'partial state');
 const findings=path.join(request.snapshot,'audit-findings');fs.mkdirSync(findings);
 fs.writeFileSync(path.join(findings,'001-test.md'),'partial report');fs.writeFileSync(path.join(findings,'001-test.patch'),'partial patch');
 if (['disconnect-running','completion','both-terminal'].includes(${JSON.stringify(failure)})) {
  const {spawn}=require('node:child_process');
  const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],
   {stdio:['ignore','inherit','inherit','ipc']});
  descendant.once('message',()=>fs.writeFileSync(${JSON.stringify(requestFile)},'request'));
 } else fs.writeFileSync(${JSON.stringify(requestFile)},'request');
 if (logOutput) {
  process.stdout.write(
   fs.readFileSync(path.join(${JSON.stringify(root)},'expected-stdout.bin')),()=>{
    process.stderr.write(
     fs.readFileSync(path.join(${JSON.stringify(root)},'expected-stderr.bin')),()=>process.exit(0));
   });return;
 }
 if (${JSON.stringify(failure)}==='leader-exit') {
  const {spawn}=require('node:child_process');
  const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],
   {stdio:['ignore','inherit','inherit','ipc']});
  descendant.once('message',()=>process.exit(0));return;
 }
 if (['output-close','disconnect-finalizing'].includes(${JSON.stringify(failure)})) {process.exit(0);return;}
 setInterval(()=>{},1000);
});`, { mode: 0o755 });
	// Log fixtures test successful draining or injected I/O faults, not the audit
	// deadline. A 1s budget preempted fault delivery under full-suite Node 24 load.
	// Keep ownership, cancellation, and deadline fixtures on their original budget.
	const timeoutMs = logOutput ? 2000 : 1000;
	fs.writeFileSync(path.join(root, "request.json"), JSON.stringify({ snapshot: path.join(root, "snapshot"),
		evidence: path.join(root, "evidence"), sandbox: "bubblewrap", unshare, bwrap: worker, nono,
		bwrapIdentity: nativeOfflineBwrapIdentity, unshareIdentity: nativeOfflineUnshareIdentity,
		nonoIdentity: nativeOfflineNonoIdentity(nono),
		runtimePath: [path.join(root, "runtime-bin"), process.env.PATH].join(path.delimiter),
		python: offlinePython, timeoutMs }));
	if (failure.endsWith("-open")) fs.mkdirSync(path.join(root, failure === "stdout-open" ? "stdout.txt" : "stderr.txt"));
	if (failure === "completion") fs.mkdirSync(path.join(root, "completed.json"));
	if (failure === "both-terminal") for (const name of ["completed.json", "spawn-error.txt"]) fs.mkdirSync(path.join(root, name));
	if (failure === "session-collision") { fs.mkdirSync(sessionDir, { recursive: true }); fs.writeFileSync(path.join(sessionDir, "keep"), "existing"); }
	const preload = path.join(root, "fault.cjs");
	fs.writeFileSync(preload, `const fs=require('node:fs'), cp=require('node:child_process');
const mode=${JSON.stringify(failure)}, spawn=cp.spawn;
cp.spawn=(...args)=>{const child=spawn(...args);
 if(mode==='crash-before-notify') {process.send({type:'test-launcher',pid:child.pid});process.kill(process.pid,'SIGKILL');}
 if(mode==='disconnect-after-ack') {const end=child.stdin.end.bind(child.stdin);child.stdin.end=(...values)=>{process.disconnect();return end(...values);};}
 if(mode==='disconnect-commit') {const pipe=child.stdio[3],end=pipe?.end.bind(pipe);if(pipe)pipe.end=(...values)=>{process.disconnect();return end(...values);};}
 return child;};
const close=fs.closeSync,open=fs.openSync,write=fs.writeSync,link=fs.linkSync;let once=true;const logs=new Set();
const fault=/^(stdout|stderr)-(partial-)?(zero|throw)-write$/.exec(mode);
let faultFd,partialWritten=false;
fs.openSync=(file,...args)=>{const fd=open(file,...args);
 if(/(?:stdout|stderr)\\.txt$/.test(String(file)))logs.add(fd);
 if(fault&&String(file).endsWith(fault[1]+'.txt'))faultFd=fd;return fd;};
if(mode==='output'||fault||mode.startsWith('short-write'))fs.writeSync=(fd,buffer,...args)=>{
 if(!logs.has(fd))return write(fd,buffer,...args);
 if(mode==='output')throw new Error('test ENOSPC');
 if(fault&&fd===faultFd){
  if(fault[2]&&!partialWritten){partialWritten=true;return write(fd,buffer.subarray(0,7));}
  if(fault[3]==='zero')return 0;
  throw new Error('test ENOSPC');
 }
 if(mode.startsWith('short-write')){
  const count=Math.min(4093,Math.max(1,Math.floor(buffer.length/2)));
  return write(fd,buffer.subarray(0,count));
 }
 return write(fd,buffer,...args);
};
fs.closeSync=(fd)=>{const log=logs.delete(fd);close(fd);if(mode==='output-close'&&once&&log){once=false;throw new Error('test close EIO');}};
if(mode==='disconnect-finalizing')fs.linkSync=(...args)=>{if(process.connected)process.disconnect();return link(...args);};
`);
	return { root, marker, requestFile, sessionDir, preload };
}

async function execute(f: ReturnType<typeof fixture>, failure: string) {
	const began = Date.now();
	const proc = spawn(process.execPath, ["--require", f.preload, runner, f.root], {
		env: { ...process.env, HOME: f.root }, detached: true, shell: false,
		stdio: failure === "no-ipc" ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", "ipc"],
	}); children.push(proc);
	let launcherPid: number | undefined; let ready = false;
	let output = "";
	for (const stream of [proc.stdout, proc.stderr]) stream?.on("data", (chunk) => {
		output += chunk; if (output.length > 65536) proc.kill("SIGKILL");
	});
	proc.on("message", (message: any) => {
		if (["native-child", "test-launcher"].includes(message.type)) {
			launcherPid = message.pid; liveGroups.push(message.pid);
			if (message.type === "test-launcher") return;
			if (failure === "disconnect-before-ack") proc.disconnect();
			else if (failure !== "missing-ack") proc.send({ type: "native-child-owned",
				pid: failure === "invalid-ack" ? 0 : message.pid });
		} else if (message.type === "native-started") {
			ready = true;
			if (["disconnect-running", "completion", "both-terminal"].includes(failure)) {
				void (async () => {
					for (let tries = 0; tries < 100 && !fs.existsSync(f.requestFile); tries++) await wait(10);
					if (proc.connected) proc.disconnect();
				})();
			}
		}
	});
	const code = await new Promise<number | null>((resolve, reject) => {
		const timeout = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error(`Wrapper timeout: ${output}`)); }, 8000);
		proc.once("error", reject);
		proc.once("exit", (exit) => { clearTimeout(timeout); proc.stdout?.destroy(); proc.stderr?.destroy(); resolve(exit); });
	});
	// Capture terminal and launch evidence before afterEach removes the fixture.
	const diagnostics = JSON.stringify({ code, elapsedMs: Date.now() - began, ready, output,
		terminal: readNativeTerminal(f.root), externalExecuted: fs.existsSync(f.marker),
		requestReceived: fs.existsSync(f.requestFile) });
	return { code, launcherPid, ready, output, diagnostics };
}

// Real wrappers, trusted Python bootstrap, live IPC, and real process groups.
// Fixed transport executables are not proof of bubblewrap isolation or providers.
describe("native-audit-runner short log writes", () => {
	const expected = {
		stdout: Buffer.from("stdout: \0雪🙂\n".repeat(40)),
		stderr: Buffer.from("stderr: \0éλ\n".repeat(40)),
	};
	it("drains short positive writes to byte-identical stdout and stderr", async () => {
		const f = fixture("short-write", expected); const result = await execute(f, "short-write");
		expect(result.code, result.diagnostics).toBe(0);
		expect(readNativeTerminal(f.root)?.exitCode, result.diagnostics).toBe(0);
		for (const name of ["stdout", "stderr"] as const) {
			const actual = fs.readFileSync(path.join(f.root, `${name}.txt`));
			expect(actual.equals(expected[name])).toBe(true);
		}
	});

	it.each([0, 1])("accounts short writes at the combined cap plus %i bytes", async (excess) => {
		const logOutput = {
			stdout: Buffer.alloc(1024 * 1024, 0x53),
			stderr: Buffer.alloc(1024 * 1024 + excess, 0x45),
		};
		const f = fixture("short-write-cap", logOutput);
		const result = await execute(f, "short-write-cap");
		const terminal = readNativeTerminal(f.root);
		expect(result.code, result.output).toBe(excess ? 1 : 0);
		expect(terminal?.exitCode).toBe(excess ? 1 : 0);
		expect(terminal?.stopped).toBe(
			excess ? "Native output exceeded the 2 MiB combined cap." : undefined,
		);
		const stdout = fs.readFileSync(path.join(f.root, "stdout.txt"));
		const stderr = fs.readFileSync(path.join(f.root, "stderr.txt"));
		expect(stdout.length + stderr.length).toBe(2 * 1024 * 1024);
		expect(stdout.length).toBeGreaterThan(0); expect(stderr.length).toBeGreaterThan(0);
		expect(stdout.equals(logOutput.stdout.subarray(0, stdout.length))).toBe(true);
		expect(stderr.equals(logOutput.stderr.subarray(0, stderr.length))).toBe(true);
	});

	it.each(["stdout", "stderr"].flatMap((stream) =>
		["zero-write", "throw-write", "partial-zero-write", "partial-throw-write"].map(
			(fault) => `${stream}-${fault}`,
		),
	))(
		"fails durably and preserves native evidence after %s", async (failure) => {
			const f = fixture(failure, expected); const result = await execute(f, failure);
			expect(result.code, result.output).toBe(1);
			const terminal = readNativeTerminal(f.root);
			expect(terminal, result.output).toBeDefined();
			expect(terminal?.exitCode).toBe(1);
			expect(terminal?.stopped, result.diagnostics).toBe("Native runner I/O failed.");
			expect(terminal?.shutdown).toBe("verified");
			expect(result.launcherPid).toBeGreaterThan(1);
			expect(() => process.kill(-result.launcherPid!, 0)).toThrow();
			const stream = failure.startsWith("stdout-") ? "stdout" : "stderr";
			const prefix = failure.includes("-partial-")
				? expected[stream].subarray(0, 7) : Buffer.alloc(0);
			expect(fs.readFileSync(path.join(f.root, `${stream}.txt`)).equals(prefix)).toBe(true);
			const state = path.join(f.root, "evidence", "native-state", "abc12345", "state.json");
			expect(fs.readFileSync(state, "utf8")).toBe("partial state");
			for (const [name, text] of [
				["001-test.md", "partial report"], ["001-test.patch", "partial patch"],
			]) {
				const finding = path.join(f.root, "evidence", "audit-findings", name);
				expect(fs.readFileSync(finding, "utf8")).toBe(text);
			}
			for (const name of ["snapshot", "runtime-bin", "sandbox"]) {
				expect(fs.existsSync(path.join(f.root, name))).toBe(false);
			}
			expect(fs.existsSync(f.sessionDir)).toBe(false);
		},
	);
});

describe("native-audit-runner ownership and disconnected finalization", () => {
	it("cannot execute bubblewrap if the real wrapper dies before ownership notification", async () => {
		const f = fixture("crash-before-notify"); const result = await execute(f, "crash-before-notify");
		await wait(200);
		expect(result.launcherPid).toBeGreaterThan(1);
		expect(fs.existsSync(f.marker)).toBe(false); expect(fs.existsSync(f.requestFile)).toBe(false);
		for (let tries = 0; tries < 120; tries++) {
			try { process.kill(-result.launcherPid!, 0); } catch { break; }
			await wait(50);
		}
		expect(() => process.kill(-result.launcherPid!, 0)).toThrow();
	}, 10000);

	it.each(["stdout-open", "stderr-open", "output", "output-close", "completion", "both-terminal",
		"missing-ack", "invalid-ack", "disconnect-before-ack", "disconnect-after-ack", "disconnect-commit",
		"disconnect-running", "disconnect-finalizing", "leader-exit", "no-ipc"])(
		"establishes shutdown and terminal failure after %s without disk-derived signalling", async (failure) => {
			const f = fixture(failure); const result = await execute(f, failure);
			expect(result.code, result.output).not.toBe(0);
			if (result.launcherPid) expect(() => process.kill(-result.launcherPid!, 0)).toThrow();
			for (const name of ["snapshot", "runtime-bin", "sandbox"]) expect(fs.existsSync(path.join(f.root, name))).toBe(failure === "disconnect-commit");
			if (failure === "session-collision") expect(fs.readFileSync(path.join(f.sessionDir, "keep"), "utf8")).toBe("existing");
			else expect(fs.existsSync(f.sessionDir)).toBe(false);
			const term = readNativeTerminal(f.root);
			if (failure === "both-terminal") {
				expect(term).toBeUndefined(); expect(result.output).toMatch(/terminal.*could not be persisted/i);
			} else {
				expect(term, result.output).toBeDefined(); expect(term!.exitCode).not.toBe(0);
				expect(term!.shutdown).toBe(failure === "disconnect-commit" ? "unverified" : result.launcherPid || failure === "no-ipc" ? "verified" : "not-started");
			}
			if (["missing-ack", "invalid-ack", "disconnect-before-ack", "disconnect-after-ack", "no-ipc"].includes(failure)) {
				expect(result.ready).toBe(false); expect(fs.existsSync(f.marker)).toBe(false); expect(fs.existsSync(f.requestFile)).toBe(false);
			}
			if (["disconnect-running", "disconnect-finalizing", "completion", "both-terminal", "leader-exit"].includes(failure)) {
				expect(fs.existsSync(f.requestFile)).toBe(true);
				expect(fs.readFileSync(path.join(f.root, "evidence", "native-state", "abc12345", "state.json"), "utf8")).toBe("partial state");
				for (const [name, text] of [["001-test.md", "partial report"], ["001-test.patch", "partial patch"]]) {
					expect(fs.readFileSync(path.join(f.root, "evidence", "audit-findings", name), "utf8")).toBe(text);
				}
			}
			if (failure === "completion") expect(term!.persistenceFailure).toMatch(/completion/);
		}, 12000,
	);
});

it("leaves a colliding legacy AgentFS session untouched in bubblewrap mode", async () => {
 const f = fixture("session-collision"); const result = await execute(f, "session-collision");
 expect(result.code).not.toBe(0);
 expect(fs.readFileSync(path.join(f.sessionDir,"keep"),"utf8")).toBe("existing");
});
