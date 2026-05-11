// V2-P6 — UI state for the focus-detection feedback layer.
//
// Two pieces of state live here, both with built-in TTL dismissal so the
// dispatcher / components don't have to manage timers themselves:
//
//   * `selfWarning`  — the private "Heads up — looking off-task" badge the
//     off-task user sees. Cleared on the next on_task sample OR after
//     `WARNING_TTL_MS` (30 s), whichever fires first. Never broadcast.
//
//   * `alertedPeers` — a map keyed by ed_pubkey_hex of the participants
//     currently in the alerted state. Used by SessionView to:
//       - light up that user's tile-border in `status.alerted`,
//       - render the reasoning text inline on the tile,
//       - play the soft peer-alert tone (once per (peer, ts) entry — the
//         dispatcher does the sound, not the store).
//     Entries auto-expire after `PEER_ALERT_TTL_MS` (30 s) because the
//     score machine latches `alertedThisStreak` and emits exactly one
//     alert per streak — there is no "alert ended" signal on the wire.
//
// The store exposes a `setRuntime` test seam so vitest can drive auto-
// dismissal with fake timers (`vi.useFakeTimers`).
//
// Privacy invariant (V2-P5 carry-forward): neither the `selfWarning` nor
// any `alertedPeers` entry carries `deduction` or `scoreAfter`. The
// running numeric score stays inside `useFocusStore.machine` until V2-P8
// builds the post-session report.

import { create } from 'zustand'

import type { Severity } from './parseJudgment'

export type AlertSeverity = Exclude<Severity, 'on_task'>

export type SelfWarningState = {
  reasoning: string
  severity: AlertSeverity
  // Wall-clock ms when the warning fired. Used by SelfWarningBadge to
  // re-render relative timestamps and by tests for ordering checks.
  ts: number
}

export type AlertedPeerEntry = {
  edPubkeyHex: string
  reasoning: string
  severity: AlertSeverity
  ts: number
}

// 30 s TTL matches the self-warning's auto-dismiss window. The advisor
// flagged that the alert latches in the score machine (one per streak) so
// there is no "alert ended" signal; we time it out instead. 30 s is long
// enough for users to notice + react in the manual two-peer test and short
// enough that the tile-border doesn't linger past the moment.
export const PEER_ALERT_TTL_MS = 30_000
export const WARNING_TTL_MS = 30_000

export type AlertsUiRuntime = {
  setTimeout: (handler: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const defaultRuntime: AlertsUiRuntime = {
  setTimeout: (handler, ms) =>
    typeof window === 'undefined'
      ? globalThis.setTimeout(handler, ms)
      : window.setTimeout(handler, ms),
  clearTimeout: (handle) => {
    if (typeof window === 'undefined') {
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
    } else {
      window.clearTimeout(handle as number)
    }
  },
}

let activeRuntime: AlertsUiRuntime = defaultRuntime

export function __setAlertsUiRuntime(runtime: AlertsUiRuntime): void {
  activeRuntime = runtime
}

export function __resetAlertsUiRuntime(): void {
  activeRuntime = defaultRuntime
}

type AlertsUiState = {
  selfWarning: SelfWarningState | null
  alertedPeers: Record<string, AlertedPeerEntry>
  setSelfWarning: (warning: SelfWarningState) => void
  clearSelfWarning: () => void
  setAlertedPeer: (entry: AlertedPeerEntry) => void
  clearAlertedPeer: (edPubkeyHex: string) => void
  reset: () => void
}

// Module-level so a fresh `useAlertsUiStore` (after Vitest module reload)
// gets a clean handle map. Stored outside the Zustand state because handles
// are opaque to React; serializing them with the state would just be noise.
let warningTimer: unknown | null = null
const peerTimers = new Map<string, unknown>()

function clearWarningTimer(): void {
  if (warningTimer !== null) {
    activeRuntime.clearTimeout(warningTimer)
    warningTimer = null
  }
}

function clearPeerTimer(edPubkeyHex: string): void {
  const handle = peerTimers.get(edPubkeyHex)
  if (handle !== undefined) {
    activeRuntime.clearTimeout(handle)
    peerTimers.delete(edPubkeyHex)
  }
}

function clearAllTimers(): void {
  clearWarningTimer()
  for (const edPubkeyHex of Array.from(peerTimers.keys())) {
    clearPeerTimer(edPubkeyHex)
  }
}

export const useAlertsUiStore = create<AlertsUiState>((set) => ({
  selfWarning: null,
  alertedPeers: {},

  setSelfWarning: (warning) => {
    clearWarningTimer()
    set({ selfWarning: warning })
    warningTimer = activeRuntime.setTimeout(() => {
      warningTimer = null
      set({ selfWarning: null })
    }, WARNING_TTL_MS)
  },

  clearSelfWarning: () => {
    clearWarningTimer()
    set({ selfWarning: null })
  },

  setAlertedPeer: (entry) => {
    clearPeerTimer(entry.edPubkeyHex)
    set((state) => ({
      alertedPeers: { ...state.alertedPeers, [entry.edPubkeyHex]: entry },
    }))
    const handle = activeRuntime.setTimeout(() => {
      peerTimers.delete(entry.edPubkeyHex)
      set((state) => {
        if (!(entry.edPubkeyHex in state.alertedPeers)) return state
        const next = { ...state.alertedPeers }
        delete next[entry.edPubkeyHex]
        return { alertedPeers: next }
      })
    }, PEER_ALERT_TTL_MS)
    peerTimers.set(entry.edPubkeyHex, handle)
  },

  clearAlertedPeer: (edPubkeyHex) => {
    clearPeerTimer(edPubkeyHex)
    set((state) => {
      if (!(edPubkeyHex in state.alertedPeers)) return state
      const next = { ...state.alertedPeers }
      delete next[edPubkeyHex]
      return { alertedPeers: next }
    })
  },

  reset: () => {
    clearAllTimers()
    set({ selfWarning: null, alertedPeers: {} })
  },
}))
