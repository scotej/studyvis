import { expect, test } from 'vitest'
import { formatLastTogether } from '@/features/friends/friendLabels'
import { strings } from '@/strings'

test('a study session before local midnight was yesterday', () => {
  const lastSession = new Date(2026, 10, 17, 23, 55).getTime()
  const now = new Date(2026, 10, 18, 0, 5).getTime()
  expect(formatLastTogether(lastSession, now)).toBe(
    strings.friends.list.lastTogether.yesterday
  )
})

test.each([
  [2, 8], // US spring forward
  [3, 5], // Australian fall back
  [9, 4], // Australian spring forward
  [10, 1], // US fall back
])(
  'counts local calendar days across the 2026 transition at %i/%i',
  (month, day) => {
    const before = new Date(2026, month, day - 1, 12).getTime()
    const after = new Date(2026, month, day + 1, 12).getTime()
    expect(formatLastTogether(before, after)).toBe(
      strings.friends.list.lastTogether.daysAgo(2)
    )
  }
)
