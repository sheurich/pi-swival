#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { finalizeNativeAudit } = require("./native-audit-lifecycle.cjs");
const runDir = process.argv[2];
const request = JSON.parse(fs.readFileSync(path.join(runDir, "request.json"), "utf8"));
const bridge = path.join(__dirname, "native_audit.py");
const cap = 2 * 1024 * 1024;
const fds = [];
let bytes = 0;
let stopped;
let deadline;
let ownershipTimer;
let ownershipAcknowledged = false;
let commitAuthorized = false;
let namespaceVerified = false;
let proof = "";
let child;
let childClosed;
let finalization;

function cancellationReason() {
	return stopped ?? (!process.connected ? "Native ownership channel disconnected; audit cancelled." : undefined);
}
function stop(reason) {
	stopped ??= reason;
	// Closing the commit pipe before authorization prevents external execution.
	// Once committed, the shared finalizer stops the live owned group instead.
	child?.stdio[3]?.destroy();
	child?.stdin?.destroy();
	void finish(1);
}
const ioFailure = () => stop("Native runner I/O failed.");
async function closeLogs(shutdown) {
	if (child) {
		if (shutdown === "unverified") {
			child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
			child.unref();
		} else await childClosed;
	}
	let failed = false;
	for (const fd of fds.splice(0)) {
		try { fs.closeSync(fd); } catch { failed = true; }
	}
	if (failed) throw new Error("Native log close failed.");
}
function finish(code) {
	if (finalization) return finalization;
	clearTimeout(deadline);
	clearTimeout(ownershipTimer);
	if (child?.pid && !commitAuthorized && process.connected) {
		process.send({ type: "native-not-started", pid: child.pid }, () => {});
	}
	finalization = finalizeNativeAudit({ runDir,
		ownership: child?.pid ? { signal: (signal) => process.kill(-child.pid, signal),
			verify: async () => namespaceVerified || !commitAuthorized } : undefined,
		closeLogs, cancellationReason,
	}, { exitCode: code, stopped }).then((terminal) => {
		process.exitCode = terminal.exitCode;
	}, () => {
		process.exitCode = 1;
		process.stderr.write(`Native terminal failure evidence could not be persisted. Artifacts: ${runDir}.\n`);
	}).finally(() => {
		process.removeListener("message", acknowledge);
		process.removeListener("disconnect", disconnected);
		for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, interrupted);
		if (process.connected) process.disconnect();
	});
	return finalization;
}
const interrupted = () => stop("Native audit was interrupted.");
const disconnected = () => stop("Native ownership channel disconnected; audit cancelled.");
function acknowledge(message) {
	if (!child?.pid || ownershipAcknowledged || !message || typeof message !== "object" || Array.isArray(message) ||
		Object.keys(message).sort().join(",") !== "pid,type" ||
		message.type !== "native-child-owned" || message.pid !== child.pid) {
		stop("Native child ownership acknowledgement was invalid.");
		return;
	}
	ownershipAcknowledged = true;
	clearTimeout(ownershipTimer);
	process.removeListener("message", acknowledge);
	if (cancellationReason()) { stop(cancellationReason()); return; }
	const input = JSON.stringify(request);
	if (Buffer.byteLength(input) > 64 * 1024) { stop("Native request exceeded its bounded protocol."); return; }
	child.stdin.end(input, () => {
		if (cancellationReason()) { stop(cancellationReason()); return; }
		commitAuthorized = true;
		child.stdio[3].end("EXEC\n", () => {
			if (cancellationReason()) stop(cancellationReason());
		});
	});
}

// These handlers remain active from before spawn through terminal persistence.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, interrupted);
process.on("disconnect", disconnected);
process.on("message", acknowledge);
try {
	{
		const env = { ...process.env, ...(request.runtimePath ? { PATH: request.runtimePath } : {}) };
		for (const name of Object.keys(env)) {
			if (name.startsWith("GIT_") || name.startsWith("PYTHON") ||
				["AGENTFS", "SWIVAL_AGENTFS_ACTIVE", "SWIVAL_AGENTFS_SESSION", "SWIVAL_AGENTFS_VERSION", "BASH_ENV", "ENV"].includes(name)) delete env[name];
		}
		Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1",
			GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_LFS_SKIP_SMUDGE: "1" });
		// Trusted Python waits for ownership ACK/EXEC/EOF, then uses the pinned
		// unshare-to-bubblewrap exec chain with init-pidfd proof outside the payload.
		for (const name of ["stdout.txt", "stderr.txt"]) fds.push(fs.openSync(path.join(runDir, name), "w", 0o600));
		child = spawn(request.python, ["-I", "-B", bridge, "--launch", request.unshare,
			request.bwrap, request.snapshot, request.evidence], {
			cwd: path.join(runDir, "sandbox"), env, shell: false, detached: true,
			stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
		});
		childClosed = new Promise((resolve) => child.once("close", resolve));
		let namespaceStarted = false;
		child.stdio[4].on("data", (chunk) => {
			proof += chunk.toString("ascii");
			if (proof.length > 64) { stop("Native namespace proof exceeded its bounded protocol."); return; }
			if (!namespaceStarted && proof.startsWith("STARTED\n")) {
				namespaceStarted = true;
				if (cancellationReason()) { stop(cancellationReason()); return; }
				process.send({ type: "native-started", pid: child.pid }, (error) => {
					if (error) stop("Native launch readiness notification failed.");
				});
			}
		});
		child.stdio[4].on("end", () => {
			namespaceVerified = proof === "STARTED\nVERIFIED\n" || proof === "VERIFIED\n" ||
				(!commitAuthorized && proof === "NOT_STARTED\n");
			if (namespaceVerified && process.connected) {
				process.send({ type: "native-namespace-stopped", pid: child.pid }, () => {});
			}
		});
		function collect(fd, chunk) {
			const remaining = Math.max(0, cap - bytes);
			try {
				const output = chunk.subarray(0, remaining);
				let offset = 0;
				while (offset < output.length) {
					const written = fs.writeSync(fd, output.subarray(offset));
					if (!written) { ioFailure(); return; }
					offset += written;
					bytes += written;
				}
			} catch { ioFailure(); return; }
			if (chunk.length > remaining) stop("Native output exceeded the 2 MiB combined cap.");
		}
		child.stdout.on("data", (chunk) => collect(fds[0], chunk));
		child.stderr.on("data", (chunk) => collect(fds[1], chunk));
		for (const stream of [child.stdin, child.stdout, child.stderr, child.stdio[3], child.stdio[4]]) stream.on("error", ioFailure);
		child.once("error", () => stop("Native sandbox failed to start."));
		// A descendant can hold stdio open after leader exit. Finalization must
		// establish group absence before awaiting log drain or copying evidence.
		child.once("exit", (code, signal) => { void finish(code ?? (signal === "SIGKILL" ? 137 : 143)); });
		deadline = setTimeout(() => stop(`Native audit timed out after ${request.timeoutMs}ms.`), request.timeoutMs);
		child.once("spawn", () => {
			if (cancellationReason() || typeof process.send !== "function") {
				stop(cancellationReason() ?? "Native child ownership channel is unavailable."); return;
			}
			ownershipTimer = setTimeout(() => stop("Native child ownership acknowledgement timed out."), 2000);
			process.send({ type: "native-child", pid: child.pid }, (error) => {
				if (error) stop("Native child ownership notification failed.");
			});
		});
	}
} catch { ioFailure(); }
