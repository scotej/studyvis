import { describe, expect, test } from 'vitest'

const { createActionWireManager } = await import(
  new URL(
    '../../node_modules/@trystero-p2p/core/dist/action-wire.mjs',
    import.meta.url
  ).href
)

const TYPE = 'session-image'
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_FRAGMENT_BYTES = 16 * 1024 - 36
const MAX_TRANSMISSION_FRAGMENTS =
  Math.ceil(MAX_IMAGE_BYTES / MAX_FRAGMENT_BYTES) + 1
const MAX_IN_FLIGHT_TRANSMISSIONS = 32
const MAX_QUEUED_UNKNOWN_ACTIONS = 64
const encoder = new TextEncoder()

function frame(args: {
  nonce?: number
  tag: number
  payload: Uint8Array
  type?: string
}): ArrayBuffer {
  const bytes = new Uint8Array(36 + args.payload.byteLength)
  bytes.set(encoder.encode(args.type ?? TYPE), 0)
  bytes[32] = ((args.nonce ?? 1) >>> 8) & 0xff
  bytes[33] = (args.nonce ?? 1) & 0xff
  bytes[34] = args.tag
  bytes[35] = 255
  bytes.set(args.payload, 36)
  return bytes.buffer
}

function createWire() {
  let destroyed = false
  const peer = { destroy: () => (destroyed = true) }
  const wire = createActionWireManager({
    getPeer: () => peer,
    getPeerIds: () => ['peer-1'],
    canReceiveFromPeer: () => true,
    throwIfAborted: () => {},
  })
  return {
    ...wire,
    wasDestroyed: () => destroyed,
  }
}

describe('patched Trystero receive limits', () => {
  test('delivers a 5 MiB binary action with its small metadata', () => {
    const wire = createWire()
    const action = wire.makeInternalAction(TYPE)
    let received: Uint8Array | undefined
    action.onMessage((payload: Uint8Array) => {
      received = payload
    })

    const metadata = encoder.encode(JSON.stringify({ filename: 'note.png' }))
    wire.handleData('peer-1', frame({ tag: 6, payload: metadata }))
    wire.handleData(
      'peer-1',
      frame({ tag: 5, payload: new Uint8Array(MAX_IMAGE_BYTES) })
    )

    expect(wire.wasDestroyed()).toBe(false)
    expect(received).toHaveLength(MAX_IMAGE_BYTES)
  })

  test('terminates a peer before reassembling a payload above 5 MiB', () => {
    const wire = createWire()
    const action = wire.makeInternalAction(TYPE)
    const received: Uint8Array[] = []
    action.onMessage((payload: Uint8Array) => received.push(payload))

    wire.handleData(
      'peer-1',
      frame({ tag: 4, payload: new Uint8Array(MAX_IMAGE_BYTES) })
    )
    wire.handleData('peer-1', frame({ tag: 5, payload: new Uint8Array([1]) }))

    expect(wire.wasDestroyed()).toBe(true)
    expect(received).toEqual([])
  })

  test('terminates a peer before parsing oversized action metadata', () => {
    const wire = createWire()
    const action = wire.makeInternalAction(TYPE)
    action.onMessage(() => {
      throw new Error('oversized metadata must not be delivered')
    })

    wire.handleData(
      'peer-1',
      frame({ tag: 6, payload: new Uint8Array(16 * 1024 + 1) })
    )

    expect(wire.wasDestroyed()).toBe(true)
  })

  test('bounds completed, unregistered actions as well as reassembly', () => {
    const wire = createWire()

    wire.handleData(
      'peer-1',
      frame({ tag: 5, payload: new Uint8Array(MAX_IMAGE_BYTES) })
    )
    wire.handleData(
      'peer-1',
      frame({ tag: 4, payload: new Uint8Array(144 * 1024 + 1) })
    )

    expect(wire.wasDestroyed()).toBe(true)
  })

  test('terminates tiny-fragment flooding at the largest valid transmission shape', () => {
    const wire = createWire()

    for (let i = 0; i < MAX_TRANSMISSION_FRAGMENTS; i += 1) {
      wire.handleData('peer-1', frame({ tag: 4, payload: new Uint8Array([i]) }))
    }
    expect(wire.wasDestroyed()).toBe(false)

    wire.handleData('peer-1', frame({ tag: 4, payload: new Uint8Array([0]) }))
    expect(wire.wasDestroyed()).toBe(true)
  })

  test('terminates flooding of concurrent partial transmissions', () => {
    const wire = createWire()

    for (let nonce = 0; nonce < MAX_IN_FLIGHT_TRANSMISSIONS; nonce += 1) {
      wire.handleData(
        'peer-1',
        frame({ nonce, tag: 4, payload: new Uint8Array([nonce]) })
      )
    }
    expect(wire.wasDestroyed()).toBe(false)

    wire.handleData(
      'peer-1',
      frame({
        nonce: MAX_IN_FLIGHT_TRANSMISSIONS,
        tag: 4,
        payload: new Uint8Array([0]),
      })
    )
    expect(wire.wasDestroyed()).toBe(true)
  })

  test('terminates tiny completed unknown-action flooding at the queue cap', () => {
    const wire = createWire()

    for (let nonce = 0; nonce < MAX_QUEUED_UNKNOWN_ACTIONS; nonce += 1) {
      wire.handleData(
        'peer-1',
        frame({ nonce, tag: 5, payload: new Uint8Array([nonce]) })
      )
    }
    expect(wire.wasDestroyed()).toBe(false)

    wire.handleData(
      'peer-1',
      frame({
        nonce: MAX_QUEUED_UNKNOWN_ACTIONS,
        tag: 5,
        payload: new Uint8Array([0]),
      })
    )
    expect(wire.wasDestroyed()).toBe(true)
  })

  test('terminates malformed metadata without throwing from the data callback', () => {
    const wire = createWire()
    wire.makeInternalAction(TYPE)

    expect(() =>
      wire.handleData(
        'peer-1',
        frame({ tag: 6, payload: encoder.encode('{not-json') })
      )
    ).not.toThrow()
    expect(wire.wasDestroyed()).toBe(true)
  })

  test('treats an unregistered prototype-named action as unregistered', () => {
    const wire = createWire()

    expect(() =>
      wire.handleData(
        'peer-1',
        frame({
          type: 'toString',
          tag: 5,
          payload: new Uint8Array([1]),
        })
      )
    ).not.toThrow()
    expect(wire.wasDestroyed()).toBe(false)
  })

  test('keeps interleaved action nonces independent below the cap', () => {
    const wire = createWire()
    const action = wire.makeInternalAction(TYPE)
    const received: string[] = []
    action.onMessage((payload: Uint8Array) => {
      received.push(new TextDecoder().decode(payload))
    })

    wire.handleData(
      'peer-1',
      frame({ nonce: 1, tag: 4, payload: encoder.encode('a') })
    )
    wire.handleData(
      'peer-1',
      frame({ nonce: 2, tag: 4, payload: encoder.encode('x') })
    )
    wire.handleData(
      'peer-1',
      frame({ nonce: 1, tag: 5, payload: encoder.encode('b') })
    )
    wire.handleData(
      'peer-1',
      frame({ nonce: 2, tag: 5, payload: encoder.encode('y') })
    )

    expect(wire.wasDestroyed()).toBe(false)
    expect(received).toEqual(['ab', 'xy'])
  })

  test('releases reassembly accounting when a peer clears', () => {
    const wire = createWire()

    wire.handleData(
      'peer-1',
      frame({ nonce: 1, tag: 4, payload: new Uint8Array(4 * 1024 * 1024) })
    )
    wire.clearPeer('peer-1')
    wire.handleData(
      'peer-1',
      frame({ nonce: 2, tag: 4, payload: new Uint8Array(2 * 1024 * 1024) })
    )

    expect(wire.wasDestroyed()).toBe(false)
  })

  test('releases queued-action accounting when a peer clears', () => {
    const wire = createWire()

    // Fill both unknown-action budgets: one maximum payload proves byte
    // accounting resets, while 63 tiny messages bring the count to its cap.
    wire.handleData(
      'peer-1',
      frame({ nonce: 0, tag: 5, payload: new Uint8Array(MAX_IMAGE_BYTES) })
    )
    for (let nonce = 1; nonce < MAX_QUEUED_UNKNOWN_ACTIONS; nonce += 1) {
      wire.handleData(
        'peer-1',
        frame({ nonce, tag: 5, payload: new Uint8Array([nonce]) })
      )
    }
    expect(wire.wasDestroyed()).toBe(false)

    wire.clearPeer('peer-1')
    wire.handleData(
      'peer-1',
      frame({
        nonce: MAX_QUEUED_UNKNOWN_ACTIONS,
        tag: 5,
        payload: new Uint8Array(MAX_IMAGE_BYTES),
      })
    )

    expect(wire.wasDestroyed()).toBe(false)
  })

  test('releases queued message-count accounting before invoking callbacks', () => {
    const wire = createWire()

    // Queue two messages before the action is registered. The first callback
    // throws, so the second callback is never invoked and its payload is no
    // longer retained for a later registration.
    wire.handleData(
      'peer-1',
      frame({ nonce: 1, tag: 5, payload: new Uint8Array([1]) })
    )
    wire.handleData(
      'peer-1',
      frame({ nonce: 2, tag: 5, payload: new Uint8Array([2]) })
    )

    const action = wire.makeInternalAction(TYPE)
    expect(() =>
      action.onMessage(() => {
        throw new Error('consumer failed')
      })
    ).toThrow('consumer failed')

    // All detached entries must release their reservations even though the
    // consumer stopped delivery. Exactly 64 new unknown actions should fit.
    for (let nonce = 0; nonce < MAX_QUEUED_UNKNOWN_ACTIONS; nonce += 1) {
      wire.handleData(
        'peer-1',
        frame({
          nonce,
          tag: 5,
          payload: new Uint8Array([nonce]),
          type: 'future-action',
        })
      )
    }

    expect(wire.wasDestroyed()).toBe(false)
  })

  test('releases queued byte accounting before invoking callbacks', () => {
    const wire = createWire()

    wire.handleData(
      'peer-1',
      frame({ nonce: 1, tag: 5, payload: new Uint8Array([1]) })
    )
    wire.handleData(
      'peer-1',
      frame({ nonce: 2, tag: 5, payload: new Uint8Array(MAX_IMAGE_BYTES) })
    )

    const action = wire.makeInternalAction(TYPE)
    expect(() =>
      action.onMessage(() => {
        throw new Error('consumer failed')
      })
    ).toThrow('consumer failed')

    // A stale 5 MiB reservation would leave only 144 KiB of peer headroom,
    // so this otherwise-small unknown action would terminate the peer.
    wire.handleData(
      'peer-1',
      frame({
        nonce: 3,
        tag: 5,
        payload: new Uint8Array(144 * 1024 + 1),
        type: 'future-action',
      })
    )

    expect(wire.wasDestroyed()).toBe(false)
  })
})
