---
description: Run one source-only native Swival audit on Pi's committed repository
argument-hint: "[relative paths or globs]"
---

Audit the configured repository with these requested relative scopes: $ARGUMENTS

Read the `auditing-with-swival` skill. Confirm scope and the operator's provider and data boundaries. Start Pi from the intended Git root; do not clone another repository or pass a caller-supplied host path.

Require Swival 1.0.48, LiteLLM 1.105.3, Python 3.13+, AgentFS 0.6.4, and upstream's installed nono profile. The real bootstrap/export gate passed on macOS; Linux and live routes remain unverified. Support means a Swival-supported route satisfying native policies on this runtime. Dynamic model-list routes fail when upstream cannot prevent model replacement. Never broaden permissions.

Consult installation guidance before execution. With no specialist selected, use configured Swival defaults, including its active profile:

```json
{"audit":{"all":true}}
```

If installation policy selects a specialist, pass its existing configured profile:

```json
{"audit":{"all":true},"profileOverride":"security-specialist"}
```

The name is illustrative, not bundled or reserved. A missing or invalid selected specialist stops before launch. A terminal selected-route failure stops without fallback; never retry without the selected specialist. Do not infer specialization by vendor/model names or send source to probe access. Inherit effort unless an override is explicitly authorized.

Swival 1.0.48 can retry the same request on the same provider, model, and endpoint, including recognized policy errors. A later attempt can succeed. The adapter does not guarantee all-phase fail-fast or uniform retry-budget propagation. Never substitute a route or rewrite a refused request. Terminal failures and incomplete audits cannot attest completion.

For ChatGPT only, standard upstream ChatGPT authentication permits login, token refresh, and auth-state writes. Complete interactive login with upstream Swival outside Pi before an audit. Device-login challenges cancel without exposing their contents. Do not inspect or export auth-store contents. API-key/local routes receive no ChatGPT store or grant. Stop on required encryption, filtering, strict-read isolation, proxies, unknown policy, or incompatible routing.

Translate confirmed relative path/glob tokens into `audit.paths` on the selected call. `all` requires deep review throughout the selected committed scope. `workers` is 1–8; `patchMaxTurns` is 1–100. Use one structured call.

Native async is unsupported. Omit `paths` for the auditable committed scope. Do not add `task`, `agent`, `cwd`, output routing, reviewer options, permission overrides, or arbitrary arguments. Requested effort is not guaranteed for every auxiliary phase.

The original source and Git metadata must remain unchanged. The independent snapshot excludes staged, unstaged, and untracked content. The adapter launches upstream AgentFS directly, explicitly granting write access to the snapshot and, for ChatGPT only, a dedicated auth-store directory inside HOME. Upstream also permits temporary, service, and session paths; source and Git metadata overlapping those exceptions fail closed. The auth directory never enters Swival `--add-dir` or model-tool roots. The adapter collects bounded state, reports, and patch proposals after verified normal shutdown. It provides no host-read confidentiality or provider-process egress guarantee.

Timeout, cancellation, and normal session shutdown stop the live owned group. After a Pi crash or SIGKILL, Swival may remain running. There is no artifact export or claimed completion afterward. Retain crash resources. Never resume native work from disk, signal recovered PIDs, or install a guardian.

Report the artifact directory, source commit/tree, scope, route, requested effort, coverage, findings, and incomplete phases. Exit zero or a plausible answer is insufficient. Require complete native state, coverage, verification lineage, report/patch pairs, and diagnostics without lost expansions. Missing, truncated, symlinked, oversized, or incomplete evidence cannot attest a clean audit.

The verifier cannot run project commands, Python, builds, tests, fetch tools, or PoCs. Label findings as source-only judgment, not executed exploit reproduction. Compare original source, Git status, and refs with their initial values. Review patches manually; do not apply them or start remediation without separate approval.
