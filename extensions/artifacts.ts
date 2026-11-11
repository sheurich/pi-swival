/**
 * Bounded artifact I/O and run-state ownership: bounded report reading,
 * sandbox bootstrap verification, artifact persistence and retention, the
 * live async run registry, disk recovery, and the read-only async observation
 * projection.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isCatalogueAgentName } from "./agents.js";
import {
	type AsyncRecoverySource,
	type AsyncRunObservation,
	MAX_OBSERVATION_ROWS,
	type ObservationReadBudget,
	ObservationReadDeferred,
	createRecoveryScan,
	isAsyncOwnerId,
	isObservationText,
} from "./async-observation.js";
import {
	ARTIFACT_ROOT,
	type AsyncRunState,
	type CompletedMarker,
	type FailureReason,
	type LiveRunHandle,
	REPORT_MAX_BYTES,
	type RecoveredRun,
	type ReportSummary,
	type RunMeta,
} from "./contracts.js";
import { canonicalFuturePath, parseEffectiveProviderTimeout } from "./paths.js";
import { isRunFailure, summarizeReport, terminalFailureReason } from "./report.js";

const HISTORICAL_RESOLUTION_BASE = process.cwd();

// ----------------------------------------------- sandbox bootstrap --

const SANDBOX_LABELS = { agentfs: "AgentFS", nono: "Nono" } as const;

/**
 * `report.sandbox.mode` is copied from argv and proves nothing. Only the
 * re-exec-only version field (`agentfs_version` / `nono_version`) is evidence
 * that the requested sandbox actually engaged. Returns undefined when the
 * sandbox was not requested or the evidence is present.
 */
export function verifySandboxBootstrap(
	mode: "agentfs" | "nono",
	requested: boolean,
	report: ReportSummary | undefined,
): FailureReason | undefined {
	if (!requested) return undefined;
	const label = SANDBOX_LABELS[mode];
	const engagement = mode === "agentfs" ? "the re-exec into the overlay" : "nono sandbox engagement";
	if (!report) {
		return { code: "config_error", text: `${label} sandbox was requested but no report was produced, so ${engagement} cannot be confirmed.` };
	}
	if (report.sandbox?.mode !== mode) {
		return { code: "config_error", text: `${label} sandbox was requested but report.sandbox.mode is "${report.sandbox?.mode ?? "missing"}", not "${mode}".` };
	}
	const version = mode === "agentfs" ? report.sandbox.agentfsVersion : report.sandbox.nonoVersion;
	if (typeof version !== "string" || version === "") {
		return {
			code: "config_error",
			text: mode === "agentfs"
				? "AgentFS sandbox was requested and report.sandbox.mode says \"agentfs\", but sandbox.agentfs_version (re-exec-only evidence) is absent, so the overlay re-exec cannot be confirmed."
				: 'Nono sandbox was requested and report.sandbox.mode says "nono", but sandbox.nono_version is absent, so nono sandbox engagement cannot be confirmed.',
		};
	}
	return undefined;
}

/** Fold a bootstrap failure into the report shape isRunFailure understands so it fails closed. */
function enforceSandboxBootstrap(mode: "agentfs" | "nono", requested: boolean, report: ReportSummary | undefined) {
	const failure = verifySandboxBootstrap(mode, requested, report);
	if (!failure) return { report };
	return { report: { ...(report ?? {}), outcome: "error" as const, accepted: false, errorMessage: failure.text }, reason: failure };
}

export const agentFsBootstrapFailure = (requested: boolean, report: ReportSummary | undefined) => verifySandboxBootstrap("agentfs", requested, report);
export const nonoBootstrapFailure = (requested: boolean, report: ReportSummary | undefined) => verifySandboxBootstrap("nono", requested, report);
export const enforceAgentFsBootstrap = (requested: boolean, report: ReportSummary | undefined) => enforceSandboxBootstrap("agentfs", requested, report);
export const enforceNonoBootstrap = (requested: boolean, report: ReportSummary | undefined) => enforceSandboxBootstrap("nono", requested, report);

/** Persisted intent covers CLI flags; report.sandbox.mode also covers configuration-selected sandboxes. */
export function enforceCompletedAsyncAgentFs(meta: Pick<RunMeta, "agentFsRequested">, report: ReportSummary | undefined) {
	return enforceAgentFsBootstrap(meta.agentFsRequested === true || report?.sandbox?.mode === "agentfs", report);
}

export function enforceCompletedAsyncNono(meta: Pick<RunMeta, "nonoRequested">, report: ReportSummary | undefined) {
	return enforceNonoBootstrap(meta.nonoRequested === true || report?.sandbox?.mode === "nono", report);
}

// ----------------------------------------------------- report reading --

/** Read one bounded regular file without following a leaf symlink or blocking on a FIFO. */
async function readBoundedText(file: string, cap: number): Promise<string | undefined> {
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > cap) return undefined;
		const buffer = Buffer.alloc(cap + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		return length > cap ? undefined : buffer.toString("utf8", 0, length);
	} catch {
		return undefined;
	} finally { await handle?.close().catch(() => undefined); }
}

/** Read and summarize `report.json`, retrying once when a non-atomic write is still in flight. */
export async function readReport(reportPath: string): Promise<ReportSummary | undefined> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const text = await readBoundedText(reportPath, REPORT_MAX_BYTES);
		if (text === undefined) return undefined;
		try {
			const parsed: unknown = JSON.parse(text);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
			return summarizeReport(parsed as Record<string, unknown>);
		} catch (err) {
			if (attempt === 0 && err instanceof SyntaxError) {
				await new Promise<void>((res) => setTimeout(res, 100));
				continue;
			}
			return undefined;
		}
	}
	return undefined;
}

// ------------------------------------------------ artifact minting --

export interface ArtifactDirMint {
	artifactDir: string;
	ts: number;
	/** Includes the random suffix to prevent millisecond-level runId collisions. */
	runId: string;
}

/** Shared by sync persistence and async launch so both use identical naming. */
export function mintArtifactDir(agentName: string, artifactRoot: string = ARTIFACT_ROOT, ts: number = Date.now()): ArtifactDirMint {
	const safeAgent = agentName.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.+/g, ".").replace(/^[._-]+/, "") || "swival";
	const suffix = randomBytes(4).toString("hex");
	return { artifactDir: path.join(artifactRoot, `${safeAgent}-${ts}-${suffix}`), ts, runId: `swival-run-${ts}-${suffix}` };
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
	await fs.promises.writeFile(file, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
}

/**
 * Copy swival's `report.json` and any `<sessionId>.jsonl` trace files from
 * the per-run tmp dir into the artifact root so they outlive tmpDir cleanup.
 * Captured synchronous runs also persist `run-meta.json` (`sync: true`) and a
 * `completed.json` marker so retention can prune them after the usual window
 * while async controls and observation never treat them as background runs.
 *
 * Returns the artifact dir path, or undefined when nothing was captured.
 */
export async function persistArtifacts(
	tmpDir: string,
	agentName: string,
	artifactRoot: string = ARTIFACT_ROOT,
	now: Date = new Date(),
	exitCode: number | null = 0,
): Promise<string | undefined> {
	const { artifactDir: destDir, runId } = mintArtifactDir(agentName, artifactRoot, now.getTime());
	let captured = false;
	try {
		await fs.promises.mkdir(destDir, { recursive: true, mode: 0o700 });
	} catch {
		return undefined;
	}
	try {
		await fs.promises.copyFile(path.join(tmpDir, "report.json"), path.join(destDir, "report.json"));
		captured = true;
	} catch { /* no report written */ }
	const traceSrc = path.join(tmpDir, "trace");
	try {
		const entries = await fs.promises.readdir(traceSrc);
		if (entries.length > 0) {
			const destTrace = path.join(destDir, "trace");
			await fs.promises.mkdir(destTrace, { recursive: true, mode: 0o700 });
			for (const name of entries) {
				try {
					await fs.promises.copyFile(path.join(traceSrc, name), path.join(destTrace, name));
					captured = true;
				} catch { /* skip unreadable entries */ }
			}
		}
	} catch { /* trace dir never populated */ }

	if (!captured) {
		await fs.promises.rm(destDir, { recursive: true, force: true }).catch(() => undefined);
		return undefined;
	}
	const meta: Pick<RunMeta, "runId" | "agent" | "startedAt" | "artifactDir" | "sync"> =
		{ runId, agent: agentName, startedAt: now.getTime(), artifactDir: destDir, sync: true };
	const marker: CompletedMarker = { exitCode, exitedAt: now.toISOString() };
	try {
		await writePrivateJson(path.join(destDir, "run-meta.json"), meta);
		await writePrivateJson(path.join(destDir, "completed.json"), marker);
	} catch { /* retention metadata is best-effort; the copied evidence stands */ }
	return destDir;
}

// ------------------------------------------------- live run registry --

/**
 * In-flight and recently completed async runs owned by this Pi process, keyed
 * by runId. Entries survive only for the process lifetime; cross-session
 * recovery scans `run-meta.json` files instead and never gains signalling authority.
 */
export const asyncRuns = new Map<string, LiveRunHandle>();
// Observation holds references only. Execution and manual controls retain their canonical registry.
const asyncObservationOwners = new Map<string, { live: Set<LiveRunHandle>; terminal: LiveRunHandle[] }>();
const newestAsyncReference = (left: LiveRunHandle, right: LiveRunHandle) =>
	right.meta.startedAt - left.meta.startedAt || left.meta.runId.localeCompare(right.meta.runId);

export function indexAsyncRun(entry: LiveRunHandle): void {
	const owner = entry.meta.ownerSessionId;
	if (!isAsyncOwnerId(owner)) return;
	let bucket = asyncObservationOwners.get(owner);
	if (!bucket) {
		bucket = { live: new Set(), terminal: [] };
		asyncObservationOwners.set(owner, bucket);
	}
	if (!entry.exited) bucket.live.add(entry);
	else {
		bucket.live.delete(entry);
		if (!bucket.terminal.includes(entry)) bucket.terminal.push(entry);
		bucket.terminal.sort(newestAsyncReference);
		bucket.terminal.length = Math.min(bucket.terminal.length, MAX_OBSERVATION_ROWS);
	}
}

export function unindexAsyncRun(entry: LiveRunHandle): void {
	const owner = entry.meta.ownerSessionId;
	if (!owner) return;
	const bucket = asyncObservationOwners.get(owner);
	if (!bucket) return;
	bucket.live.delete(entry);
	const index = bucket.terminal.indexOf(entry);
	if (index !== -1) bucket.terminal.splice(index, 1);
	if (!bucket.live.size && !bucket.terminal.length) asyncObservationOwners.delete(owner);
}

const asyncObservationListeners = new Set<() => void>();

export function subscribeAsyncRunChanges(callback: () => void): () => void {
	asyncObservationListeners.add(callback);
	return () => { asyncObservationListeners.delete(callback); };
}

export function asyncRunChanged(): void {
	for (const listener of asyncObservationListeners) {
		try { listener(); } catch { /* Observation cannot affect execution. */ }
	}
}

// ------------------------------------------------ artifact lifecycle --

/** Control classification requires native metadata/evidence, not an agent-name prefix. */
export async function isNativeArtifact(directory: string, knownMeta?: Record<string, unknown> | null): Promise<boolean> {
	for (const name of ["snapshot", "request.json", path.join("evidence", "native-state")]) {
		try { await fs.promises.lstat(path.join(directory, name)); return true; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true; }
	}
	if (knownMeta !== undefined) return knownMeta?.nativeAuditRequested === true;
	const meta = await readObservationJson(path.join(directory, "run-meta.json"), 65536);
	return meta?.value.nativeAuditRequested === true;
}

/**
 * Remove ordinary artifact directories older than `maxAgeMs` (by mtime) that
 * carry readable run metadata and a completion marker, covering both async
 * and synchronous runs. Native artifacts and live runs are always retained.
 */
export async function pruneOldArtifacts(artifactRoot: string = ARTIFACT_ROOT, maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<void> {
	const cutoff = Date.now() - maxAgeMs;
	let entries: string[];
	try {
		entries = await fs.promises.readdir(artifactRoot);
	} catch {
		return; // root doesn't exist yet — nothing to prune
	}
	const activeArtifactDirs = new Set<string>();
	for (const e of asyncRuns.values()) if (!e.exited) activeArtifactDirs.add(e.meta.artifactDir);
	for (const name of entries) {
		const fullPath = path.join(artifactRoot, name);
		try {
			const stat = await fs.promises.stat(fullPath);
			if (!stat.isDirectory() || stat.mtimeMs >= cutoff) continue;
			// Retention is deliberately more conservative than control classification.
			if (name.startsWith("native-audit-")) continue;
			const meta = await readObservationJson(path.join(fullPath, "run-meta.json"), 65536);
			if (!meta || await isNativeArtifact(fullPath, meta.value)) continue;
			if (activeArtifactDirs.has(fullPath)) continue;
			if (meta.value.sync === true) {
				// Persisted sync artifacts require a bounded, regular, non-symlink
				// completion record with a valid exitCode and exitedAt timestamp.
				const marker = await readObservationJson(path.join(fullPath, "completed.json"), 1024);
				if (!parseCompletedMarker({ startedAt: meta.value.startedAt as number }, marker, false)) continue;
			} else {
				// A missing marker means the run is still active or was interrupted
				// before it could write its marker; never prune on mtime alone.
				try { await fs.promises.access(path.join(fullPath, "completed.json")); } catch { continue; }
			}
			await fs.promises.rm(fullPath, { recursive: true, force: true });
		} catch { /* skip unreadable or already-gone entries */ }
	}
}

/**
 * Scan every subdirectory of `artifactRoot` for a `run-meta.json` whose
 * `runId` matches. Cross-session fallback for control actions after Pi
 * restarts; synchronous run metadata is never an async run.
 */
export async function findRunMeta(runId: string, artifactRoot: string = ARTIFACT_ROOT): Promise<RunMeta | undefined> {
	let entries: string[];
	try {
		entries = await fs.promises.readdir(artifactRoot);
	} catch {
		return undefined;
	}
	for (const name of entries) {
		try {
			const metadata = await readObservationJson(path.join(artifactRoot, name, "run-meta.json"), 65536);
			if (!metadata) continue;
			const parsed = metadata.value;
			if (parsed.sync === true) continue;
			if (
				typeof parsed.runId !== "string" ||
				typeof parsed.artifactDir !== "string" ||
				!(parsed.pid == null || typeof parsed.pid === "number") ||
				("agentFsRequested" in parsed && typeof parsed.agentFsRequested !== "boolean") ||
				("nonoRequested" in parsed && typeof parsed.nonoRequested !== "boolean") ||
				("effectiveProviderTimeout" in parsed && !parseEffectiveProviderTimeout(parsed.effectiveProviderTimeout)) ||
				!validPersistedAsyncOwner(parsed)
			) continue;

			// Canonicalize existing ancestors too: missing leaves can sit below an
			// escaping symlink, while the configured root may have a valid alias.
			const resolvedRoot = await canonicalFuturePath(artifactRoot);
			const resolvedArtifact = await canonicalFuturePath(parsed.artifactDir as string);
			if (!resolvedArtifact.startsWith(resolvedRoot + path.sep)) continue;
			for (const key of ["stdoutFile", "stderrFile"] as const) {
				if (typeof parsed[key] === "string") parsed[key] = await canonicalFuturePath(parsed[key] as string);
			}
			if (typeof parsed.stdoutFile !== "string" || !parsed.stdoutFile.startsWith(resolvedArtifact + path.sep)) continue;
			if (typeof parsed.stderrFile !== "string" || !parsed.stderrFile.startsWith(resolvedArtifact + path.sep)) continue;
			parsed.artifactDir = resolvedArtifact;
			// PID range: reject 0, 1, negative, and non-integer values
			if (typeof parsed.pid === "number" && (!Number.isInteger(parsed.pid) || parsed.pid < 2)) continue;

			const meta = parsed as unknown as RunMeta;
			if (meta.runId === runId) return meta;
		} catch { /* not a valid run-meta.json — skip */ }
	}
	return undefined;
}

/**
 * Unified run-state loader for control actions. The live registry is the fast
 * path and the only source of signalling authority; disk recovery yields
 * metadata plus terminal markers only, and `unknown` without a valid marker.
 */
export async function loadRunState(runId: string, artifactRoot: string = ARTIFACT_ROOT): Promise<AsyncRunState | undefined> {
	const entry = asyncRuns.get(runId);
	if (entry) {
		if (entry.exited && !entry.completed) {
			try {
				entry.completed = JSON.parse(await fs.promises.readFile(path.join(entry.meta.artifactDir, "completed.json"), "utf-8")) as CompletedMarker;
			} catch { /* best-effort */ }
		}
		return entry;
	}
	const meta = await findRunMeta(runId, artifactRoot);
	if (!meta || meta.nativeAuditRequested || await isNativeArtifact(meta.artifactDir)) return undefined;
	// Only a valid terminal marker proves exit; a missing or malformed marker
	// leaves the recovered run `unknown` (same rule as observeAsyncRun).
	const marker = parseCompletedMarker(meta, await readObservationJson(path.join(meta.artifactDir, "completed.json"), 1024));
	const completed: CompletedMarker | undefined = marker ? { exitCode: marker.exitCode, exitedAt: marker.exitedAt } : undefined;
	let spawnError: string | undefined;
	try {
		spawnError = await fs.promises.readFile(path.join(meta.artifactDir, "spawn-error.txt"), "utf-8");
	} catch { /* no spawn error */ }
	const recovered: RecoveredRun = { kind: "recovered", meta, exited: completed !== undefined, exitCode: completed?.exitCode ?? null, completed, spawnError };
	return recovered;
}

export async function inspectCompletedAsyncRun(state: AsyncRunState): Promise<{ report: ReportSummary | undefined; reason?: FailureReason }> {
	const report = await readReport(path.join(state.meta.artifactDir, "report.json"));
	const bootstrapCheck = enforceCompletedAsyncAgentFs(state.meta, report);
	const nonoCheck = enforceCompletedAsyncNono(state.meta, bootstrapCheck.report);
	const stderr = await fs.promises.readFile(state.meta.stderrFile, "utf-8").catch(() => "");
	const reason = terminalFailureReason(state.exitCode ?? 1, nonoCheck.report, stderr.split("\n").filter(Boolean),
		bootstrapCheck.reason ?? nonoCheck.reason, state.meta.effectiveProviderTimeout);
	return { report: nonoCheck.report, reason };
}

export function formatCompletedAsyncFailure(runId: string, state: AsyncRunState, reason: FailureReason): string {
	const label = reason.text.startsWith("AgentFS sandbox was requested") ? "failed AgentFS bootstrap validation"
		: reason.text.startsWith("Nono sandbox was requested") ? "failed Nono bootstrap validation"
		: `failed (${reason.code})`;
	return `Run ${runId} ${label}: ${reason.text}\nArtifact dir: ${state.meta.artifactDir}`;
}

// --------------------------------------------------- observation --

function validPersistedAsyncOwner(meta: Record<string, unknown>): boolean {
	if (!("ownerSessionId" in meta)) return !("ownerSessionFile" in meta);
	return isAsyncOwnerId(meta.ownerSessionId) && (!("ownerSessionFile" in meta) || isObservationText(meta.ownerSessionFile, 4096));
}

/** Read one regular artifact without following a leaf symlink or an unbounded growing file. */
export async function readObservationJson(file: string, cap: number, budget?: ObservationReadBudget): Promise<{
	value: Record<string, unknown>; mtimeMs: number;
} | undefined> {
	let handle: fs.promises.FileHandle | undefined;
	try {
		if (budget && (!budget.isCurrent() || budget.remaining === 0)) throw new ObservationReadDeferred();
		handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
		if (budget && !budget.isCurrent()) throw new ObservationReadDeferred();
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > cap) return undefined;
		if (budget && (!budget.isCurrent() || stat.size + 1 > budget.remaining)) throw new ObservationReadDeferred();
		const buffer = Buffer.alloc(Math.min(cap + 1, budget?.remaining ?? cap + 1));
		let length = 0;
		while (length < buffer.length) {
			if (budget && !budget.isCurrent()) throw new ObservationReadDeferred();
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
			if (budget) budget.remaining -= bytesRead;
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		if (length > cap) return undefined;
		if (length === buffer.length && buffer.length < cap + 1) throw new ObservationReadDeferred();
		const value: unknown = JSON.parse(buffer.toString("utf8", 0, length));
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		return { value: value as Record<string, unknown>, mtimeMs: stat.mtimeMs };
	} catch (error) {
		if (error instanceof ObservationReadDeferred || ["EINTR", "EIO"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		return undefined;
	} finally { await handle?.close().catch(() => undefined); }
}

function asyncObservationIdentity(meta: RunMeta) {
	return {
		runId: meta.runId, ownerSessionId: meta.ownerSessionId!,
		...(meta.ownerSessionFile ? { ownerSessionFile: meta.ownerSessionFile } : {}),
		// Observation labels are not dispatch selectors; execution metadata stays exact.
		agent: isObservationText(meta.agent, 160) ? meta.agent : "Swival agent",
		startedAt: meta.startedAt,
	};
}

/**
 * Validate a `completed.json` marker. The timestamp must be canonical ISO 8601
 * at or after launch, the file must postdate launch (unless skipped for aged
 * synchronous retention), and the exit code must be null or a non-negative
 * int32, so arbitrary JSON never proves exit.
 */
function parseCompletedMarker(
	meta: Pick<RunMeta, "startedAt">,
	marker: { value: Record<string, unknown>; mtimeMs: number } | undefined,
	requirePostLaunchMtime = true,
): { exitCode: number | null; exitedAt: string; endedAt: number } | undefined {
	if (!marker || !Number.isSafeInteger(meta.startedAt) || meta.startedAt < 0) return undefined;
	const exitedAt = marker.value.exitedAt;
	const endedAt = typeof exitedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(exitedAt) ? Date.parse(exitedAt) : NaN;
	if (!Number.isFinite(endedAt)) return undefined;
	const canonicalDate = new Date(endedAt).toISOString();
	if (canonicalDate !== exitedAt && canonicalDate.replace(".000Z", "Z") !== exitedAt) return undefined;
	if (endedAt < meta.startedAt || (requirePostLaunchMtime && marker.mtimeMs < meta.startedAt)) return undefined;
	const code = marker.value.exitCode;
	if (!(code === null || (typeof code === "number" && Number.isSafeInteger(code) && code >= 0 && code <= 2147483647))) return undefined;
	return { exitCode: code, exitedAt: exitedAt as string, endedAt };
}

async function observeAsyncRun(meta: RunMeta, entry?: LiveRunHandle, budget?: ObservationReadBudget): Promise<AsyncRunObservation> {
	const base = asyncObservationIdentity(meta);
	if (entry && !entry.exited) return Object.freeze({ ...base, state: "running" });
	const [rootStat, artifactStat] = await Promise.all([
		fs.promises.lstat(path.dirname(meta.artifactDir)).catch(() => undefined),
		fs.promises.lstat(meta.artifactDir).catch(() => undefined),
	]);
	if (!rootStat?.isDirectory() || !artifactStat?.isDirectory()) return Object.freeze({ ...base, state: "unknown" });
	const validMarker = parseCompletedMarker(meta, await readObservationJson(path.join(meta.artifactDir, "completed.json"), 1024, budget));
	if (!entry && !validMarker) return Object.freeze({ ...base, state: "unknown" });
	const raw = await readObservationJson(path.join(meta.artifactDir, "report.json"), 1024 * 1024, budget);
	let report: ReportSummary | undefined;
	try {
		if (raw && raw.mtimeMs >= meta.startedAt) report = summarizeReport(raw.value);
	} catch { /* Malformed reports fail closed under the normal result policy. */ }
	const bootstrap = enforceCompletedAsyncAgentFs(meta, report);
	const nono = enforceCompletedAsyncNono(meta, bootstrap.report);
	const exitCode = entry ? entry.exitCode : validMarker ? validMarker.exitCode : null;
	const spawnFailed = await fs.promises.lstat(path.join(meta.artifactDir, "spawn-error.txt"))
		.then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT");
	return Object.freeze({ ...base,
		state: spawnFailed || isRunFailure({ exitCode: exitCode ?? 1, report: nono.report }) ? "failed" : "completed",
		...(validMarker ? { endedAt: validMarker.endedAt } : {}),
	});
}

function eligibleAsyncObservationMeta(meta: RunMeta, ownerSessionId: string, root: string): boolean {
	return meta.ownerSessionId === ownerSessionId
		&& validPersistedAsyncOwner(meta as unknown as Record<string, unknown>)
		&& isObservationText(meta.runId, 160)
		&& (isObservationText(meta.agent, 160) || (typeof meta.agent === "string" && isCatalogueAgentName(meta.agent)))
		&& Number.isSafeInteger(meta.startedAt) && meta.startedAt >= 0
		&& meta.startedAt <= 8_640_000_000_000_000
		&& typeof meta.artifactDir === "string" && path.dirname(path.resolve(meta.artifactDir)) === root;
}

function selectLocalAsyncObservationEntries(
	ownerSessionId: string, root: string, retainedRunIds: readonly string[] = [], onTruncated?: () => void,
): LiveRunHandle[] {
	const bucket = asyncObservationOwners.get(ownerSessionId);
	if (!bucket) return [];
	const eligible = (entry: LiveRunHandle) => eligibleAsyncObservationMeta(entry.meta, ownerSessionId, root);
	const live = [...bucket.live].filter(eligible).sort(newestAsyncReference);
	if (live.length > MAX_OBSERVATION_ROWS) onTruncated?.();
	// A previously published live handle gets one terminal publication, even if its
	// start time is older than the retained history or overflow has filled every slot.
	const terminalTransitions = retainedRunIds.slice(0, MAX_OBSERVATION_ROWS)
		.map((id) => asyncRuns.get(id))
		.filter((entry): entry is LiveRunHandle => !!entry && entry.exited && eligible(entry))
		.sort(newestAsyncReference);
	const selected = new Set<LiveRunHandle>();
	for (const entry of [...terminalTransitions, ...live, ...bucket.terminal.filter(eligible)]) {
		selected.add(entry);
		if (selected.size === MAX_OBSERVATION_ROWS) break;
	}
	return [...selected];
}

export function readLocalAsyncRunObservations(
	ownerSessionId: string, artifactRoot: string, retainedRunIds: readonly string[] = [], onTruncated?: () => void,
): readonly AsyncRunObservation[] {
	if (!isAsyncOwnerId(ownerSessionId)) return Object.freeze([]);
	return Object.freeze(selectLocalAsyncObservationEntries(ownerSessionId, path.resolve(artifactRoot), retainedRunIds, onTruncated)
		// Hold a selected exiting handle until asynchronous report validation publishes its terminal state.
		.filter((entry) => !entry.exited || retainedRunIds.includes(entry.meta.runId))
		.map((entry) => Object.freeze({ ...asyncObservationIdentity(entry.meta), state: "running" as const })));
}

/** Only stat identities are retained by the observer, never metadata/report bodies. */
async function asyncEvidenceFingerprint(root: string, artifactDir: string): Promise<string | undefined> {
	try {
		const identity = (stat: fs.Stats) => `${stat.dev}:${stat.ino}:${stat.mode}`;
		const fingerprint = (stat: fs.Stats) => `${identity(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
		const [rootStat, directory] = await Promise.all([fs.promises.lstat(root), fs.promises.lstat(artifactDir)]);
		if (!rootStat.isDirectory() || !directory.isDirectory() || path.dirname(artifactDir) !== root
			|| await isNativeArtifact(artifactDir, null)) return undefined;
		// A symlinked evidence parent must not hide a native-state sentinel.
		const evidence = await fs.promises.lstat(path.join(artifactDir, "evidence")).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		});
		if (evidence && !evidence.isDirectory()) return undefined;
		const parts = [identity(rootStat), fingerprint(directory), evidence ? fingerprint(evidence) : "absent"];
		for (const name of ["run-meta.json", "completed.json", "report.json", "spawn-error.txt"]) {
			const stat = await fs.promises.lstat(path.join(artifactDir, name)).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				return undefined;
			});
			parts.push(stat ? fingerprint(stat) : "absent");
		}
		return parts.join("|");
	} catch { return undefined; }
}

/** Filesystem operations stay here; continuation and retained rows belong to the observer. */
export function asyncRecoverySource(ownerSessionId: string, root: string, resolutionBase: string = HISTORICAL_RESOLUTION_BASE): AsyncRecoverySource {
	let selectedLocalArtifacts = new Set<string>();
	return {
		local: (ids) => {
			const entries = selectLocalAsyncObservationEntries(ownerSessionId, root, ids);
			selectedLocalArtifacts = new Set(entries.map((entry) => entry.meta.artifactDir));
			return entries.map((entry) => ({
				key: entry.meta.artifactDir,
				fingerprint: async () => {
					const value = entry.exited ? await asyncEvidenceFingerprint(root, entry.meta.artifactDir) : undefined;
					return value === undefined ? undefined : `local|${value}`;
				},
				read: (budget: ObservationReadBudget) => observeAsyncRun(entry.meta, entry, budget),
			}));
		},
		async open() {
			const empty = { read: async () => null, close: async () => {} };
			const rootStat = await fs.promises.lstat(root).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return undefined;
				throw error;
			});
			if (!rootStat?.isDirectory()) return empty;
			const directory = await fs.promises.opendir(root);
			return {
				close: () => directory.close(),
				async read() {
					const item = await directory.read();
					if (!item) return null;
					const artifactDir = path.join(root, item.name);
					// Canonical locals were validated above; do not overwrite their cache
					// identity with a skipped disk read or different recovery provenance.
					const bucket = asyncObservationOwners.get(ownerSessionId);
					if (selectedLocalArtifacts.has(artifactDir) || [...bucket?.live ?? [], ...bucket?.terminal ?? []].some((entry) =>
						entry.meta.artifactDir === artifactDir && eligibleAsyncObservationMeta(entry.meta, ownerSessionId, root))) {
						return { read: async () => undefined };
					}
					return { key: artifactDir,
						fingerprint: async () => {
							const value = await asyncEvidenceFingerprint(root, artifactDir);
							return value === undefined ? undefined : `${process.cwd() === resolutionBase}|${value}`;
						},
						async read(budget: ObservationReadBudget) {
							if (!item.isDirectory() || !budget.isCurrent()) return undefined;
							const currentRoot = await fs.promises.lstat(root);
							if (!currentRoot.isDirectory() || currentRoot.dev !== rootStat.dev || currentRoot.ino !== rootStat.ino) {
								throw new Error("Async observation root changed.");
							}
							// Dirents can become stale during mutation. Never follow a replaced directory symlink.
							const stat = await fs.promises.lstat(artifactDir).catch(() => undefined);
							if (!stat?.isDirectory() || await isNativeArtifact(artifactDir, null)) return undefined;
							const record = await readObservationJson(path.join(artifactDir, "run-meta.json"), 65536, budget);
							if (!record || record.value.sync === true || await isNativeArtifact(artifactDir, record.value)) return undefined;
							const value = record.value;
							if (typeof value.artifactDir !== "string") return undefined;
							// No metadata records the old cwd. Relative paths are supported only while
							// the known historical resolution base is unchanged, never guessed from root.
							if (!path.isAbsolute(value.artifactDir) && process.cwd() !== resolutionBase) return undefined;
							const normalized = path.resolve(resolutionBase, value.artifactDir);
							if (normalized !== artifactDir || path.dirname(normalized) !== root) return undefined;
							for (const key of ["stdoutFile", "stderrFile"] as const) {
								if (!(key in value)) continue;
								if (typeof value[key] !== "string") return undefined;
								if (!path.isAbsolute(value[key]) && process.cwd() !== resolutionBase) return undefined;
								if (path.dirname(path.resolve(resolutionBase, value[key])) !== artifactDir) return undefined;
							}
							const meta = { ...value, artifactDir: normalized } as unknown as RunMeta;
							if (!eligibleAsyncObservationMeta(meta, ownerSessionId, root)) return undefined;
							if (("agentFsRequested" in meta && typeof meta.agentFsRequested !== "boolean")
								|| ("nonoRequested" in meta && typeof meta.nonoRequested !== "boolean")) return undefined;
							if ("effectiveProviderTimeout" in meta && !parseEffectiveProviderTimeout(meta.effectiveProviderTimeout)) return undefined;
							return observeAsyncRun(meta, undefined, budget);
						} };
				},
			};
		},
	};
}

/** One bounded page only, not an exhaustive snapshot. Fleet uses a disposable progressive scan. */
export async function readAsyncRunObservations(
	ownerSessionId: string,
	artifactRoot: string = ARTIFACT_ROOT,
	retainedRunIds: readonly string[] = [],
): Promise<readonly AsyncRunObservation[]> {
	if (!isAsyncOwnerId(ownerSessionId)) return Object.freeze([]);
	const root = path.resolve(artifactRoot);
	const scan = createRecoveryScan(asyncRecoverySource(ownerSessionId, root, HISTORICAL_RESOLUTION_BASE));
	try { return (await scan.pass(retainedRunIds)).rows; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
		throw new Error("Async observation unavailable.");
	} finally { scan.dispose(); }
}
