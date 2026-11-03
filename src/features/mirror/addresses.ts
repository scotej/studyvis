import type { MirrorConfig } from './wire'

// #515 — config.urls arrives preference-ordered with loopback last; only
// non-loopback addresses are reachable from another device.
export function reachableAddresses(config: MirrorConfig) {
  return config.urls.flatMap((url, index) => {
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return []
    }
    if (host === 'localhost' || host.startsWith('127.')) return []
    const certificateUrl =
      config.certificateUrls?.[index] ??
      (index === 0 ? config.certificateUrl : undefined)
    return [{ url, host, certificateUrl: certificateUrl ?? null }]
  })
}
