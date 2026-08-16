import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SwivalRunStatus = "accepted" | "completed" | "rejected" | "error" | "failed" | "stopped";

export interface SwivalCompletionSummary {
	runId: string;
	agent: string;
	artifactDir: string;
	sessionId?: string;
	status: SwivalRunStatus;
	stdout?: string;
	stdoutFile?: string;
}

export interface SwivalNotifierDeps {
	currentSessionId: string;
	batchWindowMs?: number;
	ackTimeoutMs?: number;
}

export interface SwivalNotifier {
	deliver(summary: SwivalCompletionSummary): Promise<boolean>;
	reconcile(artifactRoot: string): Promise<void>;
	dispose(): void;
}

interface PendingDelivery {
	summary: SwivalCompletionSummary;
	waiters: Array<(accepted: boolean) => void>;
}

interface AwaitingDelivery extends PendingDelivery {
	batchId: string;
}

interface AwaitingBatch {
	runIds: string[];
	sessionId: string;
	timeout: NodeJS.Timeout;
}

const NOTIFY_TTL_MS = 10 * 60 * 1000;
const ACK_TIMEOUT_MS = 15_000;

function singleContent(summary: SwivalCompletionSummary): string {
	return [
		`Swival background run ${summary.status}: **${summary.agent}** (${summary.runId})`,
		`Artifact dir: ${summary.artifactDir}`,
	].join("\n");
}

function batchContent(items: SwivalCompletionSummary[]): string {
	const names = items.map((item) => `**${item.agent}** (${item.runId})`).join(", ");
	return [
		`Swival background runs finished (${items.length}): ${names}`,
		...items.map((item) => singleContent(item)),
	].join("\n\n");
}

function isCleanStatus(status: SwivalRunStatus): boolean {
	return status === "accepted" || status === "completed";
}

function toNum(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toStr(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.promises.access(file);
		return true;
	} catch {
		return false;
	}
}

async function deriveStatus(dir: string, fallback: SwivalRunStatus): Promise<SwivalRunStatus> {
	let exitCode: number | null | undefined;
	try {
		const completed = JSON.parse(await fs.promises.readFile(path.join(dir, "completed.json"), "utf-8")) as {
			exitCode?: unknown;
		};
		if (typeof completed.exitCode === "number") exitCode = completed.exitCode;
		else if (completed.exitCode === null) exitCode = null;
	} catch {
		return fallback;
	}

	if (exitCode !== 0) {
		if (exitCode === null) {
			return await exists(path.join(dir, "spawn-error.txt")) ? "failed" : "stopped";
		}
		return "failed";
	}

	try {
		const report = JSON.parse(await fs.promises.readFile(path.join(dir, "report.json"), "utf-8")) as {
			result?: { outcome?: unknown };
			stats?: { review_rounds?: unknown };
		};
		const outcome = toStr(report.result?.outcome);
		const reviewRounds = toNum(report.stats?.review_rounds) ?? 0;
		if (outcome === "error") return "error";
		if (outcome === "failed") return "rejected";
		if (outcome === "success") return reviewRounds > 0 ? "accepted" : "completed";
	} catch {
		// Missing or malformed report.json falls back to the termination signal.
	}

	return fallback === "failed" || fallback === "stopped" ? fallback : "completed";
}

async function loadCompletedSummary(dir: string): Promise<SwivalCompletionSummary | undefined> {
	try {
		const meta = JSON.parse(await fs.promises.readFile(path.join(dir, "run-meta.json"), "utf-8")) as {
			runId?: unknown;
			agent?: unknown;
			artifactDir?: unknown;
			sessionId?: unknown;
		};
		if (
			typeof meta.runId !== "string" ||
			typeof meta.agent !== "string" ||
			typeof meta.artifactDir !== "string" ||
			typeof meta.sessionId !== "string" ||
			!meta.sessionId ||
			path.resolve(meta.artifactDir) !== path.resolve(dir)
		) return undefined;
		return {
			runId: meta.runId,
			agent: meta.agent,
			artifactDir: meta.artifactDir,
			sessionId: meta.sessionId,
			status: await deriveStatus(dir, "completed"),
		};
	} catch {
		return undefined;
	}
}

function matchesExactRunSet(expected: readonly string[], actual: readonly string[]): boolean {
	if (expected.length !== actual.length) return false;
	const expectedSorted = [...expected].sort();
	const actualSorted = [...actual].sort();
	return expectedSorted.every((runId, index) => runId === actualSorted[index]);
}

/**
 * Send durable completion notices. A successful send is NOT the acknowledgement;
 * the artifact marker is written only after Pi emits the matching message_end.
 */
export function createSwivalNotifier(
	pi: { sendMessage: ExtensionAPI["sendMessage"]; on?: ExtensionAPI["on"] },
	deps: SwivalNotifierDeps,
): SwivalNotifier {
	const batchWindowMs = deps.batchWindowMs ?? 1500;
	const ackTimeoutMs = deps.ackTimeoutMs ?? ACK_TIMEOUT_MS;
	const seen = new Map<string, number>();
	const pending = new Map<string, PendingDelivery>();
	const awaiting = new Map<string, AwaitingDelivery>();
	const awaitingBatches = new Map<string, AwaitingBatch>();
	let timer: NodeJS.Timeout | undefined;
	let disposed = false;

	const trimSeen = () => {
		const cutoff = Date.now() - NOTIFY_TTL_MS;
		for (const [runId, at] of seen) if (at <= cutoff) seen.delete(runId);
	};

	const resolveDelivery = (entry: PendingDelivery, accepted: boolean) => {
		for (const waiter of entry.waiters.splice(0)) waiter(accepted);
	};

	const scheduleFlush = (status: SwivalRunStatus) => {
		if (!isCleanStatus(status) || batchWindowMs <= 0) {
			void flush();
			return;
		}
		if (!timer) timer = setTimeout(() => { void flush(); }, batchWindowMs);
	};

	const handleAck = async (event: unknown, ctx?: { sessionManager?: { getSessionId?: () => string } }) => {
		if (disposed) return;
		const sessionId = ctx?.sessionManager?.getSessionId?.();
		if (sessionId && sessionId !== deps.currentSessionId) return;
		const message = (event as { message?: { role?: unknown; customType?: unknown; details?: unknown } })?.message;
		if (message?.role !== "custom" || message.customType !== "swival-notify") return;
		const details = (message.details ?? {}) as { runIds?: unknown; batchId?: unknown; sessionId?: unknown };
		const batchId = toStr(details.batchId);
		const ackSessionId = toStr(details.sessionId);
		if (!batchId || !ackSessionId || ackSessionId !== deps.currentSessionId) return;
		const batch = awaitingBatches.get(batchId);
		if (!batch || batch.sessionId !== deps.currentSessionId) return;
		const runIdsRaw = details.runIds;
		if (!Array.isArray(runIdsRaw)) return;
		const runIds = runIdsRaw.filter((value): value is string => typeof value === "string");
		if (!matchesExactRunSet(batch.runIds, runIds)) return;

		awaitingBatches.delete(batchId);
		clearTimeout(batch.timeout);
		const entries: AwaitingDelivery[] = [];
		for (const runId of batch.runIds) {
			const entry = awaiting.get(runId);
			if (!entry || entry.batchId !== batchId) continue;
			awaiting.delete(runId);
			seen.set(runId, Date.now());
			entries.push(entry);
		}
		for (const entry of entries) {
			try {
				await fs.promises.mkdir(entry.summary.artifactDir, { recursive: true });
				await fs.promises.writeFile(
					path.join(entry.summary.artifactDir, "notified.json"),
					JSON.stringify({ notifiedAt: new Date(Date.now()).toISOString(), runIds: [entry.summary.runId] }),
					"utf-8",
				);
				resolveDelivery(entry, true);
			} catch {
				resolveDelivery(entry, false);
			}
		}
	};

	const unsubscribe = pi.on?.("message_end", handleAck as never);

	const flush = async () => {
		timer = undefined;
		if (disposed || pending.size === 0) return;
		trimSeen();
		const entries = [...pending.entries()]
			.filter(([runId]) => !seen.has(runId))
			.map(([, entry]) => entry);
		pending.clear();
		if (entries.length === 0) return;

		const delivered = await Promise.all(entries.map(async (entry) => ({
			summary: { ...entry.summary, status: await deriveStatus(entry.summary.artifactDir, entry.summary.status) },
			waiters: entry.waiters,
		})));
		const runIds = delivered.map((entry) => entry.summary.runId);
		const batchId = `swival-notify-${randomBytes(8).toString("hex")}`;

		try {
			pi.sendMessage(
				{
					customType: "swival-notify",
					content: delivered.length === 1
						? singleContent(delivered[0]!.summary)
						: batchContent(delivered.map((entry) => entry.summary)),
					display: delivered.some((entry) => !isCleanStatus(entry.summary.status)),
					details: { runIds, batchId, sessionId: deps.currentSessionId },
				},
				{ triggerTurn: true },
			);
		} catch {
			for (const entry of delivered) resolveDelivery(entry, false);
			return;
		}

		const timeout = setTimeout(() => {
			const awaitingBatch = awaitingBatches.get(batchId);
			if (!awaitingBatch) return;
			awaitingBatches.delete(batchId);
			for (const runId of awaitingBatch.runIds) {
				const entry = awaiting.get(runId);
				if (!entry || entry.batchId !== batchId) continue;
				awaiting.delete(runId);
				resolveDelivery(entry, false);
			}
		}, ackTimeoutMs);
		timeout.unref?.();
		awaitingBatches.set(batchId, { runIds, sessionId: deps.currentSessionId, timeout });
		for (const entry of delivered) {
			awaiting.set(entry.summary.runId, { ...entry, batchId });
		}
	};

	const deliver = async (summary: SwivalCompletionSummary): Promise<boolean> => {
		trimSeen();
		if (disposed || !summary.sessionId || summary.sessionId !== deps.currentSessionId || seen.has(summary.runId)) return false;
		const canonical = { ...summary, status: await deriveStatus(summary.artifactDir, summary.status) };
		const active = awaiting.get(summary.runId);
		if (active) return new Promise<boolean>((resolve) => active.waiters.push(resolve));
		const existing = pending.get(summary.runId);
		if (existing) {
			existing.summary = canonical;
			scheduleFlush(canonical.status);
			return new Promise<boolean>((resolve) => existing.waiters.push(resolve));
		}
		const entry: PendingDelivery = { summary: canonical, waiters: [] };
		const result = new Promise<boolean>((resolve) => entry.waiters.push(resolve));
		pending.set(summary.runId, entry);
		scheduleFlush(canonical.status);
		return result;
	};

	const reconcile = async (artifactRoot: string) => {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(artifactRoot, { withFileTypes: true });
		} catch {
			return;
		}
		for (const dirent of entries) {
			if (!dirent.isDirectory()) continue;
			const dir = path.join(artifactRoot, dirent.name);
			const [completedExists, notifiedExists] = await Promise.all([
				exists(path.join(dir, "completed.json")),
				exists(path.join(dir, "notified.json")),
			]);
			if (!completedExists || notifiedExists) continue;
			const summary = await loadCompletedSummary(dir);
			if (summary) void deliver(summary);
		}
	};

	return {
		deliver,
		reconcile,
		dispose: () => {
			disposed = true;
			unsubscribe?.();
			if (timer) clearTimeout(timer);
			timer = undefined;
			for (const batch of awaitingBatches.values()) clearTimeout(batch.timeout);
			awaitingBatches.clear();
			for (const entry of pending.values()) resolveDelivery(entry, false);
			for (const entry of awaiting.values()) resolveDelivery(entry, false);
			pending.clear();
			awaiting.clear();
		},
	};
}

export interface SwivalReconcilerDeps {
	artifactRoot: string;
	pollIntervalMs?: number;
}

export function startSwivalReconciler(notifier: SwivalNotifier, deps: SwivalReconcilerDeps): () => void {
	let stopped = false;
	let watcher: fs.FSWatcher | undefined;
	const pollIntervalMs = deps.pollIntervalMs ?? 30_000;
	const scan = () => { if (!stopped) void notifier.reconcile(deps.artifactRoot); };
	void fs.promises.mkdir(deps.artifactRoot, { recursive: true }).then(() => {
		if (stopped) return;
		try { watcher = fs.watch(deps.artifactRoot, { persistent: false }, scan); } catch { /* polling remains available */ }
	});
	scan();
	const timer = setInterval(scan, pollIntervalMs);
	timer.unref?.();
	return () => {
		stopped = true;
		watcher?.close();
		clearInterval(timer);
		notifier.dispose();
	};
}
