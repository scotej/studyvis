#!/usr/bin/env tsx
// Storybook coverage guard. New primitive and feature components must have a
// story; the explicit legacy baseline below may only shrink. This is
// load-bearing because vitest runs node-env with no jsdom or RTL and there are
// no *.test.tsx files. Storybook + axe provide static rendered accessibility
// coverage for stories that exist, not interaction/behaviour tests. A component
// with no story receives neither that render smoke nor that axe audit.
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
// Stories are discovered anywhere under src/, matching .storybook/main.ts's
// own glob ('../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'). Reading only
// src/stories/ would count a colocated Foo.stories.tsx as neither coverage
// nor a story — it would be reported as an uncovered "component" instead.
const SRC = join(ROOT, 'src')
// The new-component rule covers both primitives and feature components, so
// scoping this to components/ would quietly exempt the feature tree. Both trees
// are walked recursively — a new src/components/<group>/ subdirectory is a
// component directory like any other.
const COMPONENT_DIRS: string[] = [
  join(ROOT, 'src', 'components'),
  join(ROOT, 'src', 'features'),
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

// The feature tree as it stood when this gate landed: 33 of 56 .tsx files
// under src/features/ have no story. Freezing them is the only honest way to
// turn the gate on today — enforcing retroactively would mean writing 33
// stories in a CI pull request, and leaving features/ out of scope entirely
// (the earlier draft of this script) meant the step claimed a coverage it
// did not check.
//
// This list must only ever SHRINK. It is not a place to add new components:
// anything landing in src/features/ from now on is caught by the check above,
// and deleting a line here after writing the story is the intended direction
// of travel. A path listed here that no longer exists, or that has since
// gained a story, is reported as stale.
const FEATURE_BASELINE = new Set<string>([
  'src/features/ai/AiDialogWindow.tsx',
  'src/features/ai/ModelGuide.tsx',
  'src/features/ai/ModelPicker.tsx',
  'src/features/ai/ModelPickerContainer.tsx',
  'src/features/ai/ai-dialog-main.tsx',
  'src/features/friends/AddFriendDialog.tsx',
  'src/features/friends/ContactImportDialog.tsx',
  'src/features/friends/FriendsList.tsx',
  'src/features/friends/InboxBoot.tsx',
  'src/features/friends/PairDeepLinkBoot.tsx',
  'src/features/friends/PairWordInput.tsx',
  'src/features/friends/PendingInvites.tsx',
  'src/features/identity/IdentityLoadError.tsx',
  'src/features/identity/IdentitySetupGate.tsx',
  'src/features/identity/Recover.tsx',
  'src/features/onboarding/AddFriendStep.tsx',
  'src/features/onboarding/IdentityStep.tsx',
  'src/features/onboarding/Onboarding.tsx',
  'src/features/onboarding/PermissionsStep.tsx',
  'src/features/session/SessionInviteDialog.tsx',
  'src/features/session/SessionView.tsx',
  'src/features/session/TopicGateModal.tsx',
  'src/features/settings/Settings.tsx',
  'src/features/settings/SettingsOverlay.tsx',
  'src/features/settings/categories/AiCategory.tsx',
  'src/features/settings/categories/StatsCategory.tsx',
  'src/features/stats/Dashboard.tsx',
  'src/features/stats/FocusInsights.tsx',
  'src/features/system/PomodoroNotifyListener.tsx',
  'src/features/system/PttListener.tsx',
  'src/features/system/QuitConfirmListener.tsx',
  'src/features/system/WindowLayoutListener.tsx',
  'src/features/updater/UpdaterBoot.tsx',
])

const IMPORT_PATTERN = /from\s+'(@\/(?:components|features)\/[^']+)'/g

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walk(full)))
      continue
    }
    if (entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

const isStory = (path: string) => /\.stories\.tsx$/.test(path)

async function main() {
  // Every module any story imports, normalised to a repo-relative path. The
  // alias '@/x' maps to 'src/x' (vite.config.ts resolve.alias).
  const covered = new Set<string>()
  const storyFiles = (await walk(SRC)).filter(isStory)
  for (const file of storyFiles) {
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      covered.add(`src/${match[1].slice('@/'.length)}.tsx`)
    }
    // A colocated story covers its neighbour by convention even when it
    // imports it relatively: Foo.stories.tsx sitting beside Foo.tsx.
    const sibling = relative(ROOT, file).replace(/\.stories\.tsx$/, '.tsx')
    covered.add(sibling.split('\\').join('/'))
  }

  const components: string[] = []
  for (const dir of COMPONENT_DIRS) {
    for (const file of await walk(dir)) {
      if (isStory(file)) continue
      components.push(relative(ROOT, file).split('\\').join('/'))
    }
  }
  components.sort()

  const uncovered = components.filter(
    (c) =>
      !covered.has(c) && !(c in KNOWN_UNCOVERED) && !FEATURE_BASELINE.has(c)
  )

  // A stale exemption is its own bug: it quietly lowers the bar for a
  // component that has since been given a story, or names a file that no
  // longer exists.
  const stale = [...Object.keys(KNOWN_UNCOVERED), ...FEATURE_BASELINE].filter(
    (c) => !components.includes(c) || covered.has(c)
  )

  if (uncovered.length === 0 && stale.length === 0) {
    process.stdout.write(
      `check-stories: OK (${components.length} components, ${storyFiles.length} stories, ` +
        `${Object.keys(KNOWN_UNCOVERED).length} known-uncovered, ` +
        `${FEATURE_BASELINE.size} frozen feature baseline)\n`
    )
    process.exit(0)
  }

  if (uncovered.length > 0) {
    process.stderr.write(
      `check-stories: ${uncovered.length} component(s) with no story\n`
    )
    for (const c of uncovered) process.stderr.write(`  ${c}\n`)
    process.stderr.write(
      '\nStorybook is the only automated rendered component/a11y surface in this repo (CLAUDE.md test-harness note),\n' +
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
