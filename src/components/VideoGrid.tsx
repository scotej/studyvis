import {
  Children,
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { tokens } from '@/design/tokens'
import { cn } from '@/lib/utils'
import { fitTileWidth, VIDEO_TILE_ASPECT } from '@/lib/videoGrid'
import { strings } from '@/strings'

// Layout for the session tiles. The mesh hard-caps at 4 people
// (ARCHITECTURE.md §7) and #96 lets each of them publish a screen alongside
// their camera, so the tile count runs 1–8 rather than 1–4. Plain semantic
// group — `role="grid"` would imply gridcells/keyboard navigation we don't yet
// implement; the V3 accessibility pass can revisit.
export type VideoGridProps = {
  children: ReactNode
  className?: string
}

const TILE_GAP = tokens.space[4]
// #95 — a face is worth showing down to the tile-height floor and no further;
// past that the grid scrolls instead of shrinking everyone into slivers. Only
// reachable with a screen share or two open at the 1024×640 window minimum.
const MIN_TILE_WIDTH = Math.round(
  tokens.sizes.videoTileMinHeight * VIDEO_TILE_ASPECT
)

export function VideoGrid({ children, className }: VideoGridProps) {
  // `Children.toArray` — not `Children.count` — is what makes the tile count
  // honest. SessionView passes conditional `null`s and an array of peer tiles,
  // and count scores every null as a child: sitting alone counted three and
  // laid the two tiles out in three columns.
  const tiles = Children.toArray(children).filter(isValidElement)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [area, setArea] = useState<{ width: number; height: number } | null>(
    null
  )

  // #95 — tile size follows the measured slot, so it has to be measured before
  // the first paint (layout effect) and re-measured on resize. `client*` rather
  // than a bounding rect: it excludes a scrollbar, which is exactly the width
  // the tiles cannot use. The observed box is sized by the session layout and
  // never by the tiles inside it, so writing widths back cannot feed a loop.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      const width = el.clientWidth
      const height = el.clientHeight
      setArea((cur) =>
        cur && cur.width === width && cur.height === height
          ? cur
          : { width, height }
      )
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const fitted =
    area === null
      ? null
      : fitTileWidth({
          count: tiles.length,
          width: area.width,
          height: area.height,
          gap: TILE_GAP,
        })
  const overflows = fitted !== null && fitted < MIN_TILE_WIDTH
  const tileWidth = fitted === null ? null : Math.max(fitted, MIN_TILE_WIDTH)

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={strings.session.gridAriaLabel}
      className={cn(
        'flex h-full min-h-0 flex-wrap justify-center gap-4 overflow-y-auto',
        // Centering the rows is right when they fit; when they don't, it would
        // put the first row above the scroll origin where nothing can reach it.
        overflows ? 'content-start' : 'content-center',
        className
      )}
      data-tile-count={tiles.length}
    >
      {tiles.map((tile) => (
        <div
          key={tile.key}
          // Held back for the one commit before the layout effect above has a
          // measurement: an auto-width tile is a full-width tile, which would
          // overflow the slot and hand `measure()` a scrollbar-narrowed box to
          // size everything from. Never painted — layout effects run first.
          className={cn('shrink-0', tileWidth === null && 'hidden')}
          style={tileWidth === null ? undefined : { width: tileWidth }}
        >
          {tile}
        </div>
      ))}
    </div>
  )
}
