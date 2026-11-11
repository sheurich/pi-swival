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
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseDocument } from "yaml";
import { coerceFrontmatterOptions } from "./args.js";

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
	providerTimeout?: number;
	initialToolChoice?: "auto" | "required";

	// Reviewer loop
	selfReview?: boolean;
	reviewer?: string;
	reviewPrompt?: string;
	verify?: string;
	maxReviewRounds?: number;
	/** When true, the dispatcher refuses to spawn this agent unless the call
	 *  supplies a reviewer (frontmatter, override, or selfReview). Set on agents
	 *  whose contract depends on the reviewer loop — e.g. test-runner cannot
	 *  declare success without the test script gating it. */
	requiresReviewer?: boolean;

	// Filesystem / commands
	sandbox?: "builtin" | "agentfs" | "nono";
	sandboxSession?: string;
	sandboxStrictRead?: boolean;
	noSandboxAutoSession?: boolean;
	nonoProfile?: string;
	nonoRollback?: boolean;
	nonoBlockNet?: boolean;
	nonoAllowDomain?: string[];
	network?: "full" | "provider-only" | "none";
	files?: "none" | "some" | "all";
	commands?: string;
	commandMiddleware?: string;
	baseDir?: string;
	addDir?: string[];
	addDirRo?: string[];
	encryptSecrets?: boolean;
	noReadGuard?: boolean;
	yolo?: boolean;

	// Prompt / memory
	instructionsFull?: boolean;
	noInstructions?: boolean;
	noMemory?: boolean;
	noSkills?: boolean;
	skillsDir?: string[];

	// Output budgeting
	maxOutputKb?: number;
	maxOutputLines?: number;

	// Caching
	cache?: boolean;
	cacheDir?: string;

	// Context-management / retries
	proactiveSummaries?: boolean;
	retries?: number;

	// A2A (agent-to-agent) client configuration
	a2aConfig?: string;
	/** Positive opt-in companion to noA2a, mirroring the subagents/noSubagents
	 *  pair — set true to enable A2A without supplying an a2aConfig path. */
	allowA2a?: boolean;

	// Nested-invocation hygiene (default true for all — see buildSwivalArgs)
	noLifecycle?: boolean;
	noMcp?: boolean;
	noA2a?: boolean;
	noWebSearch?: boolean;
	noHistory?: boolean;
	noContinue?: boolean;
	noSubagents?: boolean;
	subagents?: boolean;

	// Output control
	quiet?: boolean;

	// Escape hatch for any flag we didn't model
	extraArgs?: string[];
}

export type AgentDiscoveryCode =
	| "invalid_yaml"
	| "invalid_frontmatter"
	| "invalid_definition"
	| "unreadable_definition"
	| "unreadable_directory"
	| "outside_directory";

export interface AgentDiscoveryDiagnostic {
	code: AgentDiscoveryCode;
	source: AgentSource;
}

export interface SwivalAgentDiscoveryResult {
	agents: SwivalAgentConfig[];
	projectAgentsDir: string | null;
	diagnostics: AgentDiscoveryDiagnostic[];
	diagnosticsTotal: number;
	diagnosticsOmitted: number;
	/** Internal dispatch guards; never expose names from invalid definitions in the catalogue. */
	invalidAgentNames: string[];
}

const MAX_DISCOVERY_DIAGNOSTICS = 12;

/** Admit only identities that the bounded catalogue can display verbatim. */
export function isCatalogueAgentName(name: string | undefined): name is string {
	// ESC is a control character, so rejecting controls also rejects ANSI sequences.
	return name !== undefined && name.length > 0 && name.length <= 80 &&
		!/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(name) &&
		name.replace(/\s+/g, " ").trim() === name;
}

type RawFrontmatter = Record<string, unknown>;
type Diagnose = (code: AgentDiscoveryCode, source: AgentSource) => void;

function parseAgentFrontmatter(content: string): { frontmatter: RawFrontmatter; body: string } {
	// Normalize Pi's BOM/newline forms, but require whole-line frontmatter delimiters.
	const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
	if (!match) return { frontmatter: {}, body: normalized };
	const yaml = match[1];
	const body = normalized.slice(match[0].length).trim();
	if (!yaml) return { frontmatter: {}, body };

	// "error" prevents conversion warnings without "silent", which hides MULTIPLE_DOCS errors.
	// parseDocument retains errors/warnings for inspection and does not emit them.
	const document = parseDocument(yaml, { logLevel: "error", prettyErrors: false });
	if (document.errors.length > 0 || document.warnings.length > 0) throw new Error("invalid_yaml");
	return { frontmatter: document.toJS({ maxAliasCount: 100 }) ?? {}, body };
}

function loadAgentsFromDir(dir: string, source: AgentSource, diagnose: Diagnose) {
	const agents: SwivalAgentConfig[] = [];
	const invalidAgentNames = new Set<string>();
	const reject = (code: AgentDiscoveryCode, name?: string) => {
		diagnose(code, source);
		if (name !== undefined) invalidAgentNames.add(name);
	};

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") reject("unreadable_directory");
		return { agents, invalidAgentNames };
	}

	for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		// Resolve symlinks and verify the real path stays within the scanned directory
		let realFilePath: string;
		try {
			realFilePath = fs.realpathSync(filePath);
		} catch {
			reject("unreadable_definition");
			continue;
		}
		if (realFilePath !== filePath && !realFilePath.startsWith(dir + path.sep)) {
			reject("outside_directory");
			continue;
		}
		let content: string;
		try {
			content = fs.readFileSync(realFilePath, "utf-8");
		} catch {
			reject("unreadable_definition");
			continue;
		}

		let parsed: { frontmatter: RawFrontmatter; body: string };
		try {
			parsed = parseAgentFrontmatter(content);
		} catch {
			reject("invalid_yaml");
			continue;
		}
		const { frontmatter: fm, body } = parsed;
		if (fm === null || typeof fm !== "object" || Array.isArray(fm)) {
			reject("invalid_frontmatter");
			continue;
		}
		const name = typeof fm.name === "string" && fm.name.trim() ? fm.name : undefined;
		const description = typeof fm.description === "string" ? fm.description : "";
		if (!isCatalogueAgentName(name) || !description.trim()) {
			reject("invalid_definition", name);
			continue;
		}

		let agentConfig: SwivalAgentConfig;
		try {
			agentConfig = { name, description, systemPrompt: body, source, filePath, ...coerceFrontmatterOptions(fm) };
		} catch {
			reject("invalid_definition", name);
			continue;
		}
		// Strip dangerous fields from project-local agents to prevent privilege escalation
		if (source === "project") {
			agentConfig.yolo = undefined;
			agentConfig.extraArgs = undefined;
			agentConfig.reviewer = undefined;
			agentConfig.verify = undefined;
			agentConfig.noSubagents = undefined;
			agentConfig.subagents = undefined;
			agentConfig.commandMiddleware = undefined;
			agentConfig.nonoProfile = undefined;
			agentConfig.skillsDir = undefined;
			// Only allow project agents to restrict to air-gapped "none"; strip any
			// less restrictive network policy to prevent overriding ambient "none" config.
			if (agentConfig.network !== "none") agentConfig.network = undefined;
			agentConfig.nonoAllowDomain = undefined;
			agentConfig.nonoRollback = undefined;
			agentConfig.nonoBlockNet = undefined;
			// Provider/model/baseUrl redirect the LLM request itself (including
			// the Authorization header carrying the provider API key) to an
			// attacker-controlled endpoint or a fake "command" provider that
			// executes arbitrary shell commands as the "model". Never let a
			// repo-controlled agent choose these.
			agentConfig.provider = undefined;
			agentConfig.model = undefined;
			agentConfig.baseUrl = undefined;
			agentConfig.profile = undefined;
			// baseDir/addDir/addDirRo escape the repo-scoped working tree
			// entirely (e.g. baseDir: "/", addDir: ["~/.ssh"]), regardless of
			// the forced sandbox below.
			agentConfig.baseDir = undefined;
			agentConfig.addDir = undefined;
			agentConfig.addDirRo = undefined;
			// A2A connects to other agents over the network under the calling
			// operator's identity; never let a repo-controlled agent enable it.
			agentConfig.a2aConfig = undefined;
			agentConfig.allowA2a = undefined;
			agentConfig.noA2a = true;
			agentConfig.noWebSearch = true;
			// Force AgentFS for every project agent, including "nono" — the prior
			// check only forced agentfs when sandbox was unset or "builtin",
			// letting `sandbox: nono` pass through unmodified.
			agentConfig.sandbox = "agentfs";
		}
		agents.push(agentConfig);
	}

	return { agents, invalidAgentNames };
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
		if (currentDir === os.homedir()) return null;
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

	const diagnostics: AgentDiscoveryDiagnostic[] = [];
	let diagnosticsTotal = 0;
	// A malformed file without an identity is reported, never allowed to veto
	// unrelated valid agents. Only an identifiable invalid definition blocks a
	// requested name (see invalidAgentNames below).
	const diagnose: Diagnose = (code, source) => {
		diagnosticsTotal++;
		if (diagnostics.length < MAX_DISCOVERY_DIAGNOSTICS) diagnostics.push({ code, source });
	};

	// Invalid identities remain tombstones so a broken override cannot select
	// a lower-priority definition. Never guess an identity from the filename.
	const agentMap = new Map<string, SwivalAgentConfig>();
	const invalidAgentNames = new Set<string>();
	const reviewerRequirements = new Map<string, boolean | undefined>();
	const directories: [string, AgentSource][] = [[getBundledAgentsDir(), "bundled"]];
	if (scope !== "project") directories.push([userDir, "user"]);
	if (scope !== "user" && projectAgentsDir) directories.push([projectAgentsDir, "project"]);
	for (const [dir, source] of directories) {
		const loaded = loadAgentsFromDir(dir, source, diagnose);
		for (const a of loaded.agents) {
			// A project override cannot drop the trusted reviewer's contract,
			// including when an invalid intermediate override was rejected.
			if (source === "project" && reviewerRequirements.get(a.name) === true) a.requiresReviewer = true;
			if (source !== "project") reviewerRequirements.set(a.name, a.requiresReviewer);
			agentMap.set(a.name, a);
			invalidAgentNames.delete(a.name);
		}
		for (const name of loaded.invalidAgentNames) {
			agentMap.delete(name);
			invalidAgentNames.add(name);
		}
	}

	return {
		agents: Array.from(agentMap.values()).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
		projectAgentsDir,
		diagnostics,
		diagnosticsTotal,
		diagnosticsOmitted: diagnosticsTotal - diagnostics.length,
		invalidAgentNames: Array.from(invalidAgentNames).sort(),
	};
}
