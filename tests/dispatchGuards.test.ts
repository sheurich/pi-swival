import { describe, expect, it } from "vitest";
import {
	checkRequiresReviewer,
	isMutatingCwdAgent,
	READ_ONLY_AUDIT_COMMANDS,
	resolveAgentBaseDir,
	resolveDispatchCwd,
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

	it("treats files=none with unrestricted commands as mutating", () => {
		expect(isMutatingCwdAgent(makeAgent({ files: "none" }))).toBe(true);
	});

	it("returns false only when file writes and mutating commands are both disabled", () => {
		expect(isMutatingCwdAgent(makeAgent({ files: "none", commands: "none" }))).toBe(false);
		expect(
			isMutatingCwdAgent(makeAgent({ files: "none", commands: READ_ONLY_AUDIT_COMMANDS })),
		).toBe(false);
	});

	it("treats a read-only command allowlist with file writes enabled as mutating", () => {
		expect(
			isMutatingCwdAgent(makeAgent({ files: "some", commands: READ_ONLY_AUDIT_COMMANDS })),
		).toBe(true);
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

	it("treats typed and extraArgs named AgentFS sessions as shared overlays", () => {
		expect(
			isMutatingCwdAgent(makeAgent({
				sandbox: "agentfs",
				noSandboxAutoSession: true,
				sandboxSession: "shared-session",
			})),
		).toBe(true);
		expect(
			isMutatingCwdAgent(makeAgent({
				sandbox: "agentfs",
				noSandboxAutoSession: true,
				extraArgs: ["--sandbox-session=shared-session"],
			})),
		).toBe(true);
	});

	it("returns true when noSandboxAutoSession is set without an agentfs sandbox", () => {
		expect(isMutatingCwdAgent(makeAgent({ noSandboxAutoSession: true }))).toBe(true);
	});

	it("uses extraArgs overrides when classifying sandbox isolation", () => {
		expect(
			isMutatingCwdAgent(makeAgent({
				sandbox: "agentfs",
				noSandboxAutoSession: true,
				extraArgs: ["--sandbox", "builtin"],
			})),
		).toBe(true);
		expect(
			isMutatingCwdAgent(makeAgent({
				noSandboxAutoSession: true,
				extraArgs: ["--sandbox=agentfs"],
			})),
		).toBe(false);
	});

	it("uses extraArgs overrides when classifying file and command write surfaces", () => {
		expect(
			isMutatingCwdAgent(makeAgent({
				files: "none",
				commands: "none",
				extraArgs: ["--files", "all"],
			})),
		).toBe(true);
		expect(
			isMutatingCwdAgent(makeAgent({
				files: "none",
				commands: READ_ONLY_AUDIT_COMMANDS,
				extraArgs: ["--commands=all"],
			})),
		).toBe(true);
	});
});

describe("resolveAgentBaseDir", () => {
	it("uses per-task, top-level, then Pi cwd precedence", () => {
		expect(resolveDispatchCwd("../task", "/tmp/top", "/repo/pi")).toBe("/repo/task");
		expect(resolveDispatchCwd(undefined, "/tmp/top", "/repo/pi")).toBe("/tmp/top");
		expect(resolveDispatchCwd(undefined, undefined, "/repo/pi")).toBe("/repo/pi");
	});

	it("resolves typed and extraArgs base directories from the process cwd", () => {
		expect(resolveAgentBaseDir(makeAgent({ baseDir: "../shared" }), "/tmp/worktree-a")).toBe("/tmp/shared");
		expect(resolveAgentBaseDir(makeAgent({
			baseDir: "ignored",
			extraArgs: ["--base-dir", "../shared"],
		}), "/tmp/worktree-b")).toBe("/tmp/shared");
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

	it("rejects when an override disables the only configured reviewer", () => {
		expect(
			checkRequiresReviewer(makeAgent({ requiresReviewer: true, selfReview: true }), { selfReview: false }),
		).toMatch(/requires a reviewer/);
		expect(
			checkRequiresReviewer(makeAgent({ requiresReviewer: true, reviewer: "/bin/true" }), { reviewer: "" }),
		).toMatch(/requires a reviewer/);
	});

	it("rejects conflicting effective reviewer modes", () => {
		expect(
			checkRequiresReviewer(
				makeAgent({ requiresReviewer: true, reviewer: "/bin/true" }),
				{ selfReview: true },
			),
		).toMatch(/mutually exclusive/);
		expect(
			checkRequiresReviewer(makeAgent({
				requiresReviewer: true,
				selfReview: true,
				extraArgs: ["--reviewer=/bin/true"],
			}), {}),
		).toMatch(/mutually exclusive/);
	});

	it("uses final extraArgs reviewer semantics", () => {
		expect(
			checkRequiresReviewer(makeAgent({ requiresReviewer: true, extraArgs: ["--self-review"] }), {}),
		).toBeUndefined();
		expect(
			checkRequiresReviewer(makeAgent({
				requiresReviewer: true,
				reviewer: "/bin/true",
				extraArgs: ["--reviewer="],
			}), {}),
		).toMatch(/requires a reviewer/);
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
