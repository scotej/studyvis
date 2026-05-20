// Shared frame-extraction + JPEG-encoding pipeline used by captureFace and
// captureScreen. Both flows resolve to a base64 JPEG that slots directly into
// an OpenAI-compatible image content block (data URI built by the caller).
//
// The pipeline is split behind a `CaptureRuntime` interface so unit tests can
// substitute fakes without spinning a real DOM — Vitest runs in node and has
// no MediaStream / canvas / OffscreenCanvas. The default runtime uses
// OffscreenCanvas when available and falls back to an off-document
// HTMLCanvasElement; both paths are equivalent in output, but OffscreenCanvas
// avoids reflow when the surrounding component is mid-render.

export type CaptureFrame = {
  bitmap: ImageBitmap | HTMLVideoElement
  // Source dimensions in CSS pixels. For face / screen frames these come
  // from the underlying MediaStreamTrack.
  sourceWidth: number
  sourceHeight: number
}

// Source-rect crop (in source pixels) drawn into the target canvas. When
// omitted, the encoder draws the full frame stretched to fit the target —
// correct only when the target's aspect matches the source's (the screen
// path). The face path computes a centered square crop so the 16:9 webcam
// isn't squashed into a square.
export type SourceCrop = {
  sx: number
  sy: number
  sw: number
  sh: number
}

export type EncodeJpegRequest = {
  frame: CaptureFrame
  // Output dimensions after downscale. Caller computes these so the encoder
  // doesn't have to know whether we want a square (face) or
  // aspect-preserved width (screen).
  targetWidth: number
  targetHeight: number
  // 0–1, mapped 1:1 onto canvas.toBlob's quality argument.
  quality: number
  // Optional source crop. Defaults to the full frame.
  sourceCrop?: SourceCrop
}

// V3-P4 — Multi-monitor composite encode. The pure layout (where each frame
// lands on the output canvas) is computed by `computeCompositeLayout` in
// composite.ts; this runtime hook is the side-effecting half that draws the
// frames into a single canvas and returns one JPEG. Backgrounds outside the
// drawn placements are left as the canvas default (transparent on
// OffscreenCanvas, then rendered as black by the JPEG encoder).
export type CompositePlacementInput = {
  frame: CaptureFrame
  // Where to draw this frame on the output canvas (top-left + dimensions).
  x: number
  y: number
  width: number
  height: number
}

export type EncodeCompositeJpegRequest = {
  placements: ReadonlyArray<CompositePlacementInput>
  outputWidth: number
  outputHeight: number
  quality: number
}

export type CaptureRuntime = {
  // Pull a single frame off a live MediaStreamTrack. Implementations must
  // wait long enough for the underlying decoder to surface a non-black
  // frame; the default implementation handles the WKWebView race where
  // drawImage on a fresh <video>.srcObject yields a transparent or black
  // bitmap if invoked before the first decoded frame is paint-ready.
  extractFrame: (track: MediaStreamTrack) => Promise<CaptureFrame>
  // Release any allocations associated with a CaptureFrame (e.g.
  // ImageBitmap.close, detach a <video>.srcObject). Idempotent.
  disposeFrame: (frame: CaptureFrame) => void
  // Downscale + encode to JPEG, return base64 (no data: prefix).
  encodeJpegBase64: (req: EncodeJpegRequest) => Promise<string>
  // V3-P4 — draw N frames into a single canvas at their pre-computed
  // placements and encode the canvas as one JPEG (no data: prefix). Used by
  // the multi-monitor sample-loop snapshot path; the single-display path
  // still uses encodeJpegBase64.
  encodeCompositeJpegBase64: (
    req: EncodeCompositeJpegRequest
  ) => Promise<string>
}

export class CaptureError extends Error {
  readonly code: CaptureErrorCode
  constructor(code: CaptureErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CaptureError'
    this.code = code
  }
}

export type CaptureErrorCode =
  | 'no_video_track'
  | 'track_ended'
  | 'frame_extraction_failed'
  | 'encode_failed'
  | 'screen_capture_unavailable'
  | 'screen_capture_denied'
  | 'screen_capture_no_video'

// Time we allow the underlying <video> element to surface at least one
// decoded frame before drawImage. 1.5 s comfortably covers WKWebView's
// reported worst-case for getUserMedia handoff; screen-share decoders are
// typically faster.
const VIDEO_FRAME_READY_TIMEOUT_MS = 1500

async function defaultExtractFrame(
  track: MediaStreamTrack
): Promise<CaptureFrame> {
  if (track.kind !== 'video') {
    throw new CaptureError(
      'no_video_track',
      'expected a video MediaStreamTrack'
    )
  }
  if (track.readyState === 'ended') {
    throw new CaptureError(
      'track_ended',
      'video track is already ended; cannot snapshot'
    )
  }

  const stream = new MediaStream([track])
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.autoplay = true
  video.srcObject = stream

  const cleanup = () => {
    try {
      video.pause()
    } catch {
      // already paused; ignore
    }
    video.srcObject = null
  }

  try {
    await waitForVideoReady(video)
    // Settings on a screen-share track expose width/height directly; for a
    // <video> element they appear on videoWidth/videoHeight after metadata
    // arrives.
    const sourceWidth = video.videoWidth || track.getSettings().width || 0
    const sourceHeight = video.videoHeight || track.getSettings().height || 0
    if (sourceWidth === 0 || sourceHeight === 0) {
      throw new CaptureError(
        'frame_extraction_failed',
        `video frame had zero dimensions (${sourceWidth}×${sourceHeight})`
      )
    }
    return {
      bitmap: video,
      sourceWidth,
      sourceHeight,
    }
  } catch (err) {
    cleanup()
    if (err instanceof CaptureError) throw err
    throw new CaptureError(
      'frame_extraction_failed',
      err instanceof Error ? err.message : String(err),
      { cause: err }
    )
  }
}

function waitForVideoReady(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanupListeners()
      reject(
        new CaptureError(
          'frame_extraction_failed',
          `timed out waiting for first decoded frame after ${VIDEO_FRAME_READY_TIMEOUT_MS} ms`
        )
      )
    }, VIDEO_FRAME_READY_TIMEOUT_MS)

    const cleanupListeners = () => {
      clearTimeout(timer)
      video.removeEventListener('loadedmetadata', onMetadata)
      video.removeEventListener('error', onError)
    }

    const onError = () => {
      cleanupListeners()
      const msg = video.error
        ? `video element error: code=${video.error.code} message=${video.error.message}`
        : 'video element error'
      reject(new CaptureError('frame_extraction_failed', msg))
    }

    const onMetadata = () => {
      // We have dimensions; now wait for at least one frame to be paint-
      // ready. requestVideoFrameCallback is the precise primitive (Safari
      // 15.4+ / Chromium); fall back to a microtask + 50 ms timer for the
      // rare runtime that doesn't expose it.
      const reqVFC = (
        video as HTMLVideoElement & {
          requestVideoFrameCallback?: (cb: () => void) => number
        }
      ).requestVideoFrameCallback
      if (typeof reqVFC === 'function') {
        reqVFC.call(video, () => {
          cleanupListeners()
          resolve()
        })
      } else {
        setTimeout(() => {
          cleanupListeners()
          resolve()
        }, 50)
      }
    }

    video.addEventListener('loadedmetadata', onMetadata, { once: true })
    video.addEventListener('error', onError, { once: true })
    // Kick the decoder. play() returns a Promise on modern engines; we
    // intentionally swallow rejection — autoplay restrictions don't apply
    // because srcObject + muted is allowed everywhere we ship.
    void video.play().catch(() => {})
  })
}

function defaultDisposeFrame(frame: CaptureFrame): void {
  if (frame.bitmap instanceof HTMLVideoElement) {
    try {
      frame.bitmap.pause()
    } catch {
      // ignore
    }
    frame.bitmap.srcObject = null
  } else {
    try {
      frame.bitmap.close()
    } catch {
      // best-effort; some engines may not implement close()
    }
  }
}

async function defaultEncodeJpegBase64(
  req: EncodeJpegRequest
): Promise<string> {
  const { frame, targetWidth, targetHeight, quality, sourceCrop } = req
  if (targetWidth <= 0 || targetHeight <= 0) {
    throw new CaptureError(
      'encode_failed',
      `targetWidth/targetHeight must be positive (got ${targetWidth}×${targetHeight})`
    )
  }
  const crop: SourceCrop = sourceCrop ?? {
    sx: 0,
    sy: 0,
    sw: frame.sourceWidth,
    sh: frame.sourceHeight,
  }
  const blob = await drawAndEncode(
    frame,
    crop,
    targetWidth,
    targetHeight,
    quality
  )
  return await blobToBase64(blob)
}

async function defaultEncodeCompositeJpegBase64(
  req: EncodeCompositeJpegRequest
): Promise<string> {
  const { placements, outputWidth, outputHeight, quality } = req
  if (outputWidth <= 0 || outputHeight <= 0) {
    throw new CaptureError(
      'encode_failed',
      `composite output dimensions must be positive (got ${outputWidth}×${outputHeight})`
    )
  }
  if (placements.length === 0) {
    throw new CaptureError('encode_failed', 'composite has no placements')
  }
  const blob = await drawCompositeAndEncode(
    placements,
    outputWidth,
    outputHeight,
    quality
  )
  return await blobToBase64(blob)
}

async function drawCompositeAndEncode(
  placements: ReadonlyArray<CompositePlacementInput>,
  outputWidth: number,
  outputHeight: number,
  quality: number
): Promise<Blob> {
  const useOffscreen = typeof OffscreenCanvas !== 'undefined'
  if (useOffscreen) {
    const canvas = new OffscreenCanvas(outputWidth, outputHeight)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new CaptureError(
        'encode_failed',
        'OffscreenCanvas 2d context unavailable'
      )
    }
    for (const p of placements) {
      ctx.drawImage(
        p.frame.bitmap,
        0,
        0,
        p.frame.sourceWidth,
        p.frame.sourceHeight,
        p.x,
        p.y,
        p.width,
        p.height
      )
    }
    return await canvas.convertToBlob({ type: 'image/jpeg', quality })
  }
  const canvas = document.createElement('canvas')
  canvas.width = outputWidth
  canvas.height = outputHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new CaptureError('encode_failed', 'canvas 2d context unavailable')
  }
  for (const p of placements) {
    ctx.drawImage(
      p.frame.bitmap,
      0,
      0,
      p.frame.sourceWidth,
      p.frame.sourceHeight,
      p.x,
      p.y,
      p.width,
      p.height
    )
  }
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else
          reject(
            new CaptureError('encode_failed', 'canvas.toBlob returned null')
          )
      },
      'image/jpeg',
      quality
    )
  })
}

async function drawAndEncode(
  frame: CaptureFrame,
  crop: SourceCrop,
  targetWidth: number,
  targetHeight: number,
  quality: number
): Promise<Blob> {
  const useOffscreen = typeof OffscreenCanvas !== 'undefined'
  if (useOffscreen) {
    const canvas = new OffscreenCanvas(targetWidth, targetHeight)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new CaptureError(
        'encode_failed',
        'OffscreenCanvas 2d context unavailable'
      )
    }
    // 9-arg form: take crop.sx,crop.sy,crop.sw,crop.sh from the source and
    // draw it into the target rect. The 5-arg form silently stretches the
    // whole source, which squashed the camera's 16:9 frame into the face's
    // 384×384 square.
    ctx.drawImage(
      frame.bitmap,
      crop.sx,
      crop.sy,
      crop.sw,
      crop.sh,
      0,
      0,
      targetWidth,
      targetHeight
    )
    return await canvas.convertToBlob({ type: 'image/jpeg', quality })
  }
  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new CaptureError('encode_failed', 'canvas 2d context unavailable')
  }
  ctx.drawImage(
    frame.bitmap,
    crop.sx,
    crop.sy,
    crop.sw,
    crop.sh,
    0,
    0,
    targetWidth,
    targetHeight
  )
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else
          reject(
            new CaptureError('encode_failed', 'canvas.toBlob returned null')
          )
      },
      'image/jpeg',
      quality
    )
  })
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  // 8 KB chunks keep the call stack short — String.fromCharCode(...array)
  // blows the stack past ~125k args on V8 / JSC.
  const CHUNK = 8192
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK)
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

const defaultRuntime: CaptureRuntime = {
  extractFrame: defaultExtractFrame,
  disposeFrame: defaultDisposeFrame,
  encodeJpegBase64: defaultEncodeJpegBase64,
  encodeCompositeJpegBase64: defaultEncodeCompositeJpegBase64,
}

let activeRuntime: CaptureRuntime = defaultRuntime

export function __setCaptureRuntime(runtime: CaptureRuntime): void {
  activeRuntime = runtime
}

export function __resetCaptureRuntime(): void {
  activeRuntime = defaultRuntime
}

export function getCaptureRuntime(): CaptureRuntime {
  return activeRuntime
}

// Aspect-preserving downscale: returns the (w, h) pair that fits the source
// inside `maxWidth` keeping its aspect ratio, rounded to integer pixels.
// Used by captureScreen; captureFace uses a fixed square.
export function fitWidth(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number
): { width: number; height: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0 || maxWidth <= 0) {
    return { width: 0, height: 0 }
  }
  if (sourceWidth <= maxWidth) {
    return { width: sourceWidth, height: sourceHeight }
  }
  const scale = maxWidth / sourceWidth
  return {
    width: Math.round(maxWidth),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  }
}
