import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { VideoGrid } from '@/components/VideoGrid'
import { VideoTile } from '@/components/VideoTile'
import { useIdentity } from '@/features/identity'
import { isMacLikePlatform } from '@/lib/utils'
import { useSessionStore } from '@/stores/sessionStore'
import { usePttStore } from '@/stores/pttStore'

import { PTT_STATE_ACTION } from './lifecycle'

const MEDIA_CONSTRAINTS: MediaStreamConstraints = { video: true, audio: true }

type PttPayload = { active: boolean }

// Composed session feature surface (DESIGN-SYSTEM.md §8.3): tiles for self +
// each peer, PTT-driven mute on the local audio track, a bottom bar with the
// PTT hint + free-form timer + Leave button. Mounted whenever the session
// store reports an active session.
export function SessionView() {
  const room = useSessionStore((s) => s.room)
  const sessionLeave = useSessionStore((s) => s.leave)
  const startedAt = useSessionStore((s) => s.startedAt)
  const peers = useSessionStore((s) => s.peers)
  const { identity } = useIdentity()
  const pttActive = usePttStore((s) => s.active)

  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [remoteStreams, setRemoteStreams] = useState<
    Record<string, MediaStream>
  >({})
  const [peerPtt, setPeerPtt] = useState<Record<string, boolean>>({})
  const localStreamRef = useRef<MediaStream | null>(null)
  const pttSendRef = useRef<((payload: PttPayload) => Promise<void[]>) | null>(
    null
  )

  // Capture the camera + mic once per active session and add the resulting
  // MediaStream to the trystero room. trystero forwards new tracks to all
  // current peers and to peers who join later (Context7 docs / README §
  // Stream Audio and Video).
  useEffect(() => {
    if (!room) return
    let cancelled = false
    let acquiredStream: MediaStream | null = null
    void (async () => {
      try {
        const stream =
          await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS)
        if (cancelled) {
          stopTracks(stream)
          return
        }
        acquiredStream = stream
        // Default-muted (PLAN.md §5: "Default-muted; PTT key unmutes only
        // while held."). The PTT effect below toggles enabled-ness.
        for (const t of stream.getAudioTracks()) t.enabled = false
        room.addStream(stream)
        setLocalStream(stream)
        localStreamRef.current = stream
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'camera / mic unavailable'
        setMediaError(message)
      }
    })()
    return () => {
      cancelled = true
      if (acquiredStream) {
        try {
          room.removeStream(acquiredStream)
        } catch {
          // best-effort
        }
        stopTracks(acquiredStream)
      }
      localStreamRef.current = null
      setLocalStream(null)
    }
  }, [room])

  // Bind peer streams to per-peer state. trystero replays existing peers when
  // we register the stream callback, so this works for both already-present
  // peers and joiners. We also drop stream + PTT entries when a peer leaves
  // — this keeps cleanup inside an event callback so the lint rule against
  // "setState synchronously inside an effect body" doesn't fire.
  useEffect(() => {
    if (!room) return
    room.onPeerStream((stream, peerId) => {
      setRemoteStreams((cur) => ({ ...cur, [peerId]: stream }))
      const cur = useSessionStore.getState().peers[peerId]
      if (cur) useSessionStore.getState().setPeerStream(peerId, true)
    })
    room.onPeerLeave((peerId) => {
      setRemoteStreams((cur) => {
        if (!(peerId in cur)) return cur
        const next = { ...cur }
        delete next[peerId]
        return next
      })
      setPeerPtt((cur) => {
        if (!(peerId in cur)) return cur
        const next = { ...cur }
        delete next[peerId]
        return next
      })
    })
  }, [room])

  // PTT broadcast: send our active-state on every change so peers can render
  // the PTT indicator. ARCHITECTURE.md §7's data channel carries this.
  useEffect(() => {
    if (!room) return
    const action = room.makeAction<PttPayload>(PTT_STATE_ACTION)
    pttSendRef.current = action.send
    action.receive((data, peerId) => {
      const active = Boolean((data as PttPayload)?.active)
      setPeerPtt((cur) => ({ ...cur, [peerId]: active }))
      useSessionStore.getState().setPeerPtt(peerId, active)
    })
    return () => {
      pttSendRef.current = null
    }
  }, [room])

  // Reflect local PTT state on the local audio track AND broadcast it so
  // peers can light their PTT indicator while we're transmitting.
  useEffect(() => {
    const stream = localStreamRef.current
    if (stream) {
      for (const t of stream.getAudioTracks()) t.enabled = pttActive
    }
    const send = pttSendRef.current
    if (send) void send({ active: pttActive })
  }, [pttActive])

  const handleLeave = useCallback(() => {
    if (!sessionLeave) return
    void sessionLeave().catch((err) => {
      const message = err instanceof Error ? err.message : 'could not leave'
      toast.error(message)
    })
  }, [sessionLeave])

  const elapsed = useElapsed(startedAt)

  if (!room) return null

  const peerEntries = Object.values(peers)
  const youName = identity?.display_name?.trim() || 'You'

  return (
    <main
      className="flex min-h-screen flex-col bg-bg-base text-text-primary"
      aria-label="Active session"
    >
      <div className="flex-1 px-6 py-6">
        {mediaError ? (
          <div className="mb-4 rounded-md border border-status-alerted bg-bg-surface px-4 py-3 text-sm text-status-alerted">
            Couldn’t access camera or microphone: {mediaError}
          </div>
        ) : null}
        <VideoGrid>
          <VideoTile
            key="local"
            name={youName}
            stream={localStream}
            ptt={pttActive}
            isLocal
          />
          {peerEntries.map((peer) => (
            <VideoTile
              key={peer.peerId}
              name={peerLabel(peer.peerId)}
              stream={remoteStreams[peer.peerId] ?? null}
              ptt={peerPtt[peer.peerId] ?? false}
            />
          ))}
        </VideoGrid>
      </div>
      <footer className="flex items-center justify-between gap-4 border-t border-border-subtle bg-bg-surface px-6 py-4 text-sm">
        <span className="flex items-center gap-2 text-text-secondary">
          hold <Kbd>{isMacLikePlatform() ? '⌘[' : 'Ctrl+['}</Kbd> to talk
        </span>
        <span className="font-mono tabular-nums text-text-secondary">
          {elapsed}
        </span>
        <Button variant="secondary" size="sm" onClick={handleLeave}>
          Leave
        </Button>
      </footer>
    </main>
  )
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      // already-stopped tracks throw on some platforms; ignore.
    }
  }
}

function peerLabel(peerId: string): string {
  return `Peer ${peerId.slice(0, 6)}`
}

function useElapsed(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(handle)
  }, [])
  if (!startedAt) return '00:00'
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
