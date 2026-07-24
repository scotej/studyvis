// X6 — auto-update state machine.
//
// The shape of the flow, and why:
//   idle → checking → (up-to-date | available) → downloading → ready → …
//
// The download runs unattended the moment a release is found; only the
// install waits for a person. That split is deliberate — restarting is the
// only part with a cost (you lose your place), and by the time the banner
// appears the bytes are already on disk and signature-verified, so "Restart
// now" is a couple of seconds rather than a download you have to sit through.
//
// Integrity: tauri-plugin-updater verifies the artifact's minisign signature
// against the pubkey baked into tauri.conf.json BEFORE unpacking. That check
// is independent of Apple/Windows code signing, which is why this ships on
// ad-hoc-signed builds — an attacker who controls the release page still
// can't hand this app a payload it will install.
//
// Session safety is split. `UpdaterBoot` owns *scheduling* — it doesn't
// start a check while a session is active. But a check is network-bound, so a
// session can begin between UpdaterBoot's decision to check and the download
// actually starting; the timer teardown can't reach into an already-running
// `checkNow`. So the check→download boundary re-reads session state here (via
// the `isSessionActive` dep) and defers the download if a session slipped in.
// The one residual gap the plugin makes unfixable: a download already in
// flight when a session starts cannot be aborted — this plugin version's
// `download()` takes no AbortSignal. That window is narrow (only on a launch
// where a release is newly found, mid-download) and self-limiting.

import { invoke } from '@tauri-apps/api/core'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { create } from 'zustand'

import { useSessionStore } from '@/stores/sessionStore'

export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready'
  | 'upToDate'
  | 'error'

export type UpdaterDeps = {
  check: () => Promise<Update | null>
  // Split out so tests can drive the flow without a Tauri host. All three are
  // thin passthroughs in production.
  stopSidecar: () => Promise<void>
  relaunch: () => Promise<void>
  // Read at the check→download boundary so a session that started *during*
  // the (network-bound) check aborts before any installer bytes move. See
  // the note in checkNow.
  isSessionActive: () => boolean
}

export const defaultUpdaterDeps: UpdaterDeps = {
  check: () => check(),
  stopSidecar: () => invoke('sidecar_stop'),
  relaunch: () => invoke('system_relaunch_app'),
  isSessionActive: () => useSessionStore.getState().status === 'active',
}

let deps: UpdaterDeps = defaultUpdaterDeps

export function setUpdaterDeps(next: Partial<UpdaterDeps>) {
  deps = { ...deps, ...next }
}

export function resetUpdaterDeps() {
  deps = defaultUpdaterDeps
}

type UpdaterState = {
  status: UpdaterStatus
  // Version of the pending update; null whenever there isn't one.
  version: string | null
  // Release notes as GitHub rendered them into latest.json. May be empty.
  notes: string | null
  // 0..100, meaningful only while `status === 'downloading'`. Stays at 100
  // when the server sends no Content-Length (progress is indeterminate).
  percent: number
  // Which step failed, for picking copy. Set only by user-initiated actions
  // (and by install, which is always user-initiated); background failures
  // leave it null so a flaky network never produces UI.
  errorKind: 'check' | 'download' | 'install' | null
  // Banner suppression for the rest of this process. The update stays staged
  // and Settings → About still offers it.
  dismissed: boolean
  installing: boolean
  // Held between download and install: the Update handle owns the staged
  // bytes on the Rust side, so dropping it would strand them.
  pending: Update | null

  checkNow: (opts?: { userInitiated?: boolean }) => Promise<void>
  // Resolves `false` when the install failed and the app is still running.
  // A successful install never resolves on Windows (the installer takes the
  // process over) and relaunches on macOS, so `true` is mostly theoretical.
  installAndRestart: () => Promise<boolean>
  dismiss: () => void
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  status: 'idle',
  version: null,
  notes: null,
  percent: 0,
  errorKind: null,
  dismissed: false,
  installing: false,
  pending: null,

  checkNow: async ({ userInitiated = false } = {}) => {
    const { status } = get()
    // A check already in flight, or an update already staged, wins — a second
    // pass would re-download bytes we have.
    if (status === 'checking' || status === 'downloading' || status === 'ready')
      return

    set({ status: 'checking', errorKind: null })
    let update: Update | null
    try {
      update = await deps.check()
    } catch (err) {
      // Silent in the background path: no network is the common case on a
      // laptop that just woke up, and it isn't the user's problem.
      console.error('[updater] check failed:', err)
      set({ status: 'error', errorKind: userInitiated ? 'check' : null })
      return
    }

    if (!update) {
      set({ status: 'upToDate', version: null, notes: null })
      return
    }

    // A session may have started during the check above. Don't pull an
    // installer onto a live WebRTC mesh — reset to idle (nothing staged) and
    // let UpdaterBoot's post-session check re-find and download it. This holds
    // user-initiated too: Settings → About is reachable mid-session (#47 B2),
    // and installer bytes over a live call are the exact bandwidth cost this
    // guard exists to avoid, whoever pressed the button.
    if (deps.isSessionActive()) {
      set({ status: 'idle' })
      return
    }

    set({
      status: 'downloading',
      version: update.version,
      notes: update.body ?? null,
      percent: 0,
      // A fresh version supersedes an earlier dismissal — the user dismissed
      // the old one, not this one.
      dismissed: false,
    })

    try {
      let total = 0
      let received = 0
      await update.download((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? 0
            break
          case 'Progress':
            received += event.data.chunkLength
            set({
              percent:
                total > 0 ? Math.min(100, (received / total) * 100) : 100,
            })
            break
          case 'Finished':
            set({ percent: 100 })
            break
        }
      })
    } catch (err) {
      // Leave nothing staged: the next check re-downloads from scratch rather
      // than trying to resume a half-written artifact.
      console.error('[updater] download failed:', err)
      set({
        status: 'error',
        pending: null,
        version: null,
        errorKind: userInitiated ? 'download' : null,
      })
      return
    }

    set({ status: 'ready', percent: 100, pending: update })
  },

  installAndRestart: async () => {
    const { pending, installing } = get()
    if (!pending || installing) return false
    // Defense-in-depth behind the disabled button: restarting mid-session is an
    // unconfirmed quit that bypasses leaveBeforeQuit (quitLeave.ts) and the
    // lib.rs CloseRequested confirm, so the session's audit flush / sessions
    // upsert / markStudied never run and the session is lost.
    if (deps.isSessionActive()) return false
    set({ installing: true, errorKind: null })

    // The sidecar has to die before the bundle is swapped. On Windows the
    // NSIS installer cannot overwrite a running llama-server.exe; on macOS an
    // orphan would survive the relaunch holding its port and model file.
    // `sidecar_stop` is idempotent, so a never-started sidecar is a no-op.
    try {
      await deps.stopSidecar()
    } catch {
      // Best-effort. A sidecar we failed to stop is a worse install, not a
      // reason to refuse the update.
    }

    try {
      await pending.install()
    } catch (err) {
      // Most often macOS refusing to overwrite a bundle the user doesn't own
      // (a root-installed /Applications, or still running from the .dmg).
      console.error('[updater] install failed:', err)
      set({ installing: false, errorKind: 'install' })
      return false
    }

    // Windows: the NSIS installer has already taken over and will restart the
    // app, so this line is usually never reached. macOS: the bundle has been
    // swapped in place and we relaunch ourselves.
    try {
      await deps.relaunch()
    } catch (err) {
      console.error('[updater] relaunch failed:', err)
      set({ installing: false, errorKind: 'install' })
      return false
    }
    return true
  },

  dismiss: () => set({ dismissed: true }),
}))
