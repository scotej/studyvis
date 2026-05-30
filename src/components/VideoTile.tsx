import { useEffect, useRef } from 'react'

import { tokens } from '@/design/tokens'
import { cn } from '@/lib/utils'

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
  className,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const resolvedState: FocusState = state ?? (stream ? 'online' : 'offline')
  const isAlerted = resolvedState === 'alerted'

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    if (el.srcObject !== stream) el.srcObject = stream
  }, [stream])

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
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        className="h-full w-full object-cover"
      />
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
      <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-overlay-glass px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <FocusIndicator state={resolvedState} />
          <span className="truncate text-sm font-medium text-text-primary">
            {name}
          </span>
        </div>
        <PttIndicator active={ptt} />
      </figcaption>
    </figure>
  )
}
