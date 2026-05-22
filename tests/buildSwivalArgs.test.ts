import { describe, expect, it } from "vitest";
import { buildSwivalArgs, type SwivalOverrides } from "../extensions/index.js";
import type { SwivalAgentConfig } from "../extensions/agents.js";

function makeAgent(overrides: Partial<SwivalAgentConfig> = {}): SwivalAgentConfig {
	return {
		name: "test-agent",
		description: "a test agent",
		systemPrompt: "you are a test",
		source: "user",
		filePath: "/tmp/test-agent.md",
		...overrides,
	};
}

describe("buildSwivalArgs", () => {
	it("always disables lifecycle / MCP / A2A / history / continue / memory by default", () => {
		const args = buildSwivalArgs(makeAgent(), "/tmp/r.json", "/cwd");
		expect(args).toContain("--no-lifecycle");
		expect(args).toContain("--no-mcp");
		expect(args).toContain("--no-a2a");
		expect(args).toContain("--no-history");
		expect(args).toContain("--no-continue");
		expect(args).toContain("--no-memory");
	});

	it("respects explicit noLifecycle=false / noMcp=false / noA2a=false", () => {
		const args = buildSwivalArgs(
			makeAgent({ noLifecycle: false, noMcp: false, noA2a: false }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).not.toContain("--no-lifecycle");
		expect(args).not.toContain("--no-mcp");
		expect(args).not.toContain("--no-a2a");
	});

	it("omits --no-history / --no-continue / --no-memory when agent opts out", () => {
		const args = buildSwivalArgs(
			makeAgent({ noHistory: false, noContinue: false, noMemory: false }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).not.toContain("--no-history");
		expect(args).not.toContain("--no-continue");
		expect(args).not.toContain("--no-memory");
	});

	it("passes provider / profile / model / base-url from frontmatter", () => {
		const args = buildSwivalArgs(
			makeAgent({
				provider: "generic",
				profile: "fast",
				model: "claude-opus-4-6",
				baseUrl: "http://127.0.0.1:4000",
			}),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--provider");
		expect(args).toContain("generic");
		expect(args).toContain("--profile");
		expect(args).toContain("fast");
		expect(args).toContain("--model");
		expect(args).toContain("claude-opus-4-6");
		expect(args).toContain("--base-url");
		expect(args).toContain("http://127.0.0.1:4000");
	});

	it("overrides outrank frontmatter for provider/profile/model/baseUrl", () => {
		const args = buildSwivalArgs(
			makeAgent({ provider: "openrouter", profile: "fast", model: "a", baseUrl: "http://a" }),
			"/tmp/r.json",
			"/cwd",
			{ provider: "bedrock", profile: "slow", model: "b", baseUrl: "http://b" },
		);
		// The override wins: look for the overridden value after the flag.
		const idx = (flag: string) => args.indexOf(flag);
		expect(args[idx("--provider") + 1]).toBe("bedrock");
		expect(args[idx("--profile") + 1]).toBe("slow");
		expect(args[idx("--model") + 1]).toBe("b");
		expect(args[idx("--base-url") + 1]).toBe("http://b");
	});

	it("passes through sampling flags when set", () => {
		const args = buildSwivalArgs(
			makeAgent({
				temperature: 0.2,
				topP: 0.9,
				seed: 42,
				reasoningEffort: "high",
				maxOutputTokens: 16000,
				maxTurns: 50,
			}),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--temperature");
		expect(args).toContain("0.2");
		expect(args).toContain("--top-p");
		expect(args).toContain("0.9");
		expect(args).toContain("--seed");
		expect(args).toContain("42");
		expect(args).toContain("--reasoning-effort");
		expect(args).toContain("high");
		expect(args).toContain("--max-output-tokens");
		expect(args).toContain("16000");
		expect(args).toContain("--max-turns");
		expect(args).toContain("50");
	});

	it("override sampling fields outrank frontmatter", () => {
		const args = buildSwivalArgs(
			makeAgent({ temperature: 0.1 }),
			"/tmp/r.json",
			"/cwd",
			{ temperature: 0.9 },
		);
		const i = args.indexOf("--temperature");
		expect(args[i + 1]).toBe("0.9");
	});

	it("enables --cache and --cache-dir when set", () => {
		const args = buildSwivalArgs(
			makeAgent({ cache: true, cacheDir: "/tmp/cache" }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--cache");
		expect(args).toContain("--cache-dir");
		expect(args).toContain("/tmp/cache");
	});

	it("self-review override can force-enable the reviewer loop", () => {
		const args = buildSwivalArgs(makeAgent(), "/tmp/r.json", "/cwd", { selfReview: true });
		expect(args).toContain("--self-review");
	});

	it("passes reviewer / review-prompt / verify", () => {
		const args = buildSwivalArgs(
			makeAgent({
				reviewer: "/usr/bin/reviewer.sh",
				reviewPrompt: "Check for X",
				verify: "/tmp/accept.md",
				maxReviewRounds: 3,
			}),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--reviewer");
		expect(args).toContain("/usr/bin/reviewer.sh");
		expect(args).toContain("--review-prompt");
		expect(args).toContain("Check for X");
		expect(args).toContain("--verify");
		expect(args).toContain("/tmp/accept.md");
		expect(args).toContain("--max-review-rounds");
		expect(args).toContain("3");
	});

	it("yolo short-circuits sandbox/files/commands", () => {
		const args = buildSwivalArgs(
			makeAgent({ yolo: true, sandbox: "agentfs", files: "all", commands: "ls,rg" }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--yolo");
		expect(args).not.toContain("--sandbox");
		expect(args).not.toContain("--files");
		expect(args).not.toContain("--commands");
	});

	it("sandbox / files / commands land when yolo is absent", () => {
		const args = buildSwivalArgs(
			makeAgent({ sandbox: "agentfs", files: "some", commands: "ls,rg" }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--sandbox");
		expect(args).toContain("agentfs");
		expect(args).toContain("--files");
		expect(args).toContain("some");
		expect(args).toContain("--commands");
		expect(args).toContain("ls,rg");
	});

	it("baseDir wins over cwd; addDir/addDirRo are repeated", () => {
		const args = buildSwivalArgs(
			makeAgent({
				baseDir: "/work",
				addDir: ["/extra1", "/extra2"],
				addDirRo: ["/ref/repo"],
			}),
			"/tmp/r.json",
			"/cwd-fallback",
		);
		const bd = args.indexOf("--base-dir");
		expect(args[bd + 1]).toBe("/work");
		expect(args.filter((a) => a === "--add-dir").length).toBe(2);
		expect(args).toContain("/extra1");
		expect(args).toContain("/extra2");
		expect(args.filter((a) => a === "--add-dir-ro").length).toBe(1);
		expect(args).toContain("/ref/repo");
	});

	it("falls back to cwd for --base-dir when baseDir is absent", () => {
		const args = buildSwivalArgs(makeAgent(), "/tmp/r.json", "/cwd-fallback");
		const bd = args.indexOf("--base-dir");
		expect(args[bd + 1]).toBe("/cwd-fallback");
	});

	it("includes --report, --no-color, and the system prompt body", () => {
		const args = buildSwivalArgs(makeAgent({ systemPrompt: "HELLO" }), "/tmp/r.json", "/cwd");
		expect(args).toContain("--no-color");
		expect(args).toContain("--report");
		expect(args).toContain("/tmp/r.json");
		expect(args).toContain("--system-prompt");
		expect(args).toContain("HELLO");
	});

	it("omits --system-prompt when the body is blank", () => {
		const args = buildSwivalArgs(makeAgent({ systemPrompt: "   " }), "/tmp/r.json", "/cwd");
		expect(args).not.toContain("--system-prompt");
	});

	it("traceDir override adds --trace-dir", () => {
		const args = buildSwivalArgs(makeAgent(), "/tmp/r.json", "/cwd", { traceDir: "/tmp/trace" });
		const i = args.indexOf("--trace-dir");
		expect(i).toBeGreaterThan(-1);
		expect(args[i + 1]).toBe("/tmp/trace");
	});

	it("extraArgs are appended unmodified", () => {
		const args = buildSwivalArgs(
			makeAgent({ extraArgs: ["--max-context-tokens", "128000", "--sanitize-thinking"] }),
			"/tmp/r.json",
			"/cwd",
		);
		const i = args.indexOf("--max-context-tokens");
		expect(i).toBeGreaterThan(-1);
		expect(args[i + 1]).toBe("128000");
		expect(args).toContain("--sanitize-thinking");
	});

	it("passes --proactive-summaries when set", () => {
		const args = buildSwivalArgs(
			makeAgent({ proactiveSummaries: true }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--proactive-summaries");
	});

	it("passes --retries with the configured budget", () => {
		const args = buildSwivalArgs(makeAgent({ retries: 3 }), "/tmp/r.json", "/cwd");
		const i = args.indexOf("--retries");
		expect(i).toBeGreaterThan(-1);
		expect(args[i + 1]).toBe("3");
	});

	it("passes AgentFS session controls (--sandbox-session / --sandbox-strict-read / --no-sandbox-auto-session)", () => {
		const args = buildSwivalArgs(
			makeAgent({
				sandbox: "agentfs",
				sandboxSession: "sess-abc",
				sandboxStrictRead: true,
				noSandboxAutoSession: true,
			}),
			"/tmp/r.json",
			"/cwd",
		);
		const s = args.indexOf("--sandbox-session");
		expect(s).toBeGreaterThan(-1);
		expect(args[s + 1]).toBe("sess-abc");
		expect(args).toContain("--sandbox-strict-read");
		expect(args).toContain("--no-sandbox-auto-session");
	});

	it("does not set --self-review unless frontmatter or override requests it", () => {
		const args = buildSwivalArgs(makeAgent(), "/tmp/r.json", "/cwd");
		expect(args).not.toContain("--self-review");
	});

	it("selfReview override suppresses --reviewer when both would conflict", () => {
		const args = buildSwivalArgs(
			makeAgent({ reviewer: "/bin/true" }),
			"/tmp/r.json",
			"/cwd",
			{ selfReview: true },
		);
		expect(args).toContain("--self-review");
		expect(args).not.toContain("--reviewer");
	});

	it("frontmatter selfReview=true suppresses --reviewer even when reviewer is set", () => {
		const args = buildSwivalArgs(
			makeAgent({ selfReview: true, reviewer: "/bin/true" }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--self-review");
		expect(args).not.toContain("--reviewer");
	});

	it("emits --reviewer when only reviewer is set (no selfReview)", () => {
		const args = buildSwivalArgs(
			makeAgent({ reviewer: "/bin/true" }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--reviewer");
		expect(args).toContain("/bin/true");
		expect(args).not.toContain("--self-review");
	});

	it("override with undefined does not reset a frontmatter-set flag", () => {
		const args = buildSwivalArgs(
			makeAgent({ model: "from-fm" }),
			"/tmp/r.json",
			"/cwd",
			{ model: undefined } satisfies SwivalOverrides,
		);
		expect(args).toContain("from-fm");
	});
});
