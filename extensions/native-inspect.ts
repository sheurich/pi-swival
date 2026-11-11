/**
 * Native audit evidence inspection: bounded, identity-checked reads of run
 * artifacts, route and terminal-record validation, and the fail-closed
 * completeness judgment over released Swival state. Pure TypeScript; no
 * interpreter is executed after the audit.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	NATIVE_COMPATIBILITY_MANIFEST,
	NATIVE_FILE_LIMIT,
	NATIVE_MAX_ENTRIES,
	type NativeAuditResult,
	type NativeRoute,
	type NativeTerminal,
} from "./contracts.js";

// -------------------------------------------------- record helpers --

export const isPlainRecord = (value: unknown): value is Record<string, any> => value !== null &&
	typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export const hasOnlyFields = (value: Record<string, any>, fields: Set<string>) => Object.keys(value).every((key) => fields.has(key));
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

// ------------------------------------------------- evidence reading --

const TERMINAL_LIMIT = 64 * 1024;
const TERMINAL_DIAGNOSTICS = ["stopped", "shutdownFailure", "preservationFailure", "cleanupFailure", "persistenceFailure"] as const;

/** Verify every ancestor between `root` and `target` is a real directory and nothing on the way is a symlink. */
export function checkedPath(root: string, target: string): fsSync.Stats {
	const anchor = path.resolve(root);
	const relative = path.relative(anchor, path.resolve(target));
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Uncontained native evidence.");
	let current = anchor;
	for (const component of ["", ...relative.split(path.sep).filter(Boolean)]) {
		current = path.join(current, component);
		const stat = fsSync.lstatSync(current);
		if (stat.isSymbolicLink()) throw new Error("Symlinked native evidence.");
		if (current !== path.resolve(target) && !stat.isDirectory()) throw new Error("Unsafe native evidence ancestor.");
	}
	return fsSync.lstatSync(target);
}

/** Read one contained regular file, verifying the opened descriptor is the inspected inode. */
export function regularBytes(root: string, target: string, limit: number): Buffer {
	const stat = checkedPath(root, target);
	if (!stat.isFile() || stat.size > limit) throw new Error("Unsupported or oversized native evidence.");
	const fd = fsSync.openSync(target, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
	try {
		const opened = fsSync.fstatSync(fd);
		if (!opened.isFile() || opened.size > limit || opened.ino !== stat.ino || opened.dev !== stat.dev) {
			throw new Error("Native evidence changed during open.");
		}
		const bytes = Buffer.alloc(opened.size);
		let offset = 0;
		while (offset < bytes.length) {
			const count = fsSync.readSync(fd, bytes, offset, bytes.length - offset, offset);
			if (!count) throw new Error("Native evidence changed during read.");
			offset += count;
		}
		return bytes;
	} finally { fsSync.closeSync(fd); }
}

function immutable(record: NativeTerminal): NativeTerminal {
	if (record.retainedResources) Object.freeze(record.retainedResources);
	return Object.freeze(record);
}

export function validTerminal(value: unknown, fallback: boolean): value is NativeTerminal {
	if (!isPlainRecord(value) ||
		!Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255 ||
		typeof value.exitedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.exitedAt) ||
		!Number.isFinite(Date.parse(value.exitedAt)) ||
		!["not-started", "verified", "unverified"].includes(value.shutdown)) return false;
	if (value.boundary !== undefined && value.boundary !== "agentfs-cli") return false;
	const keys = new Set(["exitCode", "exitedAt", "shutdown", "boundary", "retainedResources", ...TERMINAL_DIAGNOSTICS]);
	if (!hasOnlyFields(value, keys)) return false;
	if (TERMINAL_DIAGNOSTICS.some((key) => value[key] !== undefined && (typeof value[key] !== "string" || !value[key] || value[key].length > 8192))) return false;
	if (value.retainedResources !== undefined && (!Array.isArray(value.retainedResources) ||
		value.retainedResources.length > NATIVE_MAX_ENTRIES || value.retainedResources.some((item: unknown) =>
			typeof item !== "string" || !path.isAbsolute(item) || item.length > 4096))) return false;
	if (value.exitCode === 0 && (fallback || value.shutdown !== "verified" ||
		TERMINAL_DIAGNOSTICS.some((key) => value[key]) || value.retainedResources?.length)) return false;
	return true;
}

/** Read the terminal record; a legacy text `spawn-error.txt` is failure-only and never attests shutdown. */
export function readNativeTerminal(runDir: string): NativeTerminal | undefined {
	for (const [name, fallback] of [["completed.json", false], ["spawn-error.txt", true]] as const) {
		try {
			const target = path.join(runDir, name);
			const text = regularBytes(runDir, target, TERMINAL_LIMIT).toString("utf8");
			let value: unknown;
			try { value = JSON.parse(text); }
			catch {
				// Malformed structured records must not become legacy failures or attest that execution stopped.
				if (!fallback || !text.trim() || /^[\s]*[\[{]/.test(text)) continue;
				return immutable({ exitCode: 1, exitedAt: fsSync.lstatSync(target).mtime.toISOString(), shutdown: "unverified", stopped: text.slice(0, 8192) });
			}
			if (validTerminal(value, fallback)) return immutable(value);
		} catch { /* Missing, unsafe, unreadable, and malformed records grant no authority. */ }
	}
	return undefined;
}

// ---------------------------------------------------- route parsing --

const routeIdentifier = (value: unknown, limit = 160): value is string => typeof value === "string" &&
	value.length > 0 && value.length <= limit && /^[A-Za-z0-9][A-Za-z0-9_./:-]*$/.test(value) &&
	!/[A-Za-z0-9]{40,}|(?:^|\/)\.\.?(?:\/|$)/.test(value);
const awsRegionIdentifier = (value: unknown): value is string => typeof value === "string" && /^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/.test(value);
const routeOptions = new Set(["max_output_tokens", "max_turns", "provider_timeout", "retries", "temperature", "top_p", "seed", "max_context_tokens"]);
const explicitRouteFields = new Set(["profile", "provider", "model", "reasoningEffort", "temperature", "topP", "seed",
	"maxOutputTokens", "maxTurns", "providerTimeout", "encryptSecrets"]);
const routeFailure = () => new Error("Native audit configuration preflight failed: invalid or unsupported metadata. No native worker/provider was started.");

/** Validate preflight route metadata, including the exact runtime the compatibility manifest pins. */
export function parseNativeRoute(value: unknown): NativeRoute {
	const allowedFields = new Set(["version", "runtime", "provider", "model", "endpoint", "profile", "reasoningEffort", "options", "selection", "reportIdentity",
		...(isPlainRecord(value) && value.provider === "geap" ? ["project", "location"] : [])]);
	if (!isPlainRecord(value) || value.version !== 2 || !hasOnlyFields(value, allowedFields) ||
		!isDeepStrictEqual(value.runtime, { ...NATIVE_COMPATIBILITY_MANIFEST }) ||
		!routeIdentifier(value.provider, 40) || !routeIdentifier(value.model) ||
		!(value.profile === null || routeIdentifier(value.profile, 80)) ||
		!(value.reasoningEffort === null || ["none", "minimal", "low", "medium", "high", "xhigh", "default"].includes(value.reasoningEffort)) ||
		!isPlainRecord(value.options) || !isPlainRecord(value.selection) || !isPlainRecord(value.reportIdentity)) throw routeFailure();
	if (value.provider === "geap") {
		if (!routeIdentifier(value.project, 128) || !routeIdentifier(value.location, 64) || value.endpoint !== null || value.model.includes("/")) throw routeFailure();
	}
	if (value.provider === "bedrock") {
		if (!awsRegionIdentifier(value.endpoint)) throw routeFailure();
	} else if (value.endpoint !== null) {
		if (typeof value.endpoint !== "string" || value.endpoint.length > 512 ||
			!/^https?:\/\/[A-Za-z0-9.:[\]-]+(?::[0-9]+)?(?:\/[A-Za-z0-9_./-]*)?$/.test(value.endpoint) ||
			/[A-Za-z0-9]{40,}/.test(value.endpoint)) throw routeFailure();
		try {
			const endpoint = new URL(value.endpoint);
			if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
				(endpoint.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) throw routeFailure();
		} catch { throw routeFailure(); }
	}
	const selection = value.selection;
	if (!hasOnlyFields(selection, new Set(["profileSource", "explicitFields"])) ||
		![null, "active", "explicit"].includes(selection.profileSource) ||
		!Array.isArray(selection.explicitFields) || selection.explicitFields.length > explicitRouteFields.size ||
		selection.explicitFields.some((field: unknown) => typeof field !== "string" || !explicitRouteFields.has(field)) ||
		new Set(selection.explicitFields).size !== selection.explicitFields.length ||
		(value.profile === null) !== (selection.profileSource === null) ||
		(selection.profileSource === "explicit") !== selection.explicitFields.includes("profile") ||
		!hasOnlyFields(value.reportIdentity, new Set(["provider", "model"])) ||
		value.reportIdentity.provider !== value.provider || value.reportIdentity.model !== value.model) throw routeFailure();
	const options: Record<string, number | null> = {};
	for (const [key, option] of Object.entries(value.options)) {
		if (!routeOptions.has(key) || !(option === null || typeof option === "number" && Number.isFinite(option) && Math.abs(option) <= Number.MAX_SAFE_INTEGER)) throw routeFailure();
		options[key] = option;
	}
	return { version: 2, runtime: { ...NATIVE_COMPATIBILITY_MANIFEST }, provider: value.provider,
		model: value.model, endpoint: value.endpoint, profile: value.profile, reasoningEffort: value.reasoningEffort,
		options, selection: { profileSource: selection.profileSource, explicitFields: [...selection.explicitFields] },
		reportIdentity: { provider: value.reportIdentity.provider, model: value.reportIdentity.model },
		...(value.provider === "geap" ? { project: value.project as string, location: value.location as string } : {}) };
}

const preflightReasons: Record<string, string> = {
	PROFILE_UNAVAILABLE: "Selected profile is unavailable; no fallback.",
	ROUTE_INCOMPLETE: "Configured provider and model are required; no implicit route or fallback.",
	CREDENTIAL_INTERFACE_UNSUPPORTED: "Selected route needs an unsupported credential interface or grant.",
	CREDENTIAL_UNAVAILABLE: "Selected provider credential is unavailable; no fallback.",
	MODEL_REPLACEMENT_UNCONTROLLABLE: "This runtime can replace the selected model after model-not-found; no launch.",
	ROUTE_SELECTOR_UNSUPPORTED: "Automatic or multi-model selection is unsupported; select a concrete model.",
	COMMAND_EXECUTION_REQUIRED: "Selected provider requires command execution, incompatible with commands-none.",
	CONFIG_INVALID: "Native configuration is invalid or contains unknown requirements.",
	RUNTIME_UNSUPPORTED: `Native runtime is unsupported; require Swival ${NATIVE_COMPATIBILITY_MANIFEST.swival} and LiteLLM ${NATIVE_COMPATIBILITY_MANIFEST.litellm}.`,
	TRANSPORT_REQUIREMENT_UNSUPPORTED: "Unsupported native transport proxy requirements.",
	ENDPOINT_REQUIREMENT_UNSUPPORTED: "Selected or ambient endpoint requirements are unsupported; no fallback.",
	PROJECT_ROUTING_UNSUPPORTED: "Project-supplied native routing is unsupported.",
};
const policyFields = new Set(["encrypt_secrets", "secret_shield", "llm_filter", "extra_body", "user_agent", "prompt_cache",
	"sanitize_thinking", "show_thinking", "sandbox_strict_read", "sandbox_session", "lifecycle_fail_closed",
	"reasoning_effort_all_phases", "retries_all_phases", "retries", "network", "files", "sandbox", "max_context_tokens",
	"nono_profile", "nono_rollback", "nono_block_net", "nono_allow_domain", "nono_network_profile", "nono_credential", "nono_audit_integrity",
	"web_search"]);

export function parseNativePreflight(output: string, success: boolean): { route: NativeRoute; scope?: unknown; awsProfile?: string } {
	let value: unknown;
	try { value = JSON.parse(output); } catch { throw routeFailure(); }
	if (isPlainRecord(value) && value.ok === false && hasOnlyFields(value, new Set(["ok", "reason", "field"]))) {
		let message = typeof value.reason === "string" && Object.hasOwn(preflightReasons, value.reason) ? preflightReasons[value.reason] : undefined;
		if (value.reason === "POLICY_NOT_PROPAGATED" && typeof value.field === "string" && policyFields.has(value.field)) {
			message = `Required policy ${value.field} is not propagated to every native phase.`;
		} else if (value.field !== undefined && !["api_key", ...policyFields].includes(value.field)) message = undefined;
		if (message) throw new Error(`Native audit configuration preflight failed: ${message} No native worker/provider was started.`);
		throw routeFailure();
	}
	if (!success || !isPlainRecord(value)) throw routeFailure();
	const { scope, awsProfile, ...route } = value;
	if (awsProfile !== undefined && (!routeIdentifier(awsProfile, 80) || route.provider !== "bedrock")) throw routeFailure();
	return { route: parseNativeRoute(route), ...(scope === undefined ? {} : { scope }), ...(awsProfile === undefined ? {} : { awsProfile }) };
}

// ----------------------------------------------- finding identity --

type ReleasedFindingRecord = {
	title: string; finding_type: string; severity: string; locations: string[];
	preconditions: string[]; proof: string[]; fix_outline: string; source_file: string;
	triage_decision: string | null; threat_model: string;
};
const findingFields = new Set(["title", "finding_type", "severity", "locations", "preconditions", "proof", "fix_outline", "source_file", "triage_decision", "threat_model"]);

function releasedFinding(value: unknown): ReleasedFindingRecord | undefined {
	if (!isPlainRecord(value) || !hasOnlyFields(value, findingFields)) return undefined;
	const triage = Object.hasOwn(value, "triage_decision") ? value.triage_decision : null;
	const threat = Object.hasOwn(value, "threat_model") ? value.threat_model : "";
	if (!["title", "finding_type", "severity", "fix_outline", "source_file"].every((key) => typeof value[key] === "string") ||
		!stringList(value.locations) || !stringList(value.preconditions) || !stringList(value.proof) ||
		!(triage === null || typeof triage === "string") || typeof threat !== "string") return undefined;
	return { title: value.title, finding_type: value.finding_type, severity: value.severity, locations: value.locations,
		preconditions: value.preconditions, proof: value.proof, fix_outline: value.fix_outline, source_file: value.source_file,
		triage_decision: triage, threat_model: threat };
}

const pythonAsciiString = (value: string) => JSON.stringify(value).replace(/[\u007f-\uffff]/g,
	(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
const pythonStringList = (value: string[]) => `[${value.map(pythonAsciiString).join(", ")}]`;

/** Match Swival 1.9.3 `_finding_key` for the released FindingRecord schema only. */
export function nativeFindingKey(value: unknown): string | undefined {
	const finding = releasedFinding(value);
	if (!finding) return undefined;
	const fields: [string, string][] = [
		["finding_type", pythonAsciiString(finding.finding_type)],
		["fix_outline", pythonAsciiString(finding.fix_outline)],
		["locations", pythonStringList(finding.locations)],
		["preconditions", pythonStringList(finding.preconditions)],
		["proof", pythonStringList(finding.proof)],
		["severity", pythonAsciiString(finding.severity)],
		["source_file", pythonAsciiString(finding.source_file)],
		["threat_model", pythonAsciiString(finding.threat_model)],
		["title", pythonAsciiString(finding.title)],
		["triage_decision", finding.triage_decision === null ? "null" : pythonAsciiString(finding.triage_decision)],
	];
	const serialized = `{${fields.map(([key, encoded]) => `${pythonAsciiString(key)}: ${encoded}`).join(", ")}}`;
	return createHash("sha256").update(serialized, "utf8").digest("hex").slice(0, 12);
}

type ReleasedAdjudicationDrop = { title: string; severity: string; source_file: string; reason: string };
const adjudicationDropFields = new Set(["title", "severity", "source_file", "reason"]);
const MAX_VERIFIED_LINEAGE_FINDINGS = 512;
const MAX_LINEAGE_RESIDUAL_EDGE_VISITS = 1_000_000;

function releasedAdjudicationDrops(value: unknown): ReleasedAdjudicationDrop[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const drops: ReleasedAdjudicationDrop[] = [];
	for (const item of value) {
		if (!isPlainRecord(item) || !hasOnlyFields(item, adjudicationDropFields) ||
			![...adjudicationDropFields].every((field) => Object.hasOwn(item, field) && typeof item[field] === "string")) return undefined;
		drops.push({ title: item.title, severity: item.severity, source_file: item.source_file, reason: item.reason });
	}
	return drops;
}

const survivorProjection = (finding: ReleasedFindingRecord) => JSON.stringify([finding.locations, finding.proof, finding.source_file, finding.triage_decision]);
const dropProjection = (finding: ReleasedFindingRecord | ReleasedAdjudicationDrop) => JSON.stringify([finding.title, finding.severity, finding.source_file]);

type ResidualEdge = { to: number; reverse: number; capacity: number };

/** Check existence of a one-to-one released Phase 4.5 lineage without claiming a unique historical assignment. */
function hasFeasibleFindingLineage(verifiedProposals: ReleasedFindingRecord[], survivors: ReleasedFindingRecord[], drops: ReleasedAdjudicationDrop[]): boolean {
	if (verifiedProposals.length > MAX_VERIFIED_LINEAGE_FINDINGS || verifiedProposals.length !== survivors.length + drops.length) return false;
	const cells = new Map<string, Map<string, number>>();
	const survivorDemand = new Map<string, number>();
	const dropDemand = new Map<string, number>();
	const dropCapacity = new Map<string, number>();
	for (const proposal of verifiedProposals) {
		const survivor = survivorProjection(proposal);
		const drop = dropProjection(proposal);
		const row = cells.get(survivor) ?? new Map<string, number>();
		row.set(drop, (row.get(drop) ?? 0) + 1);
		cells.set(survivor, row);
		dropCapacity.set(drop, (dropCapacity.get(drop) ?? 0) + 1);
	}
	for (const survivor of survivors) {
		const projection = survivorProjection(survivor);
		survivorDemand.set(projection, (survivorDemand.get(projection) ?? 0) + 1);
	}
	for (const drop of drops) {
		const projection = dropProjection(drop);
		dropDemand.set(projection, (dropDemand.get(projection) ?? 0) + 1);
	}
	const survivorColumns = new Map<string, number>();
	for (const projection of new Set([...dropCapacity.keys(), ...dropDemand.keys()])) {
		const demand = dropDemand.get(projection) ?? 0;
		const capacity = dropCapacity.get(projection) ?? 0;
		if (demand > capacity) return false;
		survivorColumns.set(projection, capacity - demand);
	}
	if ([...survivorColumns.values()].reduce((sum, value) => sum + value, 0) !== survivors.length) return false;

	const survivorRows = [...new Set([...cells.keys(), ...survivorDemand.keys()])];
	const dropColumns = [...survivorColumns.keys()];
	const source = 0;
	const rowStart = 1;
	const columnStart = rowStart + survivorRows.length;
	const sink = columnStart + dropColumns.length;
	const graph: ResidualEdge[][] = Array.from({ length: sink + 1 }, () => []);
	const addEdge = (from: number, to: number, capacity: number) => {
		graph[from].push({ to, reverse: graph[to].length, capacity });
		graph[to].push({ to: from, reverse: graph[from].length - 1, capacity: 0 });
	};
	const rowNodes = new Map(survivorRows.map((projection, index) => [projection, rowStart + index]));
	const columnNodes = new Map(dropColumns.map((projection, index) => [projection, columnStart + index]));
	for (const projection of survivorRows) addEdge(source, rowNodes.get(projection)!, survivorDemand.get(projection) ?? 0);
	for (const [survivor, row] of cells) for (const [drop, capacity] of row) addEdge(rowNodes.get(survivor)!, columnNodes.get(drop)!, capacity);
	for (const [projection, demand] of survivorColumns) addEdge(columnNodes.get(projection)!, sink, demand);

	let edgeVisits = 0;
	let flow = 0;
	while (flow < survivors.length) {
		const levels = Array<number>(graph.length).fill(-1);
		const queue = [source];
		levels[source] = 0;
		for (let index = 0; index < queue.length; index++) {
			const node = queue[index];
			for (const edge of graph[node]) {
				if (++edgeVisits > MAX_LINEAGE_RESIDUAL_EDGE_VISITS) return false;
				if (edge.capacity > 0 && levels[edge.to] < 0) {
					levels[edge.to] = levels[node] + 1;
					queue.push(edge.to);
				}
			}
		}
		if (levels[sink] < 0) return false;
		const next = Array<number>(graph.length).fill(0);
		const send = (node: number, available: number): number => {
			if (node === sink) return available;
			for (; next[node] < graph[node].length; next[node]++) {
				const edge = graph[node][next[node]];
				if (++edgeVisits > MAX_LINEAGE_RESIDUAL_EDGE_VISITS) return 0;
				if (edge.capacity <= 0 || levels[edge.to] !== levels[node] + 1) continue;
				const sent = send(edge.to, Math.min(available, edge.capacity));
				if (sent > 0) {
					edge.capacity -= sent;
					graph[edge.to][edge.reverse].capacity += sent;
					return sent;
				}
			}
			return 0;
		};
		for (let sent = send(source, survivors.length - flow); sent > 0; sent = send(source, survivors.length - flow)) flow += sent;
		if (edgeVisits > MAX_LINEAGE_RESIDUAL_EDGE_VISITS) return false;
	}
	return true;
}

// ------------------------------------------------------ inspection --

async function regularJson(file: string, root: string): Promise<Record<string, any>> {
	return JSON.parse(regularBytes(root, file, NATIVE_FILE_LIMIT).toString("utf8"));
}

const covers = (wanted: unknown, actual: unknown) => Array.isArray(wanted) && Array.isArray(actual) && wanted.every((file) => actual.includes(file));
const nonNegativeCount = (value: unknown) => value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);

/**
 * Judge one finished native audit from its retained evidence only. Every
 * mismatch between preparation, the released CLI report, diagnostics, and
 * the persisted audit state fails closed as `failed` or `partial`; `completed`
 * requires full mandatory coverage, zero adjudication or truncation errors, a
 * complete report, and a written report/patch pair for every verified finding.
 */
export async function inspectNativeAudit(artifactDir: string, exitCode: number): Promise<NativeAuditResult> {
	try {
		const completed = readNativeTerminal(artifactDir);
		if (!completed) return { status: "failed", error: "Native audit state is unknown: no valid terminal evidence." };
		const failures = TERMINAL_DIAGNOSTICS.map((key) => completed[key]).filter(Boolean);
		if (failures.length || completed.shutdown !== "verified" || completed.boundary !== "agentfs-cli") {
			return { status: "failed", error: failures.join(" ") || "Native shutdown was not verified; resources are retained." };
		}
		if (exitCode !== 0 || completed.exitCode !== 0) return { status: "failed", error: "Native CLI exited unsuccessfully." };
		const manifest = await regularJson(path.join(artifactDir, "manifest.json"), artifactDir);
		const report = await regularJson(path.join(artifactDir, "evidence", "native-cli-report.json"), artifactDir);
		const diagnostics = await regularJson(path.join(artifactDir, "diagnostics.json"), artifactDir);
		if (diagnostics.closed !== true || !Number.isSafeInteger(diagnostics.bytes) || diagnostics.bytes < 1 ||
			diagnostics.bytes > 2 * 1024 * 1024 || diagnostics.ambiguous !== false ||
			diagnostics.authPersistenceFailure !== false || typeof diagnostics.adjudicationFailure !== "boolean" ||
			typeof diagnostics.adjudicationRepairFailure !== "boolean" ||
			!Number.isSafeInteger(diagnostics.expansionFailures) || diagnostics.expansionFailures < 0) {
			return { status: "failed", error: "Native diagnostics are missing, truncated, or ambiguous." };
		}
		if (diagnostics.adjudicationFailure) return { status: "partial", error: "Native audit has terminal adjudication failures." };
		if (diagnostics.adjudicationRepairFailure) return { status: "partial", error: "Native adjudication completeness cannot be verified after exhausted format repair." };
		if (diagnostics.expansionFailures > 0) return { status: "partial", error: "Native audit lost findings to unrecovered expansion failures." };
		const route = parseNativeRoute(manifest.route);
		if (manifest.sandbox !== "agentfs" || !/^native-[a-f0-9]{32}$/.test(manifest.session) ||
			report.version !== 1 || report.task !== manifest.command || report.provider !== route.reportIdentity.provider ||
			report.model !== route.reportIdentity.model ||
			report.result?.outcome !== "success" || report.result.exit_code !== 0 ||
			report.sandbox?.mode !== "builtin" || report.sandbox.session !== undefined ||
			report.network !== "provider-only" || report.settings?.commands !== "none" || report.settings.files !== "some" ||
			report.settings.instructions_status !== "disabled" || !Array.isArray(report.settings.skills_discovered) ||
			report.settings.skills_discovered.length || typeof report.result.answer !== "string" || !report.result.answer.trim()) {
			return { status: "failed", error: "Native CLI route, policy, or result evidence does not match preparation." };
		}
		// The released CLI reports success even when it stopped early; its own answer says so.
		if ((report.result.answer as string).trimStart().startsWith("Audit incomplete:")) {
			return { status: "partial", error: "Native audit reported incomplete execution." };
		}
		const scope = manifest.scope;
		const statesDir = path.join(artifactDir, "evidence", "native-state");
		const entries = await fs.readdir(statesDir);
		if (entries.length !== 1 || !/^[a-f0-9]{8}$/.test(entries[0])) throw new Error("Expected one new native audit state.");
		const statePath = path.join(statesDir, entries[0], "state.json");
		const state = await regularJson(statePath, artifactDir);
		// Tracked scope may name committed directory aliases; mandatory review targets must be materialized files.
		const trackedAllowed = manifest.committedEntries ?? manifest.files;
		const materialized = manifest.materializedFiles ?? manifest.files;
		if (scope.commit !== manifest.snapshotCommit || !isDeepStrictEqual(state.scope, scope) ||
			!stringList(scope.tracked_files) || !stringList(trackedAllowed) || !stringList(materialized) ||
			!scope.tracked_files.every((file: string) => trackedAllowed.includes(file))) {
			throw new Error("Native snapshot/scope identity mismatch.");
		}
		const mandatory = scope.mandatory_files;
		if (!Array.isArray(mandatory) || !mandatory.length) return { status: "empty_scope", error: "No auditable committed files in scope." };
		if (!mandatory.every((file: unknown) => typeof file === "string" && materialized.includes(file))) {
			throw new Error("Native snapshot/scope identity mismatch.");
		}
		if (state.phase !== "done" || !covers(mandatory, state.reviewed_files) ||
			!isPlainRecord(state.metrics) || !isPlainRecord(state.truncated_files) ||
			!nonNegativeCount(state.metrics.phase1_profile_failures) ||
			!stringList(state.candidate_files) ||
			!covers(state.candidate_files, state.deep_reviewed_files) ||
			(manifest.audit?.all && !covers(mandatory, state.deep_reviewed_files)) ||
			Object.keys(state.truncated_files).length || (state.metrics.phase1_profile_failures ?? 0) > 0) {
			return { status: "partial", error: "Native audit has incomplete or truncated coverage.", statePath };
		}
		// Phase 4.5 evidence failures are recorded by the adjudication hook; any count fails closed.
		if (!nonNegativeCount(state.metrics.pi_swival_adjudication_errors) || (state.metrics.pi_swival_adjudication_errors ?? 0) > 0) {
			return { status: "partial", error: "Native audit has terminal adjudication failures.", statePath };
		}
		const incomplete = () => ({ status: "partial" as const, error: "Native verification/artifact coverage is incomplete.", statePath });
		if (!Array.isArray(state.proposed_findings) || !Array.isArray(state.verified_findings) ||
			!isPlainRecord(state.verification_state) || !isPlainRecord(state.artifact_state)) return incomplete();
		const proposedFindings = state.proposed_findings.map(releasedFinding);
		const proposedKeys = state.proposed_findings.map(nativeFindingKey);
		if (proposedFindings.some((finding: ReleasedFindingRecord | undefined) => finding === undefined) ||
			proposedKeys.some((key: string | undefined) => key === undefined) ||
			new Set(proposedKeys).size !== proposedKeys.length) return incomplete();
		const expectedProposalKeys = proposedKeys as string[];
		if (Object.keys(state.verification_state).length !== expectedProposalKeys.length ||
			expectedProposalKeys.some((key) => !Object.hasOwn(state.verification_state, key))) return incomplete();
		const verifiedProposals: ReleasedFindingRecord[] = [];
		for (let index = 0; index < expectedProposalKeys.length; index++) {
			const entry = state.verification_state[expectedProposalKeys[index]];
			if (!isPlainRecord(entry) || !["verified", "discarded"].includes(entry.status)) return incomplete();
			if (entry.status === "verified") verifiedProposals.push(proposedFindings[index]!);
		}
		const verifiedFields = new Set(["finding", "correctness_reason", "rebuttal_reason", "reproducer"]);
		const verifiedKeys: string[] = [];
		const survivorFindings: ReleasedFindingRecord[] = [];
		for (const verified of state.verified_findings) {
			if (!isPlainRecord(verified) || !hasOnlyFields(verified, verifiedFields) ||
				typeof verified.correctness_reason !== "string" || typeof verified.rebuttal_reason !== "string" ||
				!(verified.reproducer == null || isPlainRecord(verified.reproducer))) return incomplete();
			const finding = releasedFinding(verified.finding);
			const key = nativeFindingKey(verified.finding);
			if (!finding || !key) return incomplete();
			survivorFindings.push(finding);
			verifiedKeys.push(key);
		}
		const adjudicationDrops = releasedAdjudicationDrops(Object.hasOwn(state, "adjudication_discarded") ? state.adjudication_discarded : []);
		if (!adjudicationDrops || !hasFeasibleFindingLineage(verifiedProposals, survivorFindings, adjudicationDrops)) return incomplete();
		if (new Set(verifiedKeys).size !== verifiedKeys.length ||
			Object.keys(state.artifact_state).length !== verifiedKeys.length ||
			verifiedKeys.some((key) => !Object.hasOwn(state.artifact_state, key))) return incomplete();
		const reportFilenames = new Set<string>();
		const patchFilenames = new Set<string>();
		for (const key of verifiedKeys) {
			const entry = state.artifact_state[key];
			if (!isPlainRecord(entry)) return incomplete();
			if (entry.status !== "written") return { status: "partial", error: "Native findings have unfinished artifacts.", statePath };
			for (const [field, extension] of [["report_filename", "md"], ["patch_filename", "patch"]] as const) {
				const name = entry[field];
				if (typeof name !== "string" || !new RegExp(`^[0-9]+-[a-zA-Z0-9_-]+\\.${extension}$`).test(name)) throw new Error("Unsupported native artifact filename.");
				const filenames = extension === "md" ? reportFilenames : patchFilenames;
				if (filenames.has(name)) return { status: "failed", error: "Native artifact filenames are reused across findings.", statePath };
				filenames.add(name);
				const file = path.join(artifactDir, "evidence", "audit-findings", name);
				const stat = await fs.lstat(file);
				if ((await fs.realpath(file)) !== file || !stat.isFile() || stat.size > NATIVE_FILE_LIMIT) {
					throw new Error("Missing regular bounded native report/patch pair.");
				}
				if (!regularBytes(artifactDir, file, NATIVE_FILE_LIMIT).toString("utf8").trim()) {
					return { status: "partial", error: `Native finding ${extension === "md" ? "report" : "patch"} is empty.`, statePath };
				}
			}
		}
		if (Object.hasOwn(state.metrics, "truncated_calls") && state.metrics.truncated_calls !== 0) {
			return { status: "partial", error: "Native audit has incomplete or truncated coverage.", statePath };
		}
		return { status: "completed", answer: report.result.answer, statePath };
	} catch { return { status: "failed", error: "Native audit lacks valid state, scope, or report/patch evidence." }; }
}
