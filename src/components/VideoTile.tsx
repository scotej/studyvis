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
  className,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const resolvedState: FocusState = state ?? (stream ? 'online' : 'offline')

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    if (el.srcObject !== stream) el.srcObject = stream
  }, [stream])

  return (
    <figure
      className={cn(
        'group relative flex aspect-video flex-col overflow-hidden rounded-lg border border-border-default bg-bg-sunk',
        className
      )}
      style={{
        minHeight: tokens.sizes.videoTileMinHeight,
        maxHeight: tokens.sizes.videoTileMaxHeight,
      }}
      data-testid="video-tile"
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        className="h-full w-full object-cover"
      />
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
