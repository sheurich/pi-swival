import { expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { nativeTestPython } from "./nativePython.js";
import { inspectNativeAudit } from "../extensions/native-audit.js";
import { nativeScratch } from "./nativeFixtures.js";

it("executes released CLI phases, inherited same-route policy retries, terminal errors, tool denials, and standard auth offline", async () => {
	const result = await new Promise<{ code: number; output: string }>((resolve) => {
		execFile(nativeTestPython, ["-I", "-B", path.join(import.meta.dirname, "native_audit_test.py")], {
			timeout: 90_000, maxBuffer: 64 * 1024,
			env: { ...process.env, LITELLM_LOCAL_MODEL_COST_MAP: "True", NONO_NO_UPDATE_CHECK: "1" },
		}, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, output: stdout + stderr }));
	});
	expect(result.code, result.output).toBe(0);
	expect(result.output).toContain("Ran 27 tests"); expect(result.output).toMatch(/\bOK\b/);
}, 95_000);

it.each(["complete", "empty", "whitespace", "lost", "recovered", "out-of-scope"])(
	"validates actual released CLI finding/verification/patch/%s-report evidence offline", async (report) => {
		const root = nativeScratch("released-finding-");
		try {
			const output = await new Promise<{ code: number; output: string }>((resolve) => {
				execFile(nativeTestPython, ["-I", "-B", path.join(import.meta.dirname, "native_audit_test.py"), "--export-finding", root, report], {
					timeout: 30_000, maxBuffer: 64 * 1024,
					env: { ...process.env, LITELLM_LOCAL_MODEL_COST_MAP: "True", NONO_NO_UPDATE_CHECK: "1" },
				}, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, output: stdout + stderr }));
			});
			expect(output.code, output.output).toBe(0);
			const result = await inspectNativeAudit(root, 0);
			expect(result.status, result.error).toBe(["complete", "recovered", "out-of-scope"].includes(report) ? "completed" : "partial");
			if (["empty", "whitespace"].includes(report)) expect(result.error).toContain("report is empty");
			if (report === "lost") expect(result.error).toContain("expansion");
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	}, 35_000,
);
