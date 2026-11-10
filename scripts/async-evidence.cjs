"use strict";

// Host-only evidence transfer. Scratch contents are sandbox-influenced data;
// only the fixed report and bounded, basename-only trace files can cross back.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const REPORT_LIMIT = 16 * 1024 * 1024;
const TRACE_LIMIT = 4 * 1024 * 1024;
const TOTAL_LIMIT = 64 * 1024 * 1024;
const TRACE_FILES = 16;
const TRACE_NAME = /^[A-Za-z0-9_-]{1,80}\.jsonl$/;
const fail = (code) => { throw new Error(code); };
const uid = () => typeof process.getuid === "function" ? process.getuid() : fail("ownership_unavailable");

function directoryIdentity(directory) {
	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid()) fail("unsafe_directory");
	return { path: directory, dev: stat.dev, ino: stat.ino };
}
function checkIdentity(identity) {
	const current = directoryIdentity(identity.path);
	if (current.dev !== identity.dev || current.ino !== identity.ino) fail("directory_replaced");
	if (fs.realpathSync(identity.path) !== identity.path) fail("unsafe_directory");
}
function claimScratch(directory, requirePrivate = true) {
	const temporary = fs.realpathSync(os.tmpdir());
	if (typeof directory !== "string" || !path.isAbsolute(directory)
		|| path.resolve(directory) !== directory || path.dirname(directory) !== temporary
		|| !/^pi-swival-async-[A-Za-z0-9_-]+$/.test(path.basename(directory))) fail("unsafe_scratch");
	const identity = directoryIdentity(directory);
	checkIdentity(identity);
	if (requirePrivate && (fs.lstatSync(directory).mode & 0o077) !== 0) fail("unsafe_scratch");
	return identity;
}
function createScratch() {
	const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-swival-async-"));
	return claimScratch(directory);
}
function cleanupScratch(identity) {
	try {
		// Validate location as well as identity on every deletion. No arbitrary
		// argv path, renamed directory or symlink can opt into recursive removal.
		claimScratch(identity.path, false);
		checkIdentity(identity);
		fs.rmSync(identity.path, { recursive: true, force: true });
		return undefined;
	} catch (error) {
		return error.code === "ENOENT" ? undefined : "scratch_cleanup_failed";
	}
}
function regularBytes(directory, name, limit) {
	checkIdentity(directory);
	if (path.basename(name) !== name) fail("unsafe_name");
	const fd = fs.openSync(path.join(directory.path, name), fs.constants.O_RDONLY
		| fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		checkIdentity(directory);
		const before = fs.fstatSync(fd);
		if (!before.isFile() || before.uid !== uid() || before.nlink !== 1) fail("not_regular");
		if (before.size > limit) fail("too_large");
		const buffer = Buffer.alloc(Math.min(limit + 1, before.size + 1));
		let length = 0;
		while (length < buffer.length) {
			const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
			if (!count) break;
			length += count;
		}
		const after = fs.fstatSync(fd);
		if (length > limit || after.size > limit) fail("too_large");
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
			|| length !== after.size) fail("changed_during_read");
		checkIdentity(directory);
		return buffer.subarray(0, length);
	} finally { fs.closeSync(fd); }
}
function atomicWrite(directory, name, bytes) {
	checkIdentity(directory);
	if (path.basename(name) !== name) fail("unsafe_name");
	const temporary = path.join(directory.path, `.${name}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
	try {
		fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
		checkIdentity(directory);
		fs.renameSync(temporary, path.join(directory.path, name));
	} finally {
		try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
	}
}
function claimArtifacts(directory) {
	// Existing callers can use /var aliases for macOS temporary directories;
	// reject a leaf symlink, then retain the canonical owned directory identity.
	directoryIdentity(directory);
	return directoryIdentity(fs.realpathSync(directory));
}
function transferEvidence(scratch, artifacts) {
	// Worker-widened permissions make evidence untrusted, but do not revoke
	// the cleanup lease for the same owned directory.
	claimScratch(scratch.path);
	checkIdentity(scratch);
	const errors = [];
	let bytes = 0;
	try {
		checkIdentity(scratch);
		const report = regularBytes(scratch, "report.json", REPORT_LIMIT);
		atomicWrite(artifacts, "report.json", report);
		bytes += report.length;
	} catch {
		errors.push("report_transfer_failed");
		// This fixed evidence slot belongs to this run. Do not let a preexisting
		// report mask a failed transfer; unlink replaces no symlink target.
		try { checkIdentity(artifacts); fs.unlinkSync(path.join(artifacts.path, "report.json")); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
	}
	let entries;
	try {
		checkIdentity(scratch);
		const source = directoryIdentity(path.join(scratch.path, "trace"));
		checkIdentity(source);
		entries = fs.opendirSync(source.path);
		let count = 0;
		let destination;
		let entry;
		while ((entry = entries.readSync()) !== null) {
			if (++count > TRACE_FILES) { errors.push("trace_file_limit"); break; }
			if (!TRACE_NAME.test(entry.name)) { errors.push("trace_name_rejected"); continue; }
			try {
				checkIdentity(scratch);
				const trace = regularBytes(source, entry.name, TRACE_LIMIT);
				if (bytes + trace.length > TOTAL_LIMIT) { errors.push("trace_byte_limit"); break; }
				if (!destination) {
					checkIdentity(artifacts);
					const target = path.join(artifacts.path, "trace");
					try { fs.mkdirSync(target, { mode: 0o700 }); }
					catch (error) { if (error.code !== "EEXIST") throw error; }
					destination = directoryIdentity(target);
				}
				atomicWrite(destination, entry.name, trace);
				bytes += trace.length;
			} catch { errors.push("trace_transfer_failed"); }
		}
	} catch (error) {
		if (error.code !== "ENOENT") errors.push("trace_directory_rejected");
	} finally { entries?.closeSync(); }
	return [...new Set(errors)];
}

module.exports = { createScratch, claimScratch, cleanupScratch, claimArtifacts, atomicWrite, transferEvidence };
