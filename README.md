<p align="center">
  <img src="src-tauri/icons/128x128.png" width="88" height="88" alt="StudyVis" />
</p>

<h1 align="center">StudyVis</h1>

<p align="center">
  Peer-to-peer desktop study sessions for close friends.<br />
  Body-doubling over video, with optional on-device AI focus detection.<br />
  <strong>Local-first — nothing about you leaves your machine.</strong>
</p>

<p align="center">
  macOS &amp; Windows · friends-only unsigned builds · current release <strong>v1.2.2</strong> · <a href="./CHANGELOG.md">changelog</a>
</p>

---

You start a session, your friends join over video, and you keep each other on
task by being seen working. Turn on the optional AI and the app watches your
camera and screen **on the same machine** — nothing streams anywhere — and
gently nudges you when you drift off-topic. After the session, each of you sees
a quiet report of how the time went.

No accounts, no servers we run, no telemetry. Just you, a few friends, and the
quiet pressure of company.

## Contents

- [Install](#install) · [First run](#first-run) · [Optional AI](#optional-ai-focus-detection)
- [Privacy &amp; trust](#privacy--trust) · [Where your data lives](#where-your-data-lives)
- [Architecture in a minute](#architecture-in-a-minute) · [What's deliberately not here](#whats-deliberately-not-here)
- [Reporting problems](#reporting-problems) · [License](#license)

## Install

Friends-only **unsigned** installers. Each OS warns the first time you run;
the steps below clear the warning, and the OS remembers afterwards. Full
walkthrough in [`INSTALL.md`](./INSTALL.md). There is no auto-update — re-run
the installer for a new version.

| OS                        | Get it                                                                                                                                                 | First launch                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **macOS** (Apple Silicon) | The `aarch64` `.dmg` from [Releases](https://github.com/scotej/studyvis/releases), dragged into Applications. Intel Macs aren't in the release matrix. | **Right-click** the icon → **Open** (double-click refuses the first time). macOS asks once, then remembers. |
| **Windows 10 / 11**       | The `.msi` from [Releases](https://github.com/scotej/studyvis/releases).                                                                               | SmartScreen warns — click **More info** → **Run anyway**. Lands in your Start menu.                         |
| **Linux**                 | Not in 1.x yet — WebKitGTK screen-capture is unverified. Clone the repo and `npm run tauri dev` to try the dev build.                                  | —                                                                                                           |

## First run

1. **Welcome & permissions.** Camera, microphone, OS notifications. Skip any
   and grant later in your OS privacy panel — nothing is retried behind your back.
2. **Identity.** StudyVis generates a keypair and shows a **24-word recovery
   phrase, once**. Write it on paper. Lose the laptop without it and your friends
   see a new identity — there's no central account recovery. Already have a
   phrase? Choose **I have a 24-word backup** and type it in.
3. **Display name.** Anything — a name, a nickname, an emoji. Change it any time.
4. **Add a friend (or skip).** You each generate a one-time **12-word code**,
   send it over any chat app, and paste each other's. Once used, it's discarded.

Then you land on your friends list. Click an online friend → **Invite** → they
accept → you're studying together.

## Optional AI focus detection

Disabled by default; turn it on in **Settings → AI**. First enable asks for
screen-recording permission and offers a model picker — four tiers, from fast
and light to slow and thorough, with **speed measured on your machine** by a
quick on-device benchmark. Models download from Hugging Face straight to your
computer (the gated Gemma tier needs a one-time HF token, stored in your OS keychain).

During a session, a local model classifies a camera frame and a screen frame
every few seconds as on-task or mildly / moderately / blatantly off-task. Two
off-task samples in a row give **you** a private nudge; two more alert your
friends and dock your session score. Open the AI dialog with **Ctrl/Cmd + ]** to
ask for a break.

**Friends never see your frames** — only a flag and the model's one-line reason.
Camera and screen pixels never leave your machine.

## Privacy & trust

A few honest disclosures, in the spirit of "no surprises":

- **A quiet tray presence.** Once launched (and especially with opt-in
  autostart), StudyVis lives in the system tray so friends can invite you
  without you opening it first. Right-click the tray icon to quit fully.
- **A few idle encrypted WebSockets** to a small, curated set of public Nostr
  relays — the channel friends use to send invites. Kilobytes per hour; the
  relays can't read what crosses them.
- **WebRTC during sessions.** Audio and video go directly peer-to-peer. About
  **15% of networks** (strict NATs, locked-down Wi-Fi) block direct connections;
  there's no relay fallback today, but you can add your own TURN relay in
  **Settings → Network** (it only ever sees encrypted bytes).
- **Camera & mic** are requested when you first join a session;
  **screen-recording** only when you turn on AI (your OS's recording indicator
  stays lit until you leave the session). Both live with the OS — revoke any time.
- **Zero telemetry, ever.** No analytics, no crash uploads. If something breaks,
  you choose what to share (**Settings → Advanced → Share log**).

**This is built for 2–4 friends who already know each other**, and it does _not_
defend against malicious peers. AI is self-reported (a friend can turn theirs off
or fudge their score — there's no anti-cheat), and messages from non-friends are
dropped after a cheap signature check. If you wouldn't share your screen with
these people for half an hour, they're not the right friends for StudyVis.

## Where your data lives

Everything that identifies you or remembers your sessions stays in your OS
user-data directory — `~/Library/Application Support/studyvis/` on macOS,
`%APPDATA%\studyvis\` on Windows — and your **private keys live in the OS
keychain**, never in a file. Inside: your public identity, a local SQLite DB
(friends, session history, audit log), and any downloaded AI models. Open it
from **Settings → Advanced**. Full layout in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Architecture in a minute

- **Tauri 2** desktop shell (native WebView, Rust backend), ~10 MB per installer.
- **React 19 + Vite 8 + Tailwind v4 + shadcn/ui** UI, with one design-token file
  (`src/design/tokens.ts`) as the single source of truth for color/spacing/motion.
- **trystero** for peer rendezvous over public relays — friend pairing races
  **Nostr + MQTT** so one dead relay set can't strand you. Sessions run a WebRTC
  mesh of up to 4 people for media, plus an encrypted data channel for audit +
  sync events.
- **@noble/ed25519 + @noble/curves + @scure/bip39** for identity: two keypairs
  (Ed25519 signing, X25519 invite envelopes) derived from one 24-word mnemonic.
- **rusqlite** for local persistence; a **llama.cpp `llama-server` sidecar**,
  bundled per platform and started on demand, for on-device vision inference.

`PLAN.md`, `ARCHITECTURE.md`, and `DESIGN-SYSTEM.md` are the canonical specs —
each the source of truth for its concern. This README is the user-facing door.

## What's deliberately not here

These are decisions, not oversights, each recorded with its reason: **Linux
installers** (WebKitGTK screen-capture unverified), **signed builds + auto-update**
(no code-signing credentials yet), and **extra theme variants**, plus a handful
of smaller deferrals. See [`PLAN.md`](./PLAN.md) §6–§8 (non-goals, known
limitations, and deferred-with-a-trigger) and the [`CHANGELOG.md`](./CHANGELOG.md)
for the full list.

## Reporting problems

There's no built-in error reporter — that would imply telemetry. Instead:
**Settings → Advanced → Share log** reveals the AI sidecar log and copies your
version + OS + log path to the clipboard (nothing is uploaded), then file an
issue on [GitHub](https://github.com/scotej/studyvis/issues) with the version
(**Settings → About**), your OS, and the relevant log lines. Crash logs stay
local (macOS `~/Library/Logs/DiagnosticReports/StudyVis*`; Windows Event Viewer).

## License

UNLICENSED — private, friends-only distribution. Source is on GitHub for
transparency and re-pairing.
