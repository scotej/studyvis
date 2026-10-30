import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { subscribeMicrophone } from '@/features/session/microphone'
import { isMicActive, MAX_HOLD_MS, usePttStore } from '@/stores/pttStore'

describe('session microphone transmission', () => {
  let unsubscribe: (() => void) | undefined
  beforeEach(() => {
    vi.useFakeTimers()
    usePttStore.getState().reset()
  })
  afterEach(() => {
    unsubscribe?.()
    unsubscribe = undefined
    usePttStore.getState().reset()
    vi.useRealTimers()
  })

  function bind() {
    const track = { enabled: true }
    const stream = { getAudioTracks: () => [track] } as unknown as MediaStream
    const update = vi.fn()
    unsubscribe = subscribeMicrophone(() => stream, update)
    return { track, stream, update }
  }

  test('mutes immediately and follows native edges synchronously without a render', () => {
    const { track, update } = bind()
    expect(track.enabled).toBe(false)
    usePttStore.getState().press()
    expect(track.enabled).toBe(true)
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ active: true })
    )
    usePttStore.getState().release()
    expect(track.enabled).toBe(false)
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ active: false })
    )
  })

  test('always-on survives PTT releases and its stuck-key cutoff', () => {
    const { track, update } = bind()
    usePttStore.getState().toggleHotMic()
    usePttStore.getState().press()
    vi.advanceTimersByTime(MAX_HOLD_MS)
    expect(usePttStore.getState().active).toBe(false)
    expect(track.enabled).toBe(true)
    usePttStore.getState().release()
    expect(track.enabled).toBe(true)
    expect(update).toHaveBeenCalledTimes(2)
    usePttStore.getState().toggleHotMic()
    expect(track.enabled).toBe(false)
  })

  test('turning always-on off preserves a deliberately held PTT shortcut', () => {
    const { track } = bind()
    usePttStore.getState().toggleHotMic()
    usePttStore.getState().press()
    usePttStore.getState().toggleHotMic()
    expect(track.enabled).toBe(true)
    usePttStore.getState().release()
    expect(track.enabled).toBe(false)
  })

  test('session reset mutes immediately and cannot carry always-on into another session', () => {
    const { track } = bind()
    usePttStore.getState().toggleHotMic()
    usePttStore.getState().reset()
    expect(track.enabled).toBe(false)
    expect(usePttStore.getState().hotMic).toBe(false)
    expect(isMicActive(usePttStore.getState())).toBe(false)
  })

  test('each edge uses the current capture after a microphone replacement', () => {
    const original = { enabled: false }
    const replacement = { enabled: false }
    let stream = { getAudioTracks: () => [original] } as unknown as MediaStream
    unsubscribe = subscribeMicrophone(
      () => stream,
      () => {}
    )
    usePttStore.getState().toggleHotMic()
    stream = { getAudioTracks: () => [replacement] } as unknown as MediaStream
    replacement.enabled = isMicActive(usePttStore.getState())
    usePttStore.getState().toggleHotMic()
    expect(replacement.enabled).toBe(false)
    expect(original.enabled).toBe(true)
  })
})
