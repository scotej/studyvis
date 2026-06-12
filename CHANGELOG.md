# Changelog

All notable changes to StudyVis, grouped by version era. The product
was built in roughly three phases — V1 (study with friends, no AI),
V2 (on-device AI focus detection), V3 (polish + breadth) — described
in `PLAN.md`. Each build prompt landed as a single squash-merged PR;
the history below collapses to the user-facing story rather than the
per-PR ledger.

v1.0.0 through v1.0.3 shipped during V1 + V2 + the audit pass. The V3
polish phase landed in **v1.0.5** — the polished 1.0 `PLAN.md` set out
to build: feature-complete (V1's study-with-friends loop, V2's
on-device AI focus detection, V3's breadth + polish) and gated by the
success-criteria walkthrough in PR #40 (every V1 + V2 criterion
explicitly met-with-evidence or deferred-with-reason). **v1.1.0** and
**v1.2.0** followed with a feature pass and post-1.0 maintenance. (The
V3 work was drafted as v1.0.4 but shipped under the **v1.0.5** tag —
there is no v1.0.4 tag; the section below is labelled by the tag that
shipped it.)

## Unreleased — reliability, honesty, and quality-of-life pass

A broad maintenance + feature wave across eight clusters, drawn from the
`IMPROVEMENTS.md` backlog. Reliability of friend-finding and live
sessions, more honest AI and stats, safer identity error paths, new
notifications and custom pomodoro durations, a stricter accessibility
gate, and release/CI hardening. New outbound behaviour stays opt-in and
OFF by default; the one sanctioned outbound request is carved out in
PLAN §3.

### Added

- **Connection diagnostics + your own relays/TURN (Settings → Network).**
  A live per-relay status panel (state by glyph + text, never color
  alone) and fields to add your own signaling relay URLs and a TURN
  server without a new build — the one path through strict/CGNAT
  networks now that no public TURN ships.
- **Friends-list backup.** Export / Import friends to a sealed
  `.svfriends` file encrypted to your own key; import upserts. The
  recovery gap (24 words restore only the keypair) is now self-serve.
- **Focus insights (Stats).** A local, cross-session view of when
  distractions cluster, recurring reasons, and a focused-time trend —
  read from `audit_events` on-device, nothing transmitted.
- **File exports.** Save the post-session report (markdown), a raw
  per-session audit JSON, and a stats CSV of daily study minutes +
  partner counts.
- **Session history management.** Delete a single session
  (Settings → Sessions) or clear all history (Advanced), behind confirm
  dialogs; stats and the report follow.
- **Pomodoro break/work OS notifications** (opt-out, ON by default) and a
  gentle phase-transition chime (opt-in, OFF by default) — so a break
  boundary is visible while the window is in the tray.
- **"Friend came online" notification** (opt-in, OFF by default), honest
  about the ~60 s presence latency.
- **Custom pomodoro durations** (5–120 work / 1–60 rest) with a
  backward-compatible wire: explicit durations ride alongside a
  legacy-preset fallback, so a custom-split host never strands a friend
  on an older build.
- **Camera on/off toggle, audio-output picker, and a per-peer volume
  slider** in the session footer.
- **"Waiting for your friend" tile** when you're alone in a session, and
  per-peer connection states (connecting / failed) instead of a frozen
  offline tile.
- **Opt-in new-version check (Settings → About), OFF by default.** When
  on, a single unauthenticated GET to the public GitHub Releases API
  compares tags and shows a quiet update row; zero outbound while off,
  silent on failure. This is the one sanctioned outbound request beyond
  P2P + Nostr signaling — carved out in PLAN §3.
- **`studyvis://` deep link.** A pairing link now prefills (never
  auto-connects) the add-a-friend form; relaunching a tray-hidden app
  focuses the existing window (single-instance guard).
- **Quit confirmation during an active session.**

### Changed

- **Honest AI focus pipeline.** Malformed/empty model responses, and
  low-confidence off-task calls below the `off_task_confidence_floor`
  (default 0.6, with a Settings → AI slider), are now treated as
  _uncertain_ skips — they neither reset an off-task streak nor count
  toward focused-time %, instead of being fabricated as `on_task`. The
  benchmark and live request are built from one shared builder so the
  predicted cadence is achievable. A duration-based cadence backoff
  replaces the dangling "thermal-aware notice" (engages after 2 slow
  ticks vs the benchmark p95, recovers after 3 normal ticks). Model
  downloads resume from a surviving `.tmp` via HTTP Range.
- **Honest scores and labels.** AI-off sessions no longer persist a
  fabricated `score=100` — the report shows a calm no-score state and
  averages skip nulls. Stats' "Focused minutes" is renamed "Study
  minutes" so "Focused" stays the AI concept; the average-score tile
  says how many sessions it covers.
- **Legible connection failures.** The pairing dialog distinguishes
  "can't reach the network" (your side) from "your friend hasn't
  arrived"; an invite to an offline friend retries when they flip online
  (deduped) and reads differently from a relay-down failure; a
  best-effort goodbye flips presence offline near-instantly on quit.
- **Accessibility gate proves coverage.** `check-contrast` now scans
  `src/` for every text/bg/border token co-occurrence and fails on any
  pairing missing from the allowlist — not just that the listed pairs
  pass. Surfaced previously-unlisted real pairings, all AA-verified.
- **Always-visible invite button**, onboarding **Back** navigation, one
  CTA on the zero-friends empty state, and the SessionTimer presets now
  use the themed `RadioGroup` primitive.

### Fixed

- **Push-to-talk can no longer latch the mic open** — a dropped release
  event or a stale latch can never bring a fresh session's first audio
  track up live (a privacy defect); a stuck-key guard and per-session
  reset back it up.
- **Grace window before auto-ending.** A transient transport drop no
  longer ends a long session instantly — a 20 s grace window cancels on
  any rejoin.
- **Corrupt-identity and corrupt-DB safety.** An unreadable
  `identity.json` routes to a calm Retry/Restore screen and can never be
  steered into new-identity onboarding that clobbers keychain keys; a
  corrupt `app.db` is set aside and recreated with an explanatory dialog
  instead of a startup panic; a DB written by a newer build is refused
  distinctly. Recovery now skips the overwrite warning when you re-type
  the same 24 words and preserves your display name.

### Release / CI

- **CI-green gate before release.** `release-prep` runs lint, test,
  build, check-tokens, check-strings, and `cargo fmt --check` before any
  version bump, tag, or push lands on `main`; `check-strings` also runs
  in `ci.yml`.
- **macOS ad-hoc signing** (signing identity `-`, hardened runtime off)
  softens first-run Gatekeeper friction to the milder "unverified
  developer" prompt. The dormant `tauri-plugin-updater` dependency was
  removed (re-add checklist in PLAN §8).

## 1.2.0 — 2026-06-07 — post-1.0 fixes and feature improvements

A maintenance and feature pass on top of the 1.0 line: audit-verified
bug fixes across the session, AI, and Rust layers, plus four feature
improvements.

### Added

- **Share log (Settings → Advanced).** The manual share `PLAN.md` §3
  promised, previously only a folder opener. "Open log" reveals
  `llama-server.log` in your file manager; "Copy diagnostics" copies
  your version, OS, and log path. Local-only — nothing is uploaded.
- **Bounded diagnostic log.** `llama-server.log` now rolls to
  `llama-server.log.1` at ~5 MB at the start of an AI session, so it
  stays small and shareable. Resolves the deferred D7 rotation.
- **Copy session report.** The post-session report has a "Copy report"
  button that puts a plain-text summary on the clipboard to paste to
  the friends you studied with. Local-only, no peer broadcast.
- **Breaks in the report.** The report now summarises approved breaks
  per person — count and total time.

### Fixed

- **TURN preference applies to sessions.** Settings → Network's relay
  setting now affects study sessions, not just friend pairing.
- **Audit log keeps departed friends' names.** In 3+ person sessions a
  friend who leaves no longer has their earlier rows relabelled to a
  key fragment.
- **Push-to-talk reliability.** PTT no longer goes silently dead after
  a mid-hold camera/mic reacquire, and a friend who joins while you're
  talking now sees your talk indicator.
- **Pomodoro Stop is broadcaster-only.** Receivers no longer see a
  no-op Stop button the next broadcast tick would undo.
- **AI cadence respects slow models.** The sample interval can no
  longer be capped below a model's measured floor.
- **Backend hardening.** SQLite busy-timeout so a concurrent
  first-launch serialises instead of failing; duplicate push-to-talk
  accelerators no longer abort boot; the llama-server sidecar is
  reliably killed on quit instead of orphaned; failed model downloads
  clean up their partial temp file; disabling AI closes an open
  Ctrl/Cmd+] dialog.
- **UI and accessibility.** A re-opened session report no longer nests
  a second `main` landmark; the titlebar resize listener no longer
  leaks; the audit log pins to the newest row without a one-frame jump.

## 1.1.0 — 2026-06-06 — Pairing QR redesign

### Changed

- **Pairing QR redesign (#42).** Reworked the add-a-friend pairing
  surface and its QR-code presentation for a calmer, clearer exchange
  of the one-time 12-word code.

## 1.0.5 — 2026-05-31 — V3 polish, the polished 1.0

The release that lands the V3 phase (shipped under the v1.0.5 tag;
v1.0.4 was drafted but never tagged). Carries V1 + V2 + V3 in one
installer. See
"Friends-only unsigned" install notes in `INSTALL.md` and the
user-facing tour in `README.md`.

### Release hardening (cut into v1.0.5)

- **Session UX recovery.** Camera/mic errors recover with clear copy
  and a retry; a persistent AI status indicator and labelled footer
  timers; leaving a session now requires confirmation on Esc; the
  self-warning and break badges no longer fight for one slot.
- **Onboarding critique resolved** — control, privacy, a11y, layout,
  and polish fixes across the onboarding flow.
- **Accessibility.** Focus states differentiated beyond color;
  `PttIndicator` note corrected; `aria-describedby` on audit rows.
- **Release pipeline.** Dropped the macOS Intel build target; releases
  are marked prerelease until reviewed.

### V3 — polish and breadth

- **V3-P1 — Stats dashboard.** Settings → Stats. Daily focused
  minutes (last 30 days), current streak, average AI score across
  scored sessions, top study partners. Computed on-device from the
  local sessions + friends tables; nothing transmitted. Empty / no
  scored sessions / no partners states all read in voice.
- **V3-P2 — Identity recovery from a 24-word backup.** Onboarding's
  Identity step forks into "Create a new identity" or "I have a
  24-word backup". Type the words; the same Ed25519 + X25519 keypairs
  derive deterministically on the new machine. Your friends list does
  not come with the identity — you re-pair, by design (the friends
  list lives in the lost device's SQLite).
- **V3-P3 — Custom keybindings UI.** Settings → Shortcuts lets you
  rebind both global shortcuts (push-to-talk for friends; Talk to
  AI). The capture surface validates against reserved combos per
  platform, refuses bare keys, and emits a calm conflict line if you
  try to bind the same combo to both actions. Defaults match
  `DESIGN-SYSTEM` §17 (Cmd+[ / Ctrl+[ and Cmd+] / Ctrl+]).
- **V3-P4 — Multi-monitor capture toggle.** Settings → AI → Capture
  displays. "Primary only" (V2 default) or "All displays" — the
  latter composites every monitor into one image at session start.
  The OS share picker runs once per monitor at session start;
  changes between primary and all apply on the next session (no
  mid-session prompt regression).
- **V3-P5 — Light + auto theme polish.** Three modes: Dark, Light,
  Auto (follow system). Same hues, every text/background pairing
  re-tuned until it clears WCAG AA on both canvases. Verified by
  `scripts/check-contrast.ts` over 42 pairings × 2 themes.
- **V3-P6 — Custom frameless window chrome (opt-in).** Settings →
  Appearance → Window style → Custom. Adds a 38-px chrome band with
  the studyvis wordmark and platform-correct controls (macOS reserves
  the left inset for the system traffic lights; Windows paints its
  own min/restore/close cluster). Native chrome is the default; the
  toggle is honest about needing a relaunch.
- **V3-P7 — Accessibility pass + app-wide reduced motion.** Full
  keyboard navigation walk, screen-reader labels on every interactive
  surface, axe-core a11y gate over every Storybook story
  (`npm run check-a11y`). Reduce motion (Settings → Appearance) is a CSS
  `[data-reduce-motion='true']` kill switch in `@layer base` — every
  transition and animation collapses to ~1ms automatically, so new
  motion sites are gated by default. Pre-paint via inline script in
  `index.html` + `ai-dialog.html` so the first paint has no flash.
- **V3-P8 — Design cohesion & copy pass.** Every user-facing string
  centralised into `src/strings.ts` (single locale; not i18n);
  `scripts/check-strings.ts` guards toast + notification surfaces
  against drift. Voice rewritten to `DESIGN-SYSTEM` §14 throughout —
  contractions ("Couldn't" not "Could not"), periods on full
  sentences, none on labels. shadcn Dialog / Sheet / Popover /
  Tooltip / DropdownMenu motion finally real (installed
  `tw-animate-css`; durations point at the §6 named tokens). Vendored
  a `Skeleton` primitive and migrated five hand-rolled
  `animate-pulse` blocks. Report's full-screen error sink became an
  inline calm banner + Retry per §10. Recharts auto-animation off.

### Mid-release polish (within V3, before V3-P9)

- "Cozy honey" warm palette retheme — replaced the V1-baseline cool
  greys + amber with the warm-honey canvas that `DESIGN-SYSTEM` §1
  now describes as "Calm Dark — Linear × Things 3, warm not
  corporate".
- Per-arch macOS DMGs — the release workflow builds `aarch64` and
  `x86_64` separately rather than producing a universal binary,
  because the llama-server sidecar is per-arch.
- Audit pass (`audit/sev1-sev2-fixes` then `audit/sev3-sev4-fixes`)
  closed Sev1 → Sev3 findings. See `ISSUES.md` for the full ledger;
  I9 (Pomodoro broadcaster takeover) and I18 (sidecar model-path
  sandbox) were surfaced and accepted as deliberate deviations.
- Settings panel macOS scaling fix, AI model-download reachability
  fix on macOS, layout unification through design tokens, human-voice
  pass on shipped copy ahead of V3-P8.
- A localisation-style "no user-facing em dashes" sweep — the long
  dash is a writer's tic; copy reads more like a friend wrote it
  without one.

### V2 — AI accountability

- **V2-P1 — llama-server sidecar.** Tauri spawns `llama-server`
  (llama.cpp build) bundled per platform, listening on a random
  localhost port. Lifecycle (start, health-poll, restart-budget,
  stop) lives in `useSidecarStore`; the binary is launched only when
  AI features are on and a model is picked.
- **V2-P2 — Model picker + benchmark.** First-run shows 3 model
  tiers (Moondream2 / Qwen2.5-VL-3B / Gemma 3 4B as defaults). The
  picker downloads model + projector files together, verifies
  SHA-256, runs a 30-second benchmark, and pins
  `sample_interval = max(5s, p95 + 1s)`. The Gemma tier is gated by
  Hugging Face terms; paste an HF token (stored in the OS keychain)
  once.
- **V2-P3 — Capture pipeline.** `getUserMedia` (face frame) + a
  separate `getDisplayMedia` (screen frame) running in parallel only
  for the AI loop. Each frame downscaled — 384×384 JPEG for the
  face, 1024-wide JPEG for the screen — and posted to llama-server's
  OpenAI-compatible endpoint with the declared topic. Frames are
  never sent to peers. The macOS screen-recording permission
  overlay routes the user to System Settings → Privacy & Security →
  Screen Recording with platform-correct steps.
- **V2-P4 — System prompt + eval harness.** The focus-detection
  system prompt (`features/ai/systemPrompt.ts`) is locked behind
  `FOCUS_SYSTEM_PROMPT_VERSION` so we can hand-iterate without
  drifting silently. A 20-case labelled eval set lives in
  `tests/ai-eval/dataset/` — 8 on-task screenshots, 3 mild, 3
  moderate, 3 blatant, 3 prompt-injection attempts. The runner
  (`tests/ai-eval/run.ts`) writes per-prompt-version scores into
  `RESULTS.md`.
- **V2-P5 — Sample loop + score machine.** The pure sample loop
  ticks at the benchmark-derived interval, skipping if the previous
  inference is still in flight (never queues). The score machine
  maps `on_task | mild | moderate | blatant` to deductions (0 / -2 /
  -5 / -15), with the "two consecutive samples before warning, two
  more before peer alert" thresholds.
- **V2-P6 — Self-warning + peer alerts.** First 2 consecutive
  off-task samples surface a private self-warning badge (the user
  only). Next 2 broadcast a signed `ai_alert` event to peers via the
  WebRTC data channel; peers see the alert tone + the model's
  one-line reasoning, never the raw frames. Scores stay private
  until the post-session report.
- **V2-P7 — AI dialog + break handling.** Ctrl/Cmd + ] opens a
  floating, always-on-top, transparent Tauri window. Type "5 min
  water break" — the AI agent classifies the intent (topic-change /
  break-request / question / unknown) and the deterministic rule
  layer in `features/session/break.ts` is the final arbiter
  (cool-down ≥25 min between breaks, ≤10 min per break clamp,
  ≤4 breaks per session). Approved breaks pause sampling, score
  deduction, and emit a `break_approved` audit event.
- **V2-P8 — Audit events + post-session report.** Every join,
  leave, topic change, warning, alert, break request / approval /
  denial is signed and persisted to local SQLite. The Report screen
  reads from SQLite (so re-opening from Settings → Sessions is
  byte-identical to the fresh-session-end view): score gauge with
  spring-easing reveal, topic timeline, per-peer event timeline,
  top distractions.
- **V2-P9 — AI gate + migration + topic declaration.** Settings →
  AI master toggle. When AI is on, a session must declare a topic
  before it goes live (`TopicGateModal` runs once before
  `hostSession` / `joinSession`). Migration 002 ships the schema
  forward without losing V1 data. The mid-session Ctrl+] topic-
  change path mutates `declaredStudyTopic` and emits a
  `topic_change` audit event.

### V1 — Study with friends, no AI

- **V1-P1 — Project scaffold.** Tauri 2 + React 19 + Vite 8 +
  Tailwind v4 + TypeScript strict + shadcn/ui + rusqlite. Single-
  instance check; `path::data_dir()` for the keypair file; system
  tray scaffolding.
- **V1-P2 — Design system foundation.** `src/design/tokens.ts` as
  the single source of truth (color, font, spacing, radius, shadow,
  motion, z-index, sizes). `scripts/check-tokens.ts` enforces it on
  pre-commit (no raw hex, no raw cubic-bezier, no arbitrary
  bracket-px). Storybook + the axe-core a11y gate set up here.
- **V1-P3 — Identity creation.** 24-word BIP39 mnemonic shown once.
  Ed25519 + X25519 keypairs derived from one master seed via
  HKDF-SHA256. Private keys in the OS keychain; public keys + display
  name + creation timestamp in `identity.json`. The "I've saved them"
  confirmation gates the Continue button.
- **V1-P4 — SQLite + friends store.** `rusqlite` behind Tauri
  commands (frontend never opens DB handles). The friends table
  carries `ed_pubkey_hex`, `x_pubkey_hex`, `display_name`,
  `paired_at`, `last_studied_with`.
- **V1-P5 — Trystero pairing.** The 12-word one-time pairing flow:
  generate words → both peers derive `pair_topic` +
  `pair_password` → trystero finds the rendezvous on Nostr →
  signed `hello` exchange proves both pubkeys came from the same
  party who knew the secret → save to SQLite → discard the words.
- **V1-P6 — Friends list + inbox + invite.** The always-on inbox
  topic subscription. Encrypted invite envelopes via NaCl box.
  Toast + OS notification on incoming invite. Online / offline
  presence per friend (derived from per-friend presence channels).
- **V1-P7 — Tray + autostart + shortcuts.** System tray "Open
  StudyVis" / "Quit". `tauri-plugin-autostart` for opt-in launch at
  login. `tauri-plugin-global-shortcut` registers `Ctrl/Cmd + [`
  (PTT for friends) and `Ctrl/Cmd + ]` (Talk to AI) at the OS
  layer.
- **V1-P8 — Session room + WebRTC mesh + PTT.** Trystero's
  signaling builds the full-mesh WebRTC topology (≤4 peers).
  Default-muted; holding the PTT shortcut unmutes the local audio
  track while held. Per-tile presence dot + name overlay.
- **V1-P9 — Audit log + Pomodoro.** Signed audit events over the
  WebRTC data channel (`joined`, `left`, `paused_break`,
  `resumed`, `pomodoro_start`, `pomodoro_end`). Pomodoro
  broadcaster sync — one peer drives the timer, all peers receive
  phase ticks every 5s; broadcaster disconnect triggers a 10s
  hand-over to the next-oldest peer.
- **V1-P10 — Onboarding.** Welcome → permissions → identity →
  display name → add first friend (skippable) → tutorial. Each step
  honours the `OnboardingStep` progress dots + primary/secondary
  action shell.
- **V1-P11 — Settings panel.** The left-rail / right-pane shell
  with categories: Identity, Friends, Sessions, Stats (added in
  V3-P1), Appearance, Notifications, Shortcuts, AI (added in V2),
  Network, Advanced, About.
- **V1-P12 — Friends-only unsigned installers.** macOS `.dmg`
  (ad-hoc signing only — friends right-click → Open the first time),
  Windows `.msi` (unsigned — SmartScreen → Run anyway). Release
  workflow triggers on `v*.*.*` tags; no auto-update plugin.

### V0 — Pre-flight

A 30-minute throwaway Tauri test app verified that the webview
could do `getUserMedia` and `getDisplayMedia` on macOS and Windows,
and that two instances could rendezvous on a trystero room. Linux
WebKitGTK was the open question; Linux deferred to V3.

## What's intentionally not in 1.0

See the matching section in `README.md`. Briefly: Linux installers,
signed installers + auto-update, additional theme variants (sepia /
high-contrast), AI-weighted focused-minutes, a tile-alert-duration
control, a rolling 2-hour break window, the `sessions.breaks_taken`
column, dropping the unused V2 `models` table, `llama-server.log`
rotation, expanding the `/style` dev route to the composed component
layer (Storybook covers it instead), the
`LEGACY_THEME_LOCALSTORAGE_KEY` cosmetic rename, and the boot-paint
script extraction. Each is recorded with the reason it didn't make
1.0.

Audit-ledger items `I9` (Pomodoro broadcaster takeover) and `I18`
(sidecar model-path sandbox) are accepted deviations under the
friends-only threat model and the "advanced users can point at any
local GGUF" promise. Not reopened.
