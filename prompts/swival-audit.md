---
description: Run a read-only Swival security audit for a repository reference
argument-hint: "<repo-ref> [scope or notes...]"
---
Run a read-only Swival security audit for this repository reference: $ARGUMENTS

The first argument is the repository reference. It may be a local path, a GitHub URL, or an `owner/repo` shorthand. Any remaining text is optional scope, exclusions, threat-model notes, or special instructions.

## Operating rules

- Keep the audited repository read-only. Do not create, edit, delete, format, commit, branch, or write files inside it.
- Do not perform externally visible actions other than read-only cloning/fetching when needed to obtain the repository.
- Use Swival workers by security or domain bucket, not one worker per package or directory.
- Invoke workers through Pi's `swival-subagent` tool with the `audit-worker` agent. Each Swival task must start with `/audit`, followed by the focused bucket prompt. Do not use `self-review-worker`; this is a read-only audit, not implementation work. Do not invoke the `swival` CLI directly unless the user explicitly approves a fallback.
- Report only concrete, evidence-backed findings. Do not include speculative hardening ideas, style issues, unreachable issues, or issues already prevented by existing checks.
- Preserve all worker prompts, worker reports, exact commands or tool invocations, and the final report under `/tmp` unless the user specifies another output directory.
- For any file larger than ~4 KB, prefer a `bash` heredoc (`cat > path <<'EOF' ... EOF`) over the `write` tool. The `write` tool truncates or drops content silently when the body is large; heredocs round-trip the bytes faithfully and surface errors at the shell.

## Phase 1: Resolve and inspect the repository

1. Resolve the repository reference.
   - Local path: use that path after confirming it is a Git repository or a readable source tree.
   - GitHub URL or `owner/repo`: clone or materialize a read-only local copy under `/tmp/swival-audit-<repo-slug>/repo` unless the repo is already available locally.
   - Local file reference: identify whether it points to a repository, an archive, or a subdirectory. If it is not enough to audit the intended project, ask for the repository root.
2. Capture the resolved path, current branch or checked-out ref, commit SHA when available, and initial `git status --short` when the target is a Git repo.
3. Inspect the repository before launching workers. Use read-only commands such as `ls`, `find`, `rg`, `head`, `tail`, `wc`, and `git` read operations as appropriate.
4. Identify languages, frameworks, entry points, privileged operations, external interfaces, auth/authz paths, persistence layers, network boundaries, config formats, generated/vendor/test directories, and likely production code.

## Phase 2: Ask follow-up questions before starting Swival

Ask the user concise follow-up questions if any answer materially changes the audit plan. Do not start Swival workers until those questions are answered or the user tells you to proceed with assumptions.

Ask about scope when any of these are unclear:

- The repository is large enough that a full audit would be noisy or expensive.
- Production code cannot be distinguished from examples, tests, generated code, vendored code, or tools.
- Multiple products, services, packages, or deployment modes exist and the target is ambiguous.
- Exploitability depends on deployment assumptions, enabled features, or environment-specific config.
- The user supplied a subdirectory, archive, file, branch, PR, or tag rather than a clear repository root.
- The user wants a specific class of audit, such as security only, correctness only, crypto, auth, config, operational tools, or external integrations.

If there are no material questions, state the assumptions you will use and proceed.

## Phase 3: Build the worker plan

Create one Swival worker per security or domain bucket. Choose buckets from the inspected architecture. Good bucket boundaries include:

- Internet-facing request handling and input parsing
- Auth, identity, session, token, and authorization flows
- Data plane, persistence, queues, caches, and state transitions
- Cryptography, key handling, certificate handling, and signing paths
- RPC, transport security, service-to-service auth, and middleware
- External integrations, webhooks, SaaS clients, and credential handling
- Background jobs, schedulers, pipelines, and publication flows
- CLI, admin, migration, deployment, and operational tools
- Shared libraries that enforce cross-cutting invariants

Avoid buckets that are simply package lists unless the package boundary is also a security boundary. Exclude generated code, vendored dependencies, tests, mocks, tools, examples, and linters unless they expose production risk.

For each bucket, write a focused worker prompt that includes:

- Repository path and resolved commit/ref
- In-scope files, directories, and production entry points
- Out-of-scope areas
- Threat model and trust boundaries for that bucket
- Read-only constraint
- Required finding format
- Instruction to discard false positives and report only concrete findings

## Phase 4: Run Swival workers

Run the workers in parallel when their scopes do not share mutable state. Keep each worker read-only.

Use Pi's `swival-subagent` tool for each worker with `agent: "audit-worker"`. Do not use `self-review-worker`. Do not hardcode model names; let Swival configuration choose the model.

The `task` passed to `swival-subagent` must begin with `/audit`, then include the focused bucket prompt. Store the exact tool invocation under `/tmp` before or immediately after running it.

The `audit-worker` runs under an AgentFS sandbox that restricts reads to the worker's `cwd`. Files under `/tmp/swival-audit-<repo>/prompts/` (or any path outside the audited repo) are not visible to the worker. Embed the rendered bucket prompt directly in the `task` string — do not pass a `/tmp` file path and expect the worker to read it. If you need to keep an audit trail of the prompt, write it to disk yourself before dispatch and inline its contents into the `task` field.

Example single-worker invocation (rendered prompt embedded inline):

```json
{
  "agent": "audit-worker",
  "task": "/audit Audit the <bucket-name> bucket.\n\n<full focused bucket prompt body, embedded inline>",
  "cwd": "<resolved-repo-path>"
}
```

Example parallel invocation shape (each task carries its own embedded prompt):

```json
{
  "tasks": [
    {
      "agent": "audit-worker",
      "task": "/audit Audit the <first-bucket> bucket.\n\n<full first-bucket prompt body, embedded inline>"
    },
    {
      "agent": "audit-worker",
      "task": "/audit Audit the <second-bucket> bucket.\n\n<full second-bucket prompt body, embedded inline>"
    }
  ],
  "cwd": "<resolved-repo-path>"
}
```

Do not invoke the `swival` CLI directly unless the user explicitly approves a fallback. If a fallback is approved, use Swival's sandbox, restrict file access to the repository, allow only safe read/search/list commands, and keep all Swival artifacts outside the audited repository.

## Worker output contract

Each worker must use this format.

If there are no concrete findings:

`No concrete findings.`

For each finding:

### <Severity>: <short title>

- Severity: Critical | High | Medium | Low
- Confidence: High | Medium | Low
- Location: `<file path>:<line or function>`
- Failure mode or exploit scenario: <specific production scenario>
- Why existing checks do not prevent it: <specific missing or insufficient check>
- Recommended fix: <actionable code or design change>
- Validation performed: <files/functions inspected, searches run, and why the evidence supports the finding>

Also include:

- False-positive notes: suspected issues investigated but not reported because code already prevents them.
- Open questions: only questions that materially affect exploitability or severity.
- Coverage notes: what parts of the bucket were reviewed and what was not reviewed.

## Phase 5: Consolidate the final report

After all workers finish, dispatch the `security-consolidator` agent against the workspace directory that contains `reports/`. Do not synthesize the report yourself — the orchestrator has too much extra context and synthesis drifts.

Use the same dispatch overrides used for `audit-worker` so the consolidation runs at the same model tier and reasoning effort:

```json
{
  "agent": "security-consolidator",
  "cwd": "<workspace dir containing reports/>",
  "task": "Read every file under reports/. For each finding, dedupe across buckets and produce a consolidated report matching the contract.",
  "output": "<workspace>/consolidated-findings.md",
  "profileOverride": "frontier",
  "reasoningEffortOverride": "high",
  "temperatureOverride": 0.2,
  "maxReviewRoundsOverride": 2,
  "seedOverride": <int>
}
```

The consolidator's reviewer enforces the output contract (top-level structure, finding ordering, originating bucket, verbatim worker prose, no invented findings, no severity adjustments). See `agents/security-consolidator.md` for the criteria the reviewer applies.

After the consolidator returns, the orchestrator's remaining job is verification, not synthesis:

1. Read `consolidated-findings.md` and confirm it covers every bucket the workers reported on.
2. Verify the audited repository status matches the initial status when it is a Git repo.
3. Append the exact `swival-subagent` invocations used (recon, per-bucket fan-out, consolidator) to the artifact directory so the audit trail is reproducible.
4. Hash the artifacts (`shasum -a 256` over `recon.json`, `reports/*`, `consolidated-findings.md`) into `SHA256SUMS.txt` for downstream auditors.

Final report format — `consolidated-findings.md`, produced by the consolidator agent, contains:

- Repository reference, resolved path, branch/ref, and commit SHA when available
- Scope and assumptions
- Worker buckets
- Prioritized findings
- Buckets with no findings
- Open questions and human review areas
- Exact commands or tool invocations used
- Artifact locations
- Read-only verification result
