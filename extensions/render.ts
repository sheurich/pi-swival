/**
 * Output formatting: inline caps, run-output files, status rendering, the
 * parallel summary, the bounded agent catalogue, and Pi TUI rendering.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentScope, SwivalAgentDiscoveryResult } from "./agents.js";
import type { NativeRoute, RunStatus, SwivalDetails, SwivalResult, TraceToolCall } from "./contracts.js";
import { isRunFailure } from "./report.js";

// ------------------------------------------------------- inline cap --

/**
 * Truncate inline body when a caller-supplied cap is exceeded. Truncation is
 * loud: the marker points the caller at where the full answer lives. The cap
 * counts UTF-16 code units, matching JavaScript string length.
 */
export function applyInlineCap(body: string, cap: number | undefined, pointer: string | undefined): string {
	if (typeof cap !== "number" || cap <= 0 || body.length <= cap) return body;
	const cut = body.length - cap;
	const marker = pointer ? `\n[truncated ${cut} chars; full output at ${pointer}]` : `\n[truncated ${cut} chars]`;
	return body.slice(0, cap) + marker;
}

// ------------------------------------------------------ output files --

async function hasSymlinkInPath(resolved: string, cwdAnchor: string): Promise<string | null> {
	try {
		if ((await fs.promises.lstat(resolved)).isSymbolicLink()) return resolved;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	// For any path that resolves inside cwdAnchor, verify no parent directory
	// component under cwdAnchor is a symlink.
	const anchor = path.resolve(cwdAnchor);
	let current = path.dirname(resolved);
	while (current && current.startsWith(anchor + path.sep) && current !== anchor) {
		try {
			if ((await fs.promises.lstat(current)).isSymbolicLink()) return current;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
}

/**
 * Write a run's finalOutput to disk and populate the output bookkeeping
 * fields on the result. `outputPath` is model-controlled, so writes refuse
 * pre-planted symlinks (leaf and parent components within cwdAnchor), use a
 * 0600 exclusive temp file, and rename atomically. Errors append to
 * stderrTail instead of throwing.
 */
export async function writeRunOutput(
	r: SwivalResult,
	outputPath: string,
	outputMode: "inline" | "file-only" | undefined,
	cwdAnchor: string,
): Promise<void> {
	const resolved = path.isAbsolute(outputPath) ? outputPath : path.resolve(cwdAnchor, outputPath);
	try {
		const symlinkFound = await hasSymlinkInPath(resolved, cwdAnchor);
		if (symlinkFound) throw new Error(`refusing to write through existing symlink at ${symlinkFound}`);
		const dir = path.dirname(resolved);
		await fs.promises.mkdir(dir, { recursive: true });
		const postMkdirSymlink = await hasSymlinkInPath(resolved, cwdAnchor);
		if (postMkdirSymlink) throw new Error(`refusing to write through existing symlink at ${postMkdirSymlink}`);
		const body = r.finalOutput ?? "";
		const tmpFile = path.join(dir, `.tmp-output-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		try {
			await fs.promises.writeFile(tmpFile, body, { encoding: "utf-8", mode: 0o600, flag: "wx" });
			await fs.promises.chmod(tmpFile, 0o600);
			await fs.promises.rename(tmpFile, resolved);
		} finally {
			await fs.promises.unlink(tmpFile).catch(() => {});
		}
		r.outputPath = resolved;
		// Default file-only when output is set; inline opts back in.
		r.outputMode = outputMode ?? "file-only";
		r.outputBytes = Buffer.byteLength(body, "utf-8");
		r.outputLineCount = body === "" ? 0 : body.split("\n").length;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		r.stderrTail = [...r.stderrTail, `failed to write output to ${resolved}: ${msg}`];
	}
}

// ----------------------------------------------------------- status --

/**
 * Terminal lifecycle state of a run. `accepted` (reviewer approved) and
 * `completed` (no reviewer) are both successes; `rejected`, `failed`, and
 * `error` are failures with different origins. Cause lives in `reason.code`.
 */
export function renderStatus(r: SwivalResult): RunStatus {
	if (r.nativeAudit) return isRunFailure(r) ? "failed" : "completed";
	if (r.exitCode === -1) return "running";
	if (r.exitCode !== 0) return "failed";
	if (r.report?.outcome === "error") return "error";
	if (r.report?.outcome === "failed") return "rejected";
	if (r.report?.outcome === "interrupted") return "failed";
	if (r.report?.outcome === "success") return (r.report.reviewRounds ?? 0) > 0 ? "accepted" : "completed";
	// Exit zero with a missing or unknown report fails closed.
	return "error";
}

const formatDuration = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Header meta string: "opus-reviewed · 3 rounds · 8 tool calls · 12.4s · accepted". */
function buildHeaderMeta(r: SwivalResult): string {
	const parts: string[] = [];
	if (r.report?.model) parts.push(r.report.model);
	const rounds = r.report?.reviewRounds;
	if (typeof rounds === "number" && rounds > 0) parts.push(plural(rounds, "round"));
	const turns = r.report?.turns;
	if (typeof turns === "number" && turns > 0) parts.push(plural(turns, "turn"));
	const toolCalls = r.report?.toolCallsTotal;
	if (typeof toolCalls === "number" && toolCalls > 0) parts.push(plural(toolCalls, "tool call"));
	const cachedTokens = r.report?.promptCache?.cachedTokens;
	if (typeof cachedTokens === "number" && cachedTokens > 0) parts.push(`${(cachedTokens / 1000).toFixed(1)}k cached`);
	if (r.durationMs) parts.push(formatDuration(r.durationMs));
	parts.push(renderStatus(r));
	return parts.join(" · ");
}

// ------------------------------------------------- parallel summary --

/**
 * Per-task summary for parallel mode. File-only outputs show path and size
 * metadata; inline outputs show the body under the caller's cap; failed
 * tasks omit their interrupted stdout. The header uses neutral "M/N ok".
 */
export function buildParallelSummary(results: readonly SwivalResult[], opts: { maxInlineBytes?: number } = {}): string {
	const ok = results.filter((r) => !isRunFailure(r)).length;
	const blocks = results.map((r, i) => {
		const status = renderStatus(r);
		const statusLabel = isRunFailure(r) && r.reason ? `${status}/${r.reason.code}` : status;
		const turns = r.report?.turns;
		let turnsLabel = "";
		if (typeof turns === "number" && turns > 0) {
			turnsLabel = typeof r.effectiveMaxTurns === "number" && r.effectiveMaxTurns > 0
				? `, ${turns}/${r.effectiveMaxTurns} turns` : `, ${plural(turns, "turn")}`;
		}
		const lines: string[] = [`=== [${i}] ${r.agent} (${statusLabel}${turnsLabel}) ===`];
		if (isRunFailure(r) && r.errorMessage) lines.push(`error: ${r.errorMessage.replace(/\n/g, " ").trim()}`);
		if (r.artifactDir) lines.push(`artifacts: ${r.artifactDir}`);
		const hasOutputFile = Boolean(r.outputPath);
		if (hasOutputFile && r.outputMode !== "inline") {
			const meta: string[] = [];
			if (typeof r.outputLineCount === "number") meta.push(plural(r.outputLineCount, "line"));
			if (typeof r.outputBytes === "number") meta.push(`${r.outputBytes} bytes`);
			lines.push("", `→ ${r.outputPath}${meta.length > 0 ? ` (${meta.join(", ")})` : ""}`);
		} else if (!isRunFailure(r)) {
			if (hasOutputFile) lines.push(`output file: ${r.outputPath}`);
			const body = r.finalOutput ?? "";
			if (body.length > 0) lines.push("", applyInlineCap(body, opts.maxInlineBytes, r.artifactDir ?? r.outputPath ?? "report.json"));
		}
		return lines.join("\n");
	});
	return [`swival parallel: ${ok}/${results.length} ok`, "", ...blocks].join("\n");
}

// --------------------------------------------------------- catalogue --

const MAX_CATALOGUE_ROWS = 20;
const MAX_CATALOGUE_DESCRIPTION_CHARS = 160;
const MAX_CATALOGUE_TEXT_CHARS = 8192;

function catalogueText(value: string, cap: number): string {
	const clean = value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
	return clean.length > cap ? `${clean.slice(0, cap - 1)}…` : clean;
}

/** Schema v1 row fields that every agent shares; effective runtime is never claimed. */
const STATIC_CATALOGUE_ROW_FIELDS = {
	effectiveRuntime: "unknown",
	modes: ["single", "parallel", "chain"],
	async: "single-only",
	controls: { status: true, resume: "completed-output-only", interrupt: "same-process-only", liveSteering: false },
} as const;

export function buildAgentCatalogue(discovery: SwivalAgentDiscoveryResult, agentScope: AgentScope) {
	return {
		mode: "list" as const,
		schemaVersion: 1 as const,
		agentScope,
		total: discovery.agents.length,
		omitted: Math.max(0, discovery.agents.length - MAX_CATALOGUE_ROWS),
		agents: discovery.agents.slice(0, MAX_CATALOGUE_ROWS).map((agent) => ({
			name: agent.name,
			description: catalogueText(agent.description, MAX_CATALOGUE_DESCRIPTION_CHARS),
			source: agent.source,
			reviewer: {
				required: agent.requiresReviewer === true,
				selfReview: agent.selfReview ?? "unknown",
				externalReviewer: agent.reviewer === undefined ? "unknown" : Boolean(agent.reviewer),
			},
			configured: { sandbox: agent.sandbox ?? "unknown", network: agent.network ?? "unknown" },
			...STATIC_CATALOGUE_ROW_FIELDS,
		})),
		diagnostics: discovery.diagnostics,
		diagnosticsTotal: discovery.diagnosticsTotal,
		diagnosticsOmitted: discovery.diagnosticsOmitted,
		// Retained on catalogue schema v1 for consumer compatibility; discovery blocks only invalid requested names.
		dispatchBlocked: false as const,
	};
}

export type SwivalCatalogueDetails = ReturnType<typeof buildAgentCatalogue>;

export function formatAgentCatalogue(details: SwivalCatalogueDetails): string {
	const lines = [
		`Swival agent catalogue v${details.schemaVersion}: ${details.total} total, ${details.agents.length} shown, ${details.omitted} omitted.`,
		"Configured values are sanitized declarations, not effective runtime guarantees; effective runtime is unknown.",
		"Modes: single, parallel, chain. Async: single-only. Status: progress/final report. Resume: completed output only. Interrupt: same-process only. Live steering: unsupported.",
		...details.agents.map((agent) =>
			`${agent.name} (${agent.source}): ${agent.description} | reviewer required: ${agent.reviewer.required}; configured sandbox: ${agent.configured.sandbox}, network: ${agent.configured.network}`),
		`Discovery diagnostics: ${details.diagnosticsTotal} total, ${details.diagnosticsOmitted} omitted. ` +
			(details.diagnostics.map((d) => `${d.source}:${d.code}`).join(", ") || "none"),
	];
	const text = lines.join("\n");
	const marker = "\n[Catalogue text truncated; bounded rows remain in details.]";
	return text.length > MAX_CATALOGUE_TEXT_CHARS ? text.slice(0, MAX_CATALOGUE_TEXT_CHARS - marker.length) + marker : text;
}

// ---------------------------------------------------------- Pi TUI --

type Theme = { fg(color: string, text: string): string; bold(text: string): string };

interface RenderCallArgs {
	audit?: unknown;
	profileOverride?: unknown;
	agentScope?: AgentScope;
	action?: string;
	agent?: string;
	task?: string;
	tasks?: Array<{ agent: string; task: string }>;
	chain?: Array<{ agent: string; task: string }>;
	[key: string]: unknown;
}

export function renderSwivalCall(args: RenderCallArgs, theme: Theme): Text {
	const title = (label: string) => theme.fg("toolTitle", theme.bold(label));
	if ("audit" in args) {
		const selection = args.profileOverride !== undefined ? "explicit profile"
			: Object.keys(args).some((key) => key.endsWith("Override")) ? "explicit overrides" : "configured defaults";
		return new Text(title("swival native audit ") + theme.fg("muted", `[${selection}]`), 0, 0);
	}
	const scope: AgentScope = args.agentScope ?? "user";
	if (args.action === "list") return new Text(title("swival list ") + theme.fg("muted", `[${scope}]`), 0, 0);
	const preview = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text);
	if (args.chain && args.chain.length > 0) {
		let text = title("swival ") + theme.fg("accent", `chain (${args.chain.length} steps)`) + theme.fg("muted", ` [${scope}]`);
		for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
			const step = args.chain[i];
			text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)}${theme.fg("dim", ` ${preview(step.task.replace(/\{previous\}/g, "").trim(), 40)}`)}`;
		}
		if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}
	if (args.tasks && args.tasks.length > 0) {
		let text = title("swival ") + theme.fg("accent", `parallel (${args.tasks.length} tasks)`) + theme.fg("muted", ` [${scope}]`);
		for (const t of args.tasks.slice(0, 3)) text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview(t.task, 50)}`)}`;
		if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}
	const text = title("swival ") + theme.fg("accent", args.agent || "...") + theme.fg("muted", ` [${scope}]`) +
		`\n  ${theme.fg("dim", args.task ? preview(args.task, 60) : "...")}`;
	return new Text(text, 0, 0);
}

export function renderSwivalResult(
	result: { content: Array<{ type: string; text?: string }>; details?: SwivalDetails | { mode: "list" } },
	expanded: boolean,
	theme: Theme,
	parseNativeRoute: (value: unknown) => NativeRoute,
): Text | Container {
	const details = result.details;
	if (!details || details.mode === "list" || details.results.length === 0) {
		const t = result.content[0];
		return new Text(t?.type === "text" && t.text !== undefined ? t.text : "(no output)", 0, 0);
	}
	const mdTheme = getMarkdownTheme();
	const line = (text: string) => new Text(text, 0, 0);

	const renderOne = (r: SwivalResult, container: Container) => {
		const icon = r.exitCode === -1 ? theme.fg("warning", "⏳") : isRunFailure(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
		container.addChild(line(`${icon} ${theme.fg("accent", r.agent)} ${theme.fg("muted", buildHeaderMeta(r))}`));
		container.addChild(line(theme.fg("muted", "Task: ") + theme.fg("dim", r.task)));
		if (r.nativeAudit) {
			let route: NativeRoute | undefined;
			try { route = parseNativeRoute(r.nativeAudit.route); } catch { /* Do not render unvalidated saved route values. */ }
			container.addChild(line(theme.fg("muted", `Native audit: ${r.nativeAudit.status}` +
				(route ? `; ${route.provider}/${route.model}${route.endpoint ? `; endpoint=${route.endpoint}` : ""}` : ""))));
		}
		if (r.errorMessage) container.addChild(line(theme.fg("error", r.errorMessage)));
		if (r.versionAdvisory) container.addChild(line(theme.fg("warning", `⚠ ${r.versionAdvisory}`)));
		if (r.report?.security?.commandPolicyBlocks) {
			container.addChild(line(theme.fg("warning", `⚠ ${r.report.security.commandPolicyBlocks} command(s) blocked by security policy`)));
		}
		if (r.report?.stormedCalls) container.addChild(line(theme.fg("warning", `⚠ ${r.report.stormedCalls} repeat call(s) suppressed by storm breaker`)));
		// Per-tool-call progress from trace tailing: a recent slice while running, everything when expanded.
		const toolCallEvents = (r.traceEvents ?? []).filter((e): e is TraceToolCall => e.type === "toolCall");
		const previewLimit = expanded ? toolCallEvents.length : 6;
		if (toolCallEvents.length > 0 && (expanded || r.exitCode === -1)) {
			container.addChild(new Spacer(1));
			container.addChild(line(theme.fg("muted", "─── tool calls ───")));
			if (toolCallEvents.length > previewLimit) container.addChild(line(theme.fg("dim", `… ${toolCallEvents.length - previewLimit} earlier calls omitted`)));
			for (const ev of toolCallEvents.slice(-previewLimit)) {
				const marker = ev.ok === true ? theme.fg("success", "✓ ") : ev.ok === false ? theme.fg("error", "✗ ") : theme.fg("muted", "→ ");
				const argsStr = Object.keys(ev.args).length > 0 ? JSON.stringify(ev.args) : "";
				const preview = argsStr.length > 60 ? `${argsStr.slice(0, 60)}…` : argsStr;
				container.addChild(line(marker + theme.fg("accent", ev.name) + (preview ? " " + theme.fg("dim", preview) : "")));
			}
		}
		const fb = r.report?.lastReviewFeedback;
		if (fb && (expanded || r.report?.accepted === false)) {
			container.addChild(new Spacer(1));
			container.addChild(line(theme.fg("muted", "─── reviewer feedback ───")));
			container.addChild(line(theme.fg("dim", fb)));
		}
		if (expanded && r.stderrTail.length > 0) {
			container.addChild(new Spacer(1));
			container.addChild(line(theme.fg("muted", "─── stderr tail ───")));
			for (const entry of r.stderrTail) container.addChild(line(theme.fg("dim", entry)));
		}
		if (r.finalOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(r.finalOutput.trim(), 0, 0, mdTheme));
		}
		if (expanded) {
			const statParts: string[] = [];
			if (typeof r.report?.llmCalls === "number") statParts.push(`${r.report.llmCalls} llm calls`);
			if (typeof r.report?.totalLlmTimeS === "number") statParts.push(`llm ${r.report.totalLlmTimeS.toFixed(1)}s`);
			if (typeof r.report?.totalToolTimeS === "number" && r.report.totalToolTimeS > 0) statParts.push(`tools ${r.report.totalToolTimeS.toFixed(1)}s`);
			if (typeof r.report?.compactions === "number" && r.report.compactions > 0) statParts.push(plural(r.report.compactions, "compaction"));
			const by = r.report?.toolCallsByName;
			if (by && Object.keys(by).length > 0) {
				statParts.push(Object.entries(by).map(([name, v]) => {
					const ok = v.succeeded ?? 0;
					const fail = v.failed ?? 0;
					return fail > 0 ? `${name}:${ok}/${ok + fail}` : `${name}:${ok}`;
				}).sort().join(" "));
			}
			if (statParts.length > 0) {
				container.addChild(new Spacer(1));
				container.addChild(line(theme.fg("dim", statParts.join(" · "))));
			}
		}
	};

	const container = new Container();
	if (details.diagnosticsTotal && details.diagnosticsTotal > 0) {
		const codes = (details.diagnostics ?? []).map((d) => `${d.source}:${d.code}`).join(", ");
		container.addChild(line(theme.fg("warning", `⚠ Discovery diagnostics: ${details.diagnosticsTotal} total, ${details.diagnosticsOmitted ?? 0} omitted` + (codes ? ` (${codes})` : ""))));
		container.addChild(new Spacer(1));
	}
	if (details.mode === "single") {
		renderOne(details.results[0], container);
		return container;
	}
	const ok = details.results.filter((r) => !isRunFailure(r)).length;
	const running = details.results.filter((r) => r.exitCode === -1).length;
	if (details.mode === "chain") {
		const icon = running > 0 ? theme.fg("warning", "⏳") : ok === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
		container.addChild(line(`${icon} ${theme.fg("toolTitle", theme.bold("swival chain "))}${theme.fg("accent", `${ok}/${details.results.length} steps`)}`));
		details.results.forEach((r, i) => {
			container.addChild(new Spacer(1));
			container.addChild(line(theme.fg("muted", `─── step ${i + 1} ───`)));
			renderOne(r, container);
		});
		return container;
	}
	const icon = running > 0 ? theme.fg("warning", "⏳") : ok === details.results.length ? theme.fg("success", "✓") : theme.fg("warning", "◐");
	container.addChild(line(`${icon} ${theme.fg("toolTitle", theme.bold("swival parallel "))}${theme.fg("accent", `${ok}/${details.results.length}`)}`));
	for (const r of details.results) {
		container.addChild(new Spacer(1));
		renderOne(r, container);
	}
	return container;
}
