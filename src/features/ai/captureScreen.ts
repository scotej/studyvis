// V2-P3 — Screen frame snapshot for the AI sample loop. Acquires a fresh
// getDisplayMedia track exclusively for the AI side path (never published
// to peers), snapshots a single frame, downscales to 1024 px wide preserving
// aspect, encodes JPEG quality 0.7, then stops the track so the OS screen-
// recording indicator disappears between ticks.
//
// Multi-monitor: V2 makes no programmatic display selection. The OS picker
// shown by getDisplayMedia is the only selector; the user picks once per
// acquire. V3 will add a multi-monitor toggle (see src/features/ai/README.md).
//
// Track lifetime: the default flow re-acquires on every call. If the OS
// shows the picker every tick (which is the Tauri webview behavior on macOS
// + Windows once the orchestrator wires this in V2-P5), the sample loop
// switches to a long-lived track; that path is documented in README.md and
// stays out of this file to keep its surface small.

import {
  CaptureError,
  fitWidth,
  getCaptureRuntime,
  type CaptureErrorCode,
} from './captureShared'

export const SCREEN_FRAME_MAX_WIDTH = 1024
export const SCREEN_FRAME_QUALITY = 0.7

export type ScreenCaptureRuntime = {
  // Indirected so unit tests can return a stub MediaStream without spinning
  // a real WebView. Production wires this to navigator.mediaDevices.
  getDisplayMedia: (
    constraints: DisplayMediaStreamOptions
  ) => Promise<MediaStream>
}

// Default real-DOM runtime. Resolves lazily because Vitest's node
// environment has no navigator.mediaDevices and the module would otherwise
// fail to import at test boot.
function defaultGetDisplayMedia(
  constraints: DisplayMediaStreamOptions
): Promise<MediaStream> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getDisplayMedia !== 'function'
  ) {
    throw new CaptureError(
      'screen_capture_unavailable',
      'navigator.mediaDevices.getDisplayMedia is not available in this environment'
    )
  }
  return navigator.mediaDevices.getDisplayMedia(constraints)
}

const defaultScreenRuntime: ScreenCaptureRuntime = {
  getDisplayMedia: defaultGetDisplayMedia,
}

let activeScreenRuntime: ScreenCaptureRuntime = defaultScreenRuntime

export function __setScreenCaptureRuntime(runtime: ScreenCaptureRuntime): void {
  activeScreenRuntime = runtime
}

export function __resetScreenCaptureRuntime(): void {
  activeScreenRuntime = defaultScreenRuntime
}

export async function captureScreen(): Promise<string> {
  const runtime = getCaptureRuntime()
  const stream = await acquireScreenStream()
  const videoTrack = stream.getVideoTracks()[0]
  if (!videoTrack) {
    stopStream(stream)
    throw new CaptureError(
      'screen_capture_no_video',
      'getDisplayMedia returned a stream with no video tracks'
    )
  }
  try {
    const frame = await runtime.extractFrame(videoTrack)
    try {
      const { width, height } = fitWidth(
        frame.sourceWidth,
        frame.sourceHeight,
        SCREEN_FRAME_MAX_WIDTH
      )
      if (width === 0 || height === 0) {
        throw new CaptureError(
          'frame_extraction_failed',
          `screen frame had unusable dimensions (${frame.sourceWidth}×${frame.sourceHeight})`
        )
      }
      return await runtime.encodeJpegBase64({
        frame,
        targetWidth: width,
        targetHeight: height,
        quality: SCREEN_FRAME_QUALITY,
      })
    } finally {
      runtime.disposeFrame(frame)
    }
  } finally {
    // Releasing the stream is what removes the OS screen-recording indicator
    // and prevents battery drain. Always runs.
    stopStream(stream)
  }
}

async function acquireScreenStream(): Promise<MediaStream> {
  try {
    return await activeScreenRuntime.getDisplayMedia({ video: true })
  } catch (err) {
    throw mapDisplayMediaError(err)
  }
}

// Exported so the V2-P5/V2-P9 long-lived-stream path in sampleLoop.ts maps
// getDisplayMedia rejections to the same CaptureError codes (the
// macOS-Sequoia NotAllowedError → `screen_capture_denied` mapping is
// load-bearing for the permission overlay; duplicating it would risk drift).
// The long-lived acquire+snapshot loop itself still lives in sampleLoop.ts,
// per README §"Acquire strategy" — only this error classifier is shared.
export function mapDisplayMediaError(err: unknown): CaptureError {
  if (err instanceof CaptureError) return err
  if (err instanceof DOMException) {
    let code: CaptureErrorCode
    switch (err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        // macOS Sequoia surfaces system-level "Screen Recording not granted"
        // as NotAllowedError (the WebKit prompt itself fires and gets
        // refused) as well as the in-tab denial when the user dismisses the
        // picker. We treat both as `screen_capture_denied`; callers (V2-P9
        // settings flow + V2-P3 ScreenCapturePermissionOverlay) show the
        // tutorial pointing to System Settings → Privacy & Security →
        // Screen Recording.
        code = 'screen_capture_denied'
        break
      case 'NotFoundError':
      case 'AbortError':
      case 'OverconstrainedError':
        code = 'screen_capture_no_video'
        break
      default:
        code = 'screen_capture_unavailable'
    }
    return new CaptureError(code, err.message || err.name, { cause: err })
  }
  return new CaptureError(
    'screen_capture_unavailable',
    err instanceof Error ? err.message : String(err),
    { cause: err }
  )
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      // already-stopped tracks throw on some platforms; ignore.
    }
  }
}

// Caller-facing helper: trigger the one-shot OS permission prompt on macOS
// Sequoia / Windows. Throws CaptureError on denial — callers map error.code
// to the right UI affordance (e.g. the ScreenCapturePermissionOverlay).
// Used by V2-P9's "Enable AI features" toggle to seed the permission
// before the first sample-loop tick.
export async function requestScreenCapturePermission(): Promise<void> {
  const stream = await acquireScreenStream()
  // Immediately release — we only wanted the OS prompt + grant.
  stopStream(stream)
}
