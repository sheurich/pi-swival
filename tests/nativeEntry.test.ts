import { expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { nativeTestPython } from "./nativePython.js";
import { inspectNativeAudit } from "../extensions/native-audit.js";

it("executes released Session.ask native phases and inherited isolation with denied sockets", async () => {
	// The aggregate includes five cold subprocesses; allow startup under full-suite load.
	const result = await new Promise<{ code: number; output: string; diagnostics: string }>((resolve) => {
		execFile(nativeTestPython, ["-I", "-B", path.join(import.meta.dirname, "native_audit_test.py")],
			{ timeout: 60_000, maxBuffer: 64 * 1024,
				env: { ...process.env, LITELLM_LOCAL_MODEL_COST_MAP: "True" } },
			(error, stdout, stderr) => {
				const output = stdout + stderr;
				resolve({ code: error ? 1 : 0, output, diagnostics: JSON.stringify({ output,
					error: error && { code: error.code, killed: error.killed, signal: error.signal } }) });
			});
	});
	expect(result.code, result.diagnostics).toBe(0);
	expect(result.output).toContain("Ran 36 tests");
	expect(result.output).toMatch(/\bOK\b/);
}, 65_000);

it.each(["complete", "empty", "whitespace", "lost", "recovered", "out-of-scope"])(
	"validates released finding/verification/patch/%s-report evidence without provider transport", async (report) => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "released-finding-")));
		try {
			const output = await new Promise<{ code: number; output: string }>((resolve) => {
				execFile(nativeTestPython, ["-I", "-B", path.join(import.meta.dirname, "native_audit_test.py"),
					"--export-finding", root, report], {
						timeout: 20_000, maxBuffer: 64 * 1024,
						env: { ...process.env, LITELLM_LOCAL_MODEL_COST_MAP: "True" },
					}, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, output: stdout + stderr }));
			});
			expect(output.code, output.output).toBe(0);
			const code = report === "lost" ? 1 : 0;
			const result = await inspectNativeAudit(root, code);
			expect(result.status, result.error).toBe(["complete", "recovered", "out-of-scope"].includes(report)
				? "completed" : "partial");
			if (["empty", "whitespace"].includes(report)) expect(result.error).toContain("report is empty");
			if (report === "lost") expect(result.error).toContain("expansion");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 25_000,
);
