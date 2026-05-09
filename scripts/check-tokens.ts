#!/usr/bin/env tsx
import { readFile, readdir } from 'node:fs/promises'
import { resolve, relative, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const SRC = join(ROOT, 'src')

const ALLOWLIST_FILES = new Set<string>([
  join('src', 'design', 'tokens.ts'),
])

type Violation = {
  file: string
  line: number
  column: number
  rule: string
  match: string
}

type Rule = {
  name: string
  regex: RegExp
  shouldFlag: (match: RegExpExecArray, lineText: string) => boolean
}

const RULES: Rule[] = [
  {
    name: 'raw-hex',
    regex: /#[0-9a-fA-F]{3,8}\b/g,
    shouldFlag: (m, line) => {
      const idx = m.index
      const before = line.slice(Math.max(0, idx - 32), idx)
      if (/var\(\s*--[\w-]*\s*$/.test(before)) return false
      if (/url\(\s*['"]?[^'")\s]*$/.test(before)) return false
      if (/\/\/.*$/.test(line.slice(0, idx))) return false
      return true
    },
  },
  {
    name: 'raw-cubic-bezier',
    regex: /cubic-bezier\s*\(/g,
    shouldFlag: () => true,
  },
  {
    name: 'raw-px-in-style-prop',
    regex: /style\s*=\s*\{\{[^}]*?\b\d+(?:\.\d+)?px\b[^}]*?\}\}/g,
    shouldFlag: () => true,
  },
]

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue
      await walk(p, out)
    } else if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

function toRel(abs: string) {
  return relative(ROOT, abs).split(sep).join('/')
}

async function main() {
  const files = await walk(SRC)
  const violations: Violation[] = []

  for (const abs of files) {
    const rel = relative(ROOT, abs)
    if (ALLOWLIST_FILES.has(rel)) continue
    const text = await readFile(abs, 'utf8')
    const lines = text.split('\n')
    for (const rule of RULES) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const re = new RegExp(rule.regex.source, rule.regex.flags)
        let m: RegExpExecArray | null
        while ((m = re.exec(line))) {
          if (!rule.shouldFlag(m, line)) continue
          violations.push({
            file: toRel(abs),
            line: i + 1,
            column: m.index + 1,
            rule: rule.name,
            match: m[0],
          })
        }
      }
    }
  }

  if (violations.length === 0) {
    process.stdout.write(`check-tokens: OK (${files.length} files scanned)\n`)
    process.exit(0)
  }

  process.stderr.write(`check-tokens: ${violations.length} violation(s)\n`)
  for (const v of violations) {
    process.stderr.write(
      `  ${v.file}:${v.line}:${v.column}  [${v.rule}]  ${v.match}\n`
    )
  }
  process.stderr.write(
    '\nTokens must come from src/design/tokens.ts or its CSS variables.\n'
  )
  process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
