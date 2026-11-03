// #515 — desktop side of the browser companion's session media.
//
// The desktop relays the browser's camera to every session peer. Each browser
// reconnect delivers new receiver tracks; removing and re-adding the stream
// made every peer renegotiate, and a peer whose renegotiation lost a race kept
// a frozen last frame. The relay stream is published once per takeover and its
// tracks are swapped in place with replaceTrack, which needs no renegotiation.

// Wire payload for `camera-state`. `companion` is optional and ignored by
// builds that predate it, so `off` stays authoritative for them.
export type CameraPayload = { off: boolean; companion?: boolean }

export function cameraPayload(
  cameraOn: boolean,
  companionSetup: boolean
): CameraPayload {
  return companionSetup ? { off: true, companion: true } : { off: !cameraOn }
}

export function readCameraPayload(data: unknown): {
  off: boolean
  companion: boolean
} {
  if (!data || typeof data !== 'object') return { off: false, companion: false }
  const value = data as Record<string, unknown>
  return { off: Boolean(value.off), companion: value.companion === true }
}

// A muted receiver track has stopped delivering frames, which a peer would
// otherwise see as a frozen picture.
export function hasLiveVideo(stream: MediaStream | null): boolean {
  return (
    stream
      ?.getVideoTracks()
      .some((track) => track.readyState === 'live' && !track.muted) ?? false
  )
}

export function watchLiveVideo(
  stream: MediaStream | null,
  onChange: (live: boolean) => void
): () => void {
  const tracks = stream?.getVideoTracks() ?? []
  const update = () => onChange(hasLiveVideo(stream))
  for (const track of tracks)
    for (const type of ['mute', 'unmute', 'ended'])
      track.addEventListener(type, update)
  update()
  return () => {
    for (const track of tracks)
      for (const type of ['mute', 'unmute', 'ended'])
        track.removeEventListener(type, update)
  }
}

type SenderHost = Pick<RTCPeerConnection, 'getSenders'>

export type SwapRelayTracksDeps = {
  relay: MediaStream
  next: MediaStream
  peers: () => SenderHost[]
  isCurrent: () => boolean
  onReplaceTrack?: (operation: Promise<void>) => void
}

// Every track a relay has published, so a swap interrupted by an ownership
// change can still be reconciled: the next swap, or the takeover's teardown,
// finds senders left on any earlier relay track, not only the latest one.
const retiredRelayTracks = new WeakMap<MediaStream, Set<MediaStreamTrack>>()

export function relayTracksEverPublished(
  relay: MediaStream
): MediaStreamTrack[] {
  return [...relay.getTracks(), ...(retiredRelayTracks.get(relay) ?? [])]
}

// Returns false when ownership changed before every sender was reconciled.
export async function swapRelayTracks({
  relay,
  next,
  peers,
  isCurrent,
  onReplaceTrack,
}: SwapRelayTracksDeps): Promise<boolean> {
  if (!isCurrent()) return false
  const retired = retiredRelayTracks.get(relay) ?? new Set<MediaStreamTrack>()
  retiredRelayTracks.set(relay, retired)
  // Commit the relay first: joins during the awaits below then publish the
  // new tracks, and an interrupted swap leaves no sender unaccounted for.
  for (const kind of ['video', 'audio'] as const) {
    const previous = relay.getTracks().find((track) => track.kind === kind)
    const replacement = next.getTracks().find((track) => track.kind === kind)
    if (!previous || !replacement || previous === replacement) continue
    relay.removeTrack(previous)
    relay.addTrack(replacement)
    retired.add(previous)
  }
  retired.delete(relay.getVideoTracks()[0])
  retired.delete(relay.getAudioTracks()[0])
  if (retired.size === 0) return isCurrent()
  const attempted = new Set<RTCRtpSender>()
  while (isCurrent()) {
    // #381 — a join can publish older relay tracks during any await.
    // Re-read every connection until no sender still carries one.
    const pending = peers()
      .flatMap((connection) => connection.getSenders())
      .find(
        (sender) =>
          !attempted.has(sender) &&
          sender.track !== null &&
          retired.has(sender.track)
      )
    if (!pending) break
    attempted.add(pending)
    const replacement = relay
      .getTracks()
      .find((track) => track.kind === pending.track!.kind)
    if (!replacement) continue
    const operation = pending.replaceTrack(replacement).catch(() => {
      // A closed connection keeps its old sender; its peer is leaving.
    })
    onReplaceTrack?.(operation)
    await operation
  }
  return isCurrent()
}
