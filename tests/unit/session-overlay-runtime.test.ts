import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  SESSION_OVERLAY_DISMISS,
  SESSION_OVERLAY_PRESENT,
  SESSION_OVERLAY_READY,
  SESSION_OVERLAY_READY_TIMEOUT_MS,
  SESSION_OVERLAY_UPDATE,
  SESSION_OVERLAY_WINDOW_LABEL,
  SESSION_OVERLAY_WINDOW_MARGIN,
  SESSION_OVERLAY_WINDOW_WIDTH,
  type SessionOverlayUpdatePayload,
} from '@/features/session/sessionOverlay'
import { SESSION_OVERLAY_PREPARE_COMMAND } from '@/features/session/sessionOverlayRuntime'

type EventHandler = (event: { payload: unknown }) => void
type LogicalSizeLike = { width: number; height: number }
type LogicalPositionLike = { x: number; y: number }
type EmittedEvent = { target: string; event: string; payload: unknown }
type OverlayMock = {
  closed: boolean
  hideCalls: number
  showCalls: number
  sizes: LogicalSizeLike[]
  positions: LogicalPositionLike[]
}
type MonitorLike = {
  scaleFactor: number
  workArea: {
    position: { toLogical: (scale: number) => LogicalPositionLike }
    size: { toLogical: (scale: number) => LogicalSizeLike }
  }
}

const harness = vi.hoisted(() => ({
  emitted: [] as EmittedEvent[],
  failListenOn: null as string | null,
  failPrepare: false,
  handlers: new Map<string, EventHandler>(),
  invoked: [] as string[],
  monitor: null as MonitorLike | null,
  overlay: null as OverlayMock | null,
  sequence: [] as string[],
  unregistered: [] as string[],
}))

vi.mock('@/strings', () => ({
  strings: { app: { name: 'StudyVis' } },
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    harness.invoked.push(command)
    harness.sequence.push(`invoke:${command}`)
    if (harness.failPrepare) throw new Error('ns_window() returned null')
  },
}))

vi.mock('@tauri-apps/api/dpi', () => ({
  LogicalPosition: class LogicalPosition {
    x: number
    y: number

    constructor(x: number, y: number) {
      this.x = x
      this.y = y
    }
  },
  LogicalSize: class LogicalSize {
    width: number
    height: number

    constructor(width: number, height: number) {
      this.width = width
      this.height = height
    }
  },
}))

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: async (target: string, event: string, payload: unknown) => {
    harness.emitted.push({ target, event, payload })
  },
}))

vi.mock('@tauri-apps/api/webviewWindow', () => {
  class MockWebviewWindow implements OverlayMock {
    static async getByLabel(): Promise<MockWebviewWindow | null> {
      const overlay = harness.overlay
      return overlay && !overlay.closed ? (overlay as MockWebviewWindow) : null
    }

    closed = false
    hideCalls = 0
    showCalls = 0
    sizes: LogicalSizeLike[] = []
    positions: LogicalPositionLike[] = []

    constructor() {
      harness.sequence.push('construct')
      harness.overlay = this
    }

    async once(event: string, handler: () => void): Promise<() => void> {
      if (event === 'tauri://created') handler()
      return () => {}
    }

    async hide(): Promise<void> {
      this.hideCalls += 1
    }

    async show(): Promise<void> {
      harness.sequence.push('show')
      this.showCalls += 1
    }

    async setSize(size: LogicalSizeLike): Promise<void> {
      harness.sequence.push('setSize')
      this.sizes.push({ width: size.width, height: size.height })
    }

    async setPosition(position: LogicalPositionLike): Promise<void> {
      harness.sequence.push('setPosition')
      this.positions.push({ x: position.x, y: position.y })
    }

    async close(): Promise<void> {
      this.closed = true
    }
  }

  return {
    getCurrentWebviewWindow: () => ({
      listen: async (event: string, handler: EventHandler) => {
        harness.sequence.push(`listen:${event}`)
        if (harness.failListenOn === event) {
          throw new Error(`failed to listen for ${event}`)
        }
        harness.handlers.set(event, handler)
        return () => {
          harness.unregistered.push(event)
          harness.handlers.delete(event)
        }
      },
    }),
    WebviewWindow: MockWebviewWindow,
  }
})

vi.mock('@tauri-apps/api/window', () => ({
  cursorPosition: async () => ({ x: 0, y: 0 }),
  monitorFromPoint: async () => harness.monitor,
  currentMonitor: async () => null,
  primaryMonitor: async () => null,
  getCurrentWindow: () => ({
    isVisible: async () => true,
    isFocused: async () => false,
  }),
}))

const item = {
  id: 'note:1',
  title: 'Notes',
  body: 'A notification that must survive renderer lifecycle changes.',
  tone: 'neutral' as const,
}

async function loadRuntime() {
  return import('@/features/session/sessionOverlayRuntime')
}

function emitFromOverlay(event: string, payload: unknown = {}): void {
  const handler = harness.handlers.get(event)
  expect(handler).toBeDefined()
  handler?.({ payload })
}

async function flushAsyncWork(): Promise<void> {
  for (let step = 0; step < 12; step += 1) await Promise.resolve()
}

// A 2x display whose work area starts below a 25 pt menu bar, in the physical
// units Tauri's monitor API reports.
function retinaMonitor(): MonitorLike {
  return {
    scaleFactor: 2,
    workArea: {
      position: { toLogical: (scale) => ({ x: 0, y: 50 / scale }) },
      size: {
        toLogical: (scale) => ({ width: 2940 / scale, height: 1862 / scale }),
      },
    },
  }
}

async function revealFirstItem(
  runtime: Awaited<ReturnType<typeof loadRuntime>>,
  height = 172
): Promise<number> {
  await runtime.pushSessionOverlayItem(item)
  emitFromOverlay(SESSION_OVERLAY_READY)
  await flushAsyncWork()
  const revision = updates()[0]?.revision
  expect(revision).toBeDefined()
  emitFromOverlay(SESSION_OVERLAY_PRESENT, { revision, height })
  await flushAsyncWork()
  return revision as number
}

async function overlayLogMessages(): Promise<string[]> {
  // The runtime is re-imported after resetModules, so read the logger
  // instance it wrote to rather than a stale top-level import.
  const { recentRecords } = await import('@/lib/log')
  return recentRecords()
    .filter((record) => record.scope === 'session.overlay')
    .map((record) => record.msg)
}

function updates(): SessionOverlayUpdatePayload[] {
  return harness.emitted
    .filter((entry: EmittedEvent) => entry.event === SESSION_OVERLAY_UPDATE)
    .map((entry: EmittedEvent) => entry.payload as SessionOverlayUpdatePayload)
}

describe('session overlay runtime lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    harness.emitted = []
    harness.failListenOn = null
    harness.failPrepare = false
    harness.handlers.clear()
    harness.invoked = []
    harness.monitor = null
    harness.overlay = null
    harness.sequence = []
    harness.unregistered = []
    vi.stubGlobal('document', {
      visibilityState: 'hidden',
      hasFocus: () => false,
    })
    // The logger mirrors warn records to the console; the assertions below
    // read the ring buffer instead.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('registers the complete control channel before constructing a window', async () => {
    const runtime = await loadRuntime()

    await runtime.pushSessionOverlayItem(item)

    expect(harness.sequence).toEqual([
      `listen:${SESSION_OVERLAY_READY}`,
      `listen:${SESSION_OVERLAY_DISMISS}`,
      `listen:${SESSION_OVERLAY_PRESENT}`,
      'construct',
      `invoke:${SESSION_OVERLAY_PREPARE_COMMAND}`,
    ])
    expect(harness.handlers.has(SESSION_OVERLAY_READY)).toBe(true)
    expect(harness.handlers.has(SESSION_OVERLAY_DISMISS)).toBe(true)
    expect(harness.handlers.has(SESSION_OVERLAY_PRESENT)).toBe(true)
    expect(updates()).toHaveLength(0)
  })

  test('replays the active item after a fresh renderer announces READY', async () => {
    const runtime = await loadRuntime()
    await runtime.pushSessionOverlayItem(item)
    const overlay = harness.overlay
    expect(overlay).not.toBeNull()

    emitFromOverlay(SESSION_OVERLAY_READY)
    await flushAsyncWork()
    const firstUpdate = updates()[0]
    expect(firstUpdate).toMatchObject({
      revision: 1,
      snapshot: { item: { id: item.id } },
    })

    emitFromOverlay(SESSION_OVERLAY_PRESENT, {
      revision: firstUpdate?.revision,
      height: 172,
    })
    await flushAsyncWork()
    expect(overlay?.sizes).toEqual([
      { width: SESSION_OVERLAY_WINDOW_WIDTH, height: 172 },
    ])
    expect(overlay?.showCalls).toBe(1)

    emitFromOverlay(SESSION_OVERLAY_READY)
    await flushAsyncWork()
    const replay = updates()[1]
    expect(replay).toMatchObject({
      revision: 2,
      snapshot: { item: { id: item.id } },
    })
    expect(overlay?.hideCalls).toBe(2)

    // A measurement from the renderer instance that just disappeared cannot
    // reveal or resize the replacement lifecycle.
    emitFromOverlay(SESSION_OVERLAY_PRESENT, {
      revision: firstUpdate?.revision,
      height: 240,
    })
    await flushAsyncWork()
    expect(overlay?.sizes).toHaveLength(1)

    emitFromOverlay(SESSION_OVERLAY_PRESENT, {
      revision: replay?.revision,
      height: 188,
    })
    await flushAsyncWork()
    expect(overlay?.sizes).toEqual([
      { width: SESSION_OVERLAY_WINDOW_WIDTH, height: 172 },
      { width: SESSION_OVERLAY_WINDOW_WIDTH, height: 188 },
    ])
    expect(overlay?.showCalls).toBe(2)
  })

  test('does not create a dead window when the control channel cannot bind', async () => {
    harness.failListenOn = SESSION_OVERLAY_DISMISS
    const runtime = await loadRuntime()

    await runtime.pushSessionOverlayItem(item)

    expect(harness.overlay).toBeNull()
    expect(harness.sequence).not.toContain('construct')
    expect(harness.handlers.size).toBe(0)
    expect(harness.unregistered).toEqual([SESSION_OVERLAY_READY])
  })

  test('ignores malformed dismiss events and closes only for the active id', async () => {
    const runtime = await loadRuntime()
    await runtime.pushSessionOverlayItem(item)
    const overlay = harness.overlay

    emitFromOverlay(SESSION_OVERLAY_READY)
    await flushAsyncWork()
    const update = updates()[0]
    emitFromOverlay(SESSION_OVERLAY_PRESENT, {
      revision: update?.revision,
      height: 172,
    })
    await flushAsyncWork()

    emitFromOverlay(SESSION_OVERLAY_DISMISS, { id: 7 })
    await flushAsyncWork()
    expect(overlay?.closed).toBe(false)

    emitFromOverlay(SESSION_OVERLAY_DISMISS, { id: item.id })
    await flushAsyncWork()
    expect(overlay?.closed).toBe(true)
  })

  test('targets renderer updates to the overlay webview only', async () => {
    const runtime = await loadRuntime()
    await runtime.pushSessionOverlayItem(item)

    emitFromOverlay(SESSION_OVERLAY_READY)
    await flushAsyncWork()

    expect(harness.emitted).toEqual([
      expect.objectContaining({
        target: SESSION_OVERLAY_WINDOW_LABEL,
        event: SESSION_OVERLAY_UPDATE,
      }),
    ])
  })

  // #317 — the native preparation (macOS fullScreenAuxiliary) must land
  // between construction and the first reveal, exactly once per window.
  test('prepares the native window between creation and the first reveal', async () => {
    const runtime = await loadRuntime()

    await revealFirstItem(runtime)

    const prepare = `invoke:${SESSION_OVERLAY_PREPARE_COMMAND}`
    expect(harness.invoked).toEqual([SESSION_OVERLAY_PREPARE_COMMAND])
    expect(harness.sequence.indexOf('construct')).toBeLessThan(
      harness.sequence.indexOf(prepare)
    )
    expect(harness.sequence.indexOf(prepare)).toBeLessThan(
      harness.sequence.indexOf('show')
    )

    await runtime.pushSessionOverlayItem({ ...item, id: 'note:2' })
    expect(harness.invoked).toHaveLength(1)
  })

  test('still reveals the overlay when native preparation fails', async () => {
    harness.failPrepare = true
    const runtime = await loadRuntime()

    await revealFirstItem(runtime)

    expect(harness.overlay?.showCalls).toBe(1)
    expect(await overlayLogMessages()).toEqual([
      'prepare.failed',
      'present.shown',
    ])
  })

  test('re-asserts the top-left corner after every measured resize', async () => {
    harness.monitor = retinaMonitor()
    const runtime = await loadRuntime()

    const revision = await revealFirstItem(runtime)

    const expected = {
      x: 1470 - SESSION_OVERLAY_WINDOW_WIDTH - SESSION_OVERLAY_WINDOW_MARGIN,
      y: 25 + SESSION_OVERLAY_WINDOW_MARGIN,
    }
    expect(harness.overlay?.positions).toEqual([expected])
    expect(harness.sequence.slice(-3)).toEqual([
      'setSize',
      'setPosition',
      'show',
    ])

    // A later measurement for the visible revision (fonts finished loading)
    // resizes in place and anchors again.
    emitFromOverlay(SESSION_OVERLAY_PRESENT, { revision, height: 200 })
    await flushAsyncWork()
    expect(harness.overlay?.sizes).toEqual([
      { width: SESSION_OVERLAY_WINDOW_WIDTH, height: 172 },
      { width: SESSION_OVERLAY_WINDOW_WIDTH, height: 200 },
    ])
    expect(harness.overlay?.positions).toEqual([expected, expected])
    expect(harness.overlay?.showCalls).toBe(1)
  })

  test('leaves the position alone when no monitor could be resolved', async () => {
    const runtime = await loadRuntime()

    await revealFirstItem(runtime)

    expect(harness.overlay?.sizes).toHaveLength(1)
    expect(harness.overlay?.positions).toEqual([])
    expect(harness.overlay?.showCalls).toBe(1)
  })

  test('records a renderer that never announces READY', async () => {
    const runtime = await loadRuntime()

    await runtime.pushSessionOverlayItem(item)
    await vi.advanceTimersByTimeAsync(SESSION_OVERLAY_READY_TIMEOUT_MS)

    expect(await overlayLogMessages()).toEqual(['ready.timeout'])
  })

  test('stays quiet when READY arrives inside the watchdog window', async () => {
    const runtime = await loadRuntime()

    await runtime.pushSessionOverlayItem(item)
    emitFromOverlay(SESSION_OVERLAY_READY)
    await flushAsyncWork()
    await vi.advanceTimersByTimeAsync(SESSION_OVERLAY_READY_TIMEOUT_MS)

    // The layout fallback legitimately reveals the card inside this window;
    // only the watchdog must stay silent.
    expect(await overlayLogMessages()).not.toContain('ready.timeout')
  })
})
