import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const sha = '6a0403a721a2ab910fc1afa30dddf026822f0aa3'
const verifier = resolve('scripts/check-v2-release-recovery.sh')
let root: string
let run: Record<string, unknown>
let jobs: Array<Record<string, unknown>>
let log: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'release-recovery-'))
  run = {
    path: '.github/workflows/release.yml',
    head_branch: 'v2.0.0',
    head_sha: sha,
    status: 'completed',
    conclusion: 'failure',
    run_attempt: 2,
  }
  jobs = [
    'Tag / main / CI / version preflight',
    'macOS (Apple Silicon)',
    'Linux (x86_64 AppImage)',
  ].map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success',
    steps: [
      {
        name: 'Launch the exact Linux release AppImage under Xvfb',
        conclusion: 'success',
      },
    ],
  }))
  jobs.push(
    {
      name: 'Windows',
      id: 123,
      status: 'completed',
      conclusion: 'failure',
      steps: [
        { number: 18, conclusion: 'skipped' },
        {
          number: 19,
          name: 'Verify notices and runtime in the exact Windows release installer',
          conclusion: 'failure',
        },
      ],
    },
    {
      name: 'Verify draft latest.json carries every platform',
      status: 'completed',
      conclusion: 'failure',
      steps: [],
    }
  )
  log =
    'Packaged StudyVis did not write its main renderer run.start record within 60 seconds'
  writeFileSync(
    join(root, 'gh'),
    `#!/bin/bash
case "$*" in
  *attempts/2/jobs*) cat "$FIXTURE_ROOT/jobs.json" ;;
  *workflows/release.yml/runs*) cat "$FIXTURE_ROOT/latest.json" ;;
  *jobs/123/logs*) cat "$FIXTURE_ROOT/log.txt" ;;
  *actions/runs/38204769073*) cat "$FIXTURE_ROOT/run.json" ;;
  *) exit 99 ;;
esac
`,
    { mode: 0o755 }
  )
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function verify(tag = 'v2.0.0', releaseSha = sha) {
  writeFileSync(join(root, 'run.json'), JSON.stringify(run))
  writeFileSync(join(root, 'jobs.json'), JSON.stringify({ jobs }))
  writeFileSync(
    join(root, 'latest.json'),
    JSON.stringify({
      workflow_runs: [{ ...run, id: 38204769073, run_number: 100 }],
    })
  )
  writeFileSync(join(root, 'log.txt'), log)
  return spawnSync('bash', [verifier], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      FIXTURE_ROOT: root,
      GH_REPO: 'scotej/studyvis',
      TAG: tag,
      RELEASE_SHA: releaseSha,
    },
  })
}

describe('existing v2.0.0 verifier recovery', () => {
  it('accepts only the identified Windows failure with passing Linux/macOS', () => {
    const result = verify()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
  it.each(['in_progress', 'queued'])(
    'rejects an original run still %s',
    (status) => {
      run.status = status
      expect(verify().status).not.toBe(0)
    }
  )
  it('rejects another tag or commit', () => {
    expect(verify('v2.0.1').status).not.toBe(0)
    expect(verify('v2.0.0', '0'.repeat(40)).status).not.toBe(0)
  })
  it.each([0, 1, 2])('rejects failed platform/preflight job %s', (index) => {
    jobs[index].conclusion = 'failure'
    expect(verify().status).not.toBe(0)
  })
  it('rejects a missing exact Linux startup proof', () => {
    jobs[2].steps = []
    expect(verify().status).not.toBe(0)
  })
  it('rejects another Windows failure', () => {
    jobs[3].steps = [{ number: 17, name: 'Build', conclusion: 'failure' }]
    expect(verify().status).not.toBe(0)
  })
  it('requires authoritative log evidence of the identified failure', () => {
    log = 'Packaged StudyVis exited before startup completed'
    expect(verify().status).not.toBe(0)
  })
})
