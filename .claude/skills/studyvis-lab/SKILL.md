---
name: studyvis-lab
description: Drive the real StudyVis app as several virtual machines on this box — onboard, pair, run a session with live video, script the AI, inject relay faults — all offline, from the CLI. Use whenever a change needs testing against the running app rather than unit tests, or when reproducing a peer-to-peer, session, AI, or onboarding bug locally.
---

# StudyVis lab

Two laptops' worth of app, on one machine, driven from Bash. The frontend under
test is the shipped bundle; every seam (Tauri IPC, relays, ICE, the clock) is
injected by the harness, so nothing in `src/` knows it is being tested.

Read `lab/README.md` before a non-trivial session — it carries the failure modes
this file only summarizes.

## The loop

```bash
npm run lab -- up --peers alice,bob     # ~10s: relay, broker, llama stub, two Chromes
npm run lab -- onboard alice Alice      # six onboarding screens
npm run lab -- snapshot alice           # the screen, by role and accessible name
npm run lab -- click alice "Add friend"
npm run lab -- down                     # always: it leaves browsers running otherwise
```

`snapshot` is the eyes. Everything is addressed by **role and accessible name**,
the same way a screen reader would — so read the snapshot, then click what it
names. `--role checkbox`, `--nth N` and `--within '{"role":"dialog","name":"…"}'`
disambiguate. Use `hover` for controls that only become clickable on hover.

## Checking a change

```bash
npm run lab -- verify        # all five scenarios, one JSON verdict, ~80s
npm run lab -- run pair.ts   # one scenario
```

Prefer adding or extending a scenario in `lab/scenarios/` over a long
hand-driven session — it is the part that survives, and it re-runs in seconds.

## When something does not happen

In order, these answer almost everything:

```bash
npm run lab -- status              # error counters, relay/broker traffic, egress attempts
npm run lab -- peers alice         # read `connected` and `openDataChannels`, NOT `total`
npm run lab -- logs alice          # the app's own structured log (debug on by default)
npm run lab -- calls alice --cmd identity   # every Tauri command the page made
npm run lab -- subs                # the relay's live subscription table
npm run lab -- frames --limit 100  # recent REQ/EVENT/CLOSE
npm run lab -- notifications alice # recorded notifications, dialogs, windows, shortcuts
```

## Controlling the world

- **Settings**: `settings alice --set '{"theme":"light"}'` then `reload alice`.
- **Native events** (push-to-talk keys, deep links): `emit alice ptt-friends-pressed`.
- **The model**: `llama push '{"severity":"blatant","reasoning":"…","on_topic_confidence":0.1}'`,
  or start a machine with `add-machine alice --ai true` for an installed model and
  a sidecar pointed at the stub.
- **Faults**: `fault relay --faults '{"refuseConnections":true}'` — also
  `dropEvents`, `rejectPublish`, and the same shape for `broker`.

## Two rules

**It runs the built bundle.** Under `--mode dev` StrictMode's double-invoked
effects churn rooms and nothing peer-to-peer connects. Dev mode is for looking
at screens only. The bundle rebuilds itself when `src/` is newer.

**Restart after editing `lab/`.** The daemon holds the code it started with:
`npm run lab -- down && npm run lab -- up`. Scenario runs always start fresh.

## What it cannot tell you

It never touches the real macOS keychain, and it does not exercise WKWebView
rendering, real camera hardware, the tray, global shortcuts, OS notifications,
llama-server process management, updates, or packaging. A green lab run is not a
substitute for PLAN §8's physical matrix.
