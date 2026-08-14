import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  SESSION_OVERLAY_DISMISS,
  SESSION_OVERLAY_PRESENT,
  SESSION_OVERLAY_READY,
  SESSION_OVERLAY_UPDATE,
  SESSION_OVERLAY_WINDOW_LABEL,
  SESSION_OVERLAY_WINDOW_WIDTH,
  type SessionOverlayUpdatePayload,
} from '@/features/session/sessionOverlay'

type EventHandler = (event: { payload: unknown }) => void
type LogicalSizeLike = { width: number; height: number }
type EmittedEvent = { target: string; event: string; payload: unknown }
type OverlayMock = {
  closed: boolean
  hideCalls: number
  showCalls: number
  sizes: LogicalSizeLike[]
}

const harness = vi.hoisted(() => ({
  emitted: [] as EmittedEvent[],
  failListenOn: null as string | null,
  handlers: new Map<string, EventHandler>(),
  overlay: null as OverlayMock | null,
  sequence: [] as string[],
  unregistered: [] as string[],
}))

vi.mock('@/strings', () => ({
  strings: { app: { name: 'StudyVis' } },
}))

vi.mock('@tauri-apps/api/dpi', () => ({
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
      this.showCalls += 1
    }

    async setSize(size: LogicalSizeLike): Promise<void> {
      this.sizes.push({ width: size.width, height: size.height })
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
  monitorFromPoint: async () => null,
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
    harness.handlers.clear()
    harness.overlay = null
    harness.sequence = []
    harness.unregistered = []
    vi.stubGlobal('document', {
      visibilityState: 'hidden',
      hasFocus: () => false,
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  test('registers the complete control channel before constructing a window', async () => {
    const runtime = await loadRuntime()

    await runtime.pushSessionOverlayItem(item)

    expect(harness.sequence).toEqual([
      `listen:${SESSION_OVERLAY_READY}`,
      `listen:${SESSION_OVERLAY_DISMISS}`,
      `listen:${SESSION_OVERLAY_PRESENT}`,
      'construct',
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
})
