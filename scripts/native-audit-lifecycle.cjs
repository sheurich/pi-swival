"use strict";

// Native-only finalization. Callers supply live signalling authority; no PID is
// ever read from an artifact, and this module never creates a process.
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fileLimit = 8 * 1024 * 1024;
const totalLimit = 64 * 1024 * 1024;
const entryLimit = 4096;
const terminalLimit = 64 * 1024;
const diagnostics = ["stopped", "shutdownFailure", "preservationFailure", "cleanupFailure", "persistenceFailure"];

function checkedPath(root, target) {
	const anchor = path.resolve(root);
	const relative = path.relative(anchor, path.resolve(target));
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error("Uncontained native evidence.");
	}
	let current = anchor;
	for (const component of ["", ...relative.split(path.sep).filter(Boolean)]) {
		current = path.join(current, component);
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink()) throw new Error("Symlinked native evidence.");
		if (current !== path.resolve(target) && !stat.isDirectory()) throw new Error("Unsafe native evidence ancestor.");
	}
	return fs.lstatSync(target);
}

function regularBytes(root, target, limit) {
	const stat = checkedPath(root, target);
	if (!stat.isFile() || stat.size > limit) throw new Error("Unsupported or oversized native evidence.");
	const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const opened = fs.fstatSync(fd);
		if (!opened.isFile() || opened.size > limit || opened.ino !== stat.ino || opened.dev !== stat.dev) {
			throw new Error("Native evidence changed during open.");
		}
		const bytes = Buffer.alloc(opened.size);
		let offset = 0;
		while (offset < bytes.length) {
			const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
			if (!count) throw new Error("Native evidence changed during read.");
			offset += count;
		}
		return bytes;
	} finally { fs.closeSync(fd); }
}

function immutable(record) {
	if (record.retainedResources) Object.freeze(record.retainedResources);
	return Object.freeze(record);
}
function validTerminal(value, fallback) {
	if (!value || typeof value !== "object" || Array.isArray(value) ||
		!Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255 ||
		typeof value.exitedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.exitedAt) ||
		!Number.isFinite(Date.parse(value.exitedAt)) ||
		!["not-started", "verified", "unverified"].includes(value.shutdown)) return false;
	if (value.boundary !== undefined && value.boundary !== "bubblewrap-pidfd") return false;
	const keys = new Set(["exitCode", "exitedAt", "shutdown", "boundary", "retainedResources", ...diagnostics]);
	if (Object.keys(value).some((key) => !keys.has(key))) return false;
	if (diagnostics.some((key) => value[key] !== undefined &&
		(typeof value[key] !== "string" || !value[key] || value[key].length > 8192))) return false;
	if (value.retainedResources !== undefined && (!Array.isArray(value.retainedResources) ||
		value.retainedResources.length > entryLimit || value.retainedResources.some((item) =>
			typeof item !== "string" || !path.isAbsolute(item) || item.length > 4096))) return false;
	if (value.exitCode === 0 && (fallback || value.shutdown !== "verified" ||
		diagnostics.some((key) => value[key]) || value.retainedResources?.length)) return false;
	return true;
}

function readNativeTerminal(runDir) {
	for (const [name, fallback] of [["completed.json", false], ["spawn-error.txt", true]]) {
		try {
			const target = path.join(runDir, name);
			const text = regularBytes(runDir, target, terminalLimit).toString("utf8");
			let value;
			try { value = JSON.parse(text); }
			catch {
				// Legacy text is failure-only. Malformed structured records must not
				// become legacy failures or attest that execution stopped.
				if (!fallback || !text.trim() || /^[\s]*[\[{]/.test(text)) continue;
				return immutable({ exitCode: 1, exitedAt: fs.lstatSync(target).mtime.toISOString(),
					shutdown: "unverified", stopped: text.slice(0, 8192) });
			}
			if (validTerminal(value, fallback)) return immutable(value);
		} catch { /* Missing, unsafe, unreadable, and malformed records grant no authority. */ }
	}
	return undefined;
}

async function shutdownGroup(ownership) {
	const absent = () => {
		try { ownership.signal(0); return false; }
		catch (error) { return error.code === "ESRCH"; }
	};
	if (absent()) return { shutdown: "verified", wasAlive: false };
	try { ownership.signal("SIGTERM"); } catch { /* Only a later ESRCH probe proves absence. */ }
	for (let attempt = 0; attempt < 20; attempt++) {
		if (absent()) return { shutdown: "verified", wasAlive: true };
		await delay(50);
	}
	try { ownership.signal("SIGKILL"); } catch { /* Do not treat EPERM as shutdown. */ }
	for (let attempt = 0; attempt < 20; attempt++) {
		if (absent()) return { shutdown: "verified", wasAlive: true };
		await delay(50);
	}
	return { shutdown: absent() ? "verified" : "unverified", wasAlive: true };
}

function ensureDirectory(root, target) {
	if (target !== path.resolve(root)) ensureDirectory(root, path.dirname(target));
	try {
		if (!checkedPath(root, target).isDirectory()) throw new Error("Unsafe native evidence directory.");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		fs.mkdirSync(target, { mode: 0o700 });
		if (!checkedPath(root, target).isDirectory()) throw new Error("Unsafe native evidence directory.");
	}
}
function temporary(target) { return `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`; }
function exclusiveWrite(target, bytes) {
	fs.writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
}
function accountRetained(target, size, budget) {
	if (budget.paths.has(target)) return;
	scanned(budget);
	budget.bytes += size;
	if (budget.bytes > totalLimit) throw new Error("Native evidence byte limit.");
	budget.paths.add(target);
}
function publishEvidence(runDir, source, target, budget) {
	const bytes = regularBytes(runDir, source, fileLimit);
	try {
		const existing = regularBytes(runDir, target, fileLimit);
		if (!existing.equals(bytes)) throw new Error("Conflicting retained native evidence.");
		accountRetained(target, existing.length, budget);
		return;
	} catch (error) { if (error.code !== "ENOENT") throw error; }
	// Charge the destination union, including new directories. Matching retry
	// files are already charged by the retained-tree scan, never twice.
	accountRetained(target, bytes.length, budget);
	let parent = path.dirname(target);
	const evidence = path.join(runDir, "evidence");
	while (parent !== evidence) {
		accountRetained(parent, 0, budget);
		parent = path.dirname(parent);
	}
	ensureDirectory(runDir, path.dirname(target));
	const temp = temporary(target);
	try {
		exclusiveWrite(temp, bytes);
		// link is exclusive: a retry cannot overwrite a conflicting destination.
		fs.linkSync(temp, target);
	} finally {
		if (fs.existsSync(temp)) fs.unlinkSync(temp);
	}
}
function scanned(budget) {
	if (++budget.entries > entryLimit) throw new Error("Native evidence entry limit.");
}
function scanDirectory(runDir, directory, budget, visit) {
	let stat;
	try { stat = checkedPath(runDir, directory); }
	catch (error) { if (error.code === "ENOENT") return; throw error; }
	if (!stat.isDirectory()) throw new Error("Unsupported native evidence directory.");
	const entries = fs.opendirSync(directory);
	try {
		let entry;
		while ((entry = entries.readSync()) !== null) {
			scanned(budget);
			visit(entry.name);
		}
	} finally { entries.closeSync(); }
}
function preserveEvidence(runDir) {
	const snapshot = path.join(runDir, "snapshot");
	const evidence = path.join(runDir, "evidence");
	const budget = { entries: 0, bytes: 0, paths: new Set() };
	const retainedScan = { entries: 0 };
	const retained = (directory) => scanDirectory(runDir, directory, retainedScan, (name) => {
		const target = path.join(directory, name);
		const stat = checkedPath(runDir, target);
		if (stat.isDirectory()) {
			accountRetained(target, 0, budget);
			retained(target);
		} else {
			if (!stat.isFile() || stat.size > fileLimit) throw new Error("Unsupported retained native evidence.");
			accountRetained(target, stat.size, budget);
		}
	});
	// Every retained entry counts, including unmatched files in export namespaces.
	retained(evidence);
	// Bound source traversal independently from the logical destination union.
	const sourceScan = { entries: 0 };
	const states = path.join(snapshot, ".swival", "audit");
	scanDirectory(runDir, states, sourceScan, (name) => {
		if (!/^[a-f0-9]{8}$/.test(name)) return;
		const source = path.join(states, name, "state.json");
		scanned(sourceScan);
		publishEvidence(runDir, source, path.join(evidence, "native-state", name, "state.json"), budget);
	});
	const findings = (source, target) => scanDirectory(runDir, source, sourceScan, (name) => {
		const file = path.join(source, name);
		const stat = checkedPath(runDir, file);
		if (stat.isDirectory()) findings(file, path.join(target, name));
		else {
			if (!stat.isFile()) throw new Error("Nonregular native evidence.");
			if (/\.(?:md|patch)$/.test(name)) publishEvidence(runDir, file, path.join(target, name), budget);
		}
	});
	findings(path.join(snapshot, "audit-findings"), path.join(evidence, "audit-findings"));
}
function atomicTerminal(runDir, name, record) {
	checkedPath(runDir, runDir);
	const target = path.join(runDir, name);
	const temp = temporary(target);
	try {
		exclusiveWrite(temp, JSON.stringify(record, null, 2));
		fs.renameSync(temp, target);
	} finally {
		if (fs.existsSync(temp)) fs.unlinkSync(temp);
	}
}

async function finalizeNativeAudit(options, outcome) {
	const { runDir, ownership, closeLogs, startupBarrier, cancellationReason } = options;
	const existing = readNativeTerminal(runDir);
	if (existing && (existing.shutdown !== "unverified" || !ownership)) return existing;
	const record = { exitCode: outcome.exitCode ?? 1, exitedAt: new Date().toISOString(),
		...(existing ?? {}), ...outcome };
	delete record.shutdownFailure;
	if (ownership) {
		const stopped = await shutdownGroup(ownership);
		record.shutdown = stopped.shutdown;
		if (stopped.wasAlive && !record.stopped) record.stopped = "Native process left running descendants.";
	} else {
		// No ownership acknowledgement means no external execution was
		// authorized. The trusted bootstrap has a finite commit deadline.
		if (startupBarrier) await startupBarrier();
		record.shutdown = "not-started";
	}
	if (closeLogs) {
		try { await closeLogs(record.shutdown); }
		catch { record.cleanupFailure = [record.cleanupFailure, "Native runner log I/O failed."].filter(Boolean).join(" "); }
	}
	let namespaceRequired = !!ownership?.verify;
	try {
		namespaceRequired ||= JSON.parse(regularBytes(runDir, path.join(runDir, "request.json"), terminalLimit)).sandbox === "bubblewrap";
	} catch { /* Legacy records gain no new live namespace authority. */ }
	if (ownership && namespaceRequired) {
		let verified = false;
		try { verified = await ownership.verify?.() === true; } catch { /* Retain on lost proof. */ }
		if (!verified) record.shutdown = "unverified";
		else if (record.shutdown === "verified") record.boundary = "bubblewrap-pidfd";
	}
	const retained = [];
	const snapshot = path.join(runDir, "snapshot");
	if (record.shutdown === "unverified") {
		record.shutdownFailure = "Native namespace/process shutdown could not be verified.";
		for (const name of ["snapshot", "runtime-bin", "sandbox"]) retained.push(path.join(runDir, name));
	} else {
		try { preserveEvidence(runDir); }
		catch { record.preservationFailure = "Native evidence preservation failed or exceeded resource limits."; }
		const removable = [path.join(runDir, "runtime-bin"), path.join(runDir, "sandbox")];
		if (record.preservationFailure) retained.push(snapshot);
		else removable.unshift(snapshot);
		for (const target of removable) {
			try {
				// Remove only run-scoped resources, never legacy AgentFS sessions.
				if (fs.existsSync(target)) checkedPath(runDir, path.dirname(target));
				fs.rmSync(target, { recursive: true, force: true });
			} catch {
				record.cleanupFailure = [record.cleanupFailure, "Owned native temporary-resource cleanup failed."].filter(Boolean).join(" ");
				retained.push(target);
			}
		}
	}
	delete record.retainedResources;
	if (retained.length) record.retainedResources = retained;
	if (cancellationReason) record.stopped ??= cancellationReason();
	if (record.shutdown !== "verified" || diagnostics.some((key) => record[key])) record.exitCode ||= 1;
	if (!validTerminal(record, false)) throw new Error("Invalid native terminal outcome.");
	try {
		atomicTerminal(runDir, "completed.json", record);
		return immutable(record);
	} catch {
		const fallback = immutable({ ...record, exitCode: record.exitCode || 1,
			persistenceFailure: "Native completion marker could not be persisted." });
		try { atomicTerminal(runDir, "spawn-error.txt", fallback); return fallback; }
		catch {
			throw new Error(`Native terminal failure evidence could not be persisted. Artifacts: ${runDir}.`);
		}
	}
}

module.exports = { finalizeNativeAudit, readNativeTerminal };
