// In-memory NIP-01 relay for the lab. Speaks exactly the subset trystero's
// Nostr strategy and StudyVis's own presence pool depend on:
//
//   ["REQ", subId, filter]  -> streamed ["EVENT", subId, event] + ["EOSE", subId]
//   ["EVENT", event]        -> ["OK", id, true, ""] + live fan-out to matching subs
//   ["CLOSE", subId]        -> drop the subscription
//
// Ephemeral only: nothing is stored, which matches the kind ranges both callers
// use (trystero derives kind 20000+hash(topic); presence uses 20001) and keeps
// the relay honest about the one property rendezvous actually needs — a live
// subscriber hears a publish that happens after it subscribed.
//
// Signatures are NOT verified. A relay that rejected unsigned events would only
// re-test @noble; the lab's job is transport semantics. `faults` exists so a
// scenario can reproduce the failure modes the shipped relay list has actually
// hit in the field (see src/lib/trystero/relayUrls.ts).

import { createServer, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'

export type NostrEvent = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export type NostrFilter = {
  ids?: string[]
  authors?: string[]
  kinds?: number[]
  since?: number
  until?: number
} & Record<`#${string}`, string[] | undefined>

export type NostrRelayFaults = {
  /** Answer every publish with ["OK", id, false, reason] — a relay that has
   *  started requiring proof of work or web-of-trust membership. */
  rejectPublish?: string | null
  /** Accept the publish but never fan it out — the silent-blackhole relay. */
  dropEvents?: boolean
  /** Close every connection the moment it opens — a dark relay. */
  refuseConnections?: boolean
}

export type NostrRelayStats = {
  connections: number
  openConnections: number
  events: number
  subscriptions: number
  delivered: number
}

export type NostrRelayHandle = {
  url: string
  port: number
  faults: NostrRelayFaults
  stats: () => NostrRelayStats
  close: () => Promise<void>
}

type Subscription = { socket: WebSocket; subId: string; filter: NostrFilter }

function matches(filter: NostrFilter, event: NostrEvent): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  // `since`/`until` are applied against the PUBLISHER's created_at, exactly as a
  // real relay does. That is what makes a peer with a skewed clock invisible to
  // trystero's `since: now()` announce filter (#47 C1) reproducible here.
  if (filter.since !== undefined && event.created_at < filter.since)
    return false
  if (filter.until !== undefined && event.created_at > filter.until)
    return false
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(values)) continue
    const letter = key.slice(1)
    const tagValues = event.tags
      .filter((tag) => tag[0] === letter)
      .map((tag) => tag[1])
    const wanted = values as string[]
    if (!wanted.some((value) => tagValues.includes(value))) return false
  }
  return true
}

export async function startNostrRelay(
  faults: NostrRelayFaults = {}
): Promise<NostrRelayHandle> {
  const http = createServer()
  const wss = new WebSocketServer({ server: http })
  const subs = new Set<Subscription>()
  const stats: NostrRelayStats = {
    connections: 0,
    openConnections: 0,
    events: 0,
    subscriptions: 0,
    delivered: 0,
  }

  wss.on('connection', (socket) => {
    stats.connections += 1
    stats.openConnections += 1
    if (faults.refuseConnections) {
      socket.close(1013, 'lab: relay marked offline')
      return
    }

    socket.on('message', (raw) => {
      let frame: unknown
      try {
        frame = JSON.parse(String(raw))
      } catch {
        return
      }
      if (!Array.isArray(frame)) return
      const [type] = frame as [string, ...unknown[]]

      if (type === 'REQ') {
        const [, subId, ...filters] = frame as [
          string,
          string,
          ...NostrFilter[],
        ]
        for (const filter of filters) {
          subs.add({ socket, subId, filter })
          stats.subscriptions += 1
        }
        socket.send(JSON.stringify(['EOSE', subId]))
        return
      }

      if (type === 'CLOSE') {
        const [, subId] = frame as [string, string]
        for (const sub of subs) {
          if (sub.socket === socket && sub.subId === subId) subs.delete(sub)
        }
        return
      }

      if (type === 'EVENT') {
        const [, event] = frame as [string, NostrEvent]
        if (!event?.id) return
        stats.events += 1
        if (faults.rejectPublish) {
          socket.send(
            JSON.stringify(['OK', event.id, false, faults.rejectPublish])
          )
          return
        }
        socket.send(JSON.stringify(['OK', event.id, true, '']))
        if (faults.dropEvents) return
        for (const sub of subs) {
          if (sub.socket.readyState !== sub.socket.OPEN) continue
          if (!matches(sub.filter, event)) continue
          sub.socket.send(JSON.stringify(['EVENT', sub.subId, event]))
          stats.delivered += 1
        }
      }
    })

    socket.on('close', () => {
      stats.openConnections -= 1
      for (const sub of subs) if (sub.socket === socket) subs.delete(sub)
    })
  })

  const port = await listen(http)
  return {
    url: `ws://127.0.0.1:${port}`,
    port,
    faults,
    stats: () => ({ ...stats }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate()
        wss.close(() => http.close(() => resolve()))
      }),
  }
}

export function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('lab: server did not bind a TCP port'))
        return
      }
      resolve(address.port)
    })
  })
}
