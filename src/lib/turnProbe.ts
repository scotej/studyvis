// #47 C5 — reachability probe for the user-supplied TURN server. The form
// only validates URL shape and the "active" line reflects storage, not
// reachability — so the exact user who needs TURN (strict NAT/CGNAT) can't
// tell a typo'd credential from a network problem until a session dies.
//
// The probe opens a throwaway RTCPeerConnection pinned to the one server
// with iceTransportPolicy 'relay' (host/srflx candidates are suppressed) and
// reports whether a relay candidate gathers before the timeout. It contacts
// ONLY the user's own configured server — no new third-party endpoint.

export type TurnProbeServer = {
  url: string
  username: string
  credential: string
}

export type TurnProbeResult =
  | { ok: true; ms: number }
  | { ok: false; reason: 'timeout' | 'no-relay-candidate' | 'error' }

export type TurnProbeDeps = {
  // Test seam — node has no RTCPeerConnection.
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection
  timeoutMs?: number
  now?: () => number
}

export const TURN_PROBE_TIMEOUT_MS = 10_000

export function probeTurnServer(
  server: TurnProbeServer,
  deps: TurnProbeDeps = {}
): Promise<TurnProbeResult> {
  const timeoutMs = deps.timeoutMs ?? TURN_PROBE_TIMEOUT_MS
  const now = deps.now ?? (() => Date.now())
  const create =
    deps.createPeerConnection ?? ((config) => new RTCPeerConnection(config))
  const started = now()

  let pc: RTCPeerConnection
  try {
    pc = create({
      iceServers: [
        {
          urls: server.url,
          username: server.username,
          credential: server.credential,
        },
      ],
      iceTransportPolicy: 'relay',
    })
  } catch {
    return Promise.resolve({ ok: false, reason: 'error' })
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (result: TurnProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        pc.close()
      } catch {
        // already closed
      }
      resolve(result)
    }
    const timer = setTimeout(
      () => finish({ ok: false, reason: 'timeout' }),
      timeoutMs
    )

    pc.onicecandidate = (evt) => {
      if (evt.candidate === null) {
        // Gathering completed without a relay candidate: the server answered
        // DNS/STUN-wise but allocation failed (bad credentials, blocked UDP).
        finish({ ok: false, reason: 'no-relay-candidate' })
        return
      }
      // Under iceTransportPolicy 'relay' every surfaced candidate IS a relay
      // candidate; the explicit checks are belt-and-braces across engines.
      const isRelay =
        evt.candidate.type === 'relay' ||
        / typ relay( |$)/.test(evt.candidate.candidate ?? '')
      if (isRelay) {
        finish({ ok: true, ms: now() - started })
      }
    }

    try {
      pc.createDataChannel('turn-probe')
      void pc
        .createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => finish({ ok: false, reason: 'error' }))
    } catch {
      finish({ ok: false, reason: 'error' })
    }
  })
}
