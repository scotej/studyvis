import { useEffect, useRef } from 'react'
import { VideoOff } from 'lucide-react'

import { Slider } from '@/components/ui/slider'
import { tokens } from '@/design/tokens'
import { cn } from '@/lib/utils'
import { strings } from '@/strings'

import { FocusIndicator, type FocusState } from './FocusIndicator'
import { PttIndicator } from './PttIndicator'

export type VideoTileProps = {
  name: string
  stream: MediaStream | null
  state?: FocusState
  ptt?: boolean
  isLocal?: boolean
  // V2-P6 — when the tile is in `alerted` state, the off-task user's
  // reasoning text is shown inline above the name caption. Visible to all
  // peers (the carryover spec: "the off-task user's tile shows the
  // reasoning text inline"). Ignored when `state !== 'alerted'`.
  alertReasoning?: string
  // S3 — explicit "camera off" presentation. For the local tile this reflects
  // the user's own toggle; for a peer tile it reflects the peer's broadcast
  // camera state. We render a calm placeholder (VideoOff glyph + caption)
  // instead of the frozen last frame a disabled MediaStreamTrack leaves behind.
  cameraOff?: boolean
  // S4 — audio output routing. Applied via HTMLMediaElement.setSinkId when the
  // engine supports it (macOS WKWebView does NOT — we feature-detect and the
  // picker that feeds this is hidden there, so an unset/unsupported sinkId is
  // a harmless no-op). Ignored on the local tile, which is always muted.
  sinkId?: string
  // S4 — per-tile playback volume in [0, 1], local-only (never broadcast).
  // Renders an accessible slider in the caption row of non-local tiles.
  volume?: number
  onVolumeChange?: (volume: number) => void
  className?: string
}

// One peer's video tile (DESIGN-SYSTEM.md §4 + §8.3). Local tiles are always
// muted at the <video> element level — your own audio plays through your
// speakers as the live mic, not echoed back from your <video>.
export function VideoTile({
  name,
  stream,
  state,
  ptt = false,
  isLocal = false,
  alertReasoning,
  cameraOff = false,
  sinkId,
  volume,
  onVolumeChange,
  className,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  // Camera-off does NOT coerce the focus state to 'offline': that would mask a
  // broadcast off-task alert (and its reasoning) and the F4 connecting/failed
  // transport states on an otherwise-connected peer. The camera-off overlay
  // below is the sole carrier of the camera-off presentation; the indicator
  // keeps reporting the real state.
  const resolvedState: FocusState = state ?? (stream ? 'online' : 'offline')
  const isAlerted = resolvedState === 'alerted'

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    if (el.srcObject !== stream) el.srcObject = stream
  }, [stream])

  // S4 — route playback to the chosen output device when supported. setSinkId
  // is absent in macOS WKWebView, so feature-detect rather than assume; a
  // missing/unsupported method degrades to the system default silently.
  useEffect(() => {
    const el = videoRef.current
    if (!el || isLocal || sinkId == null) return
    const withSink = el as HTMLVideoElement & {
      setSinkId?: (id: string) => Promise<void>
    }
    if (typeof withSink.setSinkId !== 'function') return
    void withSink.setSinkId(sinkId).catch(() => {
      // Device may have been unplugged between enumeration and apply; ignore.
    })
  }, [sinkId, isLocal, stream])

  useEffect(() => {
    const el = videoRef.current
    if (!el || isLocal || volume == null) return
    el.volume = Math.max(0, Math.min(1, volume))
  }, [volume, isLocal, stream])

  return (
    <figure
      className={cn(
        'group relative flex aspect-video flex-col overflow-hidden rounded-lg bg-bg-sunk',
        // Tile-border highlight when the user is in the alerted state.
        // Switching the border color (rather than adding a fresh ring) keeps
        // the alerted look consistent with `border.default` on every other
        // tile size + zoom level. DESIGN-SYSTEM §6 permits border-color
        // transitions for discrete state changes.
        isAlerted
          ? 'border-2 border-status-alerted'
          : 'border border-border-default',
        className
      )}
      style={{
        minHeight: tokens.sizes.videoTileMinHeight,
        maxHeight: tokens.sizes.videoTileMaxHeight,
      }}
      data-testid="video-tile"
      data-state={resolvedState}
      data-camera-off={cameraOff ? 'true' : undefined}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        className={cn(
          'h-full w-full object-cover',
          // Keep the element mounted (so the track stays bound) but hide the
          // frozen frame behind the camera-off placeholder.
          cameraOff && 'invisible'
        )}
      />
      {cameraOff ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg-sunk text-text-muted">
          <VideoOff className="size-7" aria-hidden="true" />
          <span className="text-xs font-medium">
            {strings.session.camera.offTileLabel}
          </span>
        </div>
      ) : null}
      {isAlerted && alertReasoning ? (
        <div
          role="note"
          aria-label="Off-task reasoning"
          data-testid="alert-reasoning"
          className="pointer-events-none absolute inset-x-0 top-0 bg-status-alerted/85 px-4 py-2 text-xs font-medium text-text-inverse line-clamp-2"
        >
          {alertReasoning}
        </div>
      ) : null}
      <figcaption className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-overlay-glass px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <FocusIndicator state={resolvedState} />
          <span className="truncate text-sm font-medium text-text-primary">
            {name}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {!isLocal && volume != null && onVolumeChange ? (
            <Slider
              aria-label={strings.session.output.volumeAriaLabel(name)}
              value={[Math.round(volume * 100)]}
              min={0}
              max={100}
              step={1}
              onValueChange={(next) => {
                const v = next[0]
                if (typeof v === 'number') onVolumeChange(v / 100)
              }}
              className="w-20"
            />
          ) : null}
          <PttIndicator active={ptt} />
        </div>
      </figcaption>
    </figure>
  )
}
