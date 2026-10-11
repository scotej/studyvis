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
          'peer-1': {
            getSenders: () => args.senders,
            removeTrack: vi.fn((sender) => {
              sender.track = null
            }),
          },
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
      () => false
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
      () => false
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
      () => false
    )
    expect(newTrack.enabled).toBe(false)
  })

  test('a held PTT enables the fresh microphone only after it joins the owned local stream', async () => {
    const newTrack = fakeTrack()
    const old = fakeTrack()
    const local = fakeLocalStream([old])
    const replaceTrack = vi.fn(async () => {
      expect(newTrack.enabled).toBe(false)
      expect(local.tracks).toEqual([old])
    })
    await swapAudioInput(
      'mic-2',
      depsWith({
        fresh: fakeFreshStream([newTrack]),
        local,
        senders: [{ track: old, replaceTrack }],
      }),
      () => true
    )
    expect(local.tracks).toEqual([newTrack])
    expect(newTrack.enabled).toBe(true)
  })

  // The swap spans two awaits; a PTT release inside that window used to
  // leave the swapped-in mic silently hot (pre-await snapshot). The getter
  // is re-read after the awaits, so the track lands with the CURRENT state.
  test('a PTT release mid-swap lands on the fresh track (no hot mic)', async () => {
    const newTrack = fakeTrack()
    const old = fakeTrack()
    const local = fakeLocalStream([old])
    let ptt = true
    const replaceTrack = vi.fn(async () => {
      // Release happens while replaceTrack is in flight.
      ptt = false
    })
    await swapAudioInput(
      'mic-2',
      depsWith({
        fresh: fakeFreshStream([newTrack]),
        local,
        senders: [{ track: old, replaceTrack }],
      }),
      () => ptt
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
        () => false
      )
    ).rejects.toThrow(/no audio tracks/)
    expect(stray.stop).toHaveBeenCalled()
  })

  test('a cancelled swap never requests a device', async () => {
    const controller = new AbortController()
    controller.abort()
    const deps = depsWith({
      fresh: fakeFreshStream([fakeTrack()]),
      local: fakeLocalStream([fakeTrack()]),
    })
    deps.signal = controller.signal
    const acquire = vi.spyOn(deps, 'getUserMedia')
    expect(await swapAudioInput('mic-2', deps, () => true)).toBeNull()
    expect(acquire).not.toHaveBeenCalled()
  })

  test('takeover during device acquisition stops every fresh track before touching a sender', async () => {
    const controller = new AbortController()
    const newTrack = fakeTrack()
    const extraAudio = fakeTrack()
    const strayVideo = fakeTrack('video')
    const old = fakeTrack()
    const local = fakeLocalStream([old])
    const replaceTrack = vi.fn(async () => {})
    const deps = depsWith({
      fresh: fakeFreshStream([newTrack, extraAudio, strayVideo]),
      local,
      senders: [{ track: old, replaceTrack }],
    })
    let resolve!: (stream: MediaStream) => void
    deps.getUserMedia = () => new Promise((done) => (resolve = done))
    deps.signal = controller.signal
    const pending = swapAudioInput('mic-2', deps, () => true)
    controller.abort()
    resolve(
      fakeFreshStream([
        newTrack,
        extraAudio,
        strayVideo,
      ]) as unknown as MediaStream
    )
    expect(await pending).toBeNull()
    for (const track of [newTrack, extraAudio, strayVideo])
      expect(track.stop).toHaveBeenCalled()
    expect(replaceTrack).not.toHaveBeenCalled()
    expect(local.tracks).toEqual([old])
    expect(old.stop).not.toHaveBeenCalled()
  })

  test('a changed session or stream invalidates acquisition even before its render cleanup', async () => {
    const newTrack = fakeTrack()
    const old = fakeTrack()
    const local = fakeLocalStream([old])
    const replaceTrack = vi.fn(async () => {})
    const deps = depsWith({
      fresh: fakeFreshStream([newTrack]),
      local,
      senders: [{ track: old, replaceTrack }],
    })
    let current = true
    deps.isCurrent = () => current
    const pending = swapAudioInput('mic-2', deps, () => true)
    current = false
    expect(await pending).toBeNull()
    expect(newTrack.stop).toHaveBeenCalled()
    expect(replaceTrack).not.toHaveBeenCalled()
    expect(local.tracks).toEqual([old])
  })

  test('takeover while replaceTrack waits immediately mutes and stops the device and prevents further mutations', async () => {
    const controller = new AbortController()
    const newTrack = fakeTrack()
    const old = fakeTrack()
    const local = fakeLocalStream([old])
    let resolve!: () => void
    const replaceTrack = vi.fn(
      () => new Promise<void>((done) => (resolve = done))
    )
    const nextReplaceTrack = vi.fn(async () => {})
    const deps = depsWith({
      fresh: fakeFreshStream([newTrack]),
      local,
      senders: [
        { track: old, replaceTrack },
        { track: old, replaceTrack: nextReplaceTrack },
      ],
    })
    deps.signal = controller.signal
    const pending = swapAudioInput('mic-2', deps, () => true)
    await vi.waitFor(() => expect(replaceTrack).toHaveBeenCalled())
    expect(newTrack.enabled).toBe(false)
    controller.abort()
    // Privacy is restored before the outstanding WebRTC operation resolves.
    expect(newTrack.enabled).toBe(false)
    expect(newTrack.stop).toHaveBeenCalled()
    resolve()
    expect(await pending).toBeNull()
    expect(nextReplaceTrack).not.toHaveBeenCalled()
    expect(local.tracks).toEqual([old])
    expect(old.stop).not.toHaveBeenCalled()
  })

  test('a cancelled sender replacement never clears or restores over the new browser owner', async () => {
    const controller = new AbortController()
    const newTrack = fakeTrack()
    const old = fakeTrack()
    const browserTrack = fakeTrack()
    const local = fakeLocalStream([old])
    let resolve!: () => void
    const sender = {
      track: old,
      replaceTrack: vi.fn(async (track: FakeTrack) => {
        sender.track = track
        await new Promise<void>((done) => (resolve = done))
      }),
    }
    const deps = depsWith({
      fresh: fakeFreshStream([newTrack]),
      local,
      senders: [sender],
    })
    deps.signal = controller.signal
    const pending = swapAudioInput('mic-2', deps, () => true)
    await vi.waitFor(() => expect(sender.track).toBe(newTrack))
    controller.abort()
    sender.track = browserTrack
    resolve()
    expect(await pending).toBeNull()
    expect(newTrack.stop).toHaveBeenCalled()
    expect(sender.track).toBe(browserTrack)
    expect(sender.replaceTrack).toHaveBeenCalledTimes(1)
    expect(local.tracks).toEqual([old])
  })

  test('an unresolved cancelled acquisition never blocks publication of the next capture', async () => {
    const controller = new AbortController()
    const newTrack = fakeTrack()
    const old = fakeTrack()
    const local = fakeLocalStream([old])
    const deps = depsWith({
      fresh: fakeFreshStream([newTrack]),
      local,
      senders: [{ track: old, replaceTrack: vi.fn(async () => {}) }],
    })
    let resolve!: (stream: MediaStream) => void
    deps.getUserMedia = () => new Promise((done) => (resolve = done))
    deps.signal = controller.signal
    const operations = new Set<Promise<void>>()
    deps.onReplaceTrack = (operation) => operations.add(operation)
    const pending = swapAudioInput('mic-2', deps, () => true)
    controller.abort()
    expect(operations.size).toBe(0)
    await Promise.all([...operations])
    // Publication can proceed even though acquisition is still unresolved.
    resolve(fakeFreshStream([newTrack]) as unknown as MediaStream)
    expect(await pending).toBeNull()
    expect(operations.size).toBe(0)
  })

  test('publication waits for native completion and stale sender retirement before reusing its sender', async () => {
    const controller = new AbortController()
    const newTrack = fakeTrack()
    const old = fakeTrack()
    const browserTrack = fakeTrack()
    const local = fakeLocalStream([old])
    let resolve!: () => void
    const sender: {
      track: FakeTrack | null
      replaceTrack: (track: FakeTrack) => Promise<void>
    } = {
      track: old,
      replaceTrack: vi.fn(async (track: FakeTrack) => {
        await new Promise<void>((done) => (resolve = done))
        sender.track = track
      }),
    }
    const deps = depsWith({
      fresh: fakeFreshStream([newTrack]),
      local,
      senders: [sender],
    })
    deps.signal = controller.signal
    const operations = new Set<Promise<void>>()
    deps.onReplaceTrack = (operation) => operations.add(operation)
    const pending = swapAudioInput('mic-2', deps, () => true)
    await vi.waitFor(() => expect(operations.size).toBe(1))
    controller.abort()
    let published = false
    const publication = (async () => {
      await Promise.all([...operations])
      expect(sender.track).toBeNull()
      sender.track = browserTrack
      published = true
    })()
    await Promise.resolve()
    expect(published).toBe(false)
    resolve()
    expect(await pending).toBeNull()
    await publication
    expect(sender.track).toBe(browserTrack)
    expect(newTrack.stop).toHaveBeenCalled()
    expect(local.tracks).toEqual([old])
  })

  test('cancellation after native completion retires the fresh sender before the local stream commits', async () => {
    const controller = new AbortController()
    const newTrack = fakeTrack()
    const old = fakeTrack()
    const local = fakeLocalStream([old])
    const sender = {
      track: old,
      replaceTrack: vi.fn(async (track: FakeTrack) => {
        sender.track = track
      }),
    }
    const deps = depsWith({
      fresh: fakeFreshStream([newTrack]),
      local,
      senders: [sender],
    })
    deps.signal = controller.signal
    deps.onReplaceTrack = (operation) => {
      void operation.then(() => controller.abort())
    }
    expect(await swapAudioInput('mic-2', deps, () => true)).toBeNull()
    expect(sender.track).toBeNull()
    expect(newTrack.enabled).toBe(false)
    expect(newTrack.stop).toHaveBeenCalled()
    expect(local.tracks).toEqual([old])
    expect(old.stop).not.toHaveBeenCalled()
  })

  test('a new room can publish while a retired room finishes its own native operation', async () => {
    const controller = new AbortController()
    const newTrack = fakeTrack()
    const old = fakeTrack()
    const local = fakeLocalStream([old])
    let resolve!: () => void
    const sender = {
      track: old,
      replaceTrack: vi.fn(async (track: FakeTrack) => {
        await new Promise<void>((done) => (resolve = done))
        sender.track = track
      }),
    }
    const deps = depsWith({
      fresh: fakeFreshStream([newTrack]),
      local,
      senders: [sender],
    })
    deps.signal = controller.signal
    const retiredRoomOperations = new Set<Promise<void>>()
    const nextRoomOperations = new Set<Promise<void>>()
    deps.onReplaceTrack = (operation) => {
      retiredRoomOperations.add(operation)
      void operation.then(() => retiredRoomOperations.delete(operation))
    }
    const pending = swapAudioInput('mic-2', deps, () => true)
    await vi.waitFor(() => expect(retiredRoomOperations.size).toBe(1))
    controller.abort()
    // A distinct room never reuses the old connection's native sender.
    await Promise.all([...nextRoomOperations])
    expect(retiredRoomOperations.size).toBe(1)
    expect(nextRoomOperations.size).toBe(0)
    resolve()
    expect(await pending).toBeNull()
    expect(retiredRoomOperations.size).toBe(0)
    expect(nextRoomOperations.size).toBe(0)
    expect(sender.track).toBeNull()
  })
})
