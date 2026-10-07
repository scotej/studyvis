import { getDownloadRuntime } from '@/features/ai/download'
import { DEFAULT_CTX_SIZE, useSidecarStore } from '@/features/ai/sidecar'
import { logger } from '@/lib/log'

const log = logger.child('mirror.ai')

type StartFailure = 'model_files_missing' | 'sidecar_start_failed'

type MirrorAiRuntime = {
  modelPaths: (modelId: string) => Promise<{
    modelPath: string
    mmprojPath: string
  }>
  start: (paths: {
    modelPath: string
    mmprojPath: string
    ctxSize: number
  }) => Promise<number | null>
  stop: () => Promise<void>
  lastError: () => string | null
}

const defaultRuntime: MirrorAiRuntime = {
  modelPaths: async (modelId) => {
    const paths = await getDownloadRuntime().paths(modelId)
    return { modelPath: paths.model_path, mmprojPath: paths.mmproj_path }
  },
  start: (paths) => useSidecarStore.getState().start(paths),
  stop: () => useSidecarStore.getState().stop(),
  lastError: () => useSidecarStore.getState().lastError,
}

// Capture may be unavailable on a tablet or released during reconnect. The
// mirrored session owns the engine so those transitions cannot end text AI.
export function startMirrorAiRuntime(
  options: {
    modelId: string
    onStartFail: (reason: StartFailure, detail?: string) => void
  },
  runtime: MirrorAiRuntime = defaultRuntime
): { ready: Promise<boolean>; stop: () => Promise<void> } {
  let stopped = false
  let stopPromise: Promise<void> | null = null
  let stage: StartFailure = 'model_files_missing'
  const ready = (async () => {
    const paths = await runtime.modelPaths(options.modelId)
    if (stopped) return false
    stage = 'sidecar_start_failed'
    const port = await runtime.start({ ...paths, ctxSize: DEFAULT_CTX_SIZE })
    if (stopped) return false
    if (port === null) {
      options.onStartFail(stage, runtime.lastError() ?? undefined)
      return false
    }
    return true
  })().catch((error: unknown) => {
    if (!stopped)
      options.onStartFail(
        stage,
        error instanceof Error ? error.message : String(error)
      )
    return false
  })

  return {
    ready,
    stop: () => {
      if (stopPromise) return stopPromise
      stopped = true
      // Claim the store's singleton stop synchronously before a replacement
      // model/session can join this owner's pending native start.
      let stopping: Promise<void>
      try {
        stopping = runtime.stop()
      } catch (error) {
        stopping = Promise.reject(error)
      }
      const settledStop = stopping.catch(() => {
        log.warn('sidecar.stop_failed')
      })
      stopPromise = Promise.all([ready, settledStop]).then(() => undefined)
      return stopPromise
    },
  }
}
