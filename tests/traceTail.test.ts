import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerExtension, { startTraceTail, preflightSwivalVersion, type TraceEvent } from "../extensions/index.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => { resolve = r; });
	return { promise, resolve };
}

function traceLine(type: "assistant" | "user", content: unknown[], sessionId = "session-a") {
	return JSON.stringify({ sessionId, type, message: { role: type === "assistant" ? "assistant" : "user", content } }) + "\n";
}

function call(id: string, file: string, name = "read_file") {
	return { type: "tool_use", id, name, input: { path: file } };
}

function result(id: string, is_error: boolean) {
	return { type: "tool_result", tool_use_id: id, content: "fixture result", is_error };
}

/** Write `content` to the trace JSONL file, creating it if needed. */
function appendTrace(filePath: string, content: string) {
	fs.appendFileSync(filePath, content);
}

/** Poll until `predicate` returns true or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	// Final check — throw if still false so the test message is clear.
	if (!predicate()) {
		throw new Error(`waitFor timed out after ${timeoutMs}ms`);
	}
}

describe("startTraceTail", () => {
	let tempDir: string;

	afterEach(() => {
		vi.restoreAllMocks();
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("cleanup discovers a final trace while directory discovery is queued", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-tail-test-"));
		const gate = deferred();
		const entered = deferred();
		const readdir = fs.promises.readdir.bind(fs.promises);
		vi.spyOn(fs.promises, "readdir").mockImplementation((async (...args: any[]) => {
			if (args[0] === tempDir) { entered.resolve(); await gate.promise; }
			return (readdir as any)(...args);
		}) as any);
		const events: TraceEvent[] = [];
		const cleanup = startTraceTail(tempDir, (event) => events.push(event));
		await entered.promise;
		appendTrace(path.join(tempDir, "session-a.jsonl"), traceLine("assistant", [{ type: "text", text: "at EOF" }]));
		let stopped = false;
		const stopping = cleanup().then(() => { stopped = true; });
		try {
			await new Promise((r) => setImmediate(r));
			expect(stopped).toBe(false);
		} finally {
			gate.resolve();
			await stopping;
			// Let any already queued directory callback settle before removing the directory.
			await new Promise((r) => setImmediate(r));
		}
		expect(events).toEqual([{ type: "text", text: "at EOF" }]);
	});

	it("cleanup awaits an inflight read and drains bytes appended after its size snapshot", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-tail-test-"));
		const file = path.join(tempDir, "session-a.jsonl");
		appendTrace(file, traceLine("assistant", [{ type: "text", text: "first" }]));
		const gate = deferred();
		const entered = deferred();
		const open = fs.promises.open.bind(fs.promises);
		let held = false;
		vi.spyOn(fs.promises, "open").mockImplementation((async (...args: any[]) => {
			const handle = await (open as any)(...args);
			if (args[0] === file && !held) {
				held = true;
				const read = handle.read.bind(handle);
				handle.read = async (...readArgs: any[]) => { entered.resolve(); await gate.promise; return read(...readArgs); };
			}
			return handle;
		}) as any);
		const events: TraceEvent[] = [];
		const cleanup = startTraceTail(tempDir, (event) => events.push(event));
		await entered.promise;
		appendTrace(file, traceLine("assistant", [{ type: "text", text: "last" }]));
		let stopped = false;
		const stopping = cleanup().then(() => { stopped = true; });
		try {
			await new Promise((r) => setImmediate(r));
			expect(stopped).toBe(false);
		} finally {
			gate.resolve();
			await stopping;
			await waitFor(() => events.length === 2);
		}
		expect(events).toEqual([{ type: "text", text: "first" }, { type: "text", text: "last" }]);
	});

	it("preserves session and tool-use identities even when tool names and IDs overlap", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-tail-test-"));
		const events: TraceEvent[] = [];
		appendTrace(path.join(tempDir, "session-a.jsonl"),
			traceLine("assistant", [call("same-id", "a.ts")], "session-a") +
			traceLine("assistant", [call("same-id", "b.ts", "edit")], "session-b") +
			traceLine("user", [result("same-id", false)], "session-a") +
			traceLine("user", [result("same-id", true)], "session-b"));
		const cleanup = startTraceTail(tempDir, (event) => events.push(event));
		await waitFor(() => events.length === 4);
		await cleanup();
		expect(events).toEqual([
			expect.objectContaining({ name: "read_file", sessionId: "session-a", toolUseId: "same-id" }),
			expect.objectContaining({ name: "edit", sessionId: "session-b", toolUseId: "same-id" }),
			expect.objectContaining({ name: "read_file", sessionId: "session-a", toolUseId: "same-id", ok: true }),
			expect.objectContaining({ name: "edit", sessionId: "session-b", toolUseId: "same-id", ok: false }),
		]);
	});

	it("parses tool_use, text, and tool_result events from a synthetic JSONL trace", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-tail-test-"));
		const events: TraceEvent[] = [];
		const cleanup = startTraceTail(tempDir, (ev) => events.push(ev));

		// Write a synthetic JSONL trace file simulating swival output.
		const traceFile = path.join(tempDir, "session-abc123.jsonl");
		const lines = [
			// system message (should be ignored)
			JSON.stringify({ type: "system", message: { role: "system", content: "You are a test agent." } }),
			// assistant with tool_use
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "foo.ts" } },
					],
				},
			}),
			// assistant with text
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Let me read the file." }],
				},
			}),
			// user with tool_result (success)
			JSON.stringify({
				type: "user",
				message: {
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "tu_1", content: "file contents", is_error: false },
					],
				},
			}),
			// assistant with another tool_use
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{ type: "tool_use", id: "tu_2", name: "edit", input: { path: "foo.ts", edits: [] } },
					],
				},
			}),
			// user with tool_result (error)
			JSON.stringify({
				type: "user",
				message: {
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "tu_2", content: "permission denied", is_error: true },
					],
				},
			}),
			// last-prompt (should be ignored — unknown type)
			JSON.stringify({ type: "last-prompt", message: { role: "user", content: "final" } }),
		];

		appendTrace(traceFile, lines.join("\n") + "\n");

		await waitFor(() => events.length >= 5);
		await cleanup();

		// Verify we got the right events in order.
		// 1. tool_use: read_file
		const readCall = events.find((e) => e.type === "toolCall" && e.name === "read_file" && e.ok === undefined);
		expect(readCall).toBeDefined();

		// 2. text
		const textEv = events.find((e) => e.type === "text");
		expect(textEv).toBeDefined();
		expect(textEv?.type === "text" && textEv.text).toBe("Let me read the file.");

		// 3. tool_result ok for read_file
		const readResult = events.find(
			(e) => e.type === "toolCall" && e.name === "read_file" && e.ok === true,
		);
		expect(readResult).toBeDefined();

		// 4. tool_use: edit
		const editCall = events.find((e) => e.type === "toolCall" && e.name === "edit" && e.ok === undefined);
		expect(editCall).toBeDefined();

		// 5. tool_result error for edit
		const editResult = events.find(
			(e) => e.type === "toolCall" && e.name === "edit" && e.ok === false,
		);
		expect(editResult).toBeDefined();

		// "system" and "last-prompt" types should not produce events.
		const systemEvents = events.filter(
			(e) => e.type === "text" && (e as { text: string }).text === "You are a test agent.",
		);
		expect(systemEvents).toHaveLength(0);
	}, 10000);

	it("handles trace file appearing after startTraceTail is called", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-tail-test-"));
		const events: TraceEvent[] = [];
		const cleanup = startTraceTail(tempDir, (ev) => events.push(ev));

		// Delay writing the trace file.
		await new Promise((r) => setTimeout(r, 100));

		const traceFile = path.join(tempDir, "delayed-session.jsonl");
		const line = JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Hello from delayed trace." }],
			},
		});
		appendTrace(traceFile, line + "\n");

		await waitFor(() => events.length >= 1);
		await cleanup();

		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("text");
		expect(events[0].type === "text" && events[0].text).toBe("Hello from delayed trace.");
	});
});


describe("synchronous run trace finalization", () => {
	let root: string;
	afterEach(() => {
		vi.restoreAllMocks();
		vi.mocked(spawn).mockReset();
		if (root) fs.rmSync(root, { recursive: true, force: true });
	});

	async function fixture(trace: string, onUpdate?: (update: any) => void, closeDelay = 150) {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trace-run-test-")));
		await preflightSwivalVersion(async () => "1.0.45");
		vi.mocked(spawn).mockImplementation(((exe: string, args: string[]) => {
			const proc: any = new EventEmitter();
			proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough();
			proc.kill = vi.fn(); proc.unref = vi.fn();
			queueMicrotask(() => {
				fs.writeFileSync(args[args.indexOf("--report") + 1], JSON.stringify({ result: { outcome: "success", answer: "done" } }));
				appendTrace(path.join(args[args.indexOf("--trace-dir") + 1], "session-a.jsonl"), trace);
				proc.stdout.end(); proc.stderr.end();
				setTimeout(() => proc.emit("close", 0), closeDelay);
			});
			return proc;
		}) as any);
		let tool: any;
		registerExtension({ registerTool: (value: any) => { tool = value; } } as any, { artifactRoot: path.join(root, "artifacts") });
		return tool.execute("trace-test", { agent: "swival", task: "fixture" }, undefined, onUpdate, { cwd: root, hasUI: false });
	}

	it("merges overlapping same-name calls by session plus tool-use ID, not recency", async () => {
		const trace = traceLine("assistant", [call("first", "a.ts"), call("second", "b.ts")]) +
			traceLine("assistant", [call("first", "c.ts")], "session-b") +
			traceLine("user", [result("first", true)]) +
			traceLine("user", [result("second", false)]) +
			traceLine("user", [result("first", false)], "session-b");
		const response = await fixture(trace);
		expect(response.details.results[0].traceEvents).toEqual([
			expect.objectContaining({ args: { path: "a.ts" }, ok: false }),
			expect.objectContaining({ args: { path: "b.ts" }, ok: true }),
			expect.objectContaining({ args: { path: "c.ts" }, ok: true }),
		]);
	});

	it("does not merge an orphan result with another identified call of the same name", async () => {
		const trace = traceLine("assistant", [call("finished", "a.ts"), call("pending", "b.ts")]) +
			traceLine("user", [result("finished", false), result("finished", true)]);
		const response = await fixture(trace);
		const events = response.details.results[0].traceEvents;
		expect(events[0].ok).toBe(true);
		expect(events[1].ok).toBeUndefined();
		expect(events).toHaveLength(3);
	});

	it("drains the last read before persistence and the final update", async () => {
		const gate = deferred(); const entered = deferred();
		const open = fs.promises.open.bind(fs.promises);
		vi.spyOn(fs.promises, "open").mockImplementation((async (...args: any[]) => {
			const handle = await (open as any)(...args);
			if (String(args[0]).endsWith("session-a.jsonl")) {
				const read = handle.read.bind(handle);
				handle.read = async (...readArgs: any[]) => { entered.resolve(); await gate.promise; return read(...readArgs); };
			}
			return handle;
		}) as any);
		// Hold report loading until a trace read is definitely in flight.
		const readFile = fs.promises.readFile.bind(fs.promises);
		vi.spyOn(fs.promises, "readFile").mockImplementation((async (...args: any[]) => {
			if (String(args[0]).endsWith("report.json")) await entered.promise;
			return (readFile as any)(...args);
		}) as any);
		const copy = vi.spyOn(fs.promises, "copyFile");
		const updates: any[] = [];
		const pending = fixture(traceLine("assistant", [{ type: "text", text: "final trace" }]),
			(update) => updates.push(JSON.parse(JSON.stringify(update))), 0);
		await entered.promise;
		try {
			await new Promise((r) => setTimeout(r, 50));
			expect(copy).not.toHaveBeenCalled();
		} finally { gate.resolve(); await pending; }
		const response = await pending;
		expect(response.details.results[0].traceEvents).toEqual([{ type: "text", text: "final trace" }]);
		expect(updates.at(-1).details.results[0].traceEvents).toEqual([{ type: "text", text: "final trace" }]);
		expect(fs.readFileSync(path.join(response.details.results[0].artifactDir, "trace", "session-a.jsonl"), "utf8"))
			.toContain("final trace");
	});
});
