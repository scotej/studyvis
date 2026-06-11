# StudyVis improvement backlog

A forward-looking backlog of concrete, code-grounded improvements for StudyVis (shipped, feature-complete v1.2.0). Distinct from [`ISSUES.md`](ISSUES.md), which is the _audit ledger_ of already-found-and-fixed (or deliberately deferred) defects — this document is the menu of work still worth doing.

**Produced:** 2026-06-11, from a multi-agent survey that read the real source across all eight subsystems (friend discovery, sessions/WebRTC, AI pipeline, UI/design system, settings/stats/report, identity/crypto/DB, build/release, and the docs/threat-model), deduped to themes, and pressure-tested with a completeness critic. Every item cites the files it touches; nothing here is implemented yet.

## Scope & constraints

- **Friends-only, local-only, no telemetry.** Nothing below phones home **except** **`X4`**, which is explicitly flagged as breaking PLAN §3's "zero outbound" and must ship opt-in / off by default.
- **Accepted deviations are out of scope.** `I9` (Pomodoro broadcaster takeover) and `I18` (sidecar model-path sandbox) are deliberate choices under the documented threat model — not "fixed" here.
- **No web-scale concerns.** The audience is a handful of friends with a 4-peer session cap.

## Legend

- **Kind:** `bug` · `reliability` · `ux` · `feature` · `perf` · `tech-debt` · `security` · `a11y`
- **Impact:** to these specific users — 🔴 high · 🟡 medium · ⚪ low
- **Effort:** S (small) · M (medium) · L (large)

---

## Start here — highest ROI

The real correctness defects and near-free wins. Knock these out first.

| ID     | Title                                                               | Kind        | Impact | Effort |
| ------ | ------------------------------------------------------------------- | ----------- | ------ | ------ |
| **R1** | Stop persisting `score=100` for AI-off sessions                     | bug         | 🔴     | S      |
| **S2** | Make a missed PTT key-release recoverable (privacy defect)          | bug         | 🔴     | S      |
| **S1** | Grace window before auto-ending on transient disconnect             | reliability | 🔴     | M      |
| **D1** | Don't steer a corrupt-identity load into new-identity onboarding    | bug         | 🔴     | M      |
| **A2** | Treat malformed model responses as uncertain, not `on_task`         | reliability | 🟡     | S      |
| **F8** | Align docs/copy to the STUN-only reality (no TURN ships)            | bug         | 🔴     | S      |
| **X1** | Gate the release on CI-green before tagging `main`                  | reliability | 🔴     | S      |
| **X2** | Build the Intel `x64.dmg` the docs promise (or drop the claim)      | bug         | 🔴     | S      |
| **X3** | Run `check-strings` in CI                                           | reliability | 🟡     | S      |
| **U4** | Collapse the redundant second "Add friend" button                   | ux          | ⚪     | S      |
| **R2** | Disambiguate "Focused minutes" (stats) vs "Focused-time %" (report) | ux          | 🟡     | S      |

---

## Friend-finding & connection reliability

The headline reason the app exists, and where failure is most silent. Several gaps share one root: shipping STUN-only ([`ice.ts`](src/lib/trystero/ice.ts) `PUBLIC_TURN_SERVERS = []`) plus hardcoded relay/TURN lists with no in-app escape hatch and no auto-update to push a fix.

### F1. Wire trystero `onJoinError` so silent relay/network failures become visible

**reliability · 🔴 · M** — `src/lib/trystero/index.ts` (`joinTopic` accepts `callbacks?` but never forwards `onJoinError`; `TopicRoom` omits it); call sites pass none (`pair.ts:161`, `inbox.ts:150`, `invite.ts:114`, `presence.ts:78/104`, `session/lifecycle.ts:57/63`); `strings.ts:252`.

On a school/corporate network where all 8 pinned relays are blocked, the pairing dialog sits on "Waiting for your friend to enter the code" and the 30s hint blames the _other person_ — never the user's own network. `relays.ts` itself notes "discovery fails symmetrically for everyone with no recovery." Forward the callbacks `joinTopic` already accepts and surface a distinct "Can't reach the network" state separate from the peer-never-arrived hint.

### F2. Connection-diagnostics panel via trystero `getRelaySockets`

**feature · 🔴 · M** — `src/features/settings/categories/NetworkCategory.tsx`; `src/lib/trystero/`.

When pairing fails, a non-technical friend has zero observability. trystero already ships `getRelaySockets()` (the live socket map with per-URL readyState) and the app already imports trystero — nothing reads it. Add a "Connection" panel showing a connected/connecting/down dot per relay, re-polled on a tick. Pure local read; no telemetry.

### F3. Let users add a relay URL / TURN server without a new build

**feature · 🔴 · M** — `src/lib/trystero/relays.ts` (`DEFAULT_RELAY_URLS` hardcoded), `src/lib/trystero/ice.ts` (`buildIceOptions`/`iceOptionsFor` take effect the instant the list is non-empty), `src/stores/settingsStore.ts`, `NetworkCategory.tsx`.

Both lists are compile-time constants and TURN ships empty, so all cross-network sessions are STUN-only and the documented ~15% on symmetric/CGNAT/strict NAT fail silently. The `turnPreference` radio is inert until someone edits `ice.ts`. The ICE wiring is complete and tested — only the input is missing. Persist optional user-supplied relay URL(s) and a TURN server (url/username/credential) in `settingsStore`, plumbed through the existing `relayConfig.urls` / `buildIceOptions`. One friend self-hosting coturn unblocks the group. Gate TURN behind Advanced; default empty.

### F4. Surface per-peer WebRTC connection state in the session grid

**ux · 🟡 · M** — `src/components/VideoTile.tsx:36` (`resolvedState = stream ? 'online' : 'offline'`); `src/lib/trystero/index.ts:73` (`getPeers` returns `Record<string, RTCPeerConnection>`).

A peer mid-ICE-handshake, with a failed connection, or that never connects under STUN-only all render identically as a frozen offline tile. Feed each peer's `connectionState` into VideoTile so it shows "Connecting…" vs "Connection failed." **Do not** bundle TURN (no reliable free public TURN exists); the value is making the existing silent failure legible.

### F5. Post-peer-arrival stall timer for the pairing dialog

**reliability · 🟡 · S** — `src/features/friends/pair.ts:200-218`; `AddFriendDialog.tsx:28,70-71`.

`onPeerJoin` fires when a peer is merely on the Nostr topic, before any datachannel forms. The dialog flips to "Exchanging keys"; if the channel never establishes (strict NAT), it sits there forever with no timeout. Add a ~45s post-arrival stall timer surfacing "connected to the network but couldn't establish a direct link — try a relay/TURN."

### F6. Make invite delivery honest about offline friends + retry on presence

**ux · 🟡 · M** — `src/features/friends/invite.ts:104-152` (`sendInviteEnvelope` only fires inside `onPeerJoin`, else `InviteTimeoutError` after 15s); `FriendsListView.tsx:118`; `strings.ts:304`.

Nostr relays don't buffer for absent peers, so an invite to a closed app always times out and is never delivered later. Re-attempt `sendInviteEnvelope` when the friend's presence flips online within a short window, and distinguish "friend is offline" from "we couldn't reach the relay."

### F7. Goodbye heartbeat so presence flips offline near-instantly on quit

**ux · ⚪ · M** — `src/features/friends/presence.ts:27-34,135-148` (`HEARTBEAT_INTERVAL_MS` 30s, `ONLINE_WINDOW_MS` 60s; `leave()` just clears timers).

Online = "last heartbeat within 60s" and no offline signal is sent on quit, so a friend who closed their app 0–60s ago still shows green and exposes the Invite button (which then dead-ends in the 15s timeout). Send a best-effort "leaving" flag before `room.leave()`; receivers mark that pubkey offline on receipt. Preserves the receiver-clock model that fixed `I2`.

### F8. Align docs and in-app copy to the STUN-only reality

**bug · 🔴 · S** — `src/lib/trystero/ice.ts`; `src/strings.ts:714,718`; `README.md:29-33`; `PLAN.md §2/§7`. (ARCHITECTURE §4 was already corrected.)

`ice.ts` ships TURN empty (the old public endpoints died 2026-06-01), so there is **no** relay fallback — yet README, PLAN §2/§7, and Settings copy still promise an Open Relay fallback. The ~15% on strict networks get silent failures the docs say will be relayed. Bring the copy in line with §4: StudyVis is STUN-only today; strict-NAT/corporate/school networks may fail until a TURN server is configured. Reword the "Always" preference help (it claims it relays through a server that doesn't exist).

### F9. Raise QR error-correction level and surface code freshness

**ux · ⚪ · S** — `src/components/PairQrCode.tsx:16-25` (EC `'M'`, size 192); `PairQrScanner.tsx:54`; `src/features/friends/pairLink.ts`.

The QR encodes the full ~90-char secret link; at 192px / EC `'M'` it's dense and a laptop webcam scanning another screen across a desk struggles. Bump EC to `'Q'` (capacity is fine for the short link), enlarge slightly, and show a soft "one-time use — regenerate if it's been a while" note (the 10-min secret lifetime isn't shown today).

### F10. Register `studyvis://` as a real OS deep link

**feature · 🟡 · M** _(surfaced by the completeness critic)_ — `src/features/friends/pairLink.ts:5-10` (`PAIR_LINK_PREFIX 'studyvis://pair?c='`, commented as NOT OS-registered); no `tauri-plugin-deep-link`; accept flow in `pair.ts`.

The pairing link already _looks_ like a deep link but clicking it does nothing — the friend hand-types a ~90-char code. Register the scheme and route inbound `pair?c=<code>` into the existing accept flow (prefill, validate with `isPairLink`). Couple with single-instance (**`N1`**). Be honest in copy: pairing is still a live simultaneous rendezvous with the ~10-min secret — the win is "no dictating a long code," not async pairing.

---

## UI / UX & accessibility

The home screen and onboarding are the first thing every friend sees, and several rough edges undercut discoverability and design-system adherence.

### U1. Give online friend rows a persistent invite affordance

**ux · 🟡 · S** — `src/features/friends/FriendsListView.tsx:118-128` (Invite button is `opacity-0`/`pointer-events-none` until `group-hover`/`group-focus-within`).

The single most important action — inviting a friend — is invisible until the row is hovered: undiscoverable on first look, impossible on touch. Keep §8.2's calm aesthetic but render the button always-visible at reduced emphasis (ghost/outline), elevating to accent on hover/focus.

### U2. Show a "waiting for your friend" state when alone in a session

**ux · 🔴 · M** — `src/features/session/SessionView.tsx` (no empty-peer branch); `src/components/VideoGrid.tsx` (count≤1 → single full-bleed tile); no "waiting" copy in `strings.ts`.

After inviting, the session view shows only the host's own video filling the grid with no affordance that the app is waiting. For a body-doubling app, the most common first-session moment — sitting alone right after inviting — reads like a broken screen. When `peerEntries.length === 0` in an active session, render a calm waiting tile ("Waiting for your friend to join…") reusing the §10 empty-state pattern (no spinner).

### U3. Add Back navigation to the onboarding step sequence

**ux · 🟡 · S** — `src/features/onboarding/Onboarding.tsx` (only `advance()`/`finish()`); `src/components/OnboardingStep.tsx` (`secondaryAction` prop defined but unused); DESIGN-SYSTEM §8.1 wireframe shows `[Back] [Continue]`.

The 6-step onboarding is strictly one-directional, deviating from its own canonical wireframe. Track a back stack and pass `secondaryAction={{ label: back, onClick: goBack }}` to each step except the first (suppress after a mnemonic is committed).

### U4. Collapse the redundant second "Add friend" button

**ux · ⚪ · S** — `src/features/friends/FriendsListView.tsx:24-56` (empty branch renders the header `[+ Add friend]` AND a second identical button in the centered card).

The zero-friends empty state shows two identical buttons ~24px apart, against DESIGN-SYSTEM §10's one-primary-action rule. Keep the centered card as the sole CTA (it carries the explanatory copy).

### U5. Make the WCAG contrast gate detect token pairings not in its allowlist

**a11y · 🟡 · M** — `scripts/check-contrast.ts` (`PAIRINGS` is a hand-curated array, lines 126-459).

The gate validates a manually maintained inventory; a new combination (e.g. `text-muted` on `bg-sunk`) passes simply by not being enumerated, so the gate proves "the listed pairs pass," not the house-rule "every pair the UI uses passes." Add a coverage check: grep `src/` for `text-*`/`bg-*`/`border-*` co-occurrences and fail when a combination has no matching `PAIRINGS` entry.

### U6. Replace the raw radio input in SessionTimer with the RadioGroup primitive

**tech-debt · ⚪ · S** — `src/components/SessionTimer.tsx:196-203` (`PresetRadio` renders native `<input type="radio">`); `ui/radio-group.tsx` already exists.

The lone primitive-layering violation in the surveyed UI; the native radio bypasses the themed focus ring and sizing. Swap to `RadioGroup` + `RadioGroupItem` (arrow-key nav comes free).

### U7. Update the stale BipBackupPanel note in DESIGN-SYSTEM.md

**tech-debt · ⚪ · S** — DESIGN-SYSTEM.md §4 (says BipBackupPanel is "inlined… pending extraction"); the component exists at `src/components/BipBackupPanel.tsx`, imported by `IdentitySetup.tsx:4`, with its own story. One-line doc fix.

---

## Session robustness

Once two friends connect, the live session is fragile in ways that hurt long body-doubling runs.

### S1. Grace window before auto-ending on transient disconnect

**reliability · 🔴 · M** — `src/features/session/lifecycle.ts` (`wireSessionRoom` `onPeerLeave` 202-209; `buildLeaveHandler` 80-150).

`onPeerLeave` runs `hooks.leave()` the instant `peers.size` hits 0, with no debounce. A network blip drops the transport to all peers at once, count crashes to 0, and `buildLeaveHandler` irreversibly runs the report + `markEnded()`. A 5-second WiFi hiccup ends a 90-minute session. Arm a 15–30s grace timer on empty; cancel on rejoin (trystero re-fires `onPeerJoin` and the cumulative `seenPeerEdPubkeys` set survives the gap, so the report still records who you studied with).

### S2. Make a missed PTT key-release recoverable

**bug · 🔴 · S** — `src-tauri/src/lib.rs:404` (emits `ptt-friends-released` best-effort); `src/features/system/PttListener.tsx`; `src/stores/pttStore.ts`; `SessionView.tsx:497-509,220`.

The Rust handler emits release best-effort and PttListener has no failsafe. If one Released event is dropped, `pttStore.active` latches true and the mic stays open. Worse: the per-session reset doesn't reset `pttStore`, and the acquire effect reads `active` to set initial `track.enabled` — so a stuck state carries into the next session and brings its first audio track up **live (un-muted)**, violating PLAN §5 "default-muted." A privacy defect. Fix: (1) reset `pttStore` in the per-session reset + on teardown; (2) add a client-side failsafe (release after a max-hold timeout ~30s and on window blur).

### S3. Camera on/off toggle for the live session

**feature · 🟡 · M** — `src/features/session/SessionView.tsx:78` (`MEDIA_CONSTRAINTS = { video: true, audio: true }`); footer controls 1002-1045; `getFaceTrack` at 525 feeds the AI loop.

The footer has a mic picker and PTT but no way to turn the camera off mid-session — it's hardcoded on. For an app left running for hours, a momentary camera-off (step away, eat) is basic; today the only option is to leave entirely. Flip the local video track's `enabled` flag (peers see a paused tile) and **pause the AI loop** since `getFaceTrack` reads the local video track.

### S4. Audio output device + per-peer volume control

**feature · ⚪ · M** — `src/components/AudioDevicePicker.tsx`; `src/features/session/audioDevices.ts` (only `audioinput`); `VideoTile.tsx`.

No way to choose the speaker/headphone output (`setSinkId`) or adjust an individual peer's volume. Extend `audioDevices.ts` with `audiooutput` enumeration, apply `video.setSinkId` to peer tiles, optionally a per-tile volume slider. Local-only WebRTC APIs.

---

## AI focus-detection quality

The on-device pipeline computes signal it never uses and degrades silently in ways that mislead the user.

### A1. Make the benchmark request shape-identical to the real focus request

**bug · 🟡 · S** — `src/features/ai/benchmark.ts` (`runBenchmark` ~248-261) vs `src/features/ai/sampleLoop.ts` (`buildChatRequest` ~1020-1058).

The benchmark sends one image / `max_tokens:32` / no system prompt / no `response_format`; the live loop sends two images / `max_tokens:200` / the full `FOCUS_SYSTEM_PROMPT` / grammar-constrained decode (roughly double the prefill). `summariseBenchmark` derives `sampleIntervalSec` (and the slider min) from this, so the user is shown a cadence the machine can't sustain — real ticks overrun and get silently dropped. Reuse `buildChatRequest` (or a shared builder) so the two can't drift, mirroring the existing "byte-identical to `tests/ai-eval/run.ts`" discipline.

### A2. Treat malformed/empty model responses as uncertain, not `on_task`

**reliability · 🟡 · S** — `src/features/ai/parseJudgment.ts` (`buildFallback` → `severity:'on_task'`) → `sampleLoop.ts` tick → `scoreMachine.ts` step → `focusStore.ts` `applyJudgment`.

On any parse failure the fallback is `severity:'on_task'`, which (a) resets an in-progress off-task streak and (b) increments `onTaskSamples` feeding `focusedPct`. So a flaky sidecar returning garbage during a real distraction both cancels the pending alert _and_ makes the report claim more focus than reality. Add an "uncertain"/skipped path that neither resets the streak nor counts the sample (or counts it in a separate skipped tally excluded from `focusedPct`).

### A3. Consume `on_topic_confidence` in the score machine

**feature · 🟡 · M** — `src/features/ai/parseJudgment.ts` (validates `on_topic_confidence` ∈ [0,1], keeps it) and `scoreMachine.ts` `step()` (keys only on `severity`).

Every judgment carries `on_topic_confidence`, strictly validated, but `step()` and `applyJudgment` ignore it. The doc's own guidance is "false positives are worse than false negatives," yet the one signal that would let the pipeline act on model uncertainty is thrown away. Gate off-task streak increments on a confidence floor; expose the floor as a Settings → AI slider.

### A4. Add HTTP Range resume to model downloads

**ux · 🟡 · M** — `src/features/ai/ModelPickerContainer.tsx`; `src-tauri/src/commands/models.rs` (`run_download` has file-level sha256 resume; `download_one` has no Range/`.tmp` resume).

A completed hash-matching gguf is skipped, but within a single multi-GB file `download_one` always deletes the `.tmp` and re-GETs from byte 0. Close the app at 90% of a 4.6 GB file and you re-download the whole thing. Keep the `.tmp` across runs, send `Range: bytes=<tmp_len>-` when `Accept-Ranges` allows, seed the hasher from existing bytes (HF's CDN supports ranges). Reflect a "Resume" affordance in the picker.

### A5. Re-read the sidecar port after the capture await before POSTing

**bug · ⚪ · S** — `src/features/ai/sampleLoop.ts` `tick()`: snapshots `useSidecarStore.getState()` (~576), then after `await Promise.all([captureFace, snapshotScreens])` POSTs to the captured port (~639).

If the Rust watcher respawned the sidecar on a new ephemeral port during the capture window, the POST goes to a dead port and the tick wastes its budget on a guaranteed failure. Re-read `useSidecarStore.getState().port` immediately before the fetch and bail/reschedule if it changed.

### A6. Resolve the dangling "thermal-aware notice" in ARCHITECTURE §8

**feature · ⚪ · M** — `src/features/ai/sampleLoop.ts` (battery-branch comment cites §8 "thermal-aware notice"); `battery.ts`; `src-tauri/src/commands/system.rs`.

§8 calls for pausing AI with a thermal-aware notice, but the implementation only reads `on_battery` + `percent<20` — which never fires on AC power (the common study setup), exactly where continuous CPU vision inference throttles a fanless laptop. Either implement a lightweight cadence backoff (when consecutive ticks exceed measured p95 by a wide margin) with a one-shot notice — fully local — or correct §8 and the comment so the claim isn't dangling.

---

## Data, identity & recovery

The local-first model is sound, but several failure/recovery paths are unguarded in ways that risk a friend's identity or strand them — and there's no support channel.

### D1. Don't steer a corrupt-identity load into new-identity onboarding

**bug · 🔴 · M** — `src/stores/identityStore.ts:69-85` (refresh catch → status `'absent'`); `src/routes/Home.tsx:163-164` (absent → `<Onboarding>`); `src-tauri/src/commands/identity.rs:97-106`.

If `identity.json` is unparseable (bad serde, bit-rot, partial write), `refresh()` falls back to `'absent'`, Home renders Onboarding, and its create path overwrites the keychain keys. The private keys are still valid in the keychain, but the user is steered into a brand-new identity, abandoning their real one and stranding every friend who knows the old pubkey. Add an `error` `IdentityStatus`: when `identity_exists()` is true but the load throws, render "We couldn't read your identity file" with Retry + Recover — not create-new. At minimum, block `buildCommit.commit` when an identity exists unless an explicit overwrite is passed (as Recover already does).

### D2. Recover gracefully from a corrupt `app.db` instead of crashing at startup

**reliability · 🟡 · M** — `src-tauri/src/db/mod.rs:27-39`; `src-tauri/src/lib.rs:160-184` (setup `Err` → `.expect` panics).

A corrupt/partial/disk-full DB returns `Err`, the setup closure propagates it, and `.expect` panics — the app won't launch at all, with no message. Yet the DB holds only re-derivable secondary data (friends, history, audit). On open/migration failure, run `integrity_check`; if it fails, rename to `app.db.corrupt-<ts>` and recreate fresh (identity is in the keychain, untouched), with a one-time explanatory dialog. At minimum, replace the hard panic with a graceful error window.

### D3. Local friends-list backup/restore, encrypted to the user's own key

**feature · 🟡 · M** — `src-tauri/src/db/migrations/001_initial.sql` (`friends`); `src-tauri/src/commands/friends.rs` (no export/import); `IdentityCategory.tsx`; CHANGELOG V3-P2.

24-word recovery restores only the keypair — the recovery "done" screen tells the user "your friends list didn't come with it." A lost laptop means re-pairing with every friend via a fresh 12-word exchange. PLAN §5 listed identity export/import as a V1 settings feature that never shipped. Add "Export friends" / "Import friends" commands writing the rows to a file encrypted to the user's own X25519 key (or a passphrase), kept alongside the 24 words. Import upserts via the existing `friends::add ON CONFLICT(ed_pubkey)` path. File-based, local, no upload.

### D4. Turn the dead "Recovery phrase" settings row into an honest, actionable one

**ux · 🟡 · M** — `src/features/settings/categories/IdentityCategory.tsx:118-122` (hard-coded disabled); `src/features/onboarding/IdentityStep.tsx` (Recover only mounts during onboarding); `strings.ts:527-530`.

The mnemonic is shown once and never persisted (by design), but the Settings row is a dead disabled stub and the Recover flow is unreachable once an identity exists. Make the design explicit (re-display is impossible without storing the mnemonic) and offer the realistic alternative: a Settings action that opens the existing Recover flow (with overwrite-confirm) for the "move/restore this identity" case, plus copy stating "if you didn't save your 24 words, generate a new identity (you'll re-pair friends)."

### D5. Detect SAME vs DIFFERENT backup before the recovery overwrite warning

**ux · 🟡 · S** — `src/features/identity/Recover.tsx:81-86`; `src/stores/identityStore.ts:57-66` (`mnemonic_fingerprint` stored); `src/lib/crypto/identity.ts:146-152`.

The overwrite-confirm fires whenever an identity exists with generic copy, not distinguishing "you typed the SAME 24 words already here" (harmless no-op) from "you typed a DIFFERENT backup" (destructive). The app already stores `mnemonic_fingerprint`; compute it from the typed words and compare — skip the warning on a match, escalate copy on a mismatch. Pure-logic, node-testable.

### D6. Refuse to open a DB created by a newer app version

**reliability · ⚪ · S** — `src-tauri/src/db/migrations.rs:8-38` (`run_migrations` only applies version > applied; never checks applied > MAX_KNOWN).

With manual friends-only releases pulled out of order, a downgrade is plausible: install a newer build (schema 3), run an older build that knows up to 2, and the forward loop is a no-op — the old binary reads/writes a schema it doesn't fully understand. After computing `current`, if `current > MAX_KNOWN_VERSION` return a distinct "database was created by a newer version" error, paired with the graceful-failure window from **`D2`**.

### D7. Document the plaintext-at-rest boundary in the threat model

**security · ⚪ · S** — `src-tauri/src/db/mod.rs:27-39` (`Connection::open`, no cipher); `identity.rs:80-106` (`identity.json` plaintext); ARCHITECTURE.md §14.

Private keys live in the OS keychain (good), but `app.db` (friends' pubkeys, full session history, signed audit log) and `identity.json` are plaintext on disk. §14 never addresses on-disk confidentiality of the social graph. Arguably acceptable under friends-only, but undocumented. Add a §14 row stating it's plaintext-at-rest by design (relies on OS account security); treat SQLCipher-style encryption as a deliberate flagged future scope.

---

## Stats, report & focus history

Where users see the payoff of a session. Fix the score bug first so everything downstream is honest.

### R1. Stop persisting `score=100` for AI-off sessions

**bug · 🔴 · S** — `src/features/session/lifecycle.ts:101,130`; `src/features/ai/focusStore.ts:129-135` (`snapshotFocusForReport` returns `machine.score`); `scoreMachine.ts:41` (`INITIAL_SCORE=100`); consumed by `statsData.ts:192-202`.

`snapshotFocusForReport` returns `machine.score` = 100, never gated on `aiFeaturesEnabled` or `totalSamples>0`, and `buildLeaveHandler` always persists it. So every AI-off session is stored with `score=100`, and `statsData.averageScore` counts them all — an inflated, meaningless "Average score," plus a fabricated 100/100 gauge next to a blank focused-time. Return `score: totalSamples > 0 ? machine.score : null` (the report already has a `?? 100` fallback; `averageScore` already handles null).

### R2. Disambiguate "Focused minutes" (stats) from "Focused-time %" (report)

**ux · 🟡 · S** — `src/features/stats/statsData.ts:21-30,71-93` (`focusedMinutesForSession = total_minutes`); `strings.ts:822-825`; vs `Report.tsx:273-275` + `strings.ts:446` (`focused_pct`).

Stats labels raw presence minutes as "Focused minutes," while the report uses "Focused-time" for the AI on-task percentage — same word, two unrelated definitions in adjacent surfaces. Rename the stats label to "Study minutes" (or "Session minutes · last 30 days"), reserving "Focused" for the AI concept. Pure copy change.

### R3. File export for the report and a stats CSV

**feature · 🟡 · M** — `src/features/session/Report.tsx:258-267,597-667` (`serializeReportToText` → clipboard only); `src/features/stats/Dashboard.tsx` (no export).

The report has "Copy report" but no save-to-file, and stats has no export. `serializeReportToText` already produces clean markdown. Add a "Save as…" via `@tauri-apps/plugin-dialog` `save()` + `fs.writeTextFile`; optionally a "raw audit log (JSON)" dump and a stats "Export CSV" of daily study-minutes + partner counts. (Subsumes the per-session audit-log export ask.)

### R4. Session delete / clear-history affordance

**feature · 🟡 · M** — `src-tauri/src/commands/sessions.rs` (only insert/list/get); `SessionsCategory.tsx`; `AdvancedCategory.tsx`.

There's no `sessions_delete` or audit-clear command anywhere — a user must hand-edit the DB. Add `sessions_delete(id)` (DELETE sessions + audit_events for that topic in one tx) behind an `AlertDialog` confirm mirroring the FriendsCategory remove; optionally "Clear all history" in Advanced. Stats/report read from SQLite, so deletion flows through.

### R5. Match the copy-report section order to the on-screen order

**ux · ⚪ · S** — `src/features/session/Report.tsx` — on-screen Distractions (391) then Breaks (414); `serializeReportToText` (626-664) emits Breaks then Distractions.

The copied/exported text reorders sections relative to what the user just saw. Reorder the `lines.push` blocks so the text matches the render. One-block move.

### R6. Surface how many sessions are unscored in the average-score tile

**ux · ⚪ · S** — `src/features/stats/Dashboard.tsx:159-168`; `statsData.ts:185-202` (`ScoreSummary.scoredSessions`).

Once **`R1`** lands, the average is over the AI-scored subset only; "Average 87" from 2 of 40 sessions is easy to over-read. When `scoredSessions` is small relative to `totalSessions`, surface it prominently ("from 2 of 40 sessions") or render a muted "limited data" state. Depends on `R1`.

### R7. Local focus-insights view across sessions

**feature · 🟡 · L** — `src/features/ai/focusStore.ts` (per-session tallies, not persisted); `src/features/session/reportData.ts`; `src/features/stats/statsData.ts` (`audit_events` deliberately not queried).

The pipeline produces rich per-streak `ai_warning`/`ai_alert` reasoning, shown only in the single post-session report. There's no "when do I lose focus" view: time-of-session distraction pattern, recurring reasons, or `focused_pct` trend. Add a local-only insights surface reading `audit_events` + `sessions.score`/`focused_pct` from SQLite. Strictly local; reuse `reportData`'s distraction aggregation at the multi-session level.

---

## Release & distribution

Mature for a friends-only project, but a few gaps bite real friends.

### X1. Gate the release on CI-green before tagging `main`

**reliability · 🔴 · S** — `.github/workflows/release-prep.yml` (bump/commit/tag with no gate); `release.yml` (no lint/test/fmt/clippy/check-\* steps); `.husky/pre-commit` (comment names v1.0.3/v1.0.5/v1.2.0 cancellations).

`release-prep` bumps the five version files, commits, tags, and pushes to `main` with zero quality gate, then dispatches `release.yml` (whose only check is tsc+vite). When a gate fails you're left with a pushed bump commit + tag on `main` and a half-built release — the pre-commit comment documents this cancelling three real releases on cargo-fmt alone. Add a gate job (`lint && test && build && check-tokens && check-strings`, plus `cargo fmt --check`) that must pass before bump/tag/push.

### X2. Build the Intel Mac `x64.dmg` the docs promise (or drop the claim)

**bug · 🔴 · S** — `.github/workflows/release.yml` (matrix only `aarch64-apple-darwin` + Windows x64); `INSTALL.md:7-9`; `README.md:56`; `scripts/fetch-llama-server.sh` (`x86_64-apple-darwin` IS in `SUPPORTED_TRIPLES`).

INSTALL/README tell Intel users to download `StudyVis_<version>_x64.dmg`, but no `x86_64-apple-darwin` job exists — an Intel-Mac friend hits a 404. The sidecar triple is already ready. Either add a third matrix entry (`x86_64-apple-darwin`, `--bundles app,dmg`) or delete the Intel promise. Pick one.

### X3. Run `check-strings` in CI

**reliability · 🟡 · S** — `.github/workflows/ci.yml` (frontend job runs `check-tokens`, `check-contrast`, `check-a11y` but NOT `check-strings`); `.husky/pre-commit:3`.

`check-strings` is a single-source-of-truth house-rule gate that runs in pre-commit but is missing from CI, while its sibling `check-tokens` is present. Since the hook can silently drift (`core.hooksPath`), CI is the only reliable backstop. Add the step next to `check-tokens`.

### X4. Opt-in, OFF-by-default new-version notification

**feature · 🟡 · M** — `src/features/settings/categories/AboutCategory.tsx` (static "Open Releases"); `src-tauri/src/commands/system.rs:232-239` (`system_open_releases`); `Cargo.toml:31` (`reqwest` already a dep); `strings.ts:790`; **PLAN.md §3** ("Outbound data beyond P2P + Nostr signaling: zero").

With no auto-update, friends only learn a new release exists out-of-band and can sit on an old buggy version indefinitely. ⚠️ **This is not a free no-telemetry win** — it sends no user data but **does break PLAN §3's "zero outbound,"** so it requires an explicit principle carve-out and must ship OFF by default. When enabled: unauthenticated GET of the public GitHub Releases API, parse `tag_name`, compare to `__APP_VERSION__`, show "A newer version is available." Zero identifiers; best-effort/silent on failure. Amend PLAN §3 to carve out an opt-in no-payload check. Do **not** bundle auto-download (rides on signing — see **`P2`**).

### X5. Reduce macOS Gatekeeper friction via ad-hoc signing

**ux · ⚪ · M** — `.github/workflows/release.yml` (no codesign step); `INSTALL.md` (right-click-to-Open); `tauri.conf.json`.

The dmg ships fully unsigned (accepted scope). The downside is real first-run friction — depending on OS version, the right-click-Open dance can still throw a hard "damaged / cannot be opened" error. Add an ad-hoc `codesign --force --deep --sign - StudyVis.app` step (no Apple account needed) to reduce the hard-block to the milder "unidentified developer" prompt; document the `xattr -dr com.apple.quarantine` fallback. Do **not** propose paid notarization (conflicts with the unsigned decision).

### X6. Resolve the dormant `tauri-plugin-updater` dependency

**tech-debt · ⚪ · S** — `src-tauri/Cargo.toml:37` (`tauri-plugin-updater = "2"`); `src-tauri/src/lib.rs:381-382` (comment: registration deferred to V3); no capability/config references it.

Compiled into every build for zero runtime effect. Decide remove-or-activate: wire it up as part of version-check work, or remove it until V3 actually enables auto-update (keep the re-enable checklist).

### X7. Document the npm audit triage (9 vulns are dev-only)

**security · ⚪ · S** — `package.json` devDependencies (`concurrently@9 → shell-quote` [critical], `@storybook/test-runner` chain [moderate]); none in `dependencies`.

`npm audit` reports 9 vulns (2 critical, 7 moderate), but every one is in a devDependency — none reach the installed desktop app. Make the triage explicit so it isn't re-flagged each scan: bump `concurrently` and `@storybook/test-runner` when convenient, and note in the ledger that these are dev-only with no runtime exposure. Don't rush a major Storybook bump for a dev-only advisory.

---

## New features & cross-cutting lifecycle

Surfaced by the completeness critic — tray-app fundamentals and realistic study-with-friends affordances the themes gesture at but never file.

### N1. Single-instance guard so relaunch focuses the existing window

**reliability · 🔴 · S** — `src-tauri/Cargo.toml` (no `tauri-plugin-single-instance`); `src-tauri/src/lib.rs:160` setup / `:424` global-shortcut registration; minimize-to-tray is on via `MinimizeToTrayFlag`.

Nothing prevents a second process. With close-to-tray on, relaunching while the window is hidden spawns a second instance: a duplicate global-hotkey registration, a second tray icon, a second Nostr presence daemon under the same identity, and two processes opening the same `app.db` (the `std::sync::Mutex` pool only serializes within one process). Add `tauri-plugin-single-instance`, registered first; in its callback `show()`/`set_focus()` the existing window (and pass through any deep-link argv — see **`F10`**). Gives free restore-on-relaunch.

### N2. OS notification on pomodoro work↔rest transitions

**feature · 🔴 · S** — `src/features/session/pomodoro.ts` (only consumer-facing signal is `BreakCountdownBadge`/`SessionTimer`); the sole `sendNotification` today is `src/features/friends/InboxBoot.tsx:134`; `NotificationsCategory.tsx`.

The single most common study-app notification — "time for your break" / "back to work" — doesn't exist. With minimize-to-tray on, the window is hidden during a focus block, so the boundary is invisible. On a **local** phase flip, call `sendNotification` reusing the InboxBoot permission/copy pattern, gated by a new opt-out. Read the local phase only — must not touch the `I9` broadcaster authority (no protocol change).

### N3. Optional "friend came online" notification

**feature · 🟡 · M** — `src/features/friends/presence.ts` (no proactive online signal); reuse `InboxBoot.tsx:134`; toggle in `NotificationsCategory.tsx`.

A user only learns a friend is available by opening the app. "Alex is now online" is exactly when you'd invite, and it complements the offline-invite dead-end (**`F6`**) and timezone mismatch. On an offline→online flip (debounced), fire an opt-in, OFF-by-default notification with a per-friend/global mute. Honest about ~60s presence latency. Local read only.

### N4. Confirm before quitting during an active session

**ux · 🟡 · S** — `src-tauri/src/lib.rs:136-156` (CloseRequested honors a real quit unconditionally when minimize-to-tray is OFF) + the Cmd+Q / QuitFlag path; active-session state in `sessionStore.ts` / `SessionView.tsx:766`.

With minimize-to-tray off (or Cmd+Q with QuitFlag armed), the app quits immediately mid-session — peers see you vanish (can trigger the everyone-left auto-end) and a long session ends on an accidental Cmd+Q. When `sessionStore` reports an active session, intercept the quit with a "Leave your session and quit?" confirm; skip it when no session is active.

### N5. Custom pomodoro durations (wire-compat aware)

**feature · 🟡 · M** — `src/lib/pomodoro-types.ts` (`PomodoroPhase` closed enum; `PomodoroPreset` `'25/5' | '50/10'`); `pomodoro.ts:45-48` (`PRESET_DURATIONS` hardcoded); broadcast wire shape `phase: 'work'|'rest'` + `preset`; `SessionTimer.tsx:142-154`.

Only 25/5 and 50/10 are offered; many methods use other splits (45/15, 90/20). ⚠️ **Not a quick win:** the phase enum and the `work|rest`+`preset` broadcast are a cross-version wire contract — needs a backward-compatible story (carry explicit `durationMs` with a `preset` fallback so older peers still render work/rest) so a custom-duration host doesn't strand a friend on an older build.

### N6. Optional audio cue on break / phase transitions

**feature · ⚪ · S** — no audio-cue code exists anywhere (no `new Audio()`/`.play()` in `src/`); transition points in `pomodoro.ts` and `break.ts` / `BreakCountdownBadge.tsx`.

A user mid-focus with the window in the tray gets no signal a break started/ended. Play a short bundled chime (data-URI, like the inlined opus in V2-P6) on transitions, gated by an opt-out and respecting the reduced-motion accessibility posture (default off or clearly toggleable). Local asset.

---

## Strategic / credential-gated

Larger investments the docs gesture at but never made actionable.

### P1. Turn the Linux deferral into a concrete unblock checklist

**feature · 🟡 · L** — `release.yml` (no Linux job); `src-tauri/Cargo.toml:41-53` (`keyring` gated to macos/windows only); `src-tauri/src/commands/system.rs:245` (battery safe-default for Linux); PLAN §5/§7 + ARCHITECTURE §12.

Linux is gated entirely on one unverified question (WebKitGTK `getDisplayMedia`) unanswered since V0, framed vaguely so it never moves. The blockers are concrete: (a) re-run the V0 `getUserMedia` + `getDisplayMedia` + trystero smoke test under WebKitGTK on a current distro; (b) if `getDisplayMedia` passes, add keyring's libsecret/secret-service feature for `cfg(target_os="linux")` and a `.AppImage` job; (c) confirm the battery fallback. If `getDisplayMedia` still fails, ship **AI-off Linux** (body-doubling doesn't need it — only AI screen capture does) rather than blocking the whole platform.

### P2. Record signing / notarization / auto-install as one credential-gated roadmap item

**tech-debt · ⚪ · L** — `src-tauri/Cargo.toml:37` (dormant updater); `tauri.conf.json` (no updater pubkey/endpoints); `release.yml` (`includeUpdaterJson: false`); ARCHITECTURE §2/§12.

Every friend hits a Gatekeeper/SmartScreen prompt on every install, and the updater plugin sits inert. It's tempting to file "turn on the updater" as a quick win, but it's hard-blocked: no Developer ID / EV cert, no updater pubkey/endpoints — auto-update can't be verified without signed artifacts. Record as one entry with a clear trigger (certs acquired) and the existing re-enable checklist (updater registration, `tauri.conf.json` pubkey/endpoints, `includeUpdaterJson`, signing secrets, drop the right-click/SmartScreen language from INSTALL.md). Its cheap-now half is **`X4`**; auto-install rides on signing and stays deferred.

---

## At a glance

- **Top bugs:** **R1**, **S2**, **S1**, **D1**, **A2**, **F1** · plus doc-drift bugs **F8**, **X2**.
- **Quick wins (high impact / small effort):** **R1**, **S2**, **X1**, **X2**, **F8**, **X3**, **U1**, **N1**, **N2**.
- **Big bets (high impact / large effort):** **R7** focus-insights, **D3** friends-list backup, **P1** Linux.
- **Your stated priorities:** friend-finding (**F1**–**F10**) and UI/UX (**U1**–**U7**).
