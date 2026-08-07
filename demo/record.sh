#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: record.sh TAPE

Required environment:
  PI_SWIVAL_DEMO_PROVIDER          Pi provider used for the recording
  PI_SWIVAL_DEMO_MODEL             Pi model used for the recording
  PI_SWIVAL_DEMO_SWIVAL_PROVIDER   Swival provider used for the recording
  PI_SWIVAL_DEMO_SWIVAL_MODEL      Swival model used for the recording

Optional environment:
  PI_SWIVAL_DEMO_AUTH_PROVIDER         Pi auth.json key; defaults to the Pi provider
  PI_SWIVAL_DEMO_SWIVAL_AUTH_PROVIDER  Swival auth.json key; defaults to Pi's auth key
  PI_SWIVAL_DEMO_SWIVAL_BASE_URL       Explicit Swival provider endpoint
  PI_SWIVAL_DEMO_TMPDIR                 Neutral recording root; defaults to /tmp
  VHS                                   VHS executable; defaults to vhs
EOF
}

if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi

: "${PI_SWIVAL_DEMO_PROVIDER:?set PI_SWIVAL_DEMO_PROVIDER}"
: "${PI_SWIVAL_DEMO_MODEL:?set PI_SWIVAL_DEMO_MODEL}"
: "${PI_SWIVAL_DEMO_SWIVAL_PROVIDER:?set PI_SWIVAL_DEMO_SWIVAL_PROVIDER}"
: "${PI_SWIVAL_DEMO_SWIVAL_MODEL:?set PI_SWIVAL_DEMO_SWIVAL_MODEL}"

AUTH_PROVIDER="${PI_SWIVAL_DEMO_AUTH_PROVIDER:-$PI_SWIVAL_DEMO_PROVIDER}"
SWIVAL_AUTH_PROVIDER="${PI_SWIVAL_DEMO_SWIVAL_AUTH_PROVIDER:-$AUTH_PROVIDER}"
SWIVAL_BASE_URL="${PI_SWIVAL_DEMO_SWIVAL_BASE_URL:-}"
VHS_BIN="${VHS:-vhs}"
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
TAPE="$1"

if [[ ! -f "$TAPE" ]]; then
  echo "tape not found: $TAPE" >&2
  exit 2
fi

for command in git jq node npm pi python3 swival tar "$VHS_BIN"; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "required command not found: $command" >&2
    exit 1
  fi
done

if ! python3 -m pytest --version >/dev/null 2>&1; then
  echo "pytest is required but unavailable via python3 -m pytest; install pytest before recording" >&2
  exit 1
fi

INSTALLED_PI="$(pi --version 2>&1 | tail -n 1 | tr -d '\r')"
LATEST_PI="$(npm view @earendil-works/pi-coding-agent version)"
if [[ "$INSTALLED_PI" != "$LATEST_PI" ]]; then
  echo "Pi $INSTALLED_PI is installed; update to $LATEST_PI before recording" >&2
  exit 1
fi

REAL_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
AUTH_FILE="$REAL_AGENT_DIR/auth.json"

if ! jq -e --arg provider "$AUTH_PROVIDER" '.[$provider] != null' "$AUTH_FILE" >/dev/null; then
  echo "Pi auth entry not found for provider: $AUTH_PROVIDER" >&2
  exit 1
fi
if ! jq -e --arg provider "$SWIVAL_AUTH_PROVIDER" '.[$provider] != null' "$AUTH_FILE" >/dev/null; then
  echo "Swival auth entry not found for provider: $SWIVAL_AUTH_PROVIDER" >&2
  exit 1
fi

umask 077
TMP_BASE="${PI_SWIVAL_DEMO_TMPDIR:-/tmp}"
if [[ ! -d "$TMP_BASE" || ! -w "$TMP_BASE" ]]; then
  echo "recording root must be a writable directory: $TMP_BASE" >&2
  exit 1
fi
DEMO_REPO=""
DEMO_HOME=""
DEMO_RUNTIME=""
cleanup() {
  [[ -z "$DEMO_REPO" ]] || rm -rf "$DEMO_REPO"
  [[ -z "$DEMO_HOME" ]] || rm -rf "$DEMO_HOME"
  [[ -z "$DEMO_RUNTIME" ]] || rm -rf "$DEMO_RUNTIME"
}
trap cleanup EXIT
DEMO_REPO="$(mktemp -d "$TMP_BASE/pi-swival-recording-repo.XXXXXX")"
DEMO_HOME="$(mktemp -d "$TMP_BASE/pi-swival-recording-home.XXXXXX")"
DEMO_RUNTIME="$(mktemp -d "$TMP_BASE/pi-swival-recording-runtime.XXXXXX")"

mkdir -p "$DEMO_HOME/.pi/agent" "$DEMO_HOME/.config/swival" "$DEMO_RUNTIME/bin"
jq --arg provider "$AUTH_PROVIDER" '{($provider): .[$provider]}' \
  "$AUTH_FILE" > "$DEMO_HOME/.pi/agent/auth.json"
cat > "$DEMO_HOME/.pi/agent/settings.json" <<'JSON'
{
  "quietStartup": true,
  "enableInstallTelemetry": false,
  "theme": "dark"
}
JSON

{
  printf 'provider = '
  printf '%s' "$PI_SWIVAL_DEMO_SWIVAL_PROVIDER" | jq -Rs .
  printf 'model = '
  printf '%s' "$PI_SWIVAL_DEMO_SWIVAL_MODEL" | jq -Rs .
  if [[ -n "$SWIVAL_BASE_URL" ]]; then
    printf 'base_url = '
    printf '%s' "$SWIVAL_BASE_URL" | jq -Rs .
  fi
} > "$DEMO_HOME/.config/swival/config.toml"

SWIVAL_AUTH_TYPE="$(jq -er --arg provider "$SWIVAL_AUTH_PROVIDER" '.[$provider].type' "$AUTH_FILE")"
if [[ "$PI_SWIVAL_DEMO_SWIVAL_PROVIDER" == "chatgpt" ]]; then
  if [[ "$SWIVAL_AUTH_TYPE" != "oauth" ]]; then
    echo "chatgpt requires an OAuth Pi auth entry" >&2
    exit 1
  fi
  mkdir -p "$DEMO_HOME/.config/litellm/chatgpt"
  jq --arg provider "$SWIVAL_AUTH_PROVIDER" \
    '{
      access_token: .[$provider].access,
      refresh_token: .[$provider].refresh,
      account_id: .[$provider].accountId
    } | with_entries(select(.value != null))' \
    "$AUTH_FILE" > "$DEMO_HOME/.config/litellm/chatgpt/auth.json"
elif [[ "$SWIVAL_AUTH_TYPE" == "api_key" ]]; then
  printf 'api_key = ' >> "$DEMO_HOME/.config/swival/config.toml"
  jq -j --arg provider "$SWIVAL_AUTH_PROVIDER" '.[$provider].key' "$AUTH_FILE" \
    | jq -Rs . >> "$DEMO_HOME/.config/swival/config.toml"
else
  echo "Swival provider requires an API-key credential or chatgpt OAuth" >&2
  exit 1
fi

git -C "$ROOT" archive --format=tar HEAD | tar -xf - -C "$DEMO_REPO"

for command in node pi python3 swival; do
  ln -s "$(command -v "$command")" "$DEMO_RUNTIME/bin/$command"
done
for command in fd python pytest rg; do
  if path="$(command -v "$command" 2>/dev/null)"; then
    ln -s "$path" "$DEMO_RUNTIME/bin/$command"
  fi
done

cat > "$DEMO_RUNTIME/bin/pi-swival-demo" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail

BIN_DIR="$(cd "$(dirname "$0")" && pwd)"

case "${1:-}" in
  quick)
    SYSTEM_PROMPT='Call only the requested tool. After it returns, respond exactly: Fix reviewed and tests pass.'
    ;;
  reviewer)
    SYSTEM_PROMPT='Call only the requested tool. After it returns, respond exactly: Reviewer complete.'
    ;;
  *)
    echo "unknown demo mode: ${1:-}" >&2
    exit 2
    ;;
esac

exec env -i \
  HOME="$PI_SWIVAL_DEMO_HOME" \
  PATH="$BIN_DIR:/usr/bin:/bin:/usr/sbin:/sbin" \
  TERM="${TERM:-xterm-256color}" \
  COLORTERM="${COLORTERM:-truecolor}" \
  LANG="${LANG:-C.UTF-8}" \
  TMPDIR="$PI_SWIVAL_DEMO_TMPDIR" \
  PI_CODING_AGENT_DIR="$PI_SWIVAL_DEMO_HOME/.pi/agent" \
  PI_CODING_AGENT_SESSION_DIR="$PI_SWIVAL_DEMO_HOME/sessions" \
  PI_OFFLINE=1 \
  PI_TELEMETRY=0 \
  pi --no-session --thinking off --offline \
    --provider "$PI_SWIVAL_DEMO_PROVIDER" \
    --model "$PI_SWIVAL_DEMO_MODEL" \
    --system-prompt "$SYSTEM_PROMPT" \
    --no-extensions -e "$PI_SWIVAL_DEMO_REPO/extensions/index.ts" \
    --no-skills --no-prompt-templates --no-themes --no-context-files \
    --no-approve --no-builtin-tools --tools swival-subagent
LAUNCHER
chmod 700 "$DEMO_RUNTIME/bin/pi-swival-demo"

cd "$ROOT"
PATH="$DEMO_RUNTIME/bin:$PATH" \
PI_SWIVAL_DEMO_REPO="$DEMO_REPO" \
PI_SWIVAL_DEMO_HOME="$DEMO_HOME" \
PI_SWIVAL_DEMO_TMPDIR="$TMP_BASE" \
"$VHS_BIN" "$TAPE"
