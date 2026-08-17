# AGENTS.md

Entry point for coding agents. **[`CLAUDE.md`](./CLAUDE.md) is the authoritative
working agreement** — this file exists so agents that don't read `CLAUDE.md` by
convention still find their way there. Everything below is a pointer or a
tripwire; where the two disagree, `CLAUDE.md` wins.

StudyVis is a shipped, feature-complete peer-to-peer desktop study app (Tauri 2 +
React 19 + TypeScript strict), released friends-only and unsigned for macOS and
Windows, with an x86_64 Linux AppImage release candidate in progress. Work here
is maintenance and new features, not a from-scratch build. There are real
installed builds, so local data, peer wire formats, and identity derivation are
compatibility surfaces.

## Read before you edit

The canonical docs are the source of truth for their concern. Read the ones your
task touches — don't work from memory of them.

| Doc                                      | Concern                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| [`CLAUDE.md`](./CLAUDE.md)               | How to work here: house rules, quality gates, CI layout. **Start here.** |
| [`PLAN.md`](./PLAN.md)                   | Vision, scope, version boundaries, non-goals                             |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md)   | Stack, identity, P2P discovery, AI pipeline, threat model                |
| [`DESIGN-SYSTEM.md`](./DESIGN-SYSTEM.md) | Tokens, components, theme variants, copy voice                           |
| [`ISSUES.md`](./ISSUES.md)               | Audit ledger, one `###` section per finding                              |
| [`CHANGELOG.md`](./CHANGELOG.md)         | Release history; user-facing changes only                                |

If a request conflicts with those, surface the conflict — don't silently deviate.

## Non-negotiables

- **Design tokens** come from `src/design/tokens.ts`. No raw hex, no arbitrary
  `px`, no inline `cubic-bezier` elsewhere.
- **User-facing strings** live in `src/strings.ts`.
- **Component layering wall**: `src/components/ui/` is the only place Radix /
  shadcn primitives may be imported. Reverse imports are an ESLint error.
- **Accessibility is a gate**: WCAG AA in both themes, axe-core over every
  Storybook story, no information by color alone.
- **SQLite migrations are forward-only** and tested. Peer wire formats and
  identity derivation are cross-version contracts.
- **No telemetry, ever.** Never instruct a user to paste a model file or BIP39
  mnemonic into any AI service.
- **No new documentation files unless asked.** Updating a canonical doc,
  `CHANGELOG.md`, or `ISSUES.md` when justified is fine.
- **Scope discipline.** A bug fix is a bug fix. Don't refactor adjacent code or
  add abstractions for hypothetical needs.

## Before you commit

Pre-commit (husky) runs a subset automatically. These are **not** in the hook —
run them yourself:

```sh
npm run build          # tsc -b && vite build
npm run test           # vitest (node-env; no RTL/jsdom, no *.test.tsx)
npm run check-contrast
npm run check-a11y     # needs `npm run build-storybook` first
cargo test && cargo clippy && cargo deny check   # in src-tauri/, for Rust changes
```

Run `npm run format` before committing multi-file work — `format:check` rejects
files you didn't touch. Conventional-commit subjects (`feat:`, `fix:`, `ci:`);
PRs squash-merge and the title is linted.

## Tripwires that no check will catch

- **Two jobs compile WebKitGTK** — `ci.yml`'s `Linux AppImage startup smoke` and
  `deploy.yml`'s Linux installer — and their cache keys are byte-identical _on
  purpose_ so one entry serves both. Edit such a key in both files or neither.
  A cold compile is ~3.5h; a warm one is ~1s. See **Linux build caching** in
  `CLAUDE.md`, and read it fully before touching either workflow.
- **The Linux runtime is a product-owned supply-chain surface.** Pinned source
  tuples, hashes, license inventories, and the corresponding-source archive must
  stay coherent. Never "fix" Linux by linking the AppImage against the host's
  WebKitGTK, and never add restored build state to the tagged release leg.
- **`ISSUES.md` I9 and I18 are accepted deviations** under the friends-only
  threat model. Do not "fix" them without an explicit request.
- **Comment tags** (`I9`, `F6`, `V1-P4`, `PR-27`) are pointers into `ISSUES.md`
  and retired backlogs, decoded in `CLAUDE.md`. Keep the convention when you fix
  something traceable to one.

## Running it

```sh
npm run tauri dev      # full desktop app
npm run dev            # Vite frontend only (Tauri APIs absent)
npm run storybook      # component preview at :6006
```

Human setup instructions, including CachyOS/Arch prerequisites, are in
[`README.md`](./README.md#developing) and [`INSTALL.md`](./INSTALL.md).
