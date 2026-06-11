# StudyVis — Claude Code working agreement

Auto-loaded by Claude Code at the start of every session in this repo. It summarizes how to work here and points to the canonical docs. Read the relevant ones in full at the start of any non-trivial session — they are the source of truth, not training data.

StudyVis is **shipped and feature-complete**: a peer-to-peer desktop study app for friends (body-doubling video + optional on-device AI focus detection), released friends-only and unsigned for macOS + Windows. The current line is **v1.x** (see `CHANGELOG.md`). Work is now **maintenance and new features**, not a from-scratch build. There are real installed builds but no auto-update and no public users — friends pull releases manually.

## Canonical documents

The source of truth for their concern. Read the ones a task touches; don't work from memory of them.

1. **`PLAN.md`** — vision, scope, version boundaries (V0→V3), what running the app means, non-goals, known limitations.
2. **`ARCHITECTURE.md`** — tech stack + versions, identity model, P2P discovery, AI pipeline, file layout, threat model, state diagrams.
3. **`DESIGN-SYSTEM.md`** — design direction, tokens, component inventory, theme variants, the six consistency rules, ASCII wireframes, copy/voice.

Supporting references:

- **`CHANGELOG.md`** — release history by version era (V1 / V2 / V3). Keep it current when you ship a release.
- **`ISSUES.md`** — the audit ledger (Sev1–Sev4). **`I9` (Pomodoro broadcaster takeover) and `I18` (sidecar model-path sandbox) are accepted deviations** under the friends-only threat model — do not "fix" them without an explicit request.
- **`README.md`** / **`INSTALL.md`** — user-facing entry point and install walkthrough.
- **`BUILD-PROMPTS.md`** — **historical**. The sequenced prompts that originally built V0→V3, kept for provenance. It is *not* a live spec; do not paste from it or treat its phase scaffolding as current process.

If a request conflicts with PLAN / ARCHITECTURE / DESIGN-SYSTEM, surface the conflict; don't silently deviate.

## Working agreement

- **Reasoning budget is unlimited.** Think deeply when the task warrants it. There is no token concern.
- **Subagents are encouraged.** Use `Explore` for orientation and "where is X?" lookups, `Plan` for architectural trade-offs, `general-purpose` for parallel research.
- **Advisor is encouraged.** Call `advisor()` before committing to any non-obvious approach and once before declaring a task done. The advisor sees full conversation context.
- **Context7 over web search** for any library / API / framework documentation. Always verify the current state of an external library before depending on its API; do not rely on training-data memory.
- **Verify, don't assume.** When a fact about an external library, model, version, CLI flag, or platform behavior is load-bearing, look it up.

## Desktop testing capability

A user-scoped MCP server (`windows-mcp`, registered in `~/.claude.json`) exposes desktop control on the user's Windows host. When Claude Code runs on that machine, tools matching `mcp__windows-mcp__*` — mouse, keyboard, screenshots, window enumeration — load at session start. Use them when a task benefits from observing the live app: verifying a visual change, walking a flow, catching a UI/UX regression. Don't ask the user to screenshot manually when you can capture it yourself. Declare in the PR's manual-test section what was machine-walked vs. user-walked.

- **Confirm before destructive on-screen actions** — closing apps with unsaved work, file deletion via Explorer, anything inside a signed-in browser session. The blast radius is "anything the user could do at the keyboard."
- **Platform note.** Windows-MCP is Windows-only. macOS / Linux developer machines need an analogous setup; if it's missing on the current host, fall back to user-driven screenshots and say so in the summary.

## House rules (apply to all code in this repo)

- **Single source of truth for design tokens.** Every color, spacing, font, radius, shadow, motion, and z-index value comes from `src/design/tokens.ts`. No raw hex, no arbitrary `px`, no inline `cubic-bezier` outside `tokens.ts`. Enforced by `scripts/check-tokens.ts` in pre-commit.
- **Single source of truth for user-facing strings.** Toast and notification copy lives in `src/strings.ts`, guarded by `scripts/check-strings.ts`. JSX text and `aria-label` literals are not yet exhaustively guarded — keep them in voice (see `DESIGN-SYSTEM.md` §14) and prefer `strings.ts`.
- **Component layering wall.** `src/components/ui/` is the only place Radix / shadcn primitives may be imported. `src/components/` composes from `ui/`, `src/design/`, and shared utils. Reverse imports are an ESLint error.
- **Accessibility is a gate, not a nicety.** WCAG AA on every text/background pairing in both themes (`scripts/check-contrast.ts`); axe-core over every Storybook story (`npm run check-a11y`); no information by color alone; reduced-motion is a global kill switch. New motion sites are gated by default.
- **Compatibility surfaces are real now.** Local data persists across the manual updates friends install: SQLite schema migrations must be **forward-only and tested** (see `src-tauri/src/db/migrations/`), and peer **wire formats** + **identity derivation** are cross-version contracts — coordinate changes, don't break a friend's stored data or strand a peer on an older build. We still don't need web-scale compat shims for things never released.
- **No telemetry, ever.** Local-only. Never instruct the user to paste a model file or BIP39 mnemonic into a chat with any AI service.
- **No new documentation files unless asked.** Updating a canonical doc, `CHANGELOG.md`, or `ISSUES.md` when justified is fine. Sprawling extra `.md` files are not. Prefer concise commits and PR descriptions.
- **No comments unless the *why* is non-obvious.** Identifiers carry the meaning; code reads top-to-bottom.
- **Scope discipline.** Don't refactor adjacent code while implementing a feature. Don't add abstractions for hypothetical future needs. A bug fix is a bug fix; a feature is a feature.
- **One focused change per commit.** Conventional-commit subject (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`); PRs squash-merge.

## Quality gates (run before committing / opening a PR)

```
npm run build          # tsc -b && vite build (TypeScript strict must pass)
npm run lint           # eslint (includes the layering-wall rule)
npm run test           # vitest (node-env; see the test-harness note below)
npm run check-tokens   # design-token guard
npm run check-strings  # strings-module guard
npm run check-contrast # WCAG AA over both themes
npm run check-a11y     # axe-core over Storybook (needs `npm run build-storybook` first)
cargo test && cargo fmt --check && cargo clippy   # in src-tauri/, for Rust changes
```

Pre-commit (husky) enforces a subset automatically — `lint`, `check-tokens`, `check-strings`, `format:check` (prettier repo-wide), `tsc --noEmit` (tsconfig.app.json), and the `cargo fmt --check` gate. The rest above (`build`, `test`, `check-contrast`, `check-a11y`, `cargo test`/`clippy`) are **not** in the hook — run them yourself before opening a PR. Before committing multi-file or subagent work, run `npm run format` (prettier --write .) so the whole tree is clean — `format:check` rejects files you didn't touch.

> If the pre-commit hook isn't firing (commits succeed with no gate output), `git config core.hooksPath` has drifted — run `npm run prepare` to reset husky to `.husky/_`.

> **Test-harness caveat.** Vitest runs in node-env with no RTL/jsdom; there are no `*.test.tsx` component tests. Component behavior is covered by Storybook + the axe-core gate. Adding component tests needs a deliberate, flagged scope expansion.

## Running the app

- `npm run tauri dev` — full desktop app (real surfaces). The npm script is `tauri`; there is no `tauri:dev` alias.
- `npm run dev` — Vite frontend only (fast UI iteration; Tauri APIs stubbed/absent).
- `npm run storybook` — component preview at http://localhost:6006. A dev-only primitive gallery is at `/style`.

## Stack at a glance

- **Tauri 2** + **React 19** + **Vite 8** + **Tailwind v4** + **shadcn/ui** + **TypeScript strict**.
- **trystero** (Nostr default) for P2P discovery; **@noble/ed25519** + **@scure/bip39** + **@noble/curves** + **@noble/ciphers** for crypto.
- **rusqlite** under Rust commands for the local DB.
- **llama-server** sidecar (llama.cpp build) for on-device AI inference, bundled per-platform via Tauri `externalBin`, started on demand.
- **Storybook** for every primitive and feature component; mandatory.

Versions and full justifications are in `ARCHITECTURE.md` §2.

## Repo layout (high level)

```
PLAN.md, ARCHITECTURE.md, DESIGN-SYSTEM.md   ← canonical specs
CHANGELOG.md, ISSUES.md, README.md, INSTALL.md, BUILD-PROMPTS.md (historical)
src-tauri/   ← Rust + Tauri config + capabilities + db/migrations + bundled binaries
src/         ← React frontend
  design/      ← tokens.ts, index.css
  components/ui/   ← vendored shadcn primitives (only place primitives are imported)
  components/      ← app-composed components
  features/        ← identity, onboarding, friends, session, settings, stats, ai, system
  lib/             ← crypto, db, trystero, webrtc, media, encoding, keybindings, …
  stores/          ← Zustand stores (identity, friends, session, settings, audit, pomodoro, ptt)
  routes/          ← minimal routing (Home + dev-only /style)
  stories/         ← Storybook
  strings.ts       ← user-facing copy   types/   App.tsx   main.tsx
scripts/     ← check-tokens / check-strings / check-contrast, fetch/build-llama-server, generate-*
tests/       ← unit / integration / ai-eval (eval dataset + RESULTS.md)
```

Full layout in `ARCHITECTURE.md` §11.

## Releases

Releasing bumps the version in **five tracked files** (kept in lockstep): `package.json`, `package-lock.json` (two entries), `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` (the `studyvis` entry), `src-tauri/tauri.conf.json`. Two ways to cut one:

- **One-click:** the `Release prep` workflow (Actions tab, `.github/workflows/release-prep.yml`) bumps all five files, commits + tags `vX.Y.Z` on `main`, and dispatches the release build.
- **Manual:** bump the five files yourself, commit `chore(release): vX.Y.Z`, and push a `v*.*.*` tag — `release.yml` builds the per-OS installers as a **draft** GitHub Release to review and publish.

Update `CHANGELOG.md` as part of the release. `package.json#version` flows through `__APP_VERSION__` into Settings → About automatically.

## When in doubt

- Ask the user if the task is genuinely ambiguous.
- Otherwise: re-read the relevant canonical docs, call `advisor()`, then proceed.
