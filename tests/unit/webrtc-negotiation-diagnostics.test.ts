import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { __resetLog, recentRecords } from '@/lib/log'
import { createResilientPeerConnection } from '@/lib/webrtc/resilientPeerConnection'

class FakeConnection extends EventTarget {
  signalingState: RTCSignalingState = 'have-local-offer'

  get connectionState(): RTCPeerConnectionState {
    return 'connecting'
  }

  get iceConnectionState(): RTCIceConnectionState {
    return 'checking'
  }
}

const operations = [
  'setLocalDescription',
  'setRemoteDescription',
  'addIceCandidate',
] as const

function harness(
  operation: (typeof operations)[number],
  native: (...args: unknown[]) => unknown
) {
  class NativeConnection extends FakeConnection {}
  Object.defineProperty(NativeConnection.prototype, operation, {
    configurable: true,
    writable: true,
    value: native,
  })
  const Constructor = createResilientPeerConnection(
    NativeConnection as unknown as typeof RTCPeerConnection
  )
  return new Constructor()
}

function failures() {
  return recentRecords().filter((record) =>
    record.msg.startsWith('negotiation.')
  )
}

describe('native negotiation diagnostics', () => {
  beforeEach(() => {
    __resetLog()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetLog()
  })

  test.each(operations)(
    'reports %s rejection without recording signaling contents',
    async (operation) => {
      const sensitive = 'candidate:1 1 UDP 1 192.0.2.123 12345 typ host'
      const error = new DOMException(sensitive, 'OperationError')
      const native = vi.fn().mockRejectedValue(error)
      const connection = harness(operation, native)
      const input = {
        type: 'offer' as const,
        sdp: 'v=0\na=ice-pwd:private-password',
        candidate: sensitive,
        sdpMid: 'private-mid',
      }

      await expect(
        Reflect.apply(connection[operation], connection, [input])
      ).rejects.toBe(error)

      expect(native).toHaveBeenCalledExactlyOnceWith(input)
      expect(native.mock.contexts).toEqual([connection])
      expect(failures()).toHaveLength(1)
      expect(failures()[0]).toMatchObject({
        scope: 'p2p.transport',
        lvl: 'warn',
        msg: `negotiation.${operation}.failed`,
        data: {
          errorName: 'OperationError',
          connectionState: 'connecting',
          signalingState: 'have-local-offer',
          iceConnectionState: 'checking',
        },
      })
      expect(Object.keys(failures()[0].data ?? {}).sort()).toEqual([
        'connectionState',
        'errorName',
        'iceConnectionState',
        'signalingState',
      ])
      const serialized = JSON.stringify(recentRecords())
      for (const secret of [sensitive, input.sdp, input.sdpMid]) {
        expect(serialized).not.toContain(secret)
      }
    }
  )

  test('categorizes arbitrary error names and primitive rejections', async () => {
    const failuresToReturn = [
      { name: 'private-peer-id', message: 'private SDP' },
      'private candidate address',
    ]
    for (const error of failuresToReturn) {
      __resetLog()
      const connection = harness('setLocalDescription', () =>
        Promise.reject(error)
      )

      await expect(connection.setLocalDescription()).rejects.toBe(error)

      expect(failures()[0].data?.errorName).toBe('unknown')
      expect(JSON.stringify(recentRecords())).not.toContain('private')
    }
  })

  test('preserves synchronous throws without converting them to promises', () => {
    const error = new TypeError('private SDP')
    const native = vi.fn(() => {
      throw error
    })
    const connection = harness('setRemoteDescription', native)
    let caught: unknown

    try {
      connection.setRemoteDescription({ type: 'offer' })
    } catch (failure) {
      caught = failure
    }

    expect(caught).toBe(error)
    expect(native).toHaveBeenCalledOnce()
    expect(failures()[0].data?.errorName).toBe('TypeError')
    expect(JSON.stringify(recentRecords())).not.toContain('private SDP')
  })

  test.each(operations)(
    'preserves %s receiver, callback arguments, and successful value',
    async (operation) => {
      const value = { complete: true }
      const native = vi.fn().mockResolvedValue(value)
      const connection = harness(operation, native)
      const otherReceiver = new FakeConnection()
      const description = { type: 'offer' as const }
      const onSuccess = vi.fn()
      const onFailure = vi.fn()

      await expect(
        Reflect.apply(connection[operation], otherReceiver, [
          description,
          onSuccess,
          onFailure,
        ])
      ).resolves.toBe(value)

      expect(native.mock.contexts).toEqual([otherReceiver])
      expect(native).toHaveBeenCalledExactlyOnceWith(
        description,
        onSuccess,
        onFailure
      )
      expect(failures()).toEqual([])
    }
  )

  test('leaves callback-only return values unchanged', () => {
    const native = vi.fn(() => undefined)
    const connection = harness('addIceCandidate', native)

    expect(connection.addIceCandidate()).toBeUndefined()
    expect(native).toHaveBeenCalledExactlyOnceWith()
    expect(failures()).toEqual([])
  })

  test('diagnostic accessors cannot replace a rejection', async () => {
    const error = Object.defineProperty({}, 'name', {
      get() {
        throw new Error('unreadable error name')
      },
    })
    const connection = harness('setLocalDescription', () =>
      Promise.reject(error)
    )

    await expect(connection.setLocalDescription()).rejects.toBe(error)
  })

  test('does not add missing methods to minimal connection implementations', () => {
    const Constructor = createResilientPeerConnection(
      FakeConnection as unknown as typeof RTCPeerConnection
    )
    const connection = new Constructor()

    for (const operation of operations) {
      expect(operation in connection).toBe(false)
    }
    expect(failures()).toEqual([])
  })
})
