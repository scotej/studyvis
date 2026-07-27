#!/usr/bin/env tsx
// Storybook coverage guard. CLAUDE.md ends its stack section with "Storybook
// for every primitive and feature component; mandatory", and its test-harness
// note explains why that is load-bearing rather than decorative: vitest runs
// node-env with no jsdom or RTL, there are no *.test.tsx files, so "component
// behaviour is covered by Storybook + the axe-core gate". A component with no
// story is therefore a component with no test AND no accessibility check —
// `npm run check-a11y` can only audit stories that exist.
//
// Coverage is resolved by IMPORT, not by filename: src/stories/Button.stories.tsx
// covers src/components/ui/button.tsx because it imports it. Filename matching
// would be wrong in both directions here (stories are PascalCase, ui/
// primitives are kebab-case, and several stories cover more than one module).
//
// Runs in CI (`npm run check-stories`); exits 1 listing uncovered components.
// Its siblings check-tokens.ts / check-strings.ts share this shape.

import { readFile, readdir } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const STORIES = join(ROOT, 'src', 'stories')
const COMPONENT_DIRS = [
  join(ROOT, 'src', 'components'),
  join(ROOT, 'src', 'components', 'ui'),
]

// Components that have no story today. This is a freeze, not an amnesty: the
// gate exists so the NEXT component cannot land without one, and adding to
// this list should feel like a decision rather than a formality. Every entry
// carries the reason it is here and what would clear it.
const KNOWN_UNCOVERED: Record<string, string> = {
  'src/components/ui/skeleton.tsx':
    'Trivial presentational primitive; a story is easy and would be welcome. Clear this by writing one.',
  'src/components/PairQrCode.tsx':
    'Renders a QR of a real pair link; a story needs a fixture link that is not a real identity. Worth doing, not yet done.',
  'src/components/PairQrScanner.tsx':
    'Opens a live camera via getUserMedia. Storybook has no camera and the axe pass runs headless, so a story would assert nothing.',
}

const IMPORT_PATTERN = /from\s+'(@\/(?:components|features)\/[^']+)'/g

async function walk(dir: string, recurse: boolean): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (recurse) out.push(...(await walk(full, recurse)))
      continue
    }
    if (entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

async function main() {
  // Every module any story imports, normalised to a repo-relative path. The
  // alias '@/x' maps to 'src/x' (vite.config.ts resolve.alias).
  const covered = new Set<string>()
  const storyFiles = (await readdir(STORIES)).filter((n) =>
    n.endsWith('.stories.tsx')
  )
  for (const file of storyFiles) {
    const text = await readFile(join(STORIES, file), 'utf8')
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      covered.add(`src/${match[1].slice('@/'.length)}.tsx`)
    }
  }

  const components: string[] = []
  for (const dir of COMPONENT_DIRS) {
    for (const file of await walk(dir, false)) {
      components.push(relative(ROOT, file).split('\\').join('/'))
    }
  }
  components.sort()

  const uncovered = components.filter(
    (c) => !covered.has(c) && !(c in KNOWN_UNCOVERED)
  )

  // A stale exemption is its own bug: it quietly lowers the bar for a
  // component that has since been given a story, or names a file that no
  // longer exists.
  const stale = Object.keys(KNOWN_UNCOVERED).filter(
    (c) => !components.includes(c) || covered.has(c)
  )

  if (uncovered.length === 0 && stale.length === 0) {
    process.stdout.write(
      `check-stories: OK (${components.length} components, ${storyFiles.length} stories, ` +
        `${Object.keys(KNOWN_UNCOVERED).length} known-uncovered)\n`
    )
    process.exit(0)
  }

  if (uncovered.length > 0) {
    process.stderr.write(
      `check-stories: ${uncovered.length} component(s) with no story\n`
    )
    for (const c of uncovered) process.stderr.write(`  ${c}\n`)
    process.stderr.write(
      '\nStorybook is the only component-test surface in this repo (CLAUDE.md test-harness note),\n' +
        'and check-a11y can only audit components that have a story. Add one in src/stories/,\n' +
        'or add a KNOWN_UNCOVERED entry in scripts/check-stories.ts saying why it cannot have one.\n'
    )
  }

  if (stale.length > 0) {
    process.stderr.write(
      `\ncheck-stories: ${stale.length} stale KNOWN_UNCOVERED entr(ies) — a story now exists, or the file moved:\n`
    )
    for (const c of stale) process.stderr.write(`  ${c}\n`)
    process.stderr.write('Remove them from scripts/check-stories.ts.\n')
  }

  process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
