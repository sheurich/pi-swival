---
description: Run one native Swival audit on an isolated committed snapshot of Pi's repository
argument-hint: "[relative paths or globs]"
---

Audit the configured repository with these requested relative scopes: $ARGUMENTS

Read the `auditing-with-swival` skill. Resolve scope and routing with the operator before launch. Do not clone a different repository, change Pi's cwd, or pass a caller-supplied host path. Start a separate Pi session from the intended Git root if the current cwd is wrong.

## Routing

Follow the operator's provider and data boundaries. Verify profiles with `swival --list-profiles` before dispatch:

- For approved personal content, select `chatgpt-daybreak-blue` with `xhigh` when configured.
- For other approved routes, use `frontier` with `high` unless the operator selects another route.
- Halt if the selected profile is missing. Do not silently fall back. Keep model IDs in Swival configuration.

Requested effort is not guaranteed for every native phase. Swival 1.0.46 omits effort on auxiliary calls. A prior prompt-only probe does not prove native execution or per-phase effort.

## Launch

Translate only confirmed relative path/glob tokens into the `audit.paths` array. Do not interpolate arguments into a shell command or send them as executable slash-script text. Ask about unsupported prose, exclusions, or threat-model requirements before proceeding.

Require Swival 1.0.46 on Python 3.13+, Linux with AgentFS 0.6.4, and nono. Darwin/macOS with AgentFS 0.6.4 is blocked: writable temporary roots expose source files and Git metadata. All other unverified platform/version combinations fail closed. Require a passing real native-layout isolation canary on Linux before use; offline transport tests do not prove OS isolation. There is no sandbox fallback.

Stop on protected encryption/filtering requirements or any unknown isolation requirement. Do not disable controls, install prerequisites, or use unrestricted network to make launch succeed.

Use exactly one structured invocation, with verified route placeholders:

```json
{
  "audit": {
    "paths": ["<relative-path-or-glob>"],
    "all": true,
    "workers": 4,
    "patchMaxTurns": 50
  },
  "profileOverride": "<audit-profile>",
  "reasoningEffortOverride": "<audit-effort>",
  "timeoutMs": 900000
}
```

Do not add `agent`, `task`, `cwd`, reviewer/self-review options, permission overrides, or arbitrary arguments. Omit `paths` for the full auditable committed scope. Native worker count does not enable autonomous subagents.

Native `async` requires the originating Pi process to stay connected. Pi disconnect cancels the native audit. Keep Pi connected until terminal evidence persists.

## Completion

The source checkout and Git metadata must remain unchanged. Native audit can write only to its isolated snapshot and generated evidence. It excludes staged, unstaged, and untracked content. It may create internal worktrees and patch proposals; it has no no-patch mode.

Report the artifact directory, source commit/tree, selected scope, verified route, requested effort, native coverage, findings, and incomplete phases. An ordinary answer or exit zero is not native completion evidence. Empty scope, missing state, truncation, and partial artifacts are failures, not clean audits.

Preserve reports and patches. Verified shutdown precedes bounded evidence export and temporary-resource deletion. Preservation failure retains the remaining snapshot for diagnosis; unverified shutdown leaves mutable sources untouched. The wrapper writes a `spawn-error.txt` failure fallback if completion-marker persistence fails. Without live ownership or valid terminal evidence, disk-only native state is unknown. Report the artifact path and uncertainty; never signal or probe a PID recovered from disk.

The restricted verifier cannot execute project commands or PoCs; label its output as native verifier judgment, not reproduced exploit proof. Compare source status, contents, and Git refs with their initial values. Do not apply patches or start remediation without separate operator approval.
