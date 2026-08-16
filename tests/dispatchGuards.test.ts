import { describe, expect, it } from "vitest";
import {
	checkRequiresReviewer,
	isMutatingCwdAgent,
	READ_ONLY_AUDIT_COMMANDS,
	unknownAgentMessage,
} from "../extensions/index.js";
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

describe("isMutatingCwdAgent", () => {
	it("treats a plain agent (default files=undefined, no sandbox) as mutating", () => {
		expect(isMutatingCwdAgent(makeAgent())).toBe(true);
	});

	it("returns false when files=none disables the write surface", () => {
		expect(isMutatingCwdAgent(makeAgent({ files: "none" }))).toBe(false);
	});

	it("returns false when commands matches the read-only audit allowlist", () => {
		expect(
			isMutatingCwdAgent(makeAgent({ commands: READ_ONLY_AUDIT_COMMANDS })),
		).toBe(false);
	});

	it("returns true for a partial commands allowlist that is not the canonical read-only set", () => {
		expect(isMutatingCwdAgent(makeAgent({ commands: "ls,rg" }))).toBe(true);
	});

	it("returns false when sandbox=agentfs AND noSandboxAutoSession is set", () => {
		expect(
			isMutatingCwdAgent(makeAgent({ sandbox: "agentfs", noSandboxAutoSession: true })),
		).toBe(false);
	});

	it("returns true when sandbox=agentfs WITHOUT noSandboxAutoSession (shared overlay)", () => {
		expect(isMutatingCwdAgent(makeAgent({ sandbox: "agentfs" }))).toBe(true);
	});

	it("treats an isolation override without a session as per-child AgentFS isolation", () => {
		expect(isMutatingCwdAgent(makeAgent(), { isolation: "agentfs" })).toBe(false);
	});

	it("returns true when noSandboxAutoSession is set without an agentfs sandbox", () => {
		expect(isMutatingCwdAgent(makeAgent({ noSandboxAutoSession: true }))).toBe(true);
	});
});

describe("checkRequiresReviewer", () => {
	it("returns undefined when requiresReviewer is not set", () => {
		expect(checkRequiresReviewer(makeAgent(), {})).toBeUndefined();
	});

	it("returns an error when requiresReviewer=true and no reviewer is attached", () => {
		const err = checkRequiresReviewer(makeAgent({ requiresReviewer: true }), {});
		expect(err).toBeDefined();
		expect(err).toMatch(/requires a reviewer/);
		expect(err).toMatch(/reviewerOverride/);
		expect(err).toMatch(/selfReviewOverride/);
	});

	it("accepts when frontmatter declares a reviewer script", () => {
		expect(
			checkRequiresReviewer(
				makeAgent({ requiresReviewer: true, reviewer: "/bin/true" }),
				{},
			),
		).toBeUndefined();
	});

	it("accepts when frontmatter declares selfReview=true", () => {
		expect(
			checkRequiresReviewer(
				makeAgent({ requiresReviewer: true, selfReview: true }),
				{},
			),
		).toBeUndefined();
	});

	it("accepts when overrides supply a reviewer", () => {
		expect(
			checkRequiresReviewer(makeAgent({ requiresReviewer: true }), { reviewer: "/x.sh" }),
		).toBeUndefined();
	});

	it("accepts when overrides supply selfReview=true", () => {
		expect(
			checkRequiresReviewer(makeAgent({ requiresReviewer: true }), { selfReview: true }),
		).toBeUndefined();
	});
});

describe("unknownAgentMessage", () => {
	it("enumerates the scanned roster in sorted order", () => {
		const msg = unknownAgentMessage("explorer", [
			makeAgent({ name: "self-review-worker" }),
			makeAgent({ name: "audit-worker" }),
			makeAgent({ name: "sandboxed-explorer" }),
		]);
		expect(msg).toBe(
			'Unknown swival agent: "explorer". Available: audit-worker, sandboxed-explorer, self-review-worker',
		);
	});

	it("includes project- and bundled-scope agents", () => {
		const msg = unknownAgentMessage("nope", [
			makeAgent({ name: "swival", source: "bundled" }),
			makeAgent({ name: "repo-local", source: "project" }),
		]);
		expect(msg).toMatch(/Available: repo-local, swival$/);
	});

	it("says none when discovery found no agents", () => {
		expect(unknownAgentMessage("explorer", [])).toBe(
			'Unknown swival agent: "explorer". Available: none',
		);
	});
});
