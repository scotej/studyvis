import { logger } from '@/lib/log'
import type { PeerConnectionConstructor } from './resilientPeerConnection'

type ManagedTurnSource = {
  getIceServers: () => RTCIceServer[]
  subscribeIceServers: (listener: () => void) => () => void
}

const log = logger.child('webrtc.managed-turn')

function sameServer(a: RTCIceServer, b: RTCIceServer): boolean {
  return (
    a.username === b.username &&
    a.credential === b.credential &&
    JSON.stringify(a.urls) === JSON.stringify(b.urls)
  )
}

// Trystero's shared warm-offer pool retains its first room configuration.
// Read the lease at native construction, and rotate live configurations before
// expiration without rebuilding rooms or interrupting their media streams.
export function createManagedTurnPeerConnection(
  Base: PeerConnectionConstructor,
  source: ManagedTurnSource
): PeerConnectionConstructor {
  const live = new Map<RTCPeerConnection, RTCIceServer[]>()

  source.subscribeIceServers(() => {
    for (const [connection, previous] of live) {
      if (connection.connectionState === 'closed') {
        live.delete(connection)
        continue
      }
      try {
        const config = connection.getConfiguration()
        const next =
          config.iceTransportPolicy === 'relay' ? [] : source.getIceServers()
        const retained = (config.iceServers ?? []).filter(
          (server) => !previous.some((managed) => sameServer(server, managed))
        )
        connection.setConfiguration({
          ...config,
          iceServers: [...retained, ...next],
        })
        live.set(connection, next)
      } catch {
        // Native exceptions can contain URLs/credentials. Record only the
        // failure category; a failed update remains retryable at renewal.
        log.warn('configuration.update_failed')
      }
    }
  })

  return new Proxy(Base, {
    construct(target, args) {
      const config = (args[0] ?? {}) as RTCConfiguration
      const servers =
        config.iceTransportPolicy === 'relay' ? [] : source.getIceServers()
      const connection = Reflect.construct(target, [
        { ...config, iceServers: [...(config.iceServers ?? []), ...servers] },
        ...args.slice(1),
      ]) as RTCPeerConnection
      live.set(connection, servers)
      const close = connection.close
      connection.close = new Proxy(close, {
        apply(target, receiver, closeArgs) {
          try {
            return Reflect.apply(target, receiver, closeArgs)
          } finally {
            live.delete(connection)
          }
        },
      })
      connection.addEventListener('connectionstatechange', () => {
        if (connection.connectionState === 'closed') live.delete(connection)
      })
      return connection
    },
  })
}
