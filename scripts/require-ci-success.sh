#!/usr/bin/env bash
# Require a successful main-push CI run for one exact commit, waiting while
# that run is still queued or in flight.
#
# Usage: scripts/require-ci-success.sh <sha> [recovery-hint]
# Environment: CI_POLL_ATTEMPTS (default 240) 30-second polls; GH_TOKEN and
# GH_REPO / GITHUB_REPOSITORY as `gh` requires.
#
# Two callers, one contract (the check-version-lockstep.sh pattern):
#   - release-prep.yml's gate, before the irreversible bump+tag+push.
#   - release.yml's preflight, before any build minutes are spent on a tag.
# Both ask the same question of the same API and must read a queued run, a
# failed run, and an absent run the same way; they used to carry two
# hand-mirrored copies of this loop.
#
# ci.yml cancels its own in-progress main run when the next commit lands
# (concurrency: CI-refs/heads/main, cancel-in-progress: true), so only main's
# tip ever reaches completed:success and an overtaken commit reports
# completed:cancelled. That is the correct answer to "can I release this
# commit" — release the tip — and it arrives here as an immediate, explained
# failure rather than a timeout.
#
# Waiting rather than failing on a pending run is deliberate. The state being
# polled is a CI run that a merge has already started, so "not finished yet"
# is a normal answer that resolves itself; failing on it would only mean
# dispatching again later. Anything that is genuinely decided — a completed
# run that did not succeed, or an unrecognized state — fails immediately.
set -euo pipefail

sha="${1:?usage: require-ci-success.sh <sha> [recovery-hint]}"
hint="${2:-Push the fix, wait for CI to go green, and try again.}"
attempts="${CI_POLL_ATTEMPTS:-240}"
repository="${GH_REPO:-${GITHUB_REPOSITORY:?GH_REPO or GITHUB_REPOSITORY must be set}}"

echo "Requiring a successful main-push CI run for $sha"
for attempt in $(seq 1 "$attempts"); do
  response=$(gh api \
    "repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=10" \
    2>/dev/null || printf '{"workflow_runs":[]}')
  # Re-filter on head_sha: the API's head_sha filter has returned other
  # commits' runs, and `last` by run_number is the newest attempt.
  state=$(jq -r '
    [.workflow_runs[] | select(.head_sha == $sha)]
    | sort_by(.run_number) | last
    | if . == null then "none" else "\(.status):\(.conclusion // "")" end
  ' --arg sha "$sha" <<< "$response")
  echo "CI for ${sha}: ${state} (poll ${attempt}/${attempts})"
  case "$state" in
    completed:success)
      exit 0
      ;;
    completed:*)
      echo "::error::CI on $sha completed without success ($state). $hint"
      exit 1
      ;;
    none | queued: | in_progress: | requested: | waiting: | pending:)
      sleep 30
      ;;
    *)
      echo "::error::Unexpected CI state '$state' for $sha"
      exit 1
      ;;
  esac
done
echo "::error::Timed out waiting for CI success on $sha after $attempts polls. $hint"
exit 1
