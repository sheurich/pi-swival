import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { installOfflinePython, nativeOfflineBwrapIdentity, nativeOfflineUnshareIdentity,
	recordOfflineUnshareIdentity } from "./nativeOfflinePython.js";
import { nativeTestPython as python } from "./nativePython.js";

const bridge = path.resolve(import.meta.dirname, "../scripts/native_audit.py");
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
	for (const child of children.splice(0)) if (child.pid) {
		try { process.kill(-child.pid, "SIGKILL"); } catch { /* retained live handle already exited */ }
	}
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-launch-"))); roots.push(root);
	const marker = path.join(root, "bwrap-marker");
	fs.writeFileSync(marker, `#!${python}
import json, os, sys
try:
    os.fstat(3)
    control_closed = False
except OSError:
    control_closed = True
print(json.dumps({'pid':os.getpid(),'pgid':os.getpgrp(),'controlClosed':control_closed,'args':sys.argv[1:]}), flush=True)
`, { mode: 0o755 });
	const unshare = path.join(root, "unshare");
	fs.writeFileSync(unshare, "#!/bin/sh\nexit 97\n", { mode: 0o755 });
	const selected = installOfflinePython(root, python);
	recordOfflineUnshareIdentity(root, unshare);
	const request = { unshare, bwrap: marker, bwrapIdentity: nativeOfflineBwrapIdentity,
		unshareIdentity: nativeOfflineUnshareIdentity,
		snapshot: root, evidence: root, python: selected };
	const child = spawn(selected, ["-I", "-B", bridge, "--launch", unshare, marker, root, root],
		{ detached: true, shell: false, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] }); children.push(child);
	const control = child.stdio[3] as Writable;
	let output = ""; let errors = "";
	child.stdout!.on("data", (chunk) => { output += chunk; });
	child.stderr!.on("data", (chunk) => { errors += chunk; });
	control.on("error", () => {}); child.stdin!.on("error", () => {});
	const exit = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
	return { child, control, exit, output: () => output, errors: () => errors, root, marker, request };
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("native_audit.py trusted executable commit gate", () => {
	it("does not execute a marker before commit, then replaces PID/PGID and closes control descriptors", async () => {
		const f = fixture();
		await wait(100); expect(f.output(), f.errors()).toBe("");
		f.child.stdin!.end(JSON.stringify(f.request));
		f.control.write("EXEC\n");
		await wait(100); expect(f.output(), "A token without EOF must not commit").toBe("");
		f.control.end();
		expect(await f.exit, f.errors()).toBe(0);
		const marker = JSON.parse(f.output());
		expect(marker.pid).toBe(f.child.pid); expect(marker.pgid).toBe(f.child.pid);
		expect(marker.controlClosed).toBe(true);
		expect(marker.args).toEqual(["--unshare-user", "--disable-userns", "--unshare-pid",
			"--unshare-ipc", "--die-with-parent", "--cap-drop", "ALL", "--ro-bind", "/", "/",
			"--tmpfs", "/tmp", "--tmpfs", "/var/tmp", "--dev", "/dev", "--proc", "/proc",
			"--bind", f.root, f.root, "--bind", f.root, f.root, "--chdir", f.root,
			"--", f.request.python, "-I", "-B", bridge, "--run"]);
	}, 5000);

	it("rejects unshare launcher-scope drift before external execution", async () => {
		const f = fixture();
		f.request.unshare = path.join(f.root, "alternate-unshare");
		f.child.stdin!.end(JSON.stringify(f.request));
		f.control.end("EXEC\n");
		expect(await f.exit, f.errors()).not.toBe(0);
		expect(f.output()).toBe("");
	});

	it.each(["eof", "partial", "malformed", "oversize", "timeout", "cancel-before-token", "cancel-before-eof"])(
		"does not execute bubblewrap after pre-commit %s", async (failure) => {
			const f = fixture();
			if (failure === "eof") f.control.end();
			if (failure === "partial") f.control.end("EXE");
			if (failure === "malformed") f.control.end("RUN!\n");
			if (failure === "oversize") f.control.end("EXEC\nX");
			if (failure === "cancel-before-eof") { f.control.write("EXEC\n"); await wait(100); }
			if (failure.startsWith("cancel")) f.child.kill("SIGTERM");
			const code = await f.exit;
			expect(code, f.errors()).not.toBe(0); expect(f.output()).toBe("");
		}, 7000,
	);
});
