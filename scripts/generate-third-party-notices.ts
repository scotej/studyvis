#!/usr/bin/env tsx
// Generate the notices that ship in every desktop bundle from the two locked
// release dependency graphs. This is deliberately a repository-owned gate:
// package-manager metadata finds the closure, while explicit, version-bound
// overrides cover archives that omit their license file and StudyVis's two
// non-registry inputs (vendored Wry and the llama.cpp sidecar).
//
// Usage:
//   npm run generate-notices  # rewrite committed outputs
//   npm run check-notices     # regenerate in memory and require an exact diff
//
// Cargo metadata is offline on purpose. CI fetches every supported desktop
// target from Cargo.lock first; locally, run the three `cargo fetch --locked
// --target ...` commands documented in INSTALL.md if the cache is cold.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const OVERRIDES_PATH = join(
  ROOT,
  'scripts',
  'third-party-notices-overrides.json'
)
const NOTICE_PATH = join(ROOT, 'THIRD-PARTY-NOTICES.txt')
const MANIFEST_PATH = join(ROOT, 'THIRD-PARTY-NOTICES.json')
const BUNDLE_NOTICE_PATH = join(
  ROOT,
  'src-tauri',
  'resources',
  'THIRD-PARTY-NOTICES.txt'
)
const BUNDLE_MANIFEST_PATH = join(
  ROOT,
  'src-tauri',
  'resources',
  'THIRD-PARTY-NOTICES.json'
)

const LICENSE_NAME =
  /^(?:licen[cs]e|copying|notice|copyright|unlicense)(?:[._-].*)?$/i

type LicenseReference = {
  repositoryPath?: string
  expectedSha256?: string
  cargoPackage?: string
  npmLockPath?: string
  packagePath?: string
  path?: string
}

type ComponentSpec = {
  name: string
  version: string
  declaredLicense: string
}

type CargoOverride = ComponentSpec & {
  selectedLicense?: string
  source: string
  reason: string
  licenseFiles: LicenseReference[]
}

type CargoFallback = {
  reason: string
  selectedLicense?: string
  components: ComponentSpec[]
  licenseFiles: LicenseReference[]
}

type NpmOverride = ComponentSpec & {
  lockPath: string
  reason: string
  sourceRevision?: string
  licenseFiles: LicenseReference[]
}

type ExternalComponent = ComponentSpec & {
  commit: string
  source: string
  licenseFiles: LicenseReference[]
}

type RequiredNpmComponent = ComponentSpec & {
  licenseFile: string
  expectedSha256: string
}

type Overrides = {
  schemaVersion: number
  cargoTargets: string[]
  cargoOverrides: CargoOverride[]
  cargoFallbacks: CargoFallback[]
  npmOverrides: NpmOverride[]
  externalComponents: ExternalComponent[]
  requiredNpmComponents: RequiredNpmComponent[]
}

type CargoPackage = {
  id: string
  name: string
  version: string
  license: string | null
  license_file: string | null
  manifest_path: string
  source: string | null
  repository: string | null
}

type CargoNode = {
  id: string
  deps: Array<{
    pkg: string
    dep_kinds: Array<{ kind: string | null; target: string | null }>
  }>
}

type CargoMetadata = {
  packages: CargoPackage[]
  resolve: { root: string | null; nodes: CargoNode[] } | null
}

type CargoClosureEntry = {
  pkg: CargoPackage
  targets: Set<string>
}

type NpmLockEntry = {
  version?: string
  resolved?: string
  integrity?: string
  dev?: boolean
  license?: string
}

type PackageLock = {
  lockfileVersion: number
  packages: Record<string, NpmLockEntry>
}

type PackageJson = {
  name?: string
  version?: string
  license?: string | { type?: string }
  repository?: string | { url?: string }
}

type LicenseEvidence = {
  path: string
  sha256: string
  text: string
}

type ManifestLicenseFile = Omit<LicenseEvidence, 'text'>

type NoticeComponent = {
  id: string
  ecosystem: 'cargo' | 'npm' | 'external'
  name: string
  version: string
  licenseExpression: string
  selectedLicenseExpression?: string
  source: string
  checksum?: string
  repository?: string
  integrity?: string
  lockPath?: string
  targets: string[]
  override?: {
    reason: string
    sourceRevision?: string
  }
  licenseFiles: LicenseEvidence[]
}

type ManifestComponent = Omit<NoticeComponent, 'licenseFiles'> & {
  licenseFiles: ManifestLicenseFile[]
}

function fail(message: string): never {
  throw new Error(`third-party notices: ${message}`)
}

function normalizeText(text: string): string {
  const lf = text.replace(/\r\n?/g, '\n')
  return `${lf.trimEnd()}\n`
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function readUtf8(path: string): string {
  const bytes = readFileSync(path)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail(`${displayPath(path)} is not UTF-8 text`)
  }
  return normalizeText(text)
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function displayPath(path: string): string {
  const rel = relative(ROOT, path)
  if (rel && rel !== '..' && !rel.startsWith(`..${sep}`)) {
    return rel.split(sep).join('/')
  }
  return path
}

function componentKey(name: string, version: string): string {
  return `${name}@${version}`
}

function uniqueByPath(files: LicenseEvidence[]): LicenseEvidence[] {
  const seen = new Set<string>()
  return files
    .filter((file) => {
      if (seen.has(file.path)) return false
      seen.add(file.path)
      return true
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}

function evidence(
  absolutePath: string,
  logicalPath: string,
  expectedSha256?: string
): LicenseEvidence {
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    fail(`required license file is missing: ${logicalPath}`)
  }
  const text = readUtf8(absolutePath)
  const actual = sha256(text)
  if (expectedSha256 && actual !== expectedSha256) {
    fail(
      `${logicalPath} SHA-256 is ${actual}, expected ${expectedSha256}; review the source before updating the override`
    )
  }
  return { path: logicalPath, sha256: actual, text }
}

function runCargoMetadata(target: string): CargoMetadata {
  const cargo = process.env.CARGO || 'cargo'
  const result = spawnSync(
    cargo,
    [
      'metadata',
      '--locked',
      '--offline',
      '--format-version',
      '1',
      '--filter-platform',
      target,
    ],
    {
      cwd: join(ROOT, 'src-tauri'),
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024,
      env: process.env,
    }
  )
  if (result.status !== 0) {
    fail(
      `cargo metadata failed for ${target}. Fetch Cargo.lock for every documented target first.\n${result.stderr.trim()}`
    )
  }
  return JSON.parse(result.stdout) as CargoMetadata
}

function cargoClosure(targets: string[]): Map<string, CargoClosureEntry> {
  const closure = new Map<string, CargoClosureEntry>()
  for (const target of targets) {
    const metadata = runCargoMetadata(target)
    if (!metadata.resolve?.root)
      fail(`cargo metadata has no root for ${target}`)
    const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]))
    const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
    const stack = [metadata.resolve.root]
    const seen = new Set<string>()

    while (stack.length > 0) {
      const id = stack.pop()
      if (!id || seen.has(id)) continue
      seen.add(id)
      const node = nodes.get(id)
      if (!node) fail(`cargo resolve node is missing for ${id}`)
      for (const dep of node.deps) {
        // Build and dev dependencies execute while producing/testing the app,
        // but their code is not linked into the shipped runtime notice scope.
        if (dep.dep_kinds.some((kind) => kind.kind === null))
          stack.push(dep.pkg)
      }
    }

    for (const id of seen) {
      if (id === metadata.resolve.root) continue
      const pkg = packages.get(id)
      if (!pkg) fail(`cargo package metadata is missing for ${id}`)
      const current = closure.get(id) ?? { pkg, targets: new Set<string>() }
      current.targets.add(target)
      closure.set(id, current)
    }
  }
  return closure
}

function cargoPackageIndex(
  closure: Map<string, CargoClosureEntry>
): Map<string, CargoPackage> {
  const index = new Map<string, CargoPackage>()
  for (const { pkg } of closure.values()) {
    const key = componentKey(pkg.name, pkg.version)
    const existing = index.get(key)
    if (existing && existing.id !== pkg.id) {
      fail(`cargo closure contains ambiguous sources for ${key}`)
    }
    index.set(key, pkg)
  }
  return index
}

function cargoLockChecksums(): Map<string, string> {
  const checksums = new Map<string, string>()
  const lock = readUtf8(join(ROOT, 'src-tauri', 'Cargo.lock'))
  let current: Record<string, string> = {}
  const flush = () => {
    if (current.name && current.version && current.source && current.checksum) {
      checksums.set(
        `${componentKey(current.name, current.version)}|${current.source}`,
        current.checksum
      )
    }
    current = {}
  }
  for (const line of lock.split('\n')) {
    if (line === '[[package]]') {
      flush()
      continue
    }
    const match = /^(name|version|source|checksum) = ("(?:[^"\\]|\\.)*")$/.exec(
      line
    )
    if (match) current[match[1]] = JSON.parse(match[2]) as string
  }
  flush()
  return checksums
}

function topLevelLicenseFiles(
  directory: string,
  declaredLicenseFile?: string | null
): string[] {
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_NAME.test(entry.name))
    .map((entry) => join(directory, entry.name))

  if (declaredLicenseFile) {
    const declared = resolve(directory, declaredLicenseFile)
    if (!files.includes(declared)) files.push(declared)
  }
  return files.sort()
}

function cargoFileEvidence(
  pkg: CargoPackage,
  absolutePath: string
): LicenseEvidence {
  const base = dirname(pkg.manifest_path)
  const rel = relative(base, absolutePath).split(sep).join('/')
  return evidence(
    absolutePath,
    `cargo:${componentKey(pkg.name, pkg.version)}/${rel}`
  )
}

function npmPackageJson(lockPath: string): PackageJson {
  const path = join(ROOT, lockPath, 'package.json')
  if (!existsSync(path)) {
    fail(
      `${lockPath} is in package-lock.json's production closure but npm ci did not install it`
    )
  }
  return readJson<PackageJson>(path)
}

function licenseExpression(value: PackageJson['license']): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (
    value &&
    typeof value === 'object' &&
    typeof value.type === 'string' &&
    value.type.trim()
  ) {
    return value.type.trim()
  }
  fail('installed package.json has no usable license declaration')
}

function repositoryUrl(value: PackageJson['repository']): string | undefined {
  if (typeof value === 'string') return value
  return value?.url
}

function resolveLicenseReferences(
  references: LicenseReference[],
  cargoPackages: Map<string, CargoPackage>,
  packageLock: PackageLock,
  currentNpmLockPath?: string
): LicenseEvidence[] {
  return uniqueByPath(
    references.map((reference) => {
      if (reference.repositoryPath) {
        return evidence(
          join(ROOT, reference.repositoryPath),
          reference.repositoryPath,
          reference.expectedSha256
        )
      }
      if (reference.cargoPackage && reference.path) {
        const pkg = cargoPackages.get(reference.cargoPackage)
        if (!pkg) {
          fail(
            `license template package ${reference.cargoPackage} is not in the Cargo release closure`
          )
        }
        const absolute = join(dirname(pkg.manifest_path), reference.path)
        return evidence(
          absolute,
          `cargo:${reference.cargoPackage}/${reference.path}`,
          reference.expectedSha256
        )
      }
      if (reference.npmLockPath && reference.path) {
        if (!packageLock.packages[reference.npmLockPath]) {
          fail(
            `license source ${reference.npmLockPath} is not in package-lock.json`
          )
        }
        const absolute = join(ROOT, reference.npmLockPath, reference.path)
        return evidence(
          absolute,
          `npm:${reference.npmLockPath}/${reference.path}`,
          reference.expectedSha256
        )
      }
      if (reference.packagePath && currentNpmLockPath) {
        const absolute = join(ROOT, currentNpmLockPath, reference.packagePath)
        return evidence(
          absolute,
          `npm:${currentNpmLockPath}/${reference.packagePath}`,
          reference.expectedSha256
        )
      }
      fail(`invalid license reference: ${JSON.stringify(reference)}`)
    })
  )
}

function buildCargoComponents(
  overrides: Overrides,
  packageLock: PackageLock
): { components: NoticeComponent[]; packages: Map<string, CargoPackage> } {
  const closure = cargoClosure(overrides.cargoTargets)
  const packages = cargoPackageIndex(closure)
  const checksums = cargoLockChecksums()
  const directOverrides = new Map(
    overrides.cargoOverrides.map((override) => [
      componentKey(override.name, override.version),
      override,
    ])
  )
  const fallbacks = new Map<
    string,
    { fallback: CargoFallback; component: ComponentSpec }
  >()
  for (const fallback of overrides.cargoFallbacks) {
    for (const component of fallback.components) {
      const key = componentKey(component.name, component.version)
      if (fallbacks.has(key)) fail(`duplicate Cargo fallback for ${key}`)
      fallbacks.set(key, { fallback, component })
    }
  }

  const usedDirect = new Set<string>()
  const usedFallbacks = new Set<string>()
  const components: NoticeComponent[] = []
  for (const { pkg, targets } of closure.values()) {
    const key = componentKey(pkg.name, pkg.version)
    const declared = pkg.license?.trim()
    if (!declared) fail(`${key} has no Cargo license declaration`)
    const discovered = topLevelLicenseFiles(
      dirname(pkg.manifest_path),
      pkg.license_file
    ).map((path) => cargoFileEvidence(pkg, path))
    const direct = directOverrides.get(key)
    const fallbackEntry = fallbacks.get(key)
    let files: LicenseEvidence[]
    let selectedLicenseExpression: string | undefined
    let source = pkg.source?.startsWith('registry+')
      ? `https://crates.io/api/v1/crates/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}/download`
      : (pkg.source ?? `path:${displayPath(dirname(pkg.manifest_path))}`)
    let checksum: string | undefined
    let overrideInfo: NoticeComponent['override']

    if (pkg.source?.startsWith('registry+')) {
      checksum = checksums.get(`${key}|${pkg.source}`)
      if (!checksum) fail(`${key} has no checksum in Cargo.lock`)
    }

    if (direct) {
      if (declared !== direct.declaredLicense) {
        fail(
          `${key} declares '${declared}', override expects '${direct.declaredLicense}'`
        )
      }
      files = resolveLicenseReferences(
        direct.licenseFiles,
        packages,
        packageLock
      )
      selectedLicenseExpression = direct.selectedLicense
      source = direct.source
      overrideInfo = { reason: direct.reason }
      usedDirect.add(key)
    } else if (fallbackEntry) {
      const { fallback, component } = fallbackEntry
      if (declared !== component.declaredLicense) {
        fail(
          `${key} declares '${declared}', fallback expects '${component.declaredLicense}'`
        )
      }
      if (discovered.length > 0) {
        fail(
          `${key} now ships license files; remove and review its explicit fallback`
        )
      }
      files = resolveLicenseReferences(
        fallback.licenseFiles,
        packages,
        packageLock
      )
      selectedLicenseExpression = fallback.selectedLicense
      overrideInfo = { reason: fallback.reason }
      usedFallbacks.add(key)
    } else {
      files = discovered
    }

    if (files.length === 0) {
      fail(`${key} has no license text and no explicit fallback`)
    }
    components.push({
      id: `cargo:${key}`,
      ecosystem: 'cargo',
      name: pkg.name,
      version: pkg.version,
      licenseExpression: declared,
      selectedLicenseExpression,
      source,
      checksum,
      repository: pkg.repository ?? undefined,
      targets: overrides.cargoTargets.filter((target) => targets.has(target)),
      override: overrideInfo,
      licenseFiles: files,
    })
  }

  for (const key of directOverrides.keys()) {
    if (!usedDirect.has(key)) fail(`unused Cargo override: ${key}`)
  }
  for (const key of fallbacks.keys()) {
    if (!usedFallbacks.has(key)) fail(`unused Cargo fallback: ${key}`)
  }
  return { components, packages }
}

function buildNpmComponents(
  overrides: Overrides,
  packageLock: PackageLock,
  cargoPackages: Map<string, CargoPackage>
): NoticeComponent[] {
  if (packageLock.lockfileVersion !== 3) {
    fail(
      `package-lock.json version ${packageLock.lockfileVersion} is unsupported; expected 3`
    )
  }
  const overrideMap = new Map(
    overrides.npmOverrides.map((override) => [override.lockPath, override])
  )
  const usedOverrides = new Set<string>()
  const components: NoticeComponent[] = []

  for (const [lockPath, lockEntry] of Object.entries(packageLock.packages).sort(
    ([a], [b]) => a.localeCompare(b)
  )) {
    // lockfile v3 marks packages used only by devDependencies with dev=true.
    // Everything else beneath node_modules is part of npm's production tree.
    if (!lockPath.includes('node_modules/') || lockEntry.dev === true) continue
    const installed = npmPackageJson(lockPath)
    if (!installed.name || !installed.version || !lockEntry.version) {
      fail(`${lockPath} has incomplete installed/locked package metadata`)
    }
    if (installed.version !== lockEntry.version) {
      fail(
        `${lockPath} installed version ${installed.version} does not match lockfile ${lockEntry.version}`
      )
    }
    const declared = licenseExpression(installed.license)
    if (lockEntry.license && lockEntry.license !== declared) {
      fail(
        `${lockPath} license differs between package-lock.json and package.json`
      )
    }
    const directory = join(ROOT, lockPath)
    const discovered = topLevelLicenseFiles(directory).map((path) => {
      const rel = relative(directory, path).split(sep).join('/')
      return evidence(path, `npm:${lockPath}/${rel}`)
    })
    const override = overrideMap.get(lockPath)
    let files = discovered
    let overrideInfo: NoticeComponent['override']
    if (override) {
      if (
        installed.name !== override.name ||
        installed.version !== override.version ||
        declared !== override.declaredLicense
      ) {
        fail(`${lockPath} no longer matches its version-bound npm override`)
      }
      if (discovered.length > 0) {
        fail(
          `${lockPath} now ships top-level license files; review and remove its override`
        )
      }
      files = resolveLicenseReferences(
        override.licenseFiles,
        cargoPackages,
        packageLock,
        lockPath
      )
      overrideInfo = {
        reason: override.reason,
        sourceRevision: override.sourceRevision,
      }
      usedOverrides.add(lockPath)
    }
    if (files.length === 0) {
      fail(`${lockPath} has no license text and no explicit override`)
    }
    components.push({
      id: `npm:${lockPath}@${installed.version}`,
      ecosystem: 'npm',
      name: installed.name,
      version: installed.version,
      licenseExpression: declared,
      source: lockEntry.resolved ?? `npm-lock:${lockPath}`,
      repository: repositoryUrl(installed.repository),
      integrity: lockEntry.integrity,
      lockPath,
      targets: ['frontend'],
      override: overrideInfo,
      licenseFiles: files,
    })
  }

  for (const lockPath of overrideMap.keys()) {
    if (!usedOverrides.has(lockPath)) fail(`unused npm override: ${lockPath}`)
  }

  for (const required of overrides.requiredNpmComponents) {
    const matches = components.filter(
      (component) =>
        component.name === required.name &&
        component.version === required.version
    )
    if (matches.length !== 1) {
      fail(
        `required npm component ${componentKey(required.name, required.version)} occurs ${matches.length} times`
      )
    }
    const [component] = matches
    if (component.licenseExpression !== required.declaredLicense) {
      fail(
        `${component.id} declares '${component.licenseExpression}', expected '${required.declaredLicense}'`
      )
    }
    const suffix = `/${required.licenseFile}`
    const file = component.licenseFiles.find((entry) =>
      entry.path.endsWith(suffix)
    )
    if (!file || file.sha256 !== required.expectedSha256) {
      fail(
        `${component.id} does not carry the pinned ${required.licenseFile} text`
      )
    }
  }
  return components
}

function buildExternalComponents(
  overrides: Overrides,
  packageLock: PackageLock,
  cargoPackages: Map<string, CargoPackage>
): NoticeComponent[] {
  const fetchScript = readFileSync(
    join(ROOT, 'scripts', 'fetch-llama-server.sh'),
    'utf8'
  )
  return overrides.externalComponents.map((component) => {
    if (component.name === 'llama.cpp') {
      if (!fetchScript.includes(`LLAMA_RELEASE_TAG="${component.version}"`)) {
        fail(
          `fetch-llama-server.sh is not pinned to llama.cpp ${component.version}`
        )
      }
      if (!fetchScript.includes(component.commit)) {
        fail(
          `fetch-llama-server.sh does not name llama.cpp commit ${component.commit}`
        )
      }
    }
    return {
      id: `external:${componentKey(component.name, component.version)}`,
      ecosystem: 'external',
      name: component.name,
      version: component.version,
      licenseExpression: component.declaredLicense,
      source: component.source,
      targets: overrides.cargoTargets,
      override: {
        reason: `Pinned non-registry runtime at commit ${component.commit}.`,
        sourceRevision: component.source,
      },
      licenseFiles: resolveLicenseReferences(
        component.licenseFiles,
        cargoPackages,
        packageLock
      ),
    }
  })
}

function sortComponents(components: NoticeComponent[]): NoticeComponent[] {
  const rank = { cargo: 0, npm: 1, external: 2 }
  return components.sort(
    (a, b) =>
      rank[a.ecosystem] - rank[b.ecosystem] ||
      a.name.localeCompare(b.name) ||
      a.version.localeCompare(b.version) ||
      a.id.localeCompare(b.id)
  )
}

function renderNotice(
  components: NoticeComponent[],
  targets: string[]
): string {
  const counts = {
    cargo: components.filter((item) => item.ecosystem === 'cargo').length,
    npm: components.filter((item) => item.ecosystem === 'npm').length,
    external: components.filter((item) => item.ecosystem === 'external').length,
  }
  const lines = [
    'STUDYVIS THIRD-PARTY NOTICES',
    '============================',
    '',
    'Generated deterministically by scripts/generate-third-party-notices.ts.',
    'Do not edit this file directly; update a lockfile or the explicit override',
    'manifest, review the resulting license delta, and regenerate it.',
    '',
    'Scope: npm production packages from package-lock.json; normal Rust dependencies',
    `reachable for ${targets.join(', ')} from Cargo.lock; and the pinned llama.cpp`,
    'runtime. Build/test-only dependency trees and Linux host-derived system libraries',
    'are outside this cross-platform file and have separate packaging gates.',
    '',
    'This generated inventory is a release gate and an aid to human review. It is not',
    'legal advice, a legal opinion, or a record of legal sign-off. License expressions',
    'below are upstream declarations; consult the complete texts that follow.',
    '',
    'For each Cargo registry component, `source` is the direct exact-version crates.io',
    'source-archive URL and `source checksum` is its Cargo.lock SHA-256. These fields',
    'tell recipients how to obtain and verify the Covered Source named in the index.',
    '',
    `Components: ${components.length} total (${counts.cargo} Cargo, ${counts.npm} npm, ${counts.external} external runtime).`,
    '',
    'COMPONENT INDEX',
    '===============',
    '',
  ]

  let previousEcosystem = ''
  for (const component of components) {
    if (component.ecosystem !== previousEcosystem) {
      lines.push(
        component.ecosystem.toUpperCase(),
        '-'.repeat(component.ecosystem.length),
        ''
      )
      previousEcosystem = component.ecosystem
    }
    const selected = component.selectedLicenseExpression
      ? `; selected alternative: ${component.selectedLicenseExpression}`
      : ''
    lines.push(
      `- ${component.name} ${component.version} — ${component.licenseExpression}${selected}`,
      `  id: ${component.id}`,
      `  targets: ${component.targets.join(', ')}`,
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

  type TextGroup = { text: string; references: Set<string> }
  const groups = new Map<string, TextGroup>()
  for (const component of components) {
    for (const file of component.licenseFiles) {
      const current = groups.get(file.sha256)
      if (current && current.text !== file.text) {
        fail(`SHA-256 collision while grouping ${file.path}`)
      }
      const group = current ?? {
        text: file.text,
        references: new Set<string>(),
      }
      group.references.add(`${component.id} — ${file.path}`)
      groups.set(file.sha256, group)
    }
  }

  lines.push('LICENSE TEXTS AND NOTICES', '=========================', '')
  for (const [hash, group] of [...groups.entries()].sort(([a], [b]) =>
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

function inputHashes(
  overrides: Overrides
): Array<{ path: string; sha256: string }> {
  const paths = new Set([
    'package.json',
    'package-lock.json',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
    'scripts/fetch-llama-server.sh',
    'scripts/generate-third-party-notices.ts',
    'scripts/third-party-notices-overrides.json',
  ])
  const collect = (reference: LicenseReference) => {
    if (reference.repositoryPath) paths.add(reference.repositoryPath)
  }
  overrides.cargoOverrides.flatMap((item) => item.licenseFiles).forEach(collect)
  overrides.cargoFallbacks.flatMap((item) => item.licenseFiles).forEach(collect)
  overrides.npmOverrides.flatMap((item) => item.licenseFiles).forEach(collect)
  overrides.externalComponents
    .flatMap((item) => item.licenseFiles)
    .forEach(collect)
  return [...paths]
    .sort()
    .map((path) => ({ path, sha256: sha256(readUtf8(join(ROOT, path))) }))
}

function renderManifest(
  components: NoticeComponent[],
  overrides: Overrides,
  notice: string
): string {
  const manifestComponents: ManifestComponent[] = components.map(
    (component) => ({
      ...component,
      licenseFiles: component.licenseFiles.map(({ path, sha256: hash }) => ({
        path,
        sha256: hash,
      })),
    })
  )
  const manifest = {
    schemaVersion: 1,
    generatedBy: 'scripts/generate-third-party-notices.ts',
    noticePath: 'THIRD-PARTY-NOTICES.txt',
    noticeSha256: sha256(notice),
    scope: {
      npm: 'package-lock.json v3 entries beneath node_modules whose dev flag is not true',
      cargo:
        'normal dependency edges reachable from the StudyVis root under each release target; build/dev edges excluded',
      external: 'explicit version-and-commit-bound runtime components',
    },
    cargoTargets: overrides.cargoTargets,
    inputs: inputHashes(overrides),
    counts: {
      components: components.length,
      cargo: components.filter((item) => item.ecosystem === 'cargo').length,
      npm: components.filter((item) => item.ecosystem === 'npm').length,
      external: components.filter((item) => item.ecosystem === 'external')
        .length,
      distinctLicenseTexts: new Set(
        components.flatMap((item) =>
          item.licenseFiles.map((file) => file.sha256)
        )
      ).size,
    },
    components: manifestComponents,
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

function exactCheck(path: string, expected: string): string | null {
  if (!existsSync(path)) return `${displayPath(path)} is missing`
  const actual = readFileSync(path, 'utf8')
  if (actual !== expected) return `${displayPath(path)} is stale`
  return null
}

async function main() {
  const mode = process.argv[2]
  if (mode !== '--write' && mode !== '--check') {
    fail('usage: generate-third-party-notices.ts --write|--check')
  }
  const overrides = readJson<Overrides>(OVERRIDES_PATH)
  if (overrides.schemaVersion !== 1) fail('unsupported override schema version')
  if (new Set(overrides.cargoTargets).size !== overrides.cargoTargets.length) {
    fail('duplicate Cargo target in override manifest')
  }
  const packageLock = readJson<PackageLock>(join(ROOT, 'package-lock.json'))
  const cargo = buildCargoComponents(overrides, packageLock)
  const components = sortComponents([
    ...cargo.components,
    ...buildNpmComponents(overrides, packageLock, cargo.packages),
    ...buildExternalComponents(overrides, packageLock, cargo.packages),
  ])
  const ids = new Set<string>()
  for (const component of components) {
    if (ids.has(component.id)) fail(`duplicate component id: ${component.id}`)
    ids.add(component.id)
  }
  const notice = renderNotice(components, overrides.cargoTargets)
  const manifest = renderManifest(components, overrides, notice)

  if (mode === '--write') {
    await mkdir(dirname(BUNDLE_NOTICE_PATH), { recursive: true })
    writeFileSync(NOTICE_PATH, notice, 'utf8')
    writeFileSync(MANIFEST_PATH, manifest, 'utf8')
    writeFileSync(BUNDLE_NOTICE_PATH, notice, 'utf8')
    writeFileSync(BUNDLE_MANIFEST_PATH, manifest, 'utf8')
    process.stdout.write(
      `third-party notices: wrote ${components.length} components to committed and bundle resources\n`
    )
    return
  }

  const failures = [
    exactCheck(NOTICE_PATH, notice),
    exactCheck(MANIFEST_PATH, manifest),
    exactCheck(BUNDLE_NOTICE_PATH, notice),
    exactCheck(BUNDLE_MANIFEST_PATH, manifest),
  ].filter((failure): failure is string => Boolean(failure))
  if (failures.length > 0) {
    fail(
      `${failures.join('; ')}. Run npm run generate-notices and review the diff.`
    )
  }
  process.stdout.write(
    `third-party notices: OK (${components.length} locked components; committed and bundle copies match)\n`
  )
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exit(1)
})
