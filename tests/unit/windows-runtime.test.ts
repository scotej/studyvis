import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readPeImports,
  sha256,
  validateWindowsRuntime,
  WINDOWS_ENGINE_DLLS,
  WINDOWS_RUNTIME_DIRECTORY,
  WINDOWS_VC_DLLS,
} from '../../scripts/check-windows-runtime'

function peImage(
  imports: string[] = [],
  delayed: string[] = [],
  machine = 0x8664
): Buffer {
  const bytes = Buffer.alloc(2048)
  bytes.writeUInt16LE(0x5a4d, 0)
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.writeUInt32LE(0x4550, 0x80)
  bytes.writeUInt16LE(machine, 0x84)
  bytes.writeUInt16LE(1, 0x86)
  bytes.writeUInt16LE(240, 0x94)
  const optional = 0x98
  bytes.writeUInt16LE(0x20b, optional)
  bytes.writeBigUInt64LE(0x140000000n, optional + 24)
  bytes.writeUInt32LE(0x200, optional + 60)
  bytes.writeUInt32LE(16, optional + 108)
  const section = optional + 240
  bytes.write('.rdata', section)
  bytes.writeUInt32LE(0x1000, section + 12)
  bytes.writeUInt32LE(0x600, section + 16)
  bytes.writeUInt32LE(0x200, section + 20)
  let nameOffset = 0x600
  for (const [
    names,
    directory,
    descriptorOffset,
    descriptorSize,
    nameField,
  ] of [
    [imports, 1, 0x200, 20, 12],
    [delayed, 13, 0x400, 32, 4],
  ] as const) {
    if (!names.length) continue
    const dataDirectory = optional + 112 + directory * 8
    bytes.writeUInt32LE(descriptorOffset + 0xe00, dataDirectory)
    bytes.writeUInt32LE((names.length + 1) * descriptorSize, dataDirectory + 4)
    for (const [index, name] of names.entries()) {
      const descriptor = descriptorOffset + index * descriptorSize
      if (directory === 13) bytes.writeUInt32LE(1, descriptor)
      bytes.writeUInt32LE(nameOffset + 0xe00, descriptor + nameField)
      nameOffset += bytes.write(`${name}\0`, nameOffset, 'ascii')
    }
  }
  return bytes
}

describe('Windows PE import inspection', () => {
  it('maps section RVAs and combines regular and delayed DLL imports', () => {
    const image = readPeImports(
      peImage(['KERNEL32.dll', 'MSVCP140.dll'], ['VCRUNTIME140_1.dll'])
    )
    expect(image).toEqual({
      machine: 0x8664,
      imports: ['kernel32.dll', 'msvcp140.dll', 'vcruntime140_1.dll'],
    })
  })

  it('rejects a truncated executable rather than silently accepting no imports', () => {
    expect(() => readPeImports(peImage().subarray(0, 100))).toThrow('truncated')
  })

  it('rejects an import table pointing outside the file', () => {
    const bytes = peImage(['msvcp140.dll'])
    bytes.writeUInt32LE(0xffffff00, 0x98 + 112 + 8)
    expect(() => readPeImports(bytes)).toThrow('unmapped PE RVA')
  })

  it('rejects unterminated import descriptors', () => {
    const bytes = peImage(['msvcp140.dll'])
    bytes.writeUInt32LE(20, 0x98 + 112 + 8 + 4)
    expect(() => readPeImports(bytes)).toThrow('unterminated import directory')
  })
})

describe('Windows bundle configuration', () => {
  const config = JSON.parse(
    readFileSync(resolve('src-tauri/tauri.windows.conf.json'), 'utf8')
  ) as {
    bundle: { resources: Record<string, string> }
  }

  it.each(WINDOWS_VC_DLLS)(
    'keeps %s beside the installed executable',
    (name) => {
      expect(
        config.bundle.resources[`${WINDOWS_RUNTIME_DIRECTORY}/${name}`]
      ).toBe(name)
    }
  )

  it('retains the complete engine runtime resource directory', () => {
    expect(config.bundle.resources[WINDOWS_RUNTIME_DIRECTORY]).toBe(
      WINDOWS_RUNTIME_DIRECTORY
    )
  })
})

describe('packaged Windows runtime', () => {
  let root: string
  let runtime: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'studyvis-windows-runtime-'))
    runtime = join(root, WINDOWS_RUNTIME_DIRECTORY)
    mkdirSync(runtime, { recursive: true })
    writeFileSync(join(root, 'studyvis.exe'), peImage(['kernel32.dll']))
    writeFileSync(
      join(root, 'llama-server.exe'),
      peImage([
        'llama-common.dll',
        'llama.dll',
        'ggml-base.dll',
        ...WINDOWS_VC_DLLS,
      ])
    )
    for (const name of WINDOWS_ENGINE_DLLS) {
      writeFileSync(
        join(runtime, name),
        peImage([
          'kernel32.dll',
          ...WINDOWS_VC_DLLS,
          ...(name === 'ggml-vulkan.dll' ? ['vulkan-1.dll'] : []),
        ])
      )
    }
    const files = WINDOWS_VC_DLLS.map((name) => {
      const bytes = peImage([
        'kernel32.dll',
        'api-ms-win-crt-runtime-l1-1-0.dll',
      ])
      writeFileSync(join(runtime, name), bytes)
      writeFileSync(join(root, name), bytes)
      return {
        name,
        sha256: sha256(bytes),
        size: bytes.length,
        machine: 'AMD64',
        version: '14.44.35211.0',
        signerSubject: 'CN=Microsoft Corporation, O=Microsoft Corporation',
        signerThumbprint: '1234567890abcdef1234567890abcdef12345678',
      }
    })
    const license = resolve(
      'scripts/licenses/MICROSOFT-VISUAL-STUDIO-2022-LICENSE.docx'
    )
    copyFileSync(license, join(runtime, 'VC-RUNTIME-LICENSE.docx'))
    writeFileSync(
      join(runtime, 'VC-RUNTIME-NOTICE.txt'),
      'Copyright Microsoft Corporation.'
    )
    writeFileSync(
      join(runtime, 'VC-RUNTIME-MANIFEST.json'),
      JSON.stringify({
        schemaVersion: 1,
        component: 'Microsoft Visual C++ Runtime',
        architecture: 'x64',
        source: {
          kind: 'visual-studio-redist',
          productId: 'Microsoft.VisualStudio.Product.Enterprise',
          redistVersion: '14.44.35207',
        },
        license: {
          name: 'VC-RUNTIME-LICENSE.docx',
          sha256: sha256(readFileSync(license)),
        },
        files,
      })
    )
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('accepts a complete packaged closure without resolving any host DLLs', () => {
    const report = validateWindowsRuntime(root)
    expect(report.engine).toBe(join(root, 'llama-server.exe'))
    expect(report.runtime).toBe(runtime)
    expect(Object.keys(report.images)).toHaveLength(
      2 + 6 + WINDOWS_ENGINE_DLLS.length
    )
  })

  it('requires the actual app executable unless prebuild validation is explicit', () => {
    rmSync(join(root, 'studyvis.exe'))
    expect(() => validateWindowsRuntime(root)).toThrow('studyvis.exe')
    expect(() =>
      validateWindowsRuntime(root, { engineOnly: true })
    ).not.toThrow()
  })

  it.each(WINDOWS_VC_DLLS)(
    'rejects missing app-local %s even with a nested copy',
    (name) => {
      rmSync(join(root, name))
      expect(() => validateWindowsRuntime(root)).toThrow(
        `missing packaged runtime ${name}`
      )
    }
  )

  it.each(WINDOWS_VC_DLLS)(
    'rejects missing runtime-resource %s even with a root copy',
    (name) => {
      rmSync(join(runtime, name))
      expect(() => validateWindowsRuntime(root)).toThrow(
        `missing packaged runtime ${name}`
      )
    }
  )

  it('catches missing dynamically discovered CPU variants', () => {
    rmSync(join(runtime, 'ggml-cpu-haswell.dll'))
    expect(() => validateWindowsRuntime(root)).toThrow(
      'missing packaged runtime ggml-cpu-haswell.dll'
    )
  })

  it('catches a newly added transitive dependency instead of trusting System32', () => {
    writeFileSync(join(runtime, 'ggml.dll'), peImage(['vcruntime150.dll']))
    expect(() => validateWindowsRuntime(root)).toThrow(
      'missing packaged dependency vcruntime150.dll'
    )
  })

  it('checks dependencies reached only through delay imports', () => {
    writeFileSync(join(runtime, 'ggml.dll'), peImage([], ['missing-delay.dll']))
    expect(() => validateWindowsRuntime(root)).toThrow(
      'missing packaged dependency missing-delay.dll'
    )
  })

  it('allows the host Vulkan loader only for the optional Vulkan backend', () => {
    writeFileSync(join(root, 'llama-server.exe'), peImage(['vulkan-1.dll']))
    expect(() => validateWindowsRuntime(root)).toThrow(
      'missing packaged dependency vulkan-1.dll'
    )
  })

  it('rejects a mismatched architecture in a dynamically loaded backend', () => {
    writeFileSync(join(runtime, 'ggml-cpu-x64.dll'), peImage([], [], 0xaa64))
    expect(() => validateWindowsRuntime(root)).toThrow('expected AMD64')
  })

  it('rejects runtime bytes that disagree with their provenance manifest', () => {
    writeFileSync(join(runtime, 'vcruntime140_1.dll'), peImage(['user32.dll']))
    expect(() => validateWindowsRuntime(root)).toThrow(
      'metadata or root copy mismatch for vcruntime140_1.dll'
    )
  })

  it('rejects a root DLL that differs from the manifest-bound nested copy', () => {
    writeFileSync(join(root, 'msvcp140.dll'), peImage(['user32.dll']))
    expect(() => validateWindowsRuntime(root)).toThrow(
      'metadata or root copy mismatch for msvcp140.dll'
    )
  })

  it('rejects a missing or replaced Microsoft license', () => {
    writeFileSync(join(runtime, 'VC-RUNTIME-LICENSE.docx'), 'wrong document')
    expect(() => validateWindowsRuntime(root)).toThrow('license does not match')
  })

  it('rejects bundled application dependencies that are reachable only from the sidecar cwd', () => {
    writeFileSync(join(root, 'studyvis.exe'), peImage(['llama.dll']))
    expect(() => validateWindowsRuntime(root)).toThrow(
      'missing packaged dependency llama.dll'
    )
  })
})
