// Shared MediaStream helpers. getUserMedia and the track-stopping loop are used
// by the QR scanner (pairing), and the same stop loop is duplicated in the V2
// camera/screen-capture features; this is the reusable home for new callers.

export async function openWebcamStream(
  constraints: MediaStreamConstraints = { video: true }
): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia(constraints)
}

export function stopMediaStream(stream: MediaStream | null | undefined): void {
  if (!stream) return
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      // already-stopped tracks throw on some platforms; ignore.
    }
  }
}
