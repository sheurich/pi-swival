import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { attachAsyncRunListeners, mintArtifactDir, mapSwivalActiveWork } from "../extensions/runtime.js";
import { createSwivalNotifier, startSwivalReconciler } from "../extensions/notify.js";

interface SentRecord {
	message: { customType: string; content: string; display: boolean; details?: Record<string, unknown> };
	options: unknown;
}

interface NotifyHarness {
	pi: { sendMessage: (message: unknown, options: unknown) => void; on: (event: string, handler: (event: unknown) => void) => () => void };
	sent: SentRecord[];
	emitAck: (message: SentRecord["message"]) => void;
	waitForSent: (count: number) => Promise<void>;
}

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-w1-"));
	tempDirs.push(dir);
	return dir;
}

async function flushImmediate(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000, intervalMs = 10): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakePi(sendMessage: (message: unknown, options: unknown) => void) {
	return { sendMessage } as never;
}

function makeNotifyHarness(options: { autoAck?: boolean } = {}): NotifyHarness {
	const sent: SentRecord[] = [];
	const listeners = new Set<(event: unknown) => void>();
	const sentWaiters: Array<{ count: number; resolve: () => void }> = [];
	const releaseSentWaiters = () => {
		for (let i = sentWaiters.length - 1; i >= 0; i--) {
			if (sent.length >= sentWaiters[i]!.count) {
				const [{ resolve }] = sentWaiters.splice(i, 1);
				resolve();
			}
		}
	};
	const emitAck = (message: SentRecord["message"]) => {
		for (const listener of listeners) {
			listener({
				type: "message_end",
				message: {
					role: "custom",
					customType: message.customType,
					content: message.content,
					display: message.display,
					details: message.details,
				},
			});
		}
	};
	return {
		pi: {
			sendMessage: (message: unknown, sendOptions: unknown) => {
				const record = { message: message as SentRecord["message"], options: sendOptions };
				sent.push(record);
				releaseSentWaiters();
				if (options.autoAck !== false) queueMicrotask(() => emitAck(record.message));
			},
			on: (event: string, handler: (event: unknown) => void) => {
				if (event === "message_end") listeners.add(handler);
				return () => { listeners.delete(handler); };
			},
		},
		sent,
		emitAck,
		waitForSent: async (count: number) => {
			if (sent.length >= count) return;
			await new Promise<void>((resolve) => sentWaiters.push({ count, resolve }));
		},
	};
}

function expectExactRunIds(actual: unknown, expected: readonly string[]): void {
	expect(Array.isArray(actual)).toBe(true);
	const ids = actual as unknown[];
	expect(ids).toHaveLength(expected.length);
	expect(ids).toEqual(expect.arrayContaining(expected));
	expect(new Set(ids).size).toBe(expected.length);
}

describe("async process completion", () => {
	it("observes real ENOENT child error+close ordering and still finishes once", async () => {
		const root = tempDir();
		const meta = {
			runId: "enoent-run",
			agent: "a",
			task: "t",
			startedAt: Date.now(),
			pid: undefined,
			artifactDir: root,
			stdoutFile: path.join(root, "stdout.txt"),
			stderrFile: path.join(root, "stderr.txt"),
		};
		const finish = vi.fn();
		const { spawn } = await import("node:child_process");
		const proc = spawn(path.join(root, "definitely-missing-executable"), [], { stdio: "ignore" });
		attachAsyncRunListeners(proc as never, { meta, proc: proc as never, exited: false, exitCode: null }, finish);
		const seen: string[] = [];
		proc.once("error", (error) => {
			seen.push(`error:${(error as NodeJS.ErrnoException).code ?? "unknown"}`);
		});
		proc.once("close", (code) => {
			seen.push(`close:${String(code)}`);
		});
		await waitFor(() => finish.mock.calls.length === 1);
		await waitFor(() => seen.some((item) => item.startsWith("error:ENOENT")) && seen.some((item) => item.startsWith("close:")));
		expect(finish).toHaveBeenCalledTimes(1);
		expect(finish).toHaveBeenCalledWith(meta, null);
		expect(fs.readFileSync(path.join(root, "spawn-error.txt"), "utf-8")).toContain("failed to start");
		expect(fs.existsSync(path.join(root, "completed.json"))).toBe(true);
	});

	it("finishes once on error and close even when completed marker writing fails", async () => {
		const process = new EventEmitter() as EventEmitter & { exitCode: number | null; signalCode: NodeJS.Signals | null };
		process.exitCode = null;
		process.signalCode = null;
		const meta = { runId: "run", agent: "a", task: "t", startedAt: Date.now(), pid: 123, artifactDir: tempDir(), stdoutFile: "stdout", stderrFile: "stderr" };
		const finish = vi.fn();
		vi.spyOn(fs.promises, "writeFile").mockRejectedValue(new Error("disk full"));
		attachAsyncRunListeners(process as never, { meta, proc: process as never, exited: false, exitCode: null }, finish);
		expect(process.listenerCount("error")).toBe(1);
		expect(process.listenerCount("close")).toBe(1);
		process.emit("error", new Error("spawn failed"));
		process.emit("close", 1);
		await flushImmediate();
		expect(finish).toHaveBeenCalledTimes(1);
		expect(finish).toHaveBeenCalledWith(meta, null);
	});
});

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

	it("deduplicates a run and writes notified only after a matching custom-message acknowledgement", async () => {
		const harness = makeNotifyHarness({ autoAck: false });
		const dir = tempDir();
		const notifier = createSwivalNotifier(harness.pi as never, { currentSessionId: "s", batchWindowMs: 0 });
		const first = notifier.deliver({ runId: "same", agent: "a", artifactDir: dir, sessionId: "s", status: "completed" });
		await harness.waitForSent(1);
		expect(fs.existsSync(path.join(dir, "notified.json"))).toBe(false);
		harness.emitAck(harness.sent[0]!.message);
		expect(await first).toBe(true);
		expect(fs.existsSync(path.join(dir, "notified.json"))).toBe(true);
		expect(await notifier.deliver({ runId: "same", agent: "a", artifactDir: dir, sessionId: "s", status: "completed" })).toBe(false);
		expect(harness.sent).toHaveLength(1);
		notifier.dispose();
	});

	it("ignores unrelated custom acknowledgements that reuse the same runIds but not the original message identity", async () => {
		vi.useFakeTimers();
		const harness = makeNotifyHarness({ autoAck: false });
		const dir = tempDir();
		const notifier = createSwivalNotifier(harness.pi as never, { currentSessionId: "s", batchWindowMs: 0, ackTimeoutMs: 25 });
		const first = notifier.deliver({ runId: "same", agent: "a", artifactDir: dir, sessionId: "s", status: "completed" });
		await harness.waitForSent(1);
		harness.emitAck({
			customType: "swival-notify",
			content: "forged",
			display: false,
			details: { runIds: ["same"] },
		});
		await vi.runAllTimersAsync();
		expect(await first).toBe(false);
		expect(fs.existsSync(path.join(dir, "notified.json"))).toBe(false);
		notifier.dispose();
	});

	it("accepts a matching acknowledgement even when runIds are reordered within the same batch", async () => {
		const harness = makeNotifyHarness({ autoAck: false });
		const dir = tempDir();
		const notifier = createSwivalNotifier(harness.pi as never, { currentSessionId: "s", batchWindowMs: 25 });
		const first = notifier.deliver({ runId: "one", agent: "a", artifactDir: dir, sessionId: "s", status: "accepted" });
		const second = notifier.deliver({ runId: "two", agent: "b", artifactDir: dir, sessionId: "s", status: "completed" });
		await harness.waitForSent(1);
		const sent = harness.sent[0]!.message;
		expectExactRunIds(sent.details?.runIds, ["one", "two"]);
		harness.emitAck({
			...sent,
			details: {
				...(sent.details ?? {}),
				runIds: ["two", "one"],
			},
		});
		expect(await first).toBe(true);
		expect(await second).toBe(true);
		expect(fs.existsSync(path.join(dir, "notified.json"))).toBe(true);
		notifier.dispose();
	});

	it("rejects an acknowledgement whose runIds contain duplicates instead of the exact batch membership", async () => {
		vi.useFakeTimers();
		const harness = makeNotifyHarness({ autoAck: false });
		const dir = tempDir();
		const notifier = createSwivalNotifier(harness.pi as never, { currentSessionId: "s", batchWindowMs: 0, ackTimeoutMs: 25 });
		const first = notifier.deliver({ runId: "one", agent: "a", artifactDir: dir, sessionId: "s", status: "accepted" });
		const second = notifier.deliver({ runId: "two", agent: "b", artifactDir: dir, sessionId: "s", status: "completed" });
		await harness.waitForSent(1);
		const sent = harness.sent[0]!.message;
		harness.emitAck({
			...sent,
			details: {
				...(sent.details ?? {}),
				runIds: ["one", "one"],
			},
		});
		await vi.runAllTimersAsync();
		expect(await Promise.race([
			Promise.all([first, second]).then(() => "resolved"),
			Promise.resolve("pending"),
		])).toBe("pending");
		expect(fs.existsSync(path.join(dir, "notified.json"))).toBe(false);
		notifier.dispose();
	});

	it("keeps notifications confidential and bounded by never loading stdout files", async () => {
		const harness = makeNotifyHarness();
		const dir = tempDir();
		const stdoutPath = path.join(dir, "stdout.txt");
		fs.writeFileSync(stdoutPath, "secret final answer\n".repeat(2000));
		const readSpy = vi.spyOn(fs.promises, "readFile");
		const notifier = createSwivalNotifier(harness.pi as never, { currentSessionId: "s", batchWindowMs: 0 });
		const delivered = notifier.deliver({ runId: "confidential", agent: "secret-agent", artifactDir: dir, sessionId: "s", status: "completed", stdoutFile: stdoutPath });
		await harness.waitForSent(1);
		expect(await delivered).toBe(true);
		expect(readSpy).not.toHaveBeenCalledWith(stdoutPath, "utf-8");
		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]!.message.content).toContain("completed: **secret-agent** (confidential)");
		expect(harness.sent[0]!.message.content).toContain(`Artifact dir: ${dir}`);
		expect(harness.sent[0]!.message.content).not.toContain("secret final answer");
		expect(harness.sent[0]!.message.details).toMatchObject({ runIds: ["confidential"] });
		notifier.dispose();
	});

	it("batches clean outcomes, surfaces non-clean immediately, and includes runIds in details", async () => {
		const harness = makeNotifyHarness();
		const dir = tempDir();
		const notifier = createSwivalNotifier(harness.pi as never, { currentSessionId: "s", batchWindowMs: 100 });
		const accepted = notifier.deliver({ runId: "one", agent: "a", artifactDir: dir, sessionId: "s", status: "accepted" });
		const completed = notifier.deliver({ runId: "two", agent: "b", artifactDir: dir, sessionId: "s", status: "completed" });
		await harness.waitForSent(1);
		expect(await accepted).toBe(true);
		expect(await completed).toBe(true);
		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]!.message.display).toBe(false);
		expect(harness.sent[0]!.message.content).toContain("Swival background runs finished (2)");
		expectExactRunIds(harness.sent[0]!.message.details?.runIds, ["one", "two"]);
		const failed = notifier.deliver({ runId: "bad", agent: "c", artifactDir: dir, sessionId: "s", status: "error" });
		await harness.waitForSent(2);
		expect(await failed).toBe(true);
		expect(harness.sent).toHaveLength(2);
		expect(harness.sent[1]!.message.display).toBe(true);
		expect(harness.sent[1]!.message.details).toMatchObject({ runIds: ["bad"] });
		notifier.dispose();
	});

	it("leaves a throwing send unnotified and retries", async () => {
		const send = vi.fn(() => { throw new Error("not ready"); });
		const dir = tempDir();
		const notifier = createSwivalNotifier(fakePi(send), { currentSessionId: "s", batchWindowMs: 0 });
		const first = notifier.deliver({ runId: "retry", agent: "a", artifactDir: dir, sessionId: "s", status: "completed" });
		expect(await first).toBe(false);
		expect(fs.existsSync(path.join(dir, "notified.json"))).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
		const second = notifier.deliver({ runId: "retry", agent: "a", artifactDir: dir, sessionId: "s", status: "completed" });
		expect(await second).toBe(false);
		expect(fs.existsSync(path.join(dir, "notified.json"))).toBe(false);
		expect(send).toHaveBeenCalledTimes(2);
		notifier.dispose();
	});

	it("times out missing acknowledgements so reconciliation can retry later", async () => {
		vi.useFakeTimers();
		const harness = makeNotifyHarness({ autoAck: false });
		const root = tempDir();
		const dir = path.join(root, "retryable");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "run-meta.json"), JSON.stringify({
			runId: "retryable",
			agent: "a",
			artifactDir: dir,
			sessionId: "s",
		}));
		fs.writeFileSync(path.join(dir, "completed.json"), JSON.stringify({ exitCode: 0, exitedAt: new Date().toISOString() }));
		fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({ result: { outcome: "success" }, stats: { review_rounds: 0 } }));
		const notifier = createSwivalNotifier(harness.pi as never, { currentSessionId: "s", batchWindowMs: 0, ackTimeoutMs: 25 });
		const first = notifier.deliver({ runId: "retryable", agent: "a", artifactDir: dir, sessionId: "s", status: "completed" });
		await harness.waitForSent(1);
		await vi.runAllTimersAsync();
		expect(harness.sent).toHaveLength(1);
		expect(await first).toBe(false);
		expect(fs.existsSync(path.join(dir, "notified.json"))).toBe(false);
		await notifier.reconcile(root);
		await harness.waitForSent(2);
		await vi.runAllTimersAsync();
		expect(harness.sent).toHaveLength(2);
		expect(fs.existsSync(path.join(dir, "notified.json"))).toBe(false);
		notifier.dispose();
	});

	it("does not resend after acknowledgement when notified.json cannot be written", async () => {
		const harness = makeNotifyHarness({ autoAck: false });
		const dir = tempDir();
		vi.spyOn(fs.promises, "writeFile").mockRejectedValueOnce(new Error("read-only marker"));
		const notifier = createSwivalNotifier(harness.pi as never, { currentSessionId: "s", batchWindowMs: 0 });
		const first = notifier.deliver({ runId: "marker-failure", agent: "a", artifactDir: dir, sessionId: "s", status: "completed" });
		await harness.waitForSent(1);
		harness.emitAck(harness.sent[0]!.message);
		expect(await first).toBe(false);
		expect(harness.sent).toHaveLength(1);
		const second = notifier.deliver({ runId: "marker-failure", agent: "a", artifactDir: dir, sessionId: "s", status: "completed" });
		expect(await second).toBe(false);
		expect(harness.sent).toHaveLength(1);
		notifier.dispose();
	});

	it("reconciles completed artifacts using report outcome plus process termination", async () => {
		vi.useFakeTimers();
		const root = tempDir();
		const harness = makeNotifyHarness();
		const notifier = createSwivalNotifier(harness.pi as never, { currentSessionId: "s", batchWindowMs: 0 });
		const cases = [
			{ runId: "accepted-run", outcome: "success", reviewRounds: 2, exitCode: 0, expectedStatus: "accepted" },
			{ runId: "completed-run", outcome: "success", reviewRounds: 0, exitCode: 0, expectedStatus: "completed" },
			{ runId: "rejected-run", outcome: "failed", reviewRounds: 1, exitCode: 0, expectedStatus: "rejected" },
			{ runId: "error-run", outcome: "error", reviewRounds: 0, exitCode: 0, expectedStatus: "error" },
			{ runId: "failed-run", outcome: "success", reviewRounds: 0, exitCode: 7, expectedStatus: "failed" },
			{ runId: "spawn-run", outcome: undefined, reviewRounds: 0, exitCode: null, spawnError: true, expectedStatus: "failed" },
			{ runId: "stopped-run", outcome: undefined, reviewRounds: 0, exitCode: null, expectedStatus: "stopped" },
		] as const;
		for (const testCase of cases) {
			const dir = path.join(root, testCase.runId);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "run-meta.json"), JSON.stringify({ runId: testCase.runId, agent: testCase.runId, artifactDir: dir, sessionId: "s", stdoutFile: path.join(dir, "stdout.txt"), stderrFile: path.join(dir, "stderr.txt") }));
			if (testCase.outcome) {
				fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({ result: { outcome: testCase.outcome }, stats: { review_rounds: testCase.reviewRounds } }));
			}
			fs.writeFileSync(path.join(dir, "completed.json"), JSON.stringify({ exitCode: testCase.exitCode, exitedAt: new Date().toISOString() }));
			if (testCase.spawnError) fs.writeFileSync(path.join(dir, "spawn-error.txt"), "boom");
		}
		await notifier.reconcile(root);
		await vi.runAllTimersAsync();
		await harness.waitForSent(cases.length);
		expect(harness.sent).toHaveLength(cases.length);
		for (const testCase of cases) {
			const content = harness.sent.find((item) => item.message.details?.runIds?.[0] === testCase.runId)?.message.content ?? "";
			expect(content).toContain(`${testCase.expectedStatus}: **${testCase.runId}** (${testCase.runId})`);
		}
		expect(harness.sent.find((item) => item.message.details?.runIds?.[0] === "error-run")?.message.content).not.toContain("completed:");
		notifier.dispose();
	});

	it("composes attachAsyncRunListeners with the real reconciler contract", async () => {
		const root = tempDir();
		const dir = path.join(root, "composed-run");
		fs.mkdirSync(dir, { recursive: true });
		const meta = {
			runId: "composed-run",
			agent: "composed-agent",
			task: "t",
			startedAt: Date.now(),
			pid: 123,
			artifactDir: dir,
			stdoutFile: path.join(dir, "stdout.txt"),
			stderrFile: path.join(dir, "stderr.txt"),
			sessionId: "s",
		};
		fs.writeFileSync(path.join(dir, "run-meta.json"), JSON.stringify(meta));
		fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({ result: { outcome: "success" }, stats: { review_rounds: 0 } }));
		const proc = new EventEmitter() as EventEmitter & { exitCode: number | null; signalCode: NodeJS.Signals | null };
		proc.exitCode = null;
		proc.signalCode = null;
		attachAsyncRunListeners(proc as never, { meta, proc: proc as never, exited: false, exitCode: null }, vi.fn());
		proc.emit("close", 0);
		await waitFor(() => fs.existsSync(path.join(dir, "completed.json")));
		const harness = makeNotifyHarness();
		const notifier = createSwivalNotifier(harness.pi as never, { currentSessionId: "s", batchWindowMs: 0 });
		const stop = startSwivalReconciler(notifier, { artifactRoot: root, pollIntervalMs: 60_000 });
		await waitFor(() => harness.sent.length === 1);
		await waitFor(() => fs.existsSync(path.join(dir, "notified.json")));
		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]!.message.content).toContain("completed: **composed-agent** (composed-run)");
		stop();
	});
});
