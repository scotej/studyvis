import { useEffect, useRef } from 'react'
import { MaximizeIcon, MonitorIcon, VideoOff } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'
import { strings } from '@/strings'

import { FocusIndicator, type FocusState } from './FocusIndicator'
import { PttIndicator } from './PttIndicator'

// #96 — a screen tile carries someone's shared display rather than their face.
// It is the same tile shape (so the grid stays one rhythm) with the
// person-specific affordances dropped: no focus verdict, no PTT, no volume, and
// `object-contain` because cropping a screen loses the part being pointed at.
export type VideoTileVariant = 'camera' | 'screen'

export type VideoTileProps = {
  name: string
  stream: MediaStream | null
  variant?: VideoTileVariant
  // #96 — screen tiles only: opens the full-size viewer. A screen at quarter
  // grid size is unreadable, so this is what makes the tile useful.
  onExpand?: () => void
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
  variant = 'camera',
  onExpand,
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
  const isScreen = variant === 'screen'
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
      // #95 — a tile has no size of its own any more: VideoGrid measures its
      // slot and gives every tile a width, and `aspect-video` does the rest.
      // The old inline min/max height fought that — a min-height plus an aspect
      // ratio re-derives the WIDTH (180 → 320), so a tile the grid had sized at
      // 312 burst out of its slot and overflowed the row.
      data-testid="video-tile"
      data-state={resolvedState}
      data-variant={variant}
      data-camera-off={cameraOff ? 'true' : undefined}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        // A screen tile never carries audio (the share is requested video-only)
        // and muting it defensively keeps a peer who publishes one anyway from
        // echoing against the live mic.
        muted={isLocal || isScreen}
        className={cn(
          'h-full w-full',
          // Cropping a screen loses whatever the person is pointing at; letter-
          // boxing it inside the tile does not.
          isScreen ? 'object-contain' : 'object-cover',
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
          {isScreen ? (
            <MonitorIcon
              className="size-3.5 shrink-0 text-text-secondary"
              aria-hidden="true"
            />
          ) : (
            <FocusIndicator state={resolvedState} />
          )}
          <span className="truncate text-sm font-medium text-text-primary">
            {name}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {isScreen && onExpand ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onExpand}
              aria-haspopup="dialog"
              aria-label={strings.session.screenShare.expandAriaLabel(name)}
            >
              <MaximizeIcon />
            </Button>
          ) : null}
          {!isScreen && !isLocal && volume != null && onVolumeChange ? (
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
          {isScreen ? null : <PttIndicator active={ptt} />}
        </div>
      </figcaption>
    </figure>
  )
}
