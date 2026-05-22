# Swival Setup

Install Swival, optionally configure the litellm proxy, and
verify connectivity.

The litellm proxy is only needed when you route through
`provider = "generic"` — in practice, for Vertex AI and for
Bedrock cross-region inference profiles that the native `bedrock`
provider doesn't cover. Skip the proxy sections if you're using a
direct provider (`lmstudio`, `llamacpp`, `huggingface`,
`openrouter`, `chatgpt`, `google`, or `bedrock`).

## Prerequisites

Swival and litellm are installed via `uv tool`. If `uv` is not
available, substitute `pipx` or `pip install --user` (or `pip3`) in
the commands below.

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

## Install litellm proxy with provider extras

```bash
# Bedrock + Vertex
uv tool install 'litellm[proxy,bedrock,google]'

# Bedrock only
uv tool install 'litellm[proxy,bedrock]'
```

## Create litellm proxy config

Write `~/.config/litellm/config.yaml`. Each entry maps a short model
name to a provider-specific model string.

### Bedrock (AWS)

Bedrock requires cross-region inference profile IDs (`us.` prefix),
not raw model IDs. Raw model IDs return "on-demand throughput isn't
supported."

```yaml
model_list:
  - model_name: claude-opus-4-6
    litellm_params:
      model: bedrock/us.anthropic.claude-opus-4-6-v1
      aws_region_name: us-east-2

  - model_name: claude-sonnet-4-6
    litellm_params:
      model: bedrock/us.anthropic.claude-sonnet-4-6
      aws_region_name: us-east-2

  - model_name: claude-haiku-4-5
    litellm_params:
      model: bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0
      aws_region_name: us-east-2
```

Authentication uses the standard AWS credential chain
(`AWS_PROFILE`, `~/.aws/credentials`, instance roles).

### Vertex AI (Google Cloud)

Append under the existing `model_list:` key (or use as a standalone
config):

```yaml
model_list:
  - model_name: gemini-3.1-pro
    litellm_params:
      model: vertex_ai/gemini-3.1-pro-preview
      vertex_project: your-project-id
      vertex_location: us-east1
```

Authentication uses `gcloud auth application-default login`.

### Recommended settings

```yaml
litellm_settings:
  drop_params: true
  num_retries: 3
```

## Create Swival config

On first run in an interactive terminal with no existing config,
Swival offers an onboarding flow that writes
`~/.config/swival/config.toml` with a `[profiles.default]` block
matching the profile structure used elsewhere (since 1.0.13). Skip
it and write the config by hand if you need a specific shape.

Run `swival --init-config` to (re)generate a template non-interactively;
add `--project` with `--base-dir <dir>` to write `swival.toml` under
the project root instead of the global path.

### Via the litellm proxy (Vertex / cross-region Bedrock)

```toml
provider = "generic"
model = "claude-opus-4-6"          # default model name from proxy
base_url = "http://127.0.0.1:4000"
api_key = "sk-unused"              # proxy requires a key but ignores it
# yolo = true                      # opt-in: lift file-access restrictions (commands are already unrestricted by default)
```

The `generic` provider points Swival at the litellm proxy, which
translates to the real provider. Use this path for Vertex AI and
for Bedrock cross-region inference profiles.

### Direct Bedrock (no proxy)

Swival's native `bedrock` provider covers same-region inference
profiles that don't need litellm. Region goes in `--base-url` (or
as `base_url` in `config.toml`), and `--aws-profile` (or
`AWS_PROFILE`) selects credentials from `~/.aws/config`.

```toml
provider = "bedrock"
model = "us.anthropic.claude-opus-4-6-v1"
base_url = "us-east-2"
# aws_profile = "prod"             # optional; overrides AWS_PROFILE
```

```bash
swival --provider bedrock --base-url us-east-2 \
  --model us.anthropic.claude-opus-4-6-v1 \
  --aws-profile prod -q "Refactor this"
```

The native provider has limits (region encoded into `--base-url`,
model coverage narrower than litellm), so the proxy is still
preferred for multi-region setups or for anything Vertex.

### File-access defaults

By default, Swival restricts file access to the base directory
(auto-detected project root, or the current directory). Command
execution defaults to unrestricted (`--commands all`). Add
`yolo = true` only if you also want to lift the file-access
restriction; otherwise leave it commented out and scope access
with `--add-dir` / `--add-dir-ro` as needed.

## Install proxy manager

The script is at `scripts/swival-proxy` under the skill root.
From the repository root, copy it into your PATH:

```bash
mkdir -p ~/.local/bin
cp skills/swival/scripts/swival-proxy ~/.local/bin/swival-proxy
chmod +x ~/.local/bin/swival-proxy
```

If the skill is installed elsewhere, substitute the full path to
`scripts/swival-proxy` in the `cp` command.

The script checks that `litellm` is installed and that the config
file exists before starting the proxy.

## Verify

### Via litellm proxy

```bash
swival-proxy start
swival --model claude-haiku-4-5 -q "Say hello"
```

### Direct Bedrock (no proxy)

```bash
swival --provider bedrock --base-url us-east-2 \
  --model us.anthropic.claude-haiku-4-5-20251001-v1:0 \
  -q "Say hello"
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "on-demand throughput isn't supported" | Raw model ID instead of inference profile | Use `us.` prefix: `bedrock/us.anthropic.claude-...` |
| "Google Cloud SDK not found" | Missing Python package in litellm venv | `uv tool install 'litellm[proxy,google]'` |
| Connection refused on :4000 | Proxy not running | `swival-proxy start` |
| "unknown provider" | Provider not in Swival's enum | Use `generic` provider with litellm proxy |
| Vertex 404 "model not found" | Wrong project or API not enabled | Check `vertex_project` and enable Vertex AI API |
| `litellm: command not found` | litellm not installed | `uv tool install 'litellm[proxy,bedrock]'` |
| `uv: command not found` | uv not installed | See https://docs.astral.sh/uv/ or use `pipx` |
