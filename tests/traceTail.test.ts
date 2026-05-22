import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startTraceTail, type TraceEvent } from "../extensions/index.js";

/** Write `content` to the trace JSONL file, creating it if needed. */
function appendTrace(filePath: string, content: string) {
	fs.appendFileSync(filePath, content);
}

/** Poll until `predicate` returns true or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000, intervalMs = 50): Promise<void> {
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
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
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
	});

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
