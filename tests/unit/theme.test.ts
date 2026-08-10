import { describe, expect, test } from 'vitest'

import { resolveTheme } from '@/design/theme-resolution'

describe('resolveTheme', () => {
  test('keeps an explicit theme independent of the OS preference', () => {
    expect(resolveTheme('dark', 'light')).toBe('dark')
    expect(resolveTheme('light', 'dark')).toBe('light')
  })

  test('follows the live OS preference in auto mode', () => {
    expect(resolveTheme('auto', 'dark')).toBe('dark')
    expect(resolveTheme('auto', 'light')).toBe('light')
  })
})
