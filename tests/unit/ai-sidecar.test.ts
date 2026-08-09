import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  __resetSidecarRuntime,
  __setSidecarRuntime,
  DEFAULT_CTX_SIZE,
  ERR_AI_DISABLED,
  ERR_BENCHMARK_REQUIRES_AI_OFF,
  ERR_ENGINE_NOT_INSTALLED,
  HEALTH_POLL_INTERVAL_MS,
  useSidecarStore,
  type SidecarRuntime,
  type SidecarStatus,
} from '@/features/ai/sidecar'

type Tick = () => void

function makeFakeRuntime(opts: {
  aiEnabled: boolean
  engineAutoInstall?: boolean
  startReturns?: number
  // Tauri invoke rejects with plain STRINGS from Rust `Err(String)`; pass a
  // string here to exercise that path (an Error covers JS-side throws).
  startThrows?: Error | string
  fetchHealthSequence?: boolean[]
  fetchHealthThrows?: Error
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
    engineAutoInstall: boolean
  }> = []
  let stopCalls = 0
  let statusCalls = 0
  let baseStatus: SidecarStatus = {
    running: false,
    starting: false,
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
        starting: false,
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
        starting: false,
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
      if (opts.fetchHealthThrows) throw opts.fetchHealthThrows
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
    getEngineAutoInstall: () => opts.engineAutoInstall ?? true,
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

  test('refuses a live start when AI features are disabled', async () => {
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

  test('allows a benchmark start when AI features are disabled', async () => {
    const env = makeFakeRuntime({ aiEnabled: false, startReturns: 8123 })
    __setSidecarRuntime(env.runtime)

    const port = await useSidecarStore.getState().start({
      modelPath: '/tmp/model.gguf',
      mmprojPath: '/tmp/mmproj.gguf',
      ctxSize: 2048,
      purpose: 'benchmark',
    })

    expect(port).toBe(8123)
    expect(env.startCalls).toEqual([
      {
        modelPath: '/tmp/model.gguf',
        mmprojPath: '/tmp/mmproj.gguf',
        ctxSize: 2048,
        engineAutoInstall: true,
      },
    ])
    expect(useSidecarStore.getState().status).toBe('running')
    expect(useSidecarStore.getState().lastError).toBeNull()
  })

  test('refuses a benchmark start while AI features are enabled', async () => {
    const env = makeFakeRuntime({ aiEnabled: true })
    __setSidecarRuntime(env.runtime)

    const port = await useSidecarStore.getState().start({
      modelPath: '/tmp/model.gguf',
      purpose: 'benchmark',
    })

    expect(port).toBeNull()
    expect(env.startCalls).toHaveLength(0)
    expect(useSidecarStore.getState().lastError).toBe(
      ERR_BENCHMARK_REQUIRES_AI_OFF
    )
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
        // I73 — start() forwards the settings-store auto-install flag to
        // Rust's sidecar_start (mock runtime pins it true).
        engineAutoInstall: true,
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

  test('a rejected health probe is contained and records an unhealthy check', async () => {
    const env = makeFakeRuntime({
      aiEnabled: true,
      fetchHealthThrows: new Error('probe transport failed'),
    })
    __setSidecarRuntime(env.runtime)

    await useSidecarStore.getState().start({ modelPath: '/m.gguf' })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const state = useSidecarStore.getState()
    expect(state.status).toBe('running')
    expect(state.healthy).toBe(false)
    expect(state.lastHealthCheckAt).not.toBeNull()
  })

  test('uses the default context size when none is supplied', async () => {
    const env = makeFakeRuntime({ aiEnabled: true, startReturns: 9000 })
    __setSidecarRuntime(env.runtime)

    await useSidecarStore.getState().start({ modelPath: '/m.gguf' })
    expect(env.startCalls[0].ctxSize).toBe(DEFAULT_CTX_SIZE)
    expect(env.startCalls[0].mmprojPath).toBeNull()
  })

  test('joins 10 concurrent cold starts; the first request owns configuration', async () => {
    let resolveStart!: (port: number) => void
    const nativeStart = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveStart = resolve
        })
    )
    __setSidecarRuntime({
      start: nativeStart,
      stop: async () => undefined,
      status: async () => ({
        running: false,
        starting: false,
        port: null,
        model: null,
        mmproj: null,
        ctx_size: null,
        errored: false,
        last_error: null,
      }),
      fetchHealth: async () => true,
      setInterval: () => 1,
      clearInterval: () => undefined,
      getAiFeaturesEnabled: () => true,
      getEngineAutoInstall: () => true,
    })

    const firstRequest = {
      modelPath: '/tmp/model.gguf',
      mmprojPath: '/tmp/mmproj.gguf',
      ctxSize: 2048,
    }
    const callers = [
      useSidecarStore.getState().start(firstRequest),
      ...Array.from({ length: 8 }, () =>
        useSidecarStore.getState().start(firstRequest)
      ),
      // A second configuration cannot replace a singleton process mid-start;
      // it joins the first owner, matching the native command's semantics.
      useSidecarStore.getState().start({
        modelPath: '/tmp/other-model.gguf',
        mmprojPath: null,
        ctxSize: 8192,
      }),
    ]

    expect(nativeStart).toHaveBeenCalledTimes(1)
    expect(nativeStart).toHaveBeenCalledWith({
      ...firstRequest,
      engineAutoInstall: true,
    })
    expect(useSidecarStore.getState()).toMatchObject({
      status: 'starting',
      port: null,
    })

    resolveStart(8124)
    await expect(Promise.all(callers)).resolves.toEqual(Array(10).fill(8124))
    expect(useSidecarStore.getState()).toMatchObject({
      status: 'running',
      port: 8124,
      model: '/tmp/model.gguf',
      mmproj: '/tmp/mmproj.gguf',
      ctxSize: 2048,
    })
  })

  test('an incompatible request cannot supersede an in-flight live start', async () => {
    let resolveStart!: (port: number) => void
    const nativeStart = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveStart = resolve
        })
    )
    __setSidecarRuntime({
      start: nativeStart,
      stop: async () => undefined,
      status: async () => ({
        running: false,
        starting: false,
        port: null,
        model: null,
        mmproj: null,
        ctx_size: null,
        errored: false,
        last_error: null,
      }),
      fetchHealth: async () => true,
      setInterval: () => 1,
      clearInterval: () => undefined,
      getAiFeaturesEnabled: () => true,
      getEngineAutoInstall: () => true,
    })

    const liveStart = useSidecarStore
      .getState()
      .start({ modelPath: '/tmp/live.gguf' })
    const benchmarkStart = useSidecarStore
      .getState()
      .start({ modelPath: '/tmp/benchmark.gguf', purpose: 'benchmark' })

    await expect(benchmarkStart).resolves.toBeNull()
    expect(useSidecarStore.getState()).toMatchObject({
      status: 'starting',
      lastError: ERR_BENCHMARK_REQUIRES_AI_OFF,
    })
    expect(nativeStart).toHaveBeenCalledTimes(1)

    resolveStart(8125)
    await expect(liveStart).resolves.toBe(8125)
    expect(useSidecarStore.getState()).toMatchObject({
      status: 'running',
      port: 8125,
      model: '/tmp/live.gguf',
      lastError: null,
    })
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

  // I73 — the auto-install-off contract: the settings value is forwarded
  // verbatim, and the bare `engine_not_installed` sentinel (a plain-string
  // rejection, the way Tauri actually rejects) survives into lastError
  // intact so SessionView's strict-equality match works.
  test('forwards engineAutoInstall=false and surfaces the sentinel unchanged', async () => {
    const env = makeFakeRuntime({
      aiEnabled: true,
      engineAutoInstall: false,
      startThrows: ERR_ENGINE_NOT_INSTALLED,
    })
    __setSidecarRuntime(env.runtime)

    const port = await useSidecarStore
      .getState()
      .start({ modelPath: '/tmp/model.gguf' })
    expect(port).toBeNull()
    expect(env.startCalls[0]?.engineAutoInstall).toBe(false)
    const state = useSidecarStore.getState()
    expect(state.status).toBe('errored')
    expect(state.lastError).toBe(ERR_ENGINE_NOT_INSTALLED)
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
      starting: false,
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
      getEngineAutoInstall: () => true,
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

  test('preserves starting while Rust is still installing or spawning', async () => {
    const fetchHealth = vi.fn(async () => true)
    const setInterval = vi.fn(() => 1)
    __setSidecarRuntime({
      start: async () => 8200,
      stop: async () => undefined,
      status: async () => ({
        running: false,
        starting: true,
        port: null,
        model: null,
        mmproj: null,
        ctx_size: null,
        errored: false,
        last_error: null,
      }),
      fetchHealth,
      setInterval,
      clearInterval: () => undefined,
      getAiFeaturesEnabled: () => true,
      getEngineAutoInstall: () => true,
    })

    await useSidecarStore.getState().refreshStatus()

    expect(useSidecarStore.getState().status).toBe('starting')
    expect(useSidecarStore.getState().port).toBeNull()
    expect(setInterval).not.toHaveBeenCalled()
    expect(fetchHealth).not.toHaveBeenCalled()
  })
})

// PR-13/I38 interleaves: neither an old stop nor an old start continuation may
// overwrite the state owned by newer work. The live trigger is a sample-loop
// restart on localStream/model changes, where cleanup and setup run together.
describe('useSidecarStore start/stop races', () => {
  beforeEach(() => {
    resetStore()
  })
  afterEach(() => {
    __resetSidecarRuntime()
  })

  test('replacement start waits for native stop before it can adopt a port', async () => {
    let resolveStop!: () => void
    let nativeStopCompleted = false
    let stopCalls = 0
    const nativeStart = vi.fn(async () => (nativeStopCompleted ? 9200 : 9000))
    const runtime: SidecarRuntime = {
      start: nativeStart,
      stop: () => {
        stopCalls += 1
        return new Promise<void>((res) => {
          resolveStop = () => {
            nativeStopCompleted = true
            res()
          }
        })
      },
      status: async () => ({
        running: false,
        starting: false,
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
      getEngineAutoInstall: () => true,
    }
    __setSidecarRuntime(runtime)
    useSidecarStore.setState({
      status: 'running',
      port: 9000,
      model: '/old.gguf',
    })

    const stopPromise = useSidecarStore.getState().stop()
    expect(useSidecarStore.getState().status).toBe('stopping')

    // A native sidecar_start sent now could return the OLD child's port. The
    // replacement must wait for the owning stop IPC instead of racing it.
    const startPromise = useSidecarStore
      .getState()
      .start({ modelPath: '/new.gguf' })
    const secondStartPromise = useSidecarStore
      .getState()
      .start({ modelPath: '/new.gguf' })
    expect(useSidecarStore.getState().status).toBe('stopping')
    expect(nativeStart).not.toHaveBeenCalled()

    // Once native stop settles, one waiter creates the replacement and every
    // other waiter joins that same start instead of reporting a false failure.
    resolveStop()
    await stopPromise
    await expect(
      Promise.all([startPromise, secondStartPromise])
    ).resolves.toEqual([9200, 9200])
    const state = useSidecarStore.getState()
    expect(state.status).toBe('running')
    expect(state.port).toBe(9200)
    expect(nativeStart).toHaveBeenCalledTimes(1)
    expect(stopCalls).toBe(1)
  })

  test('a stale status refresh cannot revoke stop or return a dead port', async () => {
    let resolveStatus!: (status: SidecarStatus) => void
    let resolveStop!: () => void
    const nativeStart = vi.fn(async () => 9200)
    __setSidecarRuntime({
      start: nativeStart,
      stop: () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve
        }),
      status: () =>
        new Promise<SidecarStatus>((resolve) => {
          resolveStatus = resolve
        }),
      fetchHealth: async () => true,
      setInterval: () => 1,
      clearInterval: () => {},
      getAiFeaturesEnabled: () => true,
      getEngineAutoInstall: () => true,
    })
    useSidecarStore.setState({
      status: 'running',
      port: 9000,
      model: '/old.gguf',
    })

    const refreshPromise = useSidecarStore.getState().refreshStatus()
    const stopPromise = useSidecarStore.getState().stop()
    const replacementPromise = useSidecarStore
      .getState()
      .start({ modelPath: '/new.gguf' })
    expect(useSidecarStore.getState().status).toBe('stopping')

    // This snapshot describes the old child and arrives after stop owns the
    // store. Applying it would make stop look superseded and return port 9000
    // to the replacement even though native stop is about to kill that child.
    resolveStatus({
      running: true,
      starting: false,
      port: 9000,
      model: '/old.gguf',
      mmproj: null,
      ctx_size: 4096,
      errored: false,
      last_error: null,
    })
    await refreshPromise
    expect(useSidecarStore.getState().status).toBe('stopping')

    resolveStop()
    await stopPromise
    await expect(replacementPromise).resolves.toBe(9200)
    expect(nativeStart).toHaveBeenCalledTimes(1)
    expect(useSidecarStore.getState()).toMatchObject({
      status: 'running',
      port: 9200,
      model: '/new.gguf',
    })
  })

  test("a canceled start's late rejection does not clobber idle", async () => {
    let rejectStart!: (error: Error) => void
    __setSidecarRuntime({
      start: () =>
        new Promise<number>((_resolve, reject) => {
          rejectStart = reject
        }),
      stop: async () => undefined,
      status: async () => ({
        running: false,
        starting: false,
        port: null,
        model: null,
        mmproj: null,
        ctx_size: null,
        errored: false,
        last_error: null,
      }),
      fetchHealth: async () => false,
      setInterval: () => 1,
      clearInterval: () => undefined,
      getAiFeaturesEnabled: () => true,
      getEngineAutoInstall: () => true,
    })

    const startPromise = useSidecarStore
      .getState()
      .start({ modelPath: '/slow.gguf' })
    expect(useSidecarStore.getState().status).toBe('starting')

    await useSidecarStore.getState().stop()
    expect(useSidecarStore.getState().status).toBe('idle')

    rejectStart(new Error('sidecar start superseded'))
    await expect(startPromise).resolves.toBeNull()
    expect(useSidecarStore.getState().status).toBe('idle')
    expect(useSidecarStore.getState().lastError).toBeNull()
  })

  test("an old start's late rejection does not clobber a newer start", async () => {
    let rejectOldStart!: (error: Error) => void
    let resolveNewStart!: (port: number) => void
    let startCalls = 0
    __setSidecarRuntime({
      start: () => {
        startCalls += 1
        return new Promise<number>((resolve, reject) => {
          if (startCalls === 1) rejectOldStart = reject
          else resolveNewStart = resolve
        })
      },
      stop: async () => undefined,
      status: async () => ({
        running: false,
        starting: false,
        port: null,
        model: null,
        mmproj: null,
        ctx_size: null,
        errored: false,
        last_error: null,
      }),
      fetchHealth: async () => false,
      setInterval: () => 1,
      clearInterval: () => undefined,
      getAiFeaturesEnabled: () => true,
      getEngineAutoInstall: () => true,
    })

    const oldStart = useSidecarStore
      .getState()
      .start({ modelPath: '/old-slow.gguf' })
    await useSidecarStore.getState().stop()
    const newStart = useSidecarStore
      .getState()
      .start({ modelPath: '/new.gguf' })
    expect(useSidecarStore.getState().status).toBe('starting')

    rejectOldStart(new Error('sidecar start superseded'))
    await expect(oldStart).resolves.toBeNull()
    expect(useSidecarStore.getState().status).toBe('starting')
    expect(useSidecarStore.getState().lastError).toBeNull()

    resolveNewStart(9300)
    await expect(newStart).resolves.toBe(9300)
    expect(useSidecarStore.getState().status).toBe('running')
    expect(useSidecarStore.getState().port).toBe(9300)
  })
})
