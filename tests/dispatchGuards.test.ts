import { describe, expect, it } from "vitest";
import {
	checkRequiresReviewer,
	getParallelCwdCollisionKey,
	isMutatingCwdAgent,
	mergeTaskOverrides,
	READ_ONLY_AUDIT_COMMANDS,
	resolveEffectiveSandboxSettings,
	unknownAgentMessage,
} from "../extensions/runtime.js";
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

describe("resolveEffectiveSandboxSettings", () => {
	it("lets task-level session override agent-level and top-level sessions", () => {
		const sandbox = resolveEffectiveSandboxSettings(
			makeAgent({ sandbox: "agentfs", sandboxSession: "agent-session" }),
			mergeTaskOverrides({ isolation: "agentfs", sandboxSession: "top-session" }, { sandboxSession: "task-session" }),
		);
		expect(sandbox).toEqual({
			isolation: "agentfs",
			sandboxSession: "task-session",
			noSandboxAutoSession: false,
		});
	});

	it("treats an agentfs override without a session as an automatic isolated overlay", () => {
		expect(resolveEffectiveSandboxSettings(makeAgent(), { isolation: "agentfs" })).toEqual({
			isolation: "agentfs",
			sandboxSession: undefined,
			noSandboxAutoSession: true,
		});
	});
});

describe("mergeTaskOverrides", () => {
	it("preserves unrelated top-level overrides while applying task-level fields", () => {
		const merged = mergeTaskOverrides(
			{ model: "gpt-x", seed: 10, isolation: "builtin", sandboxSession: "top", noSandboxAutoSession: false },
			{ seed: 22, isolation: "agentfs", sandboxSession: "task", noSandboxAutoSession: true },
		);
		expect(merged).toEqual({
			model: "gpt-x",
			seed: 22,
			isolation: "agentfs",
			sandboxSession: "task",
			noSandboxAutoSession: true,
		});
	});
});

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

	it("returns true when an explicit named AgentFS session reintroduces same-overlay writes", () => {
		expect(isMutatingCwdAgent(makeAgent(), { isolation: "agentfs", sandboxSession: "shared" })).toBe(true);
	});

	it("returns true when noSandboxAutoSession is set without an agentfs sandbox", () => {
		expect(isMutatingCwdAgent(makeAgent({ noSandboxAutoSession: true }))).toBe(true);
	});
});

describe("getParallelCwdCollisionKey", () => {
	it("uses the named AgentFS session as the collision key", () => {
		expect(
			getParallelCwdCollisionKey(makeAgent(), { isolation: "agentfs", sandboxSession: "shared-session" }),
		).toBe("agentfs:shared-session");
	});

	it("allows truly distinct automatic AgentFS overlays by omitting a collision key", () => {
		expect(getParallelCwdCollisionKey(makeAgent(), { isolation: "agentfs" })).toBeUndefined();
	});

	it("keeps read-only agents exempt from collision analysis", () => {
		expect(getParallelCwdCollisionKey(makeAgent({ commands: READ_ONLY_AUDIT_COMMANDS }), {})).toBeUndefined();
	});

	it("uses the real cwd as the collision key for non-AgentFS write-capable tasks", () => {
		expect(getParallelCwdCollisionKey(makeAgent(), {})).toBe("cwd");
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
