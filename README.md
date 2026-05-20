# StudyVis

A peer-to-peer desktop study app for close friends. Body-doubling
accountability with on-device AI focus detection. Local-first, no
servers we run, nothing about you leaves your machine.

You start a session, your friends join over video, and you keep each
other on task by being seen working. Turn on the optional AI and the
app watches your camera and screen on the same machine — nothing
streams anywhere — and gently nudges you when you drift off-topic.
After the session, each of you sees a quiet report of how the time
went.

This is 1.0. It runs on macOS and Windows.

## What running StudyVis means

A few honest disclosures, in the spirit of "no surprises":

- **A tray icon and a quiet background presence.** Once you launch
  StudyVis (and especially if you let it autostart at login from
  Settings → Advanced), it stays in the system tray so friends can
  invite you to study without you having to find and open the app
  first. Right-click the tray icon to quit fully.
- **One long-lived encrypted WebSocket** to a public Nostr relay
  while you're idle. That's the channel friends use to send you
  invites. The traffic is small — kilobytes per hour — and the relay
  cannot read it.
- **WebRTC during a session.** Audio and video go directly
  peer-to-peer when your network allows it. On strict corporate or
  school networks, traffic relays through a public TURN server (Open
  Relay) which only sees encrypted bytes. About 15% of network
  configurations land on the relay path.
- **Camera and microphone permission** are requested the first time
  you join a session. They live with the OS, not with StudyVis — you
  can revoke them in your OS privacy panel any time.
- **Screen-recording permission** is only requested when you turn the
  AI on. While the AI is sampling, your OS's screen-recording
  indicator stays lit for the whole session. That's expected — it
  turns off when you leave the session. On macOS the toggle lives in
  System Settings → Privacy & Security → Screen Recording; StudyVis
  can open that pane for you when needed.
- **Zero outbound data beyond the above.** No telemetry, no crash
  uploads, no analytics. If something goes wrong, share the log file
  manually (Settings → Advanced → Open data folder).

## Install

Friends-only unsigned installers. Each OS warns the first time you
run; the steps below clear those warnings. The OS remembers your
decision afterwards. See [`INSTALL.md`](./INSTALL.md) for the full
walkthrough.

**macOS (Apple Silicon + Intel)** — download the `.dmg` matching your
Mac's chip from
[Releases](https://github.com/scotej/studyvis/releases). Drag StudyVis
into Applications. **Right-click** the app icon and choose **Open**
the first time; macOS asks once, then remembers. The right-click is
load-bearing — double-clicking will refuse.

**Windows 10 / 11** — download the `.msi` from
[Releases](https://github.com/scotej/studyvis/releases). Double-click
to install. SmartScreen will warn ("Windows protected your PC") —
click **More info** → **Run anyway**. StudyVis lands in your Start
menu.

**Linux** — not in 1.0. WebKitGTK's `getDisplayMedia` support was not
validated; Linux returns when the V0 sanity pass is re-run on it. If
you want to try the dev build today, clone the repo and run
`npm run tauri dev`.

There is no auto-update. Re-run the install for a new version.

## First run

1. **Welcome.** A quick intro screen — nothing to enter.
2. **Permissions.** Camera, microphone, OS notifications. You can
   skip any of them and grant later in your OS privacy panel; nothing
   gets surreptitiously retried.
3. **Identity.** StudyVis generates a fresh keypair and shows you a
   24-word recovery phrase. **This phrase is shown once.** Write it
   down on paper. If you lose this laptop without the phrase, friends
   will see you as a new identity — there is no centralised account
   recovery.
   - Already have a phrase? Choose **I have a 24-word backup** on the
     identity screen and type it in. The same keys come back on this
     device; your friends list does not (you'll re-pair).
4. **Display name.** Pick anything — your name, a nickname, an emoji.
   Friends see it next to your tile. Change it any time in
   Settings → Identity.
5. **Add a friend (or skip).** You and a friend each tap **Add
   friend**, generate a one-time 12-word code, paste each other's
   code, and you're paired. Send the code over any chat app — once
   used it's discarded.
6. **Tutorial.** Three sentences on how a session works. Optional.

Once you're past onboarding you land on your friends list. Click an
online friend, click **Invite**, they accept, and you're in a session
together.

## Where your data lives

Everything that identifies you or remembers your sessions stays in
the OS user-data directory:

- **macOS** — `~/Library/Application Support/com.studyvis.app/`
- **Windows** — `%APPDATA%\com.studyvis.app\`

Inside:

- `identity.json` — your public key + display name + creation
  timestamp. Private keys are in the OS keychain (macOS Keychain /
  Windows Credential Manager), not in this file.
- `studyvis.db` — local SQLite with your friends list, session
  history, and audit log per session. Used for the post-session
  report and the Stats dashboard.
- `models/` — AI model files you've downloaded (V2 features). Each
  model is 1–8 GB depending on the tier you picked.
- `llama-server.log` — diagnostic log for the AI sidecar. Not
  rotated; truncate manually if it grows beyond what you want.

You can open the data folder from Settings → Advanced.

## How AI features fit in

Disabled by default. Settings → AI to turn on. The first time you
enable it, StudyVis asks for screen-recording permission and offers
you a model picker — three tiers between fast/small and slow/thorough,
with measured speed on your machine after a 30-second benchmark.
Models download from Hugging Face directly to your computer; the
"gated" tier (Gemma) needs a one-time HF token paste, stored in your
OS keychain.

During an AI session:

- StudyVis captures one frame of your camera and one frame of your
  screen every few seconds (the picker's measured cadence; you can
  slow it down in Settings).
- The local model classifies "on task", "mild", "moderate", or
  "blatant" off-task. Friends never see frames — only a flag and the
  model's one-line reasoning.
- Two consecutive off-task samples surface a private warning to just
  you. Two more in a row broadcast an alert to your friends and
  deduct from your session score.
- You can ask for breaks with Ctrl/Cmd + ] — type "5 min coffee
  break" in the floating dialog. The model recommends approve or
  deny, the rule layer is the final arbiter (cooldown, cap, quota).

The model runs only on your machine. Camera and screen pixels never
go to peers.

## Friends-only trust model

This product is built for groups of 2–4 friends who already know
each other. We do **not** defend against actively malicious peers.
Specifically:

- A friend can disable their own AI locally; their score will read
  "AI off" to the others. There is no anti-cheat.
- A friend can fudge or fake their own focus score. The score is
  self-reported.
- A friend who learns your public key can spam your inbox topic.
  StudyVis silently drops messages from non-friends after a cheap
  signature check; bandwidth is the only cost.

The threat model assumes social trust. If you wouldn't share your
laptop screen with these people for half an hour, they're not the
right friends for StudyVis.

## Reporting problems

There is no built-in error reporter — that would imply telemetry.
Instead:

1. **Settings → Advanced → Open data folder** to find
   `llama-server.log` (AI errors) and the OS-provided webview console
   if you can dump it.
2. **File an issue on GitHub** with the version (Settings → About),
   your OS + version, and a paste of the relevant log lines.
3. **Crash logs** stay local — macOS routes them to
   `~/Library/Logs/DiagnosticReports/StudyVis*`, Windows routes them
   to Event Viewer. Share manually if asked.

## What's intentionally not in 1.0

These are decisions, not oversights. Each entry names the reason and
where you'd see it surface.

- **Linux installers.** WebKitGTK's `getDisplayMedia` support was
  never validated; the V0 sanity pass deferred Linux. Returns when
  that pass runs again. (PLAN §5, V3.) Includes the Linux keyring
  `sync-secret-service` feature and any Linux-side
  `identity_box_decrypt` hardening.
- **Signed installers + auto-update.** No code-signing credentials.
  macOS notarization, Windows code-signing, and the
  `tauri-plugin-updater` re-enable all wait for a Developer ID and an
  EV cert. Today, friends right-click → Open on macOS and click
  through SmartScreen on Windows.
- **Sepia / high-contrast theme variants.** Dark + light + auto are
  the V3 set. Additional themes are a small-but-not-zero token-pair
  - contrast effort that didn't make 1.0.
- **AI-weighted focused minutes.** The Stats dashboard shows total
  session minutes ("focused minutes = `session.total_minutes`",
  isolated in `focusedMinutesForSession()`). Weighting by the
  per-sample AI judgement would require a stored per-session histogram
  the audit log doesn't keep verbatim. Documented as a 1.0 design
  choice; not a bug.
- **A tile-alert-duration setting** (`PEER_ALERT_TTL_MS` /
  `WARNING_TTL_MS` exposed as a control). The current 30s / 5s
  constants are working well in practice; surfacing a user control
  for them is a small new feature, not 1.0 work.
- **Rolling 2-hour break window.** The break-rule layer caps at "4
  breaks per session" rather than a 2-hour rolling window. No
  in-the-wild evidence the current rule frustrates anyone.
- **`sessions.breaks_taken` column on the post-session report.**
  Schema + new rendering. The audit-log timeline in the report
  already shows each break, with its duration and reason.
- **A `models` table migration drop.** `src-tauri/src/db/migrations/
002_v2.sql` declares a `models` table that nothing reads or writes
  (the frontend persists model records in
  `models.json`/`modelStore`). Dropping it would be trivially safe
  but a forward-only migration carries the V1→V2 upgrade-test risk we
  declined at the gate. Stays as a no-op artifact.
- **`llama-server.log` rotation.** The AI sidecar writes diagnostic
  logs without size or daily rotation. Most friends won't run AI
  enough for it to matter; rotate or truncate manually if it does.
- **Accepted deviations from the audit ledger.**
  - **`ISSUES.md` I9** — the Pomodoro broadcaster takeover allows any
    peer mid-broadcast to become the next broadcaster. Friends-only
    threat model accepts this; the alternative (locking the first
    broadcaster) would regress the documented disconnect-then-resume
    behaviour. Recorded as accepted, not a bug.
  - **`ISSUES.md` I18** — the AI sidecar trusts the JS-side
    `model_path` argument (no on-disk sandbox to a specific
    directory). PLAN §5 explicitly promises "advanced users can point
    at any local GGUF"; locking the path would break that. Accepted.
- **Strings-module guard scope.** `scripts/check-strings.ts` covers
  the surfaces that historically drifted (toast +
  `sendNotification`). JSX text and `aria-label` literals were
  hoisted manually by V3-P8 but are not exhaustively guarded; the
  second pair of eyes (manual review or Storybook a11y) is the
  remaining safety net.
- **`/style` route exhibits `ui/` primitives only.** The composed
  layer (VideoTile, AuditLogPanel, ScoreGauge, AI dialog, …) lives in
  Storybook stories instead. The Storybook a11y gate (`npm run
check-a11y`) covers every composed component.
- **`LEGACY_THEME_LOCALSTORAGE_KEY` keeps its V1-P11 name.** The
  constant correctly scopes the pre-paint boot cache for theme /
  windowStyle / reduceMotion, but the name suggests "deprecated"
  more than it should. Cosmetic rename only; post-1.0.
- **Boot-paint script extraction.** Three nearly-identical inline
  pre-paint scripts in `index.html` + `ai-dialog.html` for theme +
  windowStyle + reduceMotion. Moving them to a `/public/boot-paint.js`
  shared file would add a fetch hop on the critical pre-paint path
  even when synchronous. The duplication is the intentional choice
  for first-paint speed.

## Architecture, in one minute

- **Tauri 2** desktop shell — native WebView per OS, Rust on the
  back. ~10 MB installer per platform.
- **React 19 + Vite 8 + Tailwind v4 + shadcn/ui** for the UI. One
  design-token file (`src/design/tokens.ts`) is the only place colors
  / spacing / motion values live. Two-layer component split:
  `src/components/ui/` is the only place Radix primitives are
  allowed.
- **trystero (Nostr default)** for peer rendezvous over public
  relays. WebRTC mesh (max 4 peers) for media + an encrypted data
  channel for audit events.
- **@noble/ed25519 + @noble/curves + @scure/bip39** for identity.
  Two keypairs (Ed25519 for signing, X25519 for NaCl-box invite
  envelopes), both deterministically derived from one 24-word BIP39
  mnemonic.
- **rusqlite** for local persistence (friends, sessions, audit log).
- **llama-server (llama.cpp build) sidecar** for V2 vision-model
  inference. Bundled per platform, started on demand.

`PLAN.md`, `ARCHITECTURE.md`, `DESIGN-SYSTEM.md`, and
`BUILD-PROMPTS.md` are the canonical specs. Each canonical doc is
the source of truth for its concern; this README is the
user-facing entry point.

## Versioning

1.0.x is the running release series. The internal counter moved
through 1.0.0–1.0.3 during build-prompt iteration before any version
was released; 1.0.4 is the first version pushed as a tagged release.
The version number lives in (and must stay consistent across):

- `package.json` — npm root
- `package-lock.json` — npm lockfile (two spots: top-level + the
  studyvis package node)
- `src-tauri/Cargo.toml` — Rust crate
- `src-tauri/Cargo.lock` — Rust lockfile (the `studyvis` package
  entry only; other registry crates that happen to read 1.0.x are
  unrelated)
- `src-tauri/tauri.conf.json` — Tauri bundle metadata (drives
  installer version)

The Vite build pipes `package.json#version` through `__APP_VERSION__`
into Settings → About, so the About screen tracks the npm version
automatically.

## License

UNLICENSED (private; friends-only distribution). Source available on
GitHub for transparency and re-pairing.
