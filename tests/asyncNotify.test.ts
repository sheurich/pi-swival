import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mintArtifactDir, mapSwivalActiveWork } from "../extensions/index.js";
import { createSwivalNotifier } from "../extensions/notify.js";

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-w1-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.useRealTimers();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakePi(sendMessage: (message: unknown, options: unknown) => void) {
	return { sendMessage } as never;
}

describe("async run identity", () => {
	it("uses the artifact directory basename as runId", () => {
		const minted = mintArtifactDir("my agent", "/tmp/artifacts", 1234);
		expect(minted.runId).toBe(path.basename(minted.artifactDir));
		expect(minted.runId).not.toMatch(/^swival-run-/);
	});

	it("maps only live runs owned by the requested session", () => {
		const entries = [
			{ meta: { runId: "one", sessionId: "session-a" }, exited: false },
			{ meta: { runId: "two", sessionId: "session-a" }, exited: true },
			{ meta: { runId: "three", sessionId: "session-b" }, exited: false },
		];
		expect(mapSwivalActiveWork(entries, "session-a")).toEqual([{ id: "one", sessionId: "session-a" }]);
	});
});

describe("swival completion notifier", () => {
	it("rejects a missing or different session", async () => {
		const send = vi.fn();
		const notifier = createSwivalNotifier(fakePi(send), { currentSessionId: "current", batchWindowMs: 0 });
		const dir = tempDir();
		expect(await notifier.deliver({ runId: "old", agent: "a", artifactDir: dir, sessionId: "other", status: "completed" })).toBe(false);
		expect(await notifier.deliver({ runId: "none", agent: "a", artifactDir: dir, status: "completed" })).toBe(false);
		expect(send).not.toHaveBeenCalled();
		notifier.dispose();
	});

	it("deduplicates a run and writes notified after acknowledgement", async () => {
		vi.useFakeTimers();
		const send = vi.fn();
		const dir = tempDir();
		const notifier = createSwivalNotifier(fakePi(send), { currentSessionId: "s", batchWindowMs: 0 });
		const first = notifier.deliver({ runId: "same", agent: "a", artifactDir: dir, sessionId: "s", status: "completed", stdout: "output" });
		await vi.runAllTimersAsync();
		expect(await first).toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
		expect(fs.existsSync(path.join(dir, "notified.json"))).toBe(true);
		expect(await notifier.deliver({ runId: "same", agent: "a", artifactDir: dir, sessionId: "s", status: "completed" })).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
		notifier.dispose();
	});

	it("batches clean completions and displays non-clean outcomes", async () => {
		vi.useFakeTimers();
		const send = vi.fn();
		const dir = tempDir();
		const notifier = createSwivalNotifier(fakePi(send), { currentSessionId: "s", batchWindowMs: 100 });
		const one = notifier.deliver({ runId: "one", agent: "a", artifactDir: dir, sessionId: "s", status: "completed" });
		const two = notifier.deliver({ runId: "two", agent: "b", artifactDir: dir, sessionId: "s", status: "completed" });
		await vi.advanceTimersByTimeAsync(100);
		expect(await one).toBe(true);
		expect(await two).toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[0]).toMatchObject({ display: false });
		expect((send.mock.calls[0]?.[0] as { content: string }).content).toContain("Swival background runs finished (2)");
		const failed = notifier.deliver({ runId: "bad", agent: "c", artifactDir: dir, sessionId: "s", status: "failed" });
		await vi.runAllTimersAsync();
		expect(await failed).toBe(true);
		expect(send).toHaveBeenCalledTimes(2);
		expect(send.mock.calls[1]?.[0]).toMatchObject({ display: true });
		notifier.dispose();
	});

	it("leaves a throwing send unnotified and retries", async () => {
		vi.useFakeTimers();
		const send = vi.fn().mockImplementationOnce(() => { throw new Error("not ready"); });
		const dir = tempDir();
		const notifier = createSwivalNotifier(fakePi(send), { currentSessionId: "s", batchWindowMs: 0 });
		const first = notifier.deliver({ runId: "retry", agent: "a", artifactDir: dir, sessionId: "s", status: "completed" });
		await vi.runAllTimersAsync();
		expect(await first).toBe(false);
		expect(fs.existsSync(path.join(dir, "notified.json"))).toBe(false);
		const second = notifier.deliver({ runId: "retry", agent: "a", artifactDir: dir, sessionId: "s", status: "completed" });
		await vi.runAllTimersAsync();
		expect(await second).toBe(true);
		expect(fs.existsSync(path.join(dir, "notified.json"))).toBe(true);
		expect(send).toHaveBeenCalledTimes(2);
		notifier.dispose();
	});

	it("reconciles completed artifacts without notified.json", async () => {
		const root = tempDir();
		const dir = path.join(root, "run");
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "run-meta.json"), JSON.stringify({ runId: "run", agent: "a", artifactDir: dir, sessionId: "s", stdoutFile: path.join(dir, "stdout.txt") }));
		fs.writeFileSync(path.join(dir, "stdout.txt"), "recovered output");
		fs.writeFileSync(path.join(dir, "completed.json"), JSON.stringify({ exitCode: 0 }));
		const send = vi.fn();
		const notifier = createSwivalNotifier(fakePi(send), { currentSessionId: "s", batchWindowMs: 0 });
		await notifier.reconcile(root);
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		expect(send).toHaveBeenCalledTimes(1);
		expect(fs.existsSync(path.join(dir, "notified.json"))).toBe(true);
		notifier.dispose();
	});
});
