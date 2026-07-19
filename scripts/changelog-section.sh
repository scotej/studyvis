#!/usr/bin/env bash
# Extract one version's CHANGELOG.md section (the lines between '## <ver>'
# and the next '## ' heading) to stdout; exit 1 with a ::error annotation
# when the heading is missing or the section body is empty.
#
# Two callers, one contract (the check-version-lockstep.sh pattern):
#   - release-prep.yml gates on it BEFORE the irreversible bump+tag+push.
#   - release.yml's preflight extracts the section into the draft release
#     body — the Releases page is the update channel friends actually read.
# These used to be two hand-mirrored awk copies whose drift class already
# fired once (#74: prep accepted a heading-only placeholder preflight would
# reject, stranding a pushed tag). One script cannot drift against itself.
#
# Usage: scripts/changelog-section.sh <version>   (no leading v)
# The optional second arg names the caller's recovery hint in the error.
set -euo pipefail

ver="${1:?usage: changelog-section.sh <version> [recovery-hint]}"
hint="${2:-Write the release notes for this version in CHANGELOG.md.}"

# Anchored regex (dots escaped, boundary after) so 1.3.1 cannot match a
# 1.3.10 heading. Kept byte-identical to the awk both workflows carried.
section=$(awk -v ver="$ver" '
  BEGIN { gsub(/\./, "\\.", ver); re = "^## " ver "([^0-9.]|$)" }
  !hit && $0 ~ re { hit = 1; next }
  hit && /^## /   { exit }
  hit             { print }
' CHANGELOG.md)

if [ -z "$(printf '%s' "$section" | tr -d '[:space:]')" ]; then
  echo "::error::CHANGELOG.md has no '## $ver' section with actual notes. $hint" >&2
  exit 1
fi

printf '%s\n' "$section"
