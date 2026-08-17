#!/usr/bin/env tsx
// Verify that an extracted desktop artifact contains exactly one matched pair
// of the committed cross-platform notice files. The resource directory may be
// passed directly; otherwise the tree is searched so the same command works
// for an AppImage AppDir, a macOS .app, or an unpacked Windows installer.
//
// Usage: tsx scripts/check-third-party-notices-bundle.ts <artifact-root>

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const NOTICE_NAME = 'THIRD-PARTY-NOTICES.txt'
const MANIFEST_NAME = 'THIRD-PARTY-NOTICES.json'
const EXPECTED_NOTICE = join(ROOT, NOTICE_NAME)
const EXPECTED_MANIFEST = join(ROOT, MANIFEST_NAME)

const sha256 = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex')

function fail(message: string): never {
  throw new Error(`third-party notice bundle: ${message}`)
}

function walk(directory: string, matches: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      walk(path, matches)
    } else if (
      entry.isFile() &&
      (entry.name === NOTICE_NAME || entry.name === MANIFEST_NAME)
    ) {
      matches.push(path)
    }
  }
}

function main() {
  const argument = process.argv[2]
  if (!argument || process.argv.length !== 3) {
    fail('usage: check-third-party-notices-bundle.ts <artifact-root>')
  }
  const artifactRoot = resolve(argument)
  if (!existsSync(artifactRoot) || !statSync(artifactRoot).isDirectory()) {
    fail(`${artifactRoot} is not an extracted artifact directory`)
  }
  for (const expected of [EXPECTED_NOTICE, EXPECTED_MANIFEST]) {
    if (!existsSync(expected))
      fail(`committed ${basename(expected)} is missing`)
  }

  const matches: string[] = []
  walk(artifactRoot, matches)
  const notices = matches.filter((path) => basename(path) === NOTICE_NAME)
  const manifests = matches.filter((path) => basename(path) === MANIFEST_NAME)
  if (notices.length !== 1 || manifests.length !== 1) {
    fail(
      `expected exactly one ${NOTICE_NAME}/${MANIFEST_NAME} pair, found ${notices.length}/${manifests.length}`
    )
  }
  if (dirname(notices[0]) !== dirname(manifests[0])) {
    fail('notice and machine manifest are not in the same resource directory')
  }

  const expectedNotice = readFileSync(EXPECTED_NOTICE)
  const expectedManifest = readFileSync(EXPECTED_MANIFEST)
  const bundledNotice = readFileSync(notices[0])
  const bundledManifest = readFileSync(manifests[0])
  if (!bundledNotice.equals(expectedNotice)) {
    fail(
      `${relative(artifactRoot, notices[0])} does not match the committed notice`
    )
  }
  if (!bundledManifest.equals(expectedManifest)) {
    fail(
      `${relative(artifactRoot, manifests[0])} does not match the committed manifest`
    )
  }

  const parsed = JSON.parse(bundledManifest.toString('utf8')) as {
    noticeSha256?: string
  }
  const noticeHash = sha256(bundledNotice)
  if (parsed.noticeSha256 !== noticeHash) {
    fail(
      `machine manifest records notice SHA-256 ${parsed.noticeSha256 ?? '<missing>'}, actual ${noticeHash}`
    )
  }
  process.stdout.write(
    `third-party notice bundle: OK (${relative(artifactRoot, dirname(notices[0])) || '.'}; notice SHA-256 ${noticeHash})\n`
  )
}

try {
  main()
} catch (error: unknown) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exit(1)
}
