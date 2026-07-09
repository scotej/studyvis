// F6 — Nostr relays don't buffer for an absent peer, so an invite sent while a
// friend's app is closed always times out and is never delivered. This manager
// holds a just-failed invite "pending" for a short window and re-attempts
// delivery the moment that friend's presence flips online — without ever
// letting the same invite reach a friend twice.
//
// Dedupe key: an invite is identified by (recipient ed_pubkey, session_topic).
// A given study session is a single rendezvous; once that envelope is delivered
// to that friend, no retry for the same (recipient, session) is allowed, even
// if presence flickers online→offline→online repeatedly. The host re-clicking
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

export type InviteDeliver = () => Promise<void>

type PendingEntry = {
  recipientEdPubkeyHex: string
  sessionTopic: string
  deliver: InviteDeliver
  registeredAt: number
  delivered: boolean
  inFlight: boolean
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
  // already delivered. Replaces a stale (expired) entry for the same pair.
  register: (
    recipientEdPubkeyHex: string,
    sessionTopic: string,
    deliver: InviteDeliver
  ) => void
  // Mark (recipient, session) as delivered so it never retries again. Called
  // on a successful first send AND on a successful retry.
  markDelivered: (recipientEdPubkeyHex: string, sessionTopic: string) => void
  // A friend just flipped online. Retry every non-expired pending entry for
  // them. Awaitable so tests can flush the deliveries deterministically.
  onPresenceOnline: (recipientEdPubkeyHex: string) => Promise<void>
  // Drop all pending entries for a recipient (e.g. they came online and we no
  // longer need the safety net — optional) — currently used by cancelAll.
  cancel: (recipientEdPubkeyHex: string) => void
  // Drop every pending entry (host's session ended, or the user cancelled).
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

  return {
    register(recipientEdPubkeyHex, sessionTopic, deliver) {
      const key = keyOf(recipientEdPubkeyHex, sessionTopic)
      if (delivered.has(key)) return
      pending.set(key, {
        recipientEdPubkeyHex,
        sessionTopic,
        deliver,
        registeredAt: now(),
        delivered: false,
        inFlight: false,
      })
    },

    markDelivered(recipientEdPubkeyHex, sessionTopic) {
      const key = keyOf(recipientEdPubkeyHex, sessionTopic)
      delivered.add(key)
      pending.delete(key)
    },

    async onPresenceOnline(recipientEdPubkeyHex) {
      const candidates: PendingEntry[] = []
      for (const entry of pending.values()) {
        if (entry.recipientEdPubkeyHex !== recipientEdPubkeyHex) continue
        if (entry.delivered || entry.inFlight) continue
        if (isExpired(entry)) {
          pending.delete(keyOf(entry.recipientEdPubkeyHex, entry.sessionTopic))
          continue
        }
        // PR-9 — the host may have left this session while the retry sat
        // pending. Never deliver an invite for a session that is no longer the
        // host's live one — that would drop the friend into an empty room.
        if (deps.isSessionLive && !deps.isSessionLive(entry.sessionTopic)) {
          pending.delete(keyOf(entry.recipientEdPubkeyHex, entry.sessionTopic))
          continue
        }
        candidates.push(entry)
      }
      for (const entry of candidates) {
        entry.inFlight = true
        try {
          await entry.deliver()
          // Mark delivered (and remove) only after a successful send so a
          // failed retry can be re-attempted on the next presence flip.
          const key = keyOf(entry.recipientEdPubkeyHex, entry.sessionTopic)
          delivered.add(key)
          pending.delete(key)
        } catch (err) {
          entry.inFlight = false
          deps.onRetryError?.(err)
        }
      }
    },

    cancel(recipientEdPubkeyHex) {
      for (const [key, entry] of pending) {
        if (entry.recipientEdPubkeyHex === recipientEdPubkeyHex) {
          pending.delete(key)
        }
      }
    },

    cancelAll() {
      pending.clear()
    },

    pendingCount() {
      return pending.size
    },
  }
}
