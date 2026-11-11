import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSwivalArgs, checkRequiresReviewer, isAgentFsRequested, isReexecSandboxRequested, readConfiguredAllowedDirsRo, resolveLinkedWorktreeCommonGitDir, resolveSwivalChildEnv, resolveSwivalReviewEnv, ANTHROPIC_OAUTH_SHIM_DIR, type SwivalOverrides } from "../extensions/index.js";
import { discoverSwivalAgents, type SwivalAgentConfig } from "../extensions/agents.js";
import { canonicalPathOrResolved } from "../extensions/child-env.js";

function makeAgent(overrides: Partial<SwivalAgentConfig> = {}): SwivalAgentConfig {
	return {
		name: "test-agent",
		description: "a test agent",
		systemPrompt: "you are a test",
		source: "user",
		filePath: "/tmp/test-agent.md",
		...overrides,
	};
}

describe("buildSwivalArgs", () => {
	it("suppresses inherited self-review with a required shim while retaining external reviewers", () => {
		const env = resolveSwivalReviewEnv(["--sandbox", "builtin", "--reviewer", "acceptance.sh"], true, { PYTHONPATH: "/original" });
		expect(env).toMatchObject({ PI_SWIVAL_NO_SELF_REVIEW: "1", PI_SWIVAL_SHIM_REQUIRED: "1", PYTHONDONTWRITEBYTECODE: "1" });
		expect(env?.PYTHONPATH).toBe(ANTHROPIC_OAUTH_SHIM_DIR + path.delimiter + "/original");
		expect(resolveSwivalReviewEnv(["--self-review"], true, {})).toBeUndefined();
		expect(resolveSwivalReviewEnv(["--sandbox", "agentfs"], true, {})).toBeDefined();
	});
	it.each([
		[],
		["--sandbox", "nono"],
		["--sandbox=nono", "--add-dir-ro", ANTHROPIC_OAUTH_SHIM_DIR],
		["--sandbox", "agentfs", "--sandbox=nono"],
		["--sandbox", "builtin", "--network", "none"],
		["--sandbox=agentfs", "--network=none"],
		["--network", "none"],
		["--", "--sandbox", "agentfs"],
	].map((args) => ({ args })))("rejects unsupported explicit-false shim arguments $args", ({ args }) => {
		expect(() => resolveSwivalReviewEnv(args, true, {})).toThrow(/No silent fallback/);
		expect(resolveSwivalReviewEnv(args, false, {})).toBeUndefined();
	});
	it("preflights self-review compatibility using final extraArgs before dispatch", () => {
		expect(() => buildSwivalArgs(makeAgent({ selfReview: false }), "", "/cwd")).toThrow(/explicit sandbox/);
		expect(() => buildSwivalArgs(makeAgent({ sandbox: "agentfs", extraArgs: ["--sandbox=nono"] }), "", "/cwd", { selfReview: false })).toThrow(/explicit sandbox/);
		expect(buildSwivalArgs(makeAgent({ selfReview: false, sandbox: "nono", extraArgs: ["--sandbox=agentfs"] }), "", "/cwd")).toContain("--sandbox=agentfs");
		expect(buildSwivalArgs(makeAgent({ selfReview: false, sandbox: "builtin", extraArgs: ["--self-review"] }), "", "/cwd")).toContain("--self-review");
	});
	it("emits discovered bundled reviewer flags without enabling self-review or shell", () => {
		const agent = discoverSwivalAgents("/cwd", "project").agents.find((agent) => agent.name === "sandboxed-reviewer");
		expect(agent).toBeDefined();
		const args = buildSwivalArgs(agent!, "/tmp/r.json", "/cwd");
		for (const flag of ["--no-skills", "--no-instructions", "--no-memory", "--no-sandbox-auto-session"]) expect(args).toContain(flag);
		expect(args).not.toContain("--self-review");
		expect(args).toEqual(expect.arrayContaining(["--commands", "none", "--network", "provider-only", "--sandbox", "agentfs"]));
	});
	it("directory overrides replace frontmatter and reject project agents, injection and protected grants", () => {
		const args = buildSwivalArgs(makeAgent({ addDir: ["/old"], addDirRo: ["/old-ro"] }), "/tmp/r.json", "/cwd", { addDir: ["/new"], addDirRo: ["/new-ro"] });
		expect(args).toEqual(expect.arrayContaining(["--add-dir", "/new", "--add-dir-ro", "/new-ro"]));
		expect(args).not.toContain("/old"); expect(args).not.toContain("/old-ro");
		expect(buildSwivalArgs(makeAgent({ addDir: ["/old"] }), "/tmp/r.json", "/cwd", { addDir: [] })).not.toContain("/old");
		for (const value of ["", " ", "--flag", "x\nvalue", "/", os.homedir(), path.join(os.homedir(), ".aws")]) {
			expect(() => buildSwivalArgs(makeAgent(), "/tmp/r.json", "/cwd", { addDirRo: [value] })).toThrow();
		}
		expect(() => buildSwivalArgs(makeAgent({ source: "project" }), "/tmp/r.json", "/cwd", { addDirRo: [] })).toThrow(/Project-scope/);
	});
	describe("directory override canonicalization", () => {
		const hostPlatform = process.platform;
		const roots: string[] = [];
		afterEach(() => {
			Object.defineProperty(process, "platform", { value: hostPlatform });
			vi.unstubAllEnvs();
			for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
		});
		function fakeHome() {
			const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-grants-"))); roots.push(root);
			const home = path.join(root, "home");
			const repo = path.join(home, "src", "owner", "repo");
			fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
			fs.mkdirSync(repo, { recursive: true });
			const linkDir = path.join(root, "a", "b", "c"); fs.mkdirSync(linkDir, { recursive: true });
			const link = path.join(linkDir, "link"); fs.symlinkSync(repo, link);
			vi.stubEnv("HOME", home);
			return { root, home, repo, linkDir, link };
		}
		it("resolves symlinks before `..` so a link cannot climb into a protected directory", () => {
			const { root, repo, linkDir, link } = fakeHome();
			const escape = `${link}/../../../.ssh`;
			expect(path.resolve(escape)).toBe(path.join(root, "a", ".ssh"));
			for (const overrides of [{ addDir: [escape] }, { addDirRo: [escape] }, { addDirRo: ["link/../../../.ssh"] }] as SwivalOverrides[]) {
				expect(() => buildSwivalArgs(makeAgent(), "/tmp/r.json", linkDir, overrides)).toThrow(/overlapping protected directory/);
			}
			// A benign override is emitted as the canonical path that was validated.
			const args = buildSwivalArgs(makeAgent(), "/tmp/r.json", linkDir, { addDirRo: ["link/../repo/future"] });
			expect(args[args.indexOf("--add-dir-ro") + 1]).toBe(path.join(repo, "future"));
			// Frontmatter entries are not canonicalized.
			const frontmatter = buildSwivalArgs(makeAgent({ addDirRo: [link] }), "/tmp/r.json", linkDir);
			expect(frontmatter[frontmatter.indexOf("--add-dir-ro") + 1]).toBe(link);
		});
		it("resumes symlink resolution after stepping back out of a missing component", () => {
			const { home, repo, link, linkDir } = fakeHome();
			fs.symlinkSync(path.join(home, ".ssh"), path.join(repo, "escape"));
			for (const overrides of [{ addDir: ["missing/../escape"] }, { addDirRo: ["missing/../escape"] },
				{ addDirRo: [`${repo}/missing/../escape`] }] as SwivalOverrides[]) {
				expect(() => buildSwivalArgs(makeAgent(), "/tmp/r.json", repo, overrides)).toThrow(/overlapping protected directory/);
			}
			// The emitted grant is already canonical: resolving it again is a no-op.
			const args = buildSwivalArgs(makeAgent(), "/tmp/r.json", linkDir, { addDirRo: ["missing/../link/future"] });
			expect(args[args.indexOf("--add-dir-ro") + 1]).toBe(path.join(repo, "future"));
			expect(args).not.toContain(link);
		});
		it("resolves a tilde symlink before `..` so a home link cannot climb into a protected directory", () => {
			const { home, repo } = fakeHome();
			fs.mkdirSync(path.join(home, ".ssh", "keys"));
			fs.symlinkSync(path.join(home, ".ssh", "keys"), path.join(home, "link-into-ssh"));
			fs.symlinkSync(path.join(home, ".ssh", "keys"), path.join(repo, "link-into-ssh"));
			const escape = "~/link-into-ssh/../granted";
			// Lexical collapse would land outside the protected directory.
			expect(path.join(home, escape.slice(2))).toBe(path.join(home, "granted"));
			for (const overrides of [{ addDir: [escape] }, { addDirRo: [escape] }] as SwivalOverrides[]) {
				expect(() => buildSwivalArgs(makeAgent(), "/tmp/r.json", repo, overrides)).toThrow(/overlapping protected directory/);
			}
			expect(canonicalPathOrResolved(escape, repo, home)).toBe(path.join(home, ".ssh", "granted"));
			expect(canonicalPathOrResolved("link-into-ssh/../granted", repo, home)).toBe(path.join(home, ".ssh", "granted"));
			expect(canonicalPathOrResolved(`${home}/link-into-ssh/../keys`, undefined, home)).toBe(path.join(home, ".ssh", "keys"));
			// A benign tilde link is emitted as the canonical path it resolved through.
			fs.symlinkSync(path.join(home, "src"), path.join(home, "link-into-src"));
			const args = buildSwivalArgs(makeAgent(), "/tmp/r.json", repo, { addDirRo: ["~/link-into-src/../src/owner"] });
			expect(args[args.indexOf("--add-dir-ro") + 1]).toBe(path.join(home, "src", "owner"));
		});
		it("protects symlinked and dangling home directories under both spellings", () => {
			const { root, home } = fakeHome();
			const external = path.join(root, "external"); fs.mkdirSync(external);
			fs.symlinkSync(path.join(external, "future-aws"), path.join(home, ".aws"));
			const dotfilesSsh = path.join(root, "dotfiles", "ssh"); fs.mkdirSync(dotfilesSsh, { recursive: true });
			fs.rmSync(path.join(home, ".ssh"), { recursive: true }); fs.symlinkSync(dotfilesSsh, path.join(home, ".ssh"));
			const refused = ["~/.aws", path.join(home, ".aws"), path.join(external, "future-aws"), external,
				"~/.ssh", "~/missing/../.ssh", dotfilesSsh, path.join(dotfilesSsh, "keys")];
			for (const entry of refused) {
				for (const overrides of [{ addDir: [entry] }, { addDirRo: [entry] }] as SwivalOverrides[]) {
					expect(() => buildSwivalArgs(makeAgent(), "/tmp/r.json", home, overrides), entry).toThrow(/overlapping protected directory/);
				}
			}
			// The ancestor of a protected target is refused too; an unrelated sibling is not.
			expect(() => buildSwivalArgs(makeAgent(), "/tmp/r.json", home, { addDirRo: [path.join(root, "dotfiles")] })).toThrow(/overlapping protected directory/);
			expect(buildSwivalArgs(makeAgent(), "/tmp/r.json", home, { addDirRo: [path.join(root, "a")] })).toContain(path.join(root, "a"));
		});
		it("reports unresolvable override paths as argument errors", () => {
			const { repo } = fakeHome();
			fs.writeFileSync(path.join(repo, "README.md"), "# inert\n");
			fs.symlinkSync("loop", path.join(repo, "loop"));
			for (const entry of ["README.md/sub", "loop/sub", path.join(repo, "loop")]) {
				for (const overrides of [{ addDir: [entry] }, { addDirRo: [entry] }] as SwivalOverrides[]) {
					expect(() => buildSwivalArgs(makeAgent(), "/tmp/r.json", repo, overrides), entry).toThrow(/Cannot resolve --add-dir(?:-ro)? path/);
					// Dispatch guards convert argument errors into messages instead of rejecting.
					expect(checkRequiresReviewer(makeAgent({ requiresReviewer: true }), overrides, repo)).toMatch(/Cannot resolve/);
				}
			}
		});
		it("case-folds protected home directories on case-insensitive platforms", () => {
			const { home } = fakeHome();
			expect(fs.existsSync(path.join(home, ".aws"))).toBe(false);
			Object.defineProperty(process, "platform", { value: "darwin" });
			for (const entry of ["~/.AWS", "~/.AWS/credentials", path.join(home, ".Ssh")]) {
				expect(() => buildSwivalArgs(makeAgent(), "/tmp/r.json", "/cwd", { addDirRo: [entry] })).toThrow(/overlapping protected directory/);
			}
			expect(() => buildSwivalArgs(makeAgent(), "/tmp/r.json", "/cwd", { addDirRo: [path.join(path.dirname(home), "HOME")] })).toThrow(/protected root/);
			Object.defineProperty(process, "platform", { value: "linux" });
			expect(buildSwivalArgs(makeAgent(), "/tmp/r.json", "/cwd", { addDirRo: ["~/.AWS"] })).toContain(path.join(home, ".AWS"));
		});
	});
	it("always disables lifecycle / MCP / A2A / web-search / history / continue / memory / subagents by default", () => {
		const args = buildSwivalArgs(makeAgent(), "/tmp/r.json", "/cwd");
		expect(args).toContain("--no-lifecycle");
		expect(args).toContain("--no-mcp");
		expect(args).toContain("--no-a2a");
		expect(args).toContain("--no-web-search");
		expect(args).toContain("--no-history");
		expect(args).toContain("--no-continue");
		expect(args).toContain("--no-memory");
		expect(args).toContain("--no-subagents");
	});

	it("respects explicit noSubagents=false for user agents", () => {
		const args = buildSwivalArgs(
			makeAgent({ noSubagents: false }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).not.toContain("--no-subagents");
	});

	it("respects explicit noLifecycle=false / noMcp=false / noA2a=false / noWebSearch=false", () => {
		const args = buildSwivalArgs(
			makeAgent({ noLifecycle: false, noMcp: false, noA2a: false, noWebSearch: false }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).not.toContain("--no-lifecycle");
		expect(args).not.toContain("--no-mcp");
		expect(args).not.toContain("--no-a2a");
		expect(args).not.toContain("--no-web-search");
	});

	it("omits --no-web-search when installedSwivalVersion is older than 1.9.0", () => {
		const pre19Args = buildSwivalArgs(makeAgent(), "/tmp/r.json", "/cwd", { installedSwivalVersion: "1.0.48" });
		expect(pre19Args).not.toContain("--no-web-search");
		const v19Args = buildSwivalArgs(makeAgent(), "/tmp/r.json", "/cwd", { installedSwivalVersion: "1.9.0" });
		expect(v19Args).toContain("--no-web-search");
	});

	it("omits --no-history / --no-continue / --no-memory when agent opts out", () => {
		const args = buildSwivalArgs(
			makeAgent({ noHistory: false, noContinue: false, noMemory: false }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).not.toContain("--no-history");
		expect(args).not.toContain("--no-continue");
		expect(args).not.toContain("--no-memory");
	});

	it("passes provider / profile / model / base-url from frontmatter", () => {
		const args = buildSwivalArgs(
			makeAgent({
				provider: "generic",
				profile: "fast",
				model: "claude-opus-4-6",
				baseUrl: "http://127.0.0.1:4000",
			}),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--provider");
		expect(args).toContain("generic");
		expect(args).toContain("--profile");
		expect(args).toContain("fast");
		expect(args).toContain("--model");
		expect(args).toContain("claude-opus-4-6");
		expect(args).toContain("--base-url");
		expect(args).toContain("http://127.0.0.1:4000");
	});

	it("overrides outrank frontmatter for provider/profile/model/baseUrl", () => {
		const args = buildSwivalArgs(
			makeAgent({ provider: "openrouter", profile: "fast", model: "a", baseUrl: "http://a" }),
			"/tmp/r.json",
			"/cwd",
			{ provider: "bedrock", profile: "slow", model: "b", baseUrl: "http://b" },
		);
		// The override wins: look for the overridden value after the flag.
		const idx = (flag: string) => args.indexOf(flag);
		expect(args[idx("--provider") + 1]).toBe("bedrock");
		expect(args[idx("--profile") + 1]).toBe("slow");
		expect(args[idx("--model") + 1]).toBe("b");
		expect(args[idx("--base-url") + 1]).toBe("http://b");
	});

	it("passes through sampling flags when set", () => {
		const args = buildSwivalArgs(
			makeAgent({
				temperature: 0.2,
				topP: 0.9,
				seed: 42,
				reasoningEffort: "high",
				maxOutputTokens: 16000,
				maxTurns: 50,
			}),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--temperature");
		expect(args).toContain("0.2");
		expect(args).toContain("--top-p");
		expect(args).toContain("0.9");
		expect(args).toContain("--seed");
		expect(args).toContain("42");
		expect(args).toContain("--reasoning-effort");
		expect(args).toContain("high");
		expect(args).toContain("--max-output-tokens");
		expect(args).toContain("16000");
		expect(args).toContain("--max-turns");
		expect(args).toContain("50");
	});

	it("override sampling fields outrank frontmatter", () => {
		const args = buildSwivalArgs(
			makeAgent({ temperature: 0.1 }),
			"/tmp/r.json",
			"/cwd",
			{ temperature: 0.9 },
		);
		const i = args.indexOf("--temperature");
		expect(args[i + 1]).toBe("0.9");
	});

	it("enables --cache and --cache-dir when set", () => {
		const args = buildSwivalArgs(
			makeAgent({ cache: true, cacheDir: "/tmp/cache" }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--cache");
		expect(args).toContain("--cache-dir");
		expect(args).toContain("/tmp/cache");
	});

	it("self-review override can force-enable the reviewer loop", () => {
		const args = buildSwivalArgs(makeAgent(), "/tmp/r.json", "/cwd", { selfReview: true });
		expect(args).toContain("--self-review");
	});

	it("passes reviewer / review-prompt / verify", () => {
		const args = buildSwivalArgs(
			makeAgent({
				reviewer: "/usr/bin/reviewer.sh",
				reviewPrompt: "Check for X",
				verify: "/tmp/accept.md",
				maxReviewRounds: 3,
			}),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--reviewer");
		expect(args).toContain("/usr/bin/reviewer.sh");
		expect(args).toContain("--review-prompt");
		expect(args).toContain("Check for X");
		expect(args).toContain("--verify");
		expect(args).toContain("/tmp/accept.md");
		expect(args).toContain("--max-review-rounds");
		expect(args).toContain("3");
	});

	it("yolo short-circuits sandbox/files/commands", () => {
		const args = buildSwivalArgs(
			makeAgent({ yolo: true, sandbox: "agentfs", files: "all", commands: "ls,rg" }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--yolo");
		expect(args).not.toContain("--sandbox");
		expect(args).not.toContain("--files");
		expect(args).not.toContain("--commands");
	});

	it("sandbox / files / commands land when yolo is absent", () => {
		const args = buildSwivalArgs(
			makeAgent({ sandbox: "agentfs", files: "some", commands: "ls,rg" }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--sandbox");
		expect(args).toContain("agentfs");
		expect(args).toContain("--files");
		expect(args).toContain("some");
		expect(args).toContain("--commands");
		expect(args).toContain("ls,rg");
	});

	it("baseDir wins over cwd; addDir/addDirRo are repeated", () => {
		const args = buildSwivalArgs(
			makeAgent({
				baseDir: "/work",
				addDir: ["/extra1", "/extra2"],
				addDirRo: ["/ref/repo"],
			}),
			"/tmp/r.json",
			"/cwd-fallback",
		);
		const bd = args.indexOf("--base-dir");
		expect(args[bd + 1]).toBe("/work");
		expect(args.filter((a) => a === "--add-dir").length).toBe(2);
		expect(args).toContain("/extra1");
		expect(args).toContain("/extra2");
		expect(args.filter((a) => a === "--add-dir-ro").length).toBe(1);
		expect(args).toContain("/ref/repo");
	});

	it("falls back to cwd for --base-dir when baseDir is absent", () => {
		const args = buildSwivalArgs(makeAgent(), "/tmp/r.json", "/cwd-fallback");
		const bd = args.indexOf("--base-dir");
		expect(args[bd + 1]).toBe("/cwd-fallback");
	});

	it("auto-adds --add-dir-ro for a validated linked Git worktree and rejects forged .git pointers", () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-wt-"));
		const prevXdg = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = path.join(tmpRoot, "xdg");
		try {
			const mainGit = path.join(tmpRoot, "repo", ".git");
			const wtAdmin = path.join(mainGit, "worktrees", "lane-a");
			const wtDir = path.join(tmpRoot, "worktrees", "lane-a");
			fs.mkdirSync(path.join(mainGit, "objects"), { recursive: true });
			fs.mkdirSync(path.join(mainGit, "refs"), { recursive: true });
			fs.mkdirSync(wtAdmin, { recursive: true });
			fs.mkdirSync(wtDir, { recursive: true });
			fs.writeFileSync(path.join(mainGit, "HEAD"), "ref: refs/heads/main\n");
			fs.writeFileSync(path.join(wtAdmin, "HEAD"), "ref: refs/heads/lane-a\n");
			fs.writeFileSync(path.join(wtAdmin, "commondir"), "../..\n");
			const realWtDir = fs.realpathSync.native(wtDir);
			const realMainGit = fs.realpathSync.native(mainGit);
			fs.writeFileSync(path.join(wtAdmin, "gitdir"), `${path.join(realWtDir, ".git")}\n`);
			fs.writeFileSync(path.join(wtDir, ".git"), `gitdir: ${path.join(realMainGit, "worktrees", "lane-a")}\n`);

			expect(resolveLinkedWorktreeCommonGitDir(wtDir)).toBe(realMainGit);
			const userArgs = buildSwivalArgs(makeAgent(), "/tmp/r.json", wtDir);
			const roIdx = userArgs.indexOf("--add-dir-ro");
			expect(roIdx).toBeGreaterThan(-1);
			expect(userArgs[roIdx + 1]).toBe(realMainGit);

			// Honours --base-dir in extraArgs and deduplicates existing addDir / addDirRo (resolved against cwd)
			const extraBdArgs = buildSwivalArgs(makeAgent({ extraArgs: ["--base-dir", wtDir] }), "/tmp/r.json", "/cwd");
			expect(extraBdArgs).toContain(realMainGit);
			const dedupArgs = buildSwivalArgs(makeAgent({ addDirRo: [mainGit] }), "/tmp/r.json", wtDir);
			expect(dedupArgs.filter((a) => a === "--add-dir-ro").length).toBe(1);
			const overrideArgs = buildSwivalArgs(makeAgent(), "/tmp/r.json", wtDir, { addDirRo: [mainGit] });
			expect(overrideArgs.filter((a) => a === "--add-dir-ro").length).toBe(1);
			const parentRwArgs = buildSwivalArgs(makeAgent({ addDir: [path.dirname(mainGit)] }), "/tmp/r.json", wtDir);
			expect(parentRwArgs).not.toContain("--add-dir-ro");
			// Relative addDirRo resolves against cwd, not baseDir: when baseDir != cwd, a relative path matching baseDir does not suppress the grant
			const unrelatedCwd = path.join(tmpRoot, "unrelated-cwd");
			fs.mkdirSync(unrelatedCwd, { recursive: true });
			const relMismatchArgs = buildSwivalArgs(
				makeAgent({ baseDir: wtDir, addDirRo: ["../../repo/.git"] }),
				"/tmp/r.json",
				unrelatedCwd,
			);
			expect(relMismatchArgs).toContain(realMainGit);
			// Preserves allowed_dirs_ro from project swival.toml / global config.toml when CLI --add-dir-ro is unset
			const refDir = path.join(tmpRoot, "ref-docs");
			fs.mkdirSync(refDir, { recursive: true });
			fs.writeFileSync(
				path.join(wtDir, "swival.toml"),
				[`allowed_dirs_ro = [`, `  "${refDir}",`, `  "rel-ro",`, `]`, `[profiles.example]`, `provider = "bedrock"`].join("\n") + "\n",
			);
			expect(readConfiguredAllowedDirsRo(wtDir)).toEqual([refDir, path.join(realWtDir, "rel-ro")]);
			// A preceding multiline array whose continuation line opens on `[` does not
			// truncate the root section before allowed_dirs_ro.
			fs.writeFileSync(
				path.join(wtDir, "swival.toml"),
				["commands = [", "  [1]", "]", "allowed_dirs_ro = []", "[profiles.example]", `allowed_dirs_ro = ["${refDir}"]`].join("\n") + "\n",
			);
			expect(readConfiguredAllowedDirsRo(wtDir)).toEqual([]);
			fs.writeFileSync(
				path.join(wtDir, "swival.toml"),
				["commands = [", "  [1]", "]", `allowed_dirs_ro = ["${refDir}",`, '  "rel-ro", # trailing', "]"].join("\n") + "\n",
			);
			expect(readConfiguredAllowedDirsRo(wtDir)).toEqual([refDir, path.join(realWtDir, "rel-ro")]);
			// A `]` inside a trailing comment or a string is not the array's closing bracket.
			fs.writeFileSync(path.join(wtDir, "swival.toml"), `allowed_dirs_ro = ["${refDir}"] # ]\n`);
			expect(readConfiguredAllowedDirsRo(wtDir)).toEqual([refDir]);
			fs.writeFileSync(path.join(wtDir, "swival.toml"), `allowed_dirs_ro = ["${refDir}", 'b]r'] # ] trailing\n`);
			expect(readConfiguredAllowedDirsRo(wtDir)).toEqual([refDir, path.join(realWtDir, "b]r")]);
			fs.writeFileSync(
				path.join(wtDir, "swival.toml"),
				[`allowed_dirs_ro = [ # ]`, `  "${refDir}", # ]`, `  "rel-ro",`, `] # ]`, `[profiles.example]`, `provider = "bedrock"`].join("\n") + "\n",
			);
			expect(readConfiguredAllowedDirsRo(wtDir)).toEqual([refDir, path.join(realWtDir, "rel-ro")]);
			fs.writeFileSync(path.join(wtDir, "swival.toml"), `allowed_dirs_ro = ["${refDir}"] stray\n`);
			expect(readConfiguredAllowedDirsRo(wtDir)).toEqual([]);
			// A present project file that cannot be read never exposes global entries,
			// while an empty one configures nothing.
			const xdgSwivalDir = path.join(tmpRoot, "xdg", "swival");
			fs.mkdirSync(xdgSwivalDir, { recursive: true });
			fs.writeFileSync(path.join(xdgSwivalDir, "config.toml"), 'allowed_dirs_ro = ["/global/ref"]\n');
			fs.writeFileSync(path.join(wtDir, "swival.toml"), 'allowed_dirs_ro = []\nsystem_prompt = """\nmultiline\n"""\n');
			expect(readConfiguredAllowedDirsRo(wtDir)).toEqual([]);
			fs.writeFileSync(path.join(wtDir, "swival.toml"), "");
			expect(readConfiguredAllowedDirsRo(wtDir)).toEqual(["/global/ref"]);
			fs.unlinkSync(path.join(wtDir, "swival.toml"));
			fs.symlinkSync(path.join(xdgSwivalDir, "config.toml"), path.join(wtDir, "swival.toml"));
			expect(readConfiguredAllowedDirsRo(wtDir)).toEqual([]);
			fs.unlinkSync(path.join(wtDir, "swival.toml"));
			fs.unlinkSync(path.join(xdgSwivalDir, "config.toml"));
			fs.writeFileSync(
				path.join(wtDir, "swival.toml"),
				[`allowed_dirs_ro = [`, `  "${refDir}",`, `  "rel-ro",`, `]`, `[profiles.example]`, `provider = "bedrock"`].join("\n") + "\n",
			);
			const preservedArgs = buildSwivalArgs(makeAgent(), "/tmp/r.json", wtDir);
			expect(preservedArgs).toContain(refDir);
			expect(preservedArgs).toContain(path.join(realWtDir, "rel-ro"));
			expect(preservedArgs).toContain(realMainGit);
			fs.unlinkSync(path.join(wtDir, "swival.toml"));
			// Global XDG config.toml allowed_dirs_ro is preserved when CLI --add-dir-ro is unset, and skipped when CLI --add-dir-ro is set
			const xdgSwival = path.join(tmpRoot, "xdg", "swival");
			fs.mkdirSync(xdgSwival, { recursive: true });
			fs.writeFileSync(path.join(xdgSwival, "config.toml"), `allowed_dirs_ro = ["${refDir}"]\n`);
			const globalPreservedArgs = buildSwivalArgs(makeAgent(), "/tmp/r.json", wtDir);
			expect(globalPreservedArgs).toContain(refDir);
			expect(globalPreservedArgs).toContain(realMainGit);
			const cliExplicitRoArgs = buildSwivalArgs(makeAgent({ addDirRo: ["/custom-ro"] }), "/tmp/r.json", wtDir);
			expect(cliExplicitRoArgs).not.toContain(refDir);
			expect(cliExplicitRoArgs).toContain("/custom-ro");
			expect(cliExplicitRoArgs).toContain(realMainGit);
			fs.unlinkSync(path.join(xdgSwival, "config.toml"));

			// Project-scope agents and files=none (frontmatter or extraArgs) never receive auto --add-dir-ro
			const projArgs = buildSwivalArgs(makeAgent({ source: "project" }), "/tmp/r.json", wtDir);
			expect(projArgs).not.toContain("--add-dir-ro");
			const noneArgs = buildSwivalArgs(makeAgent({ files: "none" }), "/tmp/r.json", wtDir);
			expect(noneArgs).not.toContain("--add-dir-ro");
			const extraNoneArgs = buildSwivalArgs(makeAgent({ extraArgs: ["--files=none"] }), "/tmp/r.json", wtDir);
			expect(extraNoneArgs).not.toContain("--add-dir-ro");

			// Forged .git pointing to a directory whose gitdir does not point back fails closed
			const otherWt = path.join(tmpRoot, "worktrees", "forged");
			fs.mkdirSync(otherWt, { recursive: true });
			fs.writeFileSync(path.join(otherWt, ".git"), `gitdir: ${path.join(realMainGit, "worktrees", "lane-a")}\n`);
			expect(resolveLinkedWorktreeCommonGitDir(otherWt)).toBeUndefined();

			// Symlinked .git file fails closed
			const symWt = path.join(tmpRoot, "worktrees", "symlinked");
			fs.mkdirSync(symWt, { recursive: true });
			fs.symlinkSync(path.join(wtDir, ".git"), path.join(symWt, ".git"));
			expect(resolveLinkedWorktreeCommonGitDir(symWt)).toBeUndefined();

			// Protected home directory (or ancestor of ~/.ssh) fails closed even if shaped like a Git worktree
			const fakeHome = path.join(tmpRoot, "home");
			const dotSshGit = path.join(fakeHome, ".ssh", "repo.git");
			const sshWtAdmin = path.join(dotSshGit, "worktrees", "lane-b");
			const sshWtDir = path.join(tmpRoot, "worktrees", "lane-b");
			fs.mkdirSync(path.join(dotSshGit, "objects"), { recursive: true });
			fs.mkdirSync(path.join(dotSshGit, "refs"), { recursive: true });
			fs.mkdirSync(sshWtAdmin, { recursive: true });
			fs.mkdirSync(sshWtDir, { recursive: true });
			const realSshWtDir = fs.realpathSync.native(sshWtDir);
			const realDotSshGit = fs.realpathSync.native(dotSshGit);
			fs.writeFileSync(path.join(dotSshGit, "HEAD"), "ref: refs/heads/main\n");
			fs.writeFileSync(path.join(sshWtAdmin, "HEAD"), "ref: refs/heads/lane-b\n");
			fs.writeFileSync(path.join(sshWtAdmin, "commondir"), "../..\n");
			fs.writeFileSync(path.join(sshWtAdmin, "gitdir"), `${path.join(realSshWtDir, ".git")}\n`);
			fs.writeFileSync(path.join(sshWtDir, ".git"), `gitdir: ${path.join(realDotSshGit, "worktrees", "lane-b")}\n`);
			expect(resolveLinkedWorktreeCommonGitDir(sshWtDir, fakeHome)).toBeUndefined();
			expect(resolveLinkedWorktreeCommonGitDir(wtDir, path.join(realMainGit, "nested-home"))).toBeUndefined();
		} finally {
			if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = prevXdg;
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("resolves configured allowed_dirs_ro through symlinks before `..` and case-folds protected worktree Git roots", () => {
		const tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-wt-fold-")));
		const hostPlatform = process.platform;
		const prevXdg = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = path.join(tmpRoot, "xdg");
		const linkedWorktree = (gitDir: string, worktree: string, lane: string) => {
			const admin = path.join(gitDir, "worktrees", lane);
			fs.mkdirSync(path.join(gitDir, "objects"), { recursive: true });
			fs.mkdirSync(path.join(gitDir, "refs"), { recursive: true });
			fs.mkdirSync(admin, { recursive: true });
			fs.mkdirSync(worktree, { recursive: true });
			fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
			fs.writeFileSync(path.join(admin, "HEAD"), `ref: refs/heads/${lane}\n`);
			fs.writeFileSync(path.join(admin, "commondir"), "../..\n");
			fs.writeFileSync(path.join(admin, "gitdir"), `${path.join(worktree, ".git")}\n`);
			fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${admin}\n`);
		};
		try {
			const mainGit = path.join(tmpRoot, "repo", ".git");
			const wtDir = path.join(tmpRoot, "worktrees", "lane-a");
			linkedWorktree(mainGit, wtDir, "lane-a");
			expect(resolveLinkedWorktreeCommonGitDir(wtDir)).toBe(mainGit);
			// A configured relative entry that climbs out of a symlink must resolve
			// through the link target: lexical collapse would land back in the worktree.
			fs.symlinkSync(path.join(mainGit, "worktrees"), path.join(wtDir, "link-into-git"));
			fs.writeFileSync(path.join(wtDir, "swival.toml"), 'allowed_dirs_ro = ["link-into-git/.."]\n');
			const configured = readConfiguredAllowedDirsRo(wtDir);
			expect(configured).toEqual([`${wtDir}${path.sep}link-into-git/..`]);
			expect(canonicalPathOrResolved(configured[0])).toBe(mainGit);
			expect(path.resolve(configured[0])).toBe(wtDir);
			// The common Git directory is already covered by the configured grant, so nothing is re-emitted.
			expect(buildSwivalArgs(makeAgent(), "/tmp/r.json", wtDir)).not.toContain("--add-dir-ro");
			fs.unlinkSync(path.join(wtDir, "swival.toml"));

			// A Git directory under a differently-cased protected home entry is refused
			// on case-insensitive platforms and accepted on case-sensitive ones.
			const fakeHome = path.join(tmpRoot, "home");
			const casedGit = path.join(fakeHome, ".SSH", "repo.git");
			const casedWt = path.join(tmpRoot, "worktrees", "lane-b");
			linkedWorktree(casedGit, casedWt, "lane-b");
			Object.defineProperty(process, "platform", { value: "darwin" });
			expect(resolveLinkedWorktreeCommonGitDir(casedWt, fakeHome)).toBeUndefined();
			// The Git directory spelled as a differently-cased home itself is refused too.
			expect(resolveLinkedWorktreeCommonGitDir(casedWt, path.join(fakeHome, ".ssh", "REPO.GIT"))).toBeUndefined();
			expect(resolveLinkedWorktreeCommonGitDir(wtDir, fakeHome)).toBe(mainGit);
			Object.defineProperty(process, "platform", { value: "linux" });
			// Only a case-sensitive filesystem keeps `.SSH` distinct from the protected `.ssh`.
			const caseSensitiveFs = !fs.existsSync(path.join(fakeHome, ".ssh"));
			expect(resolveLinkedWorktreeCommonGitDir(casedWt, fakeHome)).toBe(caseSensitiveFs ? casedGit : undefined);
		} finally {
			Object.defineProperty(process, "platform", { value: hostPlatform });
			if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = prevXdg;
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("includes --report, --no-color, and the system prompt body", () => {
		const args = buildSwivalArgs(makeAgent({ systemPrompt: "HELLO" }), "/tmp/r.json", "/cwd");
		expect(args).toContain("--no-color");
		expect(args).toContain("--report");
		expect(args).toContain("/tmp/r.json");
		expect(args).toContain("--system-prompt");
		expect(args).toContain("HELLO");
	});

	it("omits --system-prompt when the body is blank", () => {
		const args = buildSwivalArgs(makeAgent({ systemPrompt: "   " }), "/tmp/r.json", "/cwd");
		expect(args).not.toContain("--system-prompt");
	});

	it("traceDir override adds --trace-dir", () => {
		const args = buildSwivalArgs(makeAgent(), "/tmp/r.json", "/cwd", { traceDir: "/tmp/trace" });
		const i = args.indexOf("--trace-dir");
		expect(i).toBeGreaterThan(-1);
		expect(args[i + 1]).toBe("/tmp/trace");
	});

	it("extraArgs are appended unmodified", () => {
		const args = buildSwivalArgs(
			makeAgent({ extraArgs: ["--max-context-tokens", "128000", "--sanitize-thinking"] }),
			"/tmp/r.json",
			"/cwd",
		);
		const i = args.indexOf("--max-context-tokens");
		expect(i).toBeGreaterThan(-1);
		expect(args[i + 1]).toBe("128000");
		expect(args).toContain("--sanitize-thinking");
	});

	it("derives AgentFS intent from sandbox flags supplied through extraArgs", () => {
		const splitArgs = buildSwivalArgs(
			makeAgent({ extraArgs: ["--sandbox", "agentfs"] }),
			"/tmp/r.json",
			"/cwd",
		);
		const equalsArgs = buildSwivalArgs(
			makeAgent({ yolo: true, extraArgs: ["--sandbox=agentfs"] }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(isAgentFsRequested(splitArgs)).toBe(true);
		expect(isAgentFsRequested(equalsArgs)).toBe(true);
	});

	it("uses the final sandbox option and ignores values after the option terminator", () => {
		expect(isAgentFsRequested(["--sandbox", "agentfs", "--sandbox=builtin"])).toBe(false);
		expect(isAgentFsRequested(["--sandbox", "builtin", "--sandbox=agentfs"])).toBe(true);
		expect(isAgentFsRequested(["--", "--sandbox", "agentfs"])).toBe(false);
	});

	it("rejects an option terminator in extraArgs", () => {
		expect(() => buildSwivalArgs(
			makeAgent({ extraArgs: ["--"] }),
			"/tmp/private-report.json",
			"/cwd",
		)).toThrow(/option terminator/i);
	});

	it("keeps the extension-owned report path effective after extraArgs", () => {
		for (const extraArgs of [
			["--report", "/tmp/diverted.json"],
			["--report=/tmp/diverted.json"],
		]) {
			const args = buildSwivalArgs(makeAgent({ extraArgs }), "/tmp/private-report.json", "/cwd");
			const reportIndex = args.lastIndexOf("--report");
			expect(reportIndex).toBeGreaterThan(-1);
			expect(args[reportIndex + 1]).toBe("/tmp/private-report.json");
			expect(args.slice(reportIndex + 2)).not.toContain("--report=/tmp/diverted.json");
		}
	});

	it("passes --proactive-summaries when set", () => {
		const args = buildSwivalArgs(
			makeAgent({ proactiveSummaries: true }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--proactive-summaries");
	});

	it("passes --retries with the configured budget", () => {
		const args = buildSwivalArgs(makeAgent({ retries: 3 }), "/tmp/r.json", "/cwd");
		const i = args.indexOf("--retries");
		expect(i).toBeGreaterThan(-1);
		expect(args[i + 1]).toBe("3");
	});

	it("passes AgentFS session controls (--sandbox-session / --sandbox-strict-read / --no-sandbox-auto-session)", () => {
		const args = buildSwivalArgs(
			makeAgent({
				sandbox: "agentfs",
				sandboxSession: "sess-abc",
				sandboxStrictRead: true,
				noSandboxAutoSession: true,
			}),
			"/tmp/r.json",
			"/cwd",
		);
		const s = args.indexOf("--sandbox-session");
		expect(s).toBeGreaterThan(-1);
		expect(args[s + 1]).toBe("sess-abc");
		expect(args).toContain("--sandbox-strict-read");
		expect(args).toContain("--no-sandbox-auto-session");
	});

	it("does not set --self-review unless frontmatter or override requests it", () => {
		const args = buildSwivalArgs(makeAgent(), "/tmp/r.json", "/cwd");
		expect(args).not.toContain("--self-review");
	});

	it("rejects conflicting reviewer and self-review configuration", () => {
		expect(() => buildSwivalArgs(
			makeAgent({ reviewer: "/bin/true" }),
			"/tmp/r.json",
			"/cwd",
			{ selfReview: true },
		)).toThrow(/mutually exclusive/);
		expect(() => buildSwivalArgs(
			makeAgent({ selfReview: true, reviewer: "/bin/true" }),
			"/tmp/r.json",
			"/cwd",
		)).toThrow(/mutually exclusive/);
		expect(() => buildSwivalArgs(
			makeAgent({ selfReview: true, extraArgs: ["--reviewer=/bin/true"] }),
			"/tmp/r.json",
			"/cwd",
		)).toThrow(/mutually exclusive/);
	});

	it("emits --reviewer when only reviewer is set (no selfReview)", () => {
		const args = buildSwivalArgs(
			makeAgent({ reviewer: "/bin/true" }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--reviewer");
		expect(args).toContain("/bin/true");
		expect(args).not.toContain("--self-review");
	});

	it("override with undefined does not reset a frontmatter-set flag", () => {
		const args = buildSwivalArgs(
			makeAgent({ model: "from-fm" }),
			"/tmp/r.json",
			"/cwd",
			{ model: undefined } satisfies SwivalOverrides,
		);
		expect(args).toContain("from-fm");
	});

	it("emits --instructions-full when agent sets instructionsFull: true", () => {
		const args = buildSwivalArgs(
			makeAgent({ instructionsFull: true }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--instructions-full");
		expect(args).not.toContain("--no-instructions");
	});

	it("allows dispatch override to enable instructionsFull over agent noInstructions", () => {
		const args = buildSwivalArgs(
			makeAgent({ noInstructions: true }),
			"/tmp/r.json",
			"/cwd",
			{ instructionsFull: true },
		);
		expect(args).toContain("--instructions-full");
		expect(args).not.toContain("--no-instructions");
	});

	it("throws if agent frontmatter sets both instructionsFull and noInstructions", () => {
		expect(() =>
			buildSwivalArgs(
				makeAgent({ instructionsFull: true, noInstructions: true }),
				"/tmp/r.json",
				"/cwd",
			),
		).toThrow(/cannot specify both instructionsFull and noInstructions/);
	});

	it("preserves safe default when bundled agent sets noInstructions", () => {
		const args = buildSwivalArgs(
			makeAgent({ noInstructions: true }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--no-instructions");
		expect(args).not.toContain("--instructions-full");
	});

	it("passes nono sandbox and network isolation options", () => {
		const args = buildSwivalArgs(
			makeAgent({
				sandbox: "nono",
				nonoProfile: "strict",
				nonoRollback: true,
				nonoBlockNet: true,
				nonoAllowDomain: ["api.example.com", "auth.example.com"],
				network: "provider-only",
			}),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--sandbox");
		expect(args).toContain("nono");
		expect(args).toContain("--nono-profile");
		expect(args).toContain("strict");
		expect(args).toContain("--nono-rollback");
		expect(args).toContain("--nono-block-net");
		expect(args).toContain("--nono-allow-domain");
		expect(args).toContain("api.example.com");
		expect(args).toContain("--network");
		expect(args).toContain("provider-only");
	});

	it("passes command middleware", () => {
		const args = buildSwivalArgs(
			makeAgent({ commandMiddleware: "rtk proxy" }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--command-middleware");
		expect(args).toContain("rtk proxy");
	});

	it("passes maxOutputKb and maxOutputLines", () => {
		const args = buildSwivalArgs(
			makeAgent({ maxOutputKb: 100, maxOutputLines: 5000 }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--max-output-kb");
		expect(args).toContain("100");
		expect(args).toContain("--max-output-lines");
		expect(args).toContain("5000");
	});

	it("passes skillsDir and ambient skill sharing", () => {
		const args = buildSwivalArgs(
			makeAgent({ skillsDir: ["/extra/skills"] }),
			"/tmp/r.json",
			"/cwd",
			{ shareSkills: true },
		);
		expect(args).toContain("--skills-dir");
		expect(args).toContain("/extra/skills");
	});

	it("allows explicit subagents opt-in to emit --subagents and omit --no-subagents", () => {
		const args = buildSwivalArgs(
			makeAgent(),
			"/tmp/r.json",
			"/cwd",
			{ subagents: true },
		);
		expect(args).toContain("--subagents");
		expect(args).not.toContain("--no-subagents");
	});

	it("conservatively treats unknown or re-exec sandboxes as requiring argv task delivery", () => {
		const agentFsArgs = buildSwivalArgs(makeAgent({ sandbox: "agentfs" }), "/tmp/r.json", "/cwd");
		expect(isReexecSandboxRequested(agentFsArgs)).toBe(true);

		const nonoArgs = buildSwivalArgs(makeAgent({ sandbox: "nono" }), "/tmp/r.json", "/cwd");
		expect(isReexecSandboxRequested(nonoArgs)).toBe(true);

		// Omitted sandbox is conservatively treated as potential re-exec because ambient
		// config (config.toml / swival.toml) may set sandbox = "agentfs"
		const defaultArgs = buildSwivalArgs(makeAgent(), "/tmp/r.json", "/cwd");
		expect(isReexecSandboxRequested(defaultArgs)).toBe(true);

		// Only explicitly configured builtin sandbox is known not to re-exec
		const builtinArgs = buildSwivalArgs(makeAgent({ sandbox: "builtin" }), "/tmp/r.json", "/cwd");
		expect(isReexecSandboxRequested(builtinArgs)).toBe(false);
	});

	it("truncates non-integer maxOutputKb and maxOutputLines and skips values below 1", () => {
		const args = buildSwivalArgs(
			makeAgent({ maxOutputKb: 50.7, maxOutputLines: 2000.9 }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("50");
		expect(args).not.toContain("50.7");
		expect(args).toContain("2000");
		expect(args).not.toContain("2000.9");

		const subOneArgs = buildSwivalArgs(
			makeAgent({ maxOutputKb: 0.5, maxOutputLines: 0.9 }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(subOneArgs).not.toContain("--max-output-kb");
		expect(subOneArgs).not.toContain("--max-output-lines");
	});

	it("honors false subagent override over agent noSubagents: false", () => {
		const args = buildSwivalArgs(
			makeAgent({ noSubagents: false }),
			"/tmp/r.json",
			"/cwd",
			{ subagents: false },
		);
		expect(args).toContain("--no-subagents");
		expect(args).not.toContain("--subagents");
	});

	it("keeps an explicit subagents override from being reversed by extraArgs", () => {
		// Swival honors --subagents whenever present, so a false override cannot coexist with it.
		expect(() => buildSwivalArgs(makeAgent({ extraArgs: ["--subagents"] }), "/tmp/r.json", "/cwd", { subagents: false }))
			.toThrow(/extraArgs enable --subagents/);
		expect(checkRequiresReviewer(makeAgent({ requiresReviewer: true, extraArgs: ["--subagents"] }), { subagents: false }, "/cwd"))
			.toMatch(/extraArgs enable --subagents/);
		// Without the override the agent's escape hatch still applies.
		expect(buildSwivalArgs(makeAgent({ extraArgs: ["--subagents"] }), "/tmp/r.json", "/cwd")).toContain("--subagents");
		// A true override emits --subagents, which Swival honors over an extraArgs --no-subagents.
		const enabled = buildSwivalArgs(makeAgent({ extraArgs: ["--no-subagents"] }), "/tmp/r.json", "/cwd", { subagents: true });
		expect(enabled).toContain("--subagents");
	});

	it("passes providerTimeout and initialToolChoice from frontmatter", () => {
		const args = buildSwivalArgs(
			makeAgent({ providerTimeout: 120, initialToolChoice: "required" }),
			"/tmp/r.json",
			"/cwd",
		);
		expect(args).toContain("--provider-timeout");
		expect(args).toContain("120");
		expect(args).toContain("--initial-tool-choice");
		expect(args).toContain("required");
	});

	it("overrides outrank frontmatter for providerTimeout/initialToolChoice", () => {
		const args = buildSwivalArgs(
			makeAgent({ providerTimeout: 120, initialToolChoice: "required" }),
			"/tmp/r.json",
			"/cwd",
			{ providerTimeout: 300, initialToolChoice: "auto" },
		);
		expect(args[args.indexOf("--provider-timeout") + 1]).toBe("300");
		expect(args[args.indexOf("--initial-tool-choice") + 1]).toBe("auto");
	});

	it("a2aConfig suppresses --no-a2a and absolutizes a relative path against cwd", () => {
		const args = buildSwivalArgs(
			makeAgent({ a2aConfig: "a2a.toml" }),
			"/tmp/r.json",
			"/repo",
		);
		expect(args).not.toContain("--no-a2a");
		expect(args).toContain("--a2a-config");
		expect(args[args.indexOf("--a2a-config") + 1]).toBe("/repo/a2a.toml");
	});

	it("a2aConfigOverride outranks frontmatter and keeps an absolute path unchanged", () => {
		const args = buildSwivalArgs(
			makeAgent(),
			"/tmp/r.json",
			"/repo",
			{ a2aConfig: "/etc/swival/a2a.toml" },
		);
		expect(args).not.toContain("--no-a2a");
		expect(args[args.indexOf("--a2a-config") + 1]).toBe("/etc/swival/a2a.toml");
	});

	it("allowA2a: true suppresses --no-a2a without an a2aConfig", () => {
		const args = buildSwivalArgs(makeAgent({ allowA2a: true }), "/tmp/r.json", "/cwd");
		expect(args).not.toContain("--no-a2a");
		expect(args).not.toContain("--a2a-config");
	});

	it("throws when a2aConfig is set but network is not full", () => {
		expect(() =>
			buildSwivalArgs(
				makeAgent({ a2aConfig: "a2a.toml", network: "provider-only" }),
				"/tmp/r.json",
				"/repo",
			),
		).toThrow(/A2A requires --network full/);
	});

	it("throws when allowA2a is set but network is not full", () => {
		expect(() =>
			buildSwivalArgs(
				makeAgent({ allowA2a: true, network: "none" }),
				"/tmp/r.json",
				"/repo",
			),
		).toThrow(/A2A requires --network full/);
	});

	it("throws when noA2a: false is set but network is not full", () => {
		expect(() =>
			buildSwivalArgs(
				makeAgent({ noA2a: false, network: "provider-only" }),
				"/tmp/r.json",
				"/repo",
			),
		).toThrow(/A2A requires --network full/);
	});

	it("throws when a2aConfig is empty string", () => {
		expect(() =>
			buildSwivalArgs(
				makeAgent({ a2aConfig: "   " }),
				"/tmp/r.json",
				"/repo",
			),
		).toThrow(/A2A configuration path cannot be empty/);
	});

	it("throws when project agent attempts to enable A2A via override", () => {
		expect(() =>
			buildSwivalArgs(
				makeAgent({ source: "project" }),
				"/tmp/r.json",
				"/repo",
				{ a2aConfig: "/tmp/a2a.toml" },
			),
		).toThrow(/Project-scope agent "test-agent" cannot enable A2A/);
	});

	it("allows a2aConfig with network omitted (defaults to full)", () => {
		const args = buildSwivalArgs(makeAgent({ a2aConfig: "a2a.toml" }), "/tmp/r.json", "/repo");
		expect(args).not.toContain("--network");
		expect(args).toContain("--a2a-config");
	});
});

describe("resolveSwivalChildEnv", () => {
	const GATEWAY_PROVIDER = "acme-gateway";
	const GATEWAY_BASE_URL = "https://gateway.example.com/v1";
	const GATEWAY_KEY = "synthetic-gateway-token";

	function writePiAgentFiles(agentDir: string, options: { models?: unknown; auth?: unknown; modelsMode?: number } = {}): void {
		fs.mkdirSync(agentDir, { recursive: true });
		const models = options.models ?? { providers: { [GATEWAY_PROVIDER]: { baseUrl: GATEWAY_BASE_URL, api: "openai-completions", models: [] } } };
		const auth = options.auth ?? { [GATEWAY_PROVIDER]: { type: "api_key", key: GATEWAY_KEY } };
		fs.writeFileSync(path.join(agentDir, "models.json"), typeof models === "string" ? models : JSON.stringify(models), { mode: options.modelsMode ?? 0o644 });
		fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
	}

	it("bridges the matching Pi custom-provider key when effective provider is generic and base_url serves its models.json baseUrl", () => {
		const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-env-"));
		try {
			const agentDir = path.join(tmpHome, ".pi", "agent");
			const cfgDir = path.join(tmpHome, ".config", "swival");
			const xdgDir = path.join(tmpHome, "xdg", "swival");
			fs.mkdirSync(cfgDir, { recursive: true });
			fs.mkdirSync(xdgDir, { recursive: true });
			writePiAgentFiles(agentDir);
			fs.writeFileSync(
				path.join(cfgDir, "config.toml"),
				[
					'active_profile = "vertex-gemini-flash"',
					"[profiles.vertex-gemini-flash]",
					'provider = "geap"',
					"[profiles.gw-gpt-sol]",
					'provider = "generic"',
					`base_url = "${GATEWAY_BASE_URL}"`,
				].join("\n"),
			);
			// 1. Explicit --profile resolving to generic + the gateway base_url in config.toml
			expect(resolveSwivalChildEnv(["--profile", "gw-gpt-sol", "--"], { PATH: "/usr/bin" }, tmpHome, tmpHome)).toEqual({
				PATH: "/usr/bin",
				OPENAI_API_KEY: GATEWAY_KEY,
			});
			// 2. Explicit CLI --provider generic + --base-url without config.toml profile
			expect(
				resolveSwivalChildEnv(
					["--provider", "generic", "--base-url", GATEWAY_BASE_URL, "--"],
					{ PATH: "/usr/bin" },
					tmpHome,
					tmpHome,
				),
			).toEqual({
				PATH: "/usr/bin",
				OPENAI_API_KEY: GATEWAY_KEY,
			});
			// 3. active_profile in XDG_CONFIG_HOME/swival/config.toml
			fs.writeFileSync(
				path.join(xdgDir, "config.toml"),
				['active_profile = "gw-gpt-sol"', "[profiles.gw-gpt-sol]", 'provider = "generic"', `base_url = "${GATEWAY_BASE_URL}"`].join("\n"),
			);
			expect(
				resolveSwivalChildEnv(["--"], { PATH: "/usr/bin", XDG_CONFIG_HOME: path.join(tmpHome, "xdg") }, tmpHome, tmpHome),
			).toEqual({
				PATH: "/usr/bin",
				XDG_CONFIG_HOME: path.join(tmpHome, "xdg"),
				OPENAI_API_KEY: GATEWAY_KEY,
			});
			// 4. A provider whose baseUrl is an ancestor path or the bare origin still matches a deeper route
			for (const ancestor of ["https://gateway.example.com", "https://gateway.example.com/", "https://Gateway.Example.com/v1/"]) {
				writePiAgentFiles(agentDir, { models: { providers: { [GATEWAY_PROVIDER]: { baseUrl: ancestor } } } });
				expect(
					resolveSwivalChildEnv(["--provider", "generic", "--base-url", `${GATEWAY_BASE_URL}/chat`, "--"], {}, tmpHome, tmpHome),
					ancestor,
				).toEqual({ OPENAI_API_KEY: GATEWAY_KEY });
			}
		} finally {
			fs.rmSync(tmpHome, { recursive: true, force: true });
		}
	});

	it("fails closed on unmatched routes, reviewer-only strings, misleading profile names, project swival.toml, and unsafe auth.json", () => {
		const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-env-"));
		try {
			const agentDir = path.join(tmpHome, ".pi", "agent");
			const cfgDir = path.join(tmpHome, ".config", "swival");
			const repoDir = path.join(tmpHome, "repo");
			fs.mkdirSync(cfgDir, { recursive: true });
			fs.mkdirSync(repoDir, { recursive: true });
			writePiAgentFiles(agentDir);
			const authFile = path.join(agentDir, "auth.json");
			fs.writeFileSync(
				path.join(cfgDir, "config.toml"),
				[
					'active_profile = "local-qwen"',
					"[profiles.local-qwen]",
					'provider = "generic"',
					'base_url = "http://127.0.0.1:8000/v1"',
					"[profiles.gw-misleading]",
					'provider = "generic"',
					'base_url = "https://attacker.example/v1"',
					"[profiles.gw-gpt-sol]",
					'provider = "generic"',
					`base_url = "${GATEWAY_BASE_URL}"`,
				].join("\n"),
			);
			// External --reviewer fails closed even when main profile is gw-gpt-sol
			expect(
				resolveSwivalChildEnv(
					["--profile", "gw-gpt-sol", "--reviewer", "swival --profile local-qwen --reviewer-mode", "--"],
					{},
					tmpHome,
					repoDir,
				),
			).toBeUndefined();
			// Profile named gw-* but pointing to an unmatched base_url in config.toml must NOT bridge
			expect(resolveSwivalChildEnv(["--profile", "gw-misleading", "--"], {}, tmpHome, repoDir)).toBeUndefined();
			// Existing OPENAI_API_KEY is preserved
			expect(
				resolveSwivalChildEnv(["--profile", "gw-gpt-sol", "--"], { OPENAI_API_KEY: "existing" }, tmpHome, repoDir),
			).toBeUndefined();
			// Non-generic --provider override fails closed
			expect(
				resolveSwivalChildEnv(["--profile", "gw-gpt-sol", "--provider", "google", "--"], {}, tmpHome, repoDir),
			).toBeUndefined();
			// Unmatched --base-url override fails closed
			expect(
				resolveSwivalChildEnv(
					["--profile", "gw-gpt-sol", "--base-url", "https://attacker.example/v1", "--"],
					{},
					tmpHome,
					repoDir,
				),
			).toBeUndefined();
			// --system-prompt value containing "--profile=gw-gpt-sol" does not spoof CLI flags
			expect(
				resolveSwivalChildEnv(["--system-prompt", "--profile=gw-gpt-sol", "--"], {}, tmpHome, repoDir),
			).toBeUndefined();
			// Profile with quoted TOML key or omitted base_url must NOT fall back to root base_url
			fs.writeFileSync(
				path.join(cfgDir, "config.toml"),
				[
					'provider = "generic"',
					`base_url = "${GATEWAY_BASE_URL}"`,
					"[profiles.gw-quoted]",
					'provider = "generic"',
					'"base_url" = "http://127.0.0.1:8000/v1"',
					"[profiles.gw-gpt-sol]",
					'provider = "generic"',
					`base_url = "${GATEWAY_BASE_URL}"`,
				].join("\n"),
			);
			expect(resolveSwivalChildEnv(["--profile", "gw-quoted", "--"], {}, tmpHome, repoDir)).toBeUndefined();
			// Escaped quoted key in root or root reviewer = "..." in config.toml fails closed
			fs.writeFileSync(
				path.join(cfgDir, "config.toml"),
				[
					'provider = "generic"',
					`base_url = "${GATEWAY_BASE_URL}"`,
					'"\\u0061ctive_profile" = "local-qwen"',
					"[profiles.local-qwen]",
					'provider = "generic"',
					'base_url = "http://127.0.0.1:8000/v1"',
				].join("\n"),
			);
			expect(resolveSwivalChildEnv(["--"], {}, tmpHome, repoDir)).toBeUndefined();
			// A multiline string can hide a table header or a reviewer from the
			// line-oriented reader, so any multiline string fails closed.
			for (const quote of ['"""', "'''"]) {
				fs.writeFileSync(
					path.join(cfgDir, "config.toml"),
					[
						`system_prompt = ${quote}`, "[notes]", quote,
						'reviewer = "swival --profile local-qwen --reviewer-mode"',
						"[profiles.gw-gpt-sol]", 'provider = "generic"', `base_url = "${GATEWAY_BASE_URL}"`,
					].join("\n"),
				);
				expect(resolveSwivalChildEnv(["--profile", "gw-gpt-sol", "--"], {}, tmpHome, repoDir), quote).toBeUndefined();
				fs.writeFileSync(
					path.join(cfgDir, "config.toml"),
					["[profiles.gw-gpt-sol]", 'provider = "generic"', `base_url = "${GATEWAY_BASE_URL}"`, `note = ${quote}inert${quote}`].join("\n"),
				);
				expect(resolveSwivalChildEnv(["--profile", "gw-gpt-sol", "--"], {}, tmpHome, repoDir), quote).toBeUndefined();
			}
			// A multiline array may continue with a line opening on `[`; that line is
			// not a table header and must not hide a later reviewer or base_url.
			const nestedArray = ["commands = [", "  []", "]"];
			fs.writeFileSync(
				path.join(cfgDir, "config.toml"),
				[...nestedArray, 'reviewer = "swival --profile local-qwen --reviewer-mode"',
					"[profiles.gw-gpt-sol]", 'provider = "generic"', `base_url = "${GATEWAY_BASE_URL}"`].join("\n"),
			);
			expect(resolveSwivalChildEnv(["--profile", "gw-gpt-sol", "--"], {}, tmpHome, repoDir)).toBeUndefined();
			fs.writeFileSync(
				path.join(cfgDir, "config.toml"),
				['provider = "generic"', ...nestedArray, 'base_url = "https://attacker.example/v1"'].join("\n"),
			);
			expect(resolveSwivalChildEnv(["--"], {}, tmpHome, repoDir)).toBeUndefined();
			fs.writeFileSync(
				path.join(cfgDir, "config.toml"),
				["[profiles.gw-gpt-sol]", 'provider = "generic"', ...nestedArray, 'base_url = "https://attacker.example/v1"'].join("\n"),
			);
			expect(resolveSwivalChildEnv(["--profile", "gw-gpt-sol", "--"], {}, tmpHome, repoDir)).toBeUndefined();
			// The same array before a legitimate base_url still resolves, so the
			// continuation line is read as array content rather than refused outright.
			fs.writeFileSync(
				path.join(cfgDir, "config.toml"),
				["[profiles.gw-gpt-sol]", 'provider = "generic"', ...nestedArray, `base_url = "${GATEWAY_BASE_URL}"`].join("\n"),
			);
			expect(resolveSwivalChildEnv(["--profile", "gw-gpt-sol", "--"], {}, tmpHome, repoDir)).toEqual({ OPENAI_API_KEY: GATEWAY_KEY });
			// A dotted key sets profile fields without a table header.
			for (const dotted of ['profiles.gw-gpt-sol.base_url = "https://attacker.example/v1"', 'profiles."gw-gpt-sol".base_url = "https://attacker.example/v1"']) {
				fs.writeFileSync(
					path.join(cfgDir, "config.toml"),
					[dotted, "[profiles.gw-gpt-sol]", 'provider = "generic"', `base_url = "${GATEWAY_BASE_URL}"`].join("\n"),
				);
				expect(resolveSwivalChildEnv(["--profile", "gw-gpt-sol", "--"], {}, tmpHome, repoDir), dotted).toBeUndefined();
			}
			// Array-of-tables and whitespace-padded headers never select a profile silently.
			for (const header of ["[[profiles.gw-gpt-sol]]", "[profiles.gw-gpt-sol] trailing", "[profiles.gw-gpt-sol"]) {
				fs.writeFileSync(path.join(cfgDir, "config.toml"), [header, 'provider = "generic"', `base_url = "${GATEWAY_BASE_URL}"`].join("\n"));
				expect(resolveSwivalChildEnv(["--profile", "gw-gpt-sol", "--"], {}, tmpHome, repoDir), header).toBeUndefined();
			}
			fs.writeFileSync(path.join(cfgDir, "config.toml"), ["[ profiles . gw-gpt-sol ]", 'provider = "generic"', `base_url = "${GATEWAY_BASE_URL}"`].join("\n"));
			expect(resolveSwivalChildEnv(["--profile", "gw-gpt-sol", "--"], {}, tmpHome, repoDir)).toEqual({ OPENAI_API_KEY: GATEWAY_KEY });
			fs.writeFileSync(
				path.join(cfgDir, "config.toml"),
				[
					'reviewer = "swival --profile local-qwen --reviewer-mode"',
					"[profiles.gw-gpt-sol]",
					'provider = "generic"',
					`base_url = "${GATEWAY_BASE_URL}"`,
				].join("\n"),
			);
			expect(resolveSwivalChildEnv(["--profile", "gw-gpt-sol", "--"], {}, tmpHome, repoDir)).toBeUndefined();
			fs.writeFileSync(
				path.join(cfgDir, "config.toml"),
				["[profiles.gw-gpt-sol]", 'provider = "generic"', `base_url = "${GATEWAY_BASE_URL}"`].join("\n"),
			);
			expect(resolveSwivalChildEnv(["--profile", "gw-gpt-sol", "--"], {}, tmpHome, repoDir)).toEqual({
				OPENAI_API_KEY: GATEWAY_KEY,
			});
			// Project swival.toml in base-dir fails closed
			fs.writeFileSync(path.join(repoDir, "swival.toml"), 'base_url = "https://attacker.example/v1"\n');
			expect(resolveSwivalChildEnv(["--profile", "gw-gpt-sol", "--"], {}, tmpHome, repoDir)).toBeUndefined();
			fs.unlinkSync(path.join(repoDir, "swival.toml"));
			// Non-Anthropic oauth entry in auth.json fails closed
			fs.writeFileSync(authFile, JSON.stringify({ [GATEWAY_PROVIDER]: { type: "oauth", access: GATEWAY_KEY, expires: Date.now() + 3_600_000 } }), { mode: 0o600 });
			expect(resolveSwivalChildEnv(["--profile", "gw-gpt-sol", "--"], {}, tmpHome, repoDir)).toBeUndefined();
			fs.writeFileSync(authFile, JSON.stringify({ [GATEWAY_PROVIDER]: { type: "api_key", key: GATEWAY_KEY } }), { mode: 0o600 });
			// Group-writable auth.json fails closed
			fs.chmodSync(authFile, 0o620);
			expect(resolveSwivalChildEnv(["--profile", "gw-gpt-sol", "--"], {}, tmpHome, repoDir)).toBeUndefined();
			fs.chmodSync(authFile, 0o600);
			// Symlinked auth.json fails closed
			const targetAuth = path.join(tmpHome, "real-auth.json");
			fs.renameSync(authFile, targetAuth);
			fs.symlinkSync(targetAuth, authFile);
			expect(resolveSwivalChildEnv(["--profile", "gw-gpt-sol", "--"], {}, tmpHome, repoDir)).toBeUndefined();
		} finally {
			fs.rmSync(tmpHome, { recursive: true, force: true });
		}
	});

	it("fails closed on unsafe, ambiguous, or non-HTTPS models.json provider correlation", () => {
		const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-env-"));
		try {
			const agentDir = path.join(tmpHome, ".pi", "agent");
			const repoDir = path.join(tmpHome, "repo");
			fs.mkdirSync(repoDir, { recursive: true });
			const modelsFile = path.join(agentDir, "models.json");
			const route = ["--provider", "generic", "--base-url", GATEWAY_BASE_URL, "--"];
			const bridged = { OPENAI_API_KEY: GATEWAY_KEY };
			// 0644 models.json (Pi's default) is accepted
			writePiAgentFiles(agentDir, { modelsMode: 0o644 });
			expect(resolveSwivalChildEnv(route, {}, tmpHome, repoDir)).toEqual(bridged);
			// Group-writable models.json fails closed
			fs.chmodSync(modelsFile, 0o620);
			expect(resolveSwivalChildEnv(route, {}, tmpHome, repoDir)).toBeUndefined();
			fs.chmodSync(modelsFile, 0o644);
			// Symlinked models.json fails closed
			const targetModels = path.join(tmpHome, "real-models.json");
			fs.renameSync(modelsFile, targetModels);
			fs.symlinkSync(targetModels, modelsFile);
			expect(resolveSwivalChildEnv(route, {}, tmpHome, repoDir)).toBeUndefined();
			fs.unlinkSync(modelsFile);
			// Missing models.json fails closed even though auth.json holds the key
			expect(resolveSwivalChildEnv(route, {}, tmpHome, repoDir)).toBeUndefined();
			// Malformed models.json and non-object providers fail closed
			for (const malformed of ["{not json", JSON.stringify({ providers: [] }), JSON.stringify({ providers: { [GATEWAY_PROVIDER]: { baseUrl: ["https://gateway.example.com/v1"] } } })]) {
				writePiAgentFiles(agentDir, { models: malformed });
				expect(resolveSwivalChildEnv(route, {}, tmpHome, repoDir), malformed).toBeUndefined();
			}
			// A non-HTTPS provider never bridges and does not poison a valid HTTPS provider
			writePiAgentFiles(agentDir, {
				models: { providers: { "local-llm": { baseUrl: "http://127.0.0.1:8000/v1" }, [GATEWAY_PROVIDER]: { baseUrl: GATEWAY_BASE_URL } } },
				auth: { "local-llm": { type: "api_key", key: "synthetic-local-token" }, [GATEWAY_PROVIDER]: { type: "api_key", key: GATEWAY_KEY } },
			});
			expect(resolveSwivalChildEnv(route, {}, tmpHome, repoDir)).toEqual(bridged);
			expect(resolveSwivalChildEnv(["--provider", "generic", "--base-url", "http://127.0.0.1:8000/v1", "--"], {}, tmpHome, repoDir)).toBeUndefined();
			// Two providers matching the same baseUrl are ambiguous and fail closed
			writePiAgentFiles(agentDir, {
				models: { providers: { [GATEWAY_PROVIDER]: { baseUrl: GATEWAY_BASE_URL }, "acme-gateway-alt": { baseUrl: "https://gateway.example.com" } } },
			});
			expect(resolveSwivalChildEnv(route, {}, tmpHome, repoDir)).toBeUndefined();
			// An `anthropic` entry in models.json is never used for the generic bridge
			writePiAgentFiles(agentDir, {
				models: { providers: { anthropic: { baseUrl: GATEWAY_BASE_URL } } },
				auth: { anthropic: { type: "api_key", key: "synthetic-anthropic-key" } },
			});
			expect(resolveSwivalChildEnv(route, {}, tmpHome, repoDir)).toBeUndefined();
			// Correlated provider present in models.json but missing from auth.json fails closed
			writePiAgentFiles(agentDir, { auth: {} });
			expect(resolveSwivalChildEnv(route, {}, tmpHome, repoDir)).toBeUndefined();
		} finally {
			fs.rmSync(tmpHome, { recursive: true, force: true });
		}
	});

	it.each([
		["userinfo", "https://user:pass@gateway.example.com/v1"],
		["query", "https://gateway.example.com/v1?x=1"],
		["fragment", "https://gateway.example.com/v1#frag"],
		["encoded traversal", "https://gateway.example.com/v1/%2e%2e/v1"],
		["raw traversal", "https://gateway.example.com/v2/../v1"],
		["encoded slash", "https://gateway.example.com/v1%2fchat"],
		["backslash", "https://gateway.example.com\\v1"],
		["sibling path", "https://gateway.example.com/v2"],
		["path prefix without separator", "https://gateway.example.com/v10"],
		["host prefix", "https://gateway.example.com.attacker.test/v1"],
		["host suffix", "https://evil-gateway.example.com/v1"],
		["http scheme", "http://gateway.example.com/v1"],
		["surrounding whitespace", " https://gateway.example.com/v1"],
	])("fails closed on %s base_url edge case", (_label, baseUrl) => {
		const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-env-"));
		try {
			writePiAgentFiles(path.join(tmpHome, ".pi", "agent"));
			expect(resolveSwivalChildEnv(["--provider", "generic", "--base-url", baseUrl, "--"], {}, tmpHome, tmpHome)).toBeUndefined();
		} finally {
			fs.rmSync(tmpHome, { recursive: true, force: true });
		}
	});

	it("bridges Anthropic OAuth token and prepends ANTHROPIC_OAUTH_SHIM_DIR to PYTHONPATH for anthropic routes", () => {
		const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swival-ant-env-"));
		try {
			const agentDir = path.join(tmpHome, ".pi", "agent");
			const cfgDir = path.join(tmpHome, ".config", "swival");
			const repoDir = path.join(tmpHome, "repo");
			fs.mkdirSync(agentDir, { recursive: true });
			fs.mkdirSync(cfgDir, { recursive: true });
			fs.mkdirSync(repoDir, { recursive: true });
			fs.writeFileSync(
				path.join(agentDir, "auth.json"),
				JSON.stringify({
					anthropic: {
						type: "oauth",
						access: "sk-ant-oat01-synthetic-token",
						expires: Date.now() + 3_600_000,
					},
				}),
				{ mode: 0o600 },
			);
			fs.writeFileSync(
				path.join(cfgDir, "config.toml"),
				[
					'active_profile = "vertex-gemini-flash"',
					"[profiles.anthropic-claude-mythos]",
					'provider = "anthropic"',
					'model = "claude-mythos-5-2"',
					"max_context_tokens = 1000000",
					'reasoning_effort = "high"',
				].join("\n"),
			);
			const env = resolveSwivalChildEnv(
				["--profile", "anthropic-claude-mythos", "--"],
				{ PATH: "/usr/bin" },
				tmpHome,
				repoDir,
			);
			expect(env).toBeDefined();
			expect(env?.ANTHROPIC_API_KEY).toBe("sk-ant-oat01-synthetic-token");
			expect(env?.PYTHONPATH).toContain("anthropic_oauth_shim");
			// Ambient ANTHROPIC_API_BASE / ANTHROPIC_BASE_URL fail closed
			expect(
				resolveSwivalChildEnv(
					["--profile", "anthropic-claude-mythos", "--"],
					{ PATH: "/usr/bin", ANTHROPIC_API_BASE: "https://attacker.example" },
					tmpHome,
					repoDir,
				),
			).toBeUndefined();
			expect(
				resolveSwivalChildEnv(
					["--profile", "anthropic-claude-mythos", "--"],
					{ PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://attacker.example" },
					tmpHome,
					repoDir,
				),
			).toBeUndefined();
			// Inherited non-canonical root base_url fails closed when profile omits base_url
			fs.writeFileSync(
				path.join(cfgDir, "config.toml"),
				[
					'base_url = "https://attacker.example/v1"',
					"[profiles.anthropic-claude-mythos]",
					'provider = "anthropic"',
					'model = "claude-mythos-5-2"',
				].join("\n"),
			);
			expect(
				resolveSwivalChildEnv(["--profile", "anthropic-claude-mythos", "--"], { PATH: "/usr/bin" }, tmpHome, repoDir),
			).toBeUndefined();
			// Canonical host with userinfo, query, or fragment fails closed; the bare canonical endpoint bridges
			for (const baseUrl of ["https://user@api.anthropic.com", "https://api.anthropic.com/?x=1", "https://api.anthropic.com/#frag", "https://api.anthropic.com.attacker.test"]) {
				expect(
					resolveSwivalChildEnv(["--profile", "anthropic-claude-mythos", "--base-url", baseUrl, "--"], { PATH: "/usr/bin" }, tmpHome, repoDir),
					baseUrl,
				).toBeUndefined();
			}
			expect(
				resolveSwivalChildEnv(["--profile", "anthropic-claude-mythos", "--base-url", "https://api.anthropic.com", "--"], { PATH: "/usr/bin" }, tmpHome, repoDir)?.ANTHROPIC_API_KEY,
			).toBe("sk-ant-oat01-synthetic-token");
		} finally {
			fs.rmSync(tmpHome, { recursive: true, force: true });
		}
	});
});
