import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { nativeFindingKey } from "../extensions/native-audit.js";
import { nativeTestPython as python } from "./nativePython.js";

const releasedKey = (finding: Record<string, unknown>) => execFileSync(python, ["-I", "-B", "-c", [
	"import json, sys",
	"from swival.audit import FindingRecord, _finding_key",
	"print(_finding_key(FindingRecord(**json.load(sys.stdin))))",
].join("; ")], { input: JSON.stringify(finding), timeout: 5000, maxBuffer: 16 * 1024 }).toString().trim();

const cases = [
	["acbd6d629a17", { title: "test", finding_type: "security", severity: "high",
		locations: ["code.py:1"], preconditions: [], proof: ["proof"], fix_outline: "fix", source_file: "code.py" }],
	["8a07c018c0ee", { title: "Café 😀", finding_type: "auth", severity: "medium",
		locations: ["src/é.py:2"], preconditions: ["line\nfeed"], proof: ["雪", "\0"],
		fix_outline: "quote \" slash \\", source_file: "src/é.py", triage_decision: "escalated", threat_model: "用户" }],
] as const;

describe("released Swival finding coverage identity", () => {
	it.each(cases)("matches pinned Python serialization for %s", (expected, finding) => {
		expect(releasedKey(finding)).toBe(expected);
		expect(nativeFindingKey(finding)).toBe(expected);
	});

	it("rejects values outside the released FindingRecord schema", () => {
		const finding = { ...cases[0][1], locations: [1] };
		expect(nativeFindingKey(finding)).toBeUndefined();
		expect(nativeFindingKey([cases[0][1]])).toBeUndefined();
	});
});
