// #264 — a transient ICE `disconnected` must not end a study session.
//
// trystero declares a peer closed 5 s after its RTCPeerConnection reports
// `disconnected` (`disconnectedCloseDelayMs` in @trystero-p2p/core's peer.mjs),
// and that detaches EVERY room for that friend — session, presence and inbox
// alike, since one connection is shared across all of them. Worse, it does
// not close the connection: `SharedPeerManager.clear(…, {destroyPeer: false})`
// leaves it open with our senders still attached, which is why #264's reporter
// kept appearing LIVE to their friend while their own session sat empty. The
// friend's side then goes on reading that connection as a healthy connected
// peer and drops every offer we send, so the session cannot re-form until it
// is actually shut — `closeTransport` below, called from
// features/session/lifecycle.ts on the way out. Five seconds is shorter than
// an ordinary Wi-Fi roam and far shorter than the multi-second process stalls
// a saturated machine produces while the on-device model runs: #264 lost a
// ten-minute session to a 5.5 s stall.
//
// `disconnected` is the recoverable state in the WebRTC state machine and
// `failed` is the terminal one, so this wrapper reports the standard posture:
// hold a post-`connected` `disconnected` back for HOLD_MS, then tell the
// truth and let trystero's own timer run. `failed`, `closed`, and every
// healthy state pass through untouched and immediately, and a connection that
// has never reached `connected` is never held (a failing handshake must still
// fail fast). It is installed through trystero's documented `rtcPolyfill`
// hook, so the ICE agent gets the window the spec assumes it has to revive a
// candidate pair in place, without a fork.
//
// This does NOT mask a peer who deliberately leaves: trystero's `leaveAction`
// arrives over the data channel and a remote teardown closes that channel,
// and neither path reads connection state. The hold only extends the window
// when nothing arrives at all — which is exactly a network outage.

import { logger } from '@/lib/log'

const log = logger.child('p2p.transport')

// How long a post-`connected` `disconnected` is held back before it is
// reported. Sized to cover the 5.5–9.2 s process stalls observed in #264 with
// room to spare, while staying under the ~30 s ICE consent-freshness expiry
// that produces a real `failed` (which is never held). Worst case a genuinely
// departed peer takes this plus trystero's own 5 s to disappear.
export const TRANSIENT_DISCONNECT_HOLD_MS = 20_000

export type TransportHealth = {
  // The last `connectionState` seen while the connection was live. Read at
  // peer-leave time to tell a clean remote departure ('connected') from a
  // transport loss ('disconnected' / 'failed'). It is needed because the
  // instantaneous state does not answer the question: trystero declares a
  // peer gone WITHOUT closing its connection, so by then the state may read
  // anything from 'disconnected' to a recovered 'connected'.
  lastLiveConnectionState: RTCPeerConnectionState
  // Wall-clock ms at which the ICE agent first reported `disconnected` in the
  // current degraded stretch, or null while the transport is healthy.
  degradedSinceMs: number | null
  // True while a `disconnected` is being held back from readers.
  holding: boolean
}

export type PeerConnectionConstructor = typeof RTCPeerConnection

const health = new WeakMap<RTCPeerConnection, TransportHealth>()
const dataChannels = new WeakMap<RTCPeerConnection, Set<RTCDataChannel>>()

// Null for any connection this module did not wrap — the in-process test bus,
// or an engine whose state accessors could not be found. Callers treat that as
// "no transport evidence" and keep their prior behavior.
export function transportHealthOf(
  connection: RTCPeerConnection | null | undefined
): TransportHealth | null {
  return connection ? (health.get(connection) ?? null) : null
}

function accessorOf(target: object, key: string): (() => unknown) | null {
  let proto: object | null = Object.getPrototypeOf(target) as object | null
  while (proto) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key)
    if (descriptor?.get) return descriptor.get
    proto = Object.getPrototypeOf(proto) as object | null
  }
  return null
}

// Shadows `connectionState` / `iceConnectionState` on the instance and holds a
// post-`connected` `disconnected` back for `holdMs`. Exported for unit tests,
// which install it over a fake connection; production goes through
// `createResilientPeerConnection`.
export function installTransientDisconnectHold(
  connection: RTCPeerConnection,
  holdMs: number = TRANSIENT_DISCONNECT_HOLD_MS
): void {
  const readConnection = accessorOf(connection, 'connectionState')
  const readIce = accessorOf(connection, 'iceConnectionState')
  // An engine that exposes these as own data properties rather than prototype
  // accessors cannot be shadowed safely. Leave it exactly as trystero found
  // it — but say so, because BOTH halves of the #264 fix depend on this
  // running, and a silent no-op would look identical to a working build in
  // the next diagnostics bundle.
  if (!readConnection || !readIce) {
    log.warn('hold.unavailable', {
      hasConnectionAccessor: readConnection !== null,
      hasIceAccessor: readIce !== null,
    })
    return
  }

  const realConnectionState = (): RTCPeerConnectionState =>
    readConnection.call(connection) as RTCPeerConnectionState
  const realIceConnectionState = (): RTCIceConnectionState =>
    readIce.call(connection) as RTCIceConnectionState

  const state: TransportHealth = {
    lastLiveConnectionState: realConnectionState(),
    degradedSinceMs: null,
    holding: false,
  }
  health.set(connection, state)

  let everConnected = false
  // One hold per degraded stretch: after it expires the truth stays visible
  // until the transport recovers, so the expiry dispatch below cannot re-arm
  // it and loop.
  let holdSpent = false
  let heldIceState: RTCIceConnectionState = 'connected'
  let holdTimer: ReturnType<typeof setTimeout> | null = null

  // Retires an armed hold. `degradedSinceMs` deliberately survives: the
  // departure path in features/session reads it AFTER trystero has closed the
  // connection, to report how long the link had been degraded when it died.
  // Only a recovery clears it.
  const release = () => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer)
      holdTimer = null
    }
    state.holding = false
  }

  Object.defineProperty(connection, 'connectionState', {
    configurable: true,
    enumerable: false,
    get: () => {
      const real = realConnectionState()
      return state.holding && real === 'disconnected' ? 'connected' : real
    },
  })
  Object.defineProperty(connection, 'iceConnectionState', {
    configurable: true,
    enumerable: false,
    get: () => {
      const real = realIceConnectionState()
      return state.holding && real === 'disconnected' ? heldIceState : real
    },
  })

  const onRealStateChange = () => {
    const connectionState = realConnectionState()
    const iceConnectionState = realIceConnectionState()
    if (connectionState !== 'closed') {
      state.lastLiveConnectionState = connectionState
    }

    if (
      connectionState === 'failed' ||
      connectionState === 'closed' ||
      iceConnectionState === 'failed' ||
      iceConnectionState === 'closed'
    ) {
      release()
      return
    }

    if (
      connectionState !== 'disconnected' &&
      iceConnectionState !== 'disconnected'
    ) {
      if (connectionState === 'connected') everConnected = true
      if (
        iceConnectionState === 'connected' ||
        iceConnectionState === 'completed'
      ) {
        heldIceState = iceConnectionState
      }
      if (state.degradedSinceMs !== null) {
        log.info('hold.recovered', {
          degradedForMs: Date.now() - state.degradedSinceMs,
          held: state.holding,
        })
        state.degradedSinceMs = null
      }
      release()
      holdSpent = false
      return
    }

    state.degradedSinceMs ??= Date.now()
    if (state.holding || holdSpent || !everConnected) return
    state.holding = true
    log.info('hold.armed', { holdMs, connectionState, iceConnectionState })
    holdTimer = setTimeout(() => {
      holdTimer = null
      state.holding = false
      holdSpent = true
      // close() mutates state without firing an event, so a hold can outlive
      // the connection it was guarding. Nothing left to tell anyone.
      if (realConnectionState() === 'closed') return
      log.warn('hold.expired', {
        holdMs,
        connectionState: realConnectionState(),
        iceConnectionState: realIceConnectionState(),
      })
      // Republish the truth so every reader — trystero's own close timer
      // included — re-evaluates against the now-visible `disconnected`.
      connection.dispatchEvent(new Event('connectionstatechange'))
      connection.dispatchEvent(new Event('iceconnectionstatechange'))
    }, holdMs)
  }

  // Remembered so `closeTransport` can shut them before the connection, the
  // way trystero's own peer.destroy() does. A bare pc.close() tells the remote
  // nothing — it waits out ICE consent (~30 s) before noticing — whereas
  // closing the channel is an SCTP stream reset it receives at once.
  const channels = new Set<RTCDataChannel>()
  dataChannels.set(connection, channels)
  if (typeof connection.createDataChannel === 'function') {
    const createDataChannel = connection.createDataChannel.bind(connection)
    Object.defineProperty(connection, 'createDataChannel', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: (label: string, init?: RTCDataChannelInit) => {
        const channel = createDataChannel(label, init)
        channels.add(channel)
        return channel
      },
    })
  }
  connection.addEventListener('datachannel', (event) => {
    channels.add(event.channel)
  })

  // close() mutates state without dispatching an event, so nothing else would
  // ever retire an armed hold on a connection trystero has already destroyed.
  if (typeof connection.close === 'function') {
    const close = connection.close.bind(connection)
    Object.defineProperty(connection, 'close', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: () => {
        release()
        close()
      },
    })
  }

  // Registered before trystero attaches its own handlers, so the hold is
  // already applied by the time trystero reads the state for this event.
  connection.addEventListener('connectionstatechange', onRealStateChange)
  connection.addEventListener('iceconnectionstatechange', onRealStateChange)
}

// #264 — shut a connection trystero abandoned open.
//
// On an unclean close trystero calls `SharedPeerManager.clear(…,
// {destroyPeer: false})`, which empties `shared.bindings` before firing each
// binding's close handler — so the `detachBinding` that would have removed our
// senders early-returns, and the connection is left running with the camera
// and screen still attached to a peer the app has already reported gone. It
// leaves the FAR side pinned to it — their `state.connectedPeer` still points
// here, it still reads healthy because our data channel never closed, and
// trystero drops all signaling for such a peer — so the session cannot
// re-form until this connection is actually shut.
//
// Ordering matches trystero's own `peer.destroy()`: data channels first, so
// the remote learns from an SCTP stream reset instead of waiting out ICE
// consent, then the connection. A no-op on a connection already closed, and
// safe on one this module never wrapped (it simply has no channels recorded).
export function closeTransport(
  connection: RTCPeerConnection | null | undefined
): void {
  if (!connection || connection.connectionState === 'closed') return
  for (const channel of dataChannels.get(connection) ?? []) {
    try {
      channel.close()
    } catch {
      // Already gone with the connection; the close below is what matters.
    }
  }
  if (typeof connection.close === 'function') connection.close()
}

// Wraps a peer-connection constructor so every instance trystero builds gets
// the hold. A Proxy over the constructor keeps the public type intact: trystero
// only ever calls `new rtcPolyfill(config)`.
export function createResilientPeerConnection(
  Base: PeerConnectionConstructor,
  holdMs: number = TRANSIENT_DISCONNECT_HOLD_MS
): PeerConnectionConstructor {
  return new Proxy(Base, {
    construct(target, args) {
      const connection = Reflect.construct(
        target,
        args
      ) as unknown as RTCPeerConnection
      installTransientDisconnectHold(connection, holdMs)
      return connection
    },
  })
}
