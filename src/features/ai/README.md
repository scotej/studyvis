# `src/features/ai/` — internal capture pipeline notes

This file documents decisions that aren't obvious from the code itself.
Canonical product/architecture docs are still `PLAN.md`, `ARCHITECTURE.md`,
and `DESIGN-SYSTEM.md` at the repo root — read those first.

## Capture pipeline (V2-P3)

Two snapshot functions feed the AI sample loop (wired in V2-P5):

- `captureFace(track)` pulls a frame off the existing local camera track
  (the same `MediaStreamTrack` already published over WebRTC), encodes it as a
  384×384 JPEG at quality 0.8, and returns base64.
- `captureScreen()` acquires a fresh `getDisplayMedia({ video: true })`
  stream, snapshots a single frame, downscales to 1024 px wide preserving
  aspect, encodes JPEG at quality 0.7, and stops the stream before
  returning.

Both functions are local-only. The face track is shared with peers via
WebRTC, but the AI's still-frame snapshot is a separate side path. The
screen track is never published — it exists only for the AI loop and is
released between ticks.

### Multi-monitor in V2 = no programmatic selection

`getDisplayMedia` in both WKWebView (macOS) and WebView2 (Windows) always
surfaces an OS picker on each acquire. The user — not the app — chooses
which display, window, or app surface to share. V2 makes **no programmatic
display selection**: we don't enumerate displays, and we don't pre-select
the primary monitor. If the user wants the primary display, they pick it in
the OS picker once and the same surface is reused on subsequent acquires
within the same grant.

V3's "multi-monitor toggle" therefore means one of:

- enumerate displays Tauri-side (Rust) and present an in-app picker,
- or stitch frames from multiple `getDisplayMedia` streams.

Both require new Tauri commands and a UI affordance. Out of V2 scope.

### Acquire strategy: per-tick vs long-lived

The V2-P3 prompt asks the function to acquire a fresh `getDisplayMedia`,
snapshot, and immediately release on every tick (so the OS screen-recording
indicator goes dark between samples and battery drain is minimised). That's
what `captureScreen()` does.

The trade-off the prompt anticipates: if the OS picker fires on **every**
acquire — which is the documented behaviour of both WKWebView and WebView2
— a once-every-5–30-seconds tick interrupts the user constantly. Empirical
verification belongs to V2-P5 (the sample-loop owner). If the per-tick
acquire turns out to prompt every tick:

1. V2-P5 switches to a long-lived `MediaStream` that's acquired once when
   the session starts (or when AI is enabled), kept alive for the
   session, and snapshotted via the same `CaptureRuntime.extractFrame`
   pipeline `captureScreen` already uses.
2. The OS screen-recording indicator stays on for the whole session — same
   visibility as the camera tile. Documented in onboarding when V2-P5
   lands.
3. The long-lived path is intentionally not exported from this directory in
   V2-P3 to keep the API surface small (one prompt, one function); V2-P5
   adds the helpers when it has measurements to justify the second mode.

### macOS Sequoia permission flow

On macOS Sequoia (15.x), Screen Recording is a per-app grant in System
Settings → Privacy & Security → Screen Recording. Until the user toggles
StudyVis on there, `getDisplayMedia` rejects with `NotAllowedError`.
`captureScreen` maps that to `CaptureError.code === 'screen_capture_denied'`,
which V2-P9's "Enable AI features" flow catches and shows the
`<ScreenCapturePermissionOverlay />` (`src/components/`). The overlay
includes a button that calls `system_open_screen_capture_settings` to jump
the user to the right settings pane.

On Windows the prompt is the per-call screen-share picker and there is no
analogous OS-level grant; denial means the user dismissed the picker.

### Privacy invariant

Neither snapshot is written to disk except as a transient JPEG buffer
inside the closure that's about to POST it to `127.0.0.1:<sidecar-port>`.
No telemetry. No remote upload. The Tauri build has `connect-src` open via
`security.csp: null`; if a later phase tightens CSP, the sample loop must
keep `http://127.0.0.1:*` allowed.

## Files

```
src/features/ai/
├─ captureFace.ts        ← face frame: 384×384, JPEG q=0.8
├─ captureScreen.ts      ← screen frame: 1024w, JPEG q=0.7, acquire+release
├─ captureShared.ts      ← CaptureRuntime + DOM defaults (OffscreenCanvas)
├─ benchmark.ts          ← V2-P2: model picker benchmark
├─ models.ts             ← V2-P2: registry of supported vision models
├─ modelStore.ts         ← V2-P2: persisted per-model records
├─ sidecar.ts            ← V2-P1: llama-server JS bridge
├─ download.ts           ← V2-P2: GGUF download orchestration
├─ hfToken.ts            ← V2-P2: HF access token (keyring)
├─ ModelPicker.tsx       ← V2-P2: picker UI
├─ ModelPickerContainer.tsx
└─ ModelGuide.tsx
```
