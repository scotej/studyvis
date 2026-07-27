#!/usr/bin/env tsx
// Forward-only migration guard. `src-tauri/src/db/migrations.rs` opens with
// "never edit a shipped migration in place (001 was amended pre-release; that
// door is closed)". Friends install releases manually and out of order in
// time, so a one-character edit to 002_v2.sql is invisible on a fresh install
// and silently wrong on every machine that already ran the old text: the
// schema_version row is already there, so the amended DDL never re-runs.
//
// The Rust test `shipped_migrations_are_immutable` already pins the same
// three hashes (and this script's values match it byte for byte, CRLF
// normalization included — that agreement is deliberate). Two reasons this
// exists anyway:
//   - it runs in the `frontend` job in seconds, rather than behind a full
//     Tauri compile on macOS and Windows, so the feedback arrives first;
//   - it checks two things the Rust test does not, below.
//
// Three failures, all of which reach a friend's disk before anyone notices:
//   1. an edit to an already-shipped .sql file  -> hash mismatch below;
//   2. a new .sql file nobody wired into MIGRATIONS -> registration check;
//   3. a gap or duplicate in the version sequence -> sequence check.
//
// Shipping a NEW migration is meant to be a deliberate act, so it needs one
// deliberate command:  npm run check-migrations -- --update
//
// Runs in CI (`npm run check-migrations`); exits 1 with a diagnosis per
// violation. Its siblings check-tokens.ts / check-strings.ts share this shape.

import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const MIGRATIONS_DIR = join(ROOT, 'src-tauri', 'src', 'db', 'migrations')
const RUNNER = join(ROOT, 'src-tauri', 'src', 'db', 'migrations.rs')
const MANIFEST = join(MIGRATIONS_DIR, 'MANIFEST.sha256')

const FILE_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/

type Entry = { file: string; version: number; hash: string }

const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex')

async function readMigrations(): Promise<Entry[]> {
  const names = (await readdir(MIGRATIONS_DIR)).filter((n) =>
    n.endsWith('.sql')
  )
  const entries: Entry[] = []
  for (const file of names.sort()) {
    const match = FILE_PATTERN.exec(file)
    if (!match) {
      throw new Error(
        `migration filename '${file}' is not NNN_snake_case.sql — ` +
          `the runner derives its version from that prefix`
      )
    }
    // Normalise CRLF so a Windows checkout does not report every migration
    // as edited. .gitattributes forces LF in the tree, but a hash gate that
    // depends on that is a gate that fails for the wrong reason one day.
    const text = (await readFile(join(MIGRATIONS_DIR, file), 'utf8')).replace(
      /\r\n/g,
      '\n'
    )
    entries.push({ file, version: Number(match[1]), hash: sha256(text) })
  }
  return entries
}

async function readManifest(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  let raw: string
  try {
    raw = await readFile(MANIFEST, 'utf8')
  } catch {
    return map
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    // `sha256sum` format: "<hash>  <filename>".
    const [hash, ...rest] = trimmed.split(/\s+/)
    if (hash && rest.length) map.set(rest.join(' '), hash)
  }
  return map
}

function renderManifest(entries: Entry[]): string {
  return [
    '# Hashes of every migration that has shipped. Regenerate ONLY when',
    '# adding a new migration:  npm run check-migrations -- --update',
    '#',
    '# A changed hash for an existing file means a shipped migration was',
    '# edited in place. That is never the fix — add NNN+1 instead. See the',
    '# module doc in src-tauri/src/db/migrations.rs.',
    ...entries.map((e) => `${e.hash}  ${e.file}`),
    '',
  ].join('\n')
}

async function main() {
  const update = process.argv.includes('--update')
  const entries = await readMigrations()
  const violations: string[] = []

  if (entries.length === 0) {
    process.stderr.write('check-migrations: no migrations found\n')
    process.exit(1)
  }

  // 1. Sequence: 1..N with no gaps, no duplicates. A gap means a migration
  //    was deleted; the runner's `version > applied` loop would skip straight
  //    past it on an old database and leave the schema half-built.
  entries.forEach((entry, index) => {
    const expected = index + 1
    if (entry.version !== expected) {
      violations.push(
        `${entry.file}: expected version ${expected} in the sequence, found ${entry.version} ` +
          `(a deleted or misnumbered migration strands every database that stopped before it)`
      )
    }
  })

  // 2. Registration: the .sql file is inert until migrations.rs both
  //    include_str!s it and lists it in MIGRATIONS.
  const runner = await readFile(RUNNER, 'utf8')
  for (const entry of entries) {
    if (!runner.includes(`migrations/${entry.file}`)) {
      violations.push(
        `${entry.file}: no include_str!("migrations/${entry.file}") in src/db/migrations.rs — ` +
          `the file exists but never runs`
      )
      continue
    }
    const constName = runner.match(
      new RegExp(
        `const\\s+(\\w+)\\s*:\\s*&str\\s*=\\s*include_str!\\("migrations/${entry.file.replace(
          /\./g,
          '\\.'
        )}"\\)`
      )
    )?.[1]
    if (!constName) continue
    const tuple = new RegExp(
      `\\(\\s*${entry.version}\\s*,\\s*${constName}\\s*\\)`
    )
    if (!tuple.test(runner)) {
      violations.push(
        `${entry.file}: ${constName} is not listed as (${entry.version}, ${constName}) in MIGRATIONS — ` +
          `include_str! alone does not apply it`
      )
    }
  }

  // 3. Immutability: the whole point. Compare against what shipped.
  const manifest = await readManifest()
  if (!update) {
    for (const entry of entries) {
      const recorded = manifest.get(entry.file)
      if (recorded === undefined) {
        violations.push(
          `${entry.file}: not in MANIFEST.sha256. If this is a new migration, run ` +
            `\`npm run check-migrations -- --update\` and commit the manifest alongside it`
        )
      } else if (recorded !== entry.hash) {
        violations.push(
          `${entry.file}: content changed since it shipped (${recorded.slice(0, 12)} -> ${entry.hash.slice(0, 12)}). ` +
            `Migrations are forward-only: every friend who already ran this file will NEVER run the new text. ` +
            `Add ${String(entries.length + 1).padStart(3, '0')}_*.sql instead`
        )
      }
    }
    for (const file of manifest.keys()) {
      if (!entries.some((e) => e.file === file)) {
        violations.push(
          `${file}: listed in MANIFEST.sha256 but missing from the tree — a shipped migration was deleted`
        )
      }
    }
  }

  if (update) {
    // Refuse to launder an edit as an addition: --update may only ever add
    // rows. Changing an existing hash still has to be argued for by hand.
    const changed = entries.filter(
      (e) => manifest.has(e.file) && manifest.get(e.file) !== e.hash
    )
    if (changed.length > 0) {
      process.stderr.write(
        `check-migrations: --update refuses to rewrite ${changed.length} existing hash(es):\n` +
          changed.map((e) => `  ${e.file}\n`).join('') +
          `\nThese migrations already shipped. Add a new NNN_*.sql instead of editing them.\n` +
          `If this file genuinely never shipped, delete its manifest line by hand and say why in the commit.\n`
      )
      process.exit(1)
    }
    await writeFile(MANIFEST, renderManifest(entries), 'utf8')
    process.stdout.write(
      `check-migrations: manifest updated (${entries.length} migrations)\n`
    )
    process.exit(violations.length === 0 ? 0 : 1)
  }

  if (violations.length === 0) {
    process.stdout.write(
      `check-migrations: OK (${entries.length} migrations, hashes match, all registered)\n`
    )
    process.exit(0)
  }

  process.stderr.write(`check-migrations: ${violations.length} violation(s)\n`)
  for (const v of violations) process.stderr.write(`  ${v}\n`)
  process.stderr.write(
    '\nSchema is a cross-version compatibility surface (CLAUDE.md); migrations are forward-only.\n'
  )
  process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
