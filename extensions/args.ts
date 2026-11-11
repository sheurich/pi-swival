/**
 * Swival CLI planning: frontmatter coercion, dispatch guards, argv construction,
 * LaunchPlan assembly, and TypeBox tool parameter schemas driven by the shared
 * option descriptors in contracts.ts. Plain CLI flags iterate the descriptor
 * table; policy-coupled flags are enforced explicitly in buildSwivalArgs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum as PiStringEnum } from "@earendil-works/pi-ai";
import { type TSchema, type TUnsafe, Type } from "typebox";
import type { SwivalAgentConfig } from "./agents.js";
import {
	PROTECTED_HOME_SUBDIRS,
	assertSwivalReviewCompatibility,
	canonicalPathOrResolved,
	expandTildePath,
	readConfiguredAllowedDirsRo,
	resolveEffectiveProviderTimeout,
	resolveLinkedWorktreeCommonGitDir,
	resolveSwivalChildEnv,
	resolveSwivalReviewEnv,
	routeFromArgs,
} from "./child-env.js";
import {
	MAX_CONCURRENCY,
	NATIVE_PARAM_NAMES,
	SWIVAL_OPTION_DESCRIPTORS,
	type LaunchPlan,
	SwivalArgumentError,
	type SwivalOptionDescriptor,
	type SwivalOverrides,
	VALUE_CLI_FLAGS,
	allCliOptionValues,
	hasCliFlag,
	lastCliOptionValue,
} from "./contracts.js";
import { compareSemver, walkCanonicalPathSync } from "./paths.js";

export { SWIVAL_OPTION_DESCRIPTORS, VALUE_CLI_FLAGS, type SwivalOptionDescriptor } from "./contracts.js";

function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return PiStringEnum(values, options) as unknown as TUnsafe<T[number]>;
}

/** Descriptors whose dispatch-time override the native audit path admits as routing. */
const isNativeOverride = (d: SwivalOptionDescriptor) => d.override !== undefined && NATIVE_PARAM_NAMES.has(d.override.param);

// ------------------------------------------------- frontmatter coercion --

function coerceOptionValue(descriptor: SwivalOptionDescriptor, v: unknown): unknown {
	if (v === undefined) return undefined;
	switch (descriptor.kind) {
		case "string":
			if (typeof v === "string") return v;
			break;
		case "number":
			if (typeof v === "number" && Number.isFinite(v)) return v;
			if (typeof v === "string") {
				const n = Number(v);
				if (Number.isFinite(n)) return n;
			}
			break;
		case "boolean":
			if (typeof v === "boolean") return v;
			if (typeof v === "string") {
				const s = v.trim().toLowerCase();
				if (["true", "yes", "1", "on"].includes(s)) return true;
				if (["false", "no", "0", "off"].includes(s)) return false;
			}
			break;
		case "enum":
			if (typeof v === "string" && descriptor.enumValues!.includes(v.trim())) return v.trim();
			break;
		case "stringArray":
			if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.filter(Boolean);
			if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
			break;
	}
	throw new Error("invalid_definition");
}

/** Coerce every declared frontmatter option; throws `invalid_definition` on any ill-typed field. */
export function coerceFrontmatterOptions(frontmatter: Record<string, unknown>): Partial<SwivalAgentConfig> {
	const options: Record<string, unknown> = {};
	for (const descriptor of SWIVAL_OPTION_DESCRIPTORS) {
		options[descriptor.key] = coerceOptionValue(descriptor, frontmatter[descriptor.key]);
	}
	return options as Partial<SwivalAgentConfig>;
}

// ------------------------------------------------------- sandbox intent --

/** Derive effective AgentFS intent from the arguments emitted to Swival. */
export function isAgentFsRequested(args: readonly string[]): boolean {
	return lastCliOptionValue(args, "--sandbox") === "agentfs";
}

/** Derive effective Nono intent from the arguments emitted to Swival. */
export function isNonoRequested(args: readonly string[]): boolean {
	return lastCliOptionValue(args, "--sandbox") === "nono";
}

/**
 * Swival drains stdin before any sandbox re-exec, and omitted `--sandbox` lets
 * ambient configuration select one. Only an explicit `--sandbox builtin` makes
 * stdin task delivery safe.
 */
export function isReexecSandboxRequested(args: readonly string[]): boolean {
	return lastCliOptionValue(args, "--sandbox") !== "builtin";
}

export function plainTextTask(task: string): string {
	// `--` stops argparse option parsing, but Swival still dispatches / and !.
	return `Delegated task (plain text):\n\n${task}`;
}

// ---------------------------------------------------------- dispatch --

/**
 * True when an agent could plausibly mutate its cwd. Safety classification is
 * based on the final emitted arguments because extraArgs can override typed
 * frontmatter fields. A shared cwd is safe only when both file writes and
 * commands are disabled; AgentFS sessions do not remove write-through access.
 */
export function isMutatingCwdAgent(agent: SwivalAgentConfig, overrides: SwivalOverrides = {}, runCwd?: string): boolean {
	const args = buildSwivalArgs(agent, "", runCwd, overrides);
	return !(lastCliOptionValue(args, "--files") === "none" && lastCliOptionValue(args, "--commands") === "none");
}

/** Resolve one process cwd with per-item, top-level, then Pi precedence. */
export function resolveDispatchCwd(itemCwd: string | undefined, topLevelCwd: string | undefined, piCwd: string): string {
	const configured = itemCwd ?? topLevelCwd ?? piCwd;
	return path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(piCwd, configured);
}

/** Resolve Swival's effective base directory relative to its process cwd. */
export function resolveAgentBaseDir(agent: SwivalAgentConfig, runCwd: string, overrides: SwivalOverrides = {}): string {
	const args = buildSwivalArgs(agent, "", runCwd, overrides);
	return path.resolve(runCwd, lastCliOptionValue(args, "--base-dir") ?? runCwd);
}

/** Diagnostic for a dispatch naming an agent that is not in the discovered roster. */
export function unknownAgentMessage(agentName: string, agents: SwivalAgentConfig[]): string {
	const available = agents.map((a) => a.name).sort((a, b) => a.localeCompare(b)).join(", ") || "none";
	return `Unknown swival agent: "${agentName}". Available: ${available}`;
}

/**
 * Validate that an agent declaring `requiresReviewer: true` has a reviewer
 * attached for this call (frontmatter or overrides, self-review or external).
 */
export function checkRequiresReviewer(agent: SwivalAgentConfig, overrides: SwivalOverrides, runCwd?: string): string | undefined {
	if (!agent.requiresReviewer) return undefined;
	let args: string[];
	try {
		args = buildSwivalArgs(agent, "", runCwd, overrides);
	} catch (err) {
		if (err instanceof SwivalArgumentError) return err.message;
		throw err;
	}
	if (hasCliFlag(args, "--self-review") || lastCliOptionValue(args, "--reviewer")?.trim()) return undefined;
	return (
		`Agent "${agent.name}" requires a reviewer (frontmatter sets requiresReviewer: true) ` +
		`but the call did not supply one. Pass reviewerOverride with a path to a reviewer ` +
		`script (test-as-contract), or selfReviewOverride: true to enable LLM self-review.`
	);
}

export function getSwivalArgumentError(agent: SwivalAgentConfig, cwd: string | undefined, overrides: SwivalOverrides): string | undefined {
	try {
		buildSwivalArgs(agent, "", cwd, overrides);
		return undefined;
	} catch (err) {
		if (err instanceof SwivalArgumentError) return err.message;
		throw err;
	}
}

export function asyncOptionError(options: { timeoutMs?: unknown; output?: unknown; outputMode?: unknown }): string | undefined {
	const unsupported = (["timeoutMs", "output", "outputMode"] as const).filter((key) => options[key] !== undefined);
	return unsupported.length ? `async: true does not support ${unsupported.join(", ")}. Omit these options or use synchronous execution.` : undefined;
}

// --------------------------------------------------------- argv builder --

export function buildSwivalArgs(
	agent: SwivalAgentConfig,
	reportPath: string,
	cwd: string | undefined,
	overrides: SwivalOverrides = {},
): string[] {
	if (agent.extraArgs?.includes("--")) {
		throw new SwivalArgumentError(`Agent "${agent.name}" extraArgs must not include the option terminator "--".`);
	}
	const args: string[] = [];
	const pushValue = (flag: string, value: string | number | undefined) => {
		if (value !== undefined && value !== "") args.push(flag, String(value));
	};

	// Nested-invocation hygiene: default to disabling lifecycle / MCP / A2A /
	// history / continue / memory / subagents unless the agent explicitly opts
	// in (field=false).
	if (agent.noLifecycle !== false) args.push("--no-lifecycle");
	if (agent.noMcp !== false) args.push("--no-mcp");
	const rawA2aConfig = overrides.a2aConfig ?? agent.a2aConfig;
	if (rawA2aConfig !== undefined && rawA2aConfig.trim() === "") throw new SwivalArgumentError("A2A configuration path cannot be empty.");
	const a2aConfig = rawA2aConfig?.trim();
	const effectiveA2a = Boolean(a2aConfig) || agent.allowA2a === true || agent.noA2a === false;
	if (agent.source === "project" && effectiveA2a) throw new SwivalArgumentError(`Project-scope agent "${agent.name}" cannot enable A2A.`);
	if (agent.noA2a !== false && !effectiveA2a) args.push("--no-a2a");
	const supportsWebSearchFlag = overrides.installedSwivalVersion === undefined || compareSemver(overrides.installedSwivalVersion, "1.9.0") >= 0;
	if (agent.noWebSearch !== false && supportsWebSearchFlag) args.push("--no-web-search");
	if (agent.noHistory !== false) args.push("--no-history");
	if (agent.noContinue !== false) args.push("--no-continue");
	if (agent.noMemory !== false) args.push("--no-memory");

	// Native subagents opt-in: default to --no-subagents to prevent unmonitored
	// recursion inside Pi. An explicit false override outranks legacy noSubagents=false.
	if (overrides.subagents === true || (overrides.subagents === undefined && agent.subagents === true)) args.push("--subagents");
	else if (overrides.subagents === false || agent.noSubagents !== false) args.push("--no-subagents");

	// Plain options driven directly by the shared option table (overrides outrank frontmatter).
	for (const descriptor of SWIVAL_OPTION_DESCRIPTORS) {
		if (!descriptor.autoEmit || !descriptor.cliFlag) continue;
		const value = (descriptor.override ? overrides[descriptor.override.key] : undefined) ?? agent[descriptor.key];
		if (descriptor.kind === "boolean") {
			if (value === true) args.push(descriptor.cliFlag);
		} else if (descriptor.kind === "stringArray") {
			for (const entry of (value as readonly string[] | undefined) ?? []) args.push(descriptor.cliFlag, entry);
		} else if (value !== undefined && value !== "") {
			args.push(descriptor.cliFlag, String(value));
		}
	}

	// Sandbox / commands (yolo suppresses individual sandbox/file/command selectors)
	if (agent.yolo) args.push("--yolo");
	else {
		pushValue("--sandbox", agent.sandbox);
		pushValue("--files", agent.files);
		pushValue("--commands", agent.commands);
	}

	// A2A dials out to other agents, so it requires unrestricted network egress.
	const network = overrides.network ?? agent.network;
	if (effectiveA2a && network && network !== "full") {
		throw new SwivalArgumentError(`Agent "${agent.name}" enables A2A but network is "${network}"; A2A requires --network full.`);
	}
	if (a2aConfig) args.push("--a2a-config", path.isAbsolute(a2aConfig) ? a2aConfig : path.resolve(cwd ?? process.cwd(), a2aConfig));

	// Output budgeting
	for (const [flag, value] of [["--max-output-kb", overrides.maxOutputKb ?? agent.maxOutputKb],
		["--max-output-lines", overrides.maxOutputLines ?? agent.maxOutputLines]] as const) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0 && Math.trunc(value) >= 1) args.push(flag, String(Math.trunc(value)));
	}
	if (agent.baseDir) args.push("--base-dir", agent.baseDir);
	else if (cwd) args.push("--base-dir", cwd);
	if (agent.source === "project" && (overrides.addDir !== undefined || overrides.addDirRo !== undefined)) {
		throw new SwivalArgumentError(`Project-scope agent "${agent.name}" cannot use addDirOverride or addDirRoOverride.`);
	}
	const effectiveAddDir = overrides.addDir ?? agent.addDir ?? [];
	const effectiveAddDirRo = overrides.addDirRo ?? agent.addDirRo ?? [];
	// Frontmatter entries are emitted verbatim; override entries are emitted as
	// the canonical path that passed the protected-root check, so Swival cannot
	// resolve the grant differently than it was validated.
	const validateAddDirEntries = (entries: readonly string[], flagName: string, checkProtectedRoots: boolean): string[] => {
		const homeDir = os.homedir();
		const realHome = fs.existsSync(homeDir) ? fs.realpathSync.native(homeDir) : path.resolve(homeDir);
		// Protect each home entry under both its own spelling and its resolved
		// target, so a symlinked or dangling ~/.aws is refused either way.
		const protectedHomeSubs = PROTECTED_HOME_SUBDIRS.flatMap((sub) => {
			const lexical = path.join(realHome, sub);
			try { return [lexical, walkCanonicalPathSync(lexical)]; } catch { return [lexical]; }
		});
		const baseCwd = cwd === undefined ? process.cwd() : path.isAbsolute(cwd) ? cwd : `${process.cwd()}${path.sep}${cwd}`;
		// Default filesystems on these platforms are case-insensitive.
		const fold = (p: string) => (process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p);
		const emitted: string[] = [];
		for (const entry of entries) {
			if (typeof entry !== "string" || entry.trim() === "" || /[\x00-\x1f\x7f]/.test(entry) || entry.trim().startsWith("-")) {
				throw new SwivalArgumentError(`Invalid ${flagName} path "${entry}".`);
			}
			if (!checkProtectedRoots) { emitted.push(entry); continue; }
			// Join without normalizing so symlinks resolve before any `..` applies.
			const expanded = expandTildePath(entry, homeDir);
			let canonical: string;
			try {
				canonical = walkCanonicalPathSync(path.isAbsolute(expanded) ? expanded : `${baseCwd}${path.sep}${expanded}`);
			} catch (error) {
				throw new SwivalArgumentError(`Cannot resolve ${flagName} path "${entry}": ${(error as Error).message}`);
			}
			const folded = fold(canonical);
			if (canonical === path.parse(canonical).root || folded === fold(realHome)) {
				throw new SwivalArgumentError(`Refusing ${flagName} grant to protected root "${entry}".`);
			}
			for (const protectedRoot of protectedHomeSubs.map(fold)) {
				if (folded === protectedRoot || folded.startsWith(protectedRoot + path.sep) || protectedRoot.startsWith(folded + path.sep)) {
					throw new SwivalArgumentError(`Refusing ${flagName} grant overlapping protected directory "${entry}".`);
				}
			}
			emitted.push(canonical);
		}
		return emitted;
	};
	const emittedAddDir = validateAddDirEntries(effectiveAddDir, "--add-dir", overrides.addDir !== undefined);
	const emittedAddDirRo = validateAddDirEntries(effectiveAddDirRo, "--add-dir-ro", overrides.addDirRo !== undefined);
	for (const d of emittedAddDir) args.push("--add-dir", d);
	for (const d of emittedAddDirRo) args.push("--add-dir-ro", d);
	const effectiveFilesMode = lastCliOptionValue(agent.extraArgs ?? [], "--files") ?? agent.files;
	if (agent.source !== "project" && effectiveFilesMode !== "none") {
		const configuredBaseDir = lastCliOptionValue(agent.extraArgs ?? [], "--base-dir") ?? agent.baseDir ?? cwd;
		const baseDirCandidate = configuredBaseDir ? (cwd ? path.resolve(cwd, configuredBaseDir) : configuredBaseDir) : undefined;
		const linkedCommonGitDir = resolveLinkedWorktreeCommonGitDir(baseDirCandidate);
		if (linkedCommonGitDir) {
			const extraAddDirs = allCliOptionValues(agent.extraArgs ?? [], "--add-dir");
			const extraAddDirsRo = allCliOptionValues(agent.extraArgs ?? [], "--add-dir-ro");
			const hasCliAddDirRo = effectiveAddDirRo.length > 0 || extraAddDirsRo.length > 0;
			const inheritedConfigRo = hasCliAddDirRo ? [] : readConfiguredAllowedDirsRo(baseDirCandidate);
			const existingCanonical = [...emittedAddDir, ...extraAddDirs, ...emittedAddDirRo, ...extraAddDirsRo, ...inheritedConfigRo]
				.map((d) => canonicalPathOrResolved(d, cwd));
			const alreadyCovered = existingCanonical.some((d) => d === linkedCommonGitDir || linkedCommonGitDir.startsWith(d + path.sep));
			if (!alreadyCovered) {
				for (const d of inheritedConfigRo) args.push("--add-dir-ro", d);
				args.push("--add-dir-ro", linkedCommonGitDir);
			}
		}
	}

	// Prompt / memory (noMemory is handled above in nested-invocation hygiene)
	if (agent.instructionsFull && agent.noInstructions && overrides.instructionsFull === undefined) {
		throw new SwivalArgumentError(`Agent "${agent.name}" cannot specify both instructionsFull and noInstructions.`);
	}
	if (overrides.instructionsFull ?? agent.instructionsFull ?? false) args.push("--instructions-full");
	else if (agent.noInstructions) args.push("--no-instructions");
	if (agent.noSkills) args.push("--no-skills");
	else {
		for (const dir of overrides.skillsDir ?? agent.skillsDir ?? []) args.push("--skills-dir", dir);
		if (overrides.shareSkills) {
			const ambientSkills = path.join(os.homedir(), ".agents", "skills");
			if (fs.existsSync(ambientSkills)) args.push("--skills-dir", ambientSkills);
		}
	}

	// Escape hatch. Extension-owned protocol options follow this block so
	// extraArgs cannot redirect reports or traces away from the paths we read.
	for (const a of agent.extraArgs ?? []) args.push(a);

	// --no-color keeps stderr clean for forwarding to Pi's UI.
	args.push("--no-color");
	if (agent.quiet) args.push("-q");
	args.push("--report", reportPath);
	if (overrides.traceDir) args.push("--trace-dir", overrides.traceDir);
	if (agent.systemPrompt.trim()) args.push("--system-prompt", agent.systemPrompt);

	if (hasCliFlag(args, "--self-review") && lastCliOptionValue(args, "--reviewer")?.trim()) {
		throw new SwivalArgumentError("--self-review and --reviewer are mutually exclusive.");
	}
	// All dispatch modes preflight this builder before allocating run resources.
	const selfReview = overrides.selfReview ?? agent.selfReview;
	assertSwivalReviewCompatibility(args, selfReview === false);
	return args;
}

/**
 * Build the complete launch plan for one Swival run: argv (with the task
 * appended after `--` whenever a sandbox re-exec is possible), transport,
 * bridged child environment, and the resolved route/sandbox state spawners
 * and observers need, derived once from the same emitted arguments.
 */
export function planSwivalLaunch(
	agent: SwivalAgentConfig,
	task: string,
	reportPath: string,
	runCwd: string,
	overrides: SwivalOverrides,
	options: { baseEnv?: NodeJS.ProcessEnv; homeDir?: string } = {},
): LaunchPlan {
	const baseEnv = options.baseEnv ?? process.env;
	const homeDir = options.homeDir ?? os.homedir();
	const args = buildSwivalArgs(agent, reportPath, runCwd, overrides);
	const sandboxMode = lastCliOptionValue(args, "--sandbox");
	const reexecPossible = isReexecSandboxRequested(args);
	const route = routeFromArgs(args, runCwd);
	const payload = plainTextTask(task);
	const argv = reexecPossible ? [...args, "--", payload] : [...args, "--"];
	const bridgedEnv = resolveSwivalChildEnv(args, baseEnv, homeDir, runCwd);
	const env = resolveSwivalReviewEnv(args, (overrides.selfReview ?? agent.selfReview) === false, bridgedEnv ?? baseEnv) ?? bridgedEnv;
	const configuredMaxTurns = overrides.maxTurns ?? agent.maxTurns;
	return {
		executable: "swival",
		argv,
		cwd: runCwd,
		baseDir: route.baseDir,
		taskTransport: reexecPossible ? "argv" : "stdin",
		...(reexecPossible ? {} : { stdinPayload: payload }),
		...(env ? { env } : {}),
		route: { provider: route.provider, profile: route.profile, model: lastCliOptionValue(args, "--model"),
			baseUrl: route.baseUrl, externalReviewer: route.externalReviewer },
		sandbox: { mode: sandboxMode, agentFsRequested: sandboxMode === "agentfs", nonoRequested: sandboxMode === "nono", reexecPossible },
		effectiveProviderTimeout: resolveEffectiveProviderTimeout({ agent, overrides, args, runCwd, homeDir, env: baseEnv }),
		...(configuredMaxTurns !== undefined ? { effectiveMaxTurns: configuredMaxTurns } : {}),
		...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
	};
}

// ------------------------------------------------------- tool schemas --

export const TaskItem = Type.Object(
	{
		agent: Type.String({ description: "Swival agent name" }),
		task: Type.String({ description: "Task to delegate" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the swival process" })),
		output: Type.Optional(Type.String({
			description: "File path to write this task's finalOutput to. Relative paths resolve against the task's cwd (or the tool cwd). When set, the tool-response content defaults to file-only metadata (path + size) instead of inlining the body — set outputMode=\"inline\" to also receive the body inline.",
		})),
		outputMode: Type.Optional(StringEnum(["inline", "file-only"] as const, {
			description: "How to surface the task's output in the tool-response content. Default when output is set is file-only (path + size metadata, no body). Set inline to inline the body even when writing to a file. Ignored when output is not set (body is always inlined in that case).",
		})),
		seed: Type.Optional(Type.Number({ description: "Override --seed for this task only." })),
	},
	{ additionalProperties: false },
);

export const ChainItem = Type.Object(
	{
		agent: Type.String({ description: "Swival agent name" }),
		task: Type.String({ description: "Task with optional {previous} placeholder for prior step's output" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the swival process" })),
		seed: Type.Optional(Type.Number({ description: "Override --seed for this chain step only." })),
		output: Type.Optional(Type.String({ description: "Chain mode: file path to write this step's finalOutput to. Relative paths resolve against the step's cwd (or top-level cwd). Per-step output overrides top-level output. Defaults to file-only content unless outputMode=\"inline\"." })),
		outputMode: Type.Optional(StringEnum(["inline", "file-only"] as const, { description: "Chain mode: how to surface this step's output. Default with output is file-only; inline returns the body even when also writing to a file." })),
	},
	{ additionalProperties: false },
);

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which swival-agents directories to use. Default: "user".',
	default: "user",
});

export const NativeAuditScope = Type.Object({
	paths: Type.Optional(Type.Array(Type.String(), { maxItems: 64, description: "Relative committed paths/globs, not commands." })),
	all: Type.Optional(Type.Boolean({ description: "Deep-review every file in scope." })),
	workers: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
	patchMaxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false, description: "Synchronous, source-only native audit of repository-root cwd's committed tree. No async, task, agent, cwd or permission overrides." });

function overrideSchema(descriptor: SwivalOptionDescriptor): TSchema {
	const { description, integer } = descriptor.override!;
	switch (descriptor.kind) {
		case "boolean": return Type.Boolean({ description });
		case "number": return integer ? Type.Integer({ minimum: 1, description }) : Type.Number({ description });
		case "enum": return StringEnum(descriptor.enumValues as unknown as readonly string[], { description });
		case "stringArray": return Type.Array(Type.String(), { description });
		default: return Type.String({ description });
	}
}

/** `<param>: Type.Optional(schema)` for every descriptor with a dispatch-time override. */
const OVERRIDE_PARAM_SCHEMAS: Record<string, TSchema> = Object.fromEntries(
	SWIVAL_OPTION_DESCRIPTORS.filter((d) => d.override).map((d) => [d.override!.param, Type.Optional(overrideSchema(d))]),
);

const SHARED_BOUNDING_FIELDS = {
	maxInlineBytes: Type.Optional(Type.Number({
		minimum: 1,
		description: "Cap (in characters) on a task's finalOutput inlined into the tool-response content. Applies to single, chain, and parallel modes. When output exceeds the cap, the response shows the first maxInlineBytes characters followed by a [truncated N chars; full output at <artifactDir>] marker. Omit (default) to inline the full output — silent truncation is never the default. To avoid token growth entirely, pass `output: \"...\"` paths instead.",
	})),
	timeoutMs: Type.Optional(Type.Number({ minimum: 1, description: "Wall-clock budget in milliseconds for the swival process. On expiry: SIGTERM, then SIGKILL after 5 seconds. No default; only enforced when set." })),
};

/** Native selection and bounding fields shared by both tool schemas so the native-only tool cannot drift. */
const NativeAuditFields: Record<string, TSchema> = {
	...Object.fromEntries(SWIVAL_OPTION_DESCRIPTORS.filter((d) => isNativeOverride(d) && d.key !== "encryptSecrets")
		.map((d) => [d.override!.param, OVERRIDE_PARAM_SCHEMAS[d.override!.param]])),
	...SHARED_BOUNDING_FIELDS,
};

export const SwivalParams = Type.Object({
	audit: Type.Optional(NativeAuditScope),
	agent: Type.Optional(Type.String({ description: "Swival agent name (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, {
		description: "Array of {agent, task} run sequentially; each step's task may reference '{previous}' which is replaced with the prior step's final answer.",
	})),
	agentScope: Type.Optional(AgentScopeSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the swival process (single mode)" })),

	// Dispatch-time overrides (outrank agent frontmatter).
	...OVERRIDE_PARAM_SCHEMAS,
	shareSkills: Type.Optional(Type.Boolean({ description: "Share ambient Pi skills directories with child Swival processes." })),
	concurrency: Type.Optional(Type.Number({
		minimum: 1,
		maximum: MAX_CONCURRENCY,
		description: `Parallel-mode only: max concurrent tasks. Default 4, max ${MAX_CONCURRENCY}.`,
	})),
	...SHARED_BOUNDING_FIELDS,
	output: Type.Optional(Type.String({ description: "Single/chain mode: file path to write the run's finalOutput to. Relative paths resolve against cwd. When set, the tool-response content defaults to file-only metadata (path + size) instead of inlining the body — set outputMode=\"inline\" to also receive the body inline." })),
	outputMode: Type.Optional(StringEnum(["inline", "file-only"] as const, { description: "Single/chain mode: how to surface output in the tool-response content. Default with output is file-only; inline returns the body even when also writing to a file." })),

	async: Type.Optional(Type.Boolean({
		description: "Single mode only: spawn swival in the background and return immediately with a runId (e.g. swival-run-<timestamp>). Stdout/stderr are piped to files in the artifact dir so output is preserved. Use action:status/resume/interrupt with the returned runId to manage the run. Cannot combine async: true with timeoutMs, output, or outputMode.",
	})),
	action: Type.Optional(StringEnum(["list", "status", "interrupt", "resume"] as const, {
		description: "list: read a bounded agent capability catalogue; accepts only agentScope and cwd, without launching or probing Swival. Other actions require id. status: check progress or final report. interrupt: stop a run tracked by this Pi process only. resume: retrieve completed output and reviewer feedback, not continue execution. Live steering is unsupported.",
	})),
	id: Type.Optional(Type.String({
		description: "runId returned by a previous async invocation (e.g. swival-run-1716326580000). Required for status, interrupt and resume; forbidden for list.",
	})),
});

/**
 * Native-only declaration. Shared fields keep their general types and bounds;
 * maxInlineBytes and timeoutMs carry the native semantics in their text, and
 * encryptSecretsOverride is declared false-only. validateNativeAuditParams and
 * prepareNativeAudit still reject every other value on direct calls.
 */
export const NativeAuditToolParams = Type.Object({
	audit: NativeAuditScope,
	...NativeAuditFields,
	maxInlineBytes: Type.Optional(Type.Number({
		minimum: 1,
		description: "Cap (in characters) on the native audit answer inlined into the tool-response content. Default 65536. A longer answer is cut after this many characters and followed by a [truncated N chars; full output at <artifact evidence path>] marker; the complete report stays in the artifact directory.",
	})),
	timeoutMs: Type.Optional(Type.Number({
		minimum: 1,
		description: "Wall-clock budget in milliseconds for the native audit. Default: the smaller of 15 minutes and the configured native ceiling (30 minutes unless the registering extension sets another). An explicit value must be an integer from 1 to that ceiling. On expiry the owned process group is stopped with bounded TERM then KILL escalation.",
	})),
	encryptSecretsOverride: Type.Optional(Type.Literal(false, {
		description: "Only false is accepted; true is rejected. Admits a global encrypt_secrets=true Swival configuration for this audit. The run's inert configuration never enables encryption; project configuration, SWIVAL_ENCRYPT_KEY, filters, proxies, and every other preflight check stay fail-closed, and no file, auth, or process grant changes.",
	})),
}, { additionalProperties: false });

/** Map tool parameters onto SwivalOverrides through the option table. */
export function buildOverridesFromParams(params: Record<string, unknown>): SwivalOverrides {
	const overrides: Record<string, unknown> = {};
	for (const descriptor of SWIVAL_OPTION_DESCRIPTORS) {
		if (descriptor.override) overrides[descriptor.override.key] = params[descriptor.override.param];
	}
	// Legacy alias: an unsuffixed instructionsFull parameter still opts in.
	overrides.instructionsFull ??= params.instructionsFull;
	overrides.shareSkills = params.shareSkills;
	overrides.timeoutMs = params.timeoutMs;
	return overrides as SwivalOverrides;
}
