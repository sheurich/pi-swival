#!/usr/bin/env bash
# Smoke test for the pi-swival package.
#
# Runs three layers of check, ordered cheapest first:
#   1. Manifest:    every path declared in package.json#pi resolves on disk.
#   2. Frontmatter: every bundled agent has a name and description.
#   3. Loadability: pi -e <pkg> loads the extension, skills, and prompts
#                   without printing an error to stderr.
#
# Designed to run in CI on a clean ubuntu-latest with Pi installed globally.
# Exit non-zero on first failure.

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

step "3. Pi loads the package without errors"

# Use a scratch home so we do not pollute developer config, and so this is
# repeatable on CI runners. Pi reads ~/.pi/agent for ambient extensions.
SCRATCH="$(mktemp -d -t pi-swival-smoke.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/.pi/agent"

# pi -e mounts our package for one run. With no message and -p, pi loads
# extensions, skills, and prompts and exits because there is no work.
# This avoids needing an LLM provider — the load phase still reports any
# extension errors on stderr.
LOG="$SCRATCH/pi.log"
HOME="$SCRATCH" pi -e "$ROOT" -p --no-session > "$LOG" 2>&1
ec=$?

if [[ $ec -ne 0 ]]; then
  echo "pi exited $ec" >&2
  cat "$LOG" >&2
  fail "pi load failed"
fi

# Pi exits 0 even when extensions fail to load — so grep for explicit
# load errors.
if grep -E 'Failed to load extension|Tool .* conflicts|extension load error' "$LOG" >&2; then
  echo "---" >&2
  cat "$LOG" >&2
  fail "pi printed an extension load error"
fi

echo "  ok pi loaded the package cleanly"

step "All smoke tests passed"
