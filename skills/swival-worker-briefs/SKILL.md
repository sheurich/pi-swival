---
name: swival-worker-briefs
description: >-
  Write precise task briefs for `self-review-worker` dispatches. Use when
  dispatching `self-review-worker` for implementation, file edits, generated
  artifacts, or other work that should pass through Swival's self-review loop.
---

# Swival Worker Briefs

Use this skill when drafting `task` briefs and overrides for `swival-subagent` calls to `self-review-worker` (`../../agents/self-review-worker.md`). Use `self-review-worker` for code edits and generated artifacts, never for pure read-only reviews.

`self-review-worker` defaults to `maxReviewRounds: 5`, `files: some`, `commands: all`, `noInstructions: true`, and `noMemory: true`. Pass `instructionsFullOverride: true` when the worker needs repository `AGENTS.md`/`CLAUDE.md` files; otherwise state required project constraints directly in the brief.

## How `--self-review` works

1. **Read-only inspection (`READ_ONLY_AGENT_TOOLS`):** `SelfReviewer` can read, list, grep, and outline files inside `cwd`, but cannot run shell commands, builds, or tests.
2. **Transcript blindness:** `SelfReviewer` sees only `<task>`, optional `<verification>` (`verifyOverride`), `<answer>`, and optional `reviewPromptOverride`—never intermediate tool calls unless quoted in `<answer>`.
3. **Scoped to `cwd`:** `SelfReviewer` cannot inspect paths outside `cwd` (even when `addDir` or `addDirRo` is set). Keep all reviewed files inside `cwd`.
4. **Executable test gates:** Use `test-runner` (`../../agents/test-runner.md`) with `reviewerOverride: "<script>"` when a test or build script must run inside the retry loop.

## Reviewer outcome verification

In Swival 1.9.3, if `SelfReviewer` or `ExternalReviewer` errors (`exit_code >= 2`) or exhausts `maxReviewRounds`, Swival logs `accepting answer as-is` (or `Max review rounds (<N>) reached, accepting answer`) and still exits `0` with `outcome = "success"`. After every run:

- Check `report.json` to confirm the final `type: "review"` entry in `timeline` recorded `exit_code: 0`.
- Run `git status --short`, `git diff`, and the validation command in the parent session before staging or committing.

## Dispatch overrides

| Override | Purpose |
|---|---|
| `profileOverride` | Select a profile in `~/.config/swival/config.toml` matched to task complexity |
| `networkOverride: "provider-only"` | Block child shell/Python network access while keeping provider API access |
| `reviewPromptOverride` | Checklist for `SelfReviewer` (e.g. `"Verify modified files, types, and quoted test output."`) |
| `verifyOverride` | Acceptance-criteria file path (relative to `cwd`) |
| `instructionsFullOverride: true` | Load full `AGENTS.md`/`CLAUDE.md` without truncation |
| `output` / `outputMode` / `maxInlineBytes` | Write output to `<path>` (`outputMode: "file-only"` by default) or cap inline characters while `SelfReviewer` still sees the full `<answer>` |

## Brief template

```text
Goal: <one-sentence result>

Pre-flight & Hygiene:
- Verify `pwd`, Git branch, `HEAD`, and `git status --short` before editing; stop on unexpected dirty files.
- Edit only declared in-scope paths under `cwd`. Do not commit, push, stash, reset, install packages, or weaken/skip tests.
- Stop immediately if any command prompts for credentials, SSH PIN/token touch, or interactive input.

Scope:
- Change only: <relative paths under cwd>
- Do not change: <untouched paths, public APIs, or behaviors>

Constraints:
- <typing, architectural, or compatibility invariants>

Validation:
- Run: <exact command> (expected: exit 0 and <observable output>)

Done when:
- <observable file and validation outcomes>

Final answer must include:
1. Pre-flight `pwd`, branch, `HEAD`, and initial status.
2. Changed files under `cwd`.
3. Every validation command run, exact exit code, and verbatim pass/fail summary.
4. Residual risks or open questions.
```

## Dispatch examples

Single task:

```text
swival-subagent with
  agent: "self-review-worker",
  profileOverride: "budget",
  networkOverride: "provider-only",
  reviewPromptOverride: "Read cmd/serve.go and cmd/serve_test.go to verify input validation, error types, and passing go test output.",
  task: [
    "Goal: Add input validation to cmd/serve.go.",
    "Pre-flight & Hygiene: verify pwd, branch, HEAD, and clean git status; do not commit, install packages, or weaken tests.",
    "Scope: change only cmd/serve.go and cmd/serve_test.go.",
    "Constraints: preserve existing error types and CLI flags.",
    "Validation: run `go test -v ./cmd/...`.",
    "Done when: invalid input returns an error and `go test -v ./cmd/...` exits 0.",
    "Final answer must include pre-flight status, changed files, exact validation exit codes and summary, and residual risks."
  ].join("\n")
```

Parallel tasks on distinct pre-created worktrees (`pi-swival` passes `--add-dir-ro <git-common-dir>` automatically for bundled/user agents in linked worktrees):

```text
swival-subagent with
  networkOverride: "provider-only",
  tasks: [
    {
      agent: "self-review-worker",
      cwd: ".worktrees/worker-a",
      output: ".swival-summary.md",
      task: "Goal: Refactor auth token parsing.\nPre-flight & Hygiene: verify clean git status; do not commit.\nScope: auth/*.go only.\nValidation: run `go test ./auth/...` and quote exit code + output."
    },
    {
      agent: "self-review-worker",
      cwd: ".worktrees/worker-b",
      output: ".swival-summary.md",
      task: "Goal: Add parser error regression tests.\nPre-flight & Hygiene: verify clean git status; do not edit production code.\nScope: parser/*_test.go only.\nValidation: run `go test ./parser/...` and quote exit code + output."
    }
  ]
```
