import { execFile } from "node:child_process";
import * as fs from "node:fs";

export interface SessionCost {
	costUsd: number;
	unpricedCalls: number;
	known: boolean;
}

export interface TurnBanner {
	turn: number;
	turnLimit: number;
	tokenEstimate: number;
	contextLength?: number;
	percent?: number;
}

export interface TraceStatus {
	turns?: number;
	lastToolCall?: string;
	lastActivityAt?: string;
}

export type RunLiveness = "running" | "exited" | "unknown";

export interface LivenessInput {
	startedAt: number;
	pid?: number;
	completed: boolean;
	inMemory: "live" | "exited" | "none";
	exitCode?: number | null;
	signalCode?: NodeJS.Signals | null;
}

export interface LivenessOptions {
	processStartTime?: (pid: number) => Promise<number | undefined>;
	isAlive?: (pid: number) => boolean | Promise<boolean>;
	toleranceMs?: number;
}

export function parseSessionCost(text: string): SessionCost | undefined {
	const partial = text.match(/\bKnown session cost:\s*~\$([0-9]+(?:\.[0-9]+)?)\s*\((\d+)\s+calls?\s+unpriced\)/i);
	const complete = text.match(/\bSession cost:\s*~\$([0-9]+(?:\.[0-9]+)?)/i);
	const match = partial ?? complete;
	if (!match) return undefined;
	const costUsd = Number(match[1]);
	if (!Number.isFinite(costUsd) || costUsd <= 0) return undefined;
	const unpricedCalls = partial ? Number(partial[2]) : 0;
	if (!Number.isInteger(unpricedCalls) || unpricedCalls < 0) return undefined;
	return { costUsd, unpricedCalls, known: unpricedCalls === 0 };
}

export function parseTurnBanner(text: string): TurnBanner | undefined {
	const matches = [...text.matchAll(/Turn\s+(\d+)\s*\/\s*(\d+)\s*\(~\s*([\d,]+)(?:\s*\/\s*([\d,]+))?\s+tokens(?:,\s*(\d+)%\s*)?\)/g)];
	const match = matches.at(-1);
	if (!match) return undefined;
	return {
		turn: Number(match[1]),
		turnLimit: Number(match[2]),
		tokenEstimate: Number(match[3].replaceAll(",", "")),
		...(match[4] ? { contextLength: Number(match[4].replaceAll(",", "")) } : {}),
		...(match[5] ? { percent: Number(match[5]) } : {}),
	};
}

function textFromTraceContent(content: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(content)) return [];
	return content.filter((part): part is Record<string, unknown> =>
		Boolean(part) && typeof part === "object" && !Array.isArray(part),
	);
}

/**
 * Read progress out of a swival trace JSONL. swival rewrites the whole file
 * each turn, so this doubles as a live progress source. Record types are only
 * system, user, and assistant (see swival/traces.py) — review rounds are not
 * traced, so they come from stderr or report.json instead.
 */
export function parseTraceStatus(text: string): TraceStatus {
	let turns = 0;
	let lastToolCall: string | undefined;
	let lastActivityAt: string | undefined;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let record: Record<string, unknown>;
		try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
		if (typeof record.timestamp === "string") lastActivityAt = record.timestamp;
		if (record.type === "assistant") {
			turns++;
			const message = record.message as Record<string, unknown> | undefined;
			for (const part of textFromTraceContent(message?.content)) {
				if (part.type === "tool_use" && typeof part.name === "string") lastToolCall = part.name;
			}
		}
	}
	return {
		...(turns > 0 ? { turns } : {}),
		...(lastToolCall ? { lastToolCall } : {}),
		...(lastActivityAt ? { lastActivityAt } : {}),
	};
}

export function collapseHtmlStderr(lines: readonly string[]): string[] {
	const out: string[] = [];
	let html = "";
	let inHtml = false;
	const flush = () => {
		if (!html) return;
		const status = html.slice(0, html.indexOf("<html>"));
		const challenge = html.match(/id=["']challenge-error-text["'][^>]*>([^<]*)</i)?.[1]?.trim();
		const marker = /_cf_chl_opt/i.test(html) ? "_cf_chl_opt" : "";
		const useful = [status.trim(), challenge ? `challenge-error-text: ${challenge}` : "", marker].filter(Boolean).join(" ");
		out.push(useful || html.replace(/\s+/g, " ").trim());
		html = "";
		inHtml = false;
	};
	for (const line of lines) {
		if (!inHtml && /<html\b/i.test(line)) {
			inHtml = true;
			html = line;
			continue;
		}
		if (inHtml) {
			html += ` ${line}`;
			if (/<\/html\s*>/i.test(line)) flush();
			continue;
		}
		out.push(line);
	}
	flush();
	return out;
}

export function filterStderrLines(lines: readonly string[]): string[] {
	const filtered: string[] = [];
	let skippingSkills = false;
	for (const line of collapseHtmlStderr(lines)) {
		if (/^\s*Discovered\s+\d+\s+skill\(s\):/i.test(line)) {
			skippingSkills = true;
			continue;
		}
		if (skippingSkills) {
			if (/^\s*(?:Error:|Traceback|WARN(?:ING)?:|INFO:|Turn\s|Session cost:|Known session cost:|Cache:)/i.test(line)) {
				skippingSkills = false;
			} else {
				continue;
			}
		}
		if (line.trim()) filtered.push(line);
	}
	const decisive = filtered.filter((line) => /^\s*(?:Error:|Traceback|[A-Za-z]+Error:)/.test(line));
	return [...decisive, ...filtered.filter((line) => !decisive.includes(line))];
}

async function linuxProcessStartTime(pid: number): Promise<number | undefined> {
	try {
		const stat = await fs.promises.readFile(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		if (close < 0) return undefined;
		const fields = stat.slice(close + 2).trim().split(/\s+/);
		const startTicks = Number(fields[19]);
		const procStat = await fs.promises.readFile("/proc/stat", "utf8");
		const boot = procStat.match(/^btime\s+(\d+)$/m);
		if (!boot || !Number.isFinite(startTicks)) return undefined;
		return Number(boot[1]) * 1000 + (startTicks / 100) * 1000;
	} catch {
		return undefined;
	}
}

export function readProcessStartTime(pid: number): Promise<number | undefined> {
	return new Promise((resolve) => {
		execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 250, maxBuffer: 4096 }, (error, stdout) => {
			if (!error && stdout.trim()) {
				const parsed = Date.parse(stdout.trim());
				if (Number.isFinite(parsed)) { resolve(parsed); return; }
			}
			void linuxProcessStartTime(pid).then(resolve);
		});
	});
}

export async function classifyRunLiveness(input: LivenessInput, options: LivenessOptions = {}): Promise<RunLiveness> {
	if (input.completed || input.inMemory === "exited" || input.exitCode !== null && input.exitCode !== undefined || input.signalCode !== null && input.signalCode !== undefined) return "exited";
	if (input.inMemory === "live") return "running";
	if (!input.pid || !Number.isInteger(input.pid) || input.pid < 2) return "unknown";
	const isAlive = options.isAlive ?? ((pid: number) => {
		try { process.kill(pid, 0); return true; } catch { return false; }
	});
	if (!(await isAlive(input.pid))) return "unknown";
	const processStartTime = options.processStartTime ?? readProcessStartTime;
	const started = await processStartTime(input.pid);
	if (started === undefined || !Number.isFinite(started)) return "unknown";
	return started >= input.startedAt - (options.toleranceMs ?? 5000) ? "running" : "unknown";
}
