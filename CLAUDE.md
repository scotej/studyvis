# StudyVis — Claude Code working agreement

This file is auto-loaded by Claude Code at the start of every session in this repo. It summarizes how to work here and points to the canonical docs. Read these in full at the start of any non-trivial session — they are the source of truth, not training data.

## Canonical documents (read in order)

1. **`PLAN.md`** — vision, scope, version boundaries, what running the app means, non-goals, known limitations.
2. **`ARCHITECTURE.md`** — tech stack, identity model, P2P discovery, AI pipeline, file layout, threat model, state diagrams.
3. **`DESIGN-SYSTEM.md`** — design direction, tokens, component inventory, theme variants, six consistency rules, ASCII wireframes, copy tone.
4. **`BUILD-PROMPTS.md`** — the sequenced prompts the user pastes for each implementation slice. Each prompt is self-contained.

If any prompt or instruction conflicts with these documents, surface the conflict; don't silently deviate.

## Working agreement

- **Reasoning budget is unlimited.** Think deeply when the task warrants it. There is no token concern.
- **Subagents are encouraged.** Use `Explore` for orientation and "where is X?" lookups, `Plan` for architectural trade-offs, `general-purpose` for parallel research.
- **Advisor is encouraged.** Call `advisor()` before committing to any non-obvious approach and once before declaring a task done. The advisor sees full conversation context.
- **Context7 over web search** for any library / API / framework documentation. Always verify current state of an external library before depending on its API; do not rely on training-data memory.
- **Verify, don't assume.** When a fact about an external library, model, version, CLI flag, or platform behavior is load-bearing for the work, look it up.

## Desktop testing capability

A user-scoped MCP server (`windows-mcp`, registered in `~/.claude.json`) exposes desktop control on the user's Windows host. When Claude Code is running on that machine, tools matching `mcp__windows-mcp__*` — mouse, keyboard, screenshots, window enumeration — load at session start. Use them when a task would benefit from observing the live app: verifying a visual change, walking a flow, catching a UI/UX regression. Don't ask the user to screenshot manually when you can capture it yourself.

- **Confirm before destructive on-screen actions.** Closing apps with unsaved work, file deletion via Explorer, anything inside a signed-in browser session. The blast radius is "anything the user could do at the keyboard."
- **V3-P10 (the cold-eyes acceptance pass) is built on this capability** — single-machine autonomous UAT of the whole product before the user pushes the 1.0 tag. Other prompts may reach for it ad-hoc (verifying V3-P5's themes in the running app, walking V3-P7's keyboard pass) — that's fine; declare it in the PR's manual test section so the user knows what was machine-walked vs. user-walked.
- **Platform note.** Windows-MCP is Windows-only. macOS / Linux developer machines need an analogous setup; if it's missing on the current host, fall back to user-driven screenshots and say so in the summary.

## House rules (apply to all code in this repo)

- **Single source of truth for design tokens.** Every color, spacing, font, radius, shadow, and motion value comes from `src/design/tokens.ts`. No raw hex codes, no arbitrary `px` values, no inline `cubic-bezier` strings outside `tokens.ts`. Enforced by `scripts/check-tokens.ts` in pre-commit.
- **Component layering.** `src/components/` may import only from `src/components/ui/`, `src/design/`, and shared utilities. `src/components/ui/` is the only place Radix or other primitive imports are allowed. Reverse imports are an ESLint error.
- **No documentation files unless explicitly asked.** Updating one of the four canonical docs is allowed when justified. Generating sprawling extra `.md` files is not. Prefer concise commits and PR descriptions.
- **No comments unless the *why* is non-obvious.** Identifiers should carry the meaning; code should read top-to-bottom.
- **Scope discipline.** Don't refactor adjacent code while implementing a feature. Don't add abstractions for hypothetical future needs. A bug fix is a bug fix; a feature is a feature.
- **No backwards-compatibility shims** for things we've never released. We don't have shipped users yet.
- **No telemetry, ever.** Local-only. The user must never paste a model file or BIP39 mnemonic into a chat with any AI service.
- **Single commit per BUILD-PROMPT.** Easy to review and revert.

## Phase invariant

The `src/features/ai/` directory **does not exist in V1**. Adding any AI-related code path during a V1 prompt is a leak; reject and reorder.

## Stack at a glance

- **Tauri 2** + **React 19** + **Vite 8** + **Tailwind v4** + **shadcn/ui** + **TypeScript strict**.
- **trystero** (Nostr default) for P2P discovery; **@noble/ed25519** + **@scure/bip39** + **@noble/curves** + **@noble/ciphers** for crypto.
- **rusqlite** under Rust commands for local DB.
- **llama-server** sidecar (V2+) bundled per platform via Tauri `externalBin`.
- **Storybook** for every primitive and feature component; mandatory.

Versions and full justifications are in `ARCHITECTURE.md` §2.

## Repo layout (high level)

```
PLAN.md, ARCHITECTURE.md, DESIGN-SYSTEM.md, BUILD-PROMPTS.md, CLAUDE.md  ← canonical docs
src-tauri/   ← Rust + Tauri config + bundled binaries (V2+)
src/         ← React frontend
  design/    ← tokens.ts, index.css
  components/ui/   ← vendored shadcn primitives
  components/      ← app-specific composed components
  features/        ← {identity,friends,session,settings} (+ ai/ in V2)
  lib/             ← {trystero,webrtc,crypto,db}
  stores/          ← Zustand stores
  stories/         ← Storybook
scripts/     ← check-tokens.ts, fetch-llama-server.sh, etc.
tests/       ← unit / integration / ai-eval (V2+)
```

Full layout in `ARCHITECTURE.md` §11.

## When in doubt

- Ask the user if the task is genuinely ambiguous.
- Otherwise: read the four canonical docs again, call advisor, then proceed.
