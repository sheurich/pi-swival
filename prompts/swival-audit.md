---
description: Run one native Swival audit on an isolated committed snapshot of Pi's repository
argument-hint: "[relative paths or globs]"
---

Audit the configured repository with these requested relative scopes: $ARGUMENTS

Read the `auditing-with-swival` skill. Resolve scope and routing with the operator before launch. Do not clone a different repository, change Pi's cwd, or pass a caller-supplied host path. Start a separate Pi session from the intended Git root if the current cwd is wrong.

## Routing

Follow the operator's provider and data boundaries.

- For authorized Daybreak use, select provider `chatgpt`, model `gpt-daybreak-blue-latest`, and effort `xhigh` directly. This does not require a named profile.
- Daybreak requires prior human ChatGPT login and account authorization for the exact model. Selection does not grant access or choose another account.
- For other approved routes, use the configured `frontier` profile with `high` unless the operator selects another route. Verify configured profiles with `swival --list-profiles`.
- Halt if the selected route is unavailable or rejected. Do not silently fall back. Direct overrides do not change stored configuration, host defaults, or ordinary delegation.

Requested effort is not guaranteed for every native phase. Swival 1.0.46 omits effort on auxiliary calls. A prior prompt-only probe does not prove native execution or per-phase effort.

## Launch

Translate only confirmed relative path/glob tokens into the `audit.paths` array. Do not interpolate arguments into a shell command or send them as executable slash-script text. Ask about unsupported prose, exclusions, or threat-model requirements before proceeding.

Require Swival 1.0.46, LiteLLM 1.103.3, Python 3.13+, Linux on Debian ARM64 with util-linux 2.41.5-0+deb13u1, bubblewrap 0.12.0-1~deb13u1, pidfd support, and the reviewed nono 0.79.0 ARM64 GNU artifact identity. Native startup uses the pinned canonical `unshare --user --map-current-user --mount --propagation private --` prefix before bubblewrap. Darwin/macOS native audits are unsupported. Ordinary delegation keeps AgentFS. Unverified prerequisites fail closed. Require a passing real native-layout isolation canary on Linux before use; offline transport tests do not prove OS isolation. There is no sandbox fallback.

Stop on protected encryption/filtering requirements or any unknown isolation requirement. Do not disable controls, install prerequisites, or use unrestricted network to make launch succeed.

For an authorized Daybreak audit, use exactly one structured invocation with the exact supported route:

```json
{
  "audit": {
    "paths": ["<relative-path-or-glob>"],
    "all": true,
    "workers": 4,
    "patchMaxTurns": 50
  },
  "providerOverride": "chatgpt",
  "modelOverride": "gpt-daybreak-blue-latest",
  "reasoningEffortOverride": "xhigh",
  "timeoutMs": 900000
}
```

For another approved route, replace the three direct route overrides with its verified `profileOverride` and `reasoningEffortOverride`.

Do not add `agent`, `task`, `cwd`, reviewer/self-review options, permission overrides, or arbitrary arguments. Omit `paths` for the full auditable committed scope. Native worker count does not enable autonomous subagents.

Native `async` requires the originating Pi process to stay connected. Pi disconnect cancels the native audit. Keep Pi connected until terminal evidence persists.

## Completion

The source checkout and Git metadata must remain unchanged. Native audit can write only to its isolated snapshot and generated evidence. It excludes staged, unstaged, and untracked content. It may create internal worktrees and patch proposals; it has no no-patch mode.

Report the artifact directory, source commit/tree, selected scope, verified route, requested effort, native coverage, findings, and incomplete phases. An ordinary answer or exit zero is not native completion evidence. Empty scope, missing state, truncation, and partial artifacts are failures, not clean audits.

Preserve reports and patches. Verified shutdown precedes bounded evidence export and temporary-resource deletion. Preservation failure retains the remaining snapshot for diagnosis; unverified shutdown leaves mutable sources untouched. The wrapper writes a `spawn-error.txt` failure fallback if completion-marker persistence fails. Without live ownership or valid terminal evidence, disk-only native state is unknown. Report the artifact path and uncertainty; never signal or probe a PID recovered from disk.

The restricted verifier cannot execute project commands or PoCs; label its output as native verifier judgment, not reproduced exploit proof. Compare source status, contents, and Git refs with their initial values. Do not apply patches or start remediation without separate operator approval.
