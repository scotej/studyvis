# The StudyVis lab

Runs the real app as several virtual machines on one box, so a change can be
tested end to end — pairing, a session, media both ways, the AI pipeline —
without two laptops and without anything leaving the machine.

```
npm run lab -- up --peers alice,bob     # start the lab with two machines
npm run lab -- onboard alice Alice      # walk the six onboarding screens
npm run lab -- snapshot alice           # what is on screen, by role and name
npm run lab -- click alice "Add friend"
npm run lab -- db alice friends
npm run lab -- down

npm run lab -- verify                   # every scenario, one verdict (~80s)
npm run lab -- --help                   # the full verb list
```

## What it actually runs

The frontend under test is the shipped bundle, byte for byte. Nothing in `src/`
knows the lab exists: every seam is injected into the page before app code runs
(`src/bridge/initScript.ts`).

| Piece                    | In the lab                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Tauri IPC                | `window.__TAURI_INTERNALS__`, routed to a per-machine Node backend                                           |
| SQLite                   | `node:sqlite` running the shipped `src-tauri/src/db/migrations/*.sql`, with the Rust queries copied verbatim |
| Identity keys            | held in memory, signed with the app's own `@noble` module — **never** the macOS keychain                     |
| Nostr relays             | one loopback NIP-01 relay, each pinned url mapped to a distinct path                                         |
| MQTT brokers             | one loopback aedes broker, same mapping                                                                      |
| llama-server             | a stub serving `/health` and `/v1/chat/completions` from a scripted queue                                    |
| Camera / mic / screen    | Chrome's fake devices; `getDisplayMedia` auto-selects the whole screen                                       |
| Everything else outbound | refused, and the refusal is asserted                                                                         |

## Things that will bite you

**It defaults to the built bundle, and that is not cosmetic.** Under the Vite dev
server React's StrictMode double-invokes effects; rooms are joined and left in a
loop, so trystero never holds a subscription long enough to meet a peer and
nothing peer-to-peer works. `--mode dev` is there for looking at screens. The
built bundle is rebuilt automatically whenever anything in `src/` is newer.

**The daemon holds the code you started it with.** Editing anything under `lab/`
needs `npm run lab -- down && npm run lab -- up`; a scenario run always starts
fresh, so this only applies to the interactive path.

**Settings are read at boot.** `settings <machine> --set '{...}'` writes the file;
`reload <machine>` is what makes the app pick it up. Machines start with the
app's own debug-log setting on, so `logs` carries the discovery trace.

**`peers` will look alarming.** Trystero keeps twenty pre-generated offers per
room, so a machine sitting alone already holds dozens of closed peer
connections. Read `connected` and `openDataChannels`, not `total`.

**Mnemonics.** A lab identity's 24 words are a throwaway, but `mnemonic` prints
them, so keep them out of anything you paste elsewhere. The real rule from
CLAUDE.md stands: never put a real mnemonic into a chat with any AI service.

## Scenarios

`lab/scenarios/` — each owns its own lab, start to finish, and prints JSON.

| Scenario     | What it proves                                                                           |
| ------------ | ---------------------------------------------------------------------------------------- |
| `onboard`    | a new machine reaches a usable home screen with a real identity                          |
| `pair`       | two machines swap contact cards and converge on presence                                 |
| `session`    | invite → accept → one session with live audio and video both ways                        |
| `ai`         | scripted verdicts drive streaks, thresholds, a signed peer alert, audit and session rows |
| `dark-relay` | every Nostr relay refused, and the invite still lands over MQTT                          |

Write a new one against `src/scenario.ts`: it hands you a lab, `step`, `check`
and the `ui` verbs, dumps every machine's screen and log on failure, and fails
the run if anything tried to leave the box.

## What this does not prove

Real for the frontend, honest about the rest. The lab does not exercise
WKWebView or WebKitGTK rendering, real `getUserMedia` against real hardware, OS
keychain custody, the tray, global shortcuts, OS notifications, llama-server
process management, applying an update, or packaging. Those stay physical —
PLAN §8's matrix is still the standard for a Linux sign-off.
