#!/usr/bin/env tsx
import { readFile, readdir } from 'node:fs/promises'
import { resolve, relative, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const SRC = join(ROOT, 'src')

const ALLOWLIST_FILES = new Set<string>([join('src', 'design', 'tokens.ts')])

// Vendored shadcn primitives we cannot rewrite inside this pass: they live
// under Group D ownership in BUILD-PROMPTS, and their bracket-arbitraries are
// load-bearing visuals that need a coordinated visual-design pass to replace.
// Each entry is exempted ONLY for the named rule(s); other rules still apply.
// TODO(V3 polish): drop this allowlist after replacing the bracketed values
// with token-derived utilities.
const PER_FILE_RULE_EXEMPTIONS: Record<string, ReadonlySet<string>> = {
  // shadcn tabs internals: p-[3px], h-[calc(100%-1px)], after:bottom-[-5px],
  // ring-[3px]. Visually load-bearing; kept until V3 polish.
  'src/components/ui/tabs.tsx': new Set([
    'arbitrary-bracket-px',
    'arbitrary-bracket-ring',
  ]),
  // shadcn tooltip arrow: translate-y-[calc(-50%_-_2px)] rounded-[2px].
  'src/components/ui/tooltip.tsx': new Set(['arbitrary-bracket-px']),
  // shadcn switch thumb: translate-x-[calc(100%-2px)] is a load-bearing
  // micro-offset for the thumb's checked-state position. Replacing it with
  // a token requires a visual-design pass.
  'src/components/ui/switch.tsx': new Set(['arbitrary-bracket-px']),
  // shadcn dialog content: top-[50%], left-[50%], translate-x-[-50%],
  // translate-y-[-50%], max-w-[calc(100%-2rem)] — all percentage / rem /
  // calc-without-px and pass the new rules naturally. No exemption needed.
  // shadcn dropdown-menu: min-w-[8rem] uses rem; passes naturally.
  // Sonner mounts CSS variables via inline style; the values reference our
  // own tokens via var(--*). Allowed as a single carve-out because Sonner's
  // theming hook is its public API.
  'src/components/ui/sonner.tsx': new Set(['inline-style-string-literal']),
}

type Violation = {
  file: string
  line: number
  column: number
  rule: string
  match: string
}

type WholeFileRule = {
  name: string
  scan: (text: string) => Array<{ index: number; match: string }>
}

const HEX_PATTERN = /#[0-9a-fA-F]{3,8}\b/
const PX_PATTERN = /-?\d+(?:\.\d+)?px\b/
const ARBITRARY_BRACKET = /\[([^\s\]][^\]]*?)\]/g

function isAllowedTailwindArbitrary(content: string): boolean {
  const trimmed = content.trim()
  // Static keywords.
  if (trimmed === 'inherit' || trimmed === 'unset' || trimmed === 'initial') {
    return true
  }
  // CSS variable reference or declaration: [--my-var] or [--my-var:value].
  if (/^--[\w-]+(?:[:=].*)?$/.test(trimmed)) return true
  // Tailwind data/aria selectors: [orientation=horizontal], [size=default].
  if (trimmed.includes('=')) return true
  // Tailwind nested selectors: [&_svg]:..., [&>svg]:..., [*:not(...)].
  if (/^[&>*]/.test(trimmed)) return true
  // Element-anchored compound selectors like [a&]:hover.
  if (/^[a-z]&/.test(trimmed)) return true
  return false
}

function lineColFromIndex(text: string, index: number) {
  let line = 1
  let lastNewline = -1
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      line++
      lastNewline = i
    }
  }
  return { line, column: index - lastNewline }
}

function findHexInText(text: string): Array<{ index: number; match: string }> {
  const out: Array<{ index: number; match: string }> = []
  const re = /#[0-9a-fA-F]{3,8}\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const idx = m.index
    const before = text.slice(Math.max(0, idx - 32), idx)
    if (/var\(\s*--[\w-]*\s*$/.test(before)) continue
    if (/url\(\s*['"]?[^'")\s]*$/.test(before)) continue
    const lineStart = text.lastIndexOf('\n', idx - 1) + 1
    const linePrefix = text.slice(lineStart, idx)
    if (/(^|[^:])\/\//.test(linePrefix)) continue
    out.push({ index: idx, match: m[0] })
  }
  return out
}

const RULES: WholeFileRule[] = [
  {
    name: 'raw-hex',
    scan: (text) => findHexInText(text),
  },
  {
    name: 'raw-cubic-bezier',
    scan: (text) => {
      const out: Array<{ index: number; match: string }> = []
      const re = /cubic-bezier\s*\(/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        out.push({ index: m.index, match: 'cubic-bezier(' })
      }
      return out
    },
  },
  {
    name: 'raw-px-in-style-prop',
    scan: (text) => {
      const out: Array<{ index: number; match: string }> = []
      const blockRe = /style\s*=\s*\{\{[\s\S]*?\}\}/g
      let m: RegExpExecArray | null
      while ((m = blockRe.exec(text))) {
        const block = m[0]
        const pxRe = /-?\d+(?:\.\d+)?px\b/g
        let pxMatch: RegExpExecArray | null
        while ((pxMatch = pxRe.exec(block))) {
          out.push({
            index: m.index + pxMatch.index,
            match: pxMatch[0],
          })
        }
      }
      return out
    },
  },
  {
    name: 'inline-style-hex',
    scan: (text) => {
      const out: Array<{ index: number; match: string }> = []
      const blockRe = /style\s*=\s*\{\{[\s\S]*?\}\}/g
      let m: RegExpExecArray | null
      while ((m = blockRe.exec(text))) {
        const block = m[0]
        for (const hit of findHexInText(block)) {
          out.push({
            index: m.index + hit.index,
            match: hit.match,
          })
        }
      }
      return out
    },
  },
  {
    // Catches string literals inside style={{ ... }} that contain a CSS
    // function (e.g. filter: 'invert(1)', transform: 'translate(...)') which
    // would bypass utility-class enforcement. var(--*) and calc(...) without
    // px are allowed because they reference tokens.
    name: 'inline-style-string-literal',
    scan: (text) => {
      const out: Array<{ index: number; match: string }> = []
      const blockRe = /style\s*=\s*\{\{[\s\S]*?\}\}/g
      let m: RegExpExecArray | null
      while ((m = blockRe.exec(text))) {
        const block = m[0]
        const stringRe = /(['"])([^'"]*[a-zA-Z][^'"]*\([^'"]*)\1/g
        let s: RegExpExecArray | null
        while ((s = stringRe.exec(block))) {
          const value = s[2]
          if (/^var\(\s*--[\w-]+\s*(?:,[^)]*)?\)\s*$/.test(value.trim())) {
            continue
          }
          if (
            /^calc\([^)]*\)$/.test(value.trim()) &&
            !/\d+(?:\.\d+)?px/.test(value)
          ) {
            continue
          }
          out.push({
            index: m.index + s.index,
            match: s[0],
          })
        }
      }
      return out
    },
  },
  {
    // Tailwind arbitrary value brackets that contain a px literal anywhere:
    // e.g. w-[280px], p-[3px], rounded-[2px], h-[calc(100%-1px)],
    // after:bottom-[-5px]. Skips data-attribute selectors like
    // data-[state=active], CSS-variable references like [--my-var:value],
    // and `ring-[Npx]` (handled by arbitrary-bracket-ring so the message
    // can suggest the built-in `ring-N` width utility).
    name: 'arbitrary-bracket-px',
    scan: (text) => {
      const out: Array<{ index: number; match: string }> = []
      ARBITRARY_BRACKET.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = ARBITRARY_BRACKET.exec(text))) {
        const inner = m[1]
        if (isAllowedTailwindArbitrary(inner)) continue
        if (!PX_PATTERN.test(inner)) continue
        const preceding = text.slice(Math.max(0, m.index - 5), m.index)
        if (/(?:^|[:\s])ring-$/.test(preceding)) continue
        out.push({ index: m.index, match: m[0] })
      }
      return out
    },
  },
  {
    // Tailwind ring-[Npx]: replace with the built-in `ring-N` width utility
    // (e.g. ring-3) plus a token-named ring color (`ring-accent-ring`). Split
    // out from arbitrary-bracket-px so the message points at the right fix.
    name: 'arbitrary-bracket-ring',
    scan: (text) => {
      const out: Array<{ index: number; match: string }> = []
      const re = /\bring-\[([^\]]+)\]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        const inner = m[1]
        if (PX_PATTERN.test(inner)) {
          out.push({ index: m.index, match: m[0] })
        }
      }
      return out
    },
  },
  {
    // Tailwind arbitrary value brackets that contain a hex literal: e.g.
    // bg-[#abcdef]. Hex must come from tokens.ts via the CSS variables.
    name: 'arbitrary-bracket-hex',
    scan: (text) => {
      const out: Array<{ index: number; match: string }> = []
      ARBITRARY_BRACKET.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = ARBITRARY_BRACKET.exec(text))) {
        const inner = m[1]
        if (HEX_PATTERN.test(inner)) {
          out.push({ index: m.index, match: m[0] })
        }
      }
      return out
    },
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
    const relPosix = rel.split(sep).join('/')
    if (ALLOWLIST_FILES.has(rel)) continue
    const exempt = PER_FILE_RULE_EXEMPTIONS[relPosix] ?? new Set<string>()
    const text = await readFile(abs, 'utf8')
    for (const rule of RULES) {
      if (exempt.has(rule.name)) continue
      const hits = rule.scan(text)
      for (const hit of hits) {
        const { line, column } = lineColFromIndex(text, hit.index)
        violations.push({
          file: toRel(abs),
          line,
          column,
          rule: rule.name,
          match: hit.match,
        })
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
