# StudyVis audit ledger

Baseline before audit: `tsc -b`, `eslint`, `vitest`, `cargo test/fmt/clippy`, `vite build`, `cargo check --locked` all green. All findings are logic / correctness / security, not build failures.

Severity: Sev1 = data loss / security hole / crash / broken core flow. Sev2 = incorrect behavior or spec violation with real user impact. Sev3 = minor. Sev4 = nit.

Round 1 (`audit/sev1-sev2-fixes`, PR #29): every Sev1/Sev2 fixed. Round 2 (`audit/sev3-sev4-fixes`): every actionable Sev3/Sev4 fixed; three items surfaced as conflicting with a canonical doc and left deferred per the CLAUDE.md "surface the conflict, don't silently deviate" house rule. Rows from I19 onward are ongoing-maintenance triage entries appended after those two rounds (from the maintenance/feature line, not either audit round), kept here so a finding isn't re-investigated each time it resurfaces.

**Production-readiness round (v1.3.1, `claude/production-readiness-yg17gr`).** A 13-subsystem multi-agent audit with adversarial verification, run because the v1.2.2 Nostr+MQTT pairing race and the entire v1.3.1 offline ContactCard feature had never been audited. Rows I20+ record its confirmed fixes and its deferrals. Deferrals fall in two buckets: (a) **accepted under the friends-only threat model** — now documented in ARCHITECTURE §14 (I46 invite delivery false-positive, I47 presence spoofing); (b) **deferred with a clear reason** — an upstream trystero leak (I48), a wire-sensitive refactor not worth bundling into a broad sweep (I49), and a defense-in-depth config change that needs a desktop smoke-test to land safely (I50).

**Improvement wave 3 (post-v1.6.0, `feat/improvements-wave3`).** A 12-subsystem multi-agent survey with per-finding adversarial verification, then a multi-lens review of the branch (the three low-severity findings it confirmed were fixed on-branch). Rows I51+ record the confirmed fixes; each shipped as its own commit with tests where the harness allows. Test-only and doc-only outcomes (rendezvous-derivation vectors, signed-hello gate coverage, inbox replay coverage, and the DESIGN-SYSTEM §4 / ARCHITECTURE §11–§12 / README true-ups) are not ledgered separately.

Format: one `###` section per finding, ordered by ID. Entries are appended, never renumbered — an ID is a permanent handle cited from code comments, commits and CI config. This file is in `.prettierignore`: it was a five-column table whose cells grew to 5 KB, and Prettier's column alignment padded every row to the widest one (631 KB of the 707 KB was trailing spaces).

## Findings

### I1 — Sev1

`src/features/session/pomodoro.ts`

**Evidence.** `stop()` sent no wire signal; receivers' 10 s silence timer resurrected the timer under a new broadcaster ~10 s after Stop.

**Status.** **fixed** (R1) — explicit `stopped:true` message; receivers reset to idle. ARCHITECTURE §7 updated.

### I2 — Sev2

`src/features/friends/presence.ts`

**Evidence.** Online state compared sender wall clock to receiver's; backward sender clock step wedged presence permanently.

**Status.** **fixed** (R1) — stamp receiver-local time on receive.

### I3 — Sev2

`src/features/session/lifecycle.ts` + `sessionStore.ts`

**Evidence.** Everyone-else-leaves auto-end lost `sessions.peer_pubkeys` + `markStudied` because `peerLeft` pruned `peers` first.

**Status.** **fixed** (R1) — cumulative `seenPeerEdPubkeys` set.

### I4 — Sev2

`src/features/ai/benchmark.ts`

**Evidence.** p95 included the cold-start warmup sample, inflating the sample floor 5–10× with no user recourse.

**Status.** **fixed** (R1) — run + discard one warmup sample.

### I5 — Sev2

`src-tauri/src/commands/models.rs`

**Evidence.** Resume fast-path hashed a multi-GB GGUF synchronously on the async runtime, stalling concurrent IPC.

**Status.** **fixed** (R1) — moved to `spawn_blocking`.

### I6 — Sev3

`src/features/ai/sampleLoop.ts`

**Evidence.** Battery-pause branch omitted the §8 "thermal-aware notice" and rescheduled at the sample interval, not 60 s.

**Status.** **fixed** (R2) — `onBatteryPause`/`onBatteryResume` callbacks (fire once each) wired to SessionView toasts; paused branch now reschedules at `BATTERY_POLL_INTERVAL_MS`. Regression test added.

### I7 — Sev4

`src/features/session/invite.ts`

**Evidence.** Auditor flagged idle-invite `hostSession()` as bypassing the topic gate.

**Status.** **not a bug** — `Home.tsx` enforces `TopicGateModal` (sets `pendingInitialTopic`) before `inviteToCurrentSession`; no other caller. No change.

### I8 — Sev3

`src/features/session/SessionView.tsx`

**Evidence.** Audit receive did not check `session_topic` (the ai-alert path does).

**Status.** **fixed** (R2) — added `verified.session_topic !== sessionTopic` drop, mirroring `aiAlerts.ts`.

### I9 — Sev3

`src/features/session/pomodoro.ts`

**Evidence.** Any peer sending a valid signed `pomodoro` msg is accepted as broadcaster, even mid-broadcast by another.

**Status.** **deferred — conflicts with canonical doc.** ARCHITECTURE §14 explicitly: "Friend disables their own AI / fakes score — **Not defended. Social trust. Accepted.**" The "most recent sender becomes broadcaster" behavior is a deliberate, code-documented reconnection-robustness choice; hardening it would silently deviate from the accepted friends-only threat model and risk regressing the documented original-broadcaster-returns path. Surfaced per house rule; user can override to request the hardening explicitly.

### I10 — Sev3

`ARCHITECTURE.md §7`

**Evidence.** `score_final` wire type has no producer/consumer.

**Status.** **fixed (doc)** (R2) — §7 annotated: `score_final` is reserved/not-implemented in V2; the report is local-SQLite by V2-P8 design; type kept so a future phase avoids a breaking wire change. Not removed (removal would be a forward-compat break).

### I11 — Sev3

`src/features/ai/sampleLoop.ts`

**Evidence.** Declared topic interpolated into the focus prompt without injection delimiters.

**Status.** **fixed** (R2) — topic wrapped in `<declared_topic>` + labelled as data; system-prompt rule added; `FOCUS_SYSTEM_PROMPT_VERSION` → 2; `tests/ai-eval/run.ts` kept byte-identical; ARCHITECTURE §8 prompt updated.

### I12 — Sev3

`src/features/ai/aiAgent.ts`

**Evidence.** Total JSON-parse failure echoed ≤200 chars of raw model output into the dialog.

**Status.** **fixed** (R2) — fixed safe string to the user; raw logged to console only. Test updated.

### I13 — Sev3

`src-tauri/capabilities/default.json`

**Evidence.** `ai-dialog` window granted `notification`/`store`; §12 says permissions are main-window-scoped.

**Status.** **fixed** (R2) — `default.json` restricted to `["main"]`; new `ai-dialog.json` capability scoped to the dialog window with `core:default` only (it uses only core event/window IPC).

### I14 — Sev3

`src-tauri/src/db/migrations.rs` + `001_initial.sql`

**Evidence.** Bare `CREATE TABLE` + no single-instance ⇒ two simultaneous first-launches could panic the second.

**Status.** **fixed** (R2) — `IMMEDIATE` transaction with the version read moved inside the tx (locks before reading); `IF NOT EXISTS` on 001's DDL; `INSERT OR IGNORE` on `schema_version`. Sequential-upgrade tests preserved.

### I15 — Sev3

`src/stores/identityStore.ts` / `identity.rs`

**Evidence.** Identity commit (keychain then file) had no rollback; a failed file write + re-onboard overwrites the keychain entry.

**Status.** **mitigated** (R2) — the file write is now atomic (see I16); residual is now only "rename succeeded but the keychain `set` itself fails", an OS-keychain fault recoverable via BIP39 (PLAN §7). Full two-store transactionality is out of scope for a Sev3.

### I16 — Sev3

`src-tauri/src/commands/identity.rs`

**Evidence.** `fs::write` non-atomic; a crash mid-write truncates `identity.json`.

**Status.** **fixed** (R2) — write to `*.json.tmp` then `fs::rename` over the target (atomic on same FS); temp cleaned on rename failure.

### I17 — Sev3

`src-tauri/src/db/sessions.rs`

**Evidence.** `started_at`/`ended_at`/`total_minutes` overwritten while the comment claimed additive upserts.

**Status.** **fixed (comment)** (R2) — comment rewritten to state these three are deliberately authoritative-overwrite (a re-summarize must be able to correct them; COALESCE would swallow it) while the report columns are additive. No behavior change, by design.

### I18 — Sev4

`pair.ts` / `lib/trystero/index.ts` / `sidecar.rs`

**Evidence.** `verifyHello` didn't reject self-pubkey; stale `selfId` comment; `sidecar_start` trusts JS `model_path`.

**Status.** **partially fixed** (R2). `verifyHello` now rejects a hello whose `ed_pubkey` equals the local identity (passed `ctx.edPubHex` from `runPair`). `trystero/index.ts` comment corrected to describe the actual module-global-`selfId` mechanism. The `sidecar_start` model-path sandbox is **deferred — conflicts with canonical doc**: PLAN §5 explicitly promises "Advanced users can point at any local GGUF", so constraining `model_path` to `data_dir/models` would break a documented feature. Surfaced per house rule.

### I19 — Sev4

`package.json` devDependencies

**Evidence.** `npm audit` flags ~20 dev-chain advisories across critical/high/moderate (criticals: `concurrently@9` → `shell-quote`; highs/moderates span the `@storybook/*` and `esbuild`/`tsx` chains). Re-flagged on every scan.

**Status.** **triaged — no runtime exposure** (2026-06-13). Every one is a **devDependency**; none reaches the installed desktop app — `npm audit --omit=dev` is clean (0) and no advisory package appears in `dependencies`. Bump `concurrently` and the `@storybook/*` chain when convenient; do **not** rush a major Storybook upgrade for a dev-only advisory. Recorded so the scan result isn't re-investigated each time. (Exact counts shift with the lockfile; the load-bearing fact is the clean prod audit.)

### I20 — Sev1

`src-tauri/src/db/mod.rs`

**Evidence.** `is_definitely_corrupt` only treated a non-"ok" `integrity_check` verdict as corruption; a truncated file (SQLITE_CORRUPT) or damaged header (SQLITE_NOTADB) makes the pragma ERROR, so recovery never fired and the app bricked on every launch after a power-loss/force-kill.

**Status.** **fixed** — classify by SQLite error code; also clean up `-journal`/`-wal`/`-shm` on rename. Corruption-signature tests added.

### I21 — Sev2

`src-tauri/capabilities/ai-dialog.json`

**Evidence.** The scoped ai-dialog capability lacked `core:window:allow-close`, so the floating AI dialog's Esc/blur/X all silently failed (regression from the I13 scope-down).

**Status.** **fixed** — grant `core:window:allow-close`.

### I22 — Sev2

`src/features/session/reportData.ts` + `stats/statsInsights.ts`

**Evidence.** Report topic-timeline / top-distractions and cross-session insights walked every audit event; peers' broadcast `topic_set`/`ai_alert` (persisted locally) were misattributed to the local user.

**Status.** **fixed** — thread the local ed_pubkey and filter to it (matches the self-only score gauge / trend).

### I23 — Sev3

`src/features/ai/sampleLoop.ts`

**Evidence.** `onScreenTrackEnded` latched `captureDenied` and tore down ALL AI capture when ANY screen track ended; unplugging a secondary display in "All displays" mode killed focus detection with a misleading permission overlay.

**Status.** **fixed** — discriminate: drop the dead display, latch only when the last live one ends.

### I24 — Sev2

`src-tauri/src/commands/models.rs`

**Evidence.** No read/idle timeout on downloads; a mid-stream stall hung `bytes_stream().next()` forever, freezing the UI and permanently locking the `model_id`.

**Status.** **fixed** — 60s `read_timeout`.

### I25 — Sev2

`src-tauri/src/commands/system.rs`

**Evidence.** `system_relaunch_app`'s `app.restart()` skips `RunEvent::Exit` (the only sidecar kill), orphaning a running llama-server on Window-Style relaunch.

**Status.** **fixed** — `kill_blocking` before restart.

### I26 — Sev2

`src-tauri/src/lib.rs`

**Evidence.** A boot-time global-shortcut OS conflict propagated out of `setup()` into `build().expect()`, panicking before first paint.

**Status.** **fixed** — register best-effort; a failed binding is inert until rebound in Settings.

### I27 — Sev3

`src/features/friends/invite.ts` + `inviteRetry.ts`

**Evidence.** An invite retry queued after the 15s send timeout escaped `cancelAll` if the session ended during the window, later pulling the friend into a dead room.

**Status.** **fixed** — injected `isSessionLive` guard: a retry never fires for a session that isn't the host's current live one.

### I28 — Sev3

`src/lib/fileExport.ts`

**Evidence.** CSV export didn't neutralize spreadsheet formula injection; a peer-chosen display name beginning with `= + - @` executed on open (=HYPERLINK exfil / DDE).

**Status.** **fixed** — quote-prefix string cells starting with a trigger; numeric cells untouched.

### I29 — Sev2

`src/features/friends/AddFriendDialog.tsx`

**Evidence.** A programmatic close (contact-card deep link) during an in-flight legacy pairing never aborted it — Radix doesn't fire `onOpenChange` on a parent-driven close — leaking the trystero room + relay sockets.

**Status.** **fixed** — tear down on any `open` transition.

### I30 — Sev3

`src/features/friends/inbox.ts`

**Evidence.** No replay/dedup on the inbox receive path; a stranger on the pubkey-derived inbox topic could re-broadcast a captured envelope to re-fire the invite toast/notification.

**Status.** **fixed** — dedup on `(from_ed_pubkey, box nonce)`, TTL-bounded. §14 row added.

### I31 — Sev3

`src/features/friends/AddFriendDialog.tsx` + `lib/relayDiagnostics.ts`

**Evidence.** Pairing's "network trouble" hint read only the Nostr socket map, so it wrongly blamed the user's network in the exact MQTT-fallback case the v1.2.2 race was built to survive.

**Status.** **fixed** — transport-aware `pairingRelaysUnreachable()` judging both socket maps; Nostr-only signal kept for the invite path.

### I32 — Sev3

`src/routes/Home.tsx`

**Evidence.** `PairDeepLinkBoot` rendered only in the non-session tail, so a `studyvis://` link clicked mid-session reached zero listeners and was dropped.

**Status.** **fixed** — render the full tail in the active-session branch.

### I33 — Sev3

`src/strings.ts`

**Evidence.** In-app AI copy promised screen access is requested "when you start your first session", but enabling AI requests it immediately.

**Status.** **fixed (copy)** — reword to match the shipped enable-time prompt.

### I34 — Sev3

`src-tauri/src/lib.rs`

**Evidence.** With minimize-to-tray off, closing the main window while the AI dialog was open stranded the app: process alive, main window gone, tray "Open" a no-op.

**Status.** **fixed** — destroy the AI dialog on that close path so the runtime exits.

### I35 — Sev3

`src-tauri/src/commands/sidecar.rs`

**Evidence.** The crash-restart watcher could spawn a fresh llama-server after `kill_blocking` already ran at quit (during the backoff window), orphaning it.

**Status.** **fixed** — `shutting_down` flag re-checked after backoff, before respawn.

### I36 — Sev3

`src/design/theme.tsx`

**Evidence.** `ThemeProvider` wrote the pre-hydration fallback `dark` class, stripping the boot-cache `light` class and flashing dark for light/auto users.

**Status.** **fixed** — defer to the boot script until an authoritative mode exists.

### I37 — Sev4

`src/features/friends/pair.ts`

**Evidence.** The legacy pairing hello's (unsigned) `display_name` was stored/rendered raw, unlike the ContactCard path's cap + bidi/zero-width sanitize.

**Status.** **fixed** — shared `normalizeUntrustedName` applied on both paths.

### I38 — Sev3

`src/features/ai/sidecar.ts`

**Evidence.** `useSidecarStore.start()` unconditionally set `running` after its await, clobbering an interleaved `stop()` and leaving the store `running` on a killed process.

**Status.** **fixed** — bail if a stop intervened.

### I39 — Sev3

`src/App.tsx` + `src/components/ErrorBoundary.tsx`

**Evidence.** No React error boundary anywhere; any render throw blanked the whole window and killed the always-on inbox/presence + live session.

**Status.** **fixed** — top-level `ErrorBoundary` around the routed content with a calm "Try again".

### I40 — Sev4

`src-tauri/src/commands/system.rs`

**Evidence.** Changing one PTT shortcut when both shared a combo (hand-edited settings.json) unregistered the other.

**Status.** **fixed** — only unregister the old combo when the other action isn't still using it.

### I41 — Sev4

`src/lib/encoding.ts`

**Evidence.** `hexToBytes` used `parseInt` per byte, silently mis-decoding malformed hex ('1g'→0x01, '-a'→wraps) instead of rejecting.

**Status.** **fixed** — validate the whole string against `/^[0-9a-fA-F]*$/` first. Adversarial-input tests added.

### I42 — Sev3

`src/features/session/SessionView.tsx`

**Evidence.** The local session camera/mic stream had no `ended` listener, so a mid-session device loss (unplug / OS-revoke / another app grabbing the camera) left peers on a frozen tile and silently killed the AI face path.

**Status.** **fixed** — attach an `ended` listener that surfaces the existing "Try again" recovery banner.

### I43 — Sev3

`.github/workflows/ci.yml`

**Evidence.** CI compiled only aarch64-apple-darwin, so `#[cfg(target_os="windows")]` code first built inside `release.yml` AFTER the tag was pushed.

**Status.** **fixed** — macOS + Windows Rust matrix on every push/PR.

### I44 — Sev3

`.github/workflows/release-prep.yml`

**Evidence.** The one-click gate skipped `check-a11y` and all Rust compilation, so a release could be cut over an axe-core / clippy regression.

**Status.** **fixed** — add the a11y gate; require the exact main SHA's CI run to be green before bump/tag/push.

### I45 — Sev3

`README.md` / `PLAN.md` / `ARCHITECTURE.md` / `CHANGELOG.md`

**Evidence.** User-facing doc drift: first-run described the retired 12-word flow as primary; "one WebSocket" (really ~8 relays); "three tiers" (four models); "v1.2.0 is current" (v1.3.1); §6 "MQTT not yet wired" (raced since v1.2.2); changelog x86_64 DMG claim (aarch64-only).

**Status.** **fixed** — brought each in line with the shipped code.

### I46 — Sev3

`src/features/friends/invite.ts`

**Evidence.** `sendInviteEnvelope` treats any peer joining the recipient's inbox topic as delivery, so an eavesdropper on that shared pubkey-derived topic can appear as "delivered" or drop the invite.

**Status.** **accepted — friends-only threat model.** Envelope is still NaCl-box-sealed to the recipient; worst case is a suppressed offline-retry (re-click Invite). Documented in §14. The flagged signed invite-ACK shipped in #47 C2 (new `invite-ack` action, v1.2.x-wire-compatible: no ACK within the window → honest "unconfirmed" copy) — for UX legibility, not as a defense; the eavesdropper acceptance above stands.

### I47 — Sev3

`src/features/friends/presence.ts`

**Evidence.** Presence heartbeats/goodbyes are unauthenticated on a pubkey-derived topic, so a stranger with a friend's public pubkey can forge that friend's online/offline state.

**Status.** **accepted — friends-only threat model.** Presence is soft UX state, not a data/session compromise. Signing would break cross-version presence (older peers send unsigned), so enforcement is deferred, not shipped. Documented in §14.

### I48 — Sev3

`src/features/friends/pair.ts` (upstream `@trystero-p2p/mqtt`)

**Evidence.** Each pairing's MQTT room open→leave orphans ~4 broker connections: trystero-core sets `didInit=false` on last-room-leave but never `.end()`s the MQTT clients.

**Status.** **deferred — upstream trystero bug.** Bounded (a handful of pairings per session, cleared on process exit) under the friends-only 4-peer model. Fix is upstream (or an app-side always-on MQTT room, which trades the leak for a persistent idle broker connection — not worth it).

### I49 — Sev3

`src/features/friends/InboxBoot.tsx` + `presence.ts`

**Evidence.** The presence effect keys on the whole friend set, so adding/removing any friend tears down + rebuilds the own presence room, broadcasting a goodbye that flickers your presence offline→online on every other friend's screen (and can fire a spurious "came online" notification).

**Status.** **fixed** (#47 C6, the recorded dedicated pass) — `startPresence` gained `updateFriends`: friend list edits diff rooms in place (join added / leave removed), the own room and heartbeat cadence never churn, and `leave()`'s tested goodbye semantics are untouched. InboxBoot keys the subscription on identity only and drives list edits through the diff; removed friends' notify baselines are pruned so a re-add starts fresh. Unit tests cover added/removed/no-op churn including a watcher asserting no goodbye flicker.

### I50 — Sev4

`src-tauri/tauri.conf.json`

**Evidence.** Both webview windows ship with CSP disabled (defense-in-depth only — no reachable XSS sink today: React auto-escapes, no `innerHTML`/`eval`).

**Status.** **deferred — needs a desktop CSP smoke-test.** A wrong CSP hard-breaks Tauri IPC/asset loading, which no static gate catches; landing a `script-src 'self'` policy safely requires running the built desktop app (not possible headless). Recommended policy: `default-src 'self'; script-src 'self'; object-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss: http://127.0.0.1:*`.

### I51 — Sev2

`src/routes/Home.tsx`

**Evidence.** The `tail` fragment (InboxBoot + deep-link + import dialog + topic gate) rendered at a different unkeyed child index per view branch, so React reconciled by index and re-mounted the always-on presence/inbox room on every view switch — re-triggering the I49 goodbye flicker, blanking the friends list for up to a heartbeat, and dropping an invite that arrived in the teardown window.

**Status.** **fixed** — `<Fragment key="app-tail">` pins the tail fiber across branches of differing child arity. The load-bearing key is documented at the site; `pairDeepLink.ts`'s stale "view switches re-mount the boot" comment corrected (the `launchConsumed` guard kept). Not statically checkable and not node-testable without RTL, so protected by the site comment.

### I52 — Sev2

`src/features/session/lifecycle.ts` + `stores/sessionStore.ts`

**Evidence.** `total_minutes` was pure wall-clock `endedAt − startedAt`, counting OS-sleep/suspend as study time; a session slept on persisted the whole span (a free streak day and inflated totals).

**Status.** **fixed** — elapsed is `min(wallMs, monoMs)` off a `performance.now()` origin captured at start, mirrored in the live footer. Not retroactive (old rows stand); degrades to prior behavior on a platform whose monotonic clock happens to include suspend, never undercounts. Unit-tested via an injectable `monotonicNow` seam (awake / slept-through / backward wall clock / no-mono fallback / slept-through rejoin).

### I53 — Sev3

`src/features/session/lifecycle.ts` + `SessionView.tsx`

**Evidence.** A peer's deliberate `left` (signed, on the wire since V1-P9) still armed the 20 s reconnect grace and offered a Rejoin into a dead room.

**Status.** **fixed** — mark departed peers, and skip the grace/Rejoin only when the room empties with no unexplained absence remaining, via a new `SessionEndReason` (`'peer'`). Unexplained-absent peers are tracked in a Set (not a single flag, per the review) so an intervening join by another peer can't strand a still-absent blipper; the mark clears per-peer on rejoin so a later blip still gets grace. ARCHITECTURE §13 updated. Grace unit tests extended.

### I54 — Sev3

`src/features/friends/InboxBoot.tsx` + `friendOnlineNotify.ts`

**Evidence.** The friend-online baseline suppressed every friend's _first_ online resolution after mount (not just boot's initial sweep), so a genuine later arrival never notified — the one event the feature exists for.

**Status.** **fixed** — per-friend watch-start map with a settle bound. The bound is a dedicated `NOTIFY_SETTLE_MS` (3 min, sized above realistic presence-handshake latency), not the 60 s heartbeat window: reusing the latter let a slow-connecting already-online friend re-read as an arrival (review finding). Only the settle window is suppressed. Unit-tested.

### I55 — Sev3

`src/features/session/hello.ts`

**Evidence.** The signed session-hello `display_name` was stored/rendered without the cap + bidi/zero-width sanitize every other untrusted-name path applies; on `main` it was unbounded.

**Status.** **fixed** — `normalizeUntrustedName(name, HELLO_NAME_CAP)`. Cap is 192 UTF-8 bytes — the worst case for the 64-UTF-16-unit `maxLength` our own inputs enforce — so a legitimate multibyte name (CJK/emoji) survives intact rather than being byte-truncated (review finding), while a hand-modified sender is still bounded. Unit-tested incl. multibyte + bidi.

### I56 — Sev3

`src/features/ai/sampleLoop.ts`

**Evidence.** `onCaptureError` fired per tick (contract says once/lifetime) and the face-track guard never checked `readyState`, so a dead webcam threw `track_ended` every tick and toast-stormed the session over the MediaErrorBanner already saying the same thing.

**Status.** **fixed** — the ended-track guard skips the tick without counting a sample; a `captureErrorReported` latch mirrors `sidecarErrorReported`, reporting once and clearing on the next successful verdict. Unit-tested.

### I57 — Sev3

`src/design/tokens.ts` + `src/design/index.css`

**Evidence.** The focus ring (`accent.ring`, 40 % alpha) measured ~2.6:1 dark / ~1.8:1 light against the surfaces it is drawn on — below WCAG 1.4.11 — because the UA outline is globally reset; the gate missed it by measuring the opaque accent. `shadow.glow` had also drifted 3px/4px.

**Status.** **fixed** — raised alpha (60 % dark / 80 % light), mirrored in both hand-kept files; `check-contrast` now measures the ring in the bg-stack at its real per-theme alpha; `shadow.glow` reconciled to the tokens.ts value (3px). The ring's inner edge on `bg-accent-default` buttons intentionally stays below 3:1 — the outer edge against the canvas carries identification.

### I58 — Sev3

`src/components/ui/dropdown-menu.tsx`

**Evidence.** Menu items declared `focus:bg-bg-raised` on a `bg-bg-raised` surface — a 1.00:1 no-op — so keyboard/mouse navigation showed no highlight (worst in the in-session audio pickers, where two identically-named devices are indistinguishable).

**Status.** **fixed** — an inset accent ring highlight (keeps `focus:` so Radix pointer-move still lights it). The byte-identical Button/Badge `secondary` hover was fixed the same way (`hover:bg-bg-surface`).

### I59 — Sev3

`src/components/AuditLogPanel.tsx` + `SessionNotesPanel.tsx`

**Evidence.** The session-log and notes scroll containers had no focusable descendant and no `tabIndex`, so a keyboard-only user couldn't scroll them (WCAG 2.1.1). macOS/WKWebView only; Windows WebView2 auto-focuses scrollers.

**Status.** **fixed** — `tabIndex={0}` + a focus-visible inset ring on both. Overflowing Storybook stories added so the axe `scrollable-region-focusable` gate has something to assert on.

### I60 — Sev3

`src/strings.ts` (`searchKeywords`) + `Settings.tsx`

**Evidence.** v1.6.0 settings search routed "tray"/"minimize"/"capture displays"/"auto-update" to Advanced (which owns none of them) and left Advanced's own settings ("launch at login", "clear history", "onboarding") unfindable.

**Status.** **fixed** — keywords moved to the panes that own each setting; Advanced keywords added; a `Record<SettingsCategoryId, …>` guard in `Settings.tsx` pins the bucket↔pane mapping without a strings→features import cycle.

### I61 — Sev3

`src/stores/settingsStore.ts` + `ShortcutsCategory.tsx`

**Evidence.** `resetShortcutsToDefaults` rethrew on the first setter's combo collision and never ran the second; the rejection was swallowed to `console.error`, so the button was a silent no-op.

**Status.** **fixed** — reorder + per-call try/catch so both setters run; a residual collision surfaces a `toast.error` (copy in strings.ts). The Rust `is_registered` skip the original proposal suggested was dropped — it would re-open #47 B5. Stateful fake added to the keybindings test.

### I62 — Sev3

`src/features/updater/updaterStore.ts` + `AboutCategory.tsx`

**Evidence.** Settings → About offered a live Restart-now / Check-now during a session (unguarded, unlike the update banner), and its help text asserted "you're on X, the latest" from the initial `idle` state and after a silent background-check failure.

**Status.** **fixed** — session-active guards in `installAndRestart`/`checkNow` (the `userInitiated` exemption, made false by the in-session settings overlay, removed); About disables the buttons in-session and derives its help from an explicit `upToDate` branch rather than a fallthrough. Store tests flipped to assert deferral.

### I63 — Sev3

`src/features/identity/recoverLogic.ts`

**Evidence.** A failed 24-word restore pointed at all 24 words equally, with no way to narrow a single typo on the highest-stakes screen in the app.

**Status.** **fixed** — name the words that aren't in the wordlist (`unknownWords` on `MnemonicClass`, populated only on the 24-word path); copy in strings.ts. Kept in `recoverLogic.ts`, not the cross-version crypto module. Unit-tested.

### I64 — Sev3

`src/features/stats/FocusInsights.tsx`

**Evidence.** The focus-over-time trend tooltip had no date, so a dip couldn't be anchored to a day.

**Status.** **fixed** — carry each point's `startedAt`; the tooltip renders the `dayKey` day, byte-identical to the bar chart's day format.

### I65 — Sev4

`src/features/stats/statsData.ts`

**Evidence.** The stats CSV omitted the two headline tiles (total sessions, streak, average) — the numbers the pane is built around.

**Status.** **fixed (summary)** — prepend summary rows, preserving the null-average ("AI off" vs "scored 0") distinction. Per-session detail left out of scope. Test extended.

### I66 — Sev3

`src-tauri/src/commands/sidecar.rs`

**Evidence.** `sidecar_start` spawned llama-server then opened the log file; an `open_log_file` failure after a successful spawn dropped the `CommandChild` without `kill()`, orphaning a multi-GB process past app exit (same class as I25/I35).

**Status.** **fixed** — open the log before spawning, so no fallible `?` sits between the spawn and `guard.child`. Reviewed by reading (CI is the first Rust compiler on this dev box).

### I67 — Sev3

`src-tauri/src/commands/sidecar.rs`

**Evidence.** The respawn budget was a 30 s sliding window, so any crash spaced >30 s reset the counter and the watcher respawned llama-server forever without ever setting `errored` — no recovery affordance surfaced and the D7 log cap was defeated.

**Status.** **fixed** — the budget now counts consecutive respawns that each died before `MIN_HEALTHY_UPTIME` (120 s); a durable child resets the streak (`next_attempts` pure fn, unit-tested). Once the budget is exceeded `errored` is set as before.

### I68 — Sev4

`src-tauri/src/db/audit_events.rs`

**Evidence.** The cross-session insights read shipped the entire `audit_events` table over IPC though only `ai_warning`/`ai_alert` rows are consumed.

**Status.** **fixed** — `WHERE kind IN ('ai_warning','ai_alert')` narrows the query (~4× less JSON at 10k rows); `list_all` → `list_ai_distractions_all`, but the Tauri command name is unchanged so the IPC/TS contract is untouched. The SQL twin of TS `isDistraction` is commented at the query.

### I69 — Sev3

`src-tauri/src/lib.rs`

**Evidence.** The corrupt-DB recovery dialog asserted re-pairing was required and never mentioned the friends-backup import — wrong at the exact moment a friend loses their list.

**Status.** **fixed (copy)** — the dialog now names Settings → Identity → Import friends as the restore path if a backup exists, otherwise re-pair.

### I70 — Sev4

`.github/workflows/release.yml`

**Evidence.** A half-built draft (one platform's artifact missing from `latest.json`) could be published, stranding every friend on the missing platform with no update path and a false "you're on the latest".

**Status.** **fixed** — a job asserts both platforms are present in the draft's `latest.json` and, on failure, stamps the draft title "INCOMPLETE, DO NOT PUBLISH" (needs `contents: write` to read a draft). Not runnable on this box; validated by YAML parse + reading.

### I71 — Sev2

`src/features/updater/updaterStore.ts` + `src-tauri/src/commands/system.rs`

**Evidence.** Issue #77: an app opened straight from the mounted `.dmg` runs under macOS App Translocation (read-only bundle), where `update.install()`'s rename-into-place can never succeed — every launch re-downloaded the installer, offered "Restart now", and failed with the generic install toast. The one documented install step (drag to Applications) is exactly the one this path skipped, and the updater had no idea.

**Status.** **fixed** — new `system_install_context` command (translocation via exe-path component, read-only volume via `statfs`; fail-open) consulted after a check finds an update: an unswappable bundle sets a new process-permanent `blocked` status _before_ any bytes move, and the banner + Settings → About replace the doomed Restart with move-to-Applications guidance. Verified live: dev binary on a read-only DMG against the real v1.7.0 release showed the blocked row. Windows/NSIS unaffected (always updatable).

### I72 — Sev1

`src-tauri/src/commands/models.rs`

**Evidence.** Every model download failed at the picker's preflight with "…The model manifest may be stale." for every catalog entry. `model_head_check` populated `content_length` from `reqwest::Response::content_length()`, which is the body's size hint — an HTTP/1.1 HEAD response body is always empty (hyper decodes it as zero-length regardless of headers), so every probe reported 0 bytes and the size gate rejected all six entries. The manifest itself is current: the raw `Content-Length` (and `x-linked-etag` = pinned sha256) at every pinned revision still matches.

**Status.** **fixed** — read the `Content-Length` response header instead; in-module regression test against a local HEAD server; live-verified that all 10 catalog files (6 model + 4 mmproj — the three Gemma quants share one projector) report header sizes byte-identical to the manifest. Git history dates the break to the picker's birth: the size gate, the `content_length()` call, and the no-http2 reqwest dep all landed in one commit (af2987d, V2-P2) and never changed, and the zero-length HEAD decode is server-independent — so no catalog download has ever passed this preflight, and the downstream GET/verify/resume path has never run end-to-end in a shipped build (first real install is its true test). First user report 2026-07-26.

### I73 — Sev1

`src-tauri/src/commands/sidecar.rs` + `src-tauri/src/commands/engine.rs`

**Evidence.** In-app llama-server spawn has never worked in any build. `shell().sidecar("binaries/llama-server")` resolves `<exe_dir>/binaries/llama-server` (tauri-plugin-shell 2.3.5 joins the full configured string against the exe dir), but tauri-build (dev) and the bundler (release) both strip the directory prefix and the triple, placing the file at `<exe_dir>/llama-server` — verified in `target/debug/` and in the installed `StudyVis.app/Contents/MacOS/`. Every `sidecar_start` failed with `spawn llama-server: No such file or directory`, surfaced as "AI failed to start:" / "AI model crashed". The plugin has been pinned at 2.3.5 since V1-P1, so this is a day-one bug, not a regression; it sat behind I72 (downloads never completed), which is why the first user report of both landed the same day (2026-07-26 — the on-disk `llama-server.log` from that attempt is a 0-byte file: the child never ran).

**Status.** **fixed** — sidecar binaries now resolve to absolute paths and spawn via `shell().command()`: bundled probe at `<exe_dir>/llama-server(.exe)` (size-gated), then a managed install under `data_dir/engine/<tag>-<triple>/`. When neither resolves, `sidecar_start` auto-installs the pinned llama.cpp b9095 release asset (SHA-256-verified; pins lockstep-tested against `scripts/fetch-llama-server.sh`; tar.gz/zip unpacked flattened + filtered), gated by the new `engine_auto_install` setting (default ON) with `engine_info`/`engine_install` commands and a Settings → AI "AI engine" row (status/progress/Reinstall). `build.rs` writes a debug-profile-only placeholder so fresh checkouts compile without the fetch script; release-profile builds still hard-fail. Windows spawn failures name the VC++ redistributable when `vcruntime140.dll` is absent. Verified live on macOS: the installed bundle's binary spawns via the exact fixed resolution (`--version`, Metal init, exit 0), the placeholder build compiles and launches, and the pinned archives download, hash-match, extract, and run on this machine. The in-app GUI walk (Settings row + session start) is user-walked — the dev binary's keychain prompt blocks machine-driving it.

### I74 — Sev2

`src/features/friends/presence.ts` + `presenceRelay.ts` + `src/lib/nostr/`

**Evidence.** A mutually added friend showed permanently offline on BOTH ends whenever a STUN-only WebRTC datachannel could not form between the two networks (symmetric NAT / CGNAT / strict firewall — no TURN ships, ARCHITECTURE §4). Heartbeats only rode datachannels; trystero fires no callback on a failed ICE attempt (it silently re-offers forever), and offline ContactCard pairing (§5.1) removed the last step that ever proved the P2P path worked — so the failure was invisible end to end, with every relay reachable and both apps running. Presence, invites, and sessions all share the broken leg; presence was just the visible symptom.

**Status.** **fixed** — relay-carried presence: sealed ephemeral Nostr events (kind 20001, new `studyvis:presence-relay:v1` tag/key derivations pinned in topics.test.ts) published every 30 s to the pinned relays over an owned reconnecting socket pool; no `since` filter and `limit: 0` (the #47 C1 clock-skew lesson). The datachannel leg stays and now stamps `lastP2pAt`, so `presenceState()` distinguishes direct-online from relay-only "limited" (120 s settle, I54 lesson) — surfaced in the friends list as an amber "Available · limited connection" row plus a one-line hint deep-linking Settings → Network (TURN). Goodbyes keep `lastSeenAt` for "seen … ago". Sessions/invites behind the same NAT still need TURN — the UI now says so instead of lying "Offline". Old builds interop unchanged (they never see this leg). ARCHITECTURE §4/§7/§11/§14 + PLAN §2 updated; `offchain.pub` dropped from the relay pin (now rejects anonymous publishes).

### I75 — Sev1

`src-tauri/src/commands/sidecar.rs`

**Evidence.** After 1.8.0 shipped I73's spawn-path fix, on-device AI still failed to start on a real Windows install: `llama-server.exe` spawned, printed its banner (`Running without SSL`, `loading model`), then exited with `no backends are loaded` / `failed to load model` / `giving up after 4 restart attempts` (friend's `llama-server.log`, 2026-07-26 — the same day 1.8.0 shipped, the very next link in the same chain). Root cause: the pinned llama.cpp b9095 release assets are `GGML_BACKEND_DL` builds — 15 `ggml-cpu-*.dll` variants on Windows (haswell/zen4/sse42/…), `libggml-cpu.dylib`/`libggml-metal.dylib`/`libggml-blas.dylib` on macOS — that ggml `dlopen()`s at startup rather than linking. `ggml_backend_load_best` (`ggml/src/ggml-backend-reg.cpp`) globs exactly two places for those: the executable's own directory and the process's current working directory — never `PATH`/`DYLD_FALLBACK_LIBRARY_PATH`/`LD_LIBRARY_PATH`. I73's env-var prepend only satisfies the binary's _linked_ imports (`llama.dll`/`ggml-base.dll`/…), which is why the process starts at all; it never reaches the dlopen glob, so `ggml_backend_reg_count()` stays 0, `common_init_from_params` fails, and the crash-restart watcher gives up after `RESTART_BUDGET` (4) identical failures — on every bundled Windows and macOS install, not an edge case. Verified against the pinned llama.cpp b9095 source (`ggml-backend-reg.cpp:479-489`) and the actual release archives (`llama-b9095-bin-win-cpu-x64.zip`, `llama-b9095-bin-macos-arm64.tar.gz`).

**Status.** **fixed** — `spawn_llama` now also sets the child's working directory to the same runtime dir already resolved for the `PATH`/`DYLD_FALLBACK_LIBRARY_PATH`/`LD_LIBRARY_PATH` prepend (`Command::current_dir`, tauri-plugin-shell 2.3.5), since `fs::current_path()` is in ggml's search list. One code path covers both engine sources (bundled, and the managed install where `runtime_dir` already equals the exe's own directory) and all three platforms. Not runnable on this box — no cargo/node toolchain and `src-tauri/binaries/` has no fetched engine on this Linux dev host; gated by CI and the `Release prep` workflow's gate job instead.

### I76 — Sev1

`src/features/ai/sampleLoop.ts` + `captureScreen.ts` + `src/routes/Home.tsx` + `AiCategory.tsx` + `SessionView.tsx`

**Evidence.** User report: "AI capture error: getDisplayMedia must be called from a user gesture handler" firing on ordinary session starts with AI already enabled, and — because the fallout from this same failure kept killing the just-started sidecar — a separate, misleading "AI isn't running yet. Turn it on in Settings → AI" from the Ctrl+] chat dialog even though AI genuinely was on. Root cause: `sampleLoop.ts`'s `boot()` acquires the session's long-lived screen `MediaStream` via `navigator.mediaDevices.getDisplayMedia()`, but `boot()` runs from a React `useEffect` fired by state changes (session active + AI on + model chosen + camera up), never from inside a click handler. WebView2 (Windows) and WKWebView (macOS) require `getDisplayMedia()` to run inside live transient user activation on _every_ call, not just the first — the same reason the OS picker itself fires on every acquire (documented in `src/features/ai/README.md`'s "Acquire strategy", which is why V2-P9 already moved to one long-lived stream instead of a per-tick acquire) — so with no gesture in `boot()`'s call stack the call was rejected outright. Because the rejection's `DOMException` name fell outside `mapDisplayMediaError`'s handled set, it surfaced as the generic `screen_capture_unavailable` code and a raw toast instead of the intended `screen_capture_denied` recovery overlay, and `boot()`'s existing failure path tore down the sidecar it had just started. A second, compounding gap: `onCaptureError` never updated `AiStatusChip`'s runtime status, so the chip kept reading "active" after AI had silently died underneath it — matching the reporter's "I can't tell if it's on or if it's errored."

**Status.** **fixed** — a gesture-context handoff: callers that DO have a real user gesture (`TopicGateModal`'s submit when starting a session with AI already enabled; `AiCategory`'s "enable AI" toggle when a session is already active; `SessionView`'s permission-overlay retry) call the new `preacquireScreenStream()` synchronously (no `await` before it), which starts `getDisplayMedia()` inside that click and stashes the in-flight promise; `sampleLoop.ts`'s default `acquireScreenStream` runtime hook consumes that stash instead of calling `getDisplayMedia()` itself outside gesture context. An unconsumed stash (a rapid re-toggle, or a session that never reaches `boot()`) is released via `discardPendingScreenStream()`, including on `SessionView` unmount, so it never leaks a live stream or leaves the OS recording indicator lit. Separately, `onCaptureError` now carries a `fatal` flag — true for a `boot()`-time acquire failure (the loop really did tear itself and the sidecar down) vs. false for a `tick()`-time transient one (the loop keeps running) — so `SessionView` only flips the status chip to "error" on the former. Unit-tested (pending-stream stash/discard, default-runtime consumption of the stash, the `fatal` flag on both call sites); `npm run build`/`lint`/`test` all green (878 tests).

### I77 — Sev1

`src/features/session/lifecycle.ts` + `SessionView.tsx` + `tests/integration/session.test.ts`

**Evidence.** User report: "on my device I can't see the other person's camera but they can see mine" — a guest joining a friend's session never received the host's camera **or** mic, in either direction of the pair, while the host saw the guest fine. Root cause: `SessionView`'s media-acquire effect published the local `MediaStream` with a single untargeted `room.addStream(stream)`, and trystero 0.24 delivers a stream only to the peers that are active **at that instant** — `addStream` → `applyMediaOp` → `iterate` enumerates `keys(activePeerMap)` right then (`@trystero-p2p/core` `room.mjs:83`, `:494`) and queues nothing; peer activation (`room.mjs:306-314`) sets `activePeerMap` and fires `onPeerJoin` but replays no previously added local stream. The host is structurally guaranteed to lose that race: `hostSession()` derives a session topic from 32 fresh random bytes and `begin()`s the room **before** the invite is even sent, so the host's camera opens while it is provably alone and its one broadcast reaches nobody, forever. The guest normally wins it, because the session peer activates over trystero's already-open shared connection to that same friend in roughly one RTT — faster than a cold camera opens — so the guest's `addStream` lands and the host sees the guest. Two stale comments asserted the opposite of the library's actual behavior and are what preserved the bug: `SessionView.tsx` claimed `addStream` "forwards new tracks to all current peers **and to peers who join later**", and the stream-binding effect claimed "trystero replays existing peers when we register the stream callback" (`onPeerStream` is a bare assignment at `room.mjs:511`; only `onPeerJoin` sweeps, at `:506-509`, a replay our own `wrapRoom` consumes at construction). CI could not catch it: the integration bus mock hard-coded both false beliefs — its `addStream` ignored `targetPeers` and fanned out to every room, and its join + `onPeerStream` paths both replayed existing streams. Day-one defect; `trystero` has been pinned `^0.24.0` since the media path was introduced, so host→guest video has never worked in any shipped build.

**Status.** **fixed** — publishing moved into `publishLocalStream(room, stream)` in `lifecycle.ts`, which broadcasts to the currently-active peers and, in the immediately adjacent statement, subscribes `onPeerJoin` to re-send the same stream targeted at each later joiner (the pattern trystero's own README prescribes). The two calls live in one function so the "no `await` in the seam" invariant is structural: the broadcast covers who is active now, the subscriber covers who arrives later, and JS's single thread means no peer is missed or served twice — a double-add would desync trystero's FIFO pairing of stream metadata to incoming tracks. `SessionView`'s effect cleanup unsubscribes **before** `stopTracks`, so a "Try again" re-acquire can't hand a later joiner a dead stream. Both false comments replaced with the verified semantics + `room.mjs` line refs. The integration bus mock now models `activePeerMap` honestly (targeted sends honored, no join replay, no `onPeerStream` replay), and `tests/unit/session-publish-stream.test.ts` pins the contract — 2 of its 4 cases fail against the pre-fix code. **Both friends must update:** a patched host reaches an unpatched guest, but a patched guest still receives nothing from an unpatched host.

### I78 — Sev2

`src-tauri/Cargo.toml` (`tauri 2.11.0`)

**Evidence.** GHSA-7gmj-67g7-phm9 — "Tauri has an Origin Confusion Issue that Allows Remote Pages to Invoke Local-Only IPC Commands" (CVSS 8.8), affecting `tauri >= 2.0.0, <= 2.11.0`; fixed upstream in 2.11.1. StudyVis exposes a wide IPC surface (SQLite, keychain-backed identity, sidecar spawn, filesystem paths), so origin confusion is the class that matters most here rather than a theoretical one. Not found by `cargo deny`: the advisory is GitHub-Advisory-Database-only and RustSec does not carry it — it surfaced when OSV-Scanner was run over `Cargo.lock` while building the #102 supply-chain gates.

**Status.** **fixed** — `cargo update -p tauri --precise 2.11.1` (lockfile-only; `Cargo.toml` already requires `"2"`, so no manifest change). Pulled tauri-build/codegen/macros/runtime/runtime-wry/utils forward with it. Verified: OSV over `Cargo.lock` no longer reports the advisory, and `cargo deny check advisories licenses bans sources` stays green. Shipped as its own PR rather than bundled into the #102 CI branch: a Tauri bump is a Rust change that this box cannot compile, so it wants its own PR and its own full CI run. The new `.github/dependabot.yml` opens the 2.11.0 → 2.11.1 bump automatically (cargo ecosystem; `tauri*` is excluded from the routine grouping precisely so it lands as its own reviewable PR), and `maintenance.yml`'s weekly OSV scan keeps reporting it until the bump lands. Nothing in the pinned-ignore list of `src-tauri/deny.toml` suppresses it.

### I79 — Sev1

`src-tauri/src/macos_display_capture.rs` (new) + `src-tauri/src/lib.rs` + `src/features/ai/sampleLoop.ts`

**Evidence.** User report (issue #94): "AI does not work on macOS when it's enabled, model does not load into machine." AI is dead on macOS end-to-end, and the diagnostic log makes it look like the engine is at fault: `llama-server.log` shows a clean model load and four successful `/v1/chat/completions` (that run is the V2-P2 **benchmark**, which never touches screen capture) followed by bare `[event] terminated code=None` lines with no stderr at all — a child killed within milliseconds of spawn, before it could print its banner. Root cause is upstream and not the sidecar: since macOS 13, WebKit resolves `getDisplayMedia()` either by its own default action (when the app implements **no** capture delegate) or by the private `_webView:requestDisplayCapturePermissionForOrigin:initiatedByFrame:withSystemAudio:decisionHandler:` delegate — and it **denies the request outright** when the app implements the public `webView:requestMediaCapturePermissionForOrigin:…:type:decisionHandler:` (which wry does, to grant camera/mic) but not the private one (which wry does not: tauri-apps/wry#1195 open, #1196 unmerged, an earlier attempt #1111 reverted by #1186). So every `getDisplayMedia()` in a Tauri app is rejected with `NotAllowedError` on macOS regardless of user gesture or the app's Screen Recording grant. `mapDisplayMediaError` reads that as `screen_capture_denied` and `SessionView` mounts `ScreenCapturePermissionOverlay`, sending the user to System Settings for a grant that cannot help. **I76 is superseded, not wrong** — the gesture handoff it added is a real fix and remains correct on Windows; it shipped in v1.8.1, which is the build that failed here, which is what rules it out as the cause. Compounding it, `sampleLoop.ts`'s `boot()` spawned llama-server BEFORE acquiring the screen stream, so each attempt loaded a multi-GB model and killed it on the failed acquire — the literal "model does not load into machine" the reporter saw.

**Status.** **fixed** — `macos_display_capture::install()` adds the missing private method to wry's already-registered UI-delegate class at setup (`class_addMethod`, macOS only), answering `WKDisplayCapturePermissionDecisionScreenPrompt` so WebKit shows the OS picker — the behaviour the capture path was always written against. wry keeps owning every selector it already implements; the class just gains one more, process-wide, so the V2-P7 AI dialog window is covered too. Fail-safe: a renamed selector, an unreachable delegate or a failed `class_addMethod` logs and leaves the pre-fix behaviour rather than breaking anything. The method's type encoding is built from objc2's own `Encode` impls (BOOL is `B` on arm64, `c` on x86_64) with a test pinning the shipped arm64 signature, and a second test pins the selector spelling — the earlier upstream attempt shipped `ForSecurityOrigin` and silently did nothing. Separately `boot()` now acquires every screen stream BEFORE starting the sidecar, so a denied or cancelled capture costs nothing and a failed spawn releases the streams; two unit tests cover both directions. Not machine-walked: this repo has no macOS GUI-automation host.

### I80 — Sev4

`src/lib/nostr/pool.ts` + `tests/unit/nostr-pool.test.ts`

**Evidence.** CodeQL `js/log-injection` (alerts 51/52, medium) on the two `console.warn` calls that surface relay complaints — the OK-false reason (`frame[3]`) and the NOTICE body (`frame[1]`). Both strings are authored by the relay, and I74 added them deliberately so the relay-presence leg could not fail silently. The console is not a throwaway here: README points a friend at Settings → Advanced → Open data folder when something goes wrong, so a newline in relay text forges log lines that read as ours, and a bidi override (`‮`) reorders what a human sees without changing the bytes. No security decision is made on log content, which is what keeps this Sev4 rather than higher; a hostile pinned relay is also already outside the friends-only threat model. Found by the CI gate rather than by a report.

**Status.** **fixed** — a module-local `forLog()` replaces the `Cc`/`Cf` Unicode classes with spaces and clamps to 200 characters with an ellipsis, applied to both sinks. Deliberately not silent swallowing: the text still reaches the log, which is the whole point of I74's diagnostic. Two tests pin it — one asserts the message survives while no control character does, one asserts the clamp — and both were confirmed to FAIL with the fix reverted. `slot.url` in the third `console.warn` is ours (the pinned relay list), not relay-authored, so it is untouched and CodeQL does not flag it.

### I81 — Sev3

`src-tauri/src/commands/ai_dialog.rs`

**Evidence.** User report (issue #97): on macOS the `Ctrl+]` AI panel renders a phantom rounded-rect outline floating around it. Measured off the reported screenshot (2x capture; panel 428x102 pt): the outline is a 1 pt black hairline over a 1 pt grey one — AppKit's two-tone window rim — tracing a rect that hugs the panel's top edge and top corners, then swings ~10 pt outside its left and right edges and ~22 pt below its bottom, with a ~23 pt corner radius against the panel's 12 pt. Those offsets are the panel's own `shadow-lg` (`0 12px 32px`): the union of the opaque panel and the outer contour where that shadow's alpha still survives 8-bit quantization (~10 pt of the 16 pt blur reach, offset 12 pt down) — which is exactly the alpha silhouette AppKit shapes a borderless transparent window from. The dialog is `transparent: true` + `decorations: false` and tao defaults `has_shadow: true`, so the window server drew its rim around the shadow halo instead of around the panel. Cosmetic only; nothing is mispositioned or unclickable. Windows is unaffected because it does not derive window shape from content alpha.

**Status.** **fixed** — the macOS branch of `toggle_ai_dialog` now calls `builder.shadow(false)`, which tao maps straight onto `NSWindow::setHasShadow` at window creation (`tao-0.35.2` `platform_impl/macos/window.rs:328`), turning off the shadow-and-rim pass that draws the phantom outline. Scoped to macOS deliberately: on Windows that same flag is what gives an undecorated window its 1 px border and Windows 11 rounded corners, and Windows shows no artifact. The panel keeps its `shadow-lg`, so the depth cue is unchanged on both platforms. ARCHITECTURE §12's flag list updated to match. Not machine-walked — this repo has no macOS GUI-automation host and the Linux dev box cannot render the app; the macOS leg of CI's `Rust` job compiles the cfg-gated line, and `deploy.yml`'s macOS installer gives the reporter a build to confirm against.

### I82 — Sev2

`src/features/ai/sampleLoop.ts` + `SessionView.tsx` + `src/lib/audit-types.ts`

**Evidence.** Issue #92: a Windows session ran 10:38 with AI features on — the report's `topic_set` row proves it, since the topic gate only runs when AI is enabled — and ended with "No focus score was recorded for this session", an em-dash for focused-time, and not one word anywhere about why. The sample loop has six branches that end a tick without a sample and say nothing: the sidecar never reaching `running`+`healthy` (it refreshes status and reschedules forever; only the crash-budget `errored` transition toasts), an inference aborting at `REQUEST_TIMEOUT_MS` (a `console.warn` and nothing else — the likeliest one here, since macOS arm64 offloads to Metal with `N_GPU_LAYERS=99` while the Windows and Linux prebuilds run `--n-gpu-layers 0`, so a vision model that fits macOS's 90 s budget on GPU can blow it on CPU every single tick), a non-2xx sidecar response, a capture error after `captureErrorReported` latched the first toast, an absent/ended face track, and every screen track gone. None of them move `AiStatusChip` off "AI watching", none write an audit row, and the focus store never sees a judgment — so `snapshotFocusForReport()` persists null score, null `focused_pct`, and null sample counts, which the report renders identically to "AI was switched off". Whatever the underlying blocker was on that machine, the app knew and discarded it.

**Status.** **fixed** — a stall watchdog in the sample loop. Every one of those branches now classifies itself as a `SampleBlockReason` (`engine_warming` / `inference_timeout` / `inference_failed` / `capture_failing` / `camera_missing` / `screen_lost`), which arms the watchdog; a standalone timer (`STALL_CHECK_INTERVAL_MS`, 15 s) — not the sample tick — then decides. The timer is the load-bearing part: an `inference_timeout` tick burns the whole `REQUEST_TIMEOUT_MS` (90 s) before it fails, so evaluating only at tick boundaries pushed the first notice to 285 s, 2.4x the two minutes the constant and the CHANGELOG promise, on precisely the CPU-only case this exists for. The window runs from the last moment the loop was demonstrably fine — boot, a resolved sample, or a deliberate pause — so break / camera-off / pomodoro-rest / battery / AI-toggled-off count as progress rather than tripping it, and an already-surfaced `errored` sidecar or a latched `screen_capture_denied` is never double-reported. `onSamplesStalled(reason)` then fires exactly once, `onSamplesResumed` re-arms it on the first sample that lands, and both are guarded on `state.stopped` so `stop()` aborting its own in-flight request is never reported as a timeout. SessionView answers on three surfaces because one was never enough: the status chip stops claiming to watch ('AI error' for the engine-side reasons, 'AI paused' for the input-side ones, which are genuinely input-absent rather than broken), a toast names the blocker (with a Settings -> AI action for the three engine-side reasons) while the session is still live and fixable, and a new LOCAL-ONLY `ai_stalled` audit row carries the short reason into the session log — which is what the post-session report reads, so the report finally distinguishes 'AI was off' from 'AI was on and never got a reading'. Two consumer-side traps found in review and closed: an outstanding stall is tracked in a ref so the battery-pause resume can't flip the chip back to 'AI watching' without a sample, and the chip resets when the effect builds a NEW loop — otherwise following the toast's own advice (switch to a lighter model) left it reading 'AI paused' for the rest of the session while samples landed every few seconds. Local-only keeps the new kind off the wire, so a peer on 1.9.x or earlier is unaffected; `deriveTopDistractions` / `statsInsights` filter on `ai_warning`+`ai_alert` and so ignore it. 12 unit tests, three of them mutation-verified to fail against the pre-fix behaviour; a `Report` story pins the reported screenshot with its explanation. Not machine-walked — no Windows host, no Rust toolchain and no GUI automation on this box.

### I83 — Sev1

`src/features/ai/modelStore.ts` + `src/routes/Home.tsx` + `src/features/session/SessionView.tsx` + `sampleLoop.ts` + `Report.tsx`

**Evidence.** Issue #92: a real 10-minute two-person session on Windows rendered a report with `Focused-time —`, "No focus score was recorded for this session.", zero `ai_*` timeline rows — and, directly beside all that, "No distractions detected. Nice work." **Root cause: `useModelStore` is never hydrated outside Settings → AI.** `hydrate()` had exactly one caller, `ModelPickerContainer`'s mount effect (`ModelPickerContainer.tsx:85`), and that component mounts only inside the Settings → AI pane. `useSettingsStore` is hydrated at boot by `ThemeProvider` (`src/design/theme.tsx:52`), so `aiFeaturesEnabled` was correctly `true` while `activeModelId` sat at its `null` initial value — and `activeModelId` gates everything: `SessionView.tsx`'s sample-loop effect returns early on `if (!activeModelId)`, so `startSampleLoop` is never called and its `onStartFail('no_active_model')` toast — the one surface that names this — can never fire; `Home.tsx`'s `handleTopicSubmit` skips the V2-P9 gesture-context `preacquireScreenStream()` on the same condition, which on WebView2 is separately fatal. So any launch where the user didn't happen to open Settings → AI ran a whole session with AI silently dead: no loop, no toast, no audit row, no log line, and an unscored `sessions` row. Cross-platform and present at HEAD — it also explains #94 ("Ai does not work on macos when its enabled"). The report then made the silence permanent: `score`/`focused_pct`/`confident_samples`/`skipped_samples` all read NULL for an AI-off session, an AI-on-but-dead session, AND a pre-003 row, so no surface could tell a deliberate choice from a malfunction, and the distractions empty state asserted a clean measurement that never happened. Five further silent-death paths found alongside it: a sidecar that spawns but never reports healthy, an HTTP error from the sidecar, a per-tick abort, and any other tick throw were each `console.warn`-only (no devtools in release builds); the live 90 s per-tick timeout was 3.3× tighter than benchmark.ts's 300 s bound, so a model could benchmark successfully — the only thing that sets `activeModelId` — and then abort every live inference forever; an unanswered screen-share picker wedged `boot()` with no timeout, and `stop()` awaits `bootPromise`, so the sidecar was never killed; the Rejoin path and the camera/mic "Try again" path both re-`boot()` with no gesture pre-acquire; `mapDisplayMediaError` had no `InvalidStateError`/`InvalidAccessError` case, so a missing-transient-activation refusal was filed as `unavailable` (a dead-end toast) instead of reaching the recovery overlay whose retry button IS a gesture; `resolve_runtime_dir`'s `_ => Ok(None)` still degraded to a spawn with no CWD and no PATH prepend — the exact lethal-on-Windows state I75 fixed; and a child that dies in the Windows loader spawns Ok, so it crash-loops to the restart budget without ever reaching the VC++-redist hint.

**Status.** **fixed** — (1) hydrate `useModelStore` in `Home.tsx`'s boot effect, so the persisted model is the truth from launch rather than from a Settings visit; (2) `handleTopicSubmit` + `handleRejoin` + `handleMediaRetry` all pre-acquire the screen stream inside their real user gesture, and a store still mid-hydration counts as "maybe active" (an unconsumed stream is discarded on unmount; a missed pre-acquire is fatal on WebView2); (3) a once-per-session toast when AI is on, the model store is `ready`, and no model is active — the gap where `onStartFail` could never fire; (4) `onStalled` fires once per loop lifetime after `STALL_TICKS` (3) consecutive unproductive ticks, with a distinct reason per cause (`engine_unavailable` / `engine_error` / `inference_timeout` / `unknown`) and actionable copy; paused states (break, camera off, pomodoro rest, battery) are deliberately not stalls — **superseded by I82's wall-clock watchdog before release**: a consecutive-tick count also counted the cold-start ticks that `boot()` itself documents as "gracefully skip" while llama-server loads the model, so a healthy CPU-only session toasted "the engine isn't responding" ~15-30 s in and had no resume path to take it back, and under (5)'s p95-derived bound three consecutive timeouts could run 270-900 s before the user heard anything. `STALL_TICKS` / `SampleLoopStallReason` / `onStalled` are gone; the reasons live on as `SampleBlockReason`; (5) the per-tick timeout is derived from the model's benchmarked p95 (`effectiveRequestTimeoutMs`: 3× p95, floored at 90 s, capped at benchmark.ts's 300 s); (6) `SCREEN_ACQUIRE_TIMEOUT_MS` (120 s) bounds the acquire so an unanswered picker becomes a visible retryable error instead of a permanent wedge, and a late-arriving stream is stopped rather than leaked; (7) `InvalidStateError` / `InvalidAccessError` → `screen_capture_denied`, routing to the overlay whose retry is itself the missing gesture; (8) migration **004** adds `sessions.ai_enabled` (1/0, NULL = pre-004), written from live settings at teardown, and the new `aiCoverage()` derivation gives the report five honest states — `ran` keeps the earned "Nice work", `noConfident` covers checks that ran but couldn't be read, `noChecks` names the malfunction and points at Settings → AI, `off` says AI was off, `unknown` stays cause-neutral for pre-004 rows — shared by the rendered report and the text export so a pasted copy can never disagree; (9) Rust: `resolve_runtime_dir` falls back to the binary's own directory (one of the two places ggml globs anyway) instead of `None`, and the crash-loop give-up path now carries `append_windows_dll_hint`. Tests: `aiCoverage` (8 cases incl. the pre-003 scored row and the NULL-is-not-0 rule), serializer honesty (5), `snapshotFocusForReport.aiEnabled` (3), stall notice (4 incl. streak-reset and camera-off-is-not-a-stall), `effectiveRequestTimeoutMs` boundaries (4), and a Rust 003→004 upgrade test asserting old rows read NULL. Stories: `AiOnButNoChecks`, `AiOffForSession`. **Round 2** (a 65-agent adversarial sweep over the first draft found six more): (10) `hydrate()`'s `status: 'error'` was terminal — `ModelPickerContainer` only retried on `'loading'`, so one failed models.json read (AV lock, partial write) killed AI for the whole process and reopened this very issue through a narrower door; the gate is now `status !== 'ready'` and the session notice distinguishes it (`modelListUnreadable`). (11) the footer chip read **"AI off" while AI was ON** with no model — the single on-screen signal during #92, pointing at exactly the wrong setting; new `'unconfigured'` status via a pure, unit-tested `deriveAiChipStatus()`, with `'loading'` deliberately reading `'off'` so no launch flashes it. (12) `aiCoverage`'s first cut returned `'ran'` for `confident_samples: 0, skipped_samples: k`, defended on the grounds that the #47 D5 line caveats it — it does not below `SKIPPED_SAMPLES_MIN` (3), so k of 1–2 rendered a fabricated all-clear with no caveat at all; fifth state `'noConfident'` added and the two tests asserting the old behavior **edited**, not appended. (13) `append_windows_dll_hint` probed only `vcruntime140.dll`, staying silent on a box with the C runtime but not the C++ one; now requires both. (14) `next_attempts` resets the streak on any child clearing `MIN_HEALTHY_UPTIME` (120 s), so a sidecar dying every ~2.5 min crash-looped **forever** without ever setting `errored` — the stall notice fired once and the session then ran for an hour on a dying engine; `TOTAL_RESTART_BUDGET` (12 per generation) closes it, sized so an 8-hour session dying hourly never trips while a 121 s cycle trips at ~24 min. (15) Settings → Sessions now marks an unmeasured row `not measured` when `ai_enabled === 1`. One round-2 finding was **rejected**: "`onSidecarErrored` re-arms every tick, so a flapping sidecar re-toasts forever" — `errored` is cleared only by `sidecar_start`/`sidecar_stop` (`sidecar.rs:233`/`:270`) and the watcher `return`s after setting it, so errored→running requires deliberate user action and re-notifying then is correct, as the existing test documents.

### I84 — Sev1

`src-tauri/src/db/schema_repair.rs` (new) + `src-tauri/src/db/mod.rs` + `migrations.rs` (header)

**Evidence.** User report (issue #99): "Session history and stats show blank when exiting a new session" — Settings → Sessions shows its load error, Settings → Stats the same, no session is ever recorded and no post-session report renders, while friends / identity / pairing / AI are unaffected. **Root cause: a version-keyed migration cannot reach a database whose recorded version already covers a file that was later edited in place.** `001_initial.sql` created `sessions` on 2026-05-09 (1329305, V1-P4) without `focused_pct` / `generated_at`; V2-P8 added both by amending that same file on 2026-05-11 (4caa546). A database created in that window records `schema_version = 1`, so 001 never re-runs — 002/003/004 apply on top and leave it at the current version with those two columns permanently absent. `sessions::list`, `get` and `insert` all name every column, so every one of them fails with `no such column: focused_pct`; the `friends` amendment in the same window only REMOVED a column, which SQLite tolerates, which is why nothing else broke. The 2026-07 `shipped_migrations_are_immutable` test stops the NEXT in-place edit but cannot repair the disks the two before it already diverged.

**Status.** **fixed** — `db::schema_repair::reconcile_schema` runs after `run_migrations` at every boot and `ALTER TABLE ADD COLUMN`s whatever `EXPECTED_SCHEMA` names and the disk lacks: additive only, never a drop / rewrite / type change, so it cannot lose data and is a no-op on a healthy database. Failure is logged, not fatal — a repair that can't run leaves the database exactly as it was found. Tests reconstruct the real 2026-05-09 `sessions` DDL and assert the un-repaired database fails `list` (the defect), then that insert + list + get round-trip after the repair, that pre-existing rows keep their values while the new columns read NULL, and idempotence. A drift guard compares `EXPECTED_SCHEMA` against a freshly-migrated database in both directions, so a future migration that adds a column without listing it here fails the suite.
## Archive — retired backlogs

Two documents used to sit beside this ledger and were deleted once they had no open work left to describe: `BUILD-PROMPTS.md` (the sequenced V0→V3 build plan) and `IMPROVEMENTS.md` (the v1.2.0-era improvement backlog). Git history holds both in full — `git log --diff-filter=D -- BUILD-PROMPTS.md IMPROVEMENTS.md`, then `git show <sha>^:<file>`. What survives here is the part still cited from code.

### Improvement backlog (2026-06, v1.2.0-era)

**Retired, not live.** A code-level audit on 2026-07-10 verified every item against the source: **55 of 56 shipped** (largely in v1.2.1, with v1.2.2 and v1.3.1 following), **1 partial (P1)**, **0 open**. The IDs below appear as comment tags at the exact code sites that implemented them; the letter-to-section legend is in `CLAUDE.md`. Item text described the **v1.2.0-era gap** it was written against, not today's code — which is why only the titles are kept here, as a decoder for those tags rather than as a backlog.

Exceptions and judgment calls, so nobody re-litigates them from an item title alone:

- **P1 (Linux deferral checklist) — partial.** Its literal ask shipped — the deferral now has a concrete trigger + unblock checklist (PLAN §8) — but the Linux work the checklist describes (keyring feature, `.AppImage` job, smoke-test re-run) has not started.
- **X2** shipped via its sanctioned alternative: the Intel-Mac claim was dropped from the docs rather than adding an `x64.dmg` build.
- **X7** shipped as the documented triage (ISSUES.md I19); the "when convenient" dev-dep bumps remain untaken by design.
- **S2** closed the privacy defect with a stuck-key guard (120 s, not ~30 s) + per-session reset; the suggested blur-release was considered and deliberately rejected (`PttListener.tsx`) because the PTT shortcut is system-wide.
- **N3** shipped as a global toggle only (no per-friend mute). **S4**'s output picker is inoperative on macOS WKWebView (`setSinkId` unsupported — documented in code); per-peer volume works everywhere.

#### Item index

**F — Friend-finding & connection**

- `F1` — Wire trystero `onJoinError` so silent relay/network failures become visible
- `F2` — Connection-diagnostics panel via trystero `getRelaySockets`
- `F3` — Let users add a relay URL / TURN server without a new build
- `F4` — Surface per-peer WebRTC connection state in the session grid
- `F5` — Post-peer-arrival stall timer for the pairing dialog
- `F6` — Make invite delivery honest about offline friends + retry on presence
- `F7` — Goodbye heartbeat so presence flips offline near-instantly on quit
- `F8` — Align docs and in-app copy to the STUN-only reality
- `F9` — Raise QR error-correction level and surface code freshness
- `F10` — Register `studyvis://` as a real OS deep link

**U — UI / UX & accessibility**

- `U1` — Give online friend rows a persistent invite affordance
- `U2` — Show a "waiting for your friend" state when alone in a session
- `U3` — Add Back navigation to the onboarding step sequence
- `U4` — Collapse the redundant second "Add friend" button
- `U5` — Make the WCAG contrast gate detect token pairings not in its allowlist
- `U6` — Replace the raw radio input in SessionTimer with the RadioGroup primitive
- `U7` — Update the stale BipBackupPanel note in DESIGN-SYSTEM.md

**S — Session robustness**

- `S1` — Grace window before auto-ending on transient disconnect
- `S2` — Make a missed PTT key-release recoverable
- `S3` — Camera on/off toggle for the live session
- `S4` — Audio output device + per-peer volume control

**A — AI focus-detection quality**

- `A1` — Make the benchmark request shape-identical to the real focus request
- `A2` — Treat malformed/empty model responses as uncertain, not `on_task`
- `A3` — Consume `on_topic_confidence` in the score machine
- `A4` — Add HTTP Range resume to model downloads
- `A5` — Re-read the sidecar port after the capture await before POSTing
- `A6` — Resolve the dangling "thermal-aware notice" in ARCHITECTURE §8

**D — Data, identity & recovery**

- `D1` — Don't steer a corrupt-identity load into new-identity onboarding
- `D2` — Recover gracefully from a corrupt `app.db` instead of crashing at startup
- `D3` — Local friends-list backup/restore, encrypted to the user's own key
- `D4` — Turn the dead "Recovery phrase" settings row into an honest, actionable one
- `D5` — Detect SAME vs DIFFERENT backup before the recovery overwrite warning
- `D6` — Refuse to open a DB created by a newer app version
- `D7` — Document the plaintext-at-rest boundary in the threat model

**R — Stats, report & focus history**

- `R1` — Stop persisting `score=100` for AI-off sessions
- `R2` — Disambiguate "Focused minutes" (stats) from "Focused-time %" (report)
- `R3` — File export for the report and a stats CSV
- `R4` — Session delete / clear-history affordance
- `R5` — Match the copy-report section order to the on-screen order
- `R6` — Surface how many sessions are unscored in the average-score tile
- `R7` — Local focus-insights view across sessions

**X — Release & distribution**

- `X1` — Gate the release on CI-green before tagging `main`
- `X2` — Build the Intel Mac `x64.dmg` the docs promise (or drop the claim)
- `X3` — Run `check-strings` in CI
- `X4` — Opt-in, OFF-by-default new-version notification
- `X5` — Reduce macOS Gatekeeper friction via ad-hoc signing
- `X6` — Resolve the dormant `tauri-plugin-updater` dependency
- `X7` — Document the npm audit triage (9 vulns are dev-only)

**N — New features & cross-cutting lifecycle**

- `N1` — Single-instance guard so relaunch focuses the existing window
- `N2` — OS notification on pomodoro work↔rest transitions
- `N3` — Optional "friend came online" notification
- `N4` — Confirm before quitting during an active session
- `N5` — Custom pomodoro durations (wire-compat aware)
- `N6` — Optional audio cue on break / phase transitions

**P — Strategic / credential-gated**

- `P1` — Turn the Linux deferral into a concrete unblock checklist
- `P2` — Record signing / notarization / auto-install as one credential-gated roadmap item
