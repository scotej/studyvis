#!/usr/bin/env bash
# Narrow verifier repair for the existing v2.0.0 draft; never builds or retags.
set -euo pipefail
: "${GH_REPO:?}" "${TAG:?}" "${RELEASE_SHA:?}"
original_run=38204769073
expected_sha=6a0403a721a2ab910fc1afa30dddf026822f0aa3
[[ "$TAG" == v2.0.0 && "$RELEASE_SHA" == "$expected_sha" ]]
run=$(gh api "repos/$GH_REPO/actions/runs/$original_run")
jq -e --arg sha "$expected_sha" '
  .path == ".github/workflows/release.yml" and .head_branch == "v2.0.0" and
  .head_sha == $sha and .status == "completed" and .conclusion == "failure" and
  .run_attempt == 2
' <<< "$run" >/dev/null
latest=$(gh api "repos/$GH_REPO/actions/workflows/release.yml/runs?head_sha=$expected_sha&per_page=100")
jq -e --arg sha "$expected_sha" --argjson id "$original_run" '
  [.workflow_runs[] | select(.head_sha == $sha and .head_branch == "v2.0.0")]
  | sort_by(.run_number) | last | .id == $id
' <<< "$latest" >/dev/null
jobs=$(gh api --paginate "repos/$GH_REPO/actions/runs/$original_run/attempts/2/jobs?per_page=100" | jq -s '[.[].jobs[]]')
jq -e '
  length == 5 and
  all(.[];
    .status == "completed" and
    if .name == "Windows" then
      .conclusion == "failure" and
      ([.steps[] | select(.conclusion == "failure")] | length == 1) and
      any(.steps[]; .number == 19 and .name == "Verify notices and runtime in the exact Windows release installer" and .conclusion == "failure") and
      all(.steps[] | select(.number < 19); .conclusion == "success" or .conclusion == "skipped")
    elif .name == "Verify draft latest.json carries every platform" then .conclusion == "failure"
    elif .name == "Tag / main / CI / version preflight" or .name == "macOS (Apple Silicon)" or .name == "Linux (x86_64 AppImage)" then .conclusion == "success"
    else false end
  ) and
  any(.[]; .name == "Linux (x86_64 AppImage)" and any(.steps[]; .name == "Launch the exact Linux release AppImage under Xvfb" and .conclusion == "success"))
' <<< "$jobs" >/dev/null
windows_job=$(jq -r '.[] | select(.name == "Windows") | .id' <<< "$jobs")
log=$(gh api "repos/$GH_REPO/actions/jobs/$windows_job/logs")
grep -Fq 'Packaged StudyVis did not write its main renderer run.start record within 60 seconds' <<< "$log"
echo "Original v2.0.0 preflight/macOS/Linux passed; only the known Windows verifier and dependent manifest failed."
if [[ $# == 1 ]]; then
  recovery_id=$1
  [[ "$recovery_id" =~ ^[1-9][0-9]*$ ]]
  recovery=$(gh api "repos/$GH_REPO/actions/runs/$recovery_id")
  jq -e '
    .path == ".github/workflows/release.yml" and .head_branch == "main" and
    .event == "workflow_dispatch" and .status == "completed" and .conclusion == "success"
  ' <<< "$recovery" >/dev/null
  recovery_sha=$(jq -r .head_sha <<< "$recovery")
  git merge-base --is-ancestor "$recovery_sha" refs/remotes/origin/main
  recovery_jobs=$(gh api --paginate "repos/$GH_REPO/actions/runs/$recovery_id/jobs?per_page=100" | jq -s '[.[].jobs[]]')
  jq -e '
    all(["Verify v2.0.0 recovery tag and CI", "Verify exact existing v2.0.0 Windows installer", "Verify draft latest.json carries every platform"][];
      . as $name | any($ARGS.named.jobs[]; .name == $name and .conclusion == "success"))
  ' --argjson jobs "$recovery_jobs" <<< '{}' >/dev/null
  echo "RECOVERY_SHA=$recovery_sha" >> "$GITHUB_ENV"
fi
