#!/usr/bin/env tsx

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const WINDOWS_RUNTIME_DIRECTORY =
  'binaries/llama-runtime-x86_64-pc-windows-msvc'
export const WINDOWS_VC_DLLS = [
  'msvcp140.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
] as const

// b9095 discovers these backends dynamically, outside the PE import tables.
export const WINDOWS_ENGINE_DLLS = [
  'ggml-base.dll',
  'ggml.dll',
  'ggml-rpc.dll',
  'ggml-vulkan.dll',
  'libomp140.x86_64.dll',
  'llama-common.dll',
  'llama.dll',
  'mtmd.dll',
  ...[
    'alderlake',
    'cannonlake',
    'cascadelake',
    'cooperlake',
    'haswell',
    'icelake',
    'ivybridge',
    'piledriver',
    'sandybridge',
    'sapphirerapids',
    'skylakex',
    'sse42',
    'x64',
    'zen4',
  ].map((variant) => `ggml-cpu-${variant}.dll`),
]

const OS_DLLS = new Set([
  'advapi32.dll',
  'bcrypt.dll',
  'bcryptprimitives.dll',
  'comctl32.dll',
  'crypt32.dll',
  'dwmapi.dll',
  'gdi32.dll',
  'kernel32.dll',
  'kernelbase.dll',
  'ntdll.dll',
  'ole32.dll',
  'oleaut32.dll',
  'psapi.dll',
  'rpcrt4.dll',
  'setupapi.dll',
  'shell32.dll',
  'shlwapi.dll',
  'ucrtbase.dll',
  'user32.dll',
  'version.dll',
  'ws2_32.dll',
])

export interface PeImports {
  machine: number
  imports: string[]
}

// https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
export function readPeImports(bytes: Buffer, label = 'PE image'): PeImports {
  function range(offset: number, size: number): number {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset + size > bytes.length
    ) {
      throw new Error(`${label}: truncated PE data at ${offset}`)
    }
    return offset
  }
  const u16 = (offset: number) => bytes.readUInt16LE(range(offset, 2))
  const u32 = (offset: number) => bytes.readUInt32LE(range(offset, 4))
  if (u16(0) !== 0x5a4d) throw new Error(`${label}: missing MZ signature`)
  const pe = u32(0x3c)
  if (u32(pe) !== 0x4550) throw new Error(`${label}: missing PE signature`)
  const machine = u16(pe + 4)
  const sectionCount = u16(pe + 6)
  const optionalSize = u16(pe + 20)
  const optional = pe + 24
  range(optional, optionalSize)
  if (u16(optional) !== 0x20b) {
    throw new Error(`${label}: expected a PE32+ image`)
  }
  if (optionalSize < 112) throw new Error(`${label}: short optional header`)
  const directoryCount = u32(optional + 108)
  if (directoryCount > (optionalSize - 112) / 8) {
    throw new Error(`${label}: truncated data directories`)
  }
  const headersSize = u32(optional + 60)
  const sections: { address: number; size: number; offset: number }[] = []
  for (let index = 0; index < sectionCount; index += 1) {
    const section = range(optional + optionalSize + index * 40, 40)
    sections.push({
      address: u32(section + 12),
      size: u32(section + 16),
      offset: u32(section + 20),
    })
  }
  function fromRva(address: number, size: number): number {
    if (address < headersSize && address + size <= headersSize) {
      return range(address, size)
    }
    for (const section of sections) {
      const delta = address - section.address
      if (delta >= 0 && delta + size <= section.size) {
        return range(section.offset + delta, size)
      }
    }
    throw new Error(`${label}: unmapped PE RVA ${address}`)
  }
  function dllName(address: number): string {
    const characters: number[] = []
    for (let index = 0; index < 260; index += 1) {
      const value = bytes[fromRva(address + index, 1)]
      if (value === 0) {
        const name = Buffer.from(characters).toString('ascii').toLowerCase()
        if (!/^[a-z0-9_.-]+\.dll$/.test(name)) {
          throw new Error(`${label}: invalid DLL import ${name}`)
        }
        return name
      }
      if (value > 0x7f) throw new Error(`${label}: non-ASCII DLL import`)
      characters.push(value)
    }
    throw new Error(`${label}: unterminated DLL import`)
  }
  const imports = new Set<string>()
  for (const [directory, descriptorSize, nameOffset] of [
    [1, 20, 12],
    [13, 32, 4],
  ]) {
    if (directory >= directoryCount) continue
    const entry = optional + 112 + directory * 8
    const address = u32(entry)
    const size = u32(entry + 4)
    if (address === 0 && size === 0) continue
    if (address === 0 || size < descriptorSize || size > bytes.length) {
      throw new Error(`${label}: invalid import directory`)
    }
    let terminated = false
    for (
      let index = 0;
      index + descriptorSize <= size;
      index += descriptorSize
    ) {
      const descriptor = fromRva(address + index, descriptorSize)
      const empty = bytes
        .subarray(descriptor, descriptor + descriptorSize)
        .every((value) => value === 0)
      if (empty) {
        terminated = true
        break
      }
      let nameAddress = u32(descriptor + nameOffset)
      if (directory === 13 && (u32(descriptor) & 1) === 0) {
        const imageBase = bytes.readBigUInt64LE(range(optional + 24, 8))
        nameAddress = Number(BigInt(nameAddress) - imageBase)
      }
      imports.add(dllName(nameAddress))
    }
    if (!terminated) throw new Error(`${label}: unterminated import directory`)
  }
  return { machine, imports: [...imports].sort() }
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return walk(path)
    return entry.isFile() ? [path] : []
  })
}

function dllFiles(directory: string): Map<string, string> {
  const files = new Map<string, string>()
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.dll')) continue
    const name = entry.name.toLowerCase()
    if (files.has(name))
      throw new Error(`duplicate DLL ${name} in ${directory}`)
    files.set(name, join(directory, entry.name))
  }
  return files
}

export interface WindowsRuntimeReport {
  engine: string
  runtime: string
  images: Record<string, string[]>
}

interface VcRuntimeManifest {
  schemaVersion: number
  component: string
  architecture: string
  source: {
    kind: string
    productId: string
    redistVersion: string
  }
  license: { name: string; sha256: string }
  files: {
    name: string
    sha256: string
    size: number
    machine: string
    version: string
    signerSubject: string
    signerThumbprint: string
  }[]
}

function validateVcRuntime(
  appRoot: string,
  runtime: string,
  runtimeDlls: Map<string, string>,
  appDlls: Map<string, string>
): void {
  const manifest = JSON.parse(
    readFileSync(join(runtime, 'VC-RUNTIME-MANIFEST.json'), 'utf8')
  ) as VcRuntimeManifest
  if (
    manifest.schemaVersion !== 1 ||
    manifest.component !== 'Microsoft Visual C++ Runtime' ||
    manifest.architecture !== 'x64' ||
    manifest.source.kind !== 'visual-studio-redist' ||
    !/^Microsoft\.VisualStudio\.Product\.(Enterprise|Professional)$/.test(
      manifest.source.productId
    ) ||
    !/^14\.\d+\.\d+(\.\d+)?$/.test(manifest.source.redistVersion) ||
    manifest.files.length !== WINDOWS_VC_DLLS.length
  ) {
    throw new Error('invalid Microsoft runtime provenance manifest')
  }
  for (const name of WINDOWS_VC_DLLS) {
    const entries = manifest.files.filter((file) => file.name === name)
    if (entries.length !== 1)
      throw new Error(`missing manifest entry for ${name}`)
    const entry = entries[0]
    const runtimeFile = runtimeDlls.get(name)
    const appFile = appDlls.get(name)
    if (!runtimeFile || !appFile) {
      throw new Error(
        `missing packaged runtime ${name} beside ${join(appRoot, 'llama-server.exe')}`
      )
    }
    const bytes = readFileSync(runtimeFile)
    if (
      entry.machine !== 'AMD64' ||
      !/^14\.\d+\.\d+\.\d+$/.test(entry.version) ||
      !entry.signerSubject.includes('Microsoft Corporation') ||
      !/^[a-f0-9]{40}$/i.test(entry.signerThumbprint) ||
      entry.size !== bytes.length ||
      entry.sha256 !== sha256(bytes) ||
      !readFileSync(appFile).equals(bytes)
    ) {
      throw new Error(
        `Microsoft runtime metadata or root copy mismatch for ${name}`
      )
    }
  }
  const expectedLicense = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      'licenses/MICROSOFT-VISUAL-STUDIO-2022-LICENSE.docx'
    )
  )
  if (
    manifest.license.name !== 'VC-RUNTIME-LICENSE.docx' ||
    manifest.license.sha256 !== sha256(expectedLicense) ||
    !readFileSync(join(runtime, manifest.license.name)).equals(expectedLicense)
  ) {
    throw new Error(
      'packaged Microsoft runtime license does not match the reviewed document'
    )
  }
  if (
    !readFileSync(join(runtime, 'VC-RUNTIME-NOTICE.txt'), 'utf8').includes(
      'Microsoft Corporation'
    )
  ) {
    throw new Error('missing Microsoft runtime attribution')
  }
}

export function validateWindowsRuntime(
  artifactRoot: string,
  options: { engineOnly?: boolean } = {}
): WindowsRuntimeReport {
  const root = resolve(artifactRoot)
  if (!statSync(root).isDirectory())
    throw new Error('expected an artifact directory')
  const engines = walk(root).filter(
    (path) => basename(path).toLowerCase() === 'llama-server.exe'
  )
  if (engines.length !== 1) {
    throw new Error(
      `expected exactly one llama-server.exe, found ${engines.length}`
    )
  }
  const engine = engines[0]
  const appRoot = dirname(engine)
  const app = join(appRoot, 'studyvis.exe')
  const runtime = join(appRoot, WINDOWS_RUNTIME_DIRECTORY)
  const runtimeDlls = dllFiles(runtime)
  const appDlls = dllFiles(appRoot)
  for (const name of [...WINDOWS_VC_DLLS, ...WINDOWS_ENGINE_DLLS]) {
    if (!runtimeDlls.has(name))
      throw new Error(`missing packaged runtime ${name}`)
  }
  validateVcRuntime(appRoot, runtime, runtimeDlls, appDlls)
  const report: WindowsRuntimeReport = { engine, runtime, images: {} }
  for (const path of [
    ...(options.engineOnly ? [] : [app]),
    engine,
    ...appDlls.values(),
    ...runtimeDlls.values(),
  ]) {
    const image = readPeImports(readFileSync(path), relative(root, path))
    if (image.machine !== 0x8664) {
      throw new Error(
        `${relative(root, path)}: expected AMD64, found ${image.machine}`
      )
    }
    report.images[relative(root, path)] = image.imports
    for (const name of image.imports) {
      if (appDlls.has(name) || (path !== app && runtimeDlls.has(name))) continue
      if (
        OS_DLLS.has(name) ||
        /^(api|ext)-ms-win-[a-z0-9-]+\.dll$/.test(name)
      ) {
        continue
      }
      if (
        name === 'vulkan-1.dll' &&
        basename(path).toLowerCase() === 'ggml-vulkan.dll'
      ) {
        continue
      }
      throw new Error(
        `${relative(root, path)}: missing packaged dependency ${name}`
      )
    }
  }
  return report
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const engineOnly = process.argv[3] === '--engine-only'
    if (process.argv.length !== (engineOnly ? 4 : 3)) {
      throw new Error(
        'usage: check-windows-runtime.ts <extracted-installer> [--engine-only]'
      )
    }
    const report = validateWindowsRuntime(process.argv[2], { engineOnly })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } catch (error: unknown) {
    process.stderr.write(
      `Windows runtime: ${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exit(1)
  }
}
