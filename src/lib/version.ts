// X4 — minimal semver-ish comparison for the opt-in version check. The
// release tags are plain `X.Y.Z` (the Rust command already strips a leading
// `v`), so a full semver parser would be overkill. We compare the three
// numeric segments left-to-right; any pre-release / build suffix on the
// candidate is ignored (a `1.3.0-rc1` is treated as `1.3.0`), which is safe
// here because the project only ships clean `X.Y.Z` tags.

function parseSegments(version: string): [number, number, number] | null {
  // Drop a leading `v` defensively, then any `-pre`/`+build` suffix.
  const core = version.trim().replace(/^v/i, '').split(/[-+]/, 1)[0]
  const parts = core.split('.')
  if (parts.length === 0 || parts.length > 3) return null
  const out: number[] = [0, 0, 0]
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!/^\d+$/.test(part)) return null
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0) return null
    out[i] = n
  }
  return [out[0], out[1], out[2]]
}

// True iff `candidate` is strictly newer than `current`. Returns false for any
// unparseable input so a garbage tag can never surface a phantom update row.
export function isNewerVersion(current: string, candidate: string): boolean {
  const a = parseSegments(current)
  const b = parseSegments(candidate)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true
    if (b[i] < a[i]) return false
  }
  return false
}
