import { useEffect, useRef } from 'react'
import jsQR from 'jsqr'

import { openWebcamStream, stopMediaStream } from '@/lib/media'

export type PairQrScannerProps = {
  // Called once with the raw decoded QR text on the first successful read.
  onDecode: (text: string) => void
  // Called if the camera can't be opened (no device, permission denied).
  onError: () => void
  label: string
}

// Opens the webcam and scans each frame for a QR code, firing onDecode with the
// raw payload on the first hit. Generic: it returns the decoded text and lets
// the caller decide what it means. The camera is released on unmount and on the
// first decode.
export function PairQrScanner({
  onDecode,
  onError,
  label,
}: PairQrScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const onDecodeRef = useRef(onDecode)
  const onErrorRef = useRef(onError)

  // Keep the latest callbacks in refs — updated in an effect, never during
  // render — so a parent re-render doesn't tear down and reopen the camera.
  useEffect(() => {
    onDecodeRef.current = onDecode
    onErrorRef.current = onError
  })

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let stream: MediaStream | null = null
    let raf = 0
    let stopped = false
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    const tick = () => {
      if (stopped || !ctx) return
      if (video.readyState >= video.HAVE_ENOUGH_DATA) {
        const w = video.videoWidth
        const h = video.videoHeight
        if (w && h) {
          canvas.width = w
          canvas.height = h
          ctx.drawImage(video, 0, 0, w, h)
          const frame = ctx.getImageData(0, 0, w, h)
          const result = jsQR(frame.data, w, h, {
            inversionAttempts: 'dontInvert',
          })
          if (result?.data) {
            stopped = true
            onDecodeRef.current(result.data)
            return
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }

    void (async () => {
      try {
        stream = await openWebcamStream({
          video: { facingMode: 'environment' },
        })
      } catch {
        try {
          stream = await openWebcamStream({ video: true })
        } catch {
          if (!stopped) onErrorRef.current()
          return
        }
      }
      if (stopped) {
        stopMediaStream(stream)
        return
      }
      video.srcObject = stream
      await video.play().catch(() => {})
      raf = requestAnimationFrame(tick)
    })()

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      stopMediaStream(stream)
      video.srcObject = null
    }
  }, [])

  return (
    <div className="overflow-hidden rounded-lg border border-border-default bg-bg-surface">
      <video
        ref={videoRef}
        className="aspect-square w-full object-cover"
        muted
        playsInline
        aria-label={label}
      />
    </div>
  )
}
