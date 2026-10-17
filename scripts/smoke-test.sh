#!/usr/bin/env bash
# Credential-free manifest, resource-loader, and catalogue smoke tests.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

step() { printf '\n=== %s ===\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

step "1. Manifest paths exist"

# Read pi.extensions, pi.skills, pi.prompts from package.json and verify each
# resolves relative to the package root.
node --input-type=module -e "
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const manifest = pkg.pi ?? {};
let ok = true;
for (const key of ['extensions', 'skills', 'prompts']) {
  const paths = manifest[key] ?? [];
  if (paths.length === 0) {
    console.error('package.json#pi.' + key + ' is missing or empty');
    ok = false;
    continue;
  }
  for (const p of paths) {
    if (p.startsWith('!') || p.includes('*') || p.includes('?')) continue;
    const full = resolve(p);
    if (!existsSync(full)) {
      console.error('package.json#pi.' + key + ' references missing path: ' + p);
      ok = false;
    } else {
      console.log('  ok ' + key + ' -> ' + p);
    }
  }
}
if (!ok) process.exit(1);
"

step "2. Bundled agent frontmatter"

# Every .md under agents/ must have name and description in the frontmatter.
node --input-type=module -e "
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const dir = './agents';
const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
if (files.length === 0) {
  console.error('No agents found under ' + dir);
  process.exit(1);
}
let ok = true;
for (const file of files) {
  const content = readFileSync(join(dir, file), 'utf-8');
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) { console.error('  fail ' + file + ': no frontmatter'); ok = false; continue; }
  const block = fm[1];
  const hasName = /^name:/m.test(block);
  const hasDesc = /^description:/m.test(block);
  const hasModel = /^model:/m.test(block);
  if (!hasName) { console.error('  fail ' + file + ': missing name'); ok = false; }
  if (!hasDesc) { console.error('  fail ' + file + ': missing description'); ok = false; }
  if (hasModel) { console.error('  fail ' + file + ': has hardcoded model: (should inherit from swival config)'); ok = false; }
  if (hasName && hasDesc && !hasModel) console.log('  ok ' + file);
}
if (!ok) process.exit(1);
"

step "3. Pi loads the declared resources offline"

# No AgentSession, stdin, model selection, or ambient Pi/project resources.
NPM_GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)" node "$ROOT/scripts/smoke-loader.mjs" "$ROOT"

step "4. Pi lists the agent catalogue offline"

# Setup runs separately, outside npm's lifecycle. Smoke never installs.
SCRATCH="$(mktemp -d -t pi-swival-smoke.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT
LOG="$SCRATCH/loader.log"

# Reuse the guarded SDK loader test; do not create a CLI auth/model runtime.
ec=0
(
  cd "$ROOT/tests"
  HOME="$SCRATCH" node ./node_modules/vitest/vitest.mjs run catalogueLoad.test.ts
) > "$LOG" 2>&1 || ec=$?

if [[ $ec -ne 0 ]]; then
  echo "offline Pi loader test exited $ec" >&2
  cat "$LOG" >&2
  fail "pi load failed"
fi

echo "  ok pi loaded the package and listed its agents cleanly"

step "All smoke tests passed"
