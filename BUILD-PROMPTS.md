# StudyVis — Build Prompts (V3: finish the product)

> Sequenced, self-contained prompts you paste into Claude Code, one per working session. V0, all of V1, all of V2, and V3-P1 (stats dashboard) are **already built and merged to `main` at v1.0.3** — those prompts have been retired from this document (git history preserves them). What remains is V3: the work that takes StudyVis from *feature-complete* to *a finished product a stranger would call polished*. Run the prompts in order; later ones audit the surface earlier ones create.

## How to use this document

1. **Open Claude Code** in the `studyvis` repo root.
2. **Pick the next prompt in order** from the table of contents. V3 prompts have light dependencies (recovery and keybindings are independent; the cohesion and release prompts must run last because they audit everything before them) — the order below is the intended one.
3. **Copy the fenced block in full** (everything inside the ```` ```` fence) and paste it as your first message of the session. Each block embeds the preamble verbatim — no assembly required.
4. **Watch the work happen.** Every prompt authorises unlimited reasoning, subagents, and the advisor.
5. **Review the diff and the running app.** Acceptance criteria are stated in each prompt. Claude Code checks them, but the *felt* quality — does this screen look finished? — is yours to judge. The `/style` dev route and Storybook are the fastest way to see drift.
6. **Don't skip.** Each prompt assumes the artifacts of the ones before it.

Each prompt assumes Claude Code has fresh context and no memory of prior sessions. That is intentional — every prompt re-references `PLAN.md`, `ARCHITECTURE.md`, `DESIGN-SYSTEM.md`, `CLAUDE.md`, and the **V3 debt ledger** below, so each session re-grounds on the source of truth.

## What is already shipped (the V3 starting line)

Do not rebuild any of this. Do not regress it.

- **V1 — study with friends, no AI.** Pseudonymous identity (Ed25519 + X25519 from one BIP39 mnemonic), friends list with presence, encrypted Nostr invites, 2–4-peer WebRTC mesh sessions, push-to-talk, audit log, Pomodoro sync, system tray + opt-in autostart, onboarding, an eleven-category Settings panel, unsigned macOS + Windows installers.
- **V2 — AI accountability.** Bundled llama-server sidecar, model picker + on-device benchmark, face + screen capture pipeline, focus-judgment scoring, self-warning → peer-alert escalation, floating `Ctrl+]` AI dialog with break handling, AI audit events, local post-session report.
- **V3-P1 — stats dashboard.** Local-only Settings → Stats: focused minutes, streaks, top partners, average score. Recharts 3.8.1, token-colored, computed from local SQLite.
- **State of the tree:** version `1.0.3` (consistent across `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`). Native window chrome. Theme dark/light/auto wired. `/style` dev route live. 55 Storybook stories. Node-env Vitest only (no RTL/jsdom, zero `*.test.tsx`). `ISSUES.md` is the audit ledger — no open Sev1/Sev2. No `README.md`, no `CHANGELOG.md` yet (both owed; see the gate prompt).

## Table of contents

- **V3 — Finish the product**
  - V3-P2: Identity recovery from a 24-word backup
  - V3-P3: Custom keybindings UI
  - V3-P4: Multi-monitor capture toggle
  - V3-P5: Light + auto theme polish
  - V3-P6: Custom frameless window chrome (opt-in)
  - V3-P7: Accessibility pass + app-wide reduced motion
  - V3-P8: Design cohesion & copy pass
  - V3-P9: Release readiness & the 1.0 gate

V3-P1 (stats) is shipped and intentionally absent. Numbering continues from P2 so it stays aligned with git history and memory carryovers.

---

## V3 debt ledger (carried forward from retired prompts — do not lose these)

When the V0–V3-P1 prompts were retired from this file, the debts they had routed forward were consolidated here. Each remaining prompt's **CARRY-FORWARD DEBTS** block names the ledger items it owns; the agent running that prompt must discharge them or, where a debt is explicitly deferred, record the deferral in the V3-P9 gate. Nothing here may be silently dropped.

- **D1 — "Show backup mnemonic" is honest, not retrievable.** *(V1-P11 → V3-P2.)* Settings → Identity ships a disabled "Show backup mnemonic" row reading "Available in V3." This is a design trap: V1-P3 stores **only** the derived Ed25519/X25519 keys in the OS keychain; the BIP39 mnemonic is shown once at setup and **never persisted** (ARCHITECTURE §3, PLAN §7). It is not recoverable from the keychain. The correct resolution is *not* to store the mnemonic at rest. Recovery means "paste your 24 words on a new install to re-derive the same identity," and the Settings row stays honest.
- **D2 — Extract `BipBackupPanel`.** *(DESIGN-SYSTEM §4 → V3-P2.)* The 24-word display + copy + "I've saved them" confirmation is still inlined in `src/features/identity/IdentitySetup.tsx`. The inventory expects a standalone `BipBackupPanel` component (with story). Recovery reuses this UI, so extract it here.
- **D3 — Wire the rebind row.** *(V1-P11 / V1-P7 → V3-P3.)* Settings → Shortcuts (`src/features/settings/categories/ShortcutsCategory.tsx`) ships a disabled "Coming soon" rebind row. Wire it to a `KeybindCapture` component, persist via `useSettingsStore`, and re-register through `tauri-plugin-global-shortcut` using the V1-P7 `Mutex<Shortcut>` interior-mutability pattern. PTT is registered Rust-side in `src-tauri/src/lib.rs` (around the global-shortcut handler block).
- **D4 — Display enumeration before compositing.** *(V2-P3 / V2-P9 → V3-P4.)* `src/features/ai/captureScreen.ts` (and the long-lived screen `MediaStream` acquired once in `sampleLoop.ts.boot()`) defer display selection to the OS picker. `getDisplayMedia({ video: true })` re-prompts on WKWebView/WebView2 on **every** call — that's *why* V2-P9 moved to a single long-lived stream. Multi-monitor must enumerate and composite without reintroducing per-tick re-prompts.
- **D5 — Screen-recording indicator stays lit.** *(V2-P9 / V0 → V3-P7 + V3-P8.)* The long-lived screen stream means the OS screen-recording indicator is on for the whole AI session. Onboarding/permissions copy must say so. Also: macOS `NSScreenCaptureUsageDescription` is a documented no-op — the real toggle is System Settings → Privacy & Security → Screen Recording; copy must point users there, not rely on a purpose-string prompt.
- **D6 — Homeless UX tunables.** *(V2-P6 / V2-P7 → V3-P8, triage.)* Three small, owner-less tunables: `alertsUiStore` `PEER_ALERT_TTL_MS` / `WARNING_TTL_MS` as a tile-alert-duration slider; `evaluateBreakRules` using a rolling 2-hour window instead of "4 breaks since start"; a `sessions.breaks_taken` column if the report ever surfaces breaks taken. Implement in the cohesion pass only if it improves the felt product; otherwise record as deliberately deferred in V3-P9.
- **D7 — Dead `models` table + unbounded log.** *(V2-P9 → V3-P9.)* `002_v2.sql` creates a `models` table that nothing reads (`modelStore` uses `models.json`); `sidecar.rs::ensure_log_path` writes `llama-server.log` with no size/daily rotation. Resolve (drop the table or wire it; add rotation) or formally defer with a reason in the gate.
- **D8 — Focused-minutes definition is deliberate.** *(V3-P1 → V3-P9, record only.)* "Focused minutes = `session.total_minutes`" (not AI-weighted) is an intentional design decision isolated in `focusedMinutesForSession()`. This is **not a bug**. Record it in the "intentionally not in 1.0" list; do not "fix" it.
- **D9 — Signing & accepted deviations are out of 1.0.** *(V0 / V1-P12 / ISSUES → V3-P9, record only.)* macOS notarization, Windows code-signing, and re-enabling `tauri-plugin-updater` are conditional on signing credentials that do not exist — out of 1.0 by PLAN §5. ISSUES.md I9 and I18 are deliberate accepted deviations. Linux first-class and sepia/high-contrast theme variants are explicitly post-1.0 (scope decision recorded for this V3). Record all; reopen none.
- **D10 — Linux compile prerequisite (post-1.0).** *(V1-P3 → V3-P9, record only.)* Before Linux can ever compile, the `keyring` crate needs the `sync-secret-service` feature in the `cfg(target_os = "linux")` target block. Moot for the macOS + Windows 1.0; record as a post-1.0 Linux prerequisite. Optional, non-blocking hygiene: a Rust-side `identity_box_decrypt` for symmetry with `identity_sign`.

---

## The universal preamble (embedded verbatim in every prompt below)

Every fenced block begins with the same preamble — inlined, not referenced. Copy the whole block and paste. The canonical text (also reproduced inside each prompt):

> You are working on StudyVis, a peer-to-peer desktop study app for close friends. Read these in full before making decisions:
> - `/Users/scott/PycharmProjects/studyvis/PLAN.md`
> - `/Users/scott/PycharmProjects/studyvis/ARCHITECTURE.md`
> - `/Users/scott/PycharmProjects/studyvis/DESIGN-SYSTEM.md`
> - `/Users/scott/PycharmProjects/studyvis/CLAUDE.md`
> - `~/.claude/projects/-Users-scott-PycharmProjects-studyvis/memory/MEMORY.md` (carryovers from prior phases)
>
> These are the source of truth. If anything in this prompt conflicts with them, surface the conflict — don't silently deviate.
>
> **Reasoning budget is unlimited.** Use subagents freely. Call the **advisor** before committing to a non-obvious approach and once before declaring the task done. Use **Context7** for library docs; verify versions and APIs, don't assume.
>
> **Phase invariant (V3).** V1 + V2 + the V3-P1 stats dashboard are shipped and merged at v1.0.3. Do not regress any shipped behavior. V3 only adds polish and breadth — if a change would alter a working shipped flow, surface it. ISSUES.md I9 and I18 are deliberate accepted deviations; do not "fix" them.
>
> **Polish bar (V3).** "Done" means a screen a stranger would call *finished*, not merely functional. Obey DESIGN-SYSTEM.md §6 (motion — only the five permitted uses), §10 (every async/stateful surface ships empty + loading + error states; Skeleton, not spinners), §12 (layout grid + spacing from tokens), §14 (copy: short, direct, second person, no hype; period on full sentences, none on labels or buttons), §7 rule 5 (the `/style` route is the drift check). Tokens are the only source of color/spacing/font/radius/shadow/motion.
>
> The full exit sequence (debt carry-forward, single commit, feature branch, Copilot review loop, squash-merge) is in every fenced block below.

---

# V3 — Finish the product

V3 turns a feature-complete app into a finished one. The first six prompts close real gaps and add the last breadth; the last two are cross-cutting passes that make the whole thing feel like one person designed it. Run them in order.

## V3-P2: Identity recovery from a 24-word backup

**Phase**: V3.
**Depends on**: V1-P3 identity (`src/lib/crypto/identity.ts`), V1-P10 onboarding, V1-P11 Settings → Identity.
**Reads**: ARCHITECTURE §3 (identity model), PLAN §7 (BIP39 is the user's responsibility), DESIGN-SYSTEM §4 (`BipBackupPanel`), §8.1 (BIP39 wireframe), §10, §14.
**Outputs**: an onboarding fork ("I have a 24-word backup" vs "Create new identity"), `src/features/identity/Recover.tsx`, an extracted `src/components/BipBackupPanel.tsx` (+ story, + `/style` entry), corrected Settings → Identity copy, node-env tests, no new docs.
**Acceptance criteria**:
- Onboarding offers recovery *before* generating a new identity.
- Pasting a known mnemonic restores the exact Ed25519 pubkey asserted in the V1-P3 unit tests.
- Invalid checksum, wrong word count, and partial input each fail with a calm inline message (not a modal, not a toast storm).
- Recovering over an active install requires an explicit confirm-overwrite step.
- "Recovery does not restore your friends list" is stated plainly, once, where the user will read it.
**Out of scope**: storing the mnemonic at rest (forbidden — see D1); friend re-pairing automation; cloud anything.

**Prompt to paste**:

````
You are working on StudyVis, a peer-to-peer desktop study app for close friends. Read these in full before making decisions:
- /Users/scott/PycharmProjects/studyvis/PLAN.md
- /Users/scott/PycharmProjects/studyvis/ARCHITECTURE.md
- /Users/scott/PycharmProjects/studyvis/DESIGN-SYSTEM.md
- /Users/scott/PycharmProjects/studyvis/CLAUDE.md
- ~/.claude/projects/-Users-scott-PycharmProjects-studyvis/memory/MEMORY.md (carryovers from prior phases)

These are the source of truth. If anything in this prompt conflicts with them, surface the conflict — don't silently deviate.

Reasoning budget is unlimited. Use subagents freely (Explore, Plan, general-purpose). Call the advisor before committing to a non-obvious approach and once before declaring the task done.

Use Context7 for library docs; prefer it to web search. Verify, don't assume — look up versions, APIs, and CLI flags before depending on them.

Version policy: pinned versions in canonical docs are floors, not ceilings. Prefer current; note bumps in your end-of-task summary; never silently downgrade.

File-shape policy: if a doc or this prompt prescribes a path or config shape that conflicts with the current framework idiom, prefer the current idiom and note the deviation.

Package-manager policy: use the manager indicated by the lockfile already in the repo (npm if package-lock.json). Do not switch.

Verification policy: prefer headless commands (tsc -b, vite build, storybook build, cargo check) — those are agent-verifiable. Avoid tauri dev, storybook dev, and cross-machine peer-to-peer tests in autonomous execution; mark those user-verifiable in the PR. There is NO React Testing Library / jsdom harness in this repo (Vitest is node-env only, zero *.test.tsx). Verify behavior with node-env logic tests + Storybook stories; mark visual rendering user-verifiable. Do not add an RTL/jsdom harness.

Phase invariant (V3): V1 + V2 + the V3-P1 stats dashboard are shipped and merged at v1.0.3. Do not regress any shipped behavior. V3 only adds polish and breadth — if a change would alter a working shipped flow, surface it, don't silently make it. ISSUES.md I9 and I18 are deliberate accepted deviations; do not "fix" them.

Polish bar (V3): "done" means a screen a stranger would call finished, not merely functional. Obey DESIGN-SYSTEM.md §6 (motion — only the five permitted uses; everything else instant), §10 (every async or stateful surface ships empty + loading + error states; Skeleton not spinners), §12 (layout grid + spacing from tokens only), §14 (copy: short, direct, second person, no hype; period on full sentences, none on labels or buttons; sound like a friend wrote it), and §7 rule 5 (walk the dev-only /style route before declaring done). Tokens are the only source of color/spacing/font/radius/shadow/motion; no raw hex, px, or cubic-bezier outside tokens.ts.

Scope discipline: don't introduce features, abstractions, or polish beyond what this prompt asks. No backwards-compatibility shims. No comments unless the why is non-obvious. No new documentation files unless asked.

End-of-task exit sequence (mandatory):
1. Carry inherited debts forward into BUILD-PROMPTS.md. Audit the work for anything that surfaced and belongs to a later phase. For each debt, append a one-line bullet (format: `- From V3-P2: <one sentence on what the future phase must do>`) to the target prompt's CARRY-FORWARD DEBTS section, which lives INSIDE the fenced prompt block directly above the YOUR TASK line. Create the section with that exact heading if it doesn't exist. Stage this BUILD-PROMPTS.md change with the commit in step 2.
2. Single commit. Stage only the files this task should change (including the BUILD-PROMPTS.md update). Message format: "V3-P2: <subject>".
3. Push to a feature branch on github.com/scotej/studyvis (default branch main). Branch name: v3/p2-recovery. Direct push to main is not authorized.
4. If GitHub rejects on email privacy, amend with the noreply email and retry: git -c user.email='134114466+scotej@users.noreply.github.com' commit --amend --no-edit --reset-author
5. Open a PR: gh pr create --base main --head v3/p2-recovery --title "V3-P2: identity recovery". PR body has Summary and Test plan sections. Copilot review fires automatically on this repo.
6. Wait for the Copilot review. Poll `gh pr view <num> --json reviews --jq '[.reviews[] | select(.author.login == "copilot-pull-request-reviewer")] | length'` every ~30s for up to 10 minutes. Copilot may decline markdown/config-only PRs ("Copilot wasn't able to review any files…") — treat that as a clean pass. If nothing lands in the window, note it in a PR comment and proceed to step 9.
7. For each actionable Copilot finding (bug, correctness, missing edge case, security): fix it; re-run the prompt's verification commands. Skip pure nits, listing them with one-line reasons in the follow-up commit message. If the review surfaces new inherited debts, route them per step 1.
8. Single follow-up commit "V3-P2: address Copilot review" (or "V3-P2: no Copilot review within window"). Skip if zero actionable findings AND zero noted nits AND no new debts.
9. Auto-merge: gh pr merge <num> --squash --delete-branch. If a required check is still running, wait (gh pr checks <num>) and retry once. If the branch went stale, git fetch origin && git pull --rebase origin main, re-verify, push, retry. Never force-push main; never bypass checks (no --admin).
10. End-of-task summary in chat: (a) what shipped, (b) deviations from prompt or canonical-doc text and why, (c) Copilot findings addressed and skipped, (d) inherited debts named by phase id and confirmed routed into BUILD-PROMPTS.md, (e) confirmation the PR merged and the branch was deleted.

---

CARRY-FORWARD DEBTS (from the V3 debt ledger — incorporate into this work):
- D1 — Settings → Identity "Show backup mnemonic" row currently reads "Available in V3." The mnemonic is NOT retrievable: V1-P3 persists only the derived Ed25519/X25519 keys to the keychain; the 24 words are shown once at setup and never stored (ARCHITECTURE §3, PLAN §7). Do NOT add mnemonic-at-rest storage. Resolve the row honestly: keep it disabled and rewrite the copy so it tells the truth (e.g. "Your 24-word backup is shown once during setup and never saved here. Keep the original safe — it's the only way to recover this identity."). Recovery in this prompt means re-deriving identity from words the user still holds, on a fresh or reset install.
- D2 — The BIP39 24-word display + copy-to-clipboard + "I've saved them" confirmation is still inlined in src/features/identity/IdentitySetup.tsx. DESIGN-SYSTEM §4 expects a standalone BipBackupPanel component. Extract it to src/components/BipBackupPanel.tsx (presentational, token-only, with a Storybook story and a /style entry), refactor IdentitySetup.tsx to consume it, and reuse it (read-only / no-confirm mode if needed) in the recovery flow's success state if it aids comprehension. No behavior change to the existing onboarding path.

---

YOUR TASK: V3-P2 — Identity recovery from a 24-word backup. This is the missing half of the V1-P3 identity story: today a user can only ever create a *new* identity, so a lost laptop means becoming a stranger to friends with no path back even when they kept their words.

First, orient against real code (use Explore): confirm the exact exported name and signature of the mnemonic→identity derivation in src/lib/crypto/identity.ts (it is deriveFromMnemonic, NOT mnemonicToIdentity as older drafts said — verify), the mnemonic validator (validateMnemonic), how generateIdentity persists (keychain + identity.json via the Rust identity commands), the onboarding step machine (src/features/identity/IdentitySetup.tsx and the onboarding container), and how identityStore commits an identity.

Then build:

1. Onboarding fork. Before the "create new identity" path runs, the user chooses: "Create a new identity" or "I have a 24-word backup." This choice must appear ahead of generation, not as an afterthought buried later. Use the existing OnboardingStep primitive and the View+container split already established (do not invent a new layout pattern). Copy per §14 — calm, second person, no hype.
2. src/features/identity/Recover.tsx. Decide textarea vs 24 discrete fields by what is actually friendlier for someone typing from paper — verify the trade-off (a single textarea that tolerates whitespace/newlines and normalizes case is usually kinder than 24 boxes; justify your choice via advisor). Validate the BIP39 checksum with the existing validator. On valid input, call the real derivation function, then persist through the same identityStore/Rust commit path generateIdentity uses — recovery and creation must converge on one persistence path, not two.
3. The three failure states, all calm and inline (DESIGN-SYSTEM §10, never a modal-of-doom): invalid checksum, wrong word count, and incomplete input. Loading state while deriving/persisting uses Skeleton or a disabled control, not a spinner.
4. Overwrite guard. If an identity already exists (identity.json present / keychain populated), recovery must require an explicit, clearly-worded confirm-overwrite step — replacing an identity is destructive and irreversible. Plain language about what is lost.
5. The friends-list truth. State once, where it will actually be read (in the recovery flow and/or its success state): recovering your identity does not bring back your friends — they have no idea this new device is you, so you'll re-pair. One sentence, §14 voice, no apology theater.
6. Discharge D1 and D2 (above). The Settings → Identity row tells the truth; BipBackupPanel is extracted with a story and /style entry and the existing onboarding path is unchanged.
7. Tests (node-env): a known mnemonic → the exact Ed25519 pubkey from the V1-P3 vectors; invalid checksum rejected; wrong length rejected; whitespace/case normalization. Storybook stories for Recover (entry / invalid / success) and BipBackupPanel. Visual correctness is user-verifiable — say so in the PR.

Verification: tsc -b && vite build, storybook build, the token check script, lint, and the existing unit suite all green. Walk /style for the new BipBackupPanel row.

Acceptance criteria:
- Onboarding offers recovery before new-identity generation.
- A known mnemonic restores the exact pubkey from V1-P3 tests; bad input fails calmly inline.
- Overwrite is gated behind explicit confirmation.
- The "friends don't come back" fact is stated once, plainly.
- D1 and D2 are discharged; no mnemonic is ever written to disk.
````

## V3-P3: Custom keybindings UI

**Phase**: V3.
**Depends on**: V1-P7 global shortcuts (`src-tauri/src/lib.rs`), V1-P11 Settings → Shortcuts + `useSettingsStore`, DESIGN-SYSTEM §4 (`KeybindCapture`), §17 (keybindings table + conflict notes).
**Reads**: DESIGN-SYSTEM §4, §17; ARCHITECTURE §12 (capabilities).
**Outputs**: `KeybindCapture` primitive (+ story, + `/style`), a real Settings → Shortcuts rebind UI, persisted custom combos, live re-registration through `tauri-plugin-global-shortcut`, node-env tests.
**Acceptance criteria**:
- Rebinding PTT-friends to a new combo takes effect with no app restart.
- A combo that collides with the other binding or a known OS shortcut is refused with a one-line, specific explanation.
- "Reset to defaults" restores `Cmd/Ctrl+[` and `Cmd/Ctrl+]` and re-registers them.
- The capture interaction is keyboard-operable and screen-reader sane (it will be re-audited in V3-P7).
**Out of scope**: per-OS rebinding profiles; chording beyond a single modifier+key; rebinding non-global shortcuts.

**Prompt to paste**:

````
You are working on StudyVis, a peer-to-peer desktop study app for close friends. Read these in full before making decisions:
- /Users/scott/PycharmProjects/studyvis/PLAN.md
- /Users/scott/PycharmProjects/studyvis/ARCHITECTURE.md
- /Users/scott/PycharmProjects/studyvis/DESIGN-SYSTEM.md
- /Users/scott/PycharmProjects/studyvis/CLAUDE.md
- ~/.claude/projects/-Users-scott-PycharmProjects-studyvis/memory/MEMORY.md (carryovers from prior phases)

These are the source of truth. If anything in this prompt conflicts with them, surface the conflict — don't silently deviate.

Reasoning budget is unlimited. Use subagents freely. Call the advisor before committing to a non-obvious approach and once before declaring the task done. Use Context7 for library docs; verify versions and APIs.

Version policy: pinned versions are floors; prefer current; never silently downgrade. File-shape policy: prefer current framework idiom over a stale prescribed path; note it. Package-manager policy: use the repo lockfile's manager (npm); don't switch.

Verification policy: prefer headless commands (tsc -b, vite build, storybook build, cargo check). Avoid tauri dev and cross-machine tests in autonomous execution; mark them user-verifiable. NO RTL/jsdom harness exists (node-env Vitest only, zero *.test.tsx) — verify with node-env logic tests + Storybook; mark visual/registration user-verifiable. Do not add an RTL harness.

Phase invariant (V3): V1 + V2 + V3-P1 are shipped at v1.0.3. Do not regress shipped behavior. V3 adds polish/breadth only; surface anything that would alter a working flow. ISSUES.md I9 and I18 are accepted deviations; do not "fix" them.

Polish bar (V3): "done" means a stranger would call the screen finished. Obey DESIGN-SYSTEM.md §6 (motion), §10 (empty/loading/error states), §12 (layout grid + token spacing), §14 (copy: short, direct, second person, no hype; periods on sentences, not labels), §7 rule 5 (/style is the drift check). Tokens are the only source of color/spacing/font/radius/shadow/motion.

Scope discipline: nothing beyond what this prompt asks. No back-compat shims. No comments unless the why is non-obvious. No new docs.

End-of-task exit sequence (mandatory):
1. Carry surfaced debts into BUILD-PROMPTS.md (one-line bullets, format `- From V3-P3: <…>`, in the target prompt's CARRY-FORWARD DEBTS section above its YOUR TASK line; create the section if absent). Stage with the commit.
2. Single commit, only this task's files. Message: "V3-P3: <subject>".
3. Push to branch v3/p3-keybindings off main. No direct push to main.
4. On email-privacy rejection: git -c user.email='134114466+scotej@users.noreply.github.com' commit --amend --no-edit --reset-author
5. gh pr create --base main --head v3/p3-keybindings --title "V3-P3: custom keybindings". Summary + Test plan sections. Copilot auto-reviews.
6. Poll for the Copilot review (~30s, up to 10 min) via the reviews jq query. A declined-files message is a clean pass. If nothing lands, note it in a PR comment and go to step 9.
7. Fix actionable findings; re-run verification. Skip nits with one-line reasons in the follow-up message. Route any new debts per step 1.
8. One follow-up commit "V3-P3: address Copilot review" (or the no-review variant). Skip if nothing actionable, no nits, no new debts.
9. gh pr merge <num> --squash --delete-branch. Wait out running checks and retry once; rebase if stale; never --admin, never force-push main.
10. Summary in chat: shipped / deviations / Copilot addressed+skipped / inherited debts (routed) / merge+branch-delete confirmed.

---

CARRY-FORWARD DEBTS (from the V3 debt ledger — incorporate into this work):
- D3 — Settings → Shortcuts (src/features/settings/categories/ShortcutsCategory.tsx) currently renders the two PTT bindings read-only with a disabled "Coming soon" rebind row and the line "The rebind UI lands in V3." Replace that stub with a working KeybindCapture flow. Persist captured combos via the V1-P11 useSettingsStore (snake_case keys, optimistic set + error-field-on-failure pattern — match it exactly, don't invent a new store). Re-register at runtime through tauri-plugin-global-shortcut using the V1-P7 Mutex<Shortcut> interior-mutability pattern (PTT registration lives in src-tauri/src/lib.rs in the global-shortcut handler block — read it before changing it). The two actions are PTT-friends (default Cmd/Ctrl+[) and PTT-AI / talk-to-AI (default Cmd/Ctrl+]); the AI one is gated by the V2-P9 AiFeaturesFlag — rebinding it must not bypass that gate.

---

YOUR TASK: V3-P3 — Custom keybindings UI. Today both global shortcuts are hardcoded; users on macOS hit the documented Cmd+[ "back" conflict (DESIGN-SYSTEM §17) with no recourse. Give them recourse.

Orient first (Explore): read the current Rust shortcut registration and event emission in src-tauri/src/lib.rs, the V1-P7 interior-mutability pattern, ShortcutsCategory.tsx, and the useSettingsStore shape (keys, setters, error handling, test seam).

Then build:

1. KeybindCapture primitive per DESIGN-SYSTEM §4: a control that, when armed, listens for the next modifier+key combo and renders it with the Kbd primitive. It must be operable from the keyboard, show an obvious armed/disarmed state via the focus-ring + state-change transitions already in the token system (no new motion), and let the user cancel (Esc) without committing. Story + /style entry. Render the OS-native glyph convention (⌘ on macOS, literal "Ctrl" elsewhere) exactly as §17 specifies.
2. Settings → Shortcuts becomes real: a row per action (PTT-friends, PTT-AI) showing the active binding as Kbd, a Rebind affordance that arms KeybindCapture, and a "Reset to defaults" action. §10 states: the pane already has content, so no empty state, but show a clear inline error state for refused combos.
3. Conflict detection. Refuse a captured combo if it equals the other StudyVis binding or a known-reserved OS shortcut (enumerate a sensible per-platform denylist — at minimum the §17-noted ones and obvious system combos; verify nothing here needs a library). Refusal is a specific, calm one-liner ("Ctrl+C is reserved by the system. Pick another.") — never a generic error.
4. On save: persist via useSettingsStore and immediately re-register through tauri-plugin-global-shortcut so the new combo works with no restart, and the old one stops firing. Reset-to-defaults restores and re-registers Cmd/Ctrl+[ and Cmd/Ctrl+]. The AI binding stays behind the AiFeaturesFlag.
5. Discharge D3.

Tests (node-env): combo-to-string serialization round-trips; conflict detection flags self-collision and a reserved combo; reset returns the defaults; the settings keys persist and rehydrate via the store's test seam. Storybook: KeybindCapture (idle / armed / captured / conflict) and the Shortcuts pane. Live re-registration without restart is user-verifiable — say so.

Verification: tsc -b && vite build, storybook build, token check, lint, cargo check, existing tests — all green. Walk /style for KeybindCapture.

Acceptance criteria:
- Rebinding PTT-friends to e.g. Cmd/Ctrl+. works immediately, no restart; the old combo stops firing.
- Self-conflict and a reserved-combo are both caught and explained specifically.
- Reset-to-defaults restores and re-registers both bindings.
- D3 discharged; the AI binding still respects AiFeaturesFlag.
````

## V3-P4: Multi-monitor capture toggle

**Phase**: V3.
**Depends on**: V2-P3 capture pipeline (`src/features/ai/captureScreen.ts`), V2-P9 long-lived screen stream (`src/features/ai/sampleLoop.ts`), Settings → AI category.
**Reads**: ARCHITECTURE §8 (capture mechanics), PLAN §5 V2 non-goals (V2 = primary only; multi-monitor is V3), DESIGN-SYSTEM §10, §14.
**Outputs**: a "Capture displays" control in Settings → AI (Primary only / All displays), display enumeration + single-composite-frame logic in the capture path, node-env tests for the compositor, no per-tick OS re-prompts.
**Acceptance criteria**:
- "All displays" composites every display into one downscaled frame (≤ 2048 px wide, uniform scale) sent as the single screen image.
- Switching the setting takes effect on the next sample tick without a new OS picker prompt mid-session.
- The AI system prompt is unchanged — the model evaluates the composite.
- On a two-monitor host (one on study material, one on TikTok) with topic "studying", the judgment is off-task.
**Out of scope**: per-display selection UI (it's binary: primary vs all); changing the system prompt; capturing displays the OS won't grant.

**Prompt to paste**:

````
You are working on StudyVis, a peer-to-peer desktop study app for close friends. Read these in full before making decisions:
- /Users/scott/PycharmProjects/studyvis/PLAN.md
- /Users/scott/PycharmProjects/studyvis/ARCHITECTURE.md
- /Users/scott/PycharmProjects/studyvis/DESIGN-SYSTEM.md
- /Users/scott/PycharmProjects/studyvis/CLAUDE.md
- ~/.claude/projects/-Users-scott-PycharmProjects-studyvis/memory/MEMORY.md (carryovers from prior phases)

These are the source of truth. If anything conflicts with this prompt, surface it — don't silently deviate.

Reasoning budget is unlimited. Use subagents freely. Call the advisor before a non-obvious approach and once before declaring done. Use Context7 for library docs; verify the screen-capture/display-enumeration APIs against the current WebView behavior — do not assume.

Version policy: floors not ceilings; prefer current; never silently downgrade. File-shape policy: prefer current idiom; note deviations. Package-manager policy: repo lockfile (npm); don't switch.

Verification policy: headless commands are agent-verifiable (tsc -b, vite build, storybook build, cargo check). Multi-monitor behavior is inherently user-verifiable — mark it so. NO RTL/jsdom harness (node-env Vitest only); test the compositor as a pure function; do not add an RTL harness.

Phase invariant (V3): V1 + V2 + V3-P1 shipped at v1.0.3; don't regress. Polish/breadth only; surface anything that would change a working flow. ISSUES.md I9/I18 are accepted; don't "fix" them.

Polish bar (V3): finished, not functional. DESIGN-SYSTEM §6 (motion), §10 (empty/loading/error), §12 (grid + token spacing), §14 (copy voice), §7 rule 5 (/style). Tokens only for color/spacing/font/radius/shadow/motion.

Scope discipline: only what's asked. No shims, no speculative abstractions, no unexplained comments, no new docs.

End-of-task exit sequence (mandatory):
1. Route surfaced debts into BUILD-PROMPTS.md (`- From V3-P4: <…>` in the target prompt's CARRY-FORWARD DEBTS section above YOUR TASK; create if absent). Stage with the commit.
2. Single commit, only this task's files. Message: "V3-P4: <subject>".
3. Branch v3/p4-multimonitor off main; no direct push to main.
4. Email-privacy rejection → git -c user.email='134114466+scotej@users.noreply.github.com' commit --amend --no-edit --reset-author
5. gh pr create --base main --head v3/p4-multimonitor --title "V3-P4: multi-monitor capture". Summary + Test plan. Copilot auto-reviews.
6. Poll Copilot review (~30s, ≤10 min). Declined-files = clean pass. Nothing in window → PR comment, go to step 9.
7. Fix actionable findings; re-run verification; skip nits with reasons in the follow-up message; route new debts per step 1.
8. Follow-up commit "V3-P4: address Copilot review" (or no-review variant); skip if nothing actionable/noted/new.
9. gh pr merge <num> --squash --delete-branch; wait out checks/retry once; rebase if stale; never --admin or force-push main.
10. Chat summary: shipped / deviations / Copilot addressed+skipped / inherited debts routed / merged+branch deleted.

---

CARRY-FORWARD DEBTS (from the V3 debt ledger — incorporate into this work):
- D4 — src/features/ai/captureScreen.ts and the long-lived screen MediaStream acquired once in src/features/ai/sampleLoop.ts boot() defer display selection to the OS picker. getDisplayMedia({ video: true }) re-prompts on WKWebView/WebView2 on EVERY call — that is exactly why V2-P9 switched to one long-lived stream and a per-tick frame extract (getCaptureRuntime().extractFrame + fitWidth + encodeJpegBase64). Multi-monitor must enumerate displays and composite WITHOUT reintroducing a per-tick getDisplayMedia call or a mid-session OS prompt. Read sampleLoop.ts and the README §61 note before changing the acquire path; keep mapDisplayMediaError's denied→overlay mapping intact.

---

YOUR TASK: V3-P4 — Multi-monitor capture toggle. V2 deliberately shipped primary-display-only; PLAN §5 names multi-monitor a V3 item. A user with a second monitor can currently game the AI by keeping distractions off-primary.

Orient (Explore): read captureScreen.ts, sampleLoop.ts (boot/acquire + per-tick extract + the 'ended' latch), how the screen frame is encoded and POSTed (ARCHITECTURE §8), and where Settings → AI is defined and how its controls persist (the V2 settings keys).

Then build:

1. Settings → AI gains a "Capture displays" control: Primary only (current default) / All displays. Use the RadioGroup primitive already vendored; persist via the existing AI settings store path (match the established key style; read it, don't guess). Copy per §14: one line of helper text that says, plainly, what "All displays" does and that it does not change what peers see (peers never see screen pixels — ARCHITECTURE §4/§8).
2. Display enumeration + compositing. Determine the set of displays once per acquire (verify the viable mechanism via Context7 — getDisplayMedia constraints, getAllScreensMedia where available, or a Rust-side display-enumeration command — pick the one that does NOT re-prompt per tick on WKWebView/WebView2; justify via advisor). Each tick, when "All displays" is selected, composite the captured displays into ONE image — a horizontal strip is fine — then downscale uniformly so the composite is at most 2048 px wide. Send that single composited frame in the same image content block; the system prompt and request shape are unchanged.
3. Fall back cleanly: if enumeration yields one display or the OS only grants one, behave exactly like "Primary only" — no error, no empty frame. If the user revokes screen access, the existing denied→overlay path must still fire (don't break mapDisplayMediaError / the 'ended' latch).
4. Discharge D4. No per-tick re-prompt; switching the setting applies on the next tick.

Tests (node-env): the compositor is a pure function — feed it 1, 2, 3 synthetic frames of differing sizes and assert the output is one image, ≤2048 wide, uniformly scaled, with each input present and undistorted (assert on dimensions/layout math, not pixels). Test the single-display fallback. Storybook: the Settings → AI control states. The end-to-end "two monitors, one on TikTok ⇒ off-task" check is user-verifiable — write it as an explicit manual test-plan step in the PR.

Verification: tsc -b && vite build, storybook build, token check, lint, cargo check, existing AI tests — all green.

Acceptance criteria:
- "All displays" produces one composite ≤2048 px wide, uniform scale, every display present.
- Switching the setting applies next tick with no mid-session OS prompt.
- System prompt unchanged; single-display hosts behave as before.
- D4 discharged; denied-capture overlay path intact.
````

## V3-P5: Light + auto theme polish

**Phase**: V3.
**Depends on**: V1-P2 tokens (`src/design/tokens.ts`), the theme system (`src/design/theme.tsx`, `theme-context.ts`, `index.css`'s `:root.light`), all 55 Storybook stories.
**Reads**: DESIGN-SYSTEM §2 (light tokens), §5 (three modes), §11 (contrast ≥ WCAG AA), §16 (theme variants are post-1.0 — see note).
**Outputs**: contrast-corrected `lightTokens`, a light-theme Storybook variant for every component, an `auto`-follows-OS verification, DESIGN-SYSTEM §2 updated if any token moves, no functional motion changes.
**Acceptance criteria**:
- Every component renders cleanly in light theme — no invisible text, no muddy borders, no accent that vanishes on the light surface.
- Every text/background pairing passes WCAG AA (verified by a script: axe-core or pa11y — verify current via Context7).
- `auto` follows the OS dark/light switch with no reload and no flash of the wrong theme.
- Storybook shows each component in both themes.
**Out of scope**: sepia and high-contrast variants — **deferred to post-1.0** by scope decision (DESIGN-SYSTEM §16 treats theme variants as a new release feature). Reduced-motion is **V3-P7's** job — do not implement motion gating here, but do not add motion that couldn't be gated.

**Prompt to paste**:

````
You are working on StudyVis, a peer-to-peer desktop study app for close friends. Read these in full before making decisions:
- /Users/scott/PycharmProjects/studyvis/PLAN.md
- /Users/scott/PycharmProjects/studyvis/ARCHITECTURE.md
- /Users/scott/PycharmProjects/studyvis/DESIGN-SYSTEM.md
- /Users/scott/PycharmProjects/studyvis/CLAUDE.md
- ~/.claude/projects/-Users-scott-PycharmProjects-studyvis/memory/MEMORY.md (carryovers from prior phases)

These are the source of truth. If anything conflicts with this prompt, surface it — don't silently deviate.

Reasoning budget is unlimited. Use subagents freely. Call the advisor before a non-obvious approach and once before declaring done. Use Context7 to confirm the current axe-core / pa11y API before depending on it.

Version policy: floors not ceilings; prefer current; never silently downgrade. File-shape policy: prefer current idiom; note deviations. Package-manager: repo lockfile (npm); don't switch.

Verification policy: headless commands are agent-verifiable (tsc -b, vite build, storybook build, the contrast script). The OS auto-switch and final visual judgment are user-verifiable — mark them. NO RTL/jsdom harness (node-env Vitest only); contrast is checked by a script over the token pairs, not RTL.

Phase invariant (V3): V1 + V2 + V3-P1 shipped at v1.0.3; don't regress dark theme (the default and the one users see most). Polish/breadth only. ISSUES.md I9/I18 accepted; don't "fix".

Polish bar (V3): finished, not functional. DESIGN-SYSTEM §6 (motion — do NOT add or change motion here), §10 (states), §12 (grid + token spacing), §14 (copy voice), §7 rule 5 (/style — the primary instrument for this prompt). Tokens are the only source of color/spacing/font/radius/shadow/motion; light theme is a token-map swap, never per-component branching.

Scope discipline: only what's asked. No sepia/high-contrast (post-1.0). No reduced-motion work (V3-P7). No shims, no unexplained comments, no new docs (editing DESIGN-SYSTEM §2 is allowed and expected if a token moves).

End-of-task exit sequence (mandatory):
1. Route surfaced debts into BUILD-PROMPTS.md (`- From V3-P5: <…>` in the target prompt's CARRY-FORWARD DEBTS section above YOUR TASK; create if absent). Stage with the commit.
2. Single commit, only this task's files (lightTokens, stories, theme code, DESIGN-SYSTEM §2 if changed). Message: "V3-P5: <subject>".
3. Branch v3/p5-light-theme off main; no direct push to main.
4. Email-privacy rejection → git -c user.email='134114466+scotej@users.noreply.github.com' commit --amend --no-edit --reset-author
5. gh pr create --base main --head v3/p5-light-theme --title "V3-P5: light + auto theme polish". Summary + Test plan. Copilot auto-reviews.
6. Poll Copilot review (~30s, ≤10 min). Declined-files = clean pass. Nothing in window → PR comment, step 9.
7. Fix actionable findings; re-run verification; skip nits with reasons in the follow-up message; route new debts per step 1.
8. Follow-up commit "V3-P5: address Copilot review" (or no-review variant); skip if nothing actionable/noted/new.
9. gh pr merge <num> --squash --delete-branch; wait out checks/retry once; rebase if stale; never --admin / force-push main.
10. Chat summary: shipped / deviations (incl. any DESIGN-SYSTEM §2 token edits, with the contrast reason) / Copilot addressed+skipped / inherited debts routed / merged+branch deleted.

---

CARRY-FORWARD DEBTS (from the V3 debt ledger — incorporate into this work):
- From V3-P3: walk the new `KeybindCapture` primitive in both themes — the muted helper line, the `status-alerted` inline error, the Kbd group at `opacity-40` while armed, and the Rebind button's `outline` → `secondary` swap. The /style demo currently only renders the mac platform; consider adding an other-platform mirror or a platform parameter so the literal "Ctrl" rendering is part of the drift check too.

---

YOUR TASK: V3-P5 — Light + auto theme polish. Light and auto are wired (src/design/theme.tsx, theme-context.ts, index.css :root.light) but were never walked component-by-component; lightTokens is a first cut. Make light theme genuinely first-class, not a fallback.

Orient (Explore): read tokens.ts (dark + lightTokens), index.css (how :root.light applies the map), theme.tsx (how dark/light/auto resolve; how auto reads the OS), and the /style route + the 55 stories.

Then:

1. Walk every primitive and every app component in BOTH themes via /style and Storybook. For each, look specifically for: text that loses contrast on bg-surface/bg-raised, borders that disappear, the amber accent washing out on a light canvas, status colors (focused/warning/alerted/online/offline) that stop reading as distinct, focus rings that vanish, shadows that look dirty on light. Produce a concrete defect list before editing (advisor-check it).
2. Run a contrast audit with a script (axe-core or pa11y — confirm the current API via Context7) over every foreground/background token pairing the UI actually uses, in light. Every text pairing must pass WCAG AA (DESIGN-SYSTEM §11).
3. Fix by adjusting lightTokens ONLY — never by per-component theme branching (DESIGN-SYSTEM §5: switching theme is a token-map re-render, components don't branch on theme). Keep the same hues; move lightness/saturation. If a token value changes, update DESIGN-SYSTEM §2's lightTokens block to match (the doc must not drift) and call it out as a deliberate deviation with the contrast reason.
4. Auto theme: verify it follows the OS without a reload and without a flash of the wrong theme on launch (FOUC). If there is a flash, fix the resolution order so the correct token map is applied before first paint. The live OS sunset switch is user-verifiable — write it as an explicit manual test-plan step.
5. Add a light-theme variant to every existing Storybook story (a shared decorator/parameter is fine — don't hand-duplicate 55 files if a parameterized theme toggle gives both renders; justify the approach via advisor). The goal is that drift is visible in Storybook forever, cheaply.

Verification: tsc -b && vite build, storybook build, the contrast script (green = AA on all pairs), token check, lint, existing tests. Walk /style in both themes one last time.

Acceptance criteria:
- Every component is clean in light theme; the defect list is empty.
- The contrast script passes WCAG AA on all used pairings.
- Auto follows the OS with no reload, no FOUC.
- Storybook renders every component in both themes; DESIGN-SYSTEM §2 matches the shipped tokens.
````

## V3-P6: Custom frameless window chrome (opt-in)

**Phase**: V3.
**Depends on**: V1-P1 Tauri config (`src-tauri/tauri.conf.json`), V1-P11 Settings → Appearance + `useSettingsStore`, the theme/token system.
**Reads**: DESIGN-SYSTEM §1 (Linear restraint; "custom frameless chrome is V3 polish"), §12 (layout), §6 (motion), §14 (copy); ARCHITECTURE §12 (capabilities), §13 (window/tray lifecycle).
**Outputs**: a custom titlebar component, Tauri window config supporting frameless mode, an opt-in toggle in Settings → Appearance (native default), a draggable region + working window controls per OS, node-env-testable layout logic, DESIGN-SYSTEM update if a chrome token/section is added.
**Acceptance criteria**:
- Native chrome remains the default; the app behaves exactly as today until the user opts in.
- With custom chrome on: a frameless window with a StudyVis titlebar, an OS-correct control cluster (macOS traffic-light spacing respected; Windows min/restore/close), a draggable title region, and no double title bar.
- Toggling the setting is honest about needing a relaunch if Tauri requires it (state it; don't fake a live swap that doesn't work).
- Tray, minimize-to-tray, Cmd/Ctrl+Q, and the V2 floating AI window are all unaffected.
**Out of scope**: per-OS bespoke chrome beyond control placement; Linux (out of 1.0); animating the window; replacing the V2 AI dialog window's own decoration model.

**Prompt to paste**:

````
You are working on StudyVis, a peer-to-peer desktop study app for close friends. Read these in full before making decisions:
- /Users/scott/PycharmProjects/studyvis/PLAN.md
- /Users/scott/PycharmProjects/studyvis/ARCHITECTURE.md
- /Users/scott/PycharmProjects/studyvis/DESIGN-SYSTEM.md
- /Users/scott/PycharmProjects/studyvis/CLAUDE.md
- ~/.claude/projects/-Users-scott-PycharmProjects-studyvis/memory/MEMORY.md (carryovers from prior phases)

These are the source of truth. If anything conflicts with this prompt, surface it — don't silently deviate.

Reasoning budget is unlimited. Use subagents freely. Call the advisor before committing to the chrome approach (this is the highest-risk V3 prompt) and once before declaring done. Use Context7 for the current Tauri 2 window decoration / drag-region / macOS title-bar-style APIs — verify, do not assume; Tauri's chrome story changes between minor versions.

Version policy: floors not ceilings; prefer current Tauri 2.x; never silently downgrade. File-shape policy: prefer current Tauri idiom (lib.rs builder, capability files) over any stale prescribed path; note deviations. Package-manager: repo lockfile (npm); don't switch.

Verification policy: headless commands are agent-verifiable (tsc -b, vite build, storybook build, cargo check). Actual window chrome on each OS is inherently user-verifiable — mark every OS-visual claim user-verifiable and give a precise manual test plan. NO RTL/jsdom harness; test titlebar layout logic as pure functions.

Phase invariant (V3): V1 + V2 + V3-P1 shipped at v1.0.3. Native chrome is the SHIPPED behavior — do not regress it; it stays the default. The custom chrome is strictly opt-in. Don't disturb tray, minimize-to-tray, Cmd/Ctrl+Q, autostart, or the V2 always-on-top AI dialog window. ISSUES.md I9/I18 accepted; don't "fix".

Polish bar (V3): this prompt IS polish — the bar is highest here. DESIGN-SYSTEM §1 (Linear restraint, calm, warm — not a toy), §6 (no decorative window motion), §12 (the titlebar obeys the spacing/height grid; tokens only), §14 (any chrome copy is minimal and human), §7 rule 5 (add a /style entry for the titlebar). Tokens are the only source of color/spacing/font/radius/shadow/motion.

Scope discipline: opt-in custom chrome only. No Linux. No window animation. No new docs (a DESIGN-SYSTEM addition for chrome tokens/section is allowed and expected if you introduce any).

End-of-task exit sequence (mandatory):
1. Route surfaced debts into BUILD-PROMPTS.md (`- From V3-P6: <…>` in the target prompt's CARRY-FORWARD DEBTS section above YOUR TASK; create if absent). Stage with the commit.
2. Single commit, only this task's files. Message: "V3-P6: <subject>".
3. Branch v3/p6-window-chrome off main; no direct push to main.
4. Email-privacy rejection → git -c user.email='134114466+scotej@users.noreply.github.com' commit --amend --no-edit --reset-author
5. gh pr create --base main --head v3/p6-window-chrome --title "V3-P6: custom window chrome". Summary + Test plan (with explicit per-OS manual steps). Copilot auto-reviews.
6. Poll Copilot review (~30s, ≤10 min). Declined-files = clean pass. Nothing in window → PR comment, step 9.
7. Fix actionable findings; re-run verification; skip nits with reasons in the follow-up message; route new debts per step 1.
8. Follow-up commit "V3-P6: address Copilot review" (or no-review variant); skip if nothing actionable/noted/new.
9. gh pr merge <num> --squash --delete-branch; wait out checks/retry once; rebase if stale; never --admin / force-push main.
10. Chat summary: shipped / deviations / Copilot addressed+skipped / inherited debts routed / merged+branch deleted / explicit list of what is user-verifiable per OS.

---

CARRY-FORWARD DEBTS (from the V3 debt ledger — incorporate into this work):
- From V3-P5: light theme now uses warm-tinted low-alpha shadows (`--shadow-token-sm/md/lg` re-declared in `:root.light` of `src/design/index.css`; the values are mirrored in `lightTokens.shadow` for doc fidelity). Any window-level shadow the custom chrome introduces — drop shadow under the titlebar, raised state on focus, etc. — must follow the same per-theme branching via CSS variables, not hardcoded `rgba(0, 0, 0, …)`. The contrast script (`npm run check-contrast`) and the WCAG 1.4.11 inactive-component exemptions apply if the chrome introduces new fg/bg pairings (extend `scripts/check-contrast.ts` PAIRINGS).

---

YOUR TASK: V3-P6 — Custom frameless window chrome, opt-in. DESIGN-SYSTEM §1 names this the V3 polish that makes StudyVis feel native rather than functional. It is also the riskiest change in V3 — treat it with care, default OFF, and never at the cost of regressing the shipped native experience.

Orient (Explore): read src-tauri/tauri.conf.json (window config — there is no `decorations` key today, so it's native), the V1-P11 Settings → Appearance pane + useSettingsStore (keys, optimistic-set + error-field pattern, the Rust-roundtrip pattern used by minimize-to-tray), the tray/minimize/Cmd-Q handling in src-tauri/src/lib.rs, and how the V2 floating AI dialog window is created (it must keep its own model). Confirm the current Tauri 2 approach to frameless windows, custom drag regions, and macOS title-bar styling via Context7 before designing.

Then build:

1. A custom titlebar component (presentational, token-only, in src/components/, with a Storybook story and /style entry): the studyvis wordmark per DESIGN-SYSTEM §15, a draggable region, and an OS-correct window-control cluster — on macOS respect the traffic-light position/inset (don't overlap the system buttons; either host them or inset content correctly — verify the Tauri-current way), on Windows a minimize/restore/close cluster matching platform order. Height and spacing come from tokens; if you need a chrome height/inset token, add it to tokens.ts and document it in DESIGN-SYSTEM §2 + a short §1/§12 note (this is an authorized canonical-doc edit; flag it).
2. Window config: support frameless (decorations off) without breaking the default. The default stays native. Determine honestly whether Tauri can switch decorations live or needs a relaunch; if it needs a relaunch, the toggle says so in one calm line and offers to relaunch — do not pretend a live swap that doesn't actually work.
3. Settings → Appearance gains a "Window style" control (RadioGroup or Switch as fits §4): System (default) / Custom. Persist via useSettingsStore exactly like the other Appearance prefs (match the Rust-roundtrip pattern if a relaunch/native call is involved). Copy per §14: one honest line about what changes and any relaunch.
4. Custom chrome must coexist with everything: tray + minimize-to-tray still work, Cmd/Ctrl+Q behaves per the V1-P11 minimize-to-tray rule, the window is still resizable from edges, no double titlebar, the V2 AI dialog window keeps its transparent/no-decoration/always-on-top model untouched. The titlebar must render correctly in dark AND light (and under auto) since it's now app-painted, not OS-painted.
5. Reduced motion: introduce no window or titlebar animation (V3-P7 will assume there is none to gate).

Tests (node-env): control-cluster layout/order math per platform as pure functions; the settings key round-trips via the store seam. Everything visible on a real window is user-verifiable: write a precise per-OS manual test plan (macOS: traffic lights aligned, drag works, double-click-zoom still works, fullscreen, light/dark; Windows: control order, snap, maximize, light/dark; both: tray + Cmd/Ctrl+Q + resize-from-edge unaffected; toggling back to System fully restores native chrome).

Verification: tsc -b && vite build, storybook build, token check, lint, cargo check, existing tests — all green. Walk /style for the titlebar in both themes.

Acceptance criteria:
- Default is unchanged native chrome; opting in yields clean frameless chrome with OS-correct controls and a working drag region; opting back out fully restores native.
- No double titlebar; tray, minimize-to-tray, Cmd/Ctrl+Q, resize, and the V2 AI window are all unaffected.
- Titlebar is correct in dark + light + auto; any new chrome token is in tokens.ts and DESIGN-SYSTEM §2.
- Relaunch requirement (if any) is stated honestly, not faked.
````

## V3-P7: Accessibility pass + app-wide reduced motion

**Phase**: V3.
**Depends on**: every shipped surface, including V3-P2…P6 (this prompt audits the *final* feature set and the new chrome/themes — run it after them).
**Reads**: DESIGN-SYSTEM §6 (motion + "reduced-motion replaces all of it with opacity changes"), §11 (a11y minimums; "V3 adds: full screen-reader pass, reduced-motion mode"), §14; PLAN §5 V3 ("accessibility pass"), ARCHITECTURE §9 (audit log is a live region).
**Outputs**: real app-wide reduced-motion behavior wired to the V1-P11 `reduce_motion` setting **and** `prefers-reduced-motion`, a keyboard-navigability pass, an ARIA/screen-reader pass, an axe-core (or pa11y) CI gate, no visual regressions.
**Acceptance criteria**:
- The full core flow (open app → invite friend → join session → leave; plus onboarding incl. recovery, Settings, post-session report) is operable from keyboard only, with a visible focus ring everywhere and no traps.
- Reduced motion (settings toggle **or** OS preference) demonstrably replaces every transition with opacity-only/instant, app-wide — not just `ScoreGauge`.
- Every icon-only button has an `aria-label`; dynamic regions (audit log, AI response, alerts) announce; dialogs trap focus and return it on close; one `h1` per route, no skipped levels.
- An axe-core/pa11y check runs in CI and passes with zero violations on the rendered surfaces it can reach.
**Out of scope**: a full WCAG AAA pass; redesigning components; adding an RTL harness; localization.

**Prompt to paste**:

````
You are working on StudyVis, a peer-to-peer desktop study app for close friends. Read these in full before making decisions:
- /Users/scott/PycharmProjects/studyvis/PLAN.md
- /Users/scott/PycharmProjects/studyvis/ARCHITECTURE.md
- /Users/scott/PycharmProjects/studyvis/DESIGN-SYSTEM.md
- /Users/scott/PycharmProjects/studyvis/CLAUDE.md
- ~/.claude/projects/-Users-scott-PycharmProjects-studyvis/memory/MEMORY.md (carryovers from prior phases)

These are the source of truth. If anything conflicts with this prompt, surface it — don't silently deviate.

Reasoning budget is unlimited. Use subagents freely. Call the advisor before committing to the reduced-motion mechanism (it's app-wide and easy to get wrong) and once before declaring done. Use Context7 to confirm the current axe-core / pa11y API and the prefers-reduced-motion + Tauri specifics.

Version policy: floors not ceilings; prefer current; never silently downgrade. File-shape policy: prefer current idiom; note deviations. Package-manager: repo lockfile (npm); don't switch.

Verification policy: headless commands are agent-verifiable (tsc -b, vite build, storybook build, the a11y check). Screen-reader behavior (VoiceOver/Narrator) is user-verifiable — give a precise manual script. NO RTL/jsdom harness — do the axe check against built/static output or Storybook, and node-test the reduced-motion decision logic as a pure function. Do not add an RTL harness.

Phase invariant (V3): V1 + V2 + V3-P1..P6 are shipped/landed; do not regress them or their visuals. Reduced motion must change motion, nothing else. ISSUES.md I9/I18 accepted; don't "fix".

Polish bar (V3): accessibility IS polish. DESIGN-SYSTEM §6 (reduced motion = opacity-only/instant for ALL of the five permitted uses + the state-change transitions), §10, §11, §12, §14, §7 rule 5. Tokens only; the focus ring is the existing shadow.glow + border.strong tokens — don't invent a new one.

Scope discipline: a11y + reduced motion only. No redesigns, no new features, no localization, no RTL harness, no new docs (a DESIGN-SYSTEM §11 update reflecting "reduced motion shipped" is allowed).

End-of-task exit sequence (mandatory):
1. Route surfaced debts into BUILD-PROMPTS.md (`- From V3-P7: <…>` in the target prompt's CARRY-FORWARD DEBTS section above YOUR TASK; create if absent). Stage with the commit.
2. Single commit, only this task's files. Message: "V3-P7: <subject>".
3. Branch v3/p7-a11y off main; no direct push to main.
4. Email-privacy rejection → git -c user.email='134114466+scotej@users.noreply.github.com' commit --amend --no-edit --reset-author
5. gh pr create --base main --head v3/p7-a11y --title "V3-P7: accessibility + reduced motion". Summary + Test plan (with the SR manual script). Copilot auto-reviews.
6. Poll Copilot review (~30s, ≤10 min). Declined-files = clean pass. Nothing in window → PR comment, step 9.
7. Fix actionable findings; re-run verification; skip nits with reasons in the follow-up message; route new debts per step 1.
8. Follow-up commit "V3-P7: address Copilot review" (or no-review variant); skip if nothing actionable/noted/new.
9. gh pr merge <num> --squash --delete-branch; wait out checks/retry once; rebase if stale; never --admin / force-push main.
10. Chat summary: shipped / deviations / Copilot addressed+skipped / inherited debts routed / merged+branch deleted / the user-verifiable SR script.

---

CARRY-FORWARD DEBTS (from the V3 debt ledger — incorporate into this work):
- D5 — The V2-P9 long-lived screen MediaStream keeps the OS screen-recording indicator lit for the entire AI session, and macOS NSScreenCaptureUsageDescription is a documented no-op (the real control is System Settings → Privacy & Security → Screen Recording). Wherever onboarding/permissions explains screen capture, the copy must (a) tell users the recording indicator stays on the whole session and that's expected, and (b) point macOS users to the System Settings toggle rather than implying an in-app purpose-string prompt. (The exact wording is finalized in V3-P8's copy pass; here, ensure the information is present and announced accessibly — don't leave it only as a visual.)
- From V3-P2: re-audit `src/features/identity/RecoverView.tsx` for screen-reader and reduced-motion sanity — the `role="alert"` inline error region, focus order when the overwrite-confirm phase swaps the whole screen, and the textarea `aria-describedby` toggling between `recover-count` and `recover-error`.
- From V3-P3: gate the `transition-opacity ease-out-token` on `KeybindCapture`'s Kbd-group fade-while-armed by the central reduced-motion source. Also re-audit the capture interaction: `aria-pressed` on the Rebind button, `role="alert"` on the inline conflict span, the focus-on-arm via `buttonRef.current?.focus()` inside `useEffect`, and the document-level `keydown` capture listener (capture mode is intentional to beat focused-element handlers; make sure SR + keyboard-only users can still cancel via Esc reliably).
- From V3-P6: when the user is in opt-in custom chrome, the Windows `<TitleBar />` control cluster (Minimize / Maximize·Restore / Close) is the only interactive element above the route. Tab order must reach the wordmark drag region's siblings: each button is keyboard-reachable (aria-label set, focus-visible swaps in `bg-bg-raised text-text-primary`), but verify the visible focus ring matches `shadow.glow + border.strong` per §11 and that Enter/Space activate them. Also: gate the `transition-colors duration-fast ease-out-token` on the control buttons by the central reduced-motion source. Finally: the relaunch on chrome toggle paints a one-frame native frame on Windows before `set_decorations(false)` strips it — fix by setting `"visible": false` on the main window in `tauri.conf.json` and calling `window.show()` at the *end* of `setup_desktop` (after `apply_window_style`). Reduced motion path stays correct because `window.show()` is instant.

---

YOUR TASK: V3-P7 — Accessibility pass + app-wide reduced motion. DESIGN-SYSTEM §11 promised V3 would add "full screen-reader pass, reduced-motion mode." Today only ScoreGauge respects prefers-reduced-motion and the V1-P11 reduce_motion setting toggles a value almost nothing reads. Make the promise real across the finished app (now including recovery, keybindings, multi-monitor settings, the new chrome, and both themes).

Orient (Explore): inventory current a11y — aria-live usage, focus-visible styles in index.css, the lone prefers-reduced-motion use in ScoreGauge, the reduce_motion settings key and who (almost no one) reads it. Map every motion site against DESIGN-SYSTEM §6's five permitted uses + the allowed state-change transitions. Map every route's heading structure, every icon-only button, every dynamic region (audit log per ARCHITECTURE §9, AI response bubble, alerts, toasts), every dialog.

Then:

1. Reduced motion, app-wide and centralized. One source of truth that resolves "reduce motion?" from (the V1-P11 reduce_motion setting) OR (prefers-reduced-motion) and makes every one of §6's five motion uses and the state-change transitions become opacity-only or instant — not just ScoreGauge. Prefer a token/CSS-layer mechanism over per-component conditionals so it can't be forgotten by future components (advisor-check the mechanism). The decision function is node-testable; the visual result is user-verifiable.
2. Keyboard pass: every interactive element reachable by Tab in DOM order, operable with Enter/Space, no traps, Esc closes dialogs/popovers, the floating AI dialog and the new titlebar controls are reachable. Visible focus ring everywhere using the existing shadow.glow + border.strong tokens. Walk the full flow keyboard-only.
3. Screen-reader pass: aria-label on every icon-only button; role + aria-live on dynamic regions (audit log = polite, alerts = assertive — match severity); dialogs trap focus and restore it to the trigger on close (Radix gives most of this — verify it's actually wired, not assumed); one h1 per route, no skipped levels; status conveyed by more than color (DESIGN-SYSTEM §11 — dots already pair shape/label; verify the new V3 surfaces keep that).
4. CI gate: add an axe-core or pa11y step (confirm current API via Context7) to the existing CI workflow, run against the reachable rendered surfaces (built output or Storybook), failing the build on violations. Don't bolt on an RTL harness to achieve this.
5. Discharge D5's accessibility half: the screen-recording-indicator + macOS-settings information must exist and be announced accessibly (final wording is V3-P8's).

Verification: tsc -b && vite build, storybook build, the a11y check (zero violations), token check, lint, existing tests — all green. Provide a precise VoiceOver (macOS) / Narrator (Windows) manual script as the user-verifiable test plan: friends list, session view, audit log, post-session report, onboarding incl. recovery, Settings.

Acceptance criteria:
- Whole core flow keyboard-only with visible focus and no traps.
- Reduced motion (setting OR OS) kills all motion app-wide, demonstrably beyond ScoreGauge; nothing but motion changes.
- Icon buttons labelled; live regions announce; dialogs trap+restore focus; clean heading hierarchy.
- axe/pa11y CI step passes with zero violations; D5 info present and announced.
````

## V3-P8: Design cohesion & copy pass

**Phase**: V3.
**Depends on**: everything (this is the penultimate, cross-cutting pass — run it after V3-P2…P7 so it audits the complete surface).
**Reads**: DESIGN-SYSTEM §6, §10, §12, §13, §14 (the copy rubric — this prompt's spine), §7 rule 5; PLAN §3 ("polished, not MVP").
**Outputs**: a single user-facing strings module with all copy rewritten to the §14 voice, a screen-by-screen consistency reconciliation (spacing, layout, motion, empty/loading/error triads), a walked checklist in the PR, no behavior changes.
**Acceptance criteria**:
- Every user-facing string lives in one strings module and reads in StudyVis's voice: short, direct, second person, no hype; periods on full sentences, none on labels/buttons; "sound like a friend wrote it" (the §14 table is the test — no string fails it).
- Every screen obeys the §12 grid: page padding `space.5`, section gap `space.6`, inline gap `space.3`; one content max-width source; no off-grid one-offs.
- Every async/stateful surface has all three of empty / loading (Skeleton) / error (inline, never modal-of-doom) per §10.
- Motion across the app is exactly §6's five uses plus allowed state-change transitions — nothing decorative, nothing repeating, no spinners.
- `/style` reflects the final system; the PR contains the screen-by-screen checklist with each item marked consistent.
**Out of scope**: new features; redesigning components or the token palette; i18n/translation (a single-locale strings module is the deliverable, not multi-language); behavior changes.

**Prompt to paste**:

````
You are working on StudyVis, a peer-to-peer desktop study app for close friends. Read these in full before making decisions:
- /Users/scott/PycharmProjects/studyvis/PLAN.md
- /Users/scott/PycharmProjects/studyvis/ARCHITECTURE.md
- /Users/scott/PycharmProjects/studyvis/DESIGN-SYSTEM.md
- /Users/scott/PycharmProjects/studyvis/CLAUDE.md
- ~/.claude/projects/-Users-scott-PycharmProjects-studyvis/memory/MEMORY.md (carryovers from prior phases)

These are the source of truth. If anything conflicts with this prompt, surface it — don't silently deviate.

Reasoning budget is unlimited. Use subagents freely (this prompt spans the whole app — use Explore widely and parallel general-purpose agents to inventory copy and screens). Call the advisor before committing to the strings-module shape and once before declaring done.

Version policy: floors not ceilings; prefer current. File-shape policy: prefer current idiom; note deviations. Package-manager: repo lockfile (npm); don't switch.

Verification policy: headless commands are agent-verifiable (tsc -b, vite build, storybook build, token check, lint). The felt result is user-verifiable — deliver the screen-by-screen checklist so the user can spot-check. NO RTL/jsdom harness; node-test that the strings module exports resolve and that no component imports a now-removed inline literal (a lint/grep guard is acceptable). Do not add an RTL harness.

Phase invariant (V3): V1 + V2 + V3-P1..P7 shipped/landed. THIS PROMPT CHANGES NO BEHAVIOR — only wording, spacing, layout cohesion, and state-coverage. If a copy or spacing change would alter logic, stop and surface it. Do not regress accessibility (V3-P7) — moved/centralized strings must keep their aria roles/labels. ISSUES.md I9/I18 accepted; don't "fix".

Polish bar (V3): this prompt IS the polish bar made concrete. DESIGN-SYSTEM §14 is the spine: the before/after table in §14 is the literal rubric — every string must pass it. §6 (motion discipline), §10 (the empty/loading/error triad everywhere), §12 (the layout grid), §13 (sound rules), §7 rule 5 (/style is the cohesion mirror). Tokens only.

Scope discipline: cohesion + copy only. No features, no component redesigns, no palette changes, no translation/i18n, no behavior changes, no new docs (a DESIGN-SYSTEM §14 example refresh is allowed if the voice is sharpened).

End-of-task exit sequence (mandatory):
1. Route surfaced debts into BUILD-PROMPTS.md (`- From V3-P8: <…>` in the target prompt's CARRY-FORWARD DEBTS section above YOUR TASK; create if absent). Stage with the commit.
2. Single commit, only this task's files. Message: "V3-P8: <subject>".
3. Branch v3/p8-cohesion off main; no direct push to main.
4. Email-privacy rejection → git -c user.email='134114466+scotej@users.noreply.github.com' commit --amend --no-edit --reset-author
5. gh pr create --base main --head v3/p8-cohesion --title "V3-P8: design cohesion & copy". Summary + Test plan + the screen-by-screen checklist. Copilot auto-reviews.
6. Poll Copilot review (~30s, ≤10 min). Declined-files = clean pass. Nothing in window → PR comment, step 9.
7. Fix actionable findings; re-run verification; skip nits with reasons in the follow-up message; route new debts per step 1.
8. Follow-up commit "V3-P8: address Copilot review" (or no-review variant); skip if nothing actionable/noted/new.
9. gh pr merge <num> --squash --delete-branch; wait out checks/retry once; rebase if stale; never --admin / force-push main.
10. Chat summary: shipped / deviations / Copilot addressed+skipped / inherited debts routed / merged+branch deleted / the cohesion checklist (screens × {copy, grid, states, motion} all marked).

---

CARRY-FORWARD DEBTS (from the V3 debt ledger — incorporate into this work):
- D5 (copy half) — Finalize the screen-capture wording: onboarding/permissions copy must say, in StudyVis's voice, that the OS screen-recording indicator stays lit for the whole AI session (expected, not a bug) and that macOS users grant/revoke this in System Settings → Privacy & Security → Screen Recording (the in-app purpose string is a no-op). Keep V3-P7's accessible announcement intact; only sharpen the words.
- D6 (triage) — Three owner-less UX tunables exist: alertsUiStore PEER_ALERT_TTL_MS / WARNING_TTL_MS as a tile-alert-duration control; evaluateBreakRules using a rolling 2-hour window instead of "4 breaks since session start"; a sessions.breaks_taken column if the post-session report should surface breaks taken. For each: implement it ONLY if it measurably improves the felt product and fits this pass without behavior risk; otherwise leave it and explicitly hand it to V3-P9 to record as deliberately deferred. State your decision per item in the summary.
- From V3-P2: the onboarding identity fork gives Recover a Back-to-options affordance but the create path (IdentitySetupGate) has none, and Settings → Identity "Recovery phrase" is now informational-only — if cohesion judges the asymmetry a trap, add a symmetric back without changing shipped IdentitySetup chrome; if a Settings "Recover from backup" entry is added, reuse the `Recover` container rather than duplicating the onboarding wiring.
- From V3-P3: the new keybindings surface introduced user-facing strings that should land in the centralized strings module — Settings → Shortcuts row labels and help text ("Push to talk · friends", "Talk to AI", "Reset to defaults", "Active when AI features are on.", "Opens the floating AI dialog over any app.", "Restores the original combos for both shortcuts."), KeybindCapture's button labels ("Rebind", "Press a key…") and helper line ("Press a combo, or Esc to cancel."), and the conflict copy in `describeConflict()` inside `src/lib/keybindings.ts` (the "reserved by the system", "already bound to …", "Add Ctrl, Cmd, or Alt …", "Press a key with the modifier …" lines). Keep `describeConflict`'s shape — interpolation of action name + accelerator glyph — when relocating.
- From V3-P4: route Settings → AI "Capture displays" strings into the centralized strings module — row label, "Primary only" / "All displays" option labels, and the help line "All displays sends every monitor to the local AI as one image. Peers never see your screen." While editing, sharpen two behaviors the V3-P4 help line elides: (a) "All displays" prompts the OS screen-share picker once per connected monitor at session start (e.g. two prompts on a dual-monitor host), and (b) switching primary→all mid-session does NOT add streams — it applies on the next AI session (the all→primary direction takes effect on the next sample tick because the loop just stops compositing the extras). The V2-P9 no-mid-session-prompt contract is load-bearing; copy must not promise otherwise.
- From V3-P5: the contrast script (`scripts/check-contrast.ts`) maintains a hand-enumerated `PAIRINGS` list — every fg/bg token combo the UI uses. As the cohesion pass introduces new combinations (a tinted chip with a previously-unused color, a new icon on a new surface, a status badge variant) add the distinct pairings or the AA gate stops being accurate. The script's `severity: 'info'` classification is reserved for WCAG 1.4.11 inactive-component exemptions (idle hairline borders identified by other means — label, caret, focus ring); don't relax `block` to `info` to make a text pairing pass. The `LEGACY_THEME_LOCALSTORAGE_KEY` constant in `src/stores/settingsStore.ts` now doubles as the boot cache for the inline pre-paint script in `index.html` / `ai-dialog.html`; the name kept its V1-P11 spelling, but the new alias `THEME_LOCALSTORAGE_KEY` is the right one for new code.
- From V3-P7: §6 promises five motion uses (dialog/sheet enter-leave, AI dialog appear, audit-log new-row fade, post-session score sweep), but only the score sweep is actually wired in the codebase. No `tailwindcss-animate` / `tw-animate-css` plugin is installed, so the shadcn `animate-in` / `fade-in-0` / `zoom-in-95` / `slide-in-from-*` classes resolve to no rule and dialogs/sheets/popovers/tooltips appear instantly. The V3-P7 kill switch already gates anything you wire up. V3-P8's motion audit must explicitly decide: install an animate plugin and realise the §6 promises (which are then automatically gated), or update §6 to reflect reality (instant enter/leave is fine if intentional). Pick one; don't leave the promise/reality drift.
- From V3-P7: the `<Loader2Icon className="animate-spin" />` at `src/features/ai/ModelPicker.tsx:315` violates §6 ("no spinning loaders — use Skeleton instead"). The kill switch freezes it on a single iteration under reduced motion, but under default motion it still spins. V3-P8's motion audit should replace it with a `<Skeleton>` row or drop the icon (the busy-state copy below already conveys progress). One-line change, no behavior impact.
- From V3-P7: the user-facing strings introduced or expanded in this phase need to land in the centralized strings module — the AuditLogPanel `aria-labelledby` "Session log" header, the sr-only h1s on Home ("StudyVis") and SessionView ("Studying with friends"), the AiCategory and ScreenCapturePermissionOverlay D5 paragraphs ("While the AI is sampling, your operating system's screen-recording indicator stays on for the whole session…" and "Heads-up: your operating system's screen-recording indicator stays on…"), and the new ScreenCapturePermissionOverlay step-1 sentence ("On macOS this is the only place screen-recording access is granted or revoked."). The wording is intentionally provisional — V3-P8's voice rubric finalises it. Keep the existing aria semantics (role, aria-live, aria-labelledby relationships) when relocating; the V3-P7 axe gate will catch regressions.
- From V3-P7: the boot-cache pattern is now used by three settings (`studyvis.theme`, `studyvis.windowStyle`, `studyvis.reduceMotion`), each with a near-identical inline pre-paint script duplicated across `index.html` and `ai-dialog.html`. Consider extracting the three scripts into one `/public/boot-paint.js` linked via `<script src>` for cohesion; the per-window logic is identical. Out of V3-P7 scope; V3-P8 may collapse if it's worth it.

---

YOUR TASK: V3-P8 — Design cohesion & copy pass. This is the heart of "make it feel like one person built it." The app is feature-complete and accessible; now make every screen read and sit like siblings, and make every word sound like a friend wrote it (DESIGN-SYSTEM §14). No new behavior — only coherence.

Orient widely (parallel Explore / general-purpose agents): (a) inventory EVERY user-facing string in the codebase — button labels, helper text, toasts, dialog titles/bodies, empty-state copy, error messages, aria-labels that are user-perceivable, onboarding, Settings helper lines, the post-session report, the AI dialog. (b) Inventory EVERY screen/route and, per screen, record: page padding, section gap, inline gap, content max-width, whether empty/loading/error all exist, and every motion use. Produce both inventories before editing; advisor-check the plan.

Then:

1. Centralize copy. Create one user-facing strings module (single locale — this is NOT i18n; it's a single source of truth for wording). Move every user-facing string into it with clear, grouped keys. Replace inline literals with references. Keep aria-labels semantically identical unless the wording genuinely improves while staying a correct label (don't break V3-P7). Add a lint/grep guard that fails if a new raw user-facing literal sneaks back into components (so cohesion doesn't rot).
2. Rewrite to the §14 voice. Every string must pass the §14 before/after table: short, direct, second person, no hype, no emoji-cheer, specific over generic ("Couldn't reach Alice. Try again?" not "Oops, something went wrong."), period on full sentences, none on labels/buttons. Where copy is currently fine, leave the words and just move them. Where it's robotic, hypey, or vague, rewrite it. The recent "human voice" commit set the direction — finish the job everywhere, consistently.
3. Reconcile layout. Every screen obeys §12: page padding space.5, section gap space.6, inline gap space.3, one content-max-width source. Kill off-grid one-offs (arbitrary margins, bespoke widths). Structure should be predictable across Settings categories, onboarding steps, session view, report, stats — same rhythm, same alignment, same heading scale (§2 type scale).
4. Complete the state triads. Every async/stateful surface has empty + loading (Skeleton) + error (calm inline) per §10. Add whichever are missing. No spinners, no modal-of-doom, no "loading…" text.
5. Motion audit. Exactly §6's five uses + the allowed discrete state-change transitions. Remove anything decorative/repeating/scale-on-hover/bouncy that slipped in across phases. (Reduced-motion gating already exists from V3-P7 — don't duplicate it; just ensure no un-gated motion was reintroduced.)
6. Resolve D5 (copy) and triage D6 as specified.
7. The deliverable artifact: a screen-by-screen checklist (every screen × {copy in voice, on grid, all three states, motion compliant}) included in the PR body, every cell marked, exceptions justified. /style walked in both themes as the final cohesion mirror.

Verification: tsc -b && vite build, storybook build, token check, lint (incl. the new raw-literal guard), existing tests — all green. No behavior test should change; if one does, you changed behavior — stop and surface it.

Acceptance criteria:
- All user-facing copy in one module, every string passing the §14 rubric, with a guard preventing regressions.
- Every screen on the §12 grid with consistent structure and the §2 type scale.
- Empty/loading/error present everywhere they apply; motion is exactly §6.
- The screen-by-screen cohesion checklist is in the PR, fully marked; zero behavior changes.
````

## V3-P9: Release readiness & the 1.0 gate

**Phase**: V3 (terminal — this is the last prompt; after it, the product is done).
**Depends on**: V3-P2…P8 all merged.
**Reads**: PLAN §5 (V1 + V2 success criteria — the bar this gate enforces), ARCHITECTURE §11 (README is owed, "generated last"), §15 (versioning), `ISSUES.md`, the **V3 debt ledger** above (D6–D10), `project_release_process` memory (version in 5 files; tag triggers release.yml).
**Outputs**: `README.md`, `CHANGELOG.md`, a final debt-ledger triage (each item: done | deliberately deferred + reason), a version bump to 1.0.0-final-class (you decide the exact number; justify), a "What's intentionally not in 1.0" section, a green release-readiness report. Ends the document.
**Acceptance criteria**:
- Every PLAN §5 V1 and V2 success criterion is explicitly checked: met (with evidence) or consciously deferred (with reason). None silently skipped.
- `README.md` (overview + install for unsigned macOS/Windows + first-run + the friends-only trust note) and `CHANGELOG.md` exist and are honest.
- Every V3-ledger item D6–D10 is resolved or recorded as a deliberate, reasoned deferral; ISSUES.md I9/I18 recorded as accepted (not reopened); the "intentionally not in 1.0" list names Linux, sepia/high-contrast, signing/notarization/updater, AI-weighted focused-minutes.
- Version is bumped consistently across all the files the release process tracks; the install/first-run/uninstall walkthrough is documented and user-verifiable.
**Out of scope**: implementing deferred items (D8/D9/D10 are record-only); signing/notarization (no creds — out of 1.0); reopening I9/I18; shipping the release tag (the user pushes the tag).

**Prompt to paste**:

````
You are working on StudyVis, a peer-to-peer desktop study app for close friends. Read these in full before making decisions:
- /Users/scott/PycharmProjects/studyvis/PLAN.md
- /Users/scott/PycharmProjects/studyvis/ARCHITECTURE.md
- /Users/scott/PycharmProjects/studyvis/DESIGN-SYSTEM.md
- /Users/scott/PycharmProjects/studyvis/CLAUDE.md
- ~/.claude/projects/-Users-scott-PycharmProjects-studyvis/memory/MEMORY.md (carryovers from prior phases — especially the release process and audit ledger)

These are the source of truth. If anything conflicts with this prompt, surface it — don't silently deviate.

Reasoning budget is unlimited. Use subagents freely. Call the advisor before committing to the version number + deferral set and once before declaring the task — and the product — done. Use Context7 only if a doc/tooling fact needs verifying.

Version policy: this prompt sets the release version; pick it deliberately (the tree is at 1.0.3; this is the polished 1.0 the whole plan was building toward — justify the exact number via advisor). File-shape policy: prefer current idiom. Package-manager: repo lockfile (npm); don't switch.

Verification policy: headless commands are agent-verifiable (tsc -b, vite build, storybook build, cargo check/test, token check, lint, the a11y check). Install/first-run/uninstall on real OSes is user-verifiable — deliver a precise walkthrough. NO RTL/jsdom harness; do not add one.

Phase invariant (V3): everything is shipped/landed. This prompt implements NO new feature behavior. It writes docs, triages debt, bumps the version, and gates. D8/D9/D10 are record-only. Do NOT reopen ISSUES.md I9 or I18 — record them as accepted. Don't sign/notarize (no creds; out of 1.0).

Polish bar (V3): the gate is the final guarantor. The product must read as finished: DESIGN-SYSTEM §14 voice applies to README/CHANGELOG too (a friend wrote it). /style must be clean. Tokens-only invariant must still hold (run the check).

Scope discipline: docs + triage + version + gate only. No features, no deferred-item implementation, no signing. README.md and CHANGELOG.md are the two new docs this prompt is explicitly authorized to create — no other new docs.

End-of-task exit sequence (mandatory):
1. This is the terminal prompt — there is no later phase to carry debts to. Instead, every still-open debt (V3 ledger D6–D10, any ISSUES.md residue, anything surfaced) must be recorded in the "What's intentionally not in 1.0" section of README.md (or CHANGELOG.md) with a one-line reason. Nothing is silently dropped; the destination is the shipped docs, not a future prompt.
2. Single commit, only this task's files (README.md, CHANGELOG.md, version files, any doc syncs). Message: "V3-P9: release readiness (1.0)".
3. Branch v3/p9-release off main; no direct push to main.
4. Email-privacy rejection → git -c user.email='134114466+scotej@users.noreply.github.com' commit --amend --no-edit --reset-author
5. gh pr create --base main --head v3/p9-release --title "V3-P9: release readiness (1.0)". Body = the full release-readiness report (every PLAN §5 criterion checked, the debt triage table, the install walkthrough). Copilot auto-reviews.
6. Poll Copilot review (~30s, ≤10 min). Declined-files = clean pass (this PR is largely docs/config — expected). Nothing in window → PR comment, step 9.
7. Fix actionable findings; re-run verification; skip nits with reasons in the follow-up message.
8. Follow-up commit "V3-P9: address Copilot review" (or no-review variant); skip if nothing actionable.
9. gh pr merge <num> --squash --delete-branch; wait out checks/retry once; rebase if stale; never --admin / force-push main. Do NOT create or push a release tag — the user pushes the tag (the release.yml trigger) after reviewing merged main.
10. Chat summary: the release-readiness verdict (ship / not yet, with the criterion-by-criterion table), version chosen + why, the full deferral list with reasons, the user-verifiable install/first-run/uninstall walkthrough, and an explicit statement of what the user still owns (push the tag; signing if creds ever appear).

---

CARRY-FORWARD DEBTS (from the V3 debt ledger — resolve or record; this is the last stop):
- D6 — Whatever V3-P8 did not implement of the three UX tunables (tile-alert-duration control, rolling 2-hour break window, sessions.breaks_taken) is recorded here as deliberately deferred with a one-line reason each.
- D7 — The unread 002_v2.sql `models` table and the unrotated llama-server.log: either resolve trivially (drop the dead table via a forward-only migration if safe, or add simple size/daily log rotation in sidecar.rs::ensure_log_path) OR record both as deliberate post-1.0 with reasons. Migrations are forward-only and must not break the V1→V2 upgrade test — if in doubt, defer and record, don't risk data loss at the gate.
- D8 — "Focused minutes = session.total_minutes" (not AI-weighted), isolated in focusedMinutesForSession(): RECORD ONLY as an intentional 1.0 design decision in "What's intentionally not in 1.0." Do not change it.
- D9 — macOS notarization, Windows code-signing, tauri-plugin-updater re-enable: out of 1.0 (no signing credentials — PLAN §5). ISSUES.md I9 (pomodoro broadcaster takeover) and I18 (sidecar model-path sandbox): accepted deviations per the friends-only threat model / "any local GGUF" promise. Linux first-class and sepia/high-contrast theme variants: explicitly post-1.0. RECORD ALL in "What's intentionally not in 1.0"; reopen none.
- D10 — Linux keyring `sync-secret-service` prerequisite + optional identity_box_decrypt hygiene: RECORD as post-1.0 Linux prerequisites. Not 1.0 work.

---

YOUR TASK: V3-P9 — Release readiness & the 1.0 gate. This is the last prompt. When it merges, StudyVis is the complete, polished product PLAN.md set out to build — or this gate says, precisely, why not yet. Be the adult in the room: verify, don't assume; record every compromise honestly.

Orient (Explore + advisor): the release process (version lives in 5 files per the release_process memory; a v*.*.* tag triggers release.yml's draft build — confirm the exact file set in the repo, don't trust memory alone), ISSUES.md current state, the V3 ledger above, and PLAN §5's V1 + V2 success-criteria lists verbatim.

Then:

1. Success-criteria gate. Walk every PLAN §5 V1 success criterion AND every V2 success criterion, one by one. For each: state met (with concrete evidence — a test, a code path, a doc) or deferred (with an honest reason). The ones that are inherently cross-machine (e.g. "two friends on different OSes complete a 25-min session", "crash-free across 50 hours") are user-verifiable — say so and give the user the exact protocol to confirm them; do not claim them met from code alone.
2. Write README.md (ARCHITECTURE §11 says it is generated last: overview, what running StudyVis means per PLAN §3, install for UNSIGNED macOS .dmg (right-click → Open) and Windows .msi (SmartScreen → Run anyway), first-run/onboarding incl. identity backup + the new recovery path, the friends-only trust + no-telemetry note, where local data lives, how to file a problem (local log + manual share — no telemetry). Voice per §14. Honest about limitations (PLAN §7).
3. Write CHANGELOG.md: a clean, human history culminating in this release. Group by V1 / V2 / V3. Don't invent; derive from git history + the canonical docs. §14 voice.
4. Triage the full debt set: D6–D10 + any ISSUES.md residue + anything you surface. Produce a table (item → resolved here | deferred + reason → destination). Resolve only what's trivially safe (D7's options); everything else is recorded, not implemented. Build the "What's intentionally not in 1.0" section from this — it must name at minimum: Linux, sepia/high-contrast, signing/notarization/in-app updater, AI-weighted focused-minutes, plus the I9/I18 accepted deviations.
5. Version bump: choose the release version deliberately (the tree is 1.0.3; this is the polished 1.0 milestone — decide and justify via advisor whether that's 1.1.0, 1.0.4, or a symbolic number, given the release_process semantics and that prior 1.0.x were pre-polish). Bump it consistently in every file the release process tracks (verify the set against the repo, not just memory). Do NOT tag.
6. Final smoke: tsc -b && vite build, storybook build, cargo check && cargo test, the token check, lint, the V3-P7 a11y check — all green, captured in the report. Walk /style in dark + light. Confirm the tokens-only and component-layering invariants still hold.

Verification artifact: the PR body IS the release-readiness report — the criterion-by-criterion table, the debt triage table, the green command outputs, and the user-verifiable install/first-run/uninstall/cross-machine protocol.

Acceptance criteria:
- Every PLAN §5 V1 + V2 criterion explicitly met-with-evidence or deferred-with-reason; none skipped.
- README.md + CHANGELOG.md exist, honest, in voice.
- D6–D10 + I9/I18 all resolved or recorded; "What's intentionally not in 1.0" is complete and reasoned.
- Version bumped consistently; smoke commands green; /style clean; no tag pushed (user owns that).
- The chat summary states plainly: is StudyVis a complete, polished 1.0 — yes, or precisely what blocks it.
````

---

## Patterns common to all prompts

By design, every V3 prompt above:

- **Re-reads the canonical docs + this V3 debt ledger first.** Fresh context each session; no reliance on training memory or prior-session state.
- **Carries the rich header** (Phase / Depends on / Reads / Outputs / Acceptance criteria / Out of scope / Prompt to paste). The fenced block is the only thing you paste; it is self-contained.
- **Embeds the preamble verbatim**, including the V3 phase invariant ("don't regress shipped V1/V2/V3-P1") and the **polish bar** (DESIGN-SYSTEM §6/§10/§12/§14 + §7 rule 5) — that clause is how the "polished, human, consistent" intent reaches every prompt without restating it per task.
- **States explicit out-of-scope and a clean stopping point**, so the next session starts clean.
- **Names its debt-ledger items** in a CARRY-FORWARD DEBTS block inside the fence, and routes anything newly surfaced into a later prompt (or, for V3-P9, into the shipped docs — the terminal prompt has nowhere later to push, so open debts land in "What's intentionally not in 1.0").
- **Respects the test reality**: node-env Vitest + Storybook + user-verifiable visuals. No RTL/jsdom harness is added.
- **Single commit per prompt**, optional one follow-up titled `V3-PN: address Copilot review`, Copilot-reviewed, squash-merged with branch delete. CI must be green; branch protection is never bypassed. The user remains the post-hoc reviewer of merged `main` and owns the release tag.
