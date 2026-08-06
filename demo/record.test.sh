#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RECORD="$ROOT/demo/record.sh"

if [[ ! -x "$RECORD" ]]; then
  echo "record.sh is missing or not executable" >&2
  exit 1
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pi-swival-record-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/private-bin" "$TMP/home/.pi/agent" "$TMP/runtime" "$TMP/ambient"
MARKER="$TMP/vhs-ran"

cat > "$TMP/home/.pi/agent/auth.json" <<'JSON'
{
  "demo-provider": {
    "type": "oauth",
    "access": "demo-access",
    "refresh": "demo-refresh",
    "accountId": "demo-account"
  },
  "unused-provider": {"type": "api_key", "key": "must-not-copy"}
}
JSON

cat > "$TMP/bin/pi" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ " ${*} " == *" --version "* ]]; then
  echo "9.9.9"
  exit 0
fi
[[ -z "${LEAK_ME+x}" ]]
[[ "$PATH" == "$(dirname "$(command -v pi)"):/usr/bin:/bin:/usr/sbin:/sbin" ]]
command -v fd >/dev/null
[[ "$(cd "$HOME" && pwd)" == "$(cd "$PI_CODING_AGENT_DIR/../.." && pwd)" ]]
[[ " ${*} " == *" --provider demo-provider "* ]]
[[ " ${*} " == *" --model demo-model "* ]]
[[ " ${*} " == *" --no-extensions "* ]]
[[ " ${*} " == *" --no-skills "* ]]
[[ " ${*} " == *" --no-prompt-templates "* ]]
[[ " ${*} " == *" --no-themes "* ]]
[[ " ${*} " == *" --no-context-files "* ]]
[[ " ${*} " == *" --no-builtin-tools "* ]]
[[ " ${*} " == *" --tools swival-subagent "* ]]
STUB
chmod +x "$TMP/bin/pi"

cat > "$TMP/bin/npm" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == "view @earendil-works/pi-coding-agent version" ]]
echo "9.9.9"
STUB
chmod +x "$TMP/bin/npm"

cat > "$TMP/bin/swival" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$TMP/bin/swival"

cat > "$TMP/bin/fd" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$TMP/bin/fd"

cat > "$TMP/bin/vhs" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 1 ]]
[[ -f "$1" ]]
[[ "$(jq -r 'keys | join(",")' "$PI_SWIVAL_DEMO_HOME/.pi/agent/auth.json")" == "demo-provider" ]]
grep -q '^provider = "chatgpt"$' "$PI_SWIVAL_DEMO_HOME/.config/swival/config.toml"
grep -q '^model = "review-model"$' "$PI_SWIVAL_DEMO_HOME/.config/swival/config.toml"
[[ "$(jq -r '[.access_token, .refresh_token, .account_id] | join(",")' "$PI_SWIVAL_DEMO_HOME/.config/litellm/chatgpt/auth.json")" == "demo-access,demo-refresh,demo-account" ]]
! grep -R -q -E 'must-not-copy|unused-provider' "$PI_SWIVAL_DEMO_HOME"
[[ "$PI_SWIVAL_DEMO_REPO" == "$VHS_TEST_TMP"/pi-swival-recording-repo.* ]]
[[ -f "$PI_SWIVAL_DEMO_REPO/extensions/index.ts" ]]
mkdir -p "$PI_SWIVAL_DEMO_REPO/workspace"
cd "$PI_SWIVAL_DEMO_REPO/workspace"
pi-swival-demo quick
touch "$VHS_TEST_MARKER"
STUB
chmod +x "$TMP/bin/vhs"

export LEAK_ME="must-not-reach-pi"
HOME="$TMP/home" \
PI_CODING_AGENT_DIR="$TMP/home/.pi/agent" \
PI_SWIVAL_DEMO_PROVIDER="demo-provider" \
PI_SWIVAL_DEMO_MODEL="demo-model" \
PI_SWIVAL_DEMO_SWIVAL_PROVIDER="chatgpt" \
PI_SWIVAL_DEMO_SWIVAL_MODEL="review-model" \
VHS_TEST_MARKER="$MARKER" \
VHS_TEST_TMP="$TMP/runtime" \
PI_SWIVAL_DEMO_TMPDIR="$TMP/runtime" \
TMPDIR="$TMP/ambient" \
PATH="$TMP/bin:$TMP/private-bin:$PATH" \
VHS="vhs" \
"$RECORD" "$ROOT/demo/demo-quick.tape"

[[ -f "$MARKER" ]]
if find "$TMP/runtime" -mindepth 1 -maxdepth 1 -name 'pi-swival-recording-*' -print -quit | grep -q .; then
  echo "recording temporary directories were not removed" >&2
  exit 1
fi

echo "record demo isolation test passed"
