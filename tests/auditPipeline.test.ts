import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerExtension from "../extensions/index.js";

describe("audit pipeline integration with hostile Git and unusual filenames", () => {
	const tmpDirs: string[] = [];
	const originalPath = process.env.PATH;
	let repoDir: string;
	let binDir: string;
	let artifactRoot: string;
	let tool: { execute: (...args: any[]) => Promise<any> };

	const makeTmp = (prefix: string) => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
		tmpDirs.push(dir);
		return dir;
	};

	beforeEach(() => {
		repoDir = makeTmp("pi-swival-audit-repo-");
		binDir = makeTmp("pi-swival-audit-bin-");
		artifactRoot = makeTmp("pi-swival-audit-artifacts-");

		// Set up Git repo
		execFileSync("git", ["init"], { cwd: repoDir });
		execFileSync("git", ["config", "user.name", "Test Auditor"], { cwd: repoDir });
		execFileSync("git", ["config", "user.email", "auditor@example.com"], { cwd: repoDir });

		// Hostile Git configurations that would hijack or break naive git invocations
		execFileSync("git", ["config", "diff.external", "false"], { cwd: repoDir });
		execFileSync("git", ["config", "filter.hostile.clean", "false"], { cwd: repoDir });
		execFileSync("git", ["config", "filter.hostile.smudge", "false"], { cwd: repoDir });

		// Track unusual files and an unreadable file
		const dirWithSpace = path.join(repoDir, "sub dir");
		fs.mkdirSync(dirWithSpace, { recursive: true });
		fs.writeFileSync(path.join(dirWithSpace, "file with spaces.py"), "def foo(): pass\n");
		fs.writeFileSync(path.join(repoDir, "unicode-🦀.txt"), "crab content\n");

		let newlineFilename = "newline\nname.txt";
		try {
			fs.writeFileSync(path.join(repoDir, newlineFilename), "newline file content\n");
		} catch {
			newlineFilename = "escaped;name.txt";
			fs.writeFileSync(path.join(repoDir, newlineFilename), "escaped file\n");
		}

		const unreadable = path.join(repoDir, "unreadable.key");
		fs.writeFileSync(unreadable, "secret\n");

		execFileSync("git", ["add", "-A"], { cwd: repoDir });
		execFileSync("git", ["commit", "-m", "init repo with unusual files and hostile config"], { cwd: repoDir });

		// Make tracked file unreadable in working tree
		try {
			fs.chmodSync(unreadable, 0o000);
		} catch {
			// ignore on systems where chmod 000 is unsupported
		}

		// Put binDir on PATH
		process.env.PATH = `${binDir}:${originalPath ?? ""}`;

		let registered: typeof tool | undefined;
		registerExtension(
			{
				registerTool: (candidate: typeof tool) => {
					registered = candidate;
				},
			} as any,
			{ artifactRoot },
		);
		tool = registered!;
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		// Restore permissions so cleanup rmSync does not fail
		try {
			const unreadable = path.join(repoDir, "unreadable.key");
			if (fs.existsSync(unreadable)) fs.chmodSync(unreadable, 0o600);
		} catch {
			// ignore
		}
		for (const dir of tmpDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		tmpDirs.length = 0;
	});

	it("successfully delegates /audit and captures report when repo has hostile Git config and unusual files", async () => {
		// Mock swival that exercises Git in the repository and verifies hostile config protection
		const fakeSwival = path.join(binDir, "swival");
		fs.writeFileSync(
			fakeSwival,
			`#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);

// Swival version check probe
if (args.includes('--version')) {
  console.log('1.0.45');
  process.exit(0);
}

// 1. Verify safe git diff execution ignoring hostile diff.external on an auditable file
let diffWorked = false;
let diffError = null;
try {
  execFileSync('git', ['--no-pager', 'diff', '--no-ext-diff', '--', 'sub dir/file with spaces.py'], { encoding: 'utf-8' });
  diffWorked = true;
} catch (e) {
  diffWorked = false;
  diffError = e.message;
}

// 2. Discover tracked files using null-delimited ls-files
let trackedFiles = [];
try {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf-8' });
  trackedFiles = out.split('\\0').filter(Boolean);
} catch (e) {
  // ignore
}

// 3. Attempt reading unreadable file; expect EACCES / permission error without crashing
let unreadableHandled = false;
try {
  fs.readFileSync('unreadable.key', 'utf-8');
} catch (err) {
  if (err.code === 'EACCES' || err.code === 'EPERM') unreadableHandled = true;
}

// Locate --report argument
const reportIdx = args.indexOf('--report');
if (reportIdx !== -1 && args[reportIdx + 1]) {
  const reportPath = args[reportIdx + 1];
  const report = {
    version: 1,
    sandbox: {
      mode: 'agentfs',
      agentfs_version: '0.6.4',
    },
    result: {
      outcome: 'success',
      answer: JSON.stringify({
        diffWorked,
        diffError,
        unreadableHandled,
        trackedFiles,
      }),
      exit_code: 0,
    },
    stats: {
      turns: 2,
      review_rounds: 0,
      tool_calls_total: 4,
      tool_calls_by_name: {
        read_file: { succeeded: 3, failed: 1 },
        list_directory: { succeeded: 1, failed: 0 },
      },
    },
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

console.log('Audit completed successfully');
process.exit(0);
`,
			{ mode: 0o755 },
		);

		const result = await tool.execute(
			"audit-call-1",
			{
				agent: "audit-worker",
				task: "/audit",
				cwd: repoDir,
			},
			undefined,
			undefined,
			{ cwd: repoDir, hasUI: false },
		);

		expect(result.isError).toBeFalsy();
		const res0 = result.details.results[0];
		expect(res0.report.outcome).toBe("success");
		expect(res0.report.toolCallsTotal).toBe(4);

		// Verify artifactDir and report.json exist on disk under artifactRoot
		expect(res0.artifactDir.startsWith(artifactRoot)).toBe(true);
		expect(fs.existsSync(path.join(res0.artifactDir, "report.json"))).toBe(true);

		// Verify that unusual tracked files and safe git operations round-tripped
		const parsed = JSON.parse(res0.report.answer);
		expect(parsed.diffWorked).toBe(true);
		expect(parsed.trackedFiles.some((f: string) => f.includes("spaces.py"))).toBe(true);
		expect(parsed.trackedFiles.some((f: string) => f.includes("unicode-🦀.txt"))).toBe(true);
		expect(parsed.trackedFiles.some((f: string) => f.includes("name.txt"))).toBe(true);
	});

	it("surfaces instruction-file-too-large as config_error rather than opaque failure", async () => {
		const fakeSwival = path.join(binDir, "swival");
		fs.writeFileSync(
			fakeSwival,
			`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('1.0.45');
  process.exit(0);
}

const reportIdx = args.indexOf('--report');
if (reportIdx !== -1 && args[reportIdx + 1]) {
  const reportPath = args[reportIdx + 1];
  const report = {
    version: 1,
    sandbox: {
      mode: 'agentfs',
      agentfs_version: '0.6.4',
    },
    result: {
      outcome: 'error',
      exit_code: 1,
      error_message: 'The instruction files are too large for this setup.\\nShorten the listed files, or restart with:\\n  --no-instructions     Skip project and personal instruction files.\\n  --instructions-full   Load all instructions; this may crowd out work or fail.',
    },
    stats: { turns: 0, tool_calls_total: 0 },
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

process.stderr.write('The instruction files are too large for this setup.\\n');
process.exit(1);
`,
			{ mode: 0o755 },
		);

		const result = await tool.execute(
			"audit-call-error",
			{
				agent: "audit-worker",
				task: "/audit",
				cwd: repoDir,
			},
			undefined,
			undefined,
			{ cwd: repoDir, hasUI: false },
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/instruction files are too large/i);
		expect(result.details.results[0].reason.code).toBe("config_error");
	});

	it("surfaces interrupted lifecycle status 130 clearly", async () => {
		const fakeSwival = path.join(binDir, "swival");
		fs.writeFileSync(
			fakeSwival,
			`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('1.0.45');
  process.exit(0);
}

const reportIdx = args.indexOf('--report');
if (reportIdx !== -1 && args[reportIdx + 1]) {
  const reportPath = args[reportIdx + 1];
  const report = {
    version: 1,
    sandbox: {
      mode: 'agentfs',
      agentfs_version: '0.6.4',
    },
    result: {
      outcome: 'interrupted',
      exit_code: 130,
      answer: null,
    },
    stats: { turns: 1, tool_calls_total: 1 },
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

process.stderr.write('fmt.warning: interrupted.\\n');
process.exit(130);
`,
			{ mode: 0o755 },
		);

		const result = await tool.execute(
			"audit-call-interrupt",
			{
				agent: "audit-worker",
				task: "/audit",
				cwd: repoDir,
			},
			undefined,
			undefined,
			{ cwd: repoDir, hasUI: false },
		);

		expect(result.isError).toBe(true);
		expect(result.details.results[0].reason.code).toBe("non_zero_exit");
		expect(result.details.results[0].reason.text).toMatch(/interrupted/i);
	});
});
