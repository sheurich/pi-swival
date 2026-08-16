import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Re-evaluate the extension so its module-level artifact root uses this test's scratch path. */
async function loadExtension(): Promise<(pi: never) => void> {
	vi.resetModules();
	const module = await import("../extensions/index.js");
	return module.default as unknown as (pi: never) => void;
}

function stubPi() {
	const pi = {
		on: vi.fn(() => () => {}),
		registerTool: vi.fn(),
		events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
	};
	const ctx = {
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => "preflight-test-session" },
	};
	return { pi, ctx };
}

describe("registered tool credential preflight", () => {
	it("blocks a ChatGPT dispatch before spawning or creating an artifact run", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-preflight-"));
		const artifactRoot = path.join(root, "artifacts");
		const tokenDir = path.join(root, "chatgpt-token");
		fs.mkdirSync(artifactRoot);
		fs.mkdirSync(tokenDir);
		fs.writeFileSync(path.join(tokenDir, "auth.json"), JSON.stringify({ device_code_requested_at: 1 }));

		const previousArtifactRoot = process.env.PI_SWIVAL_ARTIFACT_ROOT;
		const previousTokenDir = process.env.CHATGPT_TOKEN_DIR;
		try {
			process.env.PI_SWIVAL_ARTIFACT_ROOT = artifactRoot;
			process.env.CHATGPT_TOKEN_DIR = tokenDir;

			const { pi, ctx } = stubPi();
			(await loadExtension())(pi as never);
			expect(pi.registerTool).toHaveBeenCalledTimes(1);
			const tool = pi.registerTool.mock.calls[0]?.[0] as {
				execute: (callId: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, context: typeof ctx) => Promise<unknown>;
			};

			// Deliberately invoke the registered execute function, rather than the
			// preflight helper, so this covers the real dispatch boundary.
			const response = await tool.execute(
				"preflight-call",
				{ agent: "swival", task: "Return the word ready.", providerOverride: "chatgpt" },
				undefined,
				undefined,
				ctx,
			);
			const result = response as { isError?: boolean; content?: Array<{ text?: string }> };
			const text = result.content?.map((part) => part.text ?? "").join("\n") ?? "";
			expect(result.isError).toBe(true);
			expect(text).toMatch(/credential preflight failed/i);
			expect(fs.readdirSync(artifactRoot)).toEqual([]);
		} finally {
			if (previousArtifactRoot === undefined) delete process.env.PI_SWIVAL_ARTIFACT_ROOT;
			else process.env.PI_SWIVAL_ARTIFACT_ROOT = previousArtifactRoot;
			if (previousTokenDir === undefined) delete process.env.CHATGPT_TOKEN_DIR;
			else process.env.CHATGPT_TOKEN_DIR = previousTokenDir;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
