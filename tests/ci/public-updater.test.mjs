import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  checkPublicUpdater,
  fetchPublic,
  validateLatestSelection,
  validateManifest,
  verifyMinisignDigest,
  verifySignedFile,
} from '../../scripts/check-public-updater.mjs'

const API = 'https://api.github.com/repos/scotej/studyvis/releases'
const MANIFEST =
  'https://github.com/scotej/studyvis/releases/latest/download/latest.json'
const KEY_ID = Buffer.from('1234567890abcdef', 'hex')

function signer() {
  const pair = generateKeyPairSync('ed25519')
  const raw = pair.publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
  const keyRecord = Buffer.concat([Buffer.from('Ed'), KEY_ID, raw])
  const publicKey = Buffer.from(
    `untrusted comment: test public key\n${keyRecord.toString('base64')}\n`
  ).toString('base64')
  const signature = (bytes) => {
    const digest = createHash('blake2b512').update(bytes).digest()
    const signed = sign(null, digest, pair.privateKey)
    const record = Buffer.concat([Buffer.from('ED'), KEY_ID, signed])
    const comment = 'timestamp:1792108800 file:test'
    const trusted = sign(
      null,
      Buffer.concat([signed, Buffer.from(comment)]),
      pair.privateKey
    )
    return Buffer.from(
      `untrusted comment: test signature\n${record.toString('base64')}\ntrusted comment: ${comment}\n${trusted.toString('base64')}\n`
    ).toString('base64')
  }
  return { publicKey, signature }
}

function fixture({ tag = 'v2.0.0', keys = signer(), idBase = 100 } = {}) {
  const release = {
    tag_name: tag,
    draft: false,
    prerelease: tag.includes('-'),
    assets: [],
  }
  const manifest = { version: tag.slice(1), platforms: {} }
  const responses = new Map()
  const platforms = [
    ['darwin-aarch64', 'StudyVis.app.tar.gz', 'darwin-aarch64-app'],
    ['windows-x86_64', 'StudyVis-setup.exe', 'windows-x86_64-nsis'],
    ['linux-x86_64', 'StudyVis.AppImage', 'linux-x86_64-appimage'],
  ]
  for (const [index, [platform, name, alias]] of platforms.entries()) {
    const bytes = Buffer.from(`signed test installer ${platform}`)
    const id = idBase + index * 2
    const asset = {
      id,
      name,
      size: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      url: `${API}/assets/${id}`,
      browser_download_url: `https://github.com/scotej/studyvis/releases/download/${tag}/${name}`,
    }
    const signature = keys.signature(bytes)
    const sidecar = {
      id: id + 1,
      name: `${name}.sig`,
      size: signature.length,
      url: `${API}/assets/${id + 1}`,
      browser_download_url: `${asset.browser_download_url}.sig`,
    }
    release.assets.push(asset, sidecar)
    manifest.platforms[platform] = { url: asset.url, signature }
    manifest.platforms[alias] = { ...manifest.platforms[platform] }
    responses.set(asset.url, bytes)
    responses.set(sidecar.url, signature)
  }
  const requests = []
  const fetchImpl = async (input, options) => {
    const url = input.href
    requests.push({ url, options })
    assert.equal(options.headers.Authorization, undefined)
    assert.equal(options.credentials, 'omit')
    if (url === `${API}/latest` || url === `${API}/tags/${tag}`)
      return new Response(JSON.stringify(release))
    if (url === MANIFEST) return new Response(JSON.stringify(manifest))
    assert.ok(responses.has(url), `unexpected test request ${url}`)
    assert.equal(options.headers.Accept, 'application/octet-stream')
    return new Response(responses.get(url))
  }
  return { ...keys, release, manifest, responses, requests, fetchImpl }
}

test('generated ED prehash and trusted-comment signatures verify and tampering fails', () => {
  const keys = signer()
  const bytes = Buffer.from('original installer')
  const signature = keys.signature(bytes)
  const digest = createHash('blake2b512').update(bytes).digest()
  verifyMinisignDigest(digest, signature, keys.publicKey)
  const tampered = Buffer.from(digest)
  tampered[0] ^= 1
  assert.throws(
    () => verifyMinisignDigest(tampered, signature, keys.publicKey),
    /artifact signature/
  )
  assert.throws(
    () => verifyMinisignDigest(digest, signature, signer().publicKey),
    /artifact signature/
  )
  const comment = Buffer.from(signature, 'base64')
    .toString()
    .replace('file:test', 'file:evil')
  assert.throws(
    () =>
      verifyMinisignDigest(
        digest,
        Buffer.from(comment).toString('base64'),
        keys.publicKey
      ),
    /trusted-comment/
  )
  assert.throws(
    () => verifyMinisignDigest(digest, 'not base64!', keys.publicKey),
    /base64/
  )
})

test('file verification streams actual file bytes and rejects changed files', async (context) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'studyvis-signature-test-')
  )
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'installer')
  const bytes = Buffer.alloc(2 * 1024 * 1024, 17)
  const keys = signer()
  const signature = keys.signature(bytes)
  await writeFile(filename, bytes)
  assert.deepEqual(
    await verifySignedFile(filename, signature, keys.publicKey),
    {
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      signature: 'verified',
    }
  )
  await writeFile(filename, Buffer.from('tampered'))
  await assert.rejects(
    verifySignedFile(filename, signature, keys.publicKey),
    /artifact signature/
  )
})

test('public canary downloads and verifies every real platform entry with no authentication', async () => {
  const data = fixture()
  const report = await checkPublicUpdater({
    publicKey: data.publicKey,
    publishedTag: 'v2.0.0',
    fetchImpl: data.fetchImpl,
    attempts: 1,
  })
  assert.deepEqual(
    report.assets.map((asset) => asset.platform),
    ['darwin-aarch64', 'windows-x86_64', 'linux-x86_64']
  )
  assert.ok(report.assets.every((asset) => asset.signature === 'verified'))
  assert.equal(report.publicAuthentication, 'none')
  assert.equal(data.requests.length, 9)
})

test('manifest rejects swapped installer URLs, stale versions, missing aliases and foreign releases', () => {
  for (const mutation of [
    (data) => {
      data.manifest.platforms['linux-x86_64'].url =
        data.manifest.platforms['windows-x86_64'].url
    },
    (data) => {
      data.manifest.version = '1.12.8'
    },
    (data) => {
      delete data.manifest.platforms['linux-x86_64-appimage']
    },
    (data) => {
      data.release.assets[0].browser_download_url =
        'https://github.com/scotej/studyvis/releases/download/v1.12.8/StudyVis.app.tar.gz'
    },
  ]) {
    const data = fixture()
    mutation(data)
    assert.throws(() => validateManifest(data.manifest, data.release))
  }
})

test('public sidecar disagreement and response digest tampering fail', async () => {
  const data = fixture()
  const sidecar = data.release.assets.find((asset) =>
    asset.name.endsWith('.sig')
  )
  data.responses.set(sidecar.url, 'wrong signature')
  await assert.rejects(
    checkPublicUpdater({
      publicKey: data.publicKey,
      fetchImpl: data.fetchImpl,
      attempts: 1,
    }),
    /sidecar disagree/
  )
  const altered = fixture()
  const asset = altered.release.assets[0]
  altered.responses.set(asset.url, Buffer.alloc(asset.size, 42))
  await assert.rejects(
    checkPublicUpdater({
      publicKey: altered.publicKey,
      fetchImpl: altered.fetchImpl,
      attempts: 1,
    }),
    /digest differs/
  )
})

test('a stable publish must become public latest; a prerelease cannot replace it', () => {
  const { release } = fixture()
  assert.throws(
    () => validateLatestSelection(release, { ...release, tag_name: 'v2.0.1' }),
    /expected v2.0.1/
  )
  validateLatestSelection(release, {
    ...release,
    tag_name: 'v2.0.1-beta.1',
    prerelease: true,
  })
  assert.throws(
    () =>
      validateLatestSelection(
        { ...release, tag_name: 'v2.0.1-beta.1', prerelease: true },
        { ...release, tag_name: 'v2.0.1-beta.1', prerelease: true }
      ),
    /must be stable/
  )
})

test('propagation retries are bounded and revalidate the public route', async () => {
  const data = fixture()
  let calls = 0
  const fetchImpl = async (...args) =>
    ++calls === 1
      ? new Response('not published yet', { status: 404 })
      : data.fetchImpl(...args)
  const report = await checkPublicUpdater({
    publicKey: data.publicKey,
    fetchImpl,
    attempts: 2,
    retryDelayMs: 0,
  })
  assert.equal(report.tag, 'v2.0.0')
  let failures = 0
  await assert.rejects(
    checkPublicUpdater({
      publicKey: data.publicKey,
      fetchImpl: async () => {
        failures += 1
        return new Response('unavailable', { status: 503 })
      },
      attempts: 3,
      retryDelayMs: 0,
    }),
    /HTTP 503/
  )
  assert.equal(failures, 3)
})

test('public requests reject foreign hosts before opening a connection', async () => {
  let called = false
  await assert.rejects(
    fetchPublic('https://attacker.invalid/installer', {
      fetchImpl: async () => {
        called = true
      },
    }),
    /unreviewed public/
  )
  assert.equal(called, false)
})

test('full prerelease verification preserves and independently validates the stable channel', async () => {
  const stable = fixture()
  const beta = fixture({ tag: 'v2.0.1-beta.1', keys: stable, idBase: 200 })
  const fetchImpl = async (input, options) => {
    if (input.href === `${API}/latest` || input.href === MANIFEST)
      return stable.fetchImpl(input, options)
    if (
      input.href ===
      'https://github.com/scotej/studyvis/releases/download/v2.0.1-beta.1/latest.json'
    )
      return new Response(JSON.stringify(beta.manifest))
    return beta.fetchImpl(input, options)
  }
  const report = await checkPublicUpdater({
    publicKey: stable.publicKey,
    publishedTag: beta.release.tag_name,
    fetchImpl,
    attempts: 1,
  })
  assert.equal(report.tag, 'v2.0.1-beta.1')
  assert.equal(report.stableLatest, 'v2.0.0')
  assert.equal(report.assets.length, 3)
})

test('requested published tag cannot be satisfied by older release metadata', async () => {
  const data = fixture()
  const fetchImpl = async (input, options) =>
    input.href === `${API}/tags/v2.0.1`
      ? new Response(JSON.stringify(data.release))
      : data.fetchImpl(input, options)
  await assert.rejects(
    checkPublicUpdater({
      publicKey: data.publicKey,
      publishedTag: 'v2.0.1',
      fetchImpl,
      attempts: 1,
    }),
    /metadata tag mismatch/
  )
})
