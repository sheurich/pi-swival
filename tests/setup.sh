#!/usr/bin/env bash
# Bootstrap the standalone vitest harness for the swival-subagent extension.
# Idempotent — safe to re-run.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
	echo "error: npm not found on PATH; install Node.js before running setup.sh." >&2
	exit 1
fi

# 1. Install the local test dependencies.
PI_SUBAGENTS_DIR="${PWD}/node_modules/pi-subagents"
PI_SUBAGENTS_SOURCE="${PI_SUBAGENTS_DIR}/src/api/background-work.ts"
PI_SUBAGENTS_PATCH="${PWD}/fixtures/pi-subagents-background-work-events.patch"
FINAL_PATCH_MARKER='export interface BackgroundWorkEventBridge'
OLD_PATCH_MARKER='export const BACKGROUND_WORK_REGISTER_EVENT = '

if [[ ! -d node_modules/vitest || ! -d "$PI_SUBAGENTS_DIR" ]]; then
	if ! npm install --silent --ignore-scripts; then
		echo "error: npm install failed while restoring test dependencies." >&2
		exit 1
	fi
fi

# An earlier fixture used the register-event constant as its marker. Restore the
# pinned package before applying the final patch when that stale patch is found.
if [[ -f "$PI_SUBAGENTS_SOURCE" ]] \
	&& grep -q "^${OLD_PATCH_MARKER}" "$PI_SUBAGENTS_SOURCE" \
	&& ! grep -q "^${FINAL_PATCH_MARKER}" "$PI_SUBAGENTS_SOURCE"; then
	rm -rf "$PI_SUBAGENTS_DIR"
	if ! npm install --silent --ignore-scripts; then
		echo "error: npm install failed while restoring pinned pi-subagents 0.50.0 after removing the stale patch." >&2
		exit 1
	fi
fi

# Apply the committed source-only patch to the pinned pi-subagents fixture.
# BackgroundWorkEventBridge is the final contract and idempotency marker.
if [[ ! -f "$PI_SUBAGENTS_SOURCE" ]]; then
	echo "error: pinned pi-subagents 0.50.0 source is missing after npm install: ${PI_SUBAGENTS_SOURCE}" >&2
	exit 1
fi
if ! grep -q "^${FINAL_PATCH_MARKER}" "$PI_SUBAGENTS_SOURCE"; then
	if ! patch --dry-run --silent -p1 -d "$PI_SUBAGENTS_DIR" < "$PI_SUBAGENTS_PATCH"; then
		echo "error: failed to apply ${PI_SUBAGENTS_PATCH} to pinned pi-subagents 0.50.0." >&2
		exit 1
	fi
	if ! patch --silent -p1 -d "$PI_SUBAGENTS_DIR" < "$PI_SUBAGENTS_PATCH"; then
		echo "error: failed to apply ${PI_SUBAGENTS_PATCH} to pinned pi-subagents 0.50.0." >&2
		exit 1
	fi
fi
if ! grep -q "^${FINAL_PATCH_MARKER}" "$PI_SUBAGENTS_SOURCE"; then
	echo "error: pi-subagents fixture patch applied without the final BackgroundWorkEventBridge contract." >&2
	exit 1
fi

# 2. Find the Pi install so we can symlink the peer packages the extension
#    imports from: @earendil-works/{pi-ai, pi-agent-core, pi-coding-agent,
#    pi-tui} and typebox.
PI_PKG=""
npm_global_root=""
npm_global_root="$(npm root -g 2>/dev/null)" || npm_global_root=""
for candidate in \
	/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent \
	/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent \
	"${HOME}/.local/share/npm/lib/node_modules/@earendil-works/pi-coding-agent" \
	"${HOME}/.local/share/npm/lib/node_modules/@mariozechner/pi-coding-agent" \
	${npm_global_root:+"${npm_global_root}/@earendil-works/pi-coding-agent"} \
	${npm_global_root:+"${npm_global_root}/@mariozechner/pi-coding-agent"}; do
	if [[ -d "$candidate" ]]; then
		PI_PKG="$candidate"
		break
	fi
done

if [[ -z "$PI_PKG" ]]; then
	echo "error: could not locate pi-coding-agent (@earendil-works or @mariozechner); install Pi first." >&2
	exit 1
fi

mkdir -p node_modules/@earendil-works

# Determine the scope prefix used by this install (@earendil-works or @mariozechner).
if [[ -d "${PI_PKG}/node_modules/@earendil-works/pi-ai" ]]; then
	PI_SCOPE="@earendil-works"
elif [[ -d "${PI_PKG}/node_modules/@mariozechner/pi-ai" ]]; then
	PI_SCOPE="@mariozechner"
else
	echo "error: cannot find pi-ai under ${PI_PKG}/node_modules/" >&2
	exit 1
fi

# The extension imports from @earendil-works/* — symlink to whatever scope
# the Pi install uses internally.
for pkg in pi-ai pi-agent-core; do
	ln -sfn "${PI_PKG}/node_modules/${PI_SCOPE}/${pkg}" "node_modules/@earendil-works/${pkg}"
done

# pi-tui may live under pi-coding-agent or as a sibling top-level package.
PI_TUI="${PI_PKG}/node_modules/${PI_SCOPE}/pi-tui"
if [[ ! -d "$PI_TUI" ]]; then
	# Try sibling install (e.g. /opt/homebrew/lib/node_modules/@earendil-works/pi-tui)
	PI_TUI="$(dirname "$PI_PKG")/pi-tui"
fi
if [[ -d "$PI_TUI" ]]; then
	ln -sfn "$PI_TUI" "node_modules/@earendil-works/pi-tui"
else
	echo "warning: could not locate pi-tui; tests importing TUI types will fail." >&2
fi

ln -sfn "$PI_PKG" node_modules/@earendil-works/pi-coding-agent
ln -sfn "${PI_PKG}/node_modules/typebox" node_modules/typebox

echo "swival-subagent tests ready. Run: npx vitest run"
