import { describe, expect, test, vi } from 'vitest'

import {
  swapAudioInput,
  type SwapAudioInputDeps,
} from '@/features/session/audioDevices'

type FakeTrack = {
  kind: 'audio' | 'video'
  enabled: boolean
  stop: () => void
}

function fakeTrack(kind: 'audio' | 'video' = 'audio'): FakeTrack {
  return { kind, enabled: true, stop: vi.fn() }
}

type FakeLocalStream = {
  tracks: FakeTrack[]
  getAudioTracks: () => FakeTrack[]
  removeTrack: (t: FakeTrack) => void
  addTrack: (t: FakeTrack) => void
}

function fakeLocalStream(tracks: FakeTrack[]): FakeLocalStream {
  const stream: FakeLocalStream = {
    tracks,
    getAudioTracks: () => stream.tracks.filter((t) => t.kind === 'audio'),
    removeTrack: (t) => {
      stream.tracks = stream.tracks.filter((x) => x !== t)
    },
    addTrack: (t) => {
      stream.tracks.push(t)
    },
  }
  return stream
}

function fakeFreshStream(tracks: FakeTrack[]) {
  return {
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getTracks: () => tracks,
  }
}

function depsWith(args: {
  fresh: ReturnType<typeof fakeFreshStream>
  local: FakeLocalStream
  senders?: { track: FakeTrack | null; replaceTrack: (t: FakeTrack) => void }[]
}): SwapAudioInputDeps {
  const room = args.senders
    ? {
        getPeers: () => ({
          'peer-1': { getSenders: () => args.senders },
        }),
      }
    : null
  return {
    getUserMedia: async () => args.fresh,
    room,
    localStream: args.local,
  } as unknown as SwapAudioInputDeps
}

describe('swapAudioInput (#47 A3)', () => {
  test('returns the swapped-in track so callers can re-attach device-loss recovery', async () => {
    const newTrack = fakeTrack()
    const old = fakeTrack()
    const local = fakeLocalStream([old])
    const returned = await swapAudioInput(
      'mic-2',
      depsWith({ fresh: fakeFreshStream([newTrack]), local }),
      false
    )
    expect(returned).toBe(newTrack as unknown as MediaStreamTrack)
  })

  test('replaces the audio sender track on every peer and swaps the local stream', async () => {
    const newTrack = fakeTrack()
    const old = fakeTrack()
    const local = fakeLocalStream([old])
    const replaceTrack = vi.fn(async () => {})
    await swapAudioInput(
      'mic-2',
      depsWith({
        fresh: fakeFreshStream([newTrack]),
        local,
        senders: [{ track: old, replaceTrack }],
      }),
      false
    )
    expect(replaceTrack).toHaveBeenCalledWith(newTrack)
    expect(old.stop).toHaveBeenCalled()
    expect(local.tracks).toEqual([newTrack])
  })

  test('mirrors the current PTT state onto the fresh track', async () => {
    const newTrack = fakeTrack()
    const local = fakeLocalStream([fakeTrack()])
    await swapAudioInput(
      'mic-2',
      depsWith({ fresh: fakeFreshStream([newTrack]), local }),
      false
    )
    expect(newTrack.enabled).toBe(false)
  })

  test('throws (and stops the acquisition) when the device yields no audio track', async () => {
    const stray = fakeTrack('video')
    const local = fakeLocalStream([fakeTrack()])
    await expect(
      swapAudioInput(
        'mic-2',
        depsWith({ fresh: fakeFreshStream([stray]), local }),
        false
      )
    ).rejects.toThrow(/no audio tracks/)
    expect(stray.stop).toHaveBeenCalled()
  })
})
