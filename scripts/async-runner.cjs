#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { claimScratch, cleanupScratch, claimArtifacts, atomicWrite, transferEvidence } = require("./async-evidence.cjs");

// Internal option only. Legacy [artifactDir, ...swivalArgs] remains supported.
const argv = process.argv.slice(2);
const scratchPath = argv[0] === "--scratch-dir" ? (argv.shift(), argv.shift()) : undefined;
const [artifactDir, ...swivalArgs] = argv;
let scratch;
let artifacts;
try {
	if (!artifactDir) throw new Error("missing artifact directory");
	artifacts = claimArtifacts(artifactDir);
	if (scratchPath !== undefined) scratch = claimScratch(scratchPath);
} catch {
	process.stderr.write("async-runner: invalid evidence directories\n");
	process.exit(2);
}

let finished = false;
function finish(exitCode, spawnError) {
	if (finished) return;
	finished = true;
	const errors = [];
	try {
		if (scratch) errors.push(...transferEvidence(scratch, artifacts));
	} catch {
		errors.push("evidence_transfer_failed");
		// Refuse stale/partial report evidence even if a host-side export failed.
		try { atomicWrite(artifacts, "report.json", ""); }
		catch { throw new Error("async-runner: evidence finalization failed"); }
	} finally {
		if (scratch) {
			const error = cleanupScratch(scratch);
			if (error) errors.push(error);
		}
	}
	if (errors.length) atomicWrite(artifacts, "transfer-error.txt", [...new Set(errors)].join("\n") + "\n");
	if (spawnError) atomicWrite(artifacts, "spawn-error.txt", `swival failed to start: ${spawnError.message}`);
	// Terminal visibility is last: never announce completion before exporting.
	atomicWrite(artifacts, "completed.json", JSON.stringify({
		exitCode,
		exitedAt: new Date().toISOString(),
	}, null, 2));
	process.exitCode = exitCode ?? 127;
}

const taskFile = path.join(artifactDir, "task.txt");
let stdinFd = "ignore";
const lastDashDash = swivalArgs.lastIndexOf("--");
const hasArgvTask = lastDashDash !== -1 && lastDashDash < swivalArgs.length - 1;
if (!hasArgvTask) {
	try { stdinFd = fs.openSync(taskFile, "r"); }
	catch { /* No task file: stdin stays ignored. */ }
}

let child;
try {
	child = spawn("swival", swivalArgs, { stdio: [stdinFd, "inherit", "inherit"] });
} catch (error) {
	finish(null, error);
} finally {
	if (typeof stdinFd === "number") fs.closeSync(stdinFd);
}
if (child) {
	child.once("error", (error) => finish(null, error));
	child.once("close", (code, signal) => {
		const signalExit = signal === "SIGKILL" ? 137 : signal === "SIGTERM" ? 143 : 1;
		finish(code ?? signalExit);
	});
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => {
			try { child.kill(signal); } catch { /* Child already exited. */ }
		});
	}
}
