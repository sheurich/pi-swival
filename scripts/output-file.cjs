"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

function assertSafeDisplayPath(value, label) {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0") || /[\r\n]/.test(value)) {
		throw new Error(`${label} must be a non-empty path without control characters`);
	}
}

// Only immutable, root-owned macOS aliases may be canonicalized. A realpath
// alone would also authorize model-creatable user or project symlinks.
function canonicalizeSystemAlias(resolved) {
	if (process.platform !== "darwin") return resolved;
	const alias = path.parse(resolved).root + resolved.split(path.sep)[1];
	const destination = { "/var": "/private/var", "/tmp": "/private/tmp", "/etc": "/private/etc" }[alias];
	if (!destination) return resolved;
	const link = fs.lstatSync(alias);
	if (!link.isSymbolicLink()) return resolved;
	if (link.uid !== 0 || path.resolve(path.dirname(alias), fs.readlinkSync(alias)) !== destination) return resolved;
	for (const parent of ["/", "/private"]) {
		const stat = fs.lstatSync(parent);
		if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return resolved;
	}
	const stat = fs.lstatSync(destination);
	if (!stat.isDirectory() || stat.uid !== 0 ||
		((stat.mode & 0o022) !== 0 && !(alias === "/tmp" && (stat.mode & 0o1000) !== 0))) return resolved;
	return path.join(destination, path.relative(alias, resolved));
}

function findSymlinkInPath(resolved) {
	try {
		if (fs.lstatSync(resolved).isSymbolicLink()) return resolved;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	let current = path.dirname(resolved);
	while (current) {
		try {
			if (fs.lstatSync(current).isSymbolicLink()) return current;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
}

function assertSafeBasename(value) {
	assertSafeDisplayPath(value, "output basename");
	if (value === "." || value === ".." || /[/\\]/.test(value)) {
		throw new Error("output basename must not contain a directory component");
	}
}

function assertOutputTarget(target) {
	try {
		const stat = fs.lstatSync(target);
		if (stat.isSymbolicLink()) throw new Error(`refusing to write through existing symlink at ${target}`);
		if (!stat.isFile()) throw new Error("output target is not a regular file");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}

function validateBinding(binding) {
	if (!binding || !Number.isInteger(binding.fd) || binding.fd < 0) throw new Error("invalid output file descriptor");
	for (const [value, label] of [[binding.target, "output target"], [binding.outputPath, "output display path"],
		[binding.temporary, "output temporary path"], [binding.directory, "output directory"]]) {
		assertSafeDisplayPath(value, label);
		if (!path.isAbsolute(value)) throw new Error("output binding paths must be absolute");
	}
	assertSafeBasename(path.basename(binding.target));
	assertSafeBasename(path.basename(binding.temporary));
	if (path.dirname(binding.target) !== binding.directory || path.dirname(binding.temporary) !== binding.directory ||
		!path.basename(binding.temporary).startsWith(".tmp-output-")) {
		throw new Error("output temporary path is not bound to the target directory");
	}
	for (const identity of [binding.identity, binding.directoryIdentity]) {
		if (!identity || !Number.isSafeInteger(identity.dev) || !Number.isSafeInteger(identity.ino)) {
			throw new Error("invalid output binding identity");
		}
	}
}

function assertBoundDirectory(binding, includeTarget = true) {
	const symlink = findSymlinkInPath(includeTarget ? binding.target : binding.directory);
	if (symlink) throw new Error(`refusing to write through existing symlink at ${symlink}`);
	const stat = fs.lstatSync(binding.directory);
	if (!stat.isDirectory() || stat.dev !== binding.directoryIdentity.dev || stat.ino !== binding.directoryIdentity.ino) {
		throw new Error("output directory identity changed after authorization");
	}
}

// Only the dedicated output committer uses cwdBound. Its cwd is selected before
// hostile work starts and never changes. Lexical paths remain display checks,
// not the authority for output writes, rename, or cleanup in that process.
function outputPaths(binding, cwdBound) {
	validateBinding(binding);
	if (!cwdBound) return { target: binding.target, temporary: binding.temporary };
	const stat = fs.lstatSync(".");
	if (!stat.isDirectory() || stat.dev !== binding.directoryIdentity.dev || stat.ino !== binding.directoryIdentity.ino) {
		throw new Error("output directory identity changed before binding committer cwd");
	}
	return { target: path.basename(binding.target), temporary: path.basename(binding.temporary) };
}

function assertTemporaryIdentity(binding, temporary) {
	const descriptorStat = fs.fstatSync(binding.fd);
	const pathStat = fs.lstatSync(temporary);
	if (!descriptorStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink() ||
		descriptorStat.dev !== binding.identity.dev || descriptorStat.ino !== binding.identity.ino ||
		pathStat.dev !== binding.identity.dev || pathStat.ino !== binding.identity.ino) {
		throw new Error("output temporary file identity changed after authorization");
	}
}

function readOutputConfig(fd) {
	const stat = fs.fstatSync(fd);
	if (!stat.isFile() || stat.nlink !== 0 || (stat.mode & 0o7777) !== 0o600 || stat.size > 65536) {
		throw new Error("output config must be an unlinked private regular file under 65536 bytes");
	}
	const buffer = Buffer.alloc(stat.size);
	let offset = 0;
	while (offset < buffer.length) {
		const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
		if (count === 0) throw new Error("output config is incomplete");
		offset += count;
	}
	const config = JSON.parse(buffer.toString("utf8"));
	const binding = { ...config.binding, fd: 3 };
	validateBinding(binding);
	return { ...config, binding };
}

function assertOutputCwd(binding) {
	const files = outputPaths(binding, true);
	assertBoundDirectory(binding, false);
	assertOutputTarget(files.target);
	assertTemporaryIdentity(binding, files.temporary);
}

function prepareOutputFile(outputPath, cwdAnchor) {
	assertSafeDisplayPath(outputPath, "output path");
	assertSafeDisplayPath(cwdAnchor, "output cwd anchor");
	const resolved = path.resolve(cwdAnchor, outputPath);
	const target = canonicalizeSystemAlias(resolved);
	assertSafeBasename(path.basename(target));
	assertOutputTarget(target);
	const symlink = findSymlinkInPath(target);
	if (symlink) throw new Error(`refusing to write through existing symlink at ${symlink}`);
	const directory = path.dirname(target);
	fs.mkdirSync(directory, { recursive: true });
	const postMkdirSymlink = findSymlinkInPath(target);
	if (postMkdirSymlink) throw new Error(`refusing to write through existing symlink at ${postMkdirSymlink}`);
	if (fs.realpathSync(directory) !== directory) throw new Error("output directory changed during authorization");
	const directoryStat = fs.lstatSync(directory);
	if (!directoryStat.isDirectory()) throw new Error("output directory is not a directory");
	const temporary = path.join(directory, `.tmp-output-${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}`);
	let fd;
	let binding;
	try {
		fd = fs.openSync(temporary, "wx", 0o600);
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) throw new Error("output temporary descriptor is not a regular file");
		binding = { target, outputPath: resolved, temporary, directory, fd,
			identity: { dev: stat.dev, ino: stat.ino },
			directoryIdentity: { dev: directoryStat.dev, ino: directoryStat.ino } };
		assertBoundDirectory(binding);
		fs.fchmodSync(fd, 0o600);
		return binding;
	} catch (error) {
		if (binding) discardOutputFile(binding);
		else if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
		throw error;
	}
}

function discardOutputFile(binding, cwdBound = false) {
	if (!binding) return;
	// A closed or substituted descriptor grants no pathname cleanup authority.
	try {
		const descriptor = fs.fstatSync(binding.fd);
		if (!descriptor.isFile() || descriptor.dev !== binding.identity?.dev ||
			descriptor.ino !== binding.identity?.ino) return;
	} catch { return; }
	try { fs.closeSync(binding.fd); } catch { /* best effort */ }
	try {
		const files = outputPaths(binding, cwdBound);
		if (!cwdBound) assertBoundDirectory(binding, false);
		const stat = fs.lstatSync(files.temporary);
		if (stat.isFile() && stat.dev === binding.identity.dev && stat.ino === binding.identity.ino) {
			fs.unlinkSync(files.temporary);
		}
	} catch { /* never clean up through a replaced directory or temporary file */ }
}

function commitOutputFile(binding, body, cwdBound = false) {
	validateBinding(binding);
	let closed = false;
	let published = false;
	try {
		const files = outputPaths(binding, cwdBound);
		assertBoundDirectory(binding, !cwdBound);
		assertOutputTarget(files.target);
		assertTemporaryIdentity(binding, files.temporary);
		const text = typeof body === "string" ? body : String(body);
		fs.ftruncateSync(binding.fd, 0);
		fs.writeFileSync(binding.fd, text, { encoding: "utf8" });
		fs.fchmodSync(binding.fd, 0o600);
		fs.fsyncSync(binding.fd);
		assertBoundDirectory(binding, !cwdBound);
		assertOutputTarget(files.target);
		assertTemporaryIdentity(binding, files.temporary);
		fs.renameSync(files.temporary, files.target);
		published = true;
		// lstat never follows a substituted target symlink. The inherited fd,
		// rather than a reopened display path, remains the file authority.
		const targetStat = fs.lstatSync(files.target);
		const descriptorStat = fs.fstatSync(binding.fd);
		if (!targetStat.isFile() || targetStat.isSymbolicLink() ||
			targetStat.dev !== binding.identity.dev || targetStat.ino !== binding.identity.ino ||
			!descriptorStat.isFile() || descriptorStat.dev !== binding.identity.dev || descriptorStat.ino !== binding.identity.ino) {
			throw new Error("output target identity changed during rename");
		}
		if ((targetStat.mode & 0o7777) !== 0o600 || (descriptorStat.mode & 0o7777) !== 0o600) {
			throw new Error("output target mode changed from 0600 during rename");
		}
		// A moved caller path must not be reported as materialized. This check
		// can fail after rename, but cannot redirect that relative rename.
		assertBoundDirectory(binding, !cwdBound);
		fs.closeSync(binding.fd);
		closed = true;
		return {
			outputPath: binding.outputPath,
			outputBytes: Buffer.byteLength(text, "utf8"),
			outputLineCount: text === "" ? 0 : text.split("\n").length,
		};
	} catch (error) {
		if (published && !closed) {
			try {
				const descriptor = fs.fstatSync(binding.fd);
				if (!descriptor.isFile() || descriptor.dev !== binding.identity.dev ||
					descriptor.ino !== binding.identity.ino) {
					throw new Error("output descriptor identity changed before erasure");
				}
				// Erase only our held inode. A replaced directory entry is not
				// cleanup authority; leave an empty private file instead of unlinking.
				fs.ftruncateSync(binding.fd, 0);
				fs.fchmodSync(binding.fd, 0o600);
				fs.fsyncSync(binding.fd);
			} catch (cleanupError) {
				throw new Error("rejected output descriptor erasure failed", { cause: cleanupError });
			} finally {
				try { fs.closeSync(binding.fd); } catch { /* already closed */ }
				closed = true;
			}
		}
		if (!closed) discardOutputFile(binding, cwdBound);
		throw error;
	}
}

function writeOutputFile(outputPath, cwdAnchor, body) {
	const binding = prepareOutputFile(outputPath, cwdAnchor);
	return commitOutputFile(binding, body);
}

function selectAsyncOutputBody(answer, stdout, outputRequested) {
	const body = typeof answer === "string" ? answer.trim() : "";
	// An explicitly requested file exports only the report answer, including
	// an empty answer. Stdout fallback belongs only to ordinary no-output runs.
	return outputRequested ? body : body || stdout.trim() || "(no output)";
}

module.exports = { assertOutputCwd, commitOutputFile, discardOutputFile, prepareOutputFile, readOutputConfig,
	selectAsyncOutputBody, writeOutputFile };
