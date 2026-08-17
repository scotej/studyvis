// One-shot screen-frame utility. `captureScreen()` acquires one
// getDisplayMedia stream for the local AI side path (never published to
// peers), snapshots a frame, downscales it to 1024 px wide, encodes a
// quality-0.7 JPEG, and always stops the stream.
//
// This is NOT the live sample loop: sampleLoop.ts acquires long-lived screen
// streams once at boot, snapshots them on each tick, and composites surviving
// streams when the user selected all displays. The OS picker remains the
// selector for every acquire on macOS, Windows, and Linux/desktop portals.
// Helpers in this file seed permissions and hand a gesture-started acquire to
// that long-lived loop. See src/features/ai/README.md.

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

// V2-P9 gesture fix — desktop webviews require
// getDisplayMedia() to run inside live transient user activation on EVERY
// call, not just the first. sampleLoop.ts's boot() acquires the long-lived
// screen stream from a useEffect (no gesture in its call stack), which is
// exactly why the loop's first tick could throw "getDisplayMedia must be
// called from a user gesture handler" instead of the intended
// screen_capture_denied flow.
//
// Callers that DO have a gesture (TopicGateModal's submit, AiCategory's
// "enable AI" toggle when a session is already active, SessionView's
// permission-overlay retry) call `preacquireScreenStream()` synchronously —
// no `await` before it — so the native getDisplayMedia() call happens
// inside that click. The in-flight acquisition is stashed here;
// sampleLoop's default `acquireScreenStream` runtime hook awaits it instead
// of calling getDisplayMedia() itself outside gesture context.
let pendingScreenAcquire: Promise<MediaStream> | null = null

// Returns the same promise that gets stashed — a caller that cares about
// the immediate outcome (e.g. SessionView's retry, for optimistic UI) may
// await it. That does NOT consume the stash: promises support multiple
// independent subscribers, so boot()'s later `takePendingScreenStream()`
// still observes the same settlement. Callers that don't care just ignore
// the return value.
export function preacquireScreenStream(): Promise<MediaStream> {
  const prior = pendingScreenAcquire
  const attempt = acquireScreenStream()
  pendingScreenAcquire = attempt
  // Nothing may ever call takePendingScreenStream() for this attempt (e.g.
  // the session never reaches boot()) — attach a no-op catch so that case
  // doesn't surface as an unhandled promise rejection. Callers that do
  // await the returned promise still observe the original rejection.
  attempt.catch(() => {})
  // A still-unconsumed stream from an earlier call (rapid re-toggle/retry)
  // must not leak — release it once it settles.
  if (prior) {
    void prior.then(stopStream).catch(() => {})
  }
  return attempt
}

// Consumed by sampleLoop.ts's default screen-acquire runtime hook. Returns
// null when no gesture-context acquisition is in flight (falls back to a
// direct getDisplayMedia() call, e.g. in tests or an uncovered code path).
export function takePendingScreenStream(): Promise<MediaStream> | null {
  const attempt = pendingScreenAcquire
  pendingScreenAcquire = null
  return attempt
}

// Release an unconsumed pre-acquired stream (e.g. SessionView unmounting
// before boot() ever ran) so it doesn't hold the OS recording indicator lit
// for no reason.
export function discardPendingScreenStream(): void {
  const attempt = pendingScreenAcquire
  pendingScreenAcquire = null
  if (attempt) {
    void attempt.then(stopStream).catch(() => {})
  }
}

// Exported so the V2-P5/V2-P9 long-lived-stream path in sampleLoop.ts maps
// getDisplayMedia rejections to the same CaptureError codes (the
// macOS-Sequoia NotAllowedError → `screen_capture_denied` mapping is
// load-bearing for the permission overlay; duplicating it would risk drift).
// The long-lived acquire+snapshot loop itself still lives in sampleLoop.ts;
// only this error classifier is shared (see README §"Live capture pipeline").
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
      case 'InvalidStateError':
      case 'InvalidAccessError':
        // I83 — "no transient activation" (the I76 failure). Chromium/WebView2
        // raises InvalidStateError, WebKit InvalidAccessError, and the default
        // branch below used to file both under `screen_capture_unavailable`,
        // whose only affordance is a toast carrying a raw DOMException string.
        // `screen_capture_denied` mounts the recovery overlay instead — and its
        // "Try again" button is itself the user gesture the call was missing,
        // so the retry genuinely works rather than repeating the failure. Its
        // non-mac steps ("if the prompt was dismissed, click Try again") read
        // correctly for this case too.
        code = 'screen_capture_denied'
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

// Caller-facing helper: trigger the one-shot OS permission/picker flow on
// macOS, Windows, or Linux. Throws CaptureError on denial — callers map
// error.code to the right UI affordance (e.g. ScreenCapturePermissionOverlay).
// Used by V2-P9's "Enable AI features" toggle to seed the permission
// before the first sample-loop tick.
export async function requestScreenCapturePermission(): Promise<void> {
  const stream = await acquireScreenStream()
  // Immediately release — we only wanted the OS prompt + grant.
  stopStream(stream)
}
