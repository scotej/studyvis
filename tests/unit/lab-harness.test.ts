import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

import { unexpectedScenarioFailures } from '../../lab/src/scenarioChecks'
import { runScenarioProcess } from '../../lab/src/scenarioProcess'

describe('lab verdict', () => {
  const machine = {
    name: 'alice',
    pageErrors: [{ message: 'injected failure' }],
    unhandled: new Map([['unsupported_command', 2]]),
  }

  test('unexpected browser exceptions and IPC each fail the common verdict', () => {
    expect(unexpectedScenarioFailures([machine], [])).toEqual([
      'alice: unexpected page-error: injected failure',
      'alice: unexpected unhandled-command: unsupported_command',
    ])
  })

  test('fault exemptions bind machine, category, pattern and exact count', () => {
    const expected = [
      {
        machine: 'alice',
        kind: 'page-error' as const,
        pattern: /^injected failure$/,
        count: 1,
      },
      {
        machine: 'alice',
        kind: 'unhandled-command' as const,
        pattern: /^unsupported_command$/,
        count: 2,
      },
    ]
    expect(unexpectedScenarioFailures([machine], expected)).toEqual([])
    expect(
      unexpectedScenarioFailures([{ ...machine, name: 'bob' }], expected)
    ).toHaveLength(4)
    expect(
      unexpectedScenarioFailures([{ ...machine, pageErrors: [] }], expected)
    ).toEqual([
      'alice: expected 1 page-error matching /^injected failure$/, observed 0',
    ])
    expect(
      unexpectedScenarioFailures(
        [{ ...machine, unhandled: new Map([['unsupported_command', 3]]) }],
        expected
      )
    ).toEqual([
      'alice: expected 2 unhandled-command matching /^unsupported_command$/, observed 3',
    ])
  })
})

describe('bounded lab process runner', () => {
  test.skipIf(process.platform === 'win32')(
    'records cancellation even when the interrupted child exits cleanly',
    async () => {
      const module = new URL(
        '../../lab/src/scenarioProcess.ts',
        import.meta.url
      ).href
      const result = await runScenarioProcess({
        args: [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `
        import {runScenarioProcess} from ${JSON.stringify(module)};
        const result=runScenarioProcess({args:['-e','process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)'],cwd:process.cwd(),timeoutMs:5000});
        setTimeout(()=>process.kill(process.pid,'SIGTERM'),3000);
        process.stdout.write(JSON.stringify(await result));
      `,
        ],
        cwd: process.cwd(),
        timeoutMs: 10_000,
      })
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: 0,
        interrupted: true,
        timedOut: false,
      })
    },
    15_000
  )

  test('CLI preserves complete evidence and refuses a green verdict from a failing process', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'studyvis-lab-verdict-'))
    try {
      const scenario = path.join(dir, 'fixture.ts')
      const evidenceDir = path.join(dir, 'evidence')
      writeFileSync(
        scenario,
        `process.stdout.write(JSON.stringify({scenario:'descriptive-fixture-name',ok:true,checks:[{label:'retained',ok:true}]}));process.exit(7)`
      )
      const result = await runScenarioProcess({
        args: [
          '--import',
          'tsx',
          fileURLToPath(new URL('../../lab/src/cli.ts', import.meta.url)),
          'run',
          scenario,
          '--evidence-dir',
          evidenceDir,
          '--timeout-ms',
          '5000',
        ],
        cwd: process.cwd(),
        timeoutMs: 10_000,
      })
      expect(result.code).toBe(1)
      const report = JSON.parse(
        readFileSync(path.join(evidenceDir, 'fixture.json'), 'utf8')
      )
      expect(report).toMatchObject({
        scenario: 'descriptive-fixture-name',
        ok: false,
        checks: [{ label: 'retained', ok: true }],
        process: { exitCode: 7, timedOut: false },
      })
      expect(
        readFileSync(path.join(evidenceDir, 'fixture.stdout.log'), 'utf8')
      ).toContain('retained')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('large failing scenario verdicts drain before exit and retain their complete JSON', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'studyvis-lab-large-'))
    try {
      const scenario = path.join(dir, 'large.mjs')
      const evidenceDir = path.join(dir, 'evidence')
      const writer = new URL('../../lab/src/scenario.ts', import.meta.url).href
      writeFileSync(
        scenario,
        `import {writeScenarioResult} from ${JSON.stringify(writer)};await writeScenarioResult({scenario:'large-failure',ok:false,error:'x'.repeat(256*1024),machines:{last:{screen:'end-of-snapshot'}}});process.exit(1)`
      )
      const result = await runScenarioProcess({
        args: [
          '--import',
          'tsx',
          fileURLToPath(new URL('../../lab/src/cli.ts', import.meta.url)),
          'run',
          scenario,
          '--evidence-dir',
          evidenceDir,
          '--timeout-ms',
          '10000',
        ],
        cwd: process.cwd(),
        timeoutMs: 15_000,
      })
      expect(result.code).toBe(1)
      const report = JSON.parse(
        readFileSync(path.join(evidenceDir, 'large.json'), 'utf8')
      )
      expect(
        report.error,
        readFileSync(path.join(evidenceDir, 'large.stderr.log'), 'utf8')
      ).toHaveLength(256 * 1024)
      expect(report.machines.last.screen).toBe('end-of-snapshot')
      expect(
        JSON.parse(
          readFileSync(path.join(evidenceDir, 'large.stdout.log'), 'utf8')
        ).error
      ).toHaveLength(256 * 1024)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  test('captures diagnostics and preserves a failing exit beside green output', async () => {
    const result = await runScenarioProcess({
      args: [
        '-e',
        'console.log(JSON.stringify({ok:true}));console.error("details");process.exit(7)',
      ],
      cwd: process.cwd(),
      timeoutMs: 5000,
    })
    expect(result).toMatchObject({ code: 7, signal: null, timedOut: false })
    expect(JSON.parse(result.stdout)).toEqual({ ok: true })
    expect(result.stderr).toContain('details')
  })

  test.skipIf(process.platform !== 'linux')(
    'kills hung descendants and a separately grouped browser after its deadline',
    async () => {
      const result = await runScenarioProcess({
        args: [
          '-e',
          `
        const {spawn}=require('node:child_process');
        const script='process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
        const child=spawn(process.execPath,['-e',script],{stdio:'ignore'});
        const browser=spawn(process.execPath,['-e',script],{stdio:'ignore',detached:true});
        process.send({type:'lab:browser',pid:browser.pid});
        console.log(JSON.stringify([child.pid,browser.pid]));
        process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
      `,
        ],
        cwd: process.cwd(),
        timeoutMs: 3000,
        graceMs: 150,
      })
      expect(result.timedOut).toBe(true)
      expect(result.signal).toBe('SIGKILL')
      const pids = JSON.parse(result.stdout) as number[]
      expect(pids).toHaveLength(2)
      await expect
        .poll(() =>
          pids.every((pid) => {
            try {
              return /^State:\s+Z/m.test(
                readFileSync(`/proc/${pid}/status`, 'utf8')
              )
            } catch (err) {
              return (err as NodeJS.ErrnoException).code === 'ENOENT'
            }
          })
        )
        .toBe(true)
    },
    10_000
  )
})
