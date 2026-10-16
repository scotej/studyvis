import { createHash, createPublicKey, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const REPOSITORY = 'scotej/studyvis'
const API = `https://api.github.com/repos/${REPOSITORY}/releases`
const PUBLIC_MANIFEST = `https://github.com/${REPOSITORY}/releases/latest/download/latest.json`
const PLATFORMS = {
  'darwin-aarch64': { suffix: '.app.tar.gz', alias: 'darwin-aarch64-app' },
  'windows-x86_64': { suffix: '-setup.exe', alias: 'windows-x86_64-nsis' },
  'linux-x86_64': { suffix: '.AppImage', alias: 'linux-x86_64-appimage' },
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function base64(value, label) {
  requireValue(
    typeof value === 'string' && value.length < 64 * 1024,
    `invalid ${label}`
  )
  const encoded = value.trim()
  requireValue(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded
    ),
    `invalid ${label} base64`
  )
  return Buffer.from(encoded, 'base64')
}

export function verifyMinisignDigest(digest, signatureBase64, publicKeyBase64) {
  requireValue(
    Buffer.isBuffer(digest) && digest.length === 64,
    'expected a BLAKE2b-512 digest'
  )
  const keyLines = base64(publicKeyBase64, 'updater public key')
    .toString('utf8')
    .trim()
    .split(/\r?\n/)
  requireValue(
    keyLines.length === 2 && keyLines[0].startsWith('untrusted comment: '),
    'invalid minisign public key text'
  )
  const key = base64(keyLines[1], 'minisign key record')
  requireValue(
    key.length === 42 && key.subarray(0, 2).toString() === 'Ed',
    'unsupported minisign public key'
  )
  const lines = base64(signatureBase64, 'updater signature')
    .toString('utf8')
    .trim()
    .split(/\r?\n/)
  requireValue(
    lines.length === 4 &&
      lines[0].startsWith('untrusted comment: ') &&
      lines[2].startsWith('trusted comment: '),
    'invalid minisign signature text'
  )
  const record = base64(lines[1], 'minisign signature record')
  requireValue(
    record.length === 74 && record.subarray(0, 2).toString() === 'ED',
    'updater signature must use minisign ED prehash mode'
  )
  requireValue(
    record.subarray(2, 10).equals(key.subarray(2, 10)),
    'updater signing-key ID mismatch'
  )
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      key.subarray(10),
    ]),
    format: 'der',
    type: 'spki',
  })
  requireValue(
    verify(null, digest, publicKey, record.subarray(10)),
    'updater artifact signature does not verify'
  )
  const commentSignature = base64(lines[3], 'trusted-comment signature')
  requireValue(
    commentSignature.length === 64 &&
      verify(
        null,
        Buffer.concat([
          record.subarray(10),
          Buffer.from(lines[2].slice('trusted comment: '.length)),
        ]),
        publicKey,
        commentSignature
      ),
    'updater trusted-comment signature does not verify'
  )
}

async function hashStream(stream, expectedSize) {
  const sha256 = createHash('sha256')
  const blake = createHash('blake2b512')
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    requireValue(
      size <= (expectedSize ?? 2 * 1024 ** 3),
      'updater asset exceeds expected size'
    )
    sha256.update(chunk)
    blake.update(chunk)
  }
  if (expectedSize !== undefined)
    requireValue(
      size === expectedSize,
      'updater asset size differs from release metadata'
    )
  return { sha256: sha256.digest('hex'), digest: blake.digest(), size }
}

export async function verifySignedFile(
  filename,
  signatureBase64,
  publicKeyBase64
) {
  const result = await hashStream(createReadStream(filename))
  verifyMinisignDigest(result.digest, signatureBase64, publicKeyBase64)
  return { sha256: result.sha256, size: result.size, signature: 'verified' }
}

function releaseVersion(release) {
  requireValue(
    release &&
      release.draft === false &&
      /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.tag_name),
    'expected a published full SemVer release'
  )
  const version = release.tag_name.slice(1)
  requireValue(
    Boolean(release.prerelease) === version.includes('-'),
    'release prerelease flag disagrees with its tag'
  )
  requireValue(
    Array.isArray(release.assets),
    'release metadata has no asset inventory'
  )
  return version
}

export function validateLatestSelection(latest, published) {
  releaseVersion(latest)
  releaseVersion(published)
  requireValue(
    latest.prerelease === false,
    'public latest release must be stable'
  )
  if (published.prerelease)
    requireValue(
      latest.tag_name !== published.tag_name,
      'a prerelease replaced the stable updater channel'
    )
  else
    requireValue(
      latest.tag_name === published.tag_name,
      `public latest release is ${latest.tag_name}, expected ${published.tag_name}`
    )
}

export function validateManifest(manifest, release) {
  const version = releaseVersion(release)
  requireValue(
    manifest?.version === version,
    `public updater manifest version must be ${version}`
  )
  requireValue(
    manifest.platforms && typeof manifest.platforms === 'object',
    'updater manifest has no platform map'
  )
  return Object.entries(PLATFORMS).map(([platform, policy]) => {
    const entry = manifest.platforms[platform]
    requireValue(
      entry &&
        typeof entry.url === 'string' &&
        typeof entry.signature === 'string' &&
        entry.signature.length > 0,
      `missing signed updater platform ${platform}`
    )
    const matches = release.assets.filter(
      (asset) =>
        asset.url === entry.url || asset.browser_download_url === entry.url
    )
    requireValue(
      matches.length === 1,
      `${platform} updater URL must name one exact asset on this release`
    )
    const asset = matches[0]
    requireValue(
      typeof asset.name === 'string' && asset.name.endsWith(policy.suffix),
      `${platform} updater URL points to the wrong installer format`
    )
    requireValue(
      Number.isSafeInteger(asset.id) &&
        asset.id > 0 &&
        Number.isSafeInteger(asset.size) &&
        asset.size > 0 &&
        asset.size <= 2 * 1024 ** 3,
      `${platform} asset metadata is incomplete`
    )
    requireValue(
      asset.url === `${API}/assets/${asset.id}`,
      `${platform} asset API URL is outside this repository`
    )
    const expectedBrowserUrl = `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(asset.name)}`
    requireValue(
      asset.browser_download_url === expectedBrowserUrl,
      `${platform} browser asset URL disagrees with this release`
    )
    const alias = manifest.platforms[policy.alias]
    requireValue(
      alias?.url === entry.url && alias?.signature === entry.signature,
      `${platform} updater alias differs from its base entry`
    )
    const sidecars = release.assets.filter(
      (candidate) => candidate.name === `${asset.name}.sig`
    )
    requireValue(
      sidecars.length === 1,
      `${platform} signature sidecar is missing or ambiguous`
    )
    requireValue(
      Number.isSafeInteger(sidecars[0].id) &&
        sidecars[0].id > 0 &&
        sidecars[0].url === `${API}/assets/${sidecars[0].id}` &&
        sidecars[0].browser_download_url === `${expectedBrowserUrl}.sig`,
      `${platform} sidecar URL disagrees with this release`
    )
    return { platform, entry, asset, sidecar: sidecars[0] }
  })
}

export async function fetchPublic(
  url,
  {
    accept = 'application/vnd.github+json',
    timeout = 30_000,
    fetchImpl = fetch,
  } = {}
) {
  const target = new URL(url)
  requireValue(
    target.protocol === 'https:' &&
      ['github.com', 'api.github.com'].includes(target.hostname) &&
      !target.username &&
      !target.password,
    'unreviewed public updater URL'
  )
  // Match the installed updater's unauthenticated binary requests. In
  // particular GH_TOKEN/GITHUB_TOKEN must never mask a broken public route.
  const response = await fetchImpl(target, {
    headers: { Accept: accept, 'User-Agent': 'StudyVis-public-updater-canary' },
    credentials: 'omit',
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  })
  requireValue(response.ok, `public updater HTTP ${response.status}: ${url}`)
  return response
}

async function publicJson(url, fetchImpl) {
  const response = await fetchPublic(url, { fetchImpl })
  const text = await response.text()
  requireValue(
    Buffer.byteLength(text) < 2 * 1024 * 1024,
    'public metadata exceeds 2 MiB'
  )
  return JSON.parse(text)
}

export async function verifyPublicAsset(item, publicKey, fetchImpl = fetch) {
  const signatureResponse = await fetchPublic(item.sidecar.url, {
    accept: 'application/octet-stream',
    fetchImpl,
  })
  const sidecar = (await signatureResponse.text()).trim()
  requireValue(
    sidecar === item.entry.signature.trim(),
    `${item.platform} manifest and public signature sidecar disagree`
  )
  const response = await fetchPublic(item.entry.url, {
    accept: 'application/octet-stream',
    timeout: 300_000,
    fetchImpl,
  })
  requireValue(
    response.body,
    `${item.platform} public asset has no response body`
  )
  const result = await hashStream(response.body, item.asset.size)
  if (item.asset.digest != null)
    requireValue(
      item.asset.digest === `sha256:${result.sha256}`,
      `${item.platform} asset digest differs from release metadata`
    )
  verifyMinisignDigest(result.digest, item.entry.signature, publicKey)
  return {
    platform: item.platform,
    name: item.asset.name,
    size: result.size,
    sha256: result.sha256,
    signature: 'verified',
  }
}

export async function checkPublicUpdater({
  publicKey,
  publishedTag,
  fetchImpl = fetch,
  attempts = 3,
  retryDelayMs = 5000,
} = {}) {
  requireValue(
    Number.isInteger(attempts) && attempts > 0 && attempts <= 3,
    'public updater retries must be between one and three'
  )
  let failure
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const latest = await publicJson(`${API}/latest`, fetchImpl)
      requireValue(
        !publishedTag ||
          /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(publishedTag),
        'invalid published tag'
      )
      const published = publishedTag
        ? await publicJson(
            `${API}/tags/${encodeURIComponent(publishedTag)}`,
            fetchImpl
          )
        : latest
      requireValue(
        !publishedTag || published.tag_name === publishedTag,
        'published release metadata tag mismatch'
      )
      validateLatestSelection(latest, published)
      const stableManifest = await publicJson(PUBLIC_MANIFEST, fetchImpl)
      validateManifest(stableManifest, latest)
      const manifest = published.prerelease
        ? await publicJson(
            `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(published.tag_name)}/latest.json`,
            fetchImpl
          )
        : stableManifest
      const items = validateManifest(manifest, published)
      const assets = []
      for (const item of items)
        assets.push(await verifyPublicAsset(item, publicKey, fetchImpl))
      return {
        checkedAt: new Date().toISOString(),
        tag: published.tag_name,
        stableLatest: latest.tag_name,
        publicAuthentication: 'none',
        assets,
      }
    } catch (error) {
      failure = error
      if (attempt + 1 < attempts)
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    }
  }
  throw failure
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const options = {}
    for (let index = 2; index < process.argv.length; index += 2) {
      requireValue(
        ['--published-tag', '--output'].includes(process.argv[index]) &&
          process.argv[index + 1],
        'usage: node scripts/check-public-updater.mjs [--published-tag vX.Y.Z] [--output report.json]'
      )
      options[process.argv[index]] = process.argv[index + 1]
    }
    const config = JSON.parse(
      await readFile(
        new URL('../src-tauri/tauri.conf.json', import.meta.url),
        'utf8'
      )
    )
    const report = await checkPublicUpdater({
      publicKey: config.plugins.updater.pubkey,
      publishedTag: options['--published-tag'],
    })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (options['--output'])
      await writeFile(
        options['--output'],
        `${JSON.stringify(report, null, 2)}\n`
      )
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `### Public updater delivery\n\nUnauthenticated ${report.tag}; stable latest ${report.stableLatest}. All three platform assets downloaded and verified against the embedded minisign key, public sidecars and release metadata.\n`
      )
  } catch (error) {
    console.error(`Public updater delivery failed: ${error.message}`)
    process.exitCode = 1
  }
}
