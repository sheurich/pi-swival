#!/usr/bin/env bash
# Real upstream bootstrap/export gate with synthetic auth and no live calls.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT/tests"
export NATIVE_AGENTFS_INTEGRATION=1 NONO_NO_UPDATE_CHECK=1
exec "$ROOT/tests/node_modules/.bin/vitest" run nativeAgentfs.test.ts --reporter=dot
