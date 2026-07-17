import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  __resetSidecarRuntime,
  __setSidecarRuntime,
  DEFAULT_CTX_SIZE,
  ERR_AI_DISABLED,
  HEALTH_POLL_INTERVAL_MS,
  useSidecarStore,
  type SidecarRuntime,
  type SidecarStatus,
} from '@/features/ai/sidecar'

type Tick = () => void

function makeFakeRuntime(opts: {
  aiEnabled: boolean
  startReturns?: number
  startThrows?: Error
  fetchHealthSequence?: boolean[]
}) {
  let scheduled: Tick | null = null
  let scheduledMs: number | null = null
  let nextHandle = 1
  const handles = new Map<number, Tick>()
  let healthIndex = 0
  const startCalls: Array<{
    modelPath: string
    mmprojPath: string | null
    ctxSize: number
  }> = []
  let stopCalls = 0
  let statusCalls = 0
  let baseStatus: SidecarStatus = {
    running: false,
    port: null,
    model: null,
    mmproj: null,
    ctx_size: null,
    errored: false,
    last_error: null,
  }

  const runtime: SidecarRuntime = {
    start: async (params) => {
      startCalls.push(params)
      if (opts.startThrows) throw opts.startThrows
      const port = opts.startReturns ?? 31337
      baseStatus = {
        running: true,
        port,
        model: params.modelPath,
        mmproj: params.mmprojPath,
        ctx_size: params.ctxSize,
        errored: false,
        last_error: null,
      }
      return port
    },
    stop: async () => {
      stopCalls += 1
      baseStatus = {
        running: false,
        port: null,
        model: null,
        mmproj: null,
        ctx_size: null,
        errored: false,
        last_error: null,
      }
    },
    status: async () => {
      statusCalls += 1
      return baseStatus
    },
    fetchHealth: async () => {
      const seq = opts.fetchHealthSequence ?? [true]
      const value = seq[Math.min(healthIndex, seq.length - 1)]
      healthIndex += 1
      return value
    },
    setInterval: (handler, ms) => {
      const id = nextHandle++
      handles.set(id, handler)
      scheduled = handler
      scheduledMs = ms
      return id
    },
    clearInterval: (handle) => {
      const id = handle as number
      handles.delete(id)
      if (handles.size === 0) {
        scheduled = null
        scheduledMs = null
      }
    },
    getAiFeaturesEnabled: () => opts.aiEnabled,
  }

  return {
    runtime,
    fireTick() {
      if (scheduled) scheduled()
    },
    scheduledMs() {
      return scheduledMs
    },
    handlesAlive() {
      return handles.size
    },
    startCalls,
    get stopCalls() {
      return stopCalls
    },
    get statusCalls() {
      return statusCalls
    },
  }
}

function resetStore(): void {
  useSidecarStore.setState({
    status: 'idle',
    port: null,
    model: null,
    mmproj: null,
    ctxSize: null,
    healthy: false,
    lastHealthCheckAt: null,
    lastError: null,
    pollHandle: null,
  })
}

describe('useSidecarStore.start', () => {
  beforeEach(() => {
    resetStore()
  })
  afterEach(() => {
    __resetSidecarRuntime()
  })

  test('refuses to start when AI features are disabled', async () => {
    const env = makeFakeRuntime({ aiEnabled: false })
    __setSidecarRuntime(env.runtime)

    const port = await useSidecarStore.getState().start({
      modelPath: '/tmp/model.gguf',
    })
    expect(port).toBeNull()
    expect(env.startCalls).toHaveLength(0)
    expect(useSidecarStore.getState().lastError).toBe(ERR_AI_DISABLED)
    expect(useSidecarStore.getState().status).toBe('idle')
  })

  test('starts the sidecar when AI is enabled and begins a 2s health poll', async () => {
    const env = makeFakeRuntime({
      aiEnabled: true,
      startReturns: 8123,
      fetchHealthSequence: [false, true],
    })
    __setSidecarRuntime(env.runtime)

    const port = await useSidecarStore.getState().start({
      modelPath: '/tmp/model.gguf',
      mmprojPath: '/tmp/mmproj.gguf',
      ctxSize: 2048,
    })
    expect(port).toBe(8123)
    expect(env.startCalls).toEqual([
      {
        modelPath: '/tmp/model.gguf',
        mmprojPath: '/tmp/mmproj.gguf',
        ctxSize: 2048,
      },
    ])
    const state = useSidecarStore.getState()
    expect(state.status).toBe('running')
    expect(state.port).toBe(8123)
    expect(state.model).toBe('/tmp/model.gguf')
    expect(state.mmproj).toBe('/tmp/mmproj.gguf')
    expect(state.ctxSize).toBe(2048)
    expect(env.scheduledMs()).toBe(HEALTH_POLL_INTERVAL_MS)
    // The synchronous tick on start (index 0 = false) leaves healthy=false.
    // Wait for the synchronous-fired tick's promise to settle.
    await Promise.resolve()
    await Promise.resolve()
    expect(useSidecarStore.getState().healthy).toBe(false)
    env.fireTick()
    await Promise.resolve()
    await Promise.resolve()
    expect(useSidecarStore.getState().healthy).toBe(true)
    expect(useSidecarStore.getState().lastHealthCheckAt).not.toBeNull()
  })

  test('uses the default context size when none is supplied', async () => {
    const env = makeFakeRuntime({ aiEnabled: true, startReturns: 9000 })
    __setSidecarRuntime(env.runtime)

    await useSidecarStore.getState().start({ modelPath: '/m.gguf' })
    expect(env.startCalls[0].ctxSize).toBe(DEFAULT_CTX_SIZE)
    expect(env.startCalls[0].mmprojPath).toBeNull()
  })

  test('stops the polling loop and clears state after stop()', async () => {
    const env = makeFakeRuntime({
      aiEnabled: true,
      startReturns: 9100,
      fetchHealthSequence: [true],
    })
    __setSidecarRuntime(env.runtime)
    await useSidecarStore.getState().start({ modelPath: '/m.gguf' })
    expect(env.handlesAlive()).toBe(1)

    await useSidecarStore.getState().stop()
    const state = useSidecarStore.getState()
    expect(state.status).toBe('idle')
    expect(state.port).toBeNull()
    expect(state.model).toBeNull()
    expect(state.healthy).toBe(false)
    expect(env.stopCalls).toBe(1)
    expect(env.handlesAlive()).toBe(0)
  })

  test('records the error when the Rust command rejects', async () => {
    const env = makeFakeRuntime({
      aiEnabled: true,
      startThrows: new Error('model_path does not exist: /missing'),
    })
    __setSidecarRuntime(env.runtime)

    const port = await useSidecarStore
      .getState()
      .start({ modelPath: '/missing' })
    expect(port).toBeNull()
    const state = useSidecarStore.getState()
    expect(state.status).toBe('errored')
    expect(state.lastError).toContain('model_path does not exist')
    expect(env.handlesAlive()).toBe(0)
  })
})

describe('useSidecarStore.refreshStatus', () => {
  beforeEach(() => {
    resetStore()
  })
  afterEach(() => {
    __resetSidecarRuntime()
  })

  test('promotes idle store to running when Rust reports the sidecar is up', async () => {
    // Fake runtime reports a running sidecar without going through start();
    // mirrors the "JS reload after Rust still has a child" recovery path.
    const baseStatus: SidecarStatus = {
      running: true,
      port: 8200,
      model: '/m.gguf',
      mmproj: null,
      ctx_size: 4096,
      errored: false,
      last_error: null,
    }
    const handles = new Set<number>()
    let nextHandle = 1
    let scheduled: (() => void) | null = null
    __setSidecarRuntime({
      start: async () => 8200,
      stop: async () => undefined,
      status: async () => baseStatus,
      fetchHealth: async () => true,
      setInterval: (handler) => {
        const id = nextHandle++
        handles.add(id)
        scheduled = handler
        return id
      },
      clearInterval: (handle) => {
        handles.delete(handle as number)
        if (handles.size === 0) scheduled = null
      },
      getAiFeaturesEnabled: () => true,
    })

    expect(handles.size).toBe(0)
    await useSidecarStore.getState().refreshStatus()
    const state = useSidecarStore.getState()
    expect(state.status).toBe('running')
    expect(state.port).toBe(8200)
    expect(state.model).toBe('/m.gguf')
    expect(handles.size).toBe(1)
    // Health probe fires synchronously on poll-start; let microtasks settle.
    await Promise.resolve()
    await Promise.resolve()
    expect(useSidecarStore.getState().healthy).toBe(true)
    expect(scheduled).not.toBeNull()
  })
})

// The other direction of the PR-13/I38 interleave family: an old loop's
// stop() continuation landing AFTER a newer start() claimed the state
// machine must not clobber 'starting' — otherwise start's own PR-13 guard
// kills the child it just spawned and the session toasts "AI failed to
// start" with no recovery path (the live trigger is the sample-loop restart
// on a localStream swap: cleanup stop() and setup start() run in one React
// commit).
describe('useSidecarStore.stop racing a newer start', () => {
  beforeEach(() => {
    resetStore()
  })
  afterEach(() => {
    __resetSidecarRuntime()
  })

  test("stop's late continuation does not clobber the newer start", async () => {
    let resolveStop!: () => void
    let resolveStart!: (port: number) => void
    let stopCalls = 0
    const runtime: SidecarRuntime = {
      start: () =>
        new Promise<number>((res) => {
          resolveStart = res
        }),
      stop: () => {
        stopCalls += 1
        return new Promise<void>((res) => {
          resolveStop = res
        })
      },
      status: async () => ({
        running: false,
        port: null,
        model: null,
        mmproj: null,
        ctx_size: null,
        errored: false,
        last_error: null,
      }),
      fetchHealth: async () => true,
      setInterval: () => 1,
      clearInterval: () => {},
      getAiFeaturesEnabled: () => true,
    }
    __setSidecarRuntime(runtime)
    useSidecarStore.setState({
      status: 'running',
      port: 9000,
      model: '/old.gguf',
    })

    const stopPromise = useSidecarStore.getState().stop()
    expect(useSidecarStore.getState().status).toBe('stopping')

    // The new loop boots while the stop IPC is still in flight; start()
    // proceeds from 'stopping' and takes ownership by writing 'starting'.
    const startPromise = useSidecarStore
      .getState()
      .start({ modelPath: '/new.gguf' })
    expect(useSidecarStore.getState().status).toBe('starting')

    // The stop IPC response lands late — it must leave the state alone.
    resolveStop()
    await stopPromise
    expect(useSidecarStore.getState().status).toBe('starting')

    resolveStart(9200)
    await expect(startPromise).resolves.toBe(9200)
    const state = useSidecarStore.getState()
    expect(state.status).toBe('running')
    expect(state.port).toBe(9200)
    // Exactly the old child was killed; start's PR-13 guard did not fire a
    // second stop against the fresh one.
    expect(stopCalls).toBe(1)
  })
})
