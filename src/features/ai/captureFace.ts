// V2-P3 — Face frame snapshot for the AI sample loop. The local camera
// MediaStreamTrack is already running for the WebRTC session (see
// SessionView.tsx). This function pulls a single still frame off that track
// without disturbing the live audio/video sent to peers, downscales to a
// 384×384 JPEG at quality 0.8, and returns a base64 string the sample loop
// can slot directly into an OpenAI-compatible image content block (the
// caller prepends `data:image/jpeg;base64,` if a data URI is needed).
//
// Privacy: the snapshot never leaves the device. The live MediaStreamTrack
// is shared with peers via WebRTC, but the AI's still-frame is a separate
// side path that's only POSTed to 127.0.0.1 / llama-server.

import { CaptureError, getCaptureRuntime } from './captureShared'

export const FACE_FRAME_SIZE = 384
export const FACE_FRAME_QUALITY = 0.8

export async function captureFace(track: MediaStreamTrack): Promise<string> {
  const runtime = getCaptureRuntime()
  const frame = await runtime.extractFrame(track)
  try {
    // Center-cropped square inside the source frame: pick the largest square
    // that fits, offset to the middle. The encoder receives an explicit
    // 9-arg drawImage source rect so a 16:9 webcam doesn't get squashed
    // into 384×384.
    const side = Math.min(frame.sourceWidth, frame.sourceHeight)
    if (side <= 0) {
      throw new CaptureError(
        'frame_extraction_failed',
        `face frame had non-positive dimensions (${frame.sourceWidth}×${frame.sourceHeight})`
      )
    }
    const sx = Math.floor((frame.sourceWidth - side) / 2)
    const sy = Math.floor((frame.sourceHeight - side) / 2)
    return await runtime.encodeJpegBase64({
      frame,
      targetWidth: FACE_FRAME_SIZE,
      targetHeight: FACE_FRAME_SIZE,
      quality: FACE_FRAME_QUALITY,
      sourceCrop: { sx, sy, sw: side, sh: side },
    })
  } finally {
    runtime.disposeFrame(frame)
  }
}
