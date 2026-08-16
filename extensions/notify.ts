import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SwivalRunStatus = "completed" | "failed" | "stopped";

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
	now?: () => number;
	setTimeout?: (handler: () => void, delay: number) => NodeJS.Timeout;
	clearTimeout?: (timer: NodeJS.Timeout) => void;
}

export interface SwivalNotifier {
	deliver(summary: SwivalCompletionSummary): Promise<boolean>;
	reconcile(artifactRoot: string): Promise<void>;
	dispose(): void;
}

const NOTIFY_TTL_MS = 10 * 60 * 1000;
const PREVIEW_CHARS = 1500;

function preview(stdout: string | undefined): string {
	const text = stdout?.slice(-PREVIEW_CHARS).trim() ?? "";
	return text || "(no output)";
}

function singleContent(summary: SwivalCompletionSummary): string {
	return [
		`Swival background run ${summary.status}: **${summary.agent}** (${summary.runId})`,
		preview(summary.stdout),
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

async function exists(file: string): Promise<boolean> {
	try { await fs.promises.access(file); return true; } catch { return false; }
}

async function loadCompletedSummary(dir: string): Promise<SwivalCompletionSummary | undefined> {
	try {
		const meta = JSON.parse(await fs.promises.readFile(path.join(dir, "run-meta.json"), "utf-8")) as {
			runId?: unknown;
			agent?: unknown;
			artifactDir?: unknown;
			sessionId?: unknown;
			stdoutFile?: unknown;
		};
		const completed = JSON.parse(await fs.promises.readFile(path.join(dir, "completed.json"), "utf-8")) as {
			exitCode?: unknown;
			status?: unknown;
		};
		if (
			typeof meta.runId !== "string" || typeof meta.agent !== "string" ||
			typeof meta.artifactDir !== "string" || typeof meta.sessionId !== "string" ||
			!meta.sessionId || path.resolve(meta.artifactDir) !== path.resolve(dir)
		) return undefined;
		let stdout = "";
		const stdoutFile = typeof meta.stdoutFile === "string" &&
			path.resolve(meta.stdoutFile).startsWith(path.resolve(dir) + path.sep)
			? meta.stdoutFile : undefined;
		if (stdoutFile) {
			try { stdout = await fs.promises.readFile(stdoutFile, "utf-8"); } catch { /* output is optional */ }
		}
		const status: SwivalRunStatus = completed.status === "stopped" || completed.exitCode === null
			? "stopped"
			: completed.exitCode === 0 ? "completed" : "failed";
		return { runId: meta.runId, agent: meta.agent, artifactDir: meta.artifactDir, sessionId: meta.sessionId, status, stdout, stdoutFile };
	} catch {
		return undefined;
	}
}

/**
 * Send durable completion notices. A successful send is the acknowledgement;
 * the artifact marker is written only after Pi accepts the message.
 */
export function createSwivalNotifier(pi: Pick<ExtensionAPI, "sendMessage">, deps: SwivalNotifierDeps): SwivalNotifier {
	const now = deps.now ?? Date.now;
	const setTimer = deps.setTimeout ?? ((handler, delay) => setTimeout(handler, delay));
	const clearTimer = deps.clearTimeout ?? ((timer) => clearTimeout(timer));
	const batchWindowMs = deps.batchWindowMs ?? 1500;
	const seen = new Map<string, number>();
	const pending = new Map<string, { summary: SwivalCompletionSummary; resolve: (accepted: boolean) => void }>();
	let timer: NodeJS.Timeout | undefined;
	let disposed = false;

	const trimSeen = () => {
		const cutoff = now() - NOTIFY_TTL_MS;
		for (const [id, at] of seen) if (at <= cutoff) seen.delete(id);
	};

	const flush = async () => {
		timer = undefined;
		if (disposed || pending.size === 0) return;
		trimSeen();
		const entries = [...pending.values()].filter((entry) => !seen.has(entry.summary.runId));
		pending.clear();
		if (entries.length === 0) return;
		const summaries = entries.map((entry) => entry.summary);
		try {
			pi.sendMessage(
				{
					customType: "swival-notify",
					content: summaries.length === 1 ? singleContent(summaries[0]!) : batchContent(summaries),
					display: summaries.some((item) => item.status !== "completed"),
				},
				{ triggerTurn: true },
			);
		} catch {
			// A throw means Pi did not accept the message. Keep the record
			// pending and unmarked so the next reconciler pass retries it;
			// nothing here reschedules the batch timer on its own.
			for (const entry of entries) {
				pending.set(entry.summary.runId, entry);
				entry.resolve(false);
			}
			return;
		}
		for (const entry of entries) {
			try {
				await fs.promises.mkdir(entry.summary.artifactDir, { recursive: true });
				await fs.promises.writeFile(
					path.join(entry.summary.artifactDir, "notified.json"),
					JSON.stringify({ notifiedAt: new Date(now()).toISOString() }),
					"utf-8",
				);
				seen.set(entry.summary.runId, now());
				entry.resolve(true);
			} catch {
				entry.resolve(false);
			}
		}
	};

	const deliver = async (summary: SwivalCompletionSummary): Promise<boolean> => {
		trimSeen();
		if (disposed || !summary.sessionId || summary.sessionId !== deps.currentSessionId || seen.has(summary.runId)) return false;
		if (summary.stdout === undefined && summary.stdoutFile) {
			try { summary.stdout = await fs.promises.readFile(summary.stdoutFile, "utf-8"); } catch { /* output is optional */ }
		}
		const existing = pending.get(summary.runId);
		if (existing) {
			if (summary.status !== "completed") void flush();
			else if (!timer) timer = setTimer(() => { void flush(); }, batchWindowMs);
			return new Promise<boolean>((resolve) => {
				const originalResolve = existing.resolve;
				existing.resolve = (accepted) => { originalResolve(accepted); resolve(accepted); };
			});
		}
		const result = new Promise<boolean>((resolve) => pending.set(summary.runId, { summary, resolve }));
		if (summary.status !== "completed") {
			void flush();
		} else if (!timer) {
			timer = setTimer(() => { void flush(); }, batchWindowMs);
		}
		return result;
	};

	const reconcile = async (artifactRoot: string) => {
		let names: string[];
		try { names = await fs.promises.readdir(artifactRoot); } catch { return; }
		for (const name of names) {
			const dir = path.join(artifactRoot, name);
			if (!(await exists(path.join(dir, "completed.json"))) || await exists(path.join(dir, "notified.json"))) continue;
			const summary = await loadCompletedSummary(dir);
			if (summary) await deliver(summary);
		}
	};

	return {
		deliver,
		reconcile,
		dispose: () => {
			disposed = true;
			if (timer) clearTimer(timer);
			timer = undefined;
			for (const entry of pending.values()) entry.resolve(false);
			pending.clear();
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
