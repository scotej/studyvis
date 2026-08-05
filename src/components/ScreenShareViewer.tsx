// #96 / #184 — fullscreen view of one shared screen. A 4K display rendered
// in the session grid is unreadable, so the tile is the affordance and this is
// where the screen is actually read. The viewer fills the webview and asks
// Tauri to put the native window into fullscreen; the full-webview layout is
// also the browser/Storybook fallback when native fullscreen is unavailable.

import { useEffect, useRef } from 'react'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { logger } from '@/lib/log'
import {
  createNativeScreenShareFullscreenRuntime,
  createScreenShareFullscreenController,
} from '@/lib/screenShareFullscreen'

const log = logger.child('session.screenShareViewer')

export type ScreenShareViewerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
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
  const onOpenChangeRef = useRef(onOpenChange)

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  }, [onOpenChange])

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    if (el.srcObject !== stream) el.srcObject = stream
  }, [stream, open])

  useEffect(() => {
    if (!open) return

    let cancelled = false
    let closeFullscreen: (() => Promise<void>) | null = null

    void createNativeScreenShareFullscreenRuntime()
      .catch((err) => {
        log.warn('nativeFullscreen.unavailable', { err })
        return null
      })
      .then(async (runtime) => {
        if (!runtime || cancelled) return
        const controller = createScreenShareFullscreenController(
          runtime,
          () => {
            onOpenChangeRef.current(false)
          }
        )
        closeFullscreen = controller.close
        try {
          await controller.open()
        } catch (err) {
          log.warn('nativeFullscreen.enterFailed', { err })
        }
      })

    return () => {
      cancelled = true
      if (closeFullscreen) void closeFullscreen()
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="inset-0 top-0 left-0 flex h-full max-w-none translate-x-0 translate-y-0 flex-col gap-3 rounded-none border-0 p-4"
        aria-describedby={undefined}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="pr-8 text-base">{name}</DialogTitle>
        </DialogHeader>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          data-testid="screen-share-viewer-video"
          className="min-h-0 w-full flex-1 rounded-md bg-bg-sunk object-contain"
        />
      </DialogContent>
    </Dialog>
  )
}
