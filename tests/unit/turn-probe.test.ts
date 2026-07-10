import { describe, expect, test, vi } from 'vitest'

import { probeTurnServer } from '@/lib/turnProbe'

// #47 C5 — drives the probe with a scripted fake RTCPeerConnection (node has
// none). The fake exposes the candidate callback so each scenario can emit
// relay candidates, end-of-gathering, or nothing at all.

type FakePc = RTCPeerConnection & {
  emit: (candidate: Partial<RTCIceCandidate> | null) => void
}

function fakePc(opts?: { failOffer?: boolean }): {
  pc: FakePc
  closed: () => boolean
} {
  let closed = false
  const pc = {
    onicecandidate: null as
      | ((evt: { candidate: Partial<RTCIceCandidate> | null }) => void)
      | null,
    createDataChannel: () => ({}),
    createOffer: () =>
      opts?.failOffer
        ? Promise.reject(new Error('offer failed'))
        : Promise.resolve({}),
    setLocalDescription: () => Promise.resolve(),
    close: () => {
      closed = true
    },
    emit(candidate: Partial<RTCIceCandidate> | null) {
      this.onicecandidate?.({ candidate })
    },
  }
  return { pc: pc as unknown as FakePc, closed: () => closed }
}

const SERVER = {
  url: 'turn:turn.example.com:3478',
  username: 'u',
  credential: 'p',
}

describe('probeTurnServer (#47 C5)', () => {
  test('succeeds when a relay candidate gathers, reporting elapsed ms', async () => {
    const { pc, closed } = fakePc()
    let clock = 1_000
    const result = probeTurnServer(SERVER, {
      createPeerConnection: () => pc,
      now: () => clock,
    })
    clock = 3_500
    pc.emit({
      type: 'relay',
      candidate: 'candidate:1 1 udp 1 1.2.3.4 3478 typ relay',
    })
    await expect(result).resolves.toEqual({ ok: true, ms: 2_500 })
    expect(closed()).toBe(true)
  })

  test('fails with no-relay-candidate when gathering completes empty', async () => {
    const { pc } = fakePc()
    const result = probeTurnServer(SERVER, { createPeerConnection: () => pc })
    pc.emit(null)
    await expect(result).resolves.toEqual({
      ok: false,
      reason: 'no-relay-candidate',
    })
  })

  test('times out when nothing gathers', async () => {
    vi.useFakeTimers()
    try {
      const { pc, closed } = fakePc()
      const result = probeTurnServer(SERVER, {
        createPeerConnection: () => pc,
        timeoutMs: 10_000,
      })
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(result).resolves.toEqual({ ok: false, reason: 'timeout' })
      expect(closed()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  test('fails with error when the offer cannot be created', async () => {
    const { pc } = fakePc({ failOffer: true })
    await expect(
      probeTurnServer(SERVER, { createPeerConnection: () => pc })
    ).resolves.toEqual({ ok: false, reason: 'error' })
  })

  test('fails with error when the connection cannot be constructed', async () => {
    await expect(
      probeTurnServer(SERVER, {
        createPeerConnection: () => {
          throw new Error('no webrtc')
        },
      })
    ).resolves.toEqual({ ok: false, reason: 'error' })
  })
})
