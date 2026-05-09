import { beforeEach, describe, expect, test, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

import {
  getAutostartEnabled,
  setAutostartEnabled,
} from '@/features/system/autostart'

beforeEach(() => {
  invokeMock.mockReset()
})

describe('autostart command round-trip', () => {
  test('enable persists across read', async () => {
    let stored = false
    invokeMock.mockImplementation(
      async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'autostart_set_enabled') {
          stored = Boolean(args?.enabled)
          return undefined
        }
        if (cmd === 'autostart_is_enabled') return stored
        throw new Error(`unexpected invoke: ${cmd}`)
      }
    )

    expect(await getAutostartEnabled()).toBe(false)
    await setAutostartEnabled(true)
    expect(await getAutostartEnabled()).toBe(true)
    await setAutostartEnabled(false)
    expect(await getAutostartEnabled()).toBe(false)
  })

  test('command names + arg keys match the Rust handler signature', async () => {
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(true)

    await setAutostartEnabled(true)
    await getAutostartEnabled()

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'autostart_set_enabled', {
      enabled: true,
    })
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'autostart_is_enabled')
  })

  test('Rust-side error bubbles up as a thrown error', async () => {
    invokeMock.mockRejectedValueOnce(new Error('keychain busy'))
    await expect(setAutostartEnabled(true)).rejects.toThrow('keychain busy')
  })
})
