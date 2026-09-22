---
name: swival-worker-briefs
description: >-
  Write precise task briefs for `self-review-worker` dispatches. Use when
  dispatching `self-review-worker` for implementation, file edits, generated
  artifacts, or other work that should pass through Swival's self-review loop.
---

# Swival worker briefs

Use this skill when drafting the `task` value for a `swival-subagent` dispatch to `self-review-worker`.

`self-review-worker` runs Swival with `--self-review` enabled. The bundled agent definition lives at `../../agents/self-review-worker.md` relative to this skill. It is an implementation agent, not a review-only agent. Use it for code changes, file edits, and generated artifacts where a second-pass review should verify the output before acceptance.

Do not use `self-review-worker` for pure review tasks. For PR reviews or change assessment without edits, use reviewer agents or review skills.

The agent defaults to `maxReviewRounds: 5` and runs with `--no-instructions` and `--no-memory`. Pass `instructionsFullOverride: true` if the worker requires repository instructions.

## Brief structure

Every task brief should include five core elements plus an evidence requirement:

1. Goal: one sentence defining the required result.
2. Scope: files, directories, or artifacts the worker may change.
3. Constraints: repo instructions, style rules, compatibility limits, and things not to change.
4. Validation: commands to run and expected outputs before declaring completion.
5. Done when: specific observable states that count as accepted.

Prefer specific instructions over broad quality requests. For example, `Fix parser error handling and run pytest tests/parser` is better than `improve parser quality`.

## Evidence standard

The worker's final answer must include:

- list of changed files
- commands run and their output
- validation results or reasons why validation could not run
- residual risks or open questions

When tasks rely on external claims, require citations from primary sources such as file paths, test runs, or upstream documentation.

## Brief template

```text
Goal: <one sentence result>

Scope:
- Change only <paths>.
- Do not change <paths or behavior>.

Constraints:
- <specific constraints or design choices>

Validation:
- Run: <command>
- Expected: <observable result>

Done when:
- <condition 1>
- <condition 2>

Final answer must include changed files, commands run, validation output, and residual risks.
```

## Dispatch examples

Single implementation task:

```text
swival-subagent with agent: "self-review-worker", task: [
  "Goal: Add input validation to cmd/serve.go.",
  "Scope: change only cmd/serve.go and its tests.",
  "Constraints: preserve existing error types and CLI flags.",
  "Validation: run `go test ./cmd/...`.",
  "Done when: invalid input returns an error and tests pass.",
  "Final answer must include changed files, commands run, validation output, and residual risks."
].join("\n")
```

Parallel tasks on isolated worktrees:

Parallel write-capable tasks must run with distinct `cwd` paths that already exist. Create each worktree before dispatching (`git worktree add -b worker-a .worktrees/worker-a HEAD`). See the `swival` skill for merge and cleanup procedures.

```text
swival-subagent with tasks: [
  {
    agent: "self-review-worker",
    cwd: ".worktrees/worker-a",
    task: [
      "Goal: Refactor auth parsing.",
      "Scope: change only auth/*.go.",
      "Constraints: keep public API.",
      "Validation: run `go test ./auth/...`.",
      "Done when: tests pass.",
      "Final answer must include changed files, commands run, validation output, and residual risks."
    ].join("\n")
  },
  {
    agent: "self-review-worker",
    cwd: ".worktrees/worker-b",
    task: [
      "Goal: Add parser error tests.",
      "Scope: change only parser tests.",
      "Constraints: no production edits.",
      "Validation: run `go test ./parser/...`.",
      "Done when: tests pass.",
      "Final answer must include changed files, commands run, validation output, and residual risks."
    ].join("\n")
  }
]
```

## Common failures

- Requesting review-only output from `self-review-worker`. Use a reviewer agent instead.
- Omitting validation commands. Without commands, the self-review loop only evaluates output text and cannot confirm runtime behavior.
- Writing vague scope descriptions like `clean this up`. Specify exact files and target behaviors.
- Running parallel mutating tasks on the same `cwd`. Pre-create and supply distinct worktree paths via `cwd`.
- Treating `--self-review` as a human review replacement. You still own final acceptance.
