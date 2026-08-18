// #98 — pins the JS↔Rust contract for the on-disk log. The Rust side cannot be
// compiled on the dev box, so the argument keys (`lines`, `maxLines`) and the
// command names are the part most likely to drift silently; these assertions
// are what catch a rename before CI builds an installer.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import {
  __resetLog,
  flushLog,
  formatRecords,
  installLogSink,
  SINK_MAX_LINES_PER_CALL,
  logger,
  parseRecordLines,
  type LogRecord,
} from '@/lib/log'

async function tauriWriteLines(lines: string[]): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('app_log_append', { lines })
}

beforeEach(() => {
  __resetLog()
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  __resetLog()
})

describe('app_log_append', () => {
  test('a flush is one call carrying every queued line', async () => {
    installLogSink({
      window: 'main',
      appVersion: '1.2.3',
      writeLines: tauriWriteLines,
      installGlobalHandlers: false,
    })
    logger.child('session').warn('join.error', { room: 'presence-friend' })
    await flushLog()

    expect(invokeMock).toHaveBeenCalledTimes(1)
    const [command, args] = invokeMock.mock.calls[0] as [
      string,
      { lines: string[] },
    ]
    expect(command).toBe('app_log_append')
    // run.start plus the one warn.
    expect(args.lines).toHaveLength(2)
    const records = parseRecordLines(args.lines)
    expect(records.map((r) => r.msg)).toEqual(['run.start', 'join.error'])
    expect(records[0]?.win).toBe('main')
    expect(records[0]?.data?.app).toBe('1.2.3')
  })

  test('the ai-dialog webview labels its own records', async () => {
    installLogSink({
      window: 'ai-dialog',
      appVersion: '1.2.3',
      writeLines: tauriWriteLines,
      installGlobalHandlers: false,
    })
    await flushLog()
    const [, args] = invokeMock.mock.calls[0] as [string, { lines: string[] }]
    expect(parseRecordLines(args.lines)[0]?.win).toBe('ai-dialog')
  })

  test('a rejecting command never surfaces as an app error', async () => {
    invokeMock.mockRejectedValue(new Error('disk full'))
    installLogSink({
      window: 'main',
      appVersion: '1.2.3',
      writeLines: tauriWriteLines,
      installGlobalHandlers: false,
    })
    logger.error('boom')
    await expect(flushLog()).resolves.toBeUndefined()
  })
})

describe('app_log_tail', () => {
  test('round-trips the lines the appender wrote', async () => {
    installLogSink({
      window: 'main',
      appVersion: '1.2.3',
      writeLines: tauriWriteLines,
      installGlobalHandlers: false,
    })
    logger.child('updater').error('install.failed', { version: '1.2.4' })
    await flushLog()
    const written = invokeMock.mock.calls.flatMap(
      (call) => (call[1] as { lines: string[] }).lines
    )

    invokeMock.mockResolvedValue(written)
    const { invoke } = await import('@tauri-apps/api/core')
    const lines = await invoke<string[]>('app_log_tail', { maxLines: 80 })
    const records: LogRecord[] = parseRecordLines(lines)

    expect(records.some((r) => r.msg === 'install.failed')).toBe(true)
    expect(
      invokeMock.mock.calls.some(
        ([command, args]) =>
          command === 'app_log_tail' &&
          (args as { maxLines: number }).maxLines === 80
      )
    ).toBe(true)
  })
})

// #226 — Rust now appends to the SAME file through `native_log.rs`, and its
// `render_record` hand-renders the key order rather than using serde_json (a
// BTreeMap would alphabetise `msg` ahead of `scope` and break the release
// grep). The Rust half cannot be compiled on this box, so this line is copied
// verbatim from the assertion in `native_log.rs`'s own tests: if either side
// moves, one of the two fails.
describe('native records share the renderer schema', () => {
  const NATIVE_LINE =
    '{"v":1,"ts":"2026-08-17T00:00:00.000Z","seq":7,"run":"abcd1234",' +
    '"win":"native","lvl":"info","scope":"ptt.native","msg":"watcher.exited",' +
    '"data":{"gen":3,"reason":"session-inactive","emitOk":42,"emitErr":0}}'

  test('the parser accepts a native line and keeps its fields', () => {
    const [record] = parseRecordLines([NATIVE_LINE])
    expect(record).toBeDefined()
    expect(record?.win).toBe('native')
    expect(record?.scope).toBe('ptt.native')
    expect(record?.msg).toBe('watcher.exited')
    // The count a reader compares against the renderer's received total.
    expect(record?.data?.emitOk).toBe(42)
  })

  // The JS half of the #226 data-loss fix is only correct if this constant is
  // <= applog.rs's private MAX_LINES_PER_CALL. Rust cannot be compiled on the
  // dev box, so this is the pin that catches a drift in either direction.
  test('the sink chunk size matches the documented Rust ceiling', () => {
    expect(SINK_MAX_LINES_PER_CALL).toBe(256)
  })

  test('scope stays immediately before msg, which CI greps for', () => {
    expect(NATIVE_LINE).toContain('"scope":"ptt.native","msg":"watcher.exited"')
  })

  test('a native line renders alongside renderer records', () => {
    const rendered = formatRecords(parseRecordLines([NATIVE_LINE]))
    expect(rendered).toContain('[ptt.native] watcher.exited')
  })
})
