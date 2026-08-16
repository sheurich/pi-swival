import { describe, expect, it } from "vitest";
import {
	classifyRunLiveness,
	collapseHtmlStderr,
	filterStderrLines,
	parseSessionCost,
	parseTraceStatus,
	parseTurnBanner,
	type RunLiveness,
} from "../extensions/index.js";

const costComplete = "  Session cost: ~$2.98";
const costPartial = "  Known session cost: ~$1.2345 (3 calls unpriced)";
const turnOne = "───────────────────────── Turn 1/250 (~13,192 tokens) ──────────────────────────";
const turnThirty = "──────────────── Turn 30/250 (~48,001 / 200,000 tokens, 24%) ───────────────────";

describe("stderr progress parsers", () => {
	it("parses a complete priced session cost", () => {
		expect(parseSessionCost(costComplete)).toEqual({ costUsd: 2.98, unpricedCalls: 0, known: true });
	});

	it("parses a partially priced session cost", () => {
		expect(parseSessionCost(costPartial)).toEqual({ costUsd: 1.2345, unpricedCalls: 3, known: false });
	});

	it("does not turn an absent or zero-rendered cost into zero", () => {
		expect(parseSessionCost("  Cache: /tmp/cache.db (2 entries)\n")).toBeUndefined();
		expect(parseSessionCost("  Session cost: ~$0.000000")).toBeUndefined();
	});

	it("parses the first turn banner with its box-drawing wrapper", () => {
		expect(parseTurnBanner(turnOne)).toEqual({ turn: 1, turnLimit: 250, tokenEstimate: 13192 });
	});

	it("takes the last turn banner and parses context usage", () => {
		expect(parseTurnBanner(`${turnOne}\n${turnThirty}`)).toEqual({
		turn: 30,
		turnLimit: 250,
		tokenEstimate: 48001,
		contextLength: 200000,
		percent: 24,
	});
	});
});

describe("stderr reporting filters", () => {
	it("drops skill discovery labels and wrapped skill names", () => {
		expect(filterStderrLines([
			"  Discovered 125 skill(s): 3percent-audit, access-review, acm, agent-browser,",
			"apple-containers, atlassian, audit-log-completeness, auditing-with-swival,",
			"boulder-deploy, brainstorming, brevity, ca-boulder, cascading-failures",
			"Error: AWS SSO token is missing or expired",
		])).toEqual(["Error: AWS SSO token is missing or expired"]);
	});

	it("collapses a Cloudflare HTML body to its useful status and challenge text", () => {
		const filtered = collapseHtmlStderr([
			"Error: LLM call failed (model: global.anthropic.claude-sonnet-5): litellm.APIError: APIError: ChatgptException - <html>",
			"  <body><span id=\"challenge-error-text\">Enable JavaScript and cookies to continue</span>",
			"<script>window._cf_chl_opt = {cType: 'managed'};</script></body></html>",
		]);
		expect(filtered).toHaveLength(1);
		expect(filtered[0]).toMatch(/ChatgptException/);
		expect(filtered[0]).toMatch(/Enable JavaScript and cookies to continue/);
		expect(filtered[0]).toMatch(/challenge-error-text/);
	});
});

describe("trace status and liveness", () => {
	it("reads last tool, activity, and assistant turn depth from trace JSONL", () => {
		const trace = [
			JSON.stringify({ type: "user", timestamp: "2026-08-15T20:00:00.000Z" }),
			JSON.stringify({ type: "assistant", timestamp: "2026-08-15T20:01:00.000Z", message: { content: [{ type: "tool_use", name: "read_file" }] } }),
			JSON.stringify({ type: "user", timestamp: "2026-08-15T20:01:01.000Z" }),
		].join("\n");
		expect(parseTraceStatus(trace)).toEqual({
			turns: 1,
			lastToolCall: "read_file",
			lastActivityAt: "2026-08-15T20:01:01.000Z",
		});
	});

	const state = (overrides: Partial<Parameters<typeof classifyRunLiveness>[0]> = {}) => ({
		startedAt: 1_000_000,
		pid: 4321,
		completed: false,
		inMemory: "none" as const,
		...overrides,
	});

	it.each([
		["exited from marker", state({ completed: true }), undefined, "exited"],
		["exited from memory", state({ inMemory: "exited" }), undefined, "exited"],
		["exited from child exitCode", state({ inMemory: "live", exitCode: 0 }), undefined, "exited"],
		["exited from child signalCode", state({ inMemory: "live", signalCode: "SIGTERM" }), undefined, "exited"],
		["live in memory", state({ inMemory: "live" }), undefined, "running"],
		["live corroborated pid", state(), async () => 1_000_001, "running"],
		["unknown without pid", state({ pid: undefined }), undefined, "unknown"],
		["unknown when pid start cannot be read", state(), async () => undefined, "unknown"],
		["unknown on pid reuse", state(), async () => 900_000, "unknown"],
	] as const)("classifies %s", async (_name, input, source, expected) => {
		const result: RunLiveness = await classifyRunLiveness(input, { processStartTime: source, isAlive: () => true });
		expect(result).toBe(expected);
	});
});
