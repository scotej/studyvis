export type OriginalMediaTransport = {
  connection: RTCPeerConnection
  channels: RTCDataChannel[]
}

// Evaluated in the page against retained native objects, never a replacement
// connection or a snapshot of what the current room happens to own (#397).
export function originalTransportsClosed(
  transports: OriginalMediaTransport[]
): boolean {
  return (
    transports.length > 0 &&
    transports.every(
      ({ connection, channels }) =>
        connection.connectionState === 'closed' &&
        channels.length > 0 &&
        channels.every((channel) => channel.readyState !== 'open')
    )
  )
}
