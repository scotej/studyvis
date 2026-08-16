# StudyVis — Claude Code working agreement

Auto-loaded by Claude Code at the start of every session in this repo. It summarizes how to work here and points to the canonical docs. Read the relevant ones in full at the start of any non-trivial session — they are the source of truth, not training data.

StudyVis is **shipped and feature-complete** on macOS Apple Silicon and Windows x86_64: a peer-to-peer desktop study app for friends (body-doubling video + optional on-device AI focus detection). The next release candidate adds Linux x86_64 AppImage support, with CachyOS KDE Wayland as its mandatory physical sign-off desktop. The current line is **v1.x** (see `CHANGELOG.md`). Work is now **maintenance and new features**, not a from-scratch build. There are real installed builds and no public users. As of **v1.5.0** the app self-updates in-app (tauri-plugin-updater, tag X6): background download + signature-verified restart, defaults ON — only the *first* install is manual. macOS and Windows remain unsigned for commercial OS code-signing purposes, so friends still clear the Gatekeeper/SmartScreen warning on that first install; the Linux candidate uses the same updater minisign chain and requires a writable AppImage for in-place update.

## Canonical documents

The source of truth for their concern. Read the ones a task touches; don't work from memory of them.

1. **`PLAN.md`** — vision, scope, version boundaries (V0→V3), what running the app means, non-goals, known limitations.
2. **`ARCHITECTURE.md`** — tech stack + versions, identity model, P2P discovery, AI pipeline, file layout, threat model, state diagrams.
3. **`DESIGN-SYSTEM.md`** — design direction, tokens, component inventory, theme variants, the six consistency rules, ASCII wireframes, copy/voice.

Supporting references:

- **`CHANGELOG.md`** — release history by version era (V1 / V2 / V3). Keep it current when you ship a release.
- **`ISSUES.md`** — the audit ledger (Sev1–Sev4), one `###` section per finding. **`I9` (Pomodoro broadcaster takeover) and `I18` (sidecar model-path sandbox) are accepted deviations** under the friends-only threat model — do not "fix" them without an explicit request. Its **Archive** section decodes the retired `IMPROVEMENTS.md` item IDs; that backlog and `BUILD-PROMPTS.md` (the historical V0→V3 build plan) were deleted once nothing in them was open — git history holds both.
- **`README.md`** / **`INSTALL.md`** — user-facing entry point (plus a Developing section) and install walkthrough.

If a request conflicts with PLAN / ARCHITECTURE / DESIGN-SYSTEM, surface the conflict; don't silently deviate.

### Comment shorthand used throughout the code

Inline comments cite compact tags instead of restating history. Decode them as:

- **`V1-P4` / `V2-P7` / `V3-P3`** — build phases from the original V0→V3 build plan (provenance only; the referenced behavior is described where the tag appears).
- **`I9`, `I16`, …** — entries in the `ISSUES.md` audit ledger.
- **`F6`, `U4`, `S2`, `A2`, `D1`, `R7`, `X4`, `N5`, …** — items from the retired improvement backlog, letter = section (F friend-finding/connection, U UI/UX/a11y, S session robustness, A AI quality, D data/identity/recovery, R stats/report, X release/distribution, N new features/lifecycle). Titles are indexed in `ISSUES.md` § Archive.
- **`PR-27`** — a finding from that pull request's review, addressed in code.

The tag is a pointer to the fuller story; the comment beside it should already carry what you need to edit safely. When you fix something traceable to one of these, keep the tag convention.

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
- **Compatibility surfaces are real now.** Local data persists across automatic and manual updates: SQLite schema migrations must be **forward-only and tested** (see `src-tauri/src/db/migrations/`), and peer **wire formats** + **identity derivation** are cross-version contracts — coordinate changes, don't break a friend's stored data or strand a peer on an older build. We still don't need web-scale compat shims for things never released.
- **The Linux runtime is a product-owned supply-chain surface.** Official distro WebKitGTK builds in the maintained path compile the `ENABLE_WEB_RTC` peer-connection binding out while retaining `navigator.mediaDevices`; do not “fix” Linux by linking the AppImage back to the host copy. Keep `scripts/linux-webkit-runtime.env`, `scripts/build-linux-webkit-runtime.sh`, `scripts/patches/webkitgtk-2.52.5-appimage-sandbox.patch`, its AppImage-relative WebKit-process/injected-bundle/sandbox-helper layout, the vendored wry constructor delta, `BUILD-MANIFEST.txt`, the 59-file readable/hash-addressed WebKit license inventory, the generated librice transitive notice pair, deterministic corresponding-source archive + checksum, and AppImage checks coherent. Keep the separate source-built AppImage type-2 runtime revision 2 tuple and its system-source evidence coherent too: exact type2/musl/zlib/decompression-only-zstd/libfuse/squashfuse/Meson sources and licenses, Noble compiler/linker/CRT provenance, build metadata, link map, and link-input hashes. It must remain an `x86_64-linux-musl` static PIE with no interpreter or dynamic dependencies, using musl mallocng and no mimalloc. A runtime bump means new verified hashes, license/source review, rebuilt source provision, packaged validation, and the PLAN §8 exact-AppImage physical matrix. The whole Linux leg builds on Ubuntu 24.04 because WebKit's librice ICE agent needs GStreamer's 1.22+ `GstWebRTCICE` base class while WebKit's own configure gate still accepts 1.20; that also sets the artifact's glibc 2.39 floor. Noble's own GStreamer 1.24.2 then breaks the final link — its `gst/webrtc/webrtc_fwd.h` has no `G_BEGIN_DECLS`, so C++ callers emit a mangled `gst_webrtc_error_quark()` that the C library cannot satisfy — and since upstream fixed that before 1.24.12 but Noble ships 1.24.2 in every pocket, the portability patch resolves that error domain by its documented quark name instead. Both GStreamer constraints are load-bearing: check them before changing the baseline. Pre-merge and preview compiles use a hash-pinned `sccache`; never add a compiler cache — or any other restored build state — to the tagged release leg, which must reconstruct the runtime from its verified tuple. The mutable Noble baseline is not bit-reproducible, the evidence is not legal sign-off, and distro security updates do not service the bundle.
- **Third-party notices are generated release inputs.** Keep `package-lock.json`, `Cargo.lock`, `scripts/third-party-notices-overrides.json`, `THIRD-PARTY-NOTICES.{txt,json}`, their `src-tauri/resources/` copies, and the base Tauri resource list coherent. Run `npm run generate-notices` only after reviewing dependency/license deltas, then `npm run check-notices`; do not hand-edit generated outputs or treat `cargo-deny`'s compatibility allowlist as notice/source delivery. The Linux WebKit builder separately runs `scripts/generate-librice-third-party-notices.mjs` against librice's own locked `rice-proto`/`rice-io` `capi` closure and packages its text/JSON pair. The explicit Wry/llama/font/victory-vendor and librice missing-file exceptions are version/hash bound, and the outputs are review evidence—not legal sign-off.
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
npm run check-migrations # forward-only SQLite migrations (hash manifest + registration)
npm run check-stories  # no new uncovered components; frozen baseline may only shrink
npm run check-notices  # locked Cargo/npm/llama notices + exact bundle-resource copies
npm run check-contrast # WCAG AA over both themes
npm run check-a11y     # axe-core over Storybook (needs `npm run build-storybook` first)
cargo test && cargo fmt --check && cargo clippy   # in src-tauri/, for Rust changes
cargo deny check       # in src-tauri/, supply chain (advisories/licenses/bans/sources)
```

Pre-commit (husky) enforces a subset automatically — `lint`, `check-tokens`, `check-strings`, `check-migrations`, `check-stories`, `format:check` (prettier repo-wide), `tsc --noEmit` (tsconfig.app.json), and the `cargo fmt --check` gate. The rest above (`build`, `test`, `check-contrast`, `check-a11y`, `cargo test`/`clippy`, `cargo deny`) are **not** in the hook — run them yourself before opening a PR. Before committing multi-file or subagent work, run `npm run format` (prettier --write .) so the whole tree is clean — `format:check` rejects files you didn't touch.

### What CI adds on top (pull requests)

Everything above runs in `.github/workflows/ci.yml`, plus checks that only make sense with a repository around them. Branch protection requires two checks: **`All pre-merge checks`** (the aggregator in `ci.yml`) and **`PR title`**. They are the only things a merge waits for — `Deployed` (`deploy.yml`) runs on every PR but is an indicator, never a requirement. Adding a job to `ci.yml` means adding it to the aggregator's `needs:` list too — the part you never have to touch again is the branch-protection rule, not the list. **`Linux AppImage startup smoke` is the one deliberate exception:** it compiles WebKitGTK from source, so it is excluded from the aggregator and reports its own advisory check rather than making every merge wait behind it. It still runs on every PR — read it, and do not merge Linux changes while it is red — and the release path is unaffected, since `release.yml` builds and smokes the exact AppImage before a draft can be published and PLAN §8's physical matrix stays mandatory. `PR title` is a separate workflow because it must listen for the `edited` activity type; putting that on `ci.yml` re-ran the whole suite against an unchanged commit and left a cancelled aggregator beside a successful one on the same SHA, which blocks the merge.

- **Workflow lint** — `actionlint` (+ shellcheck over inline `run:` blocks) and `zizmor`. `.github/zizmor.yml` encodes the pinning policy: GitHub-owned actions may float on a major tag, every third-party action must be hash-pinned. That is now enforced, not just documented.
- **Supply chain** — `dependency-review` fails on vulnerabilities *this PR adds* (the pre-existing backlog stays out of the way); `cargo-deny` runs advisories/licenses/bans/sources against `src-tauri/deny.toml`; the third-party-notice job fetches the three locked Cargo target caches and then regenerates the Cargo/npm/llama inventory offline; `npm audit` is advisory-only into the job summary, because it is red today (`ISSUES.md` I19).
- **Linux packaged runtime/startup** — Ubuntu 24.04, Rust 1.97.1, and
  `cargo-c` 0.10.24 build the hash-pinned WebKitGTK 2.52.5 + librice 0.4.3
  runtime and x86_64 AppImage. CI validates the exact artifact's native
  libraries/subprocesses, sandbox + build-manifest/license inventory, ELF links,
  packaged-only GStreamer WebRTC/SCTP elements, llama runtime, and a gnome-keyring Secret
  Service round-trip, then launches it under Xvfb and requires the first
  document's `runtime.webrtc ready` data-channel-offer record. The job is
  advisory on pull requests (excluded from the aggregator, since a merge should
  not wait an hour behind a WebKitGTK compile) and its steps are ordered so the
  cheap ones fail before that compile; `release.yml` repeats the whole thing
  against the exact shipped AppImage. This catches a
  missing or inert packaged backend; it does not exchange an `RTCDataChannel`,
  exercise a physical CachyOS KDE portal/media device, prove in-app identity
  custody, mount through FUSE, or apply an update.
- **Docs & copy hygiene** — `typos` (blocking, configured in `_typos.toml`) and a link check (advisory).
- **PR title** — conventional-commit shape, since PRs squash-merge into main's history. Own workflow (`pr-title.yml`); re-runs when the title is edited.
- **CodeQL** — `javascript-typescript`, `rust`, and `actions`, all build-mode `none`; it reports to the Security tab but is not one of the two required merge checks.
- **Weekly** (`maintenance.yml`) — OSV over both lockfiles, relay health, OpenSSF Scorecard. Never a PR gate: these go red without anyone committing anything.
- **Deployments** — `deploy.yml` deploys every commit that reaches a PR or main: real macOS arm64, Windows x86_64, and Linux x86_64 installers/AppImage built from that SHA, attached to the run for seven days. Checks are `Deploy scope`, one `Installer (…)` check per platform, and the `Deployed` rollup. **One GitHub Deployment per platform** — `preview-macos`, `preview-windows`, and `preview-linux` — is minted by the matrix job itself, because a matrix job's aggregate result cannot identify which platform failed. **`Deployed` is an indicator, not a gate** — a full build is ~30–60 min per platform, so nothing waits for it; merges wait on the two branch-protection checks above. It still goes red when a platform stops building, which is the point: look at it, act on it, don't sit and wait for it. Promoting it to required is a deliberate future call, not the current setup. For a commit touching only `*.md` / `.github/**` the installer job still runs but builds nothing (its steps are guarded, not the job — a matrix job skipped by a job-level `if:` reports its check under the literal unexpanded `${{ matrix.label }}`). The bundles carry no updater manifest and can never be consumed as an update. Storybook separately publishes to GitHub Pages from main (`pages.yml`) and rides along as a PR artifact from `ci.yml`.

Dependency bumps arrive via `.github/dependabot.yml` (npm, cargo, actions). It rewrites a SHA pin's trailing `# vX.Y.Z` comment only when the version is the **last** thing in the comment — keep it that way.

> If the pre-commit hook isn't firing (commits succeed with no gate output), `git config core.hooksPath` has drifted — run `npm run prepare` to reset husky to `.husky/_`.

> **Test-harness caveat.** Vitest runs in node-env with no RTL/jsdom; there are no `*.test.tsx` component tests. Storybook + axe cover static rendered accessibility for existing stories, not interaction behavior. Three older component-level exceptions (one UI primitive and two composed components) plus 33 older feature components remain an explicit frozen no-story baseline in `scripts/check-stories.ts`; new uncovered modules fail CI.

## Running the app

- `npm run tauri dev` — full desktop app (real surfaces). The npm script is `tauri`; there is no `tauri:dev` alias.
- `npm run dev` — Vite frontend only (fast UI iteration; Tauri APIs stubbed/absent).
- `npm run storybook` — component preview at http://localhost:6006. A dev-only primitive gallery is at `/style`.

On CachyOS/Arch, install the compiler/WebKit build prerequisites plus the Secret
Service and KDE portal/PipeWire runtime described in `INSTALL.md` before using
the full desktop loop. Host `webkit2gtk-4.1` is a development/link dependency,
not the production WebRTC runtime. Before `npm run build:linux`, run
`bash scripts/build-linux-webkit-runtime.sh`; the AppImage staging step rejects
a missing or stale runtime marker. A successful Linux compile is not evidence
that a data channel, camera, screen capture, key custody, or AppImage update
works in a physical desktop session.

## Stack at a glance

- **Tauri 2** + **React 19** + **Vite 8** + **Tailwind v4** + **shadcn/ui** + **TypeScript strict**.
- **trystero** (Nostr default) for P2P discovery; **@noble/ed25519** + **@scure/bip39** + **@noble/curves** + **@noble/ciphers** for crypto.
- **rusqlite** under Rust commands for the local DB.
- **llama-server** sidecar (llama.cpp build) for on-device AI inference, bundled per-platform via Tauri `externalBin`, started on demand.
- **WebKitGTK 2.52.5 + librice 0.4.3** private runtime for the Linux candidate,
  built from the exact hash tuple in `INSTALL.md`; Wry sets the WebRTC/media
  preference during native construction, and Rust handles only user-media
  requests while the current top-level URI is allowlisted. WebKitGTK does not
  expose the request's own origins here, so the self-only frame CSP is part of
  that boundary.
- **Trusted top-level navigation** is a Rust plugin shared by every desktop
  webview: only the exact platform app origin (plus port-1420 loopback in debug)
  may load in-app, while intended external links stay in the system opener.
- **Storybook** is mandatory for new primitive and feature components; the
  explicit legacy baseline in `scripts/check-stories.ts` may only shrink.

Versions and full justifications are in `ARCHITECTURE.md` §2.

## Repo layout (high level)

```
PLAN.md, ARCHITECTURE.md, DESIGN-SYSTEM.md   ← canonical specs
CHANGELOG.md, ISSUES.md, README.md, INSTALL.md
.github/     ← workflows, issue templates, SECURITY.md
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
scripts/     ← check-tokens / check-strings / check-contrast / check-migrations / check-stories, fetch/build-llama-server, generate-*
tests/       ← unit / integration / ai-eval (eval dataset + RESULTS.md)
```

Full layout in `ARCHITECTURE.md` §11.

## Releases

Releasing bumps the version in **five tracked files** (kept in lockstep): `package.json`, `package-lock.json` (two entries), `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` (the `studyvis` entry), `src-tauri/tauri.conf.json`. Two ways to cut one:

- **One-click:** the `Release prep` workflow (Actions tab, `.github/workflows/release-prep.yml`) bumps all five files, commits + atomically pushes `main` and a `vX.Y.Z` tag; that PAT-authenticated tag push triggers the release build. It needs the **`RELEASE_PAT`** secret — a fine-grained PAT scoped to this repo with Contents: read+write. `main` is protected by a ruleset requiring a PR plus the `All pre-merge checks` status check, and `GITHUB_TOKEN` cannot bypass that on a user-owned repo (Integration bypass actors are organization-only), so the bump commit is pushed with an owner PAT — the ruleset's one bypass actor is RepositoryRole 5 (admin). The gate job fails fast with that explanation if the secret is missing.
- **Manual:** bump the five files yourself, commit `chore(release): vX.Y.Z`, and push a `v*.*.*` tag — `release.yml` builds the macOS arm64, Windows x86_64, and Linux x86_64 artifacts as a **draft** GitHub Release to review and publish.
- **Publish:** after the draft verifier and the PLAN §8 physical CachyOS matrix
  pass, run **Publish verified release** (`publish-release.yml`) with the exact
  tag and the lowercase AppImage SHA-256 recorded by that matrix. Do not use the
  release-page publish button. The job runs through the
  `release` environment, queues behind the tag build, and fails closed unless
  the tag is on `main`, exact-commit CI succeeded, and the latest `release.yml`
  run with `head_branch` equal to that tag and `head_sha` equal to its commit
  completed successfully after the exact-AppImage runtime smoke. It also checks
  that the draft and release notes are intact and contains exactly the expected
  twelve assets. It downloads those exact assets, compares updater sidecars with
  `latest.json`, verifies their GitHub attestations against `release.yml` at the
  exact tag/commit, checks the physical-test AppImage digest, and re-downloads
  that AppImage for one final hash check immediately before publication. The
  tagged Linux leg creates and uploads both corresponding/system-source pairs only after
  its freshly built AppImage passes native inspection and the Xvfb
  data-channel-offer smoke; the final manifest is attested after aggregation.
  **Repository controls:** on 2026-08-15, `release` was configured with
  `scotej` as its required reviewer, the active `v*` tag rule restricts
  creation/update/deletion, and immutable releases were enabled. This
  sole-owner repository permits self-review; add an independent reviewer and
  enable self-review prevention for two-person approval. Its sole `Always`
  bypass entry must be
  `RepositoryRole 5` (admin), so the owner-scoped `RELEASE_PAT` can create the
  tag; do not add Write, Maintain, team, or integration bypasses. GitHub hides
  `bypass_actors` from the workflow's read-only ruleset response, so the gate
  verifies scope and rule types but an admin must verify the actor list.
  Workflow YAML cannot create these controls; re-verify them before any
  production publish.

Update `CHANGELOG.md` as part of the release. `package.json#version` flows through `__APP_VERSION__` into Settings → About automatically. Do not publish a draft unless `latest.json` contains `darwin-aarch64`, `windows-x86_64`, and `linux-x86_64`, both Linux source archives and checksum sidecars are present and verify, and the exact Linux AppImage has passed PLAN §8's physical CachyOS KDE Wayland matrix. That matrix requires an exchanged bidirectional data channel, Linux media send/receive, Linux AI capture, and physical same-draft Linux↔Linux, Linux↔macOS, and Linux↔Windows artifact pairs—not merely CI's local offer probe. It also covers FUSE/extraction launch, Secret Service, N-1 updater/relaunch with preserved data, packaged CPU-only inference, Linux `studyvis://` registration/import, KDE notification-settings launch, custom-chrome drag/window controls, the in-session Wayland hold-to-talk control, and the Settings Talk-to-AI fallback. Record the AppImage SHA-256, artifact/OS versions, direction, and result for every row. The external `release` environment/tag-ruleset/immutable-release blockers above remain independent gates.

## When in doubt

- Ask the user if the task is genuinely ambiguous.
- Otherwise: re-read the relevant canonical docs, call `advisor()`, then proceed.
