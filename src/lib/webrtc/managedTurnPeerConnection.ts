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

type PendingRenewal = {
  urls: string[]
  revision: number
  checking: boolean
  recheck?: boolean
}
type LiveConnection = {
  servers: RTCIceServer[]
  revision: number
  ready: boolean
  pending: PendingRenewal | null
}

function serverUrls(servers: RTCIceServer[]): string[] {
  return servers.flatMap((server) =>
    Array.isArray(server.urls) ? server.urls : [server.urls]
  )
}

type IceStats = {
  id: string
  type: string
  selectedCandidatePairId?: string
  localCandidateId?: string
  candidateType?: string
  nominated?: boolean
  state?: string
  url?: string
}

function selectedManagedRelay(
  report: RTCStatsReport,
  urls: string[]
): boolean | null {
  const stats = [...report.values()] as IceStats[]
  const pairIds = stats.flatMap((entry) =>
    entry.type === 'transport' && entry.selectedCandidatePairId
      ? [entry.selectedCandidatePairId]
      : []
  )
  const pairs = stats.filter(
    (entry) =>
      entry.type === 'candidate-pair' &&
      (pairIds.length > 0
        ? pairIds.includes(entry.id)
        : entry.nominated && entry.state === 'succeeded')
  )
  if (pairs.length === 0) return null
  let unknown = false
  for (const pair of pairs) {
    const local = stats.find((entry) => entry.id === pair.localCandidateId)
    if (!local?.candidateType) {
      unknown = true
    } else if (
      local.candidateType === 'relay' &&
      (!local.url || urls.includes(local.url))
    ) {
      return true
    }
  }
  return unknown ? null : false
}

// Trystero's shared warm-offer pool retains its first room configuration.
// Read the lease at native construction, and rotate live configurations before
// expiration without rebuilding rooms or interrupting their media streams.
export function createManagedTurnPeerConnection(
  Base: PeerConnectionConstructor,
  source: ManagedTurnSource
): PeerConnectionConstructor {
  const live = new Map<RTCPeerConnection, LiveConnection>()

  const renewAllocation = async (
    connection: RTCPeerConnection,
    state: LiveConnection,
    pending: PendingRenewal | null = state.pending,
    retry = true
  ): Promise<void> => {
    const current = () =>
      live.get(connection) === state &&
      state.pending === pending &&
      state.revision === pending?.revision &&
      state.ready &&
      connection.connectionState === 'connected'
    if (!pending || !current()) return
    if (pending.checking) {
      pending.recheck = true
      return
    }
    pending.checking = true
    try {
      const report = await connection.getStats()
      if (!current() || pending.recheck) return
      const relay = selectedManagedRelay(report, pending.urls)
      if (relay === true) {
        // PR-499: setConfiguration leaves the selected allocation on its old
        // credential. Trystero owns negotiationneeded and signals the restart
        // over the existing authenticated room while that allocation is live.
        connection.restartIce()
        state.pending = null
      } else if (relay === null && retry) {
        setTimeout(() => {
          void renewAllocation(connection, state, pending, false)
        }, 1_000)
      } else if (relay === null) {
        log.warn('configuration.path_unavailable')
      }
    } catch {
      if (!current()) return
      if (retry) {
        setTimeout(() => {
          void renewAllocation(connection, state, pending, false)
        }, 1_000)
      } else {
        log.warn('configuration.renewal_failed')
      }
    } finally {
      pending.checking = false
      if (pending.recheck) {
        pending.recheck = false
        void renewAllocation(connection, state, pending)
      }
    }
  }

  source.subscribeIceServers(() => {
    for (const [connection, state] of live) {
      if (connection.connectionState === 'closed') {
        live.delete(connection)
        continue
      }
      try {
        const previous = state.servers
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
        state.servers = next
        const changed =
          previous.length !== next.length ||
          previous.some((server, index) => !sameServer(server, next[index]))
        if (changed) {
          state.revision += 1
          state.pending =
            previous.length > 0 && next.length > 0
              ? {
                  urls: [
                    ...new Set([
                      ...(state.pending?.urls ?? []),
                      ...serverUrls(previous),
                    ]),
                  ],
                  revision: state.revision,
                  checking: false,
                }
              : null
          void renewAllocation(connection, state)
        }
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
      const state: LiveConnection = {
        servers,
        revision: 0,
        ready: false,
        pending: null,
      }
      live.set(connection, state)
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
      // PR-499: native connected can precede Trystero's password handshake.
      // Its ready event proves the existing room can carry restart signaling.
      connection.addEventListener('studyvis:trystero-pending', () => {
        state.ready = false
      })
      connection.addEventListener('studyvis:trystero-ready', () => {
        state.ready = true
        void renewAllocation(connection, state)
      })
      connection.addEventListener('connectionstatechange', () => {
        if (connection.connectionState === 'closed') live.delete(connection)
        else void renewAllocation(connection, state)
      })
      return connection
    },
  })
}
