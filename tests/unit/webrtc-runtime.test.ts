import { describe, expect, test, vi } from 'vitest'
import {
  canCreatePeerConnectionOffer,
  type PeerConnectionConstructor,
} from '@/lib/webrtcRuntime'

describe('canCreatePeerConnectionOffer', () => {
  test('rejects an absent WebRTC constructor', async () => {
    await expect(canCreatePeerConnectionOffer(undefined)).resolves.toBe(false)
  })

  test('creates a data channel offer, applies it, and closes', async () => {
    const close = vi.fn()
    const createDataChannel = vi.fn()
    const offer = { type: 'offer', sdp: 'v=0' }
    const createOffer = vi.fn().mockResolvedValue(offer)
    const setLocalDescription = vi.fn().mockResolvedValue(undefined)
    class WorkingPeerConnection {
      close = close
      createDataChannel = createDataChannel
      createOffer = createOffer
      setLocalDescription = setLocalDescription
    }

    await expect(
      canCreatePeerConnectionOffer(WorkingPeerConnection)
    ).resolves.toBe(true)
    expect(createDataChannel).toHaveBeenCalledWith('studyvis-startup-probe')
    expect(createOffer).toHaveBeenCalledOnce()
    expect(setLocalDescription).toHaveBeenCalledWith(offer)
    expect(close).toHaveBeenCalledOnce()
  })

  test('rejects a constructor whose native backend cannot initialise', async () => {
    const BrokenPeerConnection = class {
      constructor() {
        throw new Error('native WebRTC unavailable')
      }

      createDataChannel(): void {}
      async createOffer(): Promise<RTCSessionDescriptionInit> {
        return { type: 'offer' }
      }
      async setLocalDescription(): Promise<void> {}
      close(): void {}
    } as PeerConnectionConstructor

    await expect(
      canCreatePeerConnectionOffer(BrokenPeerConnection)
    ).resolves.toBe(false)
  })

  test('rejects a backend that cannot create an offer and still closes', async () => {
    const close = vi.fn()
    class BrokenOfferPeerConnection {
      close = close
      createDataChannel(): void {}
      async createOffer(): Promise<RTCSessionDescriptionInit> {
        throw new Error('offer failed')
      }
      async setLocalDescription(): Promise<void> {}
    }

    await expect(
      canCreatePeerConnectionOffer(BrokenOfferPeerConnection)
    ).resolves.toBe(false)
    expect(close).toHaveBeenCalledOnce()
  })
})
