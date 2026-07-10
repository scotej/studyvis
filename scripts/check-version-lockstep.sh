#!/usr/bin/env bash
# #47 F1 — assert the five release-version files agree on one version.
#
# Usage: scripts/check-version-lockstep.sh <expected-version>   (no leading v)
#
# Two callers, one contract:
#   - release.yml preflight: the pushed/dispatched tag must match the files,
#     or a v1.3.2 tag over a stale tauri.conf.json ships installers named
#     StudyVis_1.3.1_* (and a workflow_dispatch on main would mint a
#     "StudyVis main" release).
#   - release-prep.yml post-bump: `perl -0pi` exits 0 whether or not its
#     pattern matched, so a regex drift would bake a silent partial bump
#     into an immutable tag without this re-read.
#
# The ::error:: prefix renders as an annotation on GitHub Actions and is
# harmless noise when run locally.
set -euo pipefail

expected="${1:?usage: check-version-lockstep.sh <expected-version>}"
fail=0

check() {
  local label="$1" actual="$2"
  if [ "$actual" != "$expected" ]; then
    echo "::error::$label reads '$actual', expected '$expected'"
    fail=1
  else
    echo "OK  $label = $actual"
  fi
}

check "package.json" "$(node -p "require('./package.json').version")"
check "package-lock.json (root)" "$(node -p "require('./package-lock.json').version")"
check "package-lock.json (packages)" "$(node -p "require('./package-lock.json').packages[''].version")"
check "src-tauri/tauri.conf.json" "$(node -p "require('./src-tauri/tauri.conf.json').version")"
check "src-tauri/Cargo.toml" "$(perl -0ne 'print $1 if /\[package\][^\[]*?\nversion\s*=\s*"([^"]*)"/s' src-tauri/Cargo.toml)"
check "src-tauri/Cargo.lock" "$(perl -0ne 'print $1 if /name = "studyvis"\nversion = "([^"]*)"/' src-tauri/Cargo.lock)"

exit "$fail"
