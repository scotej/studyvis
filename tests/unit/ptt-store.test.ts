import { beforeEach, describe, expect, test } from 'vitest'

import { usePttStore } from '@/stores/pttStore'

describe('pttStore', () => {
  beforeEach(() => {
    usePttStore.setState({ active: false })
  })

  test('starts inactive', () => {
    expect(usePttStore.getState().active).toBe(false)
  })

  test('press flips active to true', () => {
    usePttStore.getState().press()
    expect(usePttStore.getState().active).toBe(true)
  })

  test('release flips active to false', () => {
    usePttStore.getState().press()
    usePttStore.getState().release()
    expect(usePttStore.getState().active).toBe(false)
  })

  test('repeated press is idempotent', () => {
    usePttStore.getState().press()
    usePttStore.getState().press()
    expect(usePttStore.getState().active).toBe(true)
  })

  test('release without prior press stays inactive', () => {
    usePttStore.getState().release()
    expect(usePttStore.getState().active).toBe(false)
  })

  test('press then release then press flips correctly', () => {
    const { press, release } = usePttStore.getState()
    press()
    expect(usePttStore.getState().active).toBe(true)
    release()
    expect(usePttStore.getState().active).toBe(false)
    press()
    expect(usePttStore.getState().active).toBe(true)
  })
})
