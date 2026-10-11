---
name: auditing-with-swival
description: Run one native Swival security audit on an isolated committed snapshot. Use for repository audits, native audit evidence, findings, and patch proposals through swival-subagent.
---

# Auditing with Swival

Use `swival-subagent` with an `audit` object. The extension invokes the released `Session.ask(..., parse_commands=True)` API with exactly one native `/audit`. Do not send slash commands or bucket prose through `task`.

Generic delegation adds one fixed plain-text heading and never interprets slash/bang scripts, even with ambient `oneshot_commands=true`. Native execution uses the explicit `audit` API. This prevents unintended command dispatch, not model prompt injection.

## Preconditions

- Start Pi from the target Git repository root. The native target comes from Pi's cwd, not a caller-supplied host path.
- Require Swival 1.0.46, LiteLLM 1.103.3, Python 3.13+, Linux on Debian ARM64 with util-linux 2.41.5-0+deb13u1, bubblewrap 0.12.0-1~deb13u1, pidfd support, and the reviewed nono 0.79.0 ARM64 GNU artifact identity. Native mode requires a safe local `jedisct1/swival` pack in `HOME/.config`; `XDG_CONFIG_HOME` must be absent or resolve to that same store. Other selections, releases, and unverified platform/version combinations fail closed.
- Darwin/macOS native audits are unsupported. Ordinary delegation keeps AgentFS. There is no sandbox fallback.
- Require a propagation-free final namespace. Native execution rejects shared/slave or unknown mount relationships before Session/provider activity. A privileged host can still modify files or namespaces directly.
- Require a passing real native-layout isolation canary on Linux before use. Offline transport tests do not prove OS isolation.
- Follow the operator's provider and data boundaries. A configured profile does not authorize sending repository contents to its provider.
- Daybreak requires prior human ChatGPT login and account authorization for the exact model. Direct selection does not grant access, choose another account, or require a named profile.
- For configured profile routes, verify the selected profile, provider, model, and supported effort with `swival --list-profiles`. Halt when a required profile is absent. Do not silently fall back.
- Native mode rejects required secret encryption or outbound request filtering. Upstream auxiliary calls and traces omit those controls. Never turn them off to make an audit run.

For authorized Daybreak use, select provider `chatgpt`, model `gpt-daybreak-blue-latest`, and effort `xhigh` with dispatch overrides. For other approved routes, use the configured `frontier` profile with `high` unless the operator chooses another route. Preserve provider and data boundaries. Direct overrides apply only to that call and do not change stored configuration, host defaults, or ordinary delegation.

Swival accepts effort through `xhigh`, not Pi's `max`. Requested effort is not guaranteed for every native phase: upstream auxiliary `call_llm_text` requests omit it. Report the configured route and requested effort, not uniform per-phase effort.

## Native routing

The first preflight binds the selected profile, effective client provider/model/endpoint, supported cloud selectors, and safe requested execution options. The second preflight and execution must match it. Drift fails before Session construction. A native-only guard checks primary, auxiliary, and retry transports, blocks model-list discovery/replacement and Hugging Face text-generation fallback, and rejects cached alternate models. A caught route failure still fails the run. Ordinary delegation is unchanged.

| Provider | Supported destination selection |
| --- | --- |
| `lmstudio` | Explicit model; configured HTTP base or released loopback default. |
| `generic` | Explicit model and HTTP base, with released `/vN` normalization. |
| `openrouter` | Explicit model; configured base, `OPENROUTER_API_BASE`, or released default. |
| `chatgpt` | Released GPT Responses routing, including profile/model prefixes. Bind `CHATGPT_API_BASE`, then `OPENAI_CHATGPT_API_BASE`, then the released Codex endpoint. Upstream ignores the configured base; native mode accepts it only when it matches that effective selection. |
| `huggingface` | `org/model`, with optional `huggingface/` prefix; configured base, `HF_API_BASE`, `HUGGINGFACE_API_BASE`, or released router endpoint. Dynamic provider/model mapping and the released non-chat text-generation fallback are unsupported. |
| `bedrock` | Explicit region in `base_url`; regular runtime endpoint from that region or `AWS_BEDROCK_RUNTIME_ENDPOINT`. Bind configured/ambient account-profile selectors. Region discovery, isolated-region partitions, and alternate Mantle/agent/Claude Platform/OpenAI endpoint routes are unsupported. |
| `vertexai` | Explicit project/location and a bare model selected by the released `GEMINI` handler. Legacy, partner, model-garden, agent-engine, and other dispatch modes are unsupported. Use a configured base or the released location-derived endpoint; without a configured base, reject `VERTEXAI_API_BASE` and `litellm.api_base` overrides. Reject location replacement. |

Endpoints must be representable HTTP URLs without userinfo, queries, fragments, encoded/opaque components, or recognized credential content. Nonempty routing-affecting `extra_body`, executable providers, and `USE_LITELLM_PROXY` are unsupported. Profile/model/cloud selectors use bounded token grammars; unrepresentable selectors fail with value-free diagnostics. Native mode does not discover destination selectors from credential or configuration stores. Vertex uses the released selector before Session and on each call. Its first metadata import uses production mode and the bundled model-cost map, with no dotenv or remote fetch. It caches the selector under a lock, then restores the prior environment flags, including absent values and import failures. Imported modules remain initialized in the private native process; audit threads do not change these flags. Swival's pre-existing package import may set the offline-map flag when it was absent.

The binding records typed constructor options, including context/output limits, turns, retries, timeout, sampling, thinking/cache settings, and requested effort. It does not assert that every phase forwards them. Credentials and custom `user_agent` metadata stay runtime-only and outside the binding. Credential-source metadata describes configuration or runtime lookup, not credential values, store contents, owner, billing provenance, or provider authorization. Remote server routing is not an attestation of the server's internal model selection. Do not put secrets in model, profile, endpoint, or cloud-selector fields. Token validation cannot detect every secret deliberately placed in a routing identifier.

## Dispatch

Use this exact route for an authorized Daybreak audit. It does not require a named profile and must not fall back:

```json
{
  "audit": {
    "paths": ["src/**/*.py"],
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

For another approved route, replace the three direct route overrides with its verified `profileOverride` and `reasoningEffortOverride`. Do not infer provider access from profile presence or replace a rejected route.

- `paths`: up to 64 relative committed path/glob tokens. Omit for the repository's auditable scope. Paths with spaces, controls, shell syntax, absolute paths, or traversal are unsupported.
- `all`: deep-review every selected file; otherwise native triage selects deep-review candidates.
- `workers`: 1–8 native pipeline workers, not autonomous Swival subagents.
- `patchMaxTurns`: 1–100 turns per patch loop. Native audit has no no-patch option.
- `timeoutMs`: bounded runtime, 15 minutes by default and at most the operator-configured ceiling (30 minutes by default).
- `async`: optional; returns a `runId` for `status`, `resume`, and `interrupt` while the originating Pi process stays connected. Pi disconnect cancels the native audit.

Do not combine native audit with `task`, `agent`, `cwd`, `tasks`, `chain`, reviewer/self-review settings, output routing, extra arguments, or security overrides. Native mode permits only the structured audit options, existing model/profile/sampling overrides, and its runtime/output budgets. Invalid combinations fail before launch.

## Source and permissions

The extension builds an independent repository under the configured artifact root, outside the source checkout and its Git metadata. It imports committed objects with hardened Git plumbing. It does not execute source hooks or filters, share object stores, retain remotes, or update source refs.

All staged, unstaged, and untracked changes are excluded. The manifest records source commit/tree and snapshot commit. The snapshot commit is synthetic; it preserves the committed tree, not commit history. Existing source status must remain unchanged, even when it was dirty before the audit. A tracked `swival.toml` stays in committed scope and released phase inputs. Its snapshot working copy is inert so project `[audit]` runtime settings do not execute; original source bytes and Git objects remain unchanged.

Native audit may edit its snapshot, create internal Git worktrees, and generate reports and patches. It authenticates nono bytes before an update-disabled fixed version query and requires the exact reviewed installed bytes for both the `jedisct1/swival@0.1.2` manifest and full profile policy. It validates the bounded local files without listing or pulling, binds both identities in runtime evidence, and revalidates them before probe, launch, and Session construction. Because the reviewed policy extends `default`, every host and final-namespace checkpoint also rejects sibling, user `.jsonc`/`.json`, and installed-pack `install_as` or alias overrides. Only the authenticated executable's embedded `default` is supported; ambiguous, symlinked, malformed, or oversized resolver inputs fail closed. The pinned canonical `unshare --user --map-current-user --mount --propagation private --` prefix creates a same-ID private user/mount namespace before bubblewrap. It uses no `--keep-caps`, `--fork`, persistent namespace, setuid fallback, host privilege, or host propagation change. Bubblewrap recursively mounts the original root/submounts read-only, uses private temp/dev/shared-memory/proc mounts and PID/IPC namespaces, drops capabilities, and disables nested user namespaces. Canonical source/Git/runtime/config paths remain visible read-only; rebindings cannot replace private mount roots. Only snapshot and evidence receive persistent write grants. The final payload has zero effective, permitted, inheritable, ambient, and bounding capability sets. The native Session uses `sandbox="builtin"` as an application guard inside bubblewrap, with `files="some"`, `commands="none"`, and `network="provider-only"`. Instructions, skills, memory, history, lifecycle hooks, MCP, A2A, and autonomous subagents remain disabled.

Verifier and patch loops inherit these restricted modes. They cannot execute project commands or PoCs. Treat verification as native verifier judgment, not independent exploit reproduction. Patch generation is optional evidence, not permission to apply a fix.

Unsupported tracked links, gitlinks, unsafe names, secret-shaped paths, recognized credential content, oversized snapshots, and protected or unknown configurations fail closed. Snapshot limits are 4096 entries, 8 MiB per object, and 64 MiB total. Do not treat credential scanning as a guarantee that a repository has no secrets.

ChatGPT requires prior human login and a valid token. Native execution rejects missing, malformed, or expired auth before automatic login, refresh, sensitive prompts, or auth writes. No writable-home exception is added.

Project-supplied routing and executable provider routes are unsupported. Explicit AgentFS backend/session, nono, strict-read, lifecycle, and protection requirements are not silently replaced. If native mode cannot preserve a requirement, stop; do not weaken permissions, broaden egress, or substitute a prompt audit.

## Evidence and completion

The tool returns the artifact directory. It preserves:

```text
<artifact-dir>/
├── manifest.json
├── request.json
├── run-meta.json
├── completed.json (or spawn-error.txt failure fallback)
├── stdout.txt
├── stderr.txt
└── evidence/
    ├── native-result.json
    ├── native-state/<audit-id>/state.json
    └── audit-findings/<number>-<title>.md and .patch
```

Both synchronous and asynchronous execution use the same wrapper and shared finalizer. Live ownership precedes external execution. Timeout, interruption, or Pi disconnect cancels the native audit. The trusted supervisor pins namespace init through a live pidfd before releasing bubblewrap’s private startup block. It closes control descriptors before untrusted execution. The finalizer requires namespace-init death and process-group absence, drains bounded logs, and exports regular-file partial evidence before removing owned temporary resources. Every retained evidence subtree receives recursive type and resource checks, including unmatched files in export namespaces. Limits are 4096 retained entries, 8 MiB per regular file, and 64 MiB combined retained bytes; source traversal has a separate 4096-entry limit. Byte-identical retry destinations count once; conflicting destinations fail. Combined subprocess output is capped at 2 MiB.

Preservation failure retains the remaining snapshot for diagnosis and fails the run. Unverified shutdown prevents copying or deleting mutable sources. Cleanup and persistence failures remain separate diagnostics. If completion-marker persistence fails, the wrapper atomically writes a failure fallback to `spawn-error.txt`, independently of Pi's lifetime. A failure of both terminal writes leaves disk-only recovery unknown.

Exit zero or a plausible answer alone does not prove completion. The extension checks the route binding in request/manifest/result, native state, snapshot/scope identity, reviewed-file coverage, deep-review coverage, verification state, and report/patch pairs. Empty scope, partial phases, truncated coverage, missing state, and incomplete artifacts are not successful audits. Zero findings with complete state means the native pipeline completed; it does not establish that the code is secure.

Use `status` or `resume` with only the returned `id` and `action`. Valid terminal results survive extension reloads. Legacy group-only completion records do not prove namespace death and remain unpruned. Without live ownership or valid terminal evidence, disk-only native state is unknown; inspect the returned artifact directory. The extension never signals or probes a PID recovered from disk.

Compare source content, Git status, and refs with their initial values. Inspect every patch manually. Never apply audit patches automatically.

## Validation and live probes

`npm test` uses local transport stubs and released Swival entry points with stubbed LLM responses and denied sockets. It provides offline native execution and lifecycle evidence, not live provider proof or per-phase effort attestation. A prior prompt-only probe does not prove native execution.

A live probe requires explicit operator approval and all sandbox prerequisites. Use only a disposable synthetic Git repository, an explicit approved profile, and generated artifacts outside that repository. Start a separate Pi session from its root, run the dispatch above against one synthetic file, then inspect native state, artifacts, source status, and refs. Bound its timeout and worker/patch budgets. If nono or another prerequisite is missing, mark the live probe blocked; do not install tools or fall back to unrestricted network.

For prompt-only review, use existing review skills or generic plain-language delegation. Keep it separate from native audit evidence. For remediation, dispatch `self-review-worker` only after the operator approves the findings and scope.
