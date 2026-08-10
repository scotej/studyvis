// F6 — Nostr relays don't buffer for an absent peer, so an invite sent while a
// friend's app is closed always times out and is never delivered. This manager
// holds an unconfirmed invite "pending" for a short window and re-attempts
// delivery the moment that friend's presence flips online. A transport send
// alone is not delivery: only a signature-verified recipient ACK suppresses
// retries, so a third party on the derivable inbox topic cannot acknowledge an
// invite on the recipient's behalf.
//
// Dedupe key: an invite is identified by (recipient ed_pubkey, session_topic).
// A given study session is a single rendezvous; once the recipient ACKs an
// envelope, no retry for the same (recipient, session) is allowed, even if
// presence flickers online→offline→online repeatedly. The host re-clicking
// Invite for the SAME live session reuses the same session_topic, so it
// collapses onto the one pending entry rather than queuing duplicates.
//
// Lifetime: a pending entry expires after RETRY_WINDOW_MS (so a friend who
// comes online an hour later doesn't get yanked into a long-dead session) and
// is cancelled wholesale when the host's session ends or the user cancels.
//
// Pure + dependency-injected so the unit test drives it with a fake clock and
// an in-memory deliver spy — no trystero, no React.

export const RETRY_WINDOW_MS = 3 * 60 * 1000

// The transport reports whether a signed ACK from the intended recipient was
// verified. A fulfilled but unacknowledged send remains retryable.
export type InviteDeliveryResult = { acked: boolean }

// A cancellation signal lets cancel/cancelAll tear down an in-flight retry's
// room wait or ACK linger. Implementations that cannot physically abort are
// still safe: the manager invalidates their entry before awaiting completion.
export type InviteDeliver = (
  signal: AbortSignal
) => Promise<InviteDeliveryResult>

type PendingEntry = {
  recipientEdPubkeyHex: string
  sessionTopic: string
  deliver: InviteDeliver
  registeredAt: number
  inFlight: boolean
  abortController: AbortController | null
  cancelled: boolean
}

export type InviteRetryDeps = {
  now?: () => number
  windowMs?: number
  // Surfaced when a retry attempt itself fails (developer-facing log only).
  onRetryError?: (err: unknown) => void
  // PR-9 — guard a queued retry against a session the host has already left.
  // A retry is registered only after the up-to-15s send times out, so a
  // session that ended DURING that window escapes cancelAll and would later
  // yank the friend into a dead room. Checked at delivery time (in
  // onPresenceOnline, before each send) so a retry never fires for a session
  // that isn't the host's current live one. Omitted → no guard (the pure unit
  // tests drive delivery directly).
  isSessionLive?: (sessionTopic: string) => boolean
}

export type InviteRetryManager = {
  // Record a pending retry for (recipient, session). No-op if this pair was
  // already ACK-confirmed. Replaces a non-in-flight entry for the same pair.
  register: (
    recipientEdPubkeyHex: string,
    sessionTopic: string,
    deliver: InviteDeliver
  ) => void
  // Mark (recipient, session) as delivered so it never retries again. Call
  // only after a signature-verified ACK from the intended recipient.
  markDelivered: (recipientEdPubkeyHex: string, sessionTopic: string) => void
  // A friend just flipped online. Retry every non-expired pending entry for
  // them. Awaitable so tests can flush the deliveries deterministically.
  onPresenceOnline: (recipientEdPubkeyHex: string) => Promise<void>
  // Drop all pending entries for a recipient (e.g. they came online and we no
  // longer need the safety net — optional) — currently used by cancelAll.
  cancel: (recipientEdPubkeyHex: string) => void
  // Drop every pending entry and completed-delivery dedupe state (host's
  // session ended, or the user cancelled).
  cancelAll: () => void
  // Test/debug introspection.
  pendingCount: () => number
}

function keyOf(recipientEdPubkeyHex: string, sessionTopic: string): string {
  return `${recipientEdPubkeyHex}|${sessionTopic}`
}

export function createInviteRetryManager(
  deps: InviteRetryDeps = {}
): InviteRetryManager {
  const now = deps.now ?? (() => Date.now())
  const windowMs = deps.windowMs ?? RETRY_WINDOW_MS
  // delivered set persists across pending-entry expiry so a late presence flip
  // can never re-deliver an already-delivered invite.
  const delivered = new Set<string>()
  const pending = new Map<string, PendingEntry>()

  const isExpired = (entry: PendingEntry): boolean =>
    now() - entry.registeredAt >= windowMs

  const isCurrent = (key: string, entry: PendingEntry): boolean =>
    pending.get(key) === entry && !entry.cancelled

  const invalidate = (entry: PendingEntry): void => {
    entry.cancelled = true
    entry.inFlight = false
    entry.abortController?.abort()
    entry.abortController = null
  }

  const discard = (key: string, entry: PendingEntry): void => {
    if (!isCurrent(key, entry)) return
    invalidate(entry)
    pending.delete(key)
  }

  return {
    register(recipientEdPubkeyHex, sessionTopic, deliver) {
      const key = keyOf(recipientEdPubkeyHex, sessionTopic)
      if (delivered.has(key)) return
      const existing = pending.get(key)
      // Never replace a retry that is already sending; doing so would let the
      // old continuation delete or mark delivered the replacement entry.
      if (existing?.inFlight) return
      if (existing) invalidate(existing)
      pending.set(key, {
        recipientEdPubkeyHex,
        sessionTopic,
        deliver,
        registeredAt: now(),
        inFlight: false,
        abortController: null,
        cancelled: false,
      })
    },

    markDelivered(recipientEdPubkeyHex, sessionTopic) {
      const key = keyOf(recipientEdPubkeyHex, sessionTopic)
      const entry = pending.get(key)
      if (entry) invalidate(entry)
      delivered.add(key)
      pending.delete(key)
    },

    async onPresenceOnline(recipientEdPubkeyHex) {
      const candidates: PendingEntry[] = []
      for (const entry of pending.values()) {
        if (entry.recipientEdPubkeyHex !== recipientEdPubkeyHex) continue
        if (entry.cancelled || entry.inFlight) continue
        const key = keyOf(entry.recipientEdPubkeyHex, entry.sessionTopic)
        if (isExpired(entry)) {
          discard(key, entry)
          continue
        }
        // PR-9 — the host may have left this session while the retry sat
        // pending. Never deliver an invite for a session that is no longer the
        // host's live one — that would drop the friend into an empty room.
        if (deps.isSessionLive && !deps.isSessionLive(entry.sessionTopic)) {
          discard(key, entry)
          continue
        }
        candidates.push(entry)
      }
      for (const entry of candidates) {
        const key = keyOf(entry.recipientEdPubkeyHex, entry.sessionTopic)
        // `cancel`, `cancelAll`, or a newer register may have invalidated this
        // entry after candidate collection but before its turn in the loop.
        if (!isCurrent(key, entry)) continue
        if (deps.isSessionLive && !deps.isSessionLive(entry.sessionTopic)) {
          discard(key, entry)
          continue
        }
        entry.inFlight = true
        const abortController = new AbortController()
        entry.abortController = abortController
        try {
          const result = await entry.deliver(abortController.signal)
          // A cancellation may occur while a delivery implementation is
          // settling. Never let that stale continuation resurrect the entry or
          // suppress a later invite, even if the transport cannot abort.
          if (!isCurrent(key, entry) || abortController.signal.aborted) {
            continue
          }
          entry.inFlight = false
          entry.abortController = null
          // A session can end while the retry is waiting for a peer or ACK.
          // cancelAll normally aborts it, while this second guard closes the
          // gap if lifecycle state changes before its cleanup runs.
          if (deps.isSessionLive && !deps.isSessionLive(entry.sessionTopic)) {
            discard(key, entry)
            continue
          }
          // Only an ACK verified by sendInviteEnvelope proves the intended
          // friend received the envelope. An unconfirmed transport send stays
          // pending for a future presence transition.
          if (!result.acked) continue
          delivered.add(key)
          pending.delete(key)
        } catch (err) {
          if (!isCurrent(key, entry) || abortController.signal.aborted) {
            continue
          }
          entry.inFlight = false
          entry.abortController = null
          deps.onRetryError?.(err)
        }
      }
    },

    cancel(recipientEdPubkeyHex) {
      for (const [key, entry] of pending) {
        if (entry.recipientEdPubkeyHex === recipientEdPubkeyHex) {
          invalidate(entry)
          pending.delete(key)
        }
      }
    },

    cancelAll() {
      for (const entry of pending.values()) invalidate(entry)
      pending.clear()
      // Dedupe keys are scoped to a session topic. Once that lifecycle ends,
      // retaining them only leaks process memory and makes the singleton
      // retry manager carry completed deliveries into the next lifecycle.
      delivered.clear()
    },

    pendingCount() {
      return pending.size
    },
  }
}
