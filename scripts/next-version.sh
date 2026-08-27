#!/usr/bin/env bash
# Derive the next release version from package.json and a requested bump.
#
# Usage: scripts/next-version.sh <patch|minor|major|custom> [custom-version]
#
# Two callers, one contract (the check-version-lockstep.sh pattern):
#   - release-prep.yml's preflight, which rejects an impossible release
#     request in seconds rather than after the ~20-minute quality gate.
#   - release-prep.yml's prep job, which performs the irreversible bump and
#     compares its own result against preflight's to catch main moving
#     underneath the request.
# Both must agree on the number that gets tagged; one script cannot drift
# against itself.
#
# The computed version goes to stdout and nothing else does, so callers can
# capture it directly. The ::error:: prefix renders as an annotation on
# GitHub Actions and is harmless noise when run locally.
set -euo pipefail

release_type="${1:?usage: next-version.sh <patch|minor|major|custom> [custom-version]}"
custom="${2:-}"

current=$(node -p "require('./package.json').version")
IFS='.' read -r major minor patch <<< "$current"
case "$release_type" in
  major) next="$((major + 1)).0.0" ;;
  minor) next="${major}.$((minor + 1)).0" ;;
  patch) next="${major}.${minor}.$((patch + 1))" ;;
  custom) next="$custom" ;;
  *)
    echo "::error::unknown release_type '$release_type'" >&2
    exit 1
    ;;
esac

if [[ ! "$next" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "::error::computed version '$next' is not X.Y.Z or X.Y.Z-prerelease (custom needs a value)" >&2
  exit 1
fi

echo "Bumping $current -> $next" >&2
printf '%s\n' "$next"
