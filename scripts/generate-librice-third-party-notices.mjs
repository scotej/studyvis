#!/usr/bin/env node
// Generate the license inventory for the two librice cdylibs statically linked
// into StudyVis's private Linux WebKit runtime. This stays Node-stdlib-only so
// build-linux-webkit-runtime.sh can run it before npm dependencies are present.
//
// cargo metadata resolves every member of a workspace and can therefore show
// optional features activated by members that StudyVis does not build. The
// shipped closure is instead taken from one exact `cargo tree` invocation per
// cargo-c root; metadata is used only to locate and describe those packages.
//
// Usage:
//   node scripts/generate-librice-third-party-notices.mjs --write SOURCE OUTPUT
//   node scripts/generate-librice-third-party-notices.mjs --check OUTPUT \
//     --expected-lock-sha 2235fad0ca8374fc4e8678dc79fa53918267a244d4582e4aae9c6d9913b2f9f1
//   node scripts/generate-librice-third-party-notices.mjs --self-test

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

const VERSION = '0.4.3'
const TARGET = 'x86_64-unknown-linux-gnu'
const LIBRICE_SOURCE =
  'https://github.com/ystreet/librice/archive/refs/tags/v0.4.3.tar.gz'
const LIBRICE_SOURCE_SHA256 =
  '4671e1835f9ab0f8d87e8d9e22b6bfb06f928aeae442841ab81881dff61e3f4b'
const LOCK_SHA256 =
  '2235fad0ca8374fc4e8678dc79fa53918267a244d4582e4aae9c6d9913b2f9f1'
const ROOT_LICENSE_HASHES = new Map([
  [
    'LICENSE-APACHE',
    'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
  ],
  [
    'LICENSE-MIT',
    '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
  ],
])
const ROOTS = [
  { package: 'rice-proto', features: ['capi'] },
  { package: 'rice-io', features: ['capi'] },
]
const LICENSE_FALLBACKS = new Map(
  [
    [
      'stun-proto@2.0.1',
      '48569275229458b605729c844d73c8178e03c48202ef8f9e658dc28aa5bdec45',
    ],
    [
      'stun-types@2.0.1',
      '6708dce437bffa3a93d18c70279e640cbb9079ac9b44a762bbe3c6cefe93f6ee',
    ],
    [
      'turn-client-openssl@0.1.0',
      '4fc5f5da7fd520f505d17775c45c0ba6de7c899e2d75d329250dc59e5772bfdc',
    ],
    [
      'turn-client-proto@0.7.1',
      '612e9a6edd44c286b22e55058747961d97448fe6e37014e77f1129fb173c82d7',
    ],
    [
      'turn-client-rustls@0.1.0',
      '226a00a95840dffe5a458a4e4a999bfa271059857f151948802ccc9f7a2c8020',
    ],
    [
      'turn-types@0.7.1',
      'a74d0b21919ba67466c8204d6d640678a778de1341fe19fc1a01d33e270f7bcb',
    ],
  ].map(([key, sourceHash]) => [
    key,
    {
      declaredLicense: 'MIT OR Apache-2.0',
      sourcePath: 'src/lib.rs',
      sourceHash,
      reason:
        'This exact crates.io archive omits root license files; its hash-pinned src/lib.rs carries the component copyright, MIT/Apache notice, and SPDX declaration, supplemented by the verified standard texts.',
    },
  ])
)
const NOTICE_NAME = 'LIBRICE-THIRD-PARTY-NOTICES.txt'
const MANIFEST_NAME = 'LIBRICE-THIRD-PARTY-NOTICES.json'
const LICENSE_NAME =
  /^(?:licen[cs]e|copying|notice|copyright|unlicense)(?:[._-].*)?$/i

function fail(message) {
  throw new Error(`librice third-party notices: ${message}`)
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function normalizeText(text) {
  const lf = text.replace(/\r\n?/g, '\n')
  return `${lf.trimEnd()}\n`
}

function readText(path) {
  const bytes = readFileSync(path)
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail(`${path} is not UTF-8 text`)
  }
  return normalizeText(text)
}

function sha256Text(text) {
  return sha256Bytes(Buffer.from(text, 'utf8'))
}

function pathWithin(root, path) {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

function logicalPath(sourceRoot, absolutePath) {
  const rel = relative(sourceRoot, absolutePath)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
    fail(`license path escapes the verified librice source: ${absolutePath}`)
  }
  return `librice:${rel.split(sep).join('/')}`
}

function evidence(sourceRoot, absolutePath, expectedHash) {
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    fail(`required license file is missing: ${absolutePath}`)
  }
  const text = readText(absolutePath)
  const hash = sha256Text(text)
  if (expectedHash && hash !== expectedHash) {
    fail(
      `${logicalPath(sourceRoot, absolutePath)} SHA-256 is ${hash}, expected ${expectedHash}`
    )
  }
  return {
    path: logicalPath(sourceRoot, absolutePath),
    sha256: hash,
    text,
  }
}

function runCargo(sourceRoot, args, purpose) {
  const cargo = process.env.CARGO || 'cargo'
  const result = spawnSync(cargo, args, {
    cwd: sourceRoot,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 100 * 1024 * 1024,
  })
  if (result.status !== 0) {
    fail(
      `${purpose} failed (exit ${result.status ?? 'unknown'}). The verified Cargo.lock closure must be fetched before this offline gate.\n${result.stderr.trim()}`
    )
  }
  return result.stdout
}

function treeArgs(sourceRoot, root) {
  return [
    'tree',
    '--manifest-path',
    join(sourceRoot, 'Cargo.toml'),
    '--locked',
    '--offline',
    '--target',
    TARGET,
    '--package',
    root.package,
    '--edges',
    'normal',
    '--features',
    root.features.join(','),
    '--prefix',
    'none',
    '--format',
    '{p}',
  ]
}

function logicalInvocation(root) {
  return {
    package: root.package,
    features: [...root.features],
    target: TARGET,
    edges: 'normal',
    command: [
      'cargo',
      'tree',
      '--manifest-path',
      'Cargo.toml',
      '--locked',
      '--offline',
      '--target',
      TARGET,
      '--package',
      root.package,
      '--edges',
      'normal',
      '--features',
      root.features.join(','),
      '--prefix',
      'none',
      '--format',
      '{p}',
    ],
  }
}

function parseTreeLine(line) {
  const withoutRepeat = line.endsWith(' (*)') ? line.slice(0, -4) : line
  const match = /^([^\s]+) v([^\s]+)(?: \((.*)\))?$/.exec(withoutRepeat)
  if (!match) fail(`unrecognised cargo tree package line: ${line}`)
  return { name: match[1], version: match[2] }
}

function treeClosure(sourceRoot) {
  const packages = new Map()
  const invocations = []
  for (const root of ROOTS) {
    const args = treeArgs(sourceRoot, root)
    const output = runCargo(sourceRoot, args, `cargo tree for ${root.package}`)
    const keys = new Set()
    for (const line of output.split('\n')) {
      if (!line.trim()) continue
      const parsed = parseTreeLine(line.trim())
      const key = `${parsed.name}@${parsed.version}`
      keys.add(key)
      const entry = packages.get(key) ?? {
        ...parsed,
        roots: new Set(),
      }
      entry.roots.add(root.package)
      packages.set(key, entry)
    }
    const rootKey = `${root.package}@${VERSION}`
    if (!keys.has(rootKey)) fail(`${rootKey} is absent from its own cargo tree`)
    invocations.push(logicalInvocation(root))
  }
  return { packages, invocations }
}

function cargoMetadata(sourceRoot) {
  const output = runCargo(
    sourceRoot,
    [
      'metadata',
      '--manifest-path',
      join(sourceRoot, 'Cargo.toml'),
      '--locked',
      '--offline',
      '--filter-platform',
      TARGET,
      '--format-version',
      '1',
      '--features',
      ROOTS.flatMap((root) =>
        root.features.map((feature) => `${root.package}/${feature}`)
      ).join(','),
    ],
    'cargo metadata'
  )
  try {
    return JSON.parse(output)
  } catch {
    fail('cargo metadata did not emit valid JSON')
  }
}

function metadataIndex(metadata) {
  const index = new Map()
  for (const pkg of metadata.packages ?? []) {
    const key = `${pkg.name}@${pkg.version}`
    const entries = index.get(key) ?? []
    entries.push(pkg)
    index.set(key, entries)
  }
  return index
}

function cargoLockChecksums(lockText) {
  const checksums = new Map()
  let current = {}
  const flush = () => {
    if (current.name && current.version && current.source && current.checksum) {
      checksums.set(
        `${current.name}@${current.version}|${current.source}`,
        current.checksum
      )
    }
    current = {}
  }
  for (const line of lockText.split('\n')) {
    if (line === '[[package]]') {
      flush()
      continue
    }
    const match = /^(name|version|source|checksum) = ("(?:[^"\\]|\\.)*")$/.exec(
      line
    )
    if (match) current[match[1]] = JSON.parse(match[2])
  }
  flush()
  return checksums
}

function packageLicenseFiles(packageDirectory, declaredLicenseFile) {
  const entries = readdirSync(packageDirectory, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && LICENSE_NAME.test(entry.name))
    .map((entry) => join(packageDirectory, entry.name))
  const walkLicenseDirectory = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walkLicenseDirectory(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory() && /^licenses?$/i.test(entry.name)) {
      walkLicenseDirectory(join(packageDirectory, entry.name))
    }
  }
  if (declaredLicenseFile) {
    const declared = resolve(packageDirectory, declaredLicenseFile)
    if (!files.includes(declared)) files.push(declared)
  }
  return [...new Set(files)].sort()
}

function buildComponents(sourceRoot, closure, metadata, lockText) {
  const sourceReal = realpathSync(sourceRoot)
  const rootLicenses = [...ROOT_LICENSE_HASHES].map(([name, hash]) =>
    evidence(sourceReal, join(sourceReal, name), hash)
  )
  const index = metadataIndex(metadata)
  const checksums = cargoLockChecksums(lockText)
  const components = []
  const missingLicenseTexts = []
  const usedFallbacks = new Set()

  for (const [key, closureEntry] of [...closure.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const matches = index.get(key) ?? []
    if (matches.length !== 1) {
      fail(
        `${key} maps to ${matches.length} cargo metadata packages; source identity is ambiguous`
      )
    }
    const pkg = matches[0]
    const declaredLicense = pkg.license?.trim()
    if (!declaredLicense) fail(`${key} has no Cargo license declaration`)
    const packageDirectory = realpathSync(dirname(pkg.manifest_path))
    const isWorkspace = pathWithin(sourceReal, packageDirectory)
    let source
    let checksum
    let licenseFiles
    let override

    if (isWorkspace) {
      const rel = relative(sourceReal, packageDirectory).split(sep).join('/')
      source = `https://github.com/ystreet/librice/tree/v${VERSION}/${rel}`
      if (declaredLicense !== 'MIT OR Apache-2.0') {
        fail(
          `${key} is a librice workspace package with unexpected license '${declaredLicense}'`
        )
      }
      licenseFiles = rootLicenses
      override = {
        reason:
          "The workspace package inherits librice 0.4.3's root MIT OR Apache-2.0 declaration and license files.",
      }
    } else {
      if (!pkg.source?.startsWith('registry+')) {
        fail(`${key} has unsupported non-registry Cargo source '${pkg.source}'`)
      }
      checksum = checksums.get(`${key}|${pkg.source}`)
      if (!checksum) fail(`${key} has no matching checksum in Cargo.lock`)
      source = `https://crates.io/api/v1/crates/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}/download`
      licenseFiles = packageLicenseFiles(
        packageDirectory,
        pkg.license_file
      ).map((path) => {
        const text = readText(path)
        return {
          path: `cargo:${key}/${relative(packageDirectory, path).split(sep).join('/')}`,
          sha256: sha256Text(text),
          text,
        }
      })
      if (licenseFiles.length === 0) {
        const fallback = LICENSE_FALLBACKS.get(key)
        if (!fallback) {
          missingLicenseTexts.push(`${key} (${declaredLicense})`)
          continue
        }
        if (declaredLicense !== fallback.declaredLicense) {
          fail(
            `${key} declares '${declaredLicense}', fallback expects '${fallback.declaredLicense}'`
          )
        }
        const sourceEvidence = (() => {
          const path = join(packageDirectory, fallback.sourcePath)
          const text = readText(path)
          const hash = sha256Text(text)
          if (hash !== fallback.sourceHash) {
            fail(
              `cargo:${key}/${fallback.sourcePath} SHA-256 is ${hash}, expected ${fallback.sourceHash}`
            )
          }
          return {
            path: `cargo:${key}/${fallback.sourcePath}`,
            sha256: hash,
            text,
          }
        })()
        licenseFiles = [...rootLicenses, sourceEvidence].sort((a, b) =>
          a.path.localeCompare(b.path)
        )
        override = { reason: fallback.reason }
        usedFallbacks.add(key)
      }
    }

    if (licenseFiles.length === 0) {
      missingLicenseTexts.push(`${key} (${declaredLicense})`)
      continue
    }
    components.push({
      id: `cargo:${key}`,
      name: pkg.name,
      version: pkg.version,
      licenseExpression: declaredLicense,
      source,
      checksum,
      roots: [...closureEntry.roots].sort(),
      target: TARGET,
      override,
      licenseFiles,
    })
  }
  for (const key of LICENSE_FALLBACKS.keys()) {
    if (!usedFallbacks.has(key)) {
      fail(`unused or stale license fallback: ${key}`)
    }
  }
  if (missingLicenseTexts.length > 0) {
    fail(
      `packages with no shipped license text require reviewed version-bound overrides: ${missingLicenseTexts.join(', ')}`
    )
  }
  return components
}

function renderNotice(components, invocations) {
  const lines = [
    'LIBRICE 0.4.3 THIRD-PARTY NOTICES',
    '=================================',
    '',
    'Generated deterministically by scripts/generate-librice-third-party-notices.mjs.',
    'Do not edit this file directly. Regenerate it from the exact verified librice',
    '0.4.3 source archive and review any Cargo.lock, feature, or license delta.',
    '',
    `Source: ${LIBRICE_SOURCE}`,
    `Source SHA-256: ${LIBRICE_SOURCE_SHA256}`,
    `Cargo.lock SHA-256: ${LOCK_SHA256}`,
    '',
    'Scope: normal dependency edges selected by the two locked/offline cargo tree',
    `invocations below for ${TARGET}. cargo-c enables each package's capi feature.`,
    'Build/dev-only edges and unrelated librice workspace members are excluded.',
    '',
    'This generated inventory is release evidence and an aid to human review. It is',
    'not legal advice, a legal opinion, or a record of legal sign-off.',
    '',
    'Each crates.io component names its direct exact-version source-archive URL and',
    'Cargo.lock SHA-256 so recipients can obtain and verify the named source.',
    '',
    'ROOT INVOCATIONS',
    '================',
    '',
  ]
  for (const invocation of invocations) {
    lines.push(`- ${invocation.command.join(' ')}`)
  }
  lines.push(
    '',
    `Components: ${components.length}.`,
    '',
    'COMPONENT INDEX',
    '===============',
    ''
  )

  for (const component of components) {
    lines.push(
      `- ${component.name} ${component.version} — ${component.licenseExpression}`,
      `  id: ${component.id}`,
      `  roots: ${component.roots.join(', ')}`,
      `  target: ${component.target}`,
      `  source: ${component.source}`
    )
    if (component.checksum)
      lines.push(`  source checksum: ${component.checksum}`)
    if (component.override)
      lines.push(`  override: ${component.override.reason}`)
    for (const file of component.licenseFiles) {
      lines.push(`  license: ${file.path} (SHA-256 ${file.sha256})`)
    }
    lines.push('')
  }

  const texts = new Map()
  for (const component of components) {
    for (const file of component.licenseFiles) {
      const current = texts.get(file.sha256)
      if (current && current.text !== file.text) {
        fail(`SHA-256 collision while grouping ${file.path}`)
      }
      const group = current ?? { text: file.text, references: new Set() }
      group.references.add(`${component.id} — ${file.path}`)
      texts.set(file.sha256, group)
    }
  }

  lines.push('LICENSE TEXTS AND NOTICES', '=========================', '')
  for (const [hash, group] of [...texts.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    lines.push(`SHA-256 ${hash}`, 'Applies to:')
    for (const reference of [...group.references].sort()) {
      lines.push(`- ${reference}`)
    }
    lines.push(
      '',
      '-'.repeat(80),
      '',
      group.text.trimEnd(),
      '',
      '='.repeat(80),
      ''
    )
  }
  return normalizeText(lines.join('\n'))
}

function renderManifest(components, invocations, notice) {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedBy: 'scripts/generate-librice-third-party-notices.mjs',
      noticePath: NOTICE_NAME,
      noticeSha256: sha256Text(notice),
      source: {
        name: 'librice',
        version: VERSION,
        url: LIBRICE_SOURCE,
        sha256: LIBRICE_SOURCE_SHA256,
        cargoLockSha256: LOCK_SHA256,
      },
      closure: {
        rule: 'union of cargo tree normal edges for the exact cargo-c roots; build/dev edges excluded',
        target: TARGET,
        invocations,
      },
      counts: {
        components: components.length,
        workspaceComponents: components.filter((item) =>
          item.source.startsWith('https://github.com/ystreet/librice/tree/')
        ).length,
        registryComponents: components.filter((item) => item.checksum).length,
        distinctLicenseTexts: new Set(
          components.flatMap((item) =>
            item.licenseFiles.map((file) => file.sha256)
          )
        ).size,
      },
      components: components.map((component) => ({
        ...component,
        licenseFiles: component.licenseFiles.map(({ path, sha256 }) => ({
          path,
          sha256,
        })),
      })),
    },
    null,
    2
  )}\n`
}

function compareComponentIdentity(a, b) {
  return (
    a.name.localeCompare(b.name) ||
    a.version.localeCompare(b.version) ||
    a.id.localeCompare(b.id)
  )
}

function parseNoticeLicenseTexts(notice) {
  const marker = 'LICENSE TEXTS AND NOTICES\n=========================\n\n'
  const markerIndex = notice.indexOf(marker)
  if (markerIndex < 0) fail(`missing '${marker.trim()}' section`)
  let cursor = markerIndex + marker.length
  const groups = new Map()
  const separator = '-'.repeat(80)
  const terminator = '='.repeat(80)

  while (cursor < notice.length) {
    const headerEnd = notice.indexOf(`\n\n${separator}\n\n`, cursor)
    if (headerEnd < 0) fail('malformed license-text header')
    const header = notice.slice(cursor, headerEnd)
    const headerLines = header.split('\n')
    const hashMatch = /^SHA-256 ([0-9a-f]{64})$/.exec(headerLines[0] ?? '')
    if (!hashMatch || headerLines[1] !== 'Applies to:') {
      fail('malformed license-text hash/reference header')
    }
    const references = headerLines.slice(2)
    if (
      references.length === 0 ||
      references.some((line) => !line.startsWith('- '))
    ) {
      fail(`license text ${hashMatch[1]} has malformed references`)
    }
    const textStart = headerEnd + `\n\n${separator}\n\n`.length
    const textEnd = notice.indexOf(`\n\n${terminator}\n`, textStart)
    if (textEnd < 0) fail(`license text ${hashMatch[1]} has no terminator`)
    const text = normalizeText(notice.slice(textStart, textEnd))
    const actualHash = sha256Text(text)
    if (actualHash !== hashMatch[1]) {
      fail(
        `embedded license text SHA-256 is ${actualHash}, index says ${hashMatch[1]}`
      )
    }
    if (groups.has(actualHash))
      fail(`duplicate license-text block ${actualHash}`)
    groups.set(actualHash, {
      text,
      references: references.map((line) => line.slice(2)),
    })
    cursor = textEnd + `\n\n${terminator}\n`.length
    if (notice[cursor] === '\n') cursor += 1
  }
  if (groups.size === 0) fail('notice contains no license-text blocks')
  return groups
}

function verifyOutput(outputRoot, expectedLockHash) {
  if (!/^[0-9a-f]{64}$/.test(expectedLockHash)) {
    fail(`invalid expected Cargo.lock SHA-256 '${expectedLockHash}'`)
  }
  if (expectedLockHash !== LOCK_SHA256) {
    fail(
      `requested Cargo.lock SHA-256 ${expectedLockHash} does not match the pinned librice 0.4.3 lock ${LOCK_SHA256}`
    )
  }
  const noticePath = join(outputRoot, NOTICE_NAME)
  const manifestPath = join(outputRoot, MANIFEST_NAME)
  for (const path of [noticePath, manifestPath]) {
    if (!existsSync(path) || !statSync(path).isFile()) {
      fail(`verification input is missing ${basename(path)}`)
    }
  }
  const notice = readFileSync(noticePath, 'utf8')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    fail(`${MANIFEST_NAME} is not valid JSON`)
  }
  if (manifest?.schemaVersion !== 1) fail('unsupported manifest schema')
  if (manifest?.source?.cargoLockSha256 !== expectedLockHash) {
    fail(
      `manifest Cargo.lock SHA-256 '${manifest?.source?.cargoLockSha256 ?? '<missing>'}' does not match ${expectedLockHash}`
    )
  }
  if (manifest.noticeSha256 !== sha256Text(notice)) {
    fail('manifest noticeSha256 does not match the bundled notice bytes')
  }
  if (!Array.isArray(manifest.components) || manifest.components.length === 0) {
    fail('manifest has no components')
  }
  const ids = new Set()
  let previousComponent
  const allowedRoots = new Set(ROOTS.map((root) => root.package))
  const groups = parseNoticeLicenseTexts(notice)
  const components = manifest.components.map((component) => {
    if (
      typeof component?.id !== 'string' ||
      typeof component?.name !== 'string' ||
      typeof component?.version !== 'string' ||
      typeof component?.licenseExpression !== 'string' ||
      !component.licenseExpression.trim()
    ) {
      fail('manifest contains an incomplete or unlicensed component')
    }
    if (ids.has(component.id)) fail(`duplicate component id ${component.id}`)
    ids.add(component.id)
    if (
      previousComponent &&
      compareComponentIdentity(previousComponent, component) > 0
    ) {
      fail(`components are not sorted at ${component.id}`)
    }
    previousComponent = component
    if (component.target !== TARGET) {
      fail(`${component.id} has unexpected target '${component.target}'`)
    }
    if (
      !Array.isArray(component.roots) ||
      component.roots.length === 0 ||
      component.roots.some((root) => !allowedRoots.has(root)) ||
      new Set(component.roots).size !== component.roots.length ||
      [...component.roots].sort().join('\0') !== component.roots.join('\0')
    ) {
      fail(`${component.id} has invalid or unsorted cargo-c roots`)
    }
    const registry = component.source?.startsWith(
      'https://crates.io/api/v1/crates/'
    )
    if (registry) {
      const expectedSource = `https://crates.io/api/v1/crates/${encodeURIComponent(component.name)}/${encodeURIComponent(component.version)}/download`
      if (component.source !== expectedSource) {
        fail(`${component.id} has an unexpected crates.io source URL`)
      }
      if (!/^[0-9a-f]{64}$/.test(component.checksum ?? '')) {
        fail(`${component.id} has no valid Cargo.lock checksum`)
      }
    } else if (
      !component.source?.startsWith(
        `https://github.com/ystreet/librice/tree/v${VERSION}/`
      ) ||
      component.checksum !== undefined
    ) {
      fail(`${component.id} has an unsupported source identity`)
    }
    if (
      !Array.isArray(component.licenseFiles) ||
      component.licenseFiles.length === 0
    ) {
      fail(`${component.id} has no license evidence`)
    }
    return {
      ...component,
      licenseFiles: component.licenseFiles.map((file) => {
        if (
          typeof file?.path !== 'string' ||
          !/^[0-9a-f]{64}$/.test(file?.sha256 ?? '')
        ) {
          fail(`${component.id} has malformed license evidence`)
        }
        const group = groups.get(file.sha256)
        if (!group) {
          fail(`${component.id} references absent license text ${file.sha256}`)
        }
        return { ...file, text: group.text }
      }),
    }
  })
  const expectedInvocations = ROOTS.map(logicalInvocation)
  if (
    JSON.stringify(manifest.closure?.invocations) !==
    JSON.stringify(expectedInvocations)
  ) {
    fail('manifest root commands, target, or capi feature set are not exact')
  }
  const expectedNotice = renderNotice(components, expectedInvocations)
  if (notice !== expectedNotice) {
    fail('notice is not the canonical rendering of its machine manifest')
  }
  const expectedManifest = renderManifest(
    components,
    expectedInvocations,
    expectedNotice
  )
  if (readFileSync(manifestPath, 'utf8') !== expectedManifest) {
    fail('machine manifest is not canonical or its counts/fields are stale')
  }
  process.stdout.write(
    `librice third-party notices: verified ${components.length} locked components without source tree\n`
  )
}

function selfTest() {
  const samples = [
    ['serde v1.0.228', { name: 'serde', version: '1.0.228' }],
    [
      'rice-proto v0.4.3 (/work/librice/rice-proto)',
      { name: 'rice-proto', version: '0.4.3' },
    ],
    [
      'proc-macro2 v1.0.103 (proc-macro) (*)',
      { name: 'proc-macro2', version: '1.0.103' },
    ],
  ]
  for (const [line, expected] of samples) {
    const actual = parseTreeLine(line)
    if (actual.name !== expected.name || actual.version !== expected.version) {
      fail(`self-test tree parser mismatch for '${line}'`)
    }
  }
  let rejected = false
  try {
    parseTreeLine('not cargo tree output')
  } catch {
    rejected = true
  }
  if (!rejected) fail('self-test failed to reject malformed cargo tree output')
  if (normalizeText('a\r\nb') !== 'a\nb\n') {
    fail('self-test newline normalization mismatch')
  }
  process.stdout.write('librice third-party notices: self-test OK\n')
}

async function main() {
  const [mode, firstArgument, secondArgument, thirdArgument, ...extra] =
    process.argv.slice(2)
  if (mode === '--self-test' && !firstArgument && !secondArgument) {
    selfTest()
    return
  }
  if (
    mode === '--check' &&
    firstArgument &&
    secondArgument === '--expected-lock-sha' &&
    thirdArgument &&
    extra.length === 0
  ) {
    verifyOutput(resolve(firstArgument), thirdArgument)
    return
  }
  if (
    mode !== '--write' ||
    !firstArgument ||
    !secondArgument ||
    thirdArgument ||
    extra.length > 0
  ) {
    fail(
      'usage: --write <librice-source-dir> <output-dir> | --check <output-dir> --expected-lock-sha <sha256> | --self-test'
    )
  }

  const sourceRoot = realpathSync(resolve(firstArgument))
  const outputRoot = resolve(secondArgument)
  for (const required of [
    'Cargo.toml',
    'Cargo.lock',
    ...ROOT_LICENSE_HASHES.keys(),
  ]) {
    const path = join(sourceRoot, required)
    if (!existsSync(path) || !statSync(path).isFile()) {
      fail(`verified source input is missing ${required}`)
    }
  }
  const lockBytes = readFileSync(join(sourceRoot, 'Cargo.lock'))
  const actualLockHash = sha256Bytes(lockBytes)
  if (actualLockHash !== LOCK_SHA256) {
    fail(`Cargo.lock SHA-256 is ${actualLockHash}, expected ${LOCK_SHA256}`)
  }
  const lockText = readText(join(sourceRoot, 'Cargo.lock'))
  const { packages, invocations } = treeClosure(sourceRoot)
  const metadata = cargoMetadata(sourceRoot)
  const components = buildComponents(
    sourceRoot,
    packages,
    metadata,
    lockText
  ).sort(compareComponentIdentity)
  const notice = renderNotice(components, invocations)
  const manifest = renderManifest(components, invocations, notice)
  const noticePath = join(outputRoot, NOTICE_NAME)
  const manifestPath = join(outputRoot, MANIFEST_NAME)

  await mkdir(outputRoot, { recursive: true })
  writeFileSync(noticePath, notice, 'utf8')
  writeFileSync(manifestPath, manifest, 'utf8')
  process.stdout.write(
    `librice third-party notices: wrote ${components.length} locked components to ${outputRoot}\n`
  )
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exit(1)
})
