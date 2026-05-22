---
name: auditing-with-swival
description: >-
  Run reproducible multi-bucket security audits using swival-subagent. Use
  when auditing a non-trivial codebase for security issues — splits work into
  recon, parallel per-bucket audit, and consolidation stages with structured
  output contracts at each stage. Triggers on: security audit, audit a repo,
  audit a codebase, multi-bucket audit, reproducible audit, consolidate audit
  findings, "Swival audit", "/swival-audit".
---

# Auditing with Swival

A three-stage pipeline for security audits over codebases too large for one worker. Each stage has a structured output contract so the pipeline is reproducible across runs and across operators.

## When to use

Run this pipeline when:

- The target codebase is larger than ~5 k LOC or spans multiple trust boundaries
- You need a defensible audit trail (prompts, reports, consolidated findings, hashes)
- The output will be reviewed by another human or fed into a remediation plan

For a one-off read of a small file or a quick "is X safe", just read the code directly. Don't spin up the pipeline.

## What the human stops doing

This skill exists to absorb the consolidation and routing labor:

- Before: human reads N raw worker reports, manually deduplicates, ranks by severity, writes a summary doc. Hours per audit.
- After: human reviews one recon JSON (confirm bucket cuts), then one consolidated findings doc. Minutes.

Bucket discovery moves from a session-local judgment call to a recon worker output that's inspectable, version-controlled, and re-runnable.

## Pipeline

```
Stage 1: recon          (1 worker)   → recon.json with bucket specs
   ↓
[checkpoint: human reviews bucket list]
   ↓
Stage 2: per-bucket     (N workers)  → reports/<bucket>.report.md (one per bucket)
   ↓
Stage 3: consolidation  (1 worker)   → consolidated-findings.md
   ↓
[checkpoint: human reviews consolidated doc]
```

The orchestrator coordinates between stages but does not synthesize findings itself. All synthesis happens inside Swival workers with explicit contracts, so the orchestrator's judgment doesn't drift the output.

## Workspace layout

```
$WORKSPACE/
├── preflight/
│   └── commits.txt              # repo path, ref, SHA at audit time
├── recon.json                   # Stage 1 output, parsed for fan-out
├── prompts/
│   └── <bucket-id>.md           # generated per bucket from template
├── reports/
│   ├── <bucket-id>.report.md    # Stage 2 worker stdout
│   └── <bucket-id>.swival-report.json
├── consolidated-findings.md     # Stage 3 output
└── SHA256SUMS.txt               # all reports hashed for auditability
```

Set `WORKSPACE=$HOME/.cache/swival-audit-<repo-slug>-<date>` and create it before Stage 1.

## Models and effort

Pass these as dispatch-time overrides on every worker. Do not hardcode model names — they live in `~/.config/swival/config.toml`.

| Override | Value | Rationale |
|---|---|---|
| `profileOverride` | `"heavy"` | Frontier-tier judgment. Audit is novel reasoning across call graphs; review loop alone doesn't compensate for a weaker model. |
| `reasoningEffortOverride` | `"high"` | Multi-step exploit reasoning needs extended thinking. |
| `temperatureOverride` | `0.2` | Audit reports should be deterministic; suppress confident hallucination. |
| `maxReviewRoundsOverride` | `2` | One review pass catches attention-lapse errors without unbounded spend. |
| `seedOverride` | `<fixed int>` | Reproducibility on re-run. Pick a date-based int. |

Verify `swival --list-profiles` includes `heavy` before Stage 1. If not, halt — do not silently fall back.

## Stage 1 — recon

Dispatch one `security-recon` worker. Its only job is to survey the repo and emit `recon.json` matching the contract.

```
swival-subagent with
  agent: "security-recon"
  cwd: "<repo absolute path>"
  task: "<contents of recon prompt — see below>"
  output: "$WORKSPACE/recon.json"
  profileOverride: "heavy"
  reasoningEffortOverride: "high"
  temperatureOverride: 0.2
  maxReviewRoundsOverride: 2
  seedOverride: <int>
```

Recon prompt body (substitute repo metadata):

```
Survey the repository at <absolute path>, branch <branch>, commit <SHA>.
Identify production code paths grouped by trust boundary or threat model.
Emit recon.json matching the contract.
```

Output contract: see `references/recon-contract.md`.

Checkpoint: read `recon.json`. Confirm buckets are non-overlapping, named meaningfully, and globs cover the production surface. Adjust if needed (re-dispatch or hand-edit) before Stage 2.

## Stage 2 — parallel per-bucket audits

Parse `recon.json`. For each bucket, render the prompt template (`references/audit-prompt-template.md`) into `$WORKSPACE/prompts/<bucket-id>.md`, then dispatch as one parallel call:

```
swival-subagent with
  agent: "audit-worker"
  concurrency: 3
  profileOverride: "heavy"
  reasoningEffortOverride: "high"
  temperatureOverride: 0.2
  maxReviewRoundsOverride: 2
  seedOverride: <int>
  tasks: [
    { agent: "audit-worker",
      cwd:  "<repo absolute path>",
      task: "/audit\n<contents of prompts/<bucket-id>.md>",
      output: "$WORKSPACE/reports/<bucket-id>.report.md" },
    ...one per bucket
  ]
```

The `audit-worker` agent is the existing read-only auditor (see `~/.pi/agent/swival-agents/audit-worker.md`). The leading `/audit` is required by that agent.

Set `concurrency` based on token budget and rate limits. Defaults: 3 for `heavy` profile, 4 for lighter.

Output contract per report: see `references/audit-prompt-template.md` § "Required finding format".

After dispatch, run `git -C <repo> status --porcelain` and halt on any output. The audit-worker is read-only by command allowlist; uncommitted changes mean a worker violated its sandbox.

## Stage 3 — consolidation

Dispatch one `security-consolidator` worker with read access to the reports directory.

```
swival-subagent with
  agent: "security-consolidator"
  cwd: "$WORKSPACE"
  task: "<consolidation prompt — see below>"
  output: "$WORKSPACE/consolidated-findings.md"
  profileOverride: "heavy"
  reasoningEffortOverride: "high"
  temperatureOverride: 0.2
  maxReviewRoundsOverride: 2
  seedOverride: <int>
```

Consolidation prompt body:

```
Read every file under reports/. For each finding, dedupe across buckets
and produce a consolidated report matching the contract.
```

Output contract: see `references/consolidation-contract.md`.

After Stage 3:

```bash
shasum -a 256 "$WORKSPACE"/{recon.json,reports/*,consolidated-findings.md} \
  > "$WORKSPACE/SHA256SUMS.txt"
```

Share `consolidated-findings.md` through whatever channel the audit consumer expects — a Google Doc, a tracking ticket, an internal wiki page. The pipeline produces a self-contained Markdown document; downstream distribution is out of scope for this skill.

## Re-dispatch heuristics

A worker returning "No concrete findings." is acceptable only if its coverage notes substantiate full scope review. If coverage notes are thin or absent, re-dispatch that single bucket once with `maxReviewRoundsOverride: 3`. Escalating beyond that requires a human decision.

If two buckets report overlapping findings (same file:line), Stage 3 dedupes them. If two buckets report contradictory verdicts on the same file:line, halt and ask the human — that's a signal of buggy bucket boundaries.

## Anti-patterns

- Skipping recon and writing buckets in your head. Bucket choices are the single biggest determinant of audit quality and they need to be inspectable.
- Letting one worker see another worker's output. The review boundary depends on independence.
- Hardcoding model IDs in agent definitions or dispatches. Routing belongs in `~/.config/swival/config.toml`.
- Accepting "No concrete findings" without coverage notes. That report is unverified, not negative.
- Running consolidation in the orchestrator's context. The orchestrator has too much extra context; synthesis drifts. Use the dedicated agent.
- Mixing audit and remediation in one pipeline. This skill is read-only. Backports are a separate flow that uses `reviewed-worker`.

## Cross-references

- The companion `swival-audit` prompt template (`prompts/swival-audit.md` in this package) walks an interactive operator through the same pipeline as a slash-command-style invocation.
- For implementing fixes from audit findings, dispatch a `reviewed-worker` separately. This skill is read-only; remediation is a separate flow.

## Reference files

| File | Purpose |
|---|---|
| `references/recon-contract.md` | JSON schema for Stage 1 output |
| `references/audit-prompt-template.md` | Template for per-bucket prompts in Stage 2 |
| `references/consolidation-contract.md` | Output format for Stage 3 |
