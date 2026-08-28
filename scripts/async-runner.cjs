#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const [artifactDir, ...swivalArgs] = process.argv.slice(2);
if (!artifactDir) {
	process.stderr.write("async-runner: artifact directory is required\n");
	process.exit(2);
}

function writeAtomic(name, content) {
	const target = path.join(artifactDir, name);
	const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(temporary, content, "utf-8");
	fs.renameSync(temporary, target);
}

let finished = false;
function finish(exitCode, spawnError) {
	if (finished) return;
	finished = true;
	if (spawnError) {
		writeAtomic("spawn-error.txt", `swival failed to start: ${spawnError.message}`);
	}
	writeAtomic("completed.json", JSON.stringify({
		exitCode,
		exitedAt: new Date().toISOString(),
	}, null, 2));
	process.exitCode = exitCode ?? 127;
}

const child = spawn("swival", swivalArgs, {
	stdio: "inherit",
});

child.once("error", (error) => {
	finish(null, error);
});
child.once("close", (code, signal) => {
	const signalExit = signal === "SIGKILL" ? 137 : signal === "SIGTERM" ? 143 : 1;
	finish(code ?? signalExit);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		try { child.kill(signal); } catch { /* child already exited */ }
	});
}
