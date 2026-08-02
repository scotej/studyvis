import { beforeEach, describe, expect, test, vi } from 'vitest'

const { invokeMock, saveMock, flushLogMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  saveMock: vi.fn(),
  flushLogMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: saveMock }))
vi.mock('@/lib/log', () => ({ flushLog: flushLogMock }))

import {
  saveDiagnosticsArchive,
  type DiagnosticsExportDeps,
} from '@/lib/diagnostics'

function deps(overrides: Partial<DiagnosticsExportDeps> = {}) {
  const order: string[] = []
  const value: DiagnosticsExportDeps = {
    pickPath: vi.fn(async () => {
      order.push('pick')
      return '/tmp/studyvis-diagnostics.zip'
    }),
    flush: vi.fn(async () => {
      order.push('flush')
    }),
    exportArchive: vi.fn(async () => {
      order.push('export')
      return '/tmp/studyvis-diagnostics.zip'
    }),
    ...overrides,
  }
  return { value, order }
}

beforeEach(() => {
  invokeMock.mockReset()
  saveMock.mockReset()
  flushLogMock.mockReset()
})

describe('saveDiagnosticsArchive', () => {
  test('uses the diagnostics_export Tauri contract', async () => {
    const order: string[] = []
    saveMock.mockImplementation(async () => {
      order.push('pick')
      return '/tmp/chosen.zip'
    })
    flushLogMock.mockImplementation(async () => {
      order.push('flush')
    })
    invokeMock.mockImplementation(async () => {
      order.push('export')
      return '/tmp/chosen.zip'
    })

    await expect(
      saveDiagnosticsArchive({ sessionPrefix: 'deadbeef' })
    ).resolves.toEqual({ kind: 'saved', path: '/tmp/chosen.zip' })
    expect(order).toEqual(['pick', 'flush', 'export'])
    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: 'studyvis-diagnostics.zip',
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    })
    expect(invokeMock).toHaveBeenCalledWith('diagnostics_export', {
      path: '/tmp/chosen.zip',
      sessionPrefix: 'deadbeef',
    })
  })

  test('picks a ZIP, flushes the app log, then exports the archive', async () => {
    const { value, order } = deps()

    const result = await saveDiagnosticsArchive(
      {
        defaultPath: 'studyvis-linear-algebra-diagnostics.zip',
        sessionPrefix: 'deadbeef',
      },
      value
    )

    expect(result).toEqual({
      kind: 'saved',
      path: '/tmp/studyvis-diagnostics.zip',
    })
    expect(order).toEqual(['pick', 'flush', 'export'])
    expect(value.pickPath).toHaveBeenCalledWith({
      defaultPath: 'studyvis-linear-algebra-diagnostics.zip',
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    })
    expect(value.exportArchive).toHaveBeenCalledWith(
      '/tmp/studyvis-diagnostics.zip',
      'deadbeef'
    )
  })

  test('cancellation does not flush or invoke the exporter', async () => {
    const { value } = deps({
      pickPath: vi.fn().mockResolvedValue(null),
    })

    await expect(saveDiagnosticsArchive({}, value)).resolves.toEqual({
      kind: 'cancelled',
    })
    expect(value.flush).not.toHaveBeenCalled()
    expect(value.exportArchive).not.toHaveBeenCalled()
  })

  test('uses the shared default filename and sends a null session prefix', async () => {
    const { value } = deps()

    await saveDiagnosticsArchive({}, value)

    expect(value.pickPath).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'studyvis-diagnostics.zip' })
    )
    expect(value.exportArchive).toHaveBeenCalledWith(
      '/tmp/studyvis-diagnostics.zip',
      null
    )
  })

  test('does not export when flushing fails', async () => {
    const failure = new Error('flush failed')
    const { value } = deps({ flush: vi.fn().mockRejectedValue(failure) })

    await expect(saveDiagnosticsArchive({}, value)).rejects.toBe(failure)
    expect(value.exportArchive).not.toHaveBeenCalled()
  })

  test('surfaces exporter failures to the UI caller', async () => {
    const failure = new Error('export failed')
    const { value } = deps({
      exportArchive: vi.fn().mockRejectedValue(failure),
    })

    await expect(saveDiagnosticsArchive({}, value)).rejects.toBe(failure)
  })
})
