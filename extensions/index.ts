/**
 * Pi extension entrypoint: registers the `swival-subagent` dispatcher and the
 * `swival-native-audit` tool, owns per-session observation and native-run
 * shutdown, and routes each call to the planner, process owner, artifact
 * layer, renderer, or native audit boundary. Everything else is re-exported
 * from its owning module.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AgentScope, type SwivalAgentConfig, discoverSwivalAgents } from "./agents.js";
import {
	type AsyncObservation, type AsyncOwner, ASYNC_OBSERVATION_CHANNEL, captureAsyncOwner, createAsyncObservation,
} from "./async-observation.js";
import {
	SwivalParams, asyncOptionError, buildOverridesFromParams, getSwivalArgumentError, isMutatingCwdAgent,
	resolveAgentBaseDir, resolveDispatchCwd, unknownAgentMessage, NativeAuditToolParams,
} from "./args.js";
import {
	asyncRecoverySource, findRunMeta, formatCompletedAsyncFailure, inspectCompletedAsyncRun, isNativeArtifact,
	loadRunState, mintArtifactDir, pruneOldArtifacts, readLocalAsyncRunObservations, subscribeAsyncRunChanges,
} from "./artifacts.js";
import {
	ARTIFACT_ROOT, DEFAULT_CONCURRENCY, MAX_CONCURRENCY, MAX_PARALLEL_TASKS,
	type NativeAuditLaunch, type SwivalDetails, type SwivalExtensionOptions, type SwivalOverrides, type SwivalResult,
} from "./contracts.js";
import { captureNativeRuntime, inspectNativeAudit, parseNativeRoute, prepareNativeAudit, validateNativeAuditParams } from "./native-audit.js";
import { type OnUpdateCallback, mapWithConcurrency, runSingleSwival, runSingleSwivalAsync, scheduleProcessGroupKillEscalation } from "./process.js";
import {
	type SwivalCatalogueDetails, applyInlineCap, buildAgentCatalogue, buildParallelSummary, formatAgentCatalogue,
	renderSwivalCall, renderSwivalResult, writeRunOutput,
} from "./render.js";
import { isRunFailure } from "./report.js";

// ------------------------------------------------------- re-exports --

export type {
	AsyncRunState, CompletedMarker, EffectiveProviderTimeout, FailureReason, LaunchPlan, LiveRunHandle, NativeAuditResult,
	ReasonCode, RecoveredRun, ReportSummary, RunMeta, RunStatus, SwivalDetails, SwivalExtensionOptions, SwivalOverrides,
	SwivalResult, SwivalVersionCheck, TraceEvent, TraceText, TraceToolCall,
} from "./contracts.js";
export {
	ANTHROPIC_OAUTH_SHIM_DIR, ARTIFACT_ROOT, MAX_CONCURRENCY, MAX_PARALLEL_TASKS, MIN_COMPATIBLE_SWIVAL_VERSION,
	RECOMMENDED_SWIVAL_VERSION, SwivalArgumentError,
} from "./contracts.js";
export type {
	AgentDiscoveryCode, AgentDiscoveryDiagnostic, AgentScope, AgentSource, SwivalAgentConfig, SwivalAgentDiscoveryResult,
} from "./agents.js";
export { discoverSwivalAgents } from "./agents.js";
export {
	ChainItem, NativeAuditToolParams, SwivalParams, TaskItem, buildOverridesFromParams, buildSwivalArgs, checkRequiresReviewer,
	getSwivalArgumentError, isAgentFsRequested, isMutatingCwdAgent, isNonoRequested, isReexecSandboxRequested, planSwivalLaunch,
	resolveAgentBaseDir, resolveDispatchCwd, unknownAgentMessage,
} from "./args.js";
export {
	readConfiguredAllowedDirsRo, resolveEffectiveProviderTimeout, resolveLinkedWorktreeCommonGitDir,
	resolveSwivalChildEnv, resolveSwivalReviewEnv,
} from "./child-env.js";
export { compareSemver, parseEffectiveProviderTimeout, parseSemver, readAnthropicAuthToken } from "./paths.js";
export {
	evaluateSwivalVersion, mapWithConcurrency, preflightSwivalVersion, resetSwivalVersionCache, runSingleSwival,
	runSingleSwivalAsync, scheduleProcessGroupKillEscalation, startTraceTail, terminateProcessGroup,
} from "./process.js";
export {
	agentFsBootstrapFailure, enforceAgentFsBootstrap, enforceCompletedAsyncAgentFs, enforceCompletedAsyncNono,
	enforceNonoBootstrap, findRunMeta, loadRunState, nonoBootstrapFailure, persistArtifacts, pruneOldArtifacts,
	readAsyncRunObservations, verifySandboxBootstrap,
} from "./artifacts.js";
export { classifyFailure, computeErrorMessage, isRunFailure, summarizeReport, terminalFailureReason } from "./report.js";
export { applyInlineCap, buildAgentCatalogue, buildParallelSummary, formatAgentCatalogue, renderStatus, writeRunOutput } from "./render.js";

// ------------------------------------------------------ native runs --

type ToolResult<D> = AgentToolResult<D>;
const textResult = <D>(text: string, details: D, isError = false): ToolResult<D> => ({ content: [{ type: "text", text }], details, isError });

/** One registrar's native runs: preparation, live handles, and the shutdown drain. */
function createNativeAuditSession(options: SwivalExtensionOptions, artifactRoot: string) {
	const nativeRuntime = captureNativeRuntime(options.nativePython);
	const nativeMaxTimeoutMs = options.nativeMaxTimeoutMs ?? 30 * 60_000;
	const nativeRuns = new Set<NativeAuditLaunch>();
	// Track the whole operation, including preparation and post-run inspection.
	// These promises only resolve, so rejected preparation/finalization cannot
	// leave an unhandled rejection or prevent the shutdown drain.
	const nativeOperations = new Map<AbortController, Promise<void>>();
	const shutdownReason = "Native audit cancelled during session shutdown.";
	let shutdowns = 0;
	return {
		/** Idempotent session-shutdown drain; safe to call repeatedly and concurrently. */
		async shutdown() {
			shutdowns++;
			try {
				while (nativeOperations.size) {
					for (const run of nativeRuns) run.cancel(shutdownReason);
					for (const controller of nativeOperations.keys()) controller.abort();
					await Promise.allSettled([...nativeOperations.values()]);
				}
			} finally { shutdowns--; }
		},
		/** Validate, prepare, and run one synchronous native audit from the session cwd. */
		async execute(input: Record<string, unknown>, cwd: string, signal: AbortSignal | undefined): Promise<ToolResult<SwivalDetails | undefined>> {
			const controller = new AbortController();
			const abort = () => controller.abort();
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			let finishOperation!: () => void;
			nativeOperations.set(controller, new Promise<void>((resolve) => { finishOperation = resolve; }));
			// A drain is temporary: do not change reuse after session_shutdown.
			if (shutdowns) controller.abort();
			let run: NativeAuditLaunch | undefined;
			try {
				const audit = validateNativeAuditParams(input);
				if (!Number.isInteger(nativeMaxTimeoutMs) || nativeMaxTimeoutMs < 1 || nativeMaxTimeoutMs > 2_147_483_647) {
					throw new Error("Invalid native timeout ceiling.");
				}
				const { artifactDir, runId } = mintArtifactDir("native-audit", artifactRoot);
				run = await prepareNativeAudit(cwd, input, audit, nativeRuntime, artifactDir, runId, nativeMaxTimeoutMs, controller.signal);
				nativeRuns.add(run);
				// Defensively stop a live handle returned after cancellation, even
				// if preparation did not observe its signal before returning.
				if (controller.signal.aborted) run.cancel(shutdowns ? shutdownReason : undefined);
				const routeText = `Resolved native route: ${run.route.provider}/${run.route.model}` +
					(run.route.endpoint ? `; endpoint=${run.route.endpoint}` : "") +
					(run.route.profile ? `; profile=${run.route.profile}` : "") +
					(run.route.reasoningEffort ? `; effort=${run.route.reasoningEffort}` : "");
				const terminal = await run.completion;
				const nativeAudit = { ...await inspectNativeAudit(artifactDir, terminal.exitCode), route: run.route };
				const maxInlineBytes = typeof input.maxInlineBytes === "number" ? input.maxInlineBytes : 64 * 1024;
				const result: SwivalResult = { agent: "native-audit", agentSource: "bundled", task: run.meta.task,
					exitCode: terminal.exitCode, nativeAudit, stderrTail: [], durationMs: Date.now() - run.meta.startedAt,
					artifactDir, errorMessage: nativeAudit.error,
					finalOutput: applyInlineCap(nativeAudit.answer ?? "", maxInlineBytes, path.join(artifactDir, "evidence", "native-cli-report.json")) };
				return textResult(`Native audit status: ${nativeAudit.status}. ${routeText}\n${nativeAudit.error ?? result.finalOutput}\nSource-only verifier judgment; patches are proposals.\nArtifact dir: ${artifactDir}`,
					{ mode: "single", agentScope: "user", projectAgentsDir: null, results: [result] } satisfies SwivalDetails, isRunFailure(result));
			} catch (error) {
				return textResult((error as Error).message, undefined, true);
			} finally {
				signal?.removeEventListener("abort", abort);
				if (run) nativeRuns.delete(run);
				nativeOperations.delete(controller);
				finishOperation();
			}
		},
	};
}

/**
 * Register only the synchronous native audit tool. Nothing loads this
 * automatically: an explicitly configured consumer calls it instead of the
 * default export when a session must not receive general Swival dispatch.
 * The native path, repository-root policy, lifecycle, and shutdown drain are
 * the ones the default `swival-subagent` tool uses for its `audit` input.
 */
export function registerNativeAuditTool(pi: ExtensionAPI, options: SwivalExtensionOptions = {}): void {
	const artifactRoot = path.resolve(process.cwd(), options.artifactRoot ?? ARTIFACT_ROOT);
	const nativeAudit = createNativeAuditSession(options, artifactRoot);
	pi.on?.("session_shutdown", () => nativeAudit.shutdown());
	pi.registerTool<typeof NativeAuditToolParams, SwivalDetails | undefined>({
		name: "swival-native-audit",
		label: "Swival native audit",
		description: [
			"Run one synchronous, source-only Swival native audit of the committed tree at the session's repository-root working directory.",
			"Requires the audit object; accepts only native selection and bounding fields. encryptSecretsOverride accepts only false.",
			"No agent, task, parallel, chain, control actions, cwd, async, network, sandbox, or credential inputs; patches are proposals and never applied.",
		].join(" "),
		promptSnippet: "Run one synchronous source-only Swival native audit of the committed repository tree",
		promptGuidelines: [
			"Use swival-native-audit only for an explicitly requested native audit of committed source; it cannot delegate tasks, run commands, or apply patches.",
		],
		parameters: NativeAuditToolParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const input = params as unknown as Record<string, unknown>;
			// The declared schema is also the execution boundary, so a direct call
			// cannot reach fields the model never sees (including async: false).
			const undeclared = Object.keys(input).filter((key) => !Object.hasOwn(NativeAuditToolParams.properties, key));
			if (undeclared.length) return textResult(`Native audit accepts only its declared fields; remove ${undeclared.join(", ")}.`, undefined, true);
			return nativeAudit.execute(input, ctx.cwd, signal);
		},
	});
}

// ------------------------------------------------- control actions --

type DispatchParams = Record<string, any>;
type MakeDetails = (results: SwivalResult[]) => SwivalDetails;

/** status / interrupt / resume over live handles first, then disk metadata that never gains signalling authority. */
async function controlAction(params: DispatchParams, artifactRoot: string, details: MakeDetails): Promise<ToolResult<SwivalDetails>> {
	const runId = params.id as string | undefined;
	if (!runId) return textResult(`\`id\` is required when \`action\` is set (got action="${params.action}").`, details([]), true);
	const saved = await findRunMeta(runId, artifactRoot);
	if (runId.startsWith("native-audit-") || saved && (saved.nativeAuditRequested || await isNativeArtifact(saved.artifactDir))) {
		return textResult("Native async and disk recovery are unsupported. A crashed audit may remain running; no export or claimed completion is available.", details([]), true);
	}
	const state = await loadRunState(runId, artifactRoot);
	const where = (text: string) => `${text}\nArtifact dir: ${state!.meta.artifactDir}`;
	if (params.action === "interrupt") {
		if (!state || state.exited) return textResult(`Run ${runId} is not running (already completed or not found) — nothing to interrupt.`, details([]), true);
		if (state.kind !== "live") return textResult(`Run ${runId} was recovered from disk. Its process identity cannot be verified, so it cannot safely interrupt the recorded PID.`, details([]), true);
		const pid = state.meta.pid;
		if (pid == null) return textResult(`Run ${runId} has no recorded PID — cannot interrupt.`, details([]), true);
		if (!Number.isInteger(pid) || pid < 2 || pid === process.pid) return textResult(`Run ${runId} has an invalid recorded PID (${pid}) — refusing to signal.`, details([]), true);
		// Signal the whole owned group so nested tools stop too; escalate to SIGKILL if SIGTERM is ignored.
		try { process.kill(-pid, "SIGTERM"); }
		catch { return textResult(`Run ${runId} is not running (pid ${pid} not found). It may have already completed.`, details([]), true); }
		scheduleProcessGroupKillEscalation(state.proc, pid);
		return textResult(`Sent SIGTERM to process group of run ${runId} (pgid: ${pid}). SIGKILL escalation scheduled in 5 s.`, details([]));
	}
	if (!state) return textResult(`Run ${runId} not found. It may have been pruned or was never started.`, details([]), true);
	// A recorded startup failure is terminal even when the runner never wrote completed.json.
	if (state.kind === "recovered" && state.spawnError) return textResult(where(`Run ${runId} failed to start: ${state.spawnError}`), details([]), true);
	if (!state.exited) {
		// Only a live owned handle proves the run is still executing. A disk-recovered PID is never probed or signalled.
		if (state.kind !== "live") {
			return params.action === "status"
				? textResult(where(`Run ${runId} status is unknown (recovered from disk without a valid completed.json; process liveness cannot be verified).`), details([]))
				: textResult(where(`Run ${runId} completion is unknown (recovered from disk without a valid completed.json; process liveness cannot be verified). Output is unavailable until a verified completion marker exists.`), details([]), true);
		}
		return params.action === "status"
			? textResult(where(`Run ${runId} is still running (pid: ${state.meta.pid ?? "unknown"}).`), details([]))
			: textResult(`Run ${runId} is still in progress (pid: ${state.meta.pid ?? "unknown"}). Wait for it to complete, or interrupt it first.`, details([]), true);
	}
	const inspection = await inspectCompletedAsyncRun(state);
	if (inspection.reason) return textResult(formatCompletedAsyncFailure(runId, state, inspection.reason), details([]), true);
	const outcome = inspection.report?.outcome ?? "unknown";
	if (params.action === "status") {
		return textResult(where(`Run ${runId} completed (exit ${state.exitCode ?? "?"}, outcome: ${outcome}, exitedAt: ${state.completed?.exitedAt ?? "unknown"}).`), details([]));
	}
	// Read final output only after terminal success is established.
	const stdoutContent = await fs.promises.readFile(state.meta.stdoutFile, "utf-8").catch(() => "");
	const finalOutput = (inspection.report?.answer?.trim() || stdoutContent.trim()) || "(no output)";
	const feedback = inspection.report?.lastReviewFeedback;
	let text = `Run ${runId} (${state.meta.agent}) — outcome: ${outcome}\nArtifact dir: ${state.meta.artifactDir}\n\n${finalOutput}`;
	if (feedback) text += `\n\n─── reviewer feedback ───\n${feedback}`;
	return textResult(text, details([]));
}

// ------------------------------------------------------- dispatcher --

const inlineOutput = (r: SwivalResult, maxInlineBytes: number | undefined) =>
	r.outputPath && r.outputMode === "file-only"
		? `→ ${r.outputPath} (${r.outputLineCount ?? 0} lines, ${r.outputBytes ?? 0} bytes)`
		: applyInlineCap(r.finalOutput || "(no output)", maxInlineBytes, r.artifactDir ?? r.outputPath);

export default function (pi: ExtensionAPI, options: SwivalExtensionOptions = {}) {
	const resolutionBase = process.cwd();
	const artifactRoot = path.resolve(resolutionBase, options.artifactRoot ?? ARTIFACT_ROOT);
	let observation: { owner: AsyncOwner; observer: AsyncObservation } | undefined;
	let observationOwnerSessionId: string | undefined;
	let observationGeneration = 0;
	const startObservation = (owner: AsyncOwner | undefined, replace = false) => {
		if (!replace && observation?.owner.ownerSessionId === owner?.ownerSessionId
			&& observation?.owner.ownerSessionFile === owner?.ownerSessionFile) return;
		observation?.observer.dispose();
		observation = undefined;
		if (!owner || !options.observationAdapter) return;
		let truncationReported = false;
		const onTruncated = () => {
			if (truncationReported) return;
			truncationReported = true;
			try { options.onObservationDiagnostic?.("Async observation truncated; showing 100 live runs."); }
			catch { /* Observation cannot affect execution. */ }
		};
		const observer = createAsyncObservation({
			owner, adapter: options.observationAdapter,
			readLocalSnapshot: (ids) => readLocalAsyncRunObservations(owner.ownerSessionId, artifactRoot, ids, onTruncated),
			recovery: asyncRecoverySource(owner.ownerSessionId, artifactRoot, resolutionBase),
			subscribe: subscribeAsyncRunChanges,
			emitWake: (data) => { pi.events.emit(ASYNC_OBSERVATION_CHANNEL, data); },
			onDiagnostic: options.onObservationDiagnostic,
		});
		observation = { owner, observer };
		return observer.refresh();
	};
	pi.on?.("session_start", (_event, ctx) => {
		const owner = captureAsyncOwner(ctx.sessionManager);
		observationOwnerSessionId = owner?.ownerSessionId;
		observationGeneration++;
		return startObservation(owner, true);
	});
	const nativeAudit = createNativeAuditSession(options, artifactRoot);
	pi.on?.("session_shutdown", async (_event, ctx) => {
		const owner = captureAsyncOwner(ctx?.sessionManager);
		if (owner && observationOwnerSessionId === owner.ownerSessionId) {
			observationGeneration++;
			observationOwnerSessionId = undefined;
			observation?.observer.dispose();
			observation = undefined;
		}
		await nativeAudit.shutdown();
	});
	const trustProjectAgents = () => options.trustProjectAgents === true ||
		process.env.PI_SWIVAL_TRUST_PROJECT_AGENTS === "1" || process.env.PI_SWIVAL_TRUST_PROJECT_AGENTS === "true";

	pi.registerTool<typeof SwivalParams, SwivalDetails | SwivalCatalogueDetails | undefined>({
		name: "swival-subagent",
		label: "Swival subagent",
		description: [
			"Delegate a task to a swival subprocess with its built-in reviewer loop.",
			"Use action:list for a bounded capability catalogue without launching Swival.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with '{previous}' substitution), or native audit (audit object).",
			"Native mode uses synchronous upstream AgentFS CLI and provider-only policy for source-only verification. Native async is unsupported.",
			"Ordinary async supports single only; resume retrieves completed output, live steering is unsupported, and interrupt is same-process only.",
			"Bundled agents work out of the box; override or extend via ~/.pi/agent/swival-agents/ (user) or .pi/swival-agents/ (project).",
			"Use this when you want the reviewer loop, test-as-contract, sandbox overlay, or secret encryption to wrap the subagent's work.",
		].join(" "),
		// Without promptSnippet Pi omits custom tools from the "Available tools" list.
		promptSnippet: "Delegate to swival with reviewer loop, AgentFS sandbox, test-as-contract, or secret encryption",
		promptGuidelines: [
			"Use swival-subagent when a task benefits from swival's reviewer loop (retry until acceptance passes), a test-as-contract script, OS-enforced filesystem isolation via AgentFS, or format-preserving secret encryption — otherwise prefer simpler tools.",
		],
		parameters: SwivalParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const bare = (mode: SwivalDetails["mode"] = "single"): SwivalDetails => ({ mode, agentScope, projectAgentsDir: null, results: [] });
			const optionError = params.async && !("audit" in params) ? asyncOptionError(params) : undefined;
			if (optionError) return textResult(optionError, bare(), true);
			const launchOwner = params.async ? captureAsyncOwner(ctx.sessionManager) : undefined;
			// Shutdown must retire pending approval even before an observer exists.
			if (launchOwner && observationOwnerSessionId !== launchOwner.ownerSessionId) {
				observationOwnerSessionId = launchOwner.ownerSessionId;
				observationGeneration++;
			}
			const launchGeneration = observationGeneration;
			if (params.action === "list") {
				if (Object.keys(params).some((key) => !["action", "agentScope", "cwd"].includes(key))) {
					return textResult("action:list cannot be combined with dispatch or control inputs. Use only action, agentScope and cwd.", bare(), true);
				}
				const details = buildAgentCatalogue(discoverSwivalAgents(resolveDispatchCwd(undefined, params.cwd, ctx.cwd), agentScope), agentScope);
				return { content: [{ type: "text", text: formatAgentCatalogue(details) }], details };
			}
			if ("audit" in params) return nativeAudit.execute(params as unknown as Record<string, unknown>, ctx.cwd, signal);

			// Prune artifact dirs older than 7 days — fire-and-forget, never blocks.
			void pruneOldArtifacts(artifactRoot);
			// Project-agent discovery walks up from the directory the swival process
			// will run in, anchored to the top-level cwd for parallel/chain steps.
			const discoveryCwd = resolveDispatchCwd(undefined, params.cwd, ctx.cwd);
			const discovery = discoverSwivalAgents(discoveryCwd, agentScope);
			const agents = discovery.agents;
			const raw = params as unknown as Record<string, unknown>;
			const overrides = buildOverridesFromParams(raw);
			const discoveryMeta = discovery.diagnosticsTotal > 0
				? { diagnostics: discovery.diagnostics, diagnosticsTotal: discovery.diagnosticsTotal, diagnosticsOmitted: discovery.diagnosticsOmitted }
				: {};
			const withDiscoveryNote = (text: string) => discovery.diagnosticsTotal > 0
				? `${text}\n\nDiscovery diagnostics: ${discovery.diagnosticsTotal} total, ${discovery.diagnosticsOmitted} omitted (${discovery.diagnostics.map((d) => `${d.source}:${d.code}`).join(", ")}).`
				: text;
			const makeDetails = (mode: SwivalDetails["mode"]): MakeDetails => (results) => ({ mode, agentScope, projectAgentsDir: discovery.projectAgentsDir, results, ...discoveryMeta });
			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const multi = hasChain || hasTasks;
			const mode: SwivalDetails["mode"] = hasChain ? "chain" : hasTasks ? "parallel" : "single";

			if (params.async && multi) return textResult("`async: true` is only supported in single mode (agent + task). Remove `chain` or `tasks`, or omit `async`.", makeDetails("single")([]), true);
			// Multi-agent modes must not leak A2A credentials/egress or race a shared writable directory across tasks.
			if (raw.a2aConfigOverride && multi) return textResult("`a2aConfigOverride` is only supported in single mode (agent + task). Remove `chain` or `tasks`, or configure A2A in agent frontmatter.", makeDetails("single")([]), true);
			if (raw.addDirOverride && multi) return textResult("`addDirOverride` is only supported in single mode (agent + task). Use `addDirRoOverride` for read-only access or configure `addDir` in agent frontmatter.", makeDetails("single")([]), true);
			if (params.action) {
				const conflicting = (["agent", "task", "tasks", "chain", "async"] as const).filter((k) => params[k] != null && params[k] !== false);
				if (conflicting.length > 0) return textResult(`\`action\` cannot be combined with: ${conflicting.join(", ")}. Use \`action\` + \`id\` alone.`, makeDetails("single")([]), true);
				return controlAction(params, artifactRoot, makeDetails("single"));
			}

			// Only an omitted selector defaults to the generic agent; an explicit empty or
			// whitespace-only name fails closed below instead of silently becoming "swival".
			if (params.agent === undefined && params.task && !multi) params.agent = "swival";
			const hasSingle = Boolean(params.agent !== undefined && params.task);
			if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return textResult(`Invalid parameters. Provide exactly one mode (agent+task OR tasks[] OR chain[]).\nAvailable swival agents: ${available}`, makeDetails("single")([]), true);
			}
			const requestedNames = hasChain ? params.chain!.map((step) => step.agent) : hasTasks ? params.tasks!.map((task) => task.agent) : [params.agent as string];
			const blankSelector = requestedNames.find((name) => !name.trim());
			if (blankSelector !== undefined) {
				return textResult(unknownAgentMessage(blankSelector, agents), makeDetails(mode)([]), true);
			}
			if (requestedNames.some((name) => discovery.invalidAgentNames.includes(name))) {
				const cause = "An invalid agent definition shadows a requested name; lower-priority fallback is disabled.";
				const codes = discovery.diagnostics.map((d) => `${d.source}:${d.code}`).join(", ");
				return {
					content: [{ type: "text", text: `Swival agent discovery blocked dispatch: ${cause} Repair the definitions and use action:list to check discovery. Diagnostics: ${codes || "invalid_definition"}.` }],
					details: { ...makeDetails(mode)([]), projectAgentsDir: null, diagnostics: discovery.diagnostics,
						diagnosticsTotal: discovery.diagnosticsTotal, diagnosticsOmitted: discovery.diagnosticsOmitted },
					isError: true,
				};
			}

			// Project-local agent approval, mirroring pi's subagent extension.
			if ((agentScope === "project" || agentScope === "both") && !trustProjectAgents()) {
				const projectRequested = [...new Set(requestedNames)].map((n) => agents.find((a) => a.name === n))
					.filter((a): a is SwivalAgentConfig => a?.source === "project");
				if (projectRequested.length > 0) {
					const names = projectRequested.map((a) => a.name).join(", ");
					if (!ctx.hasUI) return textResult(`Refusing to run project-local swival agents (${names}) without UI confirmation. Set PI_SWIVAL_TRUST_PROJECT_AGENTS=1 to opt out, or invoke from an interactive session.`, makeDetails(mode)([]), true);
					const ok = await ctx.ui.confirm("Run project-local swival agents?",
						`Agents: ${names}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}\n\nProject swival agents are repo-controlled. Only continue for trusted repositories.`);
					if (!ok) return textResult("Canceled: project-local swival agents not approved.", makeDetails(mode)([]));
				}
			}
			const stepCwd = (cwd: string | undefined) => resolveDispatchCwd(cwd, params.cwd, ctx.cwd);
			const stepOverrides = (seed: number | undefined): SwivalOverrides => (seed !== undefined ? { ...overrides, seed } : overrides);

			if (hasChain) {
				const chain = params.chain!;
				if (chain.length > MAX_PARALLEL_TASKS) return textResult(`Too many chain steps (${chain.length}). Max is ${MAX_PARALLEL_TASKS}.`, makeDetails("chain")([]));
				const results: SwivalResult[] = [];
				let previousOutput = "";
				for (const [i, step] of chain.entries()) {
					const chainUpdate: OnUpdateCallback | undefined = onUpdate ? (partial) => {
						const current = partial.details?.results[0];
						if (current) onUpdate({ content: partial.content, details: makeDetails("chain")([...results, current]) });
					} : undefined;
					const r = await runSingleSwival(ctx.cwd, agents, step.agent, step.task.replace(/\{previous\}/g, () => previousOutput),
						stepCwd(step.cwd), stepOverrides(step.seed), signal, chainUpdate, makeDetails("chain"), artifactRoot);
					results.push(r);
					const isLastStep = i === chain.length - 1;
					const failed = isRunFailure(r);
					const stepOutput = step.output ?? (failed || isLastStep ? params.output : undefined);
					if (stepOutput) await writeRunOutput(r, stepOutput, step.outputMode ?? (failed || isLastStep ? params.outputMode : undefined), stepCwd(step.cwd));
					if (failed) {
						const partial = r.finalOutput?.trim();
						const headline = `swival chain stopped at step ${i + 1} (${step.agent}): ${r.errorMessage ?? "(no message)"}`;
						return textResult(withDiscoveryNote(partial ? `${headline}\n\n--- partial output ---\n${applyInlineCap(partial, params.maxInlineBytes, r.artifactDir)}` : headline), makeDetails("chain")(results), true);
					}
					previousOutput = r.finalOutput;
				}
				return textResult(withDiscoveryNote(inlineOutput(results[results.length - 1], params.maxInlineBytes)), makeDetails("chain")(results));
			}

			if (hasTasks) {
				const tasks = params.tasks!;
				if (tasks.length > MAX_PARALLEL_TASKS) return textResult(`Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`, makeDetails("parallel")([]));
				// Two write-capable tasks on one cwd race and silently lose edits; only
				// agents with files: none and commands: none are exempt.
				const cwdGroups = new Map<string, number[]>();
				for (const [i, t] of tasks.entries()) {
					const agent = agents.find((a) => a.name === t.agent);
					if (!agent) continue; // unknown-agent diagnostics happen per-task in runSingleSwival
					const perTaskOverrides = stepOverrides(t.seed);
					const runCwd = stepCwd(t.cwd);
					const argumentError = getSwivalArgumentError(agent, runCwd, perTaskOverrides);
					if (argumentError) return textResult(argumentError, makeDetails("parallel")([]), true);
					if (!isMutatingCwdAgent(agent, perTaskOverrides, runCwd)) continue;
					const resolvedBaseDir = resolveAgentBaseDir(agent, runCwd, perTaskOverrides);
					cwdGroups.set(resolvedBaseDir, [...(cwdGroups.get(resolvedBaseDir) ?? []), i]);
				}
				for (const [resolvedCwd, indices] of cwdGroups) {
					if (indices.length < 2) continue;
					const preview = indices.map((i) => `[${i}] ${tasks[i].agent}`).join(", ");
					return textResult(`Refusing to dispatch ${indices.length} write-capable tasks against the same cwd (${resolvedCwd}): ${preview}. ` +
						"Parallel filesystem writes on a shared cwd race and silently lose edits. Remedies: (a) dispatch them serially, (b) give each task " +
						"its own cwd (per-task cwd field, e.g. distinct git worktrees), or (c) use an agent with files: none and commands: none.",
						makeDetails("parallel")([]), true);
				}
				const placeholders: SwivalResult[] = tasks.map((t) => ({ agent: t.agent, agentSource: "unknown", task: t.task, exitCode: -1, finalOutput: "", stderrTail: [], durationMs: 0 }));
				const emitParallel = () => {
					if (!onUpdate) return;
					const running = placeholders.filter((r) => r.exitCode === -1).length;
					onUpdate({ content: [{ type: "text", text: `swival parallel: ${placeholders.length - running}/${placeholders.length} done, ${running} running` }],
						details: makeDetails("parallel")([...placeholders]) });
				};
				const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, params.concurrency ?? DEFAULT_CONCURRENCY));
				const results = await mapWithConcurrency(tasks, concurrency, async (t, idx) => {
					const r = await runSingleSwival(ctx.cwd, agents, t.agent, t.task, stepCwd(t.cwd), stepOverrides(t.seed), signal,
						(partial) => { if (partial.details?.results[0]) { placeholders[idx] = partial.details.results[0]; emitParallel(); } },
						makeDetails("parallel"), artifactRoot);
					// Relative output paths resolve against the task's cwd like shell redirections.
					if (t.output) await writeRunOutput(r, t.output, t.outputMode, stepCwd(t.cwd));
					placeholders[idx] = r;
					emitParallel();
					return r;
				});
				return textResult(withDiscoveryNote(buildParallelSummary(results, { maxInlineBytes: params.maxInlineBytes })), makeDetails("parallel")(results));
			}

			if (params.async) {
				if (launchGeneration === observationGeneration) void startObservation(launchOwner);
				let launched: { runId: string; artifactDir: string };
				try {
					launched = await runSingleSwivalAsync(ctx.cwd, agents, params.agent as string, params.task as string, discoveryCwd, overrides, artifactRoot, launchOwner);
				} catch (err) {
					return textResult(`Failed to start async run: ${err instanceof Error ? err.message : String(err)}`, makeDetails("single")([]), true);
				}
				return textResult(withDiscoveryNote([
					"Async swival run started.", `runId:        ${launched.runId}`, `agent:        ${params.agent}`, `artifactDir:  ${launched.artifactDir}`, "",
					`Use action:"status" id:"${launched.runId}" to check progress.`,
					`Use action:"resume" id:"${launched.runId}" to retrieve the final output when done.`,
					`Use action:"interrupt" id:"${launched.runId}" to cancel.`,
				].join("\n")), makeDetails("single")([]));
			}

			const result = await runSingleSwival(ctx.cwd, agents, params.agent as string, params.task as string, discoveryCwd, overrides, signal, onUpdate, makeDetails("single"), artifactRoot);
			if (params.output) await writeRunOutput(result, params.output, params.outputMode, stepCwd(undefined));
			if (isRunFailure(result)) return textResult(withDiscoveryNote(`swival agent failed (exit ${result.exitCode}): ${result.errorMessage ?? "(no message)"}`), makeDetails("single")([result]), true);
			return textResult(withDiscoveryNote(inlineOutput(result, params.maxInlineBytes)), makeDetails("single")([result]));
		},

		renderCall(args, theme) { return renderSwivalCall(args, theme); },
		renderResult(result, { expanded }, theme) { return renderSwivalResult(result, expanded, theme, parseNativeRoute); },
	});
}
