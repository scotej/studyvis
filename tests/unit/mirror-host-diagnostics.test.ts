import { afterEach, describe, expect, test, vi } from 'vitest'

import { hasLanAddress, reachableAddresses } from '@/features/mirror/addresses'
import {
  createMirrorHost,
  readMirrorDiagnostic,
} from '@/features/mirror/runtime'
import { createMirrorPeer } from '@/features/mirror/peer'
import {
  cameraPayload,
  hasLiveVideo,
  readCameraPayload,
  relayTracksEverPublished,
  swapRelayTracks,
} from '@/features/session/companionMedia'

const doubles = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({}) as unknown),
  events: new Map<string, (event: { payload: unknown }) => void>(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: doubles.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (name: string, listener: (event: { payload: unknown }) => void) => {
      doubles.events.set(name, listener)
      return () => {
        if (doubles.events.get(name) === listener) doubles.events.delete(name)
      }
    }
  ),
}))
vi.mock('@/features/mirror/peer', () => ({
  createMirrorPeer: vi.fn(() => ({
    close: vi.fn(),
    receive: vi.fn(),
    setCapture: vi.fn(),
    setStreams: vi.fn(),
  })),
}))

afterEach(() => {
  doubles.events.clear()
  vi.clearAllMocks()
})

const config = {
  password: 'PASSWORD',
  fingerprint: 'aa',
  expiresAt: 0,
  generation: 'g',
}

describe('#515 companion reachability', () => {
  test('lists every non-loopback address in preference order', () => {
    expect(
      reachableAddresses({
        ...config,
        urls: [
          'https://192.168.1.4:9000',
          'https://172.20.0.1:9000',
          'https://127.0.0.1:9000',
        ],
        certificateUrl: 'http://192.168.1.4:9001/certificate.crt',
        certificateUrls: [
          'http://192.168.1.4:9001/certificate.crt',
          'http://172.20.0.1:9001/certificate.crt',
          'http://127.0.0.1:9001/certificate.crt',
        ],
      })
    ).toEqual([
      {
        url: 'https://192.168.1.4:9000',
        host: '192.168.1.4',
        loopback: false,
        certificateUrl: 'http://192.168.1.4:9001/certificate.crt',
      },
      {
        url: 'https://172.20.0.1:9000',
        host: '172.20.0.1',
        loopback: false,
        certificateUrl: 'http://172.20.0.1:9001/certificate.crt',
      },
    ])
    // With no LAN address the loopback link still serves this computer's
    // browser (and the CI companion fixture), behind the loopback warning.
    const loopbackOnly = {
      ...config,
      urls: ['https://127.0.0.1:9000'],
      certificateUrl: 'http://127.0.0.1:9001/certificate.crt',
    }
    expect(reachableAddresses(loopbackOnly)).toEqual([
      {
        url: 'https://127.0.0.1:9000',
        host: '127.0.0.1',
        loopback: true,
        certificateUrl: 'http://127.0.0.1:9001/certificate.crt',
      },
    ])
    expect(hasLanAddress(loopbackOnly)).toBe(false)
  })

  test('accepts only well-formed diagnostics', () => {
    expect(
      readMirrorDiagnostic(
        { address: '100.72.4.9', problem: 'blocked_network' },
        5
      )
    ).toEqual({ address: '100.72.4.9', problem: 'blocked_network', at: 5 })
    for (const value of [
      null,
      { address: '<script>', problem: 'certificate' },
      { address: '10.0.0.1', problem: 'other' },
      { problem: 'certificate' },
    ])
      expect(readMirrorDiagnostic(value, 0)).toBeNull()
  })

  test('host forwards diagnostics and the observed browser address', async () => {
    const onDiagnostic = vi.fn()
    const host = createMirrorHost({
      onControl: vi.fn(),
      onCapture: vi.fn(),
      onConnected: vi.fn(),
      onDiagnostic,
    })
    await host.start('a'.repeat(64))
    doubles.events.get('mirror:diagnostic')!({
      payload: { address: '192.168.1.40', problem: 'certificate' },
    })
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        address: '192.168.1.40',
        problem: 'certificate',
      })
    )
    doubles.events.get('mirror:client')!({
      payload: { clientId: 'one', connected: true, address: '192.168.1.40' },
    })
    expect(createMirrorPeer).toHaveBeenLastCalledWith(
      expect.objectContaining({ role: 'host', remoteAddress: '192.168.1.40' })
    )
    doubles.events.get('mirror:client')!({
      payload: { clientId: 'two', connected: true },
    })
    expect(createMirrorPeer).toHaveBeenLastCalledWith(
      expect.objectContaining({ remoteAddress: null })
    )
    await host.stop()
  })
})

describe('#515 companion camera state', () => {
  test('companion setup always reads as camera off for older peers', () => {
    expect(cameraPayload(true, true)).toEqual({ off: true, companion: true })
    expect(cameraPayload(false, false)).toEqual({ off: true })
    expect(cameraPayload(true, false)).toEqual({ off: false })
    expect(readCameraPayload({ off: true, companion: true })).toEqual({
      off: true,
      companion: true,
    })
    // A pre-#515 payload carries no companion flag.
    expect(readCameraPayload({ off: false })).toEqual({
      off: false,
      companion: false,
    })
    expect(readCameraPayload('junk')).toEqual({ off: false, companion: false })
  })

  test('a muted or ended receiver is not live video', () => {
    const stream = (tracks: Partial<MediaStreamTrack>[]) =>
      ({ getVideoTracks: () => tracks }) as unknown as MediaStream
    expect(hasLiveVideo(null)).toBe(false)
    expect(hasLiveVideo(stream([{ readyState: 'live', muted: false }]))).toBe(
      true
    )
    expect(hasLiveVideo(stream([{ readyState: 'live', muted: true }]))).toBe(
      false
    )
    expect(hasLiveVideo(stream([{ readyState: 'ended', muted: false }]))).toBe(
      false
    )
  })
})

describe('#515 companion relay', () => {
  const track = (kind: string, id: string) =>
    ({ kind, id }) as unknown as MediaStreamTrack
  const fakeStream = (tracks: MediaStreamTrack[]) => {
    const list = [...tracks]
    return {
      getTracks: () => [...list],
      getVideoTracks: () => list.filter((t) => t.kind === 'video'),
      getAudioTracks: () => list.filter((t) => t.kind === 'audio'),
      removeTrack: (t: MediaStreamTrack) => list.splice(list.indexOf(t), 1),
      addTrack: (t: MediaStreamTrack) => list.push(t),
    } as unknown as MediaStream
  }
  const sender = (initial: MediaStreamTrack | null) => {
    const value = {
      track: initial,
      replaceTrack: vi.fn(async (next: MediaStreamTrack | null) => {
        value.track = next
      }),
    }
    return value
  }

  test('commits the relay and replaces every sender in place', async () => {
    const oldVideo = track('video', 'old-v')
    const oldAudio = track('audio', 'old-a')
    const newVideo = track('video', 'new-v')
    const newAudio = track('audio', 'new-a')
    const relay = fakeStream([oldVideo, oldAudio])
    const first = [sender(oldVideo), sender(oldAudio), sender(null)]
    const joined = [sender(oldVideo), sender(oldAudio)]
    let peers = [{ getSenders: () => first as unknown as RTCRtpSender[] }]
    const operations: Promise<void>[] = []
    const swapped = await swapRelayTracks({
      relay,
      next: fakeStream([newVideo, newAudio]),
      peers: () => {
        const current = peers
        // #381 — a peer joins with the old relay tracks mid-swap.
        peers = [
          ...peers,
          { getSenders: () => joined as unknown as RTCRtpSender[] },
        ]
        return current
      },
      isCurrent: () => true,
      onReplaceTrack: (operation) => operations.push(operation),
    })
    expect(swapped).toBe(true)
    expect(first.map((s) => s.track)).toEqual([newVideo, newAudio, null])
    expect(joined.map((s) => s.track)).toEqual([newVideo, newAudio])
    expect(operations).toHaveLength(4)
    expect(relay.getTracks()).toEqual([newVideo, newAudio])
  })

  test('an interrupted swap is reconciled by the next swap and teardown', async () => {
    // Verified review finding D1: ownership lost mid-swap must not strand a
    // sender on an intermediate track that later swaps can no longer find.
    const a = track('video', 'a')
    const b = track('video', 'b')
    const c = track('video', 'c')
    const relay = fakeStream([a])
    const swappedFirst = sender(a)
    const notYet = sender(a)
    let current = true
    swappedFirst.replaceTrack.mockImplementation(async (next) => {
      swappedFirst.track = next
      current = false
    })
    const peers = () => [
      {
        getSenders: () => [swappedFirst, notYet] as unknown as RTCRtpSender[],
      },
    ]
    expect(
      await swapRelayTracks({
        relay,
        next: fakeStream([b]),
        peers,
        isCurrent: () => current,
      })
    ).toBe(false)
    expect(swappedFirst.track).toBe(b)
    expect(notYet.track).toBe(a)
    current = true
    swappedFirst.replaceTrack.mockImplementation(async (next) => {
      swappedFirst.track = next
    })
    expect(
      await swapRelayTracks({
        relay,
        next: fakeStream([c]),
        peers,
        isCurrent: () => current,
      })
    ).toBe(true)
    expect([swappedFirst.track, notYet.track]).toEqual([c, c])
    expect(relay.getTracks()).toEqual([c])
    expect(new Set(relayTracksEverPublished(relay))).toEqual(new Set([a, b, c]))
  })

  test('a failed replacement does not loop forever', async () => {
    const oldVideo = track('video', 'old-v')
    const relay = fakeStream([oldVideo])
    const stuck = sender(oldVideo)
    stuck.replaceTrack.mockRejectedValue(new Error('closed'))
    const swapped = await swapRelayTracks({
      relay,
      next: fakeStream([track('video', 'new-v')]),
      peers: () => [{ getSenders: () => [stuck] as unknown as RTCRtpSender[] }],
      isCurrent: () => true,
    })
    expect(swapped).toBe(true)
    expect(stuck.replaceTrack).toHaveBeenCalledTimes(1)
  })
})
