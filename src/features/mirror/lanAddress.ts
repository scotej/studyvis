const IPV4_LITERAL =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

export function isIpv4Literal(value: string | null | undefined): boolean {
  return typeof value === 'string' && IPV4_LITERAL.test(value)
}

// #515 — engines hide host candidates behind mDNS `.local` names until the
// page captures media, and LAN mirroring has no STUN. Networks that block
// multicast cannot resolve those names, so both sides ended up with no usable
// candidate. The socket already proved `address` reaches the peer; a wrong
// port pairing simply fails its connectivity check.
export function replaceMdnsCandidates(sdp: string, address: string): string {
  // A same-computer companion's ICE sockets sit on LAN interfaces, not
  // loopback; keep its mDNS names, which resolve locally.
  if (!isIpv4Literal(address) || /^(127|0)\./.test(address)) return sdp
  return sdp.replace(
    /^(a=candidate:\S+ \d+ \S+ \d+ )([^\s]+\.local)(?= )/gim,
    (_line, prefix: string) => `${prefix}${address}`
  )
}
