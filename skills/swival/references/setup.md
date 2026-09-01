# Swival Setup

Install Swival, point it at a provider, and verify connectivity.

Tracked against Swival 1.0.40.

Bedrock and Vertex are reached through Swival's native `bedrock` and `vertexai` providers. No proxy process or second routing configuration is required.

## Prerequisites

Swival is installed via `uv tool`. If `uv` is not available, substitute `pipx` or `pip install --user` (or `pip3`) in the commands below.

```bash
command -v uv >/dev/null 2>&1 || command -v pipx >/dev/null 2>&1 || command -v pip >/dev/null 2>&1 || command -v pip3 >/dev/null 2>&1 || {
  echo "No Python package manager found. Install uv: https://docs.astral.sh/uv/"
  exit 1
}
```

## Install Swival

```bash
uv tool install swival
# or: pipx install swival
```

## Configure

On first run in an interactive terminal with no existing config, Swival offers an onboarding flow that writes `~/.config/swival/config.toml`. Run `swival --init-config` to generate a template non-interactively; add `--project` with `--base-dir <dir>` to write `swival.toml` under a project root instead.

Project config merges over global rather than replacing it, so a project file cannot unset a global key.

### Bedrock

```toml
provider = "bedrock"
model = "global.anthropic.claude-sonnet-5"
# aws_profile = "prod"    # optional; overrides AWS_PROFILE
```

Three things to get right:

- Do not set `api_key`. Bedrock rejects it outright, auth comes from the AWS credential chain, and a global `api_key` still applies when a profile selects bedrock — so one stray global key breaks every Bedrock profile.
- `base_url` means the AWS region for this provider. Leave it unset to take the region from `~/.aws/config`. A global value also leaks into `vertexai` profiles, which do not accept it.
- An inference profile that reports `ACTIVE` is not necessarily invocable. The caller's IAM role may still get `AccessDenied`. Test by invoking.

### Vertex AI

```toml
provider = "vertexai"          # alias for "geap"
model = "gemini-3.7-flash"
project = "my-gcp-project"     # key is "project", not "gcp_project"
location = "global"
```

Needs application default credentials (`gcloud auth application-default login`). `project` and `location` are both required; Vertex rejects `api_key`. Pass the bare model name — Swival adds the `vertex_ai/` prefix itself. Gemini's graded reasoning effort tops out at `high`; Swival's enum also accepts `xhigh`, but Vertex does not honor it.

### ChatGPT subscription

```toml
provider = "chatgpt"
model = "gpt-5.6-terra"
```

### Local models

A local OpenAI-compatible server is still reached with the `generic` provider, which needs both `model` and `base_url`:

```toml
[profiles.local]
provider = "generic"
model = "qwen3-30b"
base_url = "http://127.0.0.1:8000/v1"
api_key = "unused"
```

A per-profile `api_key` is fine here because the profile also sets `provider = "generic"`. `lmstudio` and `llamacpp` discover the loaded model themselves and need no key.

### File-access defaults

By default, Swival restricts file access to the base directory (auto-detected project root, or the current directory). Command execution defaults to unrestricted (`--commands all`). Add `yolo = true` only if you also want to lift the file-access restriction; otherwise leave it out and scope access with `--add-dir` / `--add-dir-ro`.

## Verify

```bash
swival --list-profiles
swival --max-turns 2 --no-skills --no-memory --no-history "Reply with exactly: OK"
swival --profile <name> --max-turns 2 --no-skills "Reply with exactly: OK"
```

## AWS SSO lifecycle hook

With native Bedrock, an expiring SSO session is the most likely cause of a failed run. Swival's `lifecycle_command`, `lifecycle_fail_closed`, and `lifecycle_timeout` keys let a hook verify or refresh credentials before the agent starts.

```toml
lifecycle_command = "~/.config/swival/scripts/aws-sso-lifecycle.sh"
lifecycle_fail_closed = true
lifecycle_timeout = 90
```

The hook receives an action (`startup` or `exit`) and Swival's base directory:

```sh
#!/bin/sh
set -eu

profile="${PROFILE:-bedrock}"
action="${1:-}"
base_dir="${2:-}"

if [ -z "$action" ] || [ -z "$base_dir" ]; then
  echo "usage: $0 startup|exit <base-dir>" >&2
  exit 1
fi

case "$action" in
  startup)
    aws sts get-caller-identity --profile "$profile" >/dev/null 2>&1 || \
      aws sso login --profile "$profile"
    ;;
  exit)
    ;;
  *)
    echo "unknown lifecycle action: $action" >&2
    exit 1
    ;;
esac
```

Keep the hook fast: check existing credentials first and call `aws sso login` only when the cached session fails.

The hook does not cover delegated runs. `swival-subagent` passes `--no-lifecycle` unless an agent sets `noLifecycle: false`, so refresh the session before dispatching rather than relying on the hook.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `--api-key is not supported for bedrock` | A global `api_key` applies to a bedrock profile | Remove the global `api_key` |
| `AccessDeniedException` on a model | IAM role lacks invoke on that inference profile, even when it reports `ACTIVE` | Request the permission, or use a model that invokes |
| "on-demand throughput isn't supported" | Raw model ID instead of an inference profile | Use a profile ID such as `global.anthropic.claude-...` |
| `--gcp-project or GOOGLE_CLOUD_PROJECT is required` | Vertex profile missing `project` | Add `project`; the key is not `gcp_project` |
| `--api-key is not supported for geap` | `api_key` set globally or on a `vertexai` profile | Remove it; use application default credentials |
| Vertex 404 "model not found" | Wrong project, or API not enabled | Check `project` and enable the Vertex AI API |
| Expired AWS SSO mid-run | SSO session shorter than the run | Add the lifecycle hook above |
| `uv: command not found` | uv not installed | See https://docs.astral.sh/uv/ or use `pipx` |
