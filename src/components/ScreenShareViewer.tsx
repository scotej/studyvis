// #96 — full-size view of one shared screen. A 4K display rendered at quarter
// grid size is unreadable, so the grid tile is the affordance and this is where
// the screen is actually read.
//
// Deliberately a Radix Dialog rather than a bespoke overlay: it renders
// `aria-modal="true"`, which the session's two-tap Esc-to-leave handler already
// treats as "something else owns Escape". Closing the viewer therefore never
// arms leaving the session.

import { useEffect, useRef } from 'react'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export type ScreenShareViewerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Caption for the screen on show — already resolved to "Your screen" or
  // "<friend>'s screen" by the caller.
  name: string
  stream: MediaStream | null
}

export function ScreenShareViewer({
  open,
  onOpenChange,
  name,
  stream,
}: ScreenShareViewerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)

  // Re-bound on `open` as well as `stream`: the element only exists while the
  // dialog is mounted, so binding on the stream alone would miss the first
  // render after it opens.
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    if (el.srcObject !== stream) el.srcObject = stream
  }, [stream, open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[92vw] gap-3 p-4"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle className="pr-8 text-base">{name}</DialogTitle>
        </DialogHeader>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          data-testid="screen-share-viewer-video"
          className="max-h-[76vh] w-full rounded-md bg-bg-sunk object-contain"
        />
      </DialogContent>
    </Dialog>
  )
}
