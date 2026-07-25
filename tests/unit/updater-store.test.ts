// X6 — updaterStore: the check → download → install state machine.
//
// The behaviors worth pinning are the ones that are quiet in production and
// therefore easy to regress: background failures must not produce UI, a
// re-entrant check must not re-download staged bytes, and the sidecar must be
// stopped before the bundle is swapped.

import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  resetUpdaterDeps,
  setUpdaterDeps,
  useUpdaterStore,
} from '@/features/updater'

type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }

// Minimal stand-in for the plugin's Update handle. Only the two methods the
// store calls are modelled.
function fakeUpdate(
  overrides: {
    version?: string
    body?: string
    onDownload?: (emit: (e: DownloadEvent) => void) => Promise<void>
    install?: () => Promise<void>
  } = {}
) {
  return {
    version: overrides.version ?? '2.0.0',
    body: overrides.body,
    download: vi.fn(async (onEvent: (e: DownloadEvent) => void) => {
      if (overrides.onDownload) return overrides.onDownload(onEvent)
      onEvent({ event: 'Started', data: { contentLength: 100 } })
      onEvent({ event: 'Progress', data: { chunkLength: 100 } })
      onEvent({ event: 'Finished' })
    }),
    install: vi.fn(overrides.install ?? (async () => {})),
  }
}

function resetStore() {
  useUpdaterStore.setState({
    status: 'idle',
    version: null,
    notes: null,
    percent: 0,
    errorKind: null,
    dismissed: false,
    installing: false,
    pending: null,
  })
}

beforeEach(() => {
  resetStore()
  resetUpdaterDeps()
})

describe('checkNow', () => {
  test('no update available settles on upToDate', async () => {
    setUpdaterDeps({ check: async () => null })
    await useUpdaterStore.getState().checkNow()
    expect(useUpdaterStore.getState().status).toBe('upToDate')
    expect(useUpdaterStore.getState().version).toBeNull()
  })

  test('an available update downloads immediately and stages itself', async () => {
    const update = fakeUpdate({ version: '2.1.0', body: 'notes here' })
    setUpdaterDeps({ check: async () => update as never })

    await useUpdaterStore.getState().checkNow()

    const s = useUpdaterStore.getState()
    expect(update.download).toHaveBeenCalledOnce()
    expect(s.status).toBe('ready')
    expect(s.version).toBe('2.1.0')
    expect(s.notes).toBe('notes here')
    expect(s.percent).toBe(100)
    expect(s.pending).toBe(update)
  })

  test('download progress is reported as a percentage of content length', async () => {
    const seen: number[] = []
    const unsubscribe = useUpdaterStore.subscribe((s) => {
      if (s.status === 'downloading') seen.push(s.percent)
    })
    const update = fakeUpdate({
      onDownload: async (emit) => {
        emit({ event: 'Started', data: { contentLength: 200 } })
        emit({ event: 'Progress', data: { chunkLength: 50 } })
        emit({ event: 'Progress', data: { chunkLength: 150 } })
      },
    })
    setUpdaterDeps({ check: async () => update as never })

    await useUpdaterStore.getState().checkNow()
    unsubscribe()

    expect(seen).toContain(25)
    expect(seen).toContain(100)
  })

  test('a missing content length leaves progress indeterminate rather than dividing by zero', async () => {
    const update = fakeUpdate({
      onDownload: async (emit) => {
        emit({ event: 'Started', data: {} })
        emit({ event: 'Progress', data: { chunkLength: 10 } })
      },
    })
    setUpdaterDeps({ check: async () => update as never })

    await useUpdaterStore.getState().checkNow()

    expect(useUpdaterStore.getState().percent).toBe(100)
    expect(useUpdaterStore.getState().status).toBe('ready')
  })

  test('a background check failure stays silent — no errorKind for the UI to render', async () => {
    setUpdaterDeps({
      check: async () => {
        throw new Error('offline')
      },
    })

    await useUpdaterStore.getState().checkNow()

    expect(useUpdaterStore.getState().status).toBe('error')
    expect(useUpdaterStore.getState().errorKind).toBeNull()
  })

  test('a user-initiated check failure is attributed so the UI can explain it', async () => {
    setUpdaterDeps({
      check: async () => {
        throw new Error('offline')
      },
    })

    await useUpdaterStore.getState().checkNow({ userInitiated: true })

    expect(useUpdaterStore.getState().errorKind).toBe('check')
  })

  test('a failed download stages nothing, so the next check starts clean', async () => {
    const update = fakeUpdate({
      onDownload: async () => {
        throw new Error('connection reset')
      },
    })
    setUpdaterDeps({ check: async () => update as never })

    await useUpdaterStore.getState().checkNow({ userInitiated: true })

    const s = useUpdaterStore.getState()
    expect(s.status).toBe('error')
    expect(s.errorKind).toBe('download')
    expect(s.pending).toBeNull()
    expect(s.version).toBeNull()
  })

  test('a check while an update is already staged is a no-op — staged bytes are not re-fetched', async () => {
    const first = fakeUpdate({ version: '2.0.0' })
    setUpdaterDeps({ check: async () => first as never })
    await useUpdaterStore.getState().checkNow()
    expect(useUpdaterStore.getState().status).toBe('ready')

    const check = vi.fn(async () => fakeUpdate({ version: '3.0.0' }) as never)
    setUpdaterDeps({ check })
    await useUpdaterStore.getState().checkNow()

    expect(check).not.toHaveBeenCalled()
    expect(useUpdaterStore.getState().version).toBe('2.0.0')
  })

  test('a newly found version clears a prior dismissal', async () => {
    useUpdaterStore.setState({ dismissed: true })
    setUpdaterDeps({ check: async () => fakeUpdate() as never })

    await useUpdaterStore.getState().checkNow()

    expect(useUpdaterStore.getState().dismissed).toBe(false)
  })

  test('a session that started during the check defers the download', async () => {
    const update = fakeUpdate({ version: '2.2.0' })
    setUpdaterDeps({
      check: async () => update as never,
      // Models a session that began while check() was in flight.
      isSessionActive: () => true,
    })

    await useUpdaterStore.getState().checkNow()

    // No bytes moved, nothing staged — back to idle for the next post-session
    // check to re-find and download.
    expect(update.download).not.toHaveBeenCalled()
    expect(useUpdaterStore.getState().status).toBe('idle')
    expect(useUpdaterStore.getState().pending).toBeNull()
  })

  test('a user-initiated check also defers during a session — no installer bytes over a live mesh', async () => {
    // Settings → About is reachable mid-session (#47 B2), so the old
    // userInitiated exemption pulled a download onto the call. It now defers
    // like the background path: nothing moves, back to idle.
    const update = fakeUpdate({ version: '2.3.0' })
    setUpdaterDeps({
      check: async () => update as never,
      isSessionActive: () => true,
    })

    await useUpdaterStore.getState().checkNow({ userInitiated: true })

    expect(update.download).not.toHaveBeenCalled()
    expect(useUpdaterStore.getState().status).toBe('idle')
    expect(useUpdaterStore.getState().pending).toBeNull()
  })
})

describe('installAndRestart', () => {
  test('stops the sidecar before swapping the bundle', async () => {
    const order: string[] = []
    const update = fakeUpdate({
      install: async () => {
        order.push('install')
      },
    })
    setUpdaterDeps({
      check: async () => update as never,
      stopSidecar: async () => {
        order.push('stopSidecar')
      },
      relaunch: async () => {
        order.push('relaunch')
      },
    })

    await useUpdaterStore.getState().checkNow()
    await useUpdaterStore.getState().installAndRestart()

    expect(order).toEqual(['stopSidecar', 'install', 'relaunch'])
  })

  test('a sidecar that refuses to stop does not block the update', async () => {
    const update = fakeUpdate()
    setUpdaterDeps({
      check: async () => update as never,
      stopSidecar: async () => {
        throw new Error('no sidecar running')
      },
      relaunch: async () => {},
    })

    await useUpdaterStore.getState().checkNow()
    const ok = await useUpdaterStore.getState().installAndRestart()

    expect(ok).toBe(true)
    expect(update.install).toHaveBeenCalledOnce()
  })

  test('a failed install reports back so the caller can point at the Releases page', async () => {
    const update = fakeUpdate({
      install: async () => {
        throw new Error('read-only bundle')
      },
    })
    setUpdaterDeps({
      check: async () => update as never,
      stopSidecar: async () => {},
      relaunch: async () => {},
    })

    await useUpdaterStore.getState().checkNow()
    const ok = await useUpdaterStore.getState().installAndRestart()

    const s = useUpdaterStore.getState()
    expect(ok).toBe(false)
    expect(s.errorKind).toBe('install')
    // Cleared so the button is live again for a retry.
    expect(s.installing).toBe(false)
  })

  test('does nothing when no update is staged', async () => {
    const stopSidecar = vi.fn(async () => {})
    setUpdaterDeps({ stopSidecar })

    const ok = await useUpdaterStore.getState().installAndRestart()

    expect(ok).toBe(false)
    expect(stopSidecar).not.toHaveBeenCalled()
  })

  test('refuses to restart during a session — an unconfirmed quit would lose the session', async () => {
    const update = fakeUpdate()
    const stopSidecar = vi.fn(async () => {})
    setUpdaterDeps({
      check: async () => update as never,
      stopSidecar,
      relaunch: async () => {},
    })

    // Stage an update while no session is running, then a session begins.
    await useUpdaterStore.getState().checkNow()
    expect(useUpdaterStore.getState().status).toBe('ready')
    setUpdaterDeps({ isSessionActive: () => true })

    const ok = await useUpdaterStore.getState().installAndRestart()

    expect(ok).toBe(false)
    expect(stopSidecar).not.toHaveBeenCalled()
    expect(update.install).not.toHaveBeenCalled()
  })
})
