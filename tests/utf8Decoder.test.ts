import { describe, it, expect } from "vitest";

describe("TextDecoder streaming vs per-chunk Buffer.toString", () => {
    it("preserves multi-byte chars split across chunk boundaries", () => {
        // U+1F600 grinning face emoji = 4 bytes: F0 9F 98 80
        const all = Buffer.from("\u{1F600}", "utf-8");
        const a = all.subarray(0, 2);
        const b = all.subarray(2);
        // Broken pattern (what the code used to do):
        const broken = a.toString("utf-8") + b.toString("utf-8");
        expect(broken).not.toBe("\u{1F600}");
        // Streaming TextDecoder (what the fix uses):
        const dec = new TextDecoder("utf-8");
        const fixed = dec.decode(a, { stream: true }) + dec.decode(b, { stream: true }) + dec.decode();
        expect(fixed).toBe("\u{1F600}");
    });
});
