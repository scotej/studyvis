import type { MirrorConfig } from './wire'

// #515 — config.urls arrives preference-ordered with loopback last; only
// non-loopback addresses are reachable from another device. With none, the
// loopback link still serves a browser on this same computer.
export function reachableAddresses(config: MirrorConfig) {
  const all = linkAddresses(config)
  const lan = all.filter((address) => !address.loopback)
  return lan.length > 0 ? lan : all
}

export function hasLanAddress(config: MirrorConfig) {
  return linkAddresses(config).some((address) => !address.loopback)
}

function linkAddresses(config: MirrorConfig) {
  return config.urls.flatMap((url, index) => {
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return []
    }
    const loopback = host === 'localhost' || host.startsWith('127.')
    const certificateUrl =
      config.certificateUrls?.[index] ??
      (index === 0 ? config.certificateUrl : undefined)
    return [{ url, host, loopback, certificateUrl: certificateUrl ?? null }]
  })
}
