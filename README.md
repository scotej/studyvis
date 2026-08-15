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

This is the 1.x release line. The current release runs on macOS and Windows;
the next release candidate adds x86_64 Linux AppImage support. CachyOS with
KDE on Wayland is the reference Linux desktop for its required sign-off.

## What running StudyVis means

A few honest disclosures, in the spirit of "no surprises":

- **A tray icon and a quiet background presence.** Once you launch
  StudyVis (and especially if you let it autostart at login from
  Settings → Advanced), it stays in the system tray so friends can
  invite you to study without you having to find and open the app
  first. Right-click the tray icon to quit fully.
- **A handful of long-lived encrypted WebSockets** to a small curated
  set of public Nostr relays — plus a few public MQTT brokers raced as
  a second transport — while you're idle. That's the channel friends
  use to send you invites. The traffic is small — kilobytes per hour —
  and neither the relays nor the brokers can read it.
- **WebRTC during a session.** Audio and video go directly
  peer-to-peer. This works on most home networks. Some networks
  (corporate firewalls, strict NATs, locked-down school Wi-Fi) block
  direct connections — about 15% of setups — and those sessions can
  fail to connect. StudyVis ships with no relay fallback today; to get
  through such networks you can add your own TURN relay in Settings →
  Network (it only ever sees encrypted bytes).
- **Camera and microphone permission** are requested the first time
  you join a session. They live with the OS, not with StudyVis — you
  can revoke them in your OS privacy panel any time.
- **Screen-recording permission** is requested when you share a screen
  or turn the AI on. While the AI is sampling, your OS's
  screen-recording indicator stays lit for the whole session. That's
  expected — it turns off when you leave the session. On macOS the
  toggle lives in System Settings → Privacy & Security → Screen
  Recording; StudyVis can open that pane for you when needed. KDE
  Wayland presents its own desktop-portal picker and requires a working
  `xdg-desktop-portal-kde` + PipeWire session.
- **Zero outbound data beyond the above.** No telemetry, no crash
  uploads, no analytics. One exception: auto-update (Settings → About,
  ON by default) fetches the release manifest from GitHub and downloads
  new versions. Those requests are unauthenticated and carry no
  identifiers and no payload — nothing about you, your friends, or your
  sessions. Turn the toggle off to stop update checks/downloads; the disclosed
  signaling sockets, WebRTC traffic, and user-initiated AI downloads are
  separate. If something
  goes wrong, download a diagnostics archive from the fresh post-session
  report or Settings → Advanced. The archive is created locally and is
  never uploaded by StudyVis; you decide whether and where to share it.

## Install

Friends-only downloads. macOS and Windows warn on first launch because
their installers lack commercial OS code signing; the steps below clear
those warnings. The Linux candidate runs from its AppImage without a system
installer.
See [`INSTALL.md`](./INSTALL.md) for the full walkthrough.

**macOS (Apple Silicon)** — download the `aarch64` `.dmg` from
[Releases](https://github.com/scotej/studyvis/releases) (Apple Silicon
only; Intel Macs aren't in the release matrix). Drag StudyVis into
Applications. **Right-click** the app icon and choose **Open** the
first time; macOS asks once, then remembers. The right-click is
load-bearing — double-clicking will refuse.

**Windows 10 / 11** — download `StudyVis_<version>_x64-setup.exe` from
[Releases](https://github.com/scotej/studyvis/releases). Double-click
to install. SmartScreen will warn ("Windows protected your PC") —
click **More info** → **Run anyway**. StudyVis lands in your Start
menu. **Upgrading from v1.4.0 or earlier?** Those shipped as an
`.msi`; uninstall the old StudyVis from Settings → Apps first, or
Windows lists two copies. Your data is untouched. (This is a one-time
step — from v1.5.0 on, updates are automatic.)

**Linux (x86_64, next release candidate)** — once the candidate appears on
[Releases](https://github.com/scotej/studyvis/releases), download its
`.AppImage`, make it executable, and run it from a writable location. The Linux
AI engine is the upstream CPU build, so benchmark the selected model and prefer
a lighter model on slower machines. CachyOS prerequisites, FUSE-free fallback,
KDE Wayland portals, Secret Service setup, and updater details are in
[`INSTALL.md`](./INSTALL.md#linux-x86_64-appimage). ARM64 Linux and native
`.pkg.tar.zst`, `.deb`, and `.rpm` packages are not shipped.

The candidate does not rely on the host distribution's WebKit for sessions.
Official distro WebKitGTK release builds in the maintained Linux path compile
the GTK `ENABLE_WEB_RTC` peer-connection binding out, so installing or upgrading
that package cannot make `RTCPeerConnection` available (its media-device API is
still present). The AppImage instead carries the StudyVis-built WebKitGTK 2.52.5
and librice 0.4.3 runtime. Linux remains a release candidate until that exact
AppImage—not a dev build using host libraries—passes the data-channel,
camera/microphone, screen-capture, AI-capture, and physical cross-platform peer
matrix in [`PLAN.md`](./PLAN.md#platform-completion-and-deferred-scope).

StudyVis keeps itself up to date on the currently shipped platforms. It checks
for new releases in the background, downloads them, and offers a "Restart now"
button when one is ready — never during a session. Only your first install is
manual. For the Linux candidate, the AppImage and its containing directory must
be writable so the updater can replace it in place. This remains true with
`--appimage-extract-and-run`: Tauri updates and relaunches the original
AppImage, not its temporary extracted tree.
You can turn updates off in Settings → About.

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
5. **Add a friend (or skip).** Tap **Add friend** and you each get a
   friend code — a `studyvis://add#…` link (also shown as a QR). Swap
   codes over any chat app or scan each other's QR in person; each side
   imports the other. It works even if one of you is offline (no relay,
   no live connection needed). When you paste a code, compare the
   **safety number** it shows out-of-band (say it on a call) before
   confirming — that catches a tampered or impersonated code. The code
   holds only your public keys, so it's safe to share. (Pairing with a
   friend still on an older StudyVis? A "friend on an older StudyVis?"
   link falls back to the one-time 12-word code.)
6. **Tutorial.** Three sentences on how a session works. Optional.

Once you're past onboarding you land on your friends list. Click an
online friend, click **Invite**, they accept, and you're in a session
together.

## Where your data lives

Everything that identifies you or remembers your sessions stays in
the OS user-data directory:

- **macOS** — `~/Library/Application Support/studyvis/`
- **Windows** — `%APPDATA%\studyvis\` (i.e. `~/AppData/Roaming/studyvis/`)
- **Linux** — `$XDG_DATA_HOME/studyvis/` when `XDG_DATA_HOME` is set;
  otherwise `~/.local/share/studyvis/`

`com.studyvis.app` is the bundle identifier + the keychain service
name; it is NOT the data folder name. The data folder name is
`studyvis` under `path::data_dir()` (per `src-tauri/src/db/mod.rs`).

Inside:

- `identity.json` — your public key + display name + creation
  timestamp. Private keys are in the OS credential store (macOS
  Keychain / Windows Credential Manager / Linux Secret Service), not
  in this file. Linux needs a provider owning
  `org.freedesktop.secrets`, such as gnome-keyring or KeePassXC with
  its Secret Service integration enabled.
- `app.db` — local SQLite with your friends list, session
  history, and audit log per session. Used for the post-session
  report and the Stats dashboard.
- `models/` — AI model files you've downloaded (V2 features). Each
  model is 1–8 GB depending on the tier you picked.
- `logs/studyvis.log` — the app's own diagnostic log: one JSON record
  per line, written as the app runs. Usernames, keys, mnemonics and
  your own writing are stripped before anything is recorded. At about
  2 MB the live file rolls to `studyvis.log.1`; up to ten rolled
  generations are kept alongside the live file.
- `logs/llama-server.log` — diagnostic output from the local AI engine.
  Each explicit engine start archives up to the newest 5 MB of the
  previous live file, with ten rolled generations kept alongside the
  live file. Benchmarks, retries and deliberate restarts can each start
  the engine, so these are **log generations, not a promise of ten study
  sessions**.

The downloadable diagnostics ZIP includes a manifest and bounded tails
of the live and retained app/AI-engine logs (at most the newest 1 MB from
each file). Older bytes are marked as truncated instead of making an
unbounded archive. App records were redacted before being written;
AI-engine output has common home-directory usernames scrubbed while the
ZIP is built, but it can still contain local model and machine details.
Review the archive before sharing it. Creating it never uploads anything.

You can open the data folder from Settings → Advanced.

## How AI features fit in

AI stays disabled by default until you explicitly turn it on in
Settings → AI. You can choose and download any of the four model tiers
without running a benchmark. Benchmarking is optional but recommended:
it measures that model's speed on this device and tunes the sampling
cadence. If the selected model has not been benchmarked, StudyVis warns
you before enabling AI; continuing uses a 5-second fallback cadence and
a conservative five-minute request timeout, without p95 slowdown backoff. Models
download from Hugging Face directly to your computer; none of the
current catalog models requires a Hugging Face token.

During an AI session:

- StudyVis captures one frame of your camera and one frame of your
  screen at the benchmark-derived cadence, or with a 5-second fallback
  interval when the selected model is unbenchmarked. You can slow it
  down in Settings.
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
go to peers. The packaged Linux-candidate x86_64 engine is CPU-only; GPU
acceleration is not promised by the AppImage build, even if the machine has a
supported GPU.

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

1. **Download diagnostics.** Immediately after a session, use the
   download action at the top of its fresh report. The same action is
   available later from Settings → Advanced. It creates a local ZIP
   containing a manifest plus bounded app and AI-engine log tails;
   nothing is sent automatically. "Copy diagnostics" remains available
   for a short version/OS/display summary and recent app-log records,
   while "Open log" reveals the retained source files.
2. **Review the ZIP before sharing it.** Structured app records are
   redacted and common usernames are scrubbed from AI-engine paths, but
   AI-engine output may still reveal model or machine details and the
   retained generations can predate the session whose report you just
   closed.
3. **File an issue on GitHub** with the archive, or with the version
   (Settings → About), OS version and only the relevant log lines.
4. **Crash logs** stay local — macOS routes them to
   `~/Library/Logs/DiagnosticReports/StudyVis*`, Windows routes them
   to Event Viewer, and Linux users should start with
   `logs/studyvis.log` in the data directory (plus the desktop journal,
   when available). Share manually if asked.

## Current production limitations

These are decisions, not oversights. Each entry names the reason and
where you'd see it surface.

- **Linux packaging targets x86_64 AppImage only.** CachyOS KDE Wayland is
  the mandatory release-candidate sign-off path. ARM64 Linux, AUR/pacman,
  Flatpak, Snap, `.deb`, and `.rpm` packages are not release targets. Screen capture
  depends on the desktop portal + PipeWire, key custody depends on a
  Secret Service provider, and the bundled AI engine uses the CPU.
  Automatic update also requires the AppImage to live on a writable
  filesystem. The FUSE-free extraction fallback still targets that original
  file and does not remove the write requirement. Because StudyVis bundles its
  WebKitGTK/librice copy, distro security updates do not update it: maintainers
  own advisory monitoring, runtime rebuilds, license/source compliance, and
  delivery through the signed updater before Linux can become a supported
  release.
- **Release publication still needs external repository hardening.** The
  dedicated publish workflow revalidates the exact tag, CI run, signed
  three-platform manifest, artifacts, and successful latest tagged
  `release.yml` run for that exact tag/commit—the run that includes the uploaded
  AppImage's runtime smoke. That run attests the exact downloadable assets and
  final updater manifest. Publishing requires the SHA-256 recorded during the
  physical AppImage matrix, downloads the exact twelve-file draft set, requires
  each updater sidecar to match `latest.json` byte for byte, verifies every
  artifact's exact-workflow/tag/commit provenance, and rechecks the AppImage
  digest immediately before publication. Workflow YAML cannot configure the
  repository controls around it. Before production publication,
  an administrator must create the GitHub `release` environment with required
  reviewers, protect matching `v*` tags against
  creation, update, or deletion, and enable immutable releases. On this
  personal repository, the tag ruleset's sole `Always` bypass entry must be
  `RepositoryRole 5` (admin), which lets the owner-scoped `RELEASE_PAT` create
  the tag; do not add Write, Maintain, team, or integration bypasses. GitHub
  hides `bypass_actors` from the workflow's read-only ruleset response, so the
  workflow verifies scope and rule types while an admin must verify this list. This
  sole-owner repository requires `scotej` as its reviewer and permits self-review;
  add an independent reviewer and enable self-review prevention before relying on
  a second-person approval boundary.
  As of 2026-08-13 the environment is confirmed absent; the tag ruleset and
  immutable-release setting must also be verified/configured. Until then, the
  workflow does not provide the intended independent, tamper-resistant release
  boundary.
- **Signed installers.** No code-signing credentials. macOS
  notarization and Windows code-signing wait for a Developer ID and an
  EV cert, so friends still right-click → Open on macOS and click
  through SmartScreen on Windows _on the first install_. Auto-update
  itself shipped in v1.5.0 — it has its own signature check and doesn't
  need those certs. One consequence of staying unsigned on macOS: an
  update can reset the camera / mic / screen-recording permissions,
  because macOS ties them to a code identity an ad-hoc build doesn't
  have.
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
- **`/style` is a curated primitive/status gallery, not a coverage gate.**
  Covered composed components (VideoTile, AuditLogPanel, ScoreGauge, AI
  dialog, …) live in Storybook instead. The Storybook a11y gate
  (`npm run check-a11y`) audits every story that exists; three older
  component-level exceptions and 33 older feature components remain a frozen
  no-story baseline, while new uncovered modules fail CI.
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
  back. Bundle size varies by platform; the candidate AppImage includes the
  Linux runtime and packaged AI sidecar and is substantially larger
  than a minimal web shell.
- **React 19 + Vite 8 + Tailwind v4 + shadcn/ui** for the UI. One
  design-token file (`src/design/tokens.ts`) is the only place colors
  / spacing / motion values live. Two-layer component split:
  `src/components/ui/` is the only place Radix primitives are
  allowed.
- **trystero (Nostr default, MQTT raced for pairing, presence, inbox, and invites)** for peer
  rendezvous over public relays — the channel for invites, presence,
  and session signaling. WebRTC mesh (max 4 peers) for media + an
  encrypted data channel for audit events. Adding a friend needs no
  rendezvous at all: it's a self-signed **friend code** (public keys +
  name) each side imports offline, with an out-of-band **safety
  number** to compare before trusting a pasted code. The legacy live
  12-word pairing is retained for friends on older builds.
- **@noble/ed25519 + @noble/curves + @scure/bip39** for identity.
  Two keypairs (Ed25519 for signing, X25519 for NaCl-box invite
  envelopes), both deterministically derived from one 24-word BIP39
  mnemonic.
- **rusqlite** for local persistence (friends, sessions, audit log).
- **llama-server (llama.cpp build) sidecar** for V2 vision-model
  inference. Bundled per platform, started on demand. The packaged
  Linux-candidate build deliberately runs CPU-only.

`PLAN.md`, `ARCHITECTURE.md`, and `DESIGN-SYSTEM.md` are the
canonical specs — each the source of truth for its concern.
`CHANGELOG.md` and `ISSUES.md` track release history and the audit
ledger. `CLAUDE.md` is the working agreement for contributors and AI
coding agents. This README is the user-facing entry point.

## Developing

The stack is Tauri 2 + React 19 + Vite 8 + TypeScript strict. Use
Node 24.x, npm 11 or 12, and Rust 1.97.1 (the repository pins both
runtime/toolchain versions), plus the Tauri 2 platform prerequisites for your OS
(<https://tauri.app/start/prerequisites/>). CachyOS/Arch package names and
desktop-service prerequisites are listed in
[`INSTALL.md`](./INSTALL.md#building-on-cachyos--arch-linux).

```sh
npm install                      # frontend + tooling deps
npm run tauri dev                # full desktop app — React UI + Rust shell
```

Debug builds no longer need `scripts/fetch-llama-server.sh` first: `build.rs`
writes a placeholder sidecar and the app auto-installs the real llama.cpp
engine on first AI use (I73) — provided Settings → AI → "Install engine
automatically" is still on (its default) and the machine is online; with it
off, run the script or use the pane's Install now button. The script is still
**required** before `tauri build` (release-profile builds fail without real
binaries, by design).

Two lighter loops when you don't need the desktop shell:

- `npm run dev` — Vite frontend only. Fast UI iteration; Tauri APIs
  are absent, so identity, DB, P2P-adjacent commands, and the AI
  sidecar don't function.
- `npm run storybook` — component workbench at
  <http://localhost:6006>. New components must have stories; three older
  component-level exceptions (one UI primitive and two composed components)
  plus 33 older feature components remain a frozen coverage baseline in
  `scripts/check-stories.ts`. A dev-only primitive gallery also lives at
  `/style` in the running app.

Before opening a PR, all gates must pass (husky pre-commit enforces
only a subset — lint, prettier, `tsc --noEmit`, token/string/migration/
story guards, `cargo fmt --check`):

```sh
npm run build && npm run lint && npm run test
npm run check-tokens && npm run check-strings && npm run check-contrast
npm run check-migrations && npm run check-stories
npm run build-storybook && npm run check-a11y
(cd src-tauri && cargo test && cargo fmt --check && cargo clippy)
(cd src-tauri && cargo deny check)
```

CI runs all of that on every pull request and adds what only makes
sense with a repository around it: workflow linting (`actionlint` +
`zizmor`), dependency review, `cargo-deny`, spell-checking, a packaged
Linux AppImage startup/Secret Service smoke, and a conventional-commit
PR title. Most roll up into one required check, **All pre-merge checks**;
the title check is its own required check (**PR title**) because it has
to re-run when a title is edited. The AppImage smoke builds the portable
artifact, checks a gnome-keyring Secret Service round-trip, and keeps it
alive under Xvfb for 20 seconds. It is not a substitute for the physical
CachyOS KDE matrix in PLAN §8. CodeQL runs alongside as a non-required workflow
(JavaScript/TypeScript, Rust, and the workflows themselves) and reports into
the Security tab. Storybook publishes to GitHub Pages from
`main` and is attached to each PR as an artifact.

Every pull request also gets a deployment, and no pull request waits
for one. `deploy.yml` builds each commit that reaches a PR or `main`
into a real installable preview bundle for macOS, Windows, and the Linux
release candidate that you can smoke-test — `StudyVis-macOS-arm64-pr<n>` and
`StudyVis-Windows-x64-pr<n>`, plus the x86_64 Linux AppImage artifact,
attached to the run for seven days. Each platform records its own GitHub
Deployment (`preview-macos`, `preview-windows`, `preview-linux`), so one
broken platform is visible without hiding the others.

Its **Deployed** check is an _indicator only_ — a full build takes
30–60 minutes per platform, so merging waits on the two branch-protection
checks above, never on this one. Red means a platform stopped building and is
worth acting on; it still will not block the merge. A commit touching
only docs or workflow files builds nothing and is recorded as a
documentation deployment. These bundles carry no updater manifest and
are never consumable as an update.

**Read before changing code.** `CLAUDE.md` (repo root) is the
working agreement — house rules, doc map, quality gates — for human
contributors and AI coding agents alike. The load-bearing rules, in
one breath: every design value comes from `src/design/tokens.ts`;
user-facing copy lives in `src/strings.ts`; Radix/shadcn primitives
are imported only inside `src/components/ui/`; SQLite migrations are
forward-only; peer wire formats and identity derivation are
cross-version compatibility contracts (friends can update at different
times); accessibility (WCAG AA, axe-clean stories,
reduced-motion) is a gate, not a nicety; and no telemetry, ever.

`ISSUES.md` entries `I9` and `I18` are accepted deviations under the
friends-only threat model — leave them unless explicitly asked. Its
Archive section indexes the retired 2026-06 improvement backlog, whose
IDs still tag the code that implemented them; a code audit found
essentially all of it shipped, so nothing there is open work.

## Versioning

1.x is the running release series, all friends-only builds without
macOS notarization or Windows Authenticode signing. The Linux release-candidate
AppImage is covered by the same updater minisign integrity chain but is not a
native distro package and cannot publish before its physical sign-off.
v1.0.0–v1.0.3 shipped during V1 + V2 + the audit pass. **v1.0.5** is
the polished 1.0 — it landed the V3 phase (recovery from a 24-word
backup, custom keybindings, multi-monitor capture, light + auto
themes, opt-in custom window chrome, the accessibility and
reduced-motion pass, and the cohesion + copy pass). **v1.1.0** added
the pairing QR redesign; **v1.2.x** brought a maintenance + feature
wave and more reliable pairing discovery; **v1.3.1** brought offline
friend codes; **v1.4.0** added multi-friend sessions, faster AI, and
the verified backlog; **v1.5.0** brought in-app auto-update; **v1.6.0**
a searchable settings rail and a lighter, faster startup. `CHANGELOG.md`
has the full history, including whatever shipped most recently. The version
number lives in (and must stay consistent across):

- `package.json` — npm root
- `package-lock.json` — npm lockfile (two spots: top-level + the
  studyvis package node)
- `src-tauri/Cargo.toml` — Rust crate
- `src-tauri/Cargo.lock` — Rust lockfile (the `studyvis` package
  entry only; other registry crates that happen to read a 1.x
  version are unrelated)
- `src-tauri/tauri.conf.json` — Tauri bundle metadata (drives
  installer version)

The Vite build pipes `package.json#version` through `__APP_VERSION__`
into Settings → About, so the About screen tracks the npm version
automatically.

## License

UNLICENSED (private; friends-only distribution). Source available on
GitHub for transparency and re-pairing.

Every desktop bundle carries `THIRD-PARTY-NOTICES.txt` and its machine-readable
`THIRD-PARTY-NOTICES.json` manifest under its Tauri resources. The repository
generator derives them from the locked npm production tree, the normal Rust
dependency closures for all three release targets, and the pinned llama.cpp
runtime. Version-bound overrides cover vendored Wry's selected MIT alternative,
llama.cpp b9095, both OFL font packages, victory-vendor's omitted root MIT text
and 13 nested licenses, and package archives that declare a license but omit its
text. CI regenerates the files offline after populating the locked caches and
requires an exact diff; artifact checks require the packaged copies and hashes.
This mechanical inventory aids review and release gating—it is not legal advice
or legal sign-off.

The Linux candidate also bundles separately licensed WebKitGTK and librice
components. Their notices, the local portability patch, and other staged
license material ship under
`usr/share/licenses/studyvis-webkit-runtime/` in the AppImage. That directory's
`BUILD-MANIFEST.txt` records the source URLs/hashes, patch hash, tool/config
inputs, and payload list; `WEBKIT-THIRD-PARTY-LICENSES.txt` and
`WEBKIT-LICENSE-FILES.sha256` carry the readable 59-file upstream inventory.
`LIBRICE-THIRD-PARTY-NOTICES.txt` and its JSON manifest separately inventory
the exact locked normal-dependency union selected by the `rice-proto` and
`rice-io` `cargo-c` builds, including their `capi` features and source hashes.
Each tagged Linux draft also carries
`StudyVis_X.Y.Z_linux-webkit-sources.tar.gz` and its `.sha256` sidecar, providing
the verified upstream archives, complete patch, and build inputs separately
from the installed AppImage. Its companion
`StudyVis_X.Y.Z_linux-system-sources.tar.gz` and `.sha256` pair starts from the
finished AppImage: it maps every ELF and symlink to an exact Ubuntu package or a
recorded non-Ubuntu input, records byte hashes/build IDs and dynamic
dependencies, and carries matching Ubuntu source/copyright material plus the
modeled packaging-tool, AppRun, and llama.cpp sources/notices. It also carries
the complete evidence set for StudyVis's source-built AppImage type-2 runtime
revision 1: the hash-pinned type2 commit, musl 1.2.5, zlib 1.3.1,
decompression-only zstd 1.5.6, libfuse 3.15.0, squashfuse 0.5.2, and Meson 1.7.2
sources and licenses; exact Jammy compiler/linker source and package versions;
build metadata; a link map; and hashes for every selected link input. The gate
requires an `x86_64-linux-musl` `ET_DYN` static PIE with no `PT_INTERP` or
`DT_NEEDED`. It uses musl mallocng; mimalloc is neither linked nor shipped.
This completes the pre-SquashFS runtime's static source, notice, and link
closure. The source pairs are mechanical release evidence, not legal sign-off.
The hosted Ubuntu 22.04 image and Jammy apt indexes remain a bounded build
baseline, not a bit-reproducible environment.
The build recipe remains tracked here and is documented in
[`INSTALL.md`](./INSTALL.md#pinned-linux-webkit-runtime).
