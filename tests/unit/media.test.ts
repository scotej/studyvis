import { describe, expect, test, vi } from 'vitest'

import { stopMediaStream } from '@/lib/media'

function fakeStream(tracks: Array<{ stop: () => void }>): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream
}

describe('stopMediaStream', () => {
  test('stops every track', () => {
    const stop = vi.fn()
    stopMediaStream(fakeStream([{ stop }, { stop }]))
    expect(stop).toHaveBeenCalledTimes(2)
  })

  test('keeps going when a track throws on stop', () => {
    const stop = vi.fn()
    const throwing = {
      stop: () => {
        throw new Error('already stopped')
      },
    }
    expect(() =>
      stopMediaStream(fakeStream([throwing, { stop }]))
    ).not.toThrow()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  test('tolerates null / undefined', () => {
    expect(() => stopMediaStream(null)).not.toThrow()
    expect(() => stopMediaStream(undefined)).not.toThrow()
  })
})
