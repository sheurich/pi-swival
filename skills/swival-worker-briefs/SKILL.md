---
name: swival-worker-briefs
description: >-
  Write precise task briefs for `self-review-worker` dispatches. Use when
  dispatching `self-review-worker` for implementation, file edits, generated
  artifacts, or other work that should pass through Swival's self-review loop.
---

# Swival worker briefs

Use this skill when drafting the `task` value and dispatch overrides for a `swival-subagent` call to `self-review-worker`.

`self-review-worker` runs Swival with `--self-review` enabled. The bundled agent definition lives at `../../agents/self-review-worker.md` relative to this skill. It is an implementation agent, not a review-only agent. Use it for code changes, file edits, and generated artifacts where an in-process review pass should check the result before returning.

Do not use `self-review-worker` for pure review tasks. For PR reviews or read-only change assessment, use dedicated reviewer agents or review skills.

The agent defaults to `maxReviewRounds: 5`, `files: some`, `commands: all`, `noInstructions: true`, and `noMemory: true`. Pass `instructionsFullOverride: true` when the worker needs repository `AGENTS.md`/`CLAUDE.md` files; host harness instructions are not loaded automatically and must be stated in the brief.

## How `--self-review` works (and what it cannot see)

Understanding Swival's `SelfReviewer` mechanics is essential when writing briefs:

1. **Read-only file inspection only — no commands or tests:** `SelfReviewer` runs a read-only agent loop (`READ_ONLY_AGENT_TOOLS`, `files="some"`, `network="provider-only"`) using the same model/provider as the worker. It can read, list, grep, and outline files inside `cwd`, **but it cannot execute shell commands, builds, or tests**.
2. **No visibility into the worker's tool-call transcript:** `SelfReviewer` receives only `<task>`, optional `<verification>` (`verifyOverride`), the worker's final `<answer>` text, and optional custom rubric instructions (`reviewPromptOverride`). It never sees intermediate tool calls or command outputs unless the worker quotes them in `<answer>`.
3. **Scoped strictly to `cwd`:** `SelfReviewer` inspects only `cwd` (`base_dir`) with `extra_write_roots=[]`. Files outside `cwd` (including paths granted to the worker via `addDir` or `addDirRo`) are invisible to `SelfReviewer`. Keep all files that require review inside `cwd`.
4. **When to use `test-runner` instead:** If you want an executable test, linter, or build script to run inside the retry loop after each turn, dispatch `test-runner` (`../../agents/test-runner.md`) with `reviewerOverride: "<script>"` (test-as-contract), or pair `self-review-worker` with `reviewPromptOverride` / `verifyOverride`. Because Swival's review loop applies the same outer-success fallback to both `--self-review` and external `--reviewer` scripts (see below), always verify `report.json` and run the test command in the parent session before accepting either agent's output.

## Reviewer outcome semantics and parent verification

In Swival 1.9.3, when either `SelfReviewer` (`--self-review`) or `ExternalReviewer` (`--reviewer`, used by `test-runner`) encounters a reviewer error (`verdict.status == "error"` / exit code `>= 2`) or reaches `maxReviewRounds` (default `5` on `self-review-worker`, `10` on `test-runner`), Swival logs a warning (`accepting answer as-is` or `Max review rounds (<N>) reached, accepting answer`) and still exits `0` with `result.outcome = "success"`.

After every `self-review-worker` (or `test-runner`) run, the caller must:

- Inspect `report.json` (confirm the final `type: "review"` entry in `timeline` has `exit_code: 0` rather than `1` or `2`).
- Run `git status --short`, `git diff`, and the validation command independently in the parent session before staging or committing.
- Treat same-model `--self-review` as a first-pass implementation filter, not a substitute for independent cross-model review or human acceptance.

## Brief structure

Every task brief should include six elements plus an explicit evidence requirement:

1. **Goal:** one sentence defining the required result.
2. **Pre-flight & Hygiene:** worktree verification, mutation boundaries, test integrity, and non-interactive failure rules.
3. **Scope:** exact files, directories, or artifacts under `cwd` the worker may change, and paths/behaviors that must remain untouched.
4. **Constraints:** style rules, architectural invariants, compatibility limits, and dependency boundaries (no unapproved installs or config edits).
5. **Validation:** exact commands to run and expected outputs before declaring completion.
6. **Done when:** specific observable states in `cwd` and validation outputs that count as complete.

Prefer concrete, verifiable instructions over vague quality requests (`Fix parser EOF handling in src/parser.ts and run npm test` rather than `improve parser quality`).

## Evidence standard

Because `SelfReviewer` sees only `<answer>` and files under `cwd`, the brief must require the worker's final answer to include:

- **Pre-flight state:** confirmed `pwd`, branch, `HEAD`, and initial `git status --short`.
- **Changed files:** exact relative paths under `cwd` modified, added, or deleted.
- **Commands and verbatim outputs:** each validation command run, its exact exit code, and relevant stdout/stderr summary.
- **Residual risks:** any edge cases, skipped paths, or open questions (or `none`).

When tasks rely on external or repository claims, require citations with exact file paths and line numbers.

## Dispatch overrides and context budgeting

Pair a well-structured brief with dispatch overrides that match the task's risk and output size:

| Override | When to use |
| --- | --- |
| `profileOverride` | Select a named profile from `~/.config/swival/config.toml` matching task complexity (e.g. a fast/budget profile for bounded mechanical edits or a frontier reasoning profile for complex refactors). |
| `networkOverride: "provider-only"` | Block child shell commands and Python scripts from outbound network access while preserving LLM provider API access. |
| `reviewPromptOverride` | Supply a focused checklist for `SelfReviewer` to verify in the edited files (e.g. `"Read the modified files and verify error paths, types, and quoted test output."` ). |
| `verifyOverride` | Point `SelfReviewer` at an acceptance-criteria file path (resolved relative to `cwd`). |
| `instructionsFullOverride: true` | Load complete repository `AGENTS.md`/`CLAUDE.md` files without the instruction-budget cap (`<= 8,192` tokens; suppresses `--no-instructions`). |
| `output` / `outputMode` / `maxInlineBytes` | Pass `output: "<artifact-path>"` (resolved relative to the task's `cwd`; defaults to `outputMode: "file-only"`) to return only path + size metadata to the parent while `SelfReviewer` still inspects the full `<answer>` in-process, or pass `maxInlineBytes` to keep short answers inline and truncate longer ones with a pointer to the artifact directory. |

## Brief template

```text
Goal: <one-sentence result>

Pre-flight & Hygiene:
- Verify `pwd`, current Git branch, `HEAD`, and `git status --short` before editing. Stop and report immediately if unexpected or unattributed dirty files exist.
- Edit only the declared in-scope files under `cwd`. Do not run `git commit`, `git stash`, `git reset`, `git push`, package installations, or host-state mutations.
- Do not weaken, skip (`skip`/`xfail`), or delete tests or assertions to make checks pass.
- Non-interactive execution: stop and escalate immediately if any command prompts for credentials, SSH PIN/hardware-token touch, or interactive input; never retry or switch authentication methods.

Scope:
- Change only: <relative paths under cwd>.
- Do not change: <paths, public APIs, or behaviors>.

Constraints:
- <specific architectural, typing, or compatibility constraints>

Validation:
- Run: <exact command>
- Expected: <exit 0 and observable test/lint output>

Done when:
- <observable file state 1>
- <observable validation result 2>

Final answer must include:
1. Pre-flight `pwd`, branch, `HEAD`, and initial status.
2. Exact list of changed files under `cwd`.
3. Every validation command run, its exact exit code, and verbatim pass/fail summary (required so the read-only self-reviewer can verify your claims).
4. Residual risks or open questions.
```

## Dispatch examples

Single implementation task with provider-only network isolation and custom reviewer checklist:

```text
swival-subagent with
  agent: "self-review-worker",
  profileOverride: "budget",
  networkOverride: "provider-only",
  reviewPromptOverride: "Read cmd/serve.go and cmd/serve_test.go to verify input validation, preserved error types, and that the answer quotes passing go test output.",
  task: [
    "Goal: Add input validation to cmd/serve.go.",
    "Pre-flight & Hygiene: verify pwd, branch, HEAD, and clean git status before editing; stop on unexpected dirt. Do not commit, push, install packages, or weaken tests.",
    "Scope: change only cmd/serve.go and cmd/serve_test.go.",
    "Constraints: preserve existing error types and CLI flags.",
    "Validation: run `go test -v ./cmd/...`.",
    "Done when: invalid input returns an error and `go test -v ./cmd/...` exits 0.",
    "Final answer must include pre-flight status, changed files, exact validation commands with exit codes and output summary, and residual risks."
  ].join("\n")
```

Parallel tasks on isolated worktrees with file-backed output budgeting:

Parallel write-capable tasks must target distinct `cwd` directories that already exist. Allocate each worktree before dispatching (for example with Worktrunk `wt switch --create --no-cd <branch>` or `git worktree add -b worker-a .worktrees/worker-a HEAD`). For bundled and user-scope agents in linked Git worktrees, `pi-swival` validates the worktree and passes `--add-dir-ro <git-common-dir>` automatically so read-only Git commands (`git status`, `git diff`, `git rev-parse`) work under `networkOverride: "provider-only"` while shared `.git` metadata stays write-protected. See the `swival` skill for merge and cleanup procedures.

```text
swival-subagent with
  networkOverride: "provider-only",
  tasks: [
    {
      agent: "self-review-worker",
      cwd: ".worktrees/worker-a",
      output: ".swival-summary.md",
      task: [
        "Goal: Refactor auth token parsing.",
        "Pre-flight & Hygiene: verify pwd, branch, HEAD, and clean git status; stop on unexpected dirt. Do not commit or weaken tests.",
        "Scope: change only auth/*.go.",
        "Constraints: keep public API unchanged.",
        "Validation: run `go test ./auth/...`.",
        "Done when: `go test ./auth/...` exits 0.",
        "Final answer must include pre-flight status, changed files, validation commands with exit codes and output, and residual risks."
      ].join("\n")
    },
    {
      agent: "self-review-worker",
      cwd: ".worktrees/worker-b",
      output: ".swival-summary.md",
      task: [
        "Goal: Add parser error regression tests.",
        "Pre-flight & Hygiene: verify pwd, branch, HEAD, and clean git status; stop on unexpected dirt. Do not commit or edit production code.",
        "Scope: change only parser/*_test.go.",
        "Constraints: no production edits.",
        "Validation: run `go test ./parser/...`.",
        "Done when: `go test ./parser/...` exits 0.",
        "Final answer must include pre-flight status, changed files, validation commands with exit codes and output, and residual risks."
      ].join("\n")
    }
  ]
```

## Common pitfalls

- **Assuming `--self-review` runs your test suite:** `SelfReviewer` is read-only and cannot run commands. If the worker does not quote command exit codes and output in `<answer>`, `SelfReviewer` has no way to see whether tests ran. Use `test-runner` with `reviewerOverride` when an executable script should drive retry feedback, and still verify `report.json` (`exit_code: 0` on the final `type: "review"` timeline entry) plus parent-session validation before accepting.
- **Editing or referencing files outside `cwd`:** `SelfReviewer` cannot read paths outside `cwd` (even with `addDir` / `addDirRo`). Always set `cwd` to a root that encloses every file under review.
- **Trusting exit code `0` without checking `report.json` and `git diff`:** Swival 1.9.3 exits `0` with `outcome = "success"` even when `maxReviewRounds` is exhausted or the reviewer errors. Check `timeline` review events in `report.json` and run validation in the parent session.
- **Requesting review-only output from `self-review-worker`:** Use a read-only reviewer agent instead.
- **Omitting pre-flight and git/auth stop rules:** Because `--no-instructions` is on by default, always state worktree pre-flight checks, no-commit/no-push boundaries, and non-interactive stop-on-auth-failure rules in the brief.
- **Running parallel mutating tasks on the same `cwd`:** Pre-create and pass distinct worktree paths via `cwd`.
