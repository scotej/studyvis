#!/usr/bin/env tsx
// V3-P8 — centralised-copy guard. Mirrors scripts/check-tokens.ts:
//
//   - Scans every .ts/.tsx file under src/ for raw string literals passed
//     to surfaces that render to the user (toast/notification), since
//     those are the riskiest place for inline copy to sneak back in.
//   - Allows template literals (interpolation), variable refs, and string
//     constants whose name starts with a known module path — see the
//     ALLOWED_VALUE_PATTERNS below.
//   - Per-file exemptions for dev-only routes, Storybook stories, and the
//     strings.ts module itself.
//
// Failure mode: process exits 1 and prints `file:line:col [rule] match`
// so the developer can find the slip-up. To clear a violation, hoist the
// literal into src/strings.ts and reference it.
//
// Intentionally targeted (not exhaustive): this guard catches the cases
// that have actually drifted in past phases — toast/notification — rather
// than every JSX text node. The full sweep stays a manual reviewer task.

import { readFile, readdir } from 'node:fs/promises'
import { resolve, relative, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const SRC = join(ROOT, 'src')

const ALLOWLIST_FILES = new Set<string>([
  join('src', 'strings.ts'),
  join('src', 'routes', 'StyleGuide.tsx'),
])

const ALLOWLIST_DIR_PREFIXES = [join('src', 'stories') + sep]

type Violation = {
  file: string
  line: number
  column: number
  rule: string
  match: string
}

type WholeFileRule = {
  name: string
  scan: (text: string, file: string) => Array<{ index: number; match: string }>
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

// A toast() / notification call where the argument is a *bare string
// literal* — single quote, double quote, or untemplated backtick (no
// `${...}` substitutions; an interpolated template is permitted because
// it carries runtime values). Allowed alternatives:
//   - template strings with at least one `${...}`
//   - variable references (most callers pass `message` or `strings.x.y`)
//   - object literals (`toast.warning({ ... })`)
//   - identifiers starting with `strings.` (the centralised module)
//   - module-level constants whose value is itself declared in strings.ts
//
// Backslash inside a literal (e.g. `\"`, `\'`) is tolerated by allowing
// any escape sequence inside the body.
const TOAST_RULE: WholeFileRule = {
  name: 'inline-toast-literal',
  scan: (text) => {
    const out: Array<{ index: number; match: string }> = []
    // toast(  toast.error(  toast.warning(  toast.success(  toast.message(
    // Three alternations cover the three literal flavours: '…', "…", `…`
    // (the backtick form rejects templates by excluding `${`).
    const quoted = `(?:'(?:\\\\.|[^'\\\\\\n])+'|"(?:\\\\.|[^"\\\\\\n])+"|\`(?:\\\\.|[^\`\\\\$]|\\$(?!\\{))+\`)`
    const re = new RegExp(
      `(?<![A-Za-z0-9_$.])toast(?:\\.(?:error|warning|success|message))?\\s*\\(\\s*${quoted}`,
      'g'
    )
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      out.push({ index: m.index, match: m[0] })
    }
    return out
  },
}

const NOTIFICATION_RULE: WholeFileRule = {
  name: 'inline-notification-literal',
  scan: (text) => {
    const out: Array<{ index: number; match: string }> = []
    // sendNotification({ title: '...', body: '...' })  → flag string-literal
    // title or body. Same three-flavour literal matcher as TOAST_RULE.
    const quoted = `(?:'(?:\\\\.|[^'\\\\\\n])+'|"(?:\\\\.|[^"\\\\\\n])+"|\`(?:\\\\.|[^\`\\\\$]|\\$(?!\\{))+\`)`
    const re = new RegExp(
      `sendNotification\\s*\\(\\s*\\{[\\s\\S]*?(?:title|body)\\s*:\\s*${quoted}[\\s\\S]*?\\}\\s*\\)`,
      'g'
    )
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      out.push({ index: m.index, match: m[0].slice(0, 80) })
    }
    return out
  },
}

const RULES: WholeFileRule[] = [TOAST_RULE, NOTIFICATION_RULE]

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
    if (ALLOWLIST_DIR_PREFIXES.some((p) => rel.startsWith(p))) continue
    const text = await readFile(abs, 'utf8')
    for (const rule of RULES) {
      const hits = rule.scan(text, rel)
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
    process.stdout.write(`check-strings: OK (${files.length} files scanned)\n`)
    process.exit(0)
  }

  process.stderr.write(`check-strings: ${violations.length} violation(s)\n`)
  for (const v of violations) {
    process.stderr.write(
      `  ${v.file}:${v.line}:${v.column}  [${v.rule}]  ${v.match}\n`
    )
  }
  process.stderr.write(
    '\nUser-facing copy must reference src/strings.ts. Hoist the literal there, then\n' +
      'replace the inline call site with `strings.x.y` or a function reference.\n'
  )
  process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
