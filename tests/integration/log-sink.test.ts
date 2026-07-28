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
  installLogSink,
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
