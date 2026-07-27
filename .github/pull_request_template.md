## What changed and why

<!-- One paragraph. What behaviour is different afterwards, and what made it
worth changing. Link the issue if there is one (Fixes #123). -->

## Manual test

<!-- CI proves the code compiles, lints, and passes the automated gates. It
cannot prove the app still works — there are no component tests (vitest runs
node-env only) and no desktop smoke test. Say what you actually exercised.

Mark each line as machine-walked (driven by an agent via windows-mcp) or
user-walked (a human at the keyboard), per CLAUDE.md's desktop-testing note.
"Not applicable — docs/CI only" is a fine answer for changes that cannot
reach the running app. -->

- [ ] `npm run tauri dev` launched and the changed surface behaves as described
      — _machine-walked / user-walked / n-a_
- [ ] Checked in both themes and at reduced-motion — _machine-walked /
      user-walked / n-a_

## Compatibility surfaces

<!-- Delete the ones this PR does not touch. These are the things that break a
friend who has NOT updated yet, or that break data already on disk. If any
box is ticked, say in one line what keeps the old side working. -->

- [ ] SQLite schema / `src-tauri/src/db/migrations/` — new migration is
      **appended**, never an edit to a released file
- [ ] Peer wire format (trystero payloads, session/pomodoro/AI-alert messages)
- [ ] Identity derivation (BIP39 → ed25519/x25519, pair links, contact links)
- [ ] Persisted settings shape / store keys
- [ ] Updater manifest or release artifact names

## Gates

<!-- Pre-merge CI runs these. Tick what you ran locally; anything you skipped,
CI will tell you about. The husky pre-commit hook covers lint,
check-tokens, check-strings, check-migrations, check-stories, format:check,
tsc --noEmit, and cargo fmt — everything else below is yours to run. -->

- [ ] `npm run build && npm run lint && npm run test`
- [ ] `npm run check-tokens && npm run check-strings && npm run check-contrast`
- [ ] `npm run check-migrations && npm run check-stories`
- [ ] `npm run build-storybook && npm run check-a11y`
- [ ] `cd src-tauri && cargo fmt --check && cargo clippy && cargo test`
      — _or: no Rust changes / CI is the first compiler for this box_
- [ ] `cd src-tauri && cargo deny check` — supply chain

CI-only, nothing to run locally: `actionlint` + `zizmor` (workflow lint),
`dependency-review`, `typos`, the version-lockstep assertion, the PR-title
check, and CodeQL. They gate the merge; they just have no useful local
form.

## Merge style

<!-- CLAUDE.md: one focused change per commit, conventional-commit subjects.
Squash by default; ask for a merge commit when the per-commit rationale is
worth keeping (PR #43 / #80 precedent). -->

- [ ] Squash
- [ ] Merge commit — because: <!-- reason -->
