#!/usr/bin/env bash
# Credential-free resource-loader smoke test for the pi-swival package.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# The helper constructs only DefaultResourceLoader with an in-memory settings
# manager. It does not create an AgentSession, consume stdin, select a model,
# or read ambient Pi/project resources.
NPM_GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)" exec node "$ROOT/scripts/smoke-loader.mjs" "$ROOT"
