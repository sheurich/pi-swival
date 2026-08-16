import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Wiring test for the parts the pure-function tests cannot reach: the
 * session_start hook must build the notifier and reconciler, the reconciler
 * must deliver a completed run through pi.sendMessage, and session_shutdown
 * must tear everything down. The extension factory is driven with a stub pi,
 * so no Pi runtime, no swival process, and no LLM are involved.
 */

/** Poll rather than sleep, so a concurrent fs.watch test is not starved. */
async function waitFor(predicate: () => boolean, timeoutMs = 4000, intervalMs = 25): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** Re-evaluate the extension so module-level ARTIFACT_ROOT reads current env. */
async function loadExtension(): Promise<(pi: never) => void> {
	vi.resetModules();
	const module = await import("../extensions/index.js");
	return module.default as unknown as (pi: never) => void;
}

interface Handlers {
	session_start?: (event: unknown, ctx: unknown) => unknown;
	session_shutdown?: (event: unknown, ctx: unknown) => unknown;
}

function stubPi(sessionId: string) {
	const handlers: Handlers = {};
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const pi = {
		on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
			handlers[event as keyof Handlers] = handler;
			return () => {};
		},
		registerTool: vi.fn(),
		sendMessage: (message: unknown, options: unknown) => { sent.push({ message, options }); },
		events: {
			emit: (channel: string, data: unknown) => { emitted.push({ channel, data }); },
			on: () => () => {},
		},
	};
	const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => sessionId } };
	return { pi, ctx, handlers, sent, emitted };
}

function writeCompletedRun(root: string, runId: string, sessionId: string | undefined): string {
	const dir = path.join(root, runId);
	fs.mkdirSync(dir, { recursive: true });
	const meta: Record<string, unknown> = {
		runId,
		agent: "self-review-worker",
		task: "t",
		startedAt: Date.now(),
		artifactDir: dir,
		stdoutFile: path.join(dir, "stdout.txt"),
		stderrFile: path.join(dir, "stderr.txt"),
	};
	if (sessionId) meta.sessionId = sessionId;
	fs.writeFileSync(path.join(dir, "run-meta.json"), JSON.stringify(meta));
	fs.writeFileSync(path.join(dir, "stdout.txt"), "the final answer");
	fs.writeFileSync(path.join(dir, "completed.json"), JSON.stringify({ exitCode: 0, exitedAt: new Date().toISOString() }));
	return dir;
}

describe("extension wiring", () => {
	it("registers the tool and a session_start hook", async () => {
		const { pi, handlers } = stubPi("session-1");
		(await loadExtension())(pi as never);
		expect(pi.registerTool).toHaveBeenCalledTimes(1);
		expect(typeof handlers.session_start).toBe("function");
		expect(typeof handlers.session_shutdown).toBe("function");
	});

	it("delivers a completed run owned by this session, and ignores others", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-wiring-"));
		const previousRoot = process.env.PI_SWIVAL_ARTIFACT_ROOT;
		try {
			const artifactRoot = path.join(root, "artifacts");
			fs.mkdirSync(artifactRoot);
			const mine = writeCompletedRun(artifactRoot, "mine-1-aaaa", "session-1");
			const theirs = writeCompletedRun(artifactRoot, "theirs-1-bbbb", "session-2");
			const orphan = writeCompletedRun(artifactRoot, "orphan-1-cccc", undefined);

			// Redirect the extension's own artifact root, then re-import it so the
			// module-level constant picks the scratch path up. This exercises the
			// reconciler the session_start hook builds, not a copy of it.
			process.env.PI_SWIVAL_ARTIFACT_ROOT = artifactRoot;
			const factory = await loadExtension();

			const { pi, ctx, handlers, sent } = stubPi("session-1");
			factory(pi as never);
			await handlers.session_start?.({ reason: "startup" }, ctx);
			// The wired notifier batches clean completions for 1500 ms by default.
			await waitFor(() => sent.length >= 1);

			expect(sent).toHaveLength(1);
			const message = sent[0]!.message as { customType: string; content: string; display: boolean };
			expect(message.customType).toBe("swival-notify");
			expect(message.content).toContain("mine-1-aaaa");
			expect(message.content).toContain("the final answer");
			expect(message.display).toBe(false);
			expect(sent[0]!.options).toMatchObject({ triggerTurn: true });

			expect(fs.existsSync(path.join(mine, "notified.json"))).toBe(true);
			expect(fs.existsSync(path.join(theirs, "notified.json"))).toBe(false);
			expect(fs.existsSync(path.join(orphan, "notified.json"))).toBe(false);

			handlers.session_shutdown?.({}, ctx);
		} finally {
			if (previousRoot === undefined) delete process.env.PI_SWIVAL_ARTIFACT_ROOT;
			else process.env.PI_SWIVAL_ARTIFACT_ROOT = previousRoot;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
