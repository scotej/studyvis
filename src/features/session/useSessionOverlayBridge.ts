import { useEffect, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useSonner } from 'sonner'

import { useAlertsUiStore } from '@/features/ai/alertsUiStore'
import { useIdentityStore } from '@/stores/identityStore'
import { useSessionStore } from '@/stores/sessionStore'
import { strings } from '@/strings'

import { useNotesStore } from './notesStore'
import {
  overlayItemFromToast,
  overlayToastSignature,
  type SessionOverlayDismissPayload,
} from './sessionOverlay'
import {
  clearSessionOverlay,
  dismissSessionOverlayItem,
  markSessionOverlayReady,
  pushSessionOverlayItem,
  sessionOverlayEvents,
} from './sessionOverlayRuntime'

export function useSessionOverlayBridge(): void {
  const status = useSessionStore((state) => state.status)
  const seenPeerNames = useSessionStore((state) => state.seenPeerNames)
  const selfEdPubkey = useIdentityStore(
    (state) => state.identity?.ed_pubkey_hex ?? null
  )
  const selfDisplayName = useIdentityStore(
    (state) =>
      state.identity?.display_name?.trim() || strings.session.selfFallback
  )
  const selfWarning = useAlertsUiStore((state) => state.selfWarning)
  const alertedPeers = useAlertsUiStore((state) => state.alertedPeers)
  const notes = useNotesStore((state) => state.notes)
  const images = useNotesStore((state) => state.images)
  const { toasts } = useSonner()

  const toastSignatures = useRef(new Map<string, string>())
  const selfWarningKey = useRef<string | null>(null)
  const alertedKeys = useRef(new Set<string>())
  const noteIds = useRef(new Set<string>())
  const imageIds = useRef(new Set<string>())

  useEffect(() => {
    const activeIds = new Set<string>()
    for (const toast of [...toasts].reverse()) {
      const id = String(toast.id)
      activeIds.add(id)
      const signature = overlayToastSignature(toast)
      const previous = toastSignatures.current.get(id)
      toastSignatures.current.set(id, signature)
      if (status !== 'active' || previous === signature) continue
      const item = overlayItemFromToast(toast)
      if (item) void pushSessionOverlayItem(item)
    }
    for (const id of toastSignatures.current.keys()) {
      if (!activeIds.has(id)) toastSignatures.current.delete(id)
    }
  }, [status, toasts])

  useEffect(() => {
    if (!selfWarning) return
    const key = `${selfWarning.ts}:${selfWarning.reasoning}`
    if (selfWarningKey.current === key) return
    selfWarningKey.current = key
    if (status !== 'active') return
    void pushSessionOverlayItem({
      id: `self-warning:${key}`,
      title: strings.session.badges.selfWarningTitle,
      body: selfWarning.reasoning,
      tone: 'warning',
    })
  }, [selfWarning, status])

  useEffect(() => {
    const activeKeys = new Set<string>()
    for (const [edPubkey, alert] of Object.entries(alertedPeers)) {
      const key = `${edPubkey}:${alert.ts}`
      activeKeys.add(key)
      if (alertedKeys.current.has(key)) continue
      alertedKeys.current.add(key)
      if (status !== 'active') continue
      const name = resolveName(
        edPubkey,
        selfEdPubkey,
        selfDisplayName,
        seenPeerNames
      )
      void pushSessionOverlayItem({
        id: `off-task:${key}`,
        title: strings.session.focusStates.alerted,
        body: `${name}: ${alert.reasoning}`,
        tone: 'alerted',
      })
    }
    pruneSeen(alertedKeys.current, activeKeys)
  }, [
    alertedPeers,
    seenPeerNames,
    selfDisplayName,
    selfEdPubkey,
    status,
  ])

  useEffect(() => {
    const activeIds = new Set(notes.map((note) => note.id))
    for (const note of notes) {
      if (noteIds.current.has(note.id)) continue
      noteIds.current.add(note.id)
      if (status !== 'active' || note.mine) continue
      const name = resolveName(
        note.fromEdPubkeyHex,
        selfEdPubkey,
        selfDisplayName,
        seenPeerNames
      )
      void pushSessionOverlayItem({
        id: `note:${note.id}`,
        title: strings.session.notes.heading,
        body: `${name}: ${note.text}`,
        tone: 'neutral',
      })
    }
    pruneSeen(noteIds.current, activeIds)
  }, [notes, seenPeerNames, selfDisplayName, selfEdPubkey, status])

  useEffect(() => {
    const activeIds = new Set(images.map((image) => image.id))
    for (const image of images) {
      if (imageIds.current.has(image.id)) continue
      imageIds.current.add(image.id)
      if (status !== 'active' || image.mine) continue
      const name = resolveName(
        image.fromEdPubkeyHex,
        selfEdPubkey,
        selfDisplayName,
        seenPeerNames
      )
      void pushSessionOverlayItem({
        id: `image:${image.id}`,
        title: strings.session.images.viewerTitle(name),
        body: image.filename,
        tone: 'neutral',
      })
    }
    pruneSeen(imageIds.current, activeIds)
  }, [images, seenPeerNames, selfDisplayName, selfEdPubkey, status])

  useEffect(() => {
    if (status !== 'active') void clearSessionOverlay()
  }, [status])

  useEffect(() => {
    let cancelled = false
    const unlistens: Array<() => void> = []

    const register = async <T,>(
      eventName: string,
      handler: (payload: T) => void
    ): Promise<void> => {
      const off = await listen<T>(eventName, (event) => {
        if (!cancelled) handler(event.payload)
      })
      if (cancelled) {
        off()
        return
      }
      unlistens.push(off)
    }

    void register(sessionOverlayEvents.ready, () => {
      void markSessionOverlayReady()
    }).catch(() => {})
    void register<SessionOverlayDismissPayload>(
      sessionOverlayEvents.dismiss,
      (payload) => {
        if (payload && typeof payload.id === 'string') {
          void dismissSessionOverlayItem(payload.id)
        }
      }
    ).catch(() => {})

    const clear = () => {
      void clearSessionOverlay()
    }
    window.addEventListener('focus', clear)
    const clearWhenVisible = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) clear()
    }
    document.addEventListener('visibilitychange', clearWhenVisible)

    let offTauriFocus: (() => void) | null = null
    void getCurrentWindow()
      .listen('tauri://focus', clear)
      .then((off) => {
        if (cancelled) off()
        else offTauriFocus = off
      })
      .catch(() => {})

    return () => {
      cancelled = true
      window.removeEventListener('focus', clear)
      document.removeEventListener('visibilitychange', clearWhenVisible)
      offTauriFocus?.()
      for (const off of unlistens) off()
    }
  }, [])
}

function resolveName(
  edPubkey: string,
  selfEdPubkey: string | null,
  selfDisplayName: string,
  seenPeerNames: Record<string, string>
): string {
  if (edPubkey === selfEdPubkey) return selfDisplayName
  return seenPeerNames[edPubkey] ?? strings.session.peerFallback(edPubkey)
}

function pruneSeen(seen: Set<string>, active: Set<string>): void {
  for (const key of seen) {
    if (!active.has(key)) seen.delete(key)
  }
}
