#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { assertOutputCwd, commitOutputFile, discardOutputFile, readOutputConfig } = require("./output-file.cjs");

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const INPUT_TIMEOUT_MS = 10000;
let binding;
let finished = false;
let inputTimer;

function reply(message) {
	fs.writeSync(1, `${JSON.stringify(message)}\n`);
}

function fail(message) {
	if (finished) return;
	finished = true;
	clearTimeout(inputTimer);
	discardOutputFile(binding, true);
	try { reply({ status: "error", error: String(message).slice(0, 2048) }); } catch { /* runner disconnected */ }
	process.stdin.destroy();
	process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => fail("output committer cancelled"));
try {
	binding = readOutputConfig(4).binding;
	fs.closeSync(4);
	// Only this held kernel cwd and the inherited temporary fd authorize writes.
	assertOutputCwd(binding);
	reply({ status: "ready" });
} catch (error) {
	fail(error.message);
}

if (!finished) {
	// Fixed binary protocol: operation 0 discards; operation 1 commits a UTF-8
	// body. A complete five-byte header and exact body must precede input EOF.
	// No destination, executable, or command is accepted from the runner pipe.
	const header = Buffer.alloc(5);
	let headerBytes = 0;
	let expectedBytes;
	let bodyBytes = 0;
	const chunks = [];
	process.stdin.on("error", () => fail("output committer input failed"));
	process.stdin.on("data", (chunk) => {
		if (finished) return;
		if (!inputTimer) inputTimer = setTimeout(() => fail("output committer input timed out"), INPUT_TIMEOUT_MS);
		if (headerBytes < header.length) {
			const count = Math.min(header.length - headerBytes, chunk.length);
			chunk.copy(header, headerBytes, 0, count);
			headerBytes += count;
			chunk = chunk.subarray(count);
			if (headerBytes < header.length) return;
			expectedBytes = header.readUInt32BE(1);
			if (![0, 1].includes(header[0]) || expectedBytes > MAX_BODY_BYTES || (header[0] === 0 && expectedBytes !== 0)) {
				fail("invalid output committer input header");
				return;
			}
		}
		bodyBytes += chunk.length;
		if (bodyBytes > expectedBytes) { fail("output committer input has trailing bytes"); return; }
		chunks.push(chunk);
	});
	process.stdin.on("end", () => {
		if (finished) return;
		if (headerBytes !== header.length || bodyBytes !== expectedBytes) {
			fail("output committer disconnected with incomplete input");
			return;
		}
		clearTimeout(inputTimer);
		try {
			let result;
			if (header[0] === 0) {
				discardOutputFile(binding, true);
				result = { status: "discarded" };
			} else {
				const bytes = Buffer.concat(chunks, bodyBytes);
				const body = bytes.toString("utf8");
				if (!Buffer.from(body, "utf8").equals(bytes)) throw new Error("output body is not valid UTF-8");
				result = { status: "written", ...commitOutputFile(binding, body, true) };
			}
			reply(result);
			finished = true;
		} catch (error) { fail(error.message); }
	});
}
