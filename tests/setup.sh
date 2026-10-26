#!/usr/bin/env bash
# Bootstrap the standalone Vitest harness. Run directly, never through npm.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
	echo "error: npm not found on PATH; install Node.js before running tests/setup.sh." >&2
	exit 1
fi

if [[ -n "${npm_lifecycle_event:-}" || -n "${npm_config_allow_scripts:-}" ]]; then
	cat >&2 <<'EOF'
error: tests/setup.sh must be run directly, outside an npm lifecycle.

npm exports your allow-scripts policy as npm_config_allow_scripts to lifecycle
children. npm rejects a nested install under that policy even with
--ignore-scripts. Run ./tests/setup.sh once, then run npm test. Your npm policy
and configuration were left unchanged.
EOF
	exit 1
fi

pinned_types_present() {
	node -e 'const pins = require("./package.json").devDependencies;
	for (const name of ["typescript", "@types/node"]) {
		try { if (require("./node_modules/" + name + "/package.json").version !== pins[name]) process.exit(1); }
		catch { process.exit(1); }
	}'
}
if [[ ! -d node_modules/vitest || ! -f node_modules/typescript/package.json ||
	! -f node_modules/@types/node/package.json ]] || ! pinned_types_present; then
	npm install --ignore-scripts --no-audit --no-fund --legacy-peer-deps
fi
pinned_types_present

# Install the extension's declared runtime dependency without installing peers.
if ! node -e '
	const expected = require("../package.json").dependencies.yaml;
	const installed = require("../node_modules/yaml/package.json").version;
	process.exit(installed === expected ? 0 : 1);
' >/dev/null 2>&1; then
	npm install --prefix .. --ignore-scripts --no-audit --no-fund \
		--legacy-peer-deps --package-lock=false
fi

npm_global_root="$(npm root -g 2>/dev/null || true)"
NPM_GLOBAL_ROOT="$npm_global_root" node ../scripts/test-peer-bootstrap.mjs --link "$PWD/node_modules"
if ! command -v uv >/dev/null 2>&1; then
	echo "uv and Python 3.13 are required for the offline native audit tests." >&2
	exit 1
fi
if [[ -L .venv ]]; then
	echo "Refusing a symlinked test virtual environment." >&2
	exit 1
fi
if [[ ! -d .venv ]]; then
	uv --no-config venv --python 3.13 --no-python-downloads .venv
fi
uv --no-config pip sync --python .venv/bin/python --only-binary :all: \
	--require-hashes requirements.txt
.venv/bin/python -c 'import sys, importlib.metadata; assert sys.version_info[:2] == (3, 13); assert importlib.metadata.version("swival") == "1.0.48"'
echo "Test dependencies, selected Pi peers, and pinned Swival are ready. Run: npm run ci"
