// V2-P3 — Audio input device discovery + hot-swap for an active session.
//
// The session opens its initial getUserMedia stream with no deviceId
// constraint, so the OS-chosen default microphone wins on first launch.
// While the session is live the user may want to switch (AirPods sleep,
// USB headset hot-plug). The hook here enumerates audio inputs, exposes
// the current selection, and provides a swap() that:
//   1. Acquires a fresh audio-only MediaStream pinned to the new deviceId.
//   2. Calls `RTCRtpSender.replaceTrack` on every active peer connection,
//      which is renegotiation-free — the SDP audio m-section stays valid
//      because we're swapping a track of the same kind.
//   3. Re-applies the PTT muted-by-default state (`enabled = false`)
//      because the new track inherits its enabled flag from the constructor.
//   4. Replaces the old audio track on the local stream so on-screen UI
//      (e.g. mic-monitoring meters) keeps reading the same MediaStream.
//   5. Stops the old track so the OS releases the previous input device.
//
// All side effects happen inside `swap`; the hook itself is purely
// reactive — listing devices and tracking the active deviceId.

import type { TopicRoom } from '@/lib/trystero'

export const AUDIO_DEVICE_DEFAULT_ID = 'default'

export type AudioInputOption = {
  deviceId: string
  label: string
}

export type SwapAudioInputDeps = {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  room: TopicRoom | null
  localStream: MediaStream
}

// Pulls the list of audio inputs through enumerateDevices. The OS strips
// labels until at least one getUserMedia({audio:true}) call has succeeded,
// which the session always has by the time this hook runs.
export async function listAudioInputs(): Promise<AudioInputOption[]> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.enumerateDevices !== 'function'
  ) {
    return []
  }
  const all = await navigator.mediaDevices.enumerateDevices()
  return all
    .filter((d) => d.kind === 'audioinput')
    .map((d) => ({
      deviceId: d.deviceId,
      // Some browsers report empty labels before user gestures; surface
      // a deterministic fallback so the picker rendering is stable.
      label: d.label || labelForUnnamed(d.deviceId),
    }))
}

function labelForUnnamed(deviceId: string): string {
  if (deviceId === AUDIO_DEVICE_DEFAULT_ID) return 'System default'
  return `Microphone ${deviceId.slice(0, 6)}`
}

// S4 — audio OUTPUT enumeration for the speaker/headphone picker. Routing is
// applied per-tile via HTMLMediaElement.setSinkId; see setSinkIdSupported().
export async function listAudioOutputs(): Promise<AudioInputOption[]> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.enumerateDevices !== 'function'
  ) {
    return []
  }
  const all = await navigator.mediaDevices.enumerateDevices()
  return all
    .filter((d) => d.kind === 'audiooutput')
    .map((d) => ({
      deviceId: d.deviceId,
      label: d.label || labelForUnnamedOutput(d.deviceId),
    }))
}

function labelForUnnamedOutput(deviceId: string): string {
  if (deviceId === AUDIO_DEVICE_DEFAULT_ID) return 'System default'
  return `Speaker ${deviceId.slice(0, 6)}`
}

// S4 — feature-detect HTMLMediaElement.setSinkId. macOS WKWebView does NOT
// implement it (and WebView2 does), so the output picker must hide rather than
// offer a control that silently no-ops. Checking the prototype avoids
// constructing a throwaway element when the DOM is absent (Vitest/node).
export function setSinkIdSupported(): boolean {
  if (typeof HTMLMediaElement === 'undefined') return false
  const proto = HTMLMediaElement.prototype as {
    setSinkId?: (id: string) => Promise<void>
  }
  return typeof proto.setSinkId === 'function'
}

// Returns the swapped-in track so the caller can re-attach the I42
// device-loss recovery listener (#47 A3): the acquire-time 'ended' handlers
// only cover tracks present at acquisition, and stop() on the old track
// never fires 'ended' — without re-attaching, a swapped-in headset that
// unplugs mid-session fails silently.
export async function swapAudioInput(
  nextDeviceId: string,
  deps: SwapAudioInputDeps,
  pttActive: boolean
): Promise<MediaStreamTrack> {
  const constraints: MediaStreamConstraints = {
    audio: nextDeviceId ? { deviceId: { exact: nextDeviceId } } : true,
  }
  const fresh = await deps.getUserMedia(constraints)
  const newTrack = fresh.getAudioTracks()[0]
  if (!newTrack) {
    stopAllTracks(fresh)
    throw new Error('selected audio device produced no audio tracks')
  }
  // Stop any tracks on `fresh` we don't intend to keep — extra audio tracks
  // from a browser quirk, or a stray video track if constraints widen
  // later. Without this they'd hold the device handle open after newTrack
  // moves to the local stream and never be referenced again.
  for (const t of fresh.getTracks()) {
    if (t !== newTrack) {
      try {
        t.stop()
      } catch {
        // ignore
      }
    }
  }
  // Inherit the session's current mute-state: muted-by-default with PTT
  // toggling enabled. The fresh track starts enabled, so we mirror.
  newTrack.enabled = pttActive

  const oldTrack = deps.localStream.getAudioTracks()[0] ?? null

  if (deps.room) {
    for (const conn of Object.values(deps.room.getPeers())) {
      for (const sender of conn.getSenders()) {
        if (sender.track && sender.track.kind === 'audio') {
          try {
            await sender.replaceTrack(newTrack)
          } catch (err) {
            console.error('replaceTrack failed for one peer:', err)
          }
        }
      }
    }
  }

  if (oldTrack) {
    try {
      deps.localStream.removeTrack(oldTrack)
    } catch {
      // older Safari throws on remove; ignore
    }
    try {
      oldTrack.stop()
    } catch {
      // ignore
    }
  }
  deps.localStream.addTrack(newTrack)
  return newTrack
}

function stopAllTracks(stream: MediaStream): void {
  for (const t of stream.getTracks()) {
    try {
      t.stop()
    } catch {
      // ignore
    }
  }
}
