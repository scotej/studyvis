import { describe, expect, test } from 'vitest'

import { mediaErrorKind } from '@/lib/mediaError'

describe('mediaErrorKind', () => {
  test('maps permission-denial names to "denied"', () => {
    expect(mediaErrorKind('NotAllowedError')).toBe('denied')
    expect(mediaErrorKind('SecurityError')).toBe('denied')
  })

  test('maps missing-device names to "notFound"', () => {
    expect(mediaErrorKind('NotFoundError')).toBe('notFound')
    expect(mediaErrorKind('DevicesNotFoundError')).toBe('notFound')
  })

  test('maps busy-device names to "inUse"', () => {
    expect(mediaErrorKind('NotReadableError')).toBe('inUse')
    expect(mediaErrorKind('TrackStartError')).toBe('inUse')
  })

  test('maps constraint names to "overconstrained"', () => {
    expect(mediaErrorKind('OverconstrainedError')).toBe('overconstrained')
    expect(mediaErrorKind('ConstraintNotSatisfiedError')).toBe(
      'overconstrained'
    )
  })

  test('falls back to "generic" for unknown or empty names', () => {
    expect(mediaErrorKind('AbortError')).toBe('generic')
    expect(mediaErrorKind('')).toBe('generic')
    expect(mediaErrorKind(undefined)).toBe('generic')
  })
})
