import { describe, it, expect } from "vitest";
import { applyInlineCap } from "../extensions/index.js";

describe("applyInlineCap", () => {
	describe("no truncation cases", () => {
		it("returns body unchanged when cap is undefined", () => {
			const body = "hello world";
			expect(applyInlineCap(body, undefined, undefined)).toBe(body);
		});

		it("returns body unchanged when cap is larger than body", () => {
			const body = "hello world";
			expect(applyInlineCap(body, 100, undefined)).toBe(body);
		});

		it("returns body unchanged when cap equals body length", () => {
			const body = "hello world";
			expect(applyInlineCap(body, body.length, undefined)).toBe(body);
		});

		it("returns body unchanged when cap is zero", () => {
			const body = "hello world";
			expect(applyInlineCap(body, 0, undefined)).toBe(body);
		});

		it("returns body unchanged when cap is negative", () => {
			const body = "hello world";
			expect(applyInlineCap(body, -5, undefined)).toBe(body);
		});
	});

	describe("truncation cases", () => {
		it("truncates body and appends marker without pointer", () => {
			const body = "abcdefghij"; // 10 chars
			const result = applyInlineCap(body, 5, undefined);
			expect(result).toBe("abcde\n[truncated 5 chars]");
		});

		it("truncated prefix length equals cap", () => {
			const body = "abcdefghij"; // 10 chars
			const cap = 4;
			const result = applyInlineCap(body, cap, undefined);
			const lines = result.split("\n");
			expect(lines[0].length).toBe(cap);
		});

		it("marker contains pointer when pointer is supplied", () => {
			const body = "abcdefghij"; // 10 chars
			const result = applyInlineCap(body, 5, "/tmp/artifacts");
			expect(result).toBe("abcde\n[truncated 5 chars; full output at /tmp/artifacts]");
		});

		it("marker omits pointer when pointer is undefined", () => {
			const body = "abcdefghij"; // 10 chars
			const result = applyInlineCap(body, 5, undefined);
			expect(result).not.toContain("full output at");
			expect(result).toContain("[truncated 5 chars]");
		});

		it("cut count reflects characters removed", () => {
			const body = "x".repeat(200);
			const cap = 50;
			const cut = body.length - cap;
			const result = applyInlineCap(body, cap, undefined);
			expect(result).toContain(`[truncated ${cut} chars]`);
		});

		it("handles body of exactly cap+1 chars", () => {
			const body = "a".repeat(11);
			const result = applyInlineCap(body, 10, "dir/out");
			expect(result).toBe("aaaaaaaaaa\n[truncated 1 chars; full output at dir/out]");
		});
	});
});
