/**
 * Swival agent discovery.
 *
 * Reads agent definitions from ~/.pi/agent/swival-agents/ (user scope)
 * and .pi/swival-agents/ walked up from cwd (project scope).
 *
 * Frontmatter schema extends the pi-subagent schema with swival-specific
 * fields. Unknown fields are ignored.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "bundled" | "user" | "project";

export interface SwivalAgentConfig {
	name: string;
	description: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;

	// Provider / model routing
	provider?: string;
	profile?: string;
	model?: string;
	baseUrl?: string;
	temperature?: number;
	topP?: number;
	seed?: number;
	reasoningEffort?: string;
	maxOutputTokens?: number;
	maxTurns?: number;

	// Reviewer loop
	selfReview?: boolean;
	reviewer?: string;
	reviewPrompt?: string;
	verify?: string;
	maxReviewRounds?: number;

	// Filesystem / commands
	sandbox?: "builtin" | "agentfs";
	sandboxSession?: string;
	sandboxStrictRead?: boolean;
	noSandboxAutoSession?: boolean;
	files?: "none" | "some" | "all";
	commands?: string;
	baseDir?: string;
	addDir?: string[];
	addDirRo?: string[];
	encryptSecrets?: boolean;
	noReadGuard?: boolean;
	yolo?: boolean;

	// Prompt / memory
	noInstructions?: boolean;
	noMemory?: boolean;
	noSkills?: boolean;

	// Caching
	cache?: boolean;
	cacheDir?: string;

	// Context-management / retries
	proactiveSummaries?: boolean;
	retries?: number;

	// Nested-invocation hygiene (default true for all — see buildSwivalArgs)
	noLifecycle?: boolean;
	noMcp?: boolean;
	noA2a?: boolean;
	noHistory?: boolean;
	noContinue?: boolean;
	noSubagents?: boolean;

	// Output control
	quiet?: boolean;

	// Escape hatch for any flag we didn't model
	extraArgs?: string[];
}

export interface SwivalAgentDiscoveryResult {
	agents: SwivalAgentConfig[];
	projectAgentsDir: string | null;
}

type RawFrontmatter = Record<string, unknown>;

function asBool(v: unknown): boolean | undefined {
	if (typeof v === "boolean") return v;
	if (typeof v === "string") {
		const s = v.trim().toLowerCase();
		if (["true", "yes", "1", "on"].includes(s)) return true;
		if (["false", "no", "0", "off"].includes(s)) return false;
	}
	return undefined;
}

function asStringArray(v: unknown): string[] | undefined {
	if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
	if (typeof v === "string") {
		return v
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	return undefined;
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
	if (typeof v !== "string") return undefined;
	const s = v.trim() as T;
	return allowed.includes(s) ? s : undefined;
}

function asNumber(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string") {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

function loadAgentsFromDir(dir: string, source: AgentSource): SwivalAgentConfig[] {
	const agents: SwivalAgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter: fm, body } = parseFrontmatter<RawFrontmatter>(content);
		const name = typeof fm.name === "string" ? fm.name : "";
		const description = typeof fm.description === "string" ? fm.description : "";
		if (!name || !description) continue;

		agents.push({
			name,
			description,
			systemPrompt: body,
			source,
			filePath,

			provider: typeof fm.provider === "string" ? fm.provider : undefined,
			profile: typeof fm.profile === "string" ? fm.profile : undefined,
			model: typeof fm.model === "string" ? fm.model : undefined,
			baseUrl: typeof fm.baseUrl === "string" ? fm.baseUrl : undefined,
			temperature: asNumber(fm.temperature),
			topP: asNumber(fm.topP),
			seed: asNumber(fm.seed),
			reasoningEffort: typeof fm.reasoningEffort === "string" ? fm.reasoningEffort : undefined,
			maxOutputTokens: asNumber(fm.maxOutputTokens),
			maxTurns: asNumber(fm.maxTurns),

			selfReview: asBool(fm.selfReview),
			reviewer: typeof fm.reviewer === "string" ? fm.reviewer : undefined,
			reviewPrompt: typeof fm.reviewPrompt === "string" ? fm.reviewPrompt : undefined,
			verify: typeof fm.verify === "string" ? fm.verify : undefined,
			maxReviewRounds: asNumber(fm.maxReviewRounds),

			sandbox: asEnum(fm.sandbox, ["builtin", "agentfs"] as const),
			sandboxSession: typeof fm.sandboxSession === "string" ? fm.sandboxSession : undefined,
			sandboxStrictRead: asBool(fm.sandboxStrictRead),
			noSandboxAutoSession: asBool(fm.noSandboxAutoSession),
			files: asEnum(fm.files, ["none", "some", "all"] as const),
			commands: typeof fm.commands === "string" ? fm.commands : undefined,
			baseDir: typeof fm.baseDir === "string" ? fm.baseDir : undefined,
			addDir: asStringArray(fm.addDir),
			addDirRo: asStringArray(fm.addDirRo),
			encryptSecrets: asBool(fm.encryptSecrets),
			noReadGuard: asBool(fm.noReadGuard),
			yolo: asBool(fm.yolo),

			noInstructions: asBool(fm.noInstructions),
			noMemory: asBool(fm.noMemory),
			noSkills: asBool(fm.noSkills),

			noLifecycle: asBool(fm.noLifecycle),
			noMcp: asBool(fm.noMcp),
			noA2a: asBool(fm.noA2a),
			noHistory: asBool(fm.noHistory),
			noContinue: asBool(fm.noContinue),
			noSubagents: asBool(fm.noSubagents),

			quiet: asBool(fm.quiet),
			extraArgs: asStringArray(fm.extraArgs),

			cache: asBool(fm.cache),
			cacheDir: typeof fm.cacheDir === "string" ? fm.cacheDir : undefined,

			proactiveSummaries: asBool(fm.proactiveSummaries),
			retries: asNumber(fm.retries),
		});
	}

	return agents;
}

function findNearestProjectSwivalAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "swival-agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			/* not present, walk up */
		}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Resolve the bundled agents/ directory shipped with this package.
 * Uses import.meta.url so it works regardless of where pi installed the package.
 */
function getBundledAgentsDir(): string {
	const thisFile = fileURLToPath(import.meta.url);
	return path.join(path.dirname(thisFile), "..", "agents");
}

/**
 * Discovery priority (highest wins on name collision):
 *   1. project (.pi/swival-agents/ walked up from cwd)
 *   2. user   (~/.pi/agent/swival-agents/)
 *   3. bundled (this package's agents/ directory)
 *
 * Bundled agents are always loaded regardless of scope — they are the
 * baseline that ships with pi-swival. User and project agents override
 * them by name.
 */
export function discoverSwivalAgents(cwd: string, scope: AgentScope): SwivalAgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "swival-agents");
	const projectAgentsDir = findNearestProjectSwivalAgentsDir(cwd);

	const bundledAgents = loadAgentsFromDir(getBundledAgentsDir(), "bundled");
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	// Lowest priority first; later entries override by name.
	const agentMap = new Map<string, SwivalAgentConfig>();
	for (const a of bundledAgents) agentMap.set(a.name, a);
	if (scope === "both" || scope === "user") {
		for (const a of userAgents) agentMap.set(a.name, a);
	}
	if (scope === "both" || scope === "project") {
		for (const a of projectAgents) agentMap.set(a.name, a);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
