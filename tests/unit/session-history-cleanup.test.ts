import { beforeEach, expect, test, vi } from 'vitest'
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
import {
  JournalCleanupIncompleteError,
  sessionsDelete,
  sessionsClearAll,
} from '@/lib/db/sessions'
beforeEach(() => {
  invoke.mockReset()
})
test.each([
  ['single', () => sessionsDelete('ab')],
  ['all', sessionsClearAll],
])(
  '%s distinguishes committed deletion with incomplete file cleanup and permits retry',
  async (_kind, action) => {
    invoke
      .mockRejectedValueOnce(
        'SESSION_JOURNAL_CLEANUP_INCOMPLETE: permission denied'
      )
      .mockResolvedValueOnce(undefined)
    await expect(action()).rejects.toBeInstanceOf(JournalCleanupIncompleteError)
    await expect(action()).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledTimes(2)
  }
)
test('SQL errors retain their original failure semantics', async () => {
  invoke.mockRejectedValue('database busy')
  await expect(sessionsDelete('ab')).rejects.toBe('database busy')
})
