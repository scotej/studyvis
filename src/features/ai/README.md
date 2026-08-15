# `src/features/ai/` — internal capture pipeline notes

This file documents decisions that aren't obvious from the code itself.
Canonical product/architecture docs are still `PLAN.md`, `ARCHITECTURE.md`,
and `DESIGN-SYSTEM.md` at the repo root — read those first.

## Live capture pipeline (current V3 path)

The AI sample loop has two local still-image inputs:

- `captureFace(track)` snapshots the existing local camera track (the same
  `MediaStreamTrack` published over WebRTC), crops it to 384×384, encodes a
  quality-0.8 JPEG, and returns base64.
- `sampleLoop.ts` acquires screen media once when the loop boots, keeps the
  selected stream or streams alive, and snapshots them on each inference tick.
  A single display is downscaled to at most 1024 px wide; multiple displays are
  composited into one horizontal image at most 2048 px wide. Screen tracks used
  by the AI loop are never published to peers.

`captureScreen()` is still exported as a one-shot utility: it acquires one
`getDisplayMedia({ video: true })` stream, snapshots and encodes one frame, and
always stops the stream. It is covered by capture unit tests, but it is **not**
the live sample-loop implementation. `requestScreenCapturePermission()` uses
the same acquire-and-release shape only to seed/check an OS permission grant.

### Long-lived streams and user gestures

Calling `getDisplayMedia` repeatedly can show an OS picker repeatedly, and the
desktop webviews require acquisition to begin from a user gesture. UI entry
points therefore call `preacquireScreenStream()` synchronously from the click;
`sampleLoop.ts` consumes that pending promise at boot and keeps the resulting
stream alive until the loop stops. The screen-recording indicator consequently
stays visible for the session rather than going dark between samples.

The primary acquire is required. Denial latches capture as unavailable and
surfaces the permission recovery UI. An ended track is dropped; losing the last
track stops capture. Teardown stops every retained stream and clears listeners.

### Multi-monitor capture

When `captureDisplays === 'primary'`, the loop acquires one stream. For
`'all'`, it reads Tauri's `availableMonitors()` count and asks for one stream per
reported display at boot. The operating-system picker remains authoritative:
StudyVis cannot silently select or retain portal authority. The user chooses a
surface for each acquire. Cancelling an additional picker is a soft fallback to
the streams already granted, and each tick composites the surviving tracks.

Changing from all displays to primary during a session immediately releases
the extra streams. Changing from primary to all waits for the next loop boot,
because adding streams mid-session would require another picker outside the
original user gesture.

### macOS: the webview has to be taught to ask (I79)

Before the OS grant matters at all, WebKit has to be willing to route the
request. Since macOS 13 it resolves `getDisplayMedia()` either by its own
default action — taken only when the app implements **no** capture delegate —
or by the private
`_webView:requestDisplayCapturePermissionForOrigin:initiatedByFrame:withSystemAudio:decisionHandler:`
delegate, and it denies the call outright when an app implements the public
camera/mic delegate without that private one. wry is exactly that app, so
`src-tauri/src/macos_display_capture.rs` adds the missing method to wry's
delegate class at startup; without that patch every acquire rejects with
`NotAllowedError` no matter what the user has granted. The workaround was
tracked in tauri-apps/wry#1195/#1196; re-evaluate it when upgrading wry.

### macOS Sequoia permission flow

With the delegate in place, Screen Recording is a per-app grant in System
Settings → Privacy & Security → Screen Recording. Until the user toggles
StudyVis on there, `getDisplayMedia` rejects with `NotAllowedError`.
`captureScreen` maps that to `CaptureError.code === 'screen_capture_denied'`,
which V2-P9's "Enable AI features" flow catches and shows the
`<ScreenCapturePermissionOverlay />` (`src/components/`). The overlay
includes a button that calls `system_open_screen_capture_settings` to jump
the user to the right settings pane.

On Windows the prompt is the per-call screen-share picker and there is no
analogous OS-level grant; denial means the user dismissed the picker.

### Linux / KDE Wayland

The Linux release candidate uses WebKitGTK. On the reference CachyOS KDE
Wayland desktop, `getDisplayMedia` crosses `xdg-desktop-portal-kde` and PipeWire,
so a working portal/PipeWire session and the user's picker approval are runtime
prerequisites. The code path and AppImage packaging exist, but a headless Xvfb
startup test does not validate the real portal: PLAN §8 requires physical KDE
Wayland capture with the exact release artifact before publication.

### Privacy invariant

Neither snapshot is written to disk; it exists as a transient JPEG buffer sent
only to `127.0.0.1:<sidecar-port>`. No telemetry and no remote upload. The Tauri
CSP is explicit, and its `connect-src` directive deliberately includes
`http://127.0.0.1:*` for the randomly bound local llama-server port.

## Files

- `captureFace.ts` — camera crop/encode.
- `captureScreen.ts` — one-shot capture, permission seeding, user-gesture
  pre-acquire handoff, and display-media error classification.
- `captureShared.ts` / `composite.ts` — frame extraction, JPEG encoding, and
  multi-display layout/compositing.
- `sampleLoop.ts` — long-lived screen streams, cadence, capture, inference, and
  focus-store application.
- `focusRequest.ts` / `systemPrompt.ts` / `parseJudgment.ts` — model request and
  response contract.
- `models.ts` / `modelStore.ts` / `download.ts` / `benchmark.ts` — model
  catalogue, persistence, download, and device benchmark.
- `sidecar.ts` / `engine.ts` — packaged llama-server lifecycle and health.
