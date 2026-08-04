import { useState } from 'react'
import { DownloadIcon, MinusIcon, PlusIcon, RotateCcwIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { strings } from '@/strings'

import { saveSessionImage } from './imageSave'
import type { ImageMimeType } from './images'
import type { SessionImage } from './notesStore'

const MIN_ZOOM = 0.5
const MAX_ZOOM = 4
const ZOOM_STEP = 0.25

export type SessionImageViewerProps = {
  image: SessionImage | null
  onOpenChange: (open: boolean) => void
  resolveName: (image: SessionImage) => string
}

export function SessionImageViewer({
  image,
  onOpenChange,
  resolveName,
}: SessionImageViewerProps) {
  const [zoom, setZoom] = useState(1)
  const copy = strings.session.images

  const download = async () => {
    if (!image) return
    try {
      const result = await saveSessionImage(
        image.blob,
        image.filename,
        image.mimeType as ImageMimeType
      )
      if (result === 'saved') toast.success(copy.downloaded)
    } catch {
      toast.error(copy.downloadFailed)
    }
  }

  return (
    <Dialog
      open={image != null}
      onOpenChange={(open) => {
        if (!open) setZoom(1)
        onOpenChange(open)
      }}
    >
      <DialogContent
        className="max-h-[92vh] max-w-[94vw] gap-3 overflow-hidden p-4"
        aria-describedby={undefined}
      >
        {image && (
          <>
            <DialogHeader>
              <DialogTitle className="pr-8 text-base">
                {copy.viewerTitle(resolveName(image))}
              </DialogTitle>
            </DialogHeader>
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-xs text-text-secondary">
                {image.filename}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setZoom((value) => Math.max(MIN_ZOOM, value - ZOOM_STEP))
                  }
                  disabled={zoom <= MIN_ZOOM}
                  aria-label={copy.zoomOut}
                >
                  <MinusIcon />
                </Button>
                <span className="min-w-12 text-center text-xs text-text-secondary">
                  {Math.round(zoom * 100)}%
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP))
                  }
                  disabled={zoom >= MAX_ZOOM}
                  aria-label={copy.zoomIn}
                >
                  <PlusIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setZoom(1)}
                  disabled={zoom === 1}
                  aria-label={copy.resetZoom}
                >
                  <RotateCcwIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void download()}
                  aria-label={copy.download}
                >
                  <DownloadIcon />
                </Button>
              </div>
            </div>
            <div className="min-h-0 overflow-auto rounded-md bg-bg-sunk p-3">
              <img
                src={image.objectUrl}
                alt={copy.imageAlt(resolveName(image))}
                style={{
                  width: `${image.width * zoom}px`,
                  maxWidth: zoom <= 1 ? '100%' : 'none',
                }}
                className="mx-auto h-auto object-contain"
              />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
