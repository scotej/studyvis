import { isMicActive, usePttStore } from '@/stores/pttStore'

export type MicrophoneUpdate = {
  active: boolean
  revision: number
  audioTracks: number
  enabledTracks: number
}

// Native shortcuts must update audio without waiting for a background React
// render, whose scheduling may depend on the window being visible.
export function subscribeMicrophone(
  getStream: () => MediaStream | null,
  onUpdate: (update: MicrophoneUpdate) => void
): () => void {
  const apply = () => {
    const state = usePttStore.getState()
    const active = isMicActive(state)
    const tracks = getStream()?.getAudioTracks() ?? []
    for (const track of tracks) track.enabled = active
    onUpdate({
      active,
      revision: state.revision,
      audioTracks: tracks.length,
      enabledTracks: tracks.filter((track) => track.enabled).length,
    })
  }

  apply()
  return usePttStore.subscribe((state, previous) => {
    if (isMicActive(state) !== isMicActive(previous)) apply()
  })
}
