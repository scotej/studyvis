export type PeerConnectionConstructor = new () => {
  createDataChannel: (label: string) => unknown
  createOffer: (options?: RTCOfferOptions) => Promise<RTCSessionDescriptionInit>
  setLocalDescription: (
    description?: RTCLocalSessionDescriptionInit
  ) => Promise<void>
  close: () => void
}

/**
 * Proves that the current document received a usable WebRTC constructor.
 *
 * WebKitGTK can expose the rest of the media surface while omitting
 * RTCPeerConnection when its build gate or embedding preference is disabled.
 * Merely checking the property also misses a second packaging failure: a
 * constructor that exists but cannot initialise its data-channel backend.
 */
export async function canCreatePeerConnectionOffer(
  PeerConnection: PeerConnectionConstructor | undefined
): Promise<boolean> {
  if (typeof PeerConnection !== 'function') return false

  let connection: InstanceType<PeerConnectionConstructor> | null = null
  try {
    connection = new PeerConnection()
    connection.createDataChannel('studyvis-startup-probe')
    const offer = await connection.createOffer()
    await connection.setLocalDescription(offer)
    return true
  } catch {
    return false
  } finally {
    try {
      connection?.close()
    } catch {
      // Closing is cleanup, so never let a native teardown exception mask the
      // offer/setLocalDescription result this startup attestation measures.
    }
  }
}
