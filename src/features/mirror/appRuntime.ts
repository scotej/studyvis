import { sha256 } from '@noble/hashes/sha2.js'

import {
  isMirrorAppJson,
  isMirrorAppCommand,
  readMirrorAppRequest,
  readMirrorAppSnapshot,
  readMirrorAppJob,
  type MirrorAppCommandName,
  type MirrorAppError,
  type MirrorAppJson,
  type MirrorAppRequest,
  type MirrorAppResult,
  type MirrorAppSnapshot,
  type MirrorAppJob,
} from './appBridge'

export type MirrorAppExecution = {
  signal: AbortSignal
  isCurrent: () => boolean
  commit: <T>(write: () => T | Promise<T>) => Promise<T>
}

export type MirrorAppCommandSpec<T> = {
  parse: (input: MirrorAppJson) => T | null
  execute: (
    args: T,
    context: MirrorAppExecution
  ) => MirrorAppJson | Promise<MirrorAppJson>
  requiresSession?: boolean
  mutates?: boolean
  sensitive?: boolean
  available?: (snapshot: MirrorAppSnapshot) => boolean
}

type Registration = MirrorAppCommandSpec<unknown>
type Entry = {
  sequence: number
  fingerprint: string
  result?: MirrorAppResult
  pending?: Promise<MirrorAppResult>
  bytes: number
}
type Active = {
  controllerId: string
  abort: AbortController
  committed: boolean
  releaseWait?: (error: MirrorAppError) => void
}

export type MirrorAppRuntime = ReturnType<typeof createMirrorAppRuntime>
export const MIRROR_APP_REPLAY_WINDOW = 4096

export function createMirrorAppRuntime() {
  let snapshot: MirrorAppSnapshot | null = null
  let cachedBytes = 0
  let replayGeneration = crypto.randomUUID()
  let highestSequence = -1
  const commands = new Map<MirrorAppCommandName, Registration>()
  const entries = new Map<string, Entry>()
  const sequences = new Map<number, string>()
  const active = new Set<Active>()
  const listeners = new Set<() => void>()
  const jobListeners = new Set<(job: MirrorAppJob) => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const invalidate = () => {
    for (const operation of active) {
      operation.abort.abort()
      operation.releaseWait?.('cancelled')
    }
    entries.clear()
    sequences.clear()
    cachedBytes = 0
    highestSequence = -1
    replayGeneration = crypto.randomUUID()
  }
  const capabilities = () =>
    snapshot
      ? [...commands]
          .filter(([, spec]) => {
            try {
              return (
                (!spec.requiresSession ||
                  snapshot!.sessionActivationId !== null) &&
                (!spec.available || spec.available(snapshot!))
              )
            } catch {
              return false
            }
          })
          .map(([name]) => name)
      : []
  const currentSnapshot = () =>
    snapshot
      ? readMirrorAppSnapshot({
          ...snapshot,
          replayGeneration,
          replayNextSequence: highestSequence + 1,
          capabilities: capabilities(),
        })
      : null
  const fail = (
    request: MirrorAppRequest,
    error: MirrorAppError
  ): MirrorAppResult => ({
    version: 1,
    requestId: request.requestId,
    ownerEpoch: request.ownerEpoch,
    ok: false,
    error,
  })
  const trimResults = () => {
    let results = [...entries.values()].filter((entry) => entry.result).length
    for (const entry of entries.values()) {
      if (cachedBytes <= 2 * 1024 * 1024 && results <= 128) break
      if (entry.result) {
        cachedBytes -= entry.bytes
        entry.bytes = 0
        delete entry.result
        results--
      }
    }
    const floor = highestSequence - MIRROR_APP_REPLAY_WINDOW + 1
    for (const [key, entry] of entries)
      if (entry.sequence < floor && !entry.pending && !entry.result) {
        entries.delete(key)
        sequences.delete(entry.sequence)
      }
  }

  return {
    getSnapshot: currentSnapshot,
    setSnapshot(
      next: Omit<
        MirrorAppSnapshot,
        'capabilities' | 'replayGeneration' | 'replayNextSequence'
      >
    ) {
      const parsed = readMirrorAppSnapshot({
        ...next,
        replayGeneration,
        replayNextSequence: highestSequence + 1,
        capabilities: [],
      })
      if (
        !parsed ||
        (snapshot?.ownerEpoch === parsed.ownerEpoch &&
          parsed.revision < snapshot.revision)
      )
        throw new Error('Invalid companion app snapshot')
      if (snapshot?.ownerEpoch !== parsed.ownerEpoch) invalidate()
      else if (snapshot.sessionActivationId !== parsed.sessionActivationId) {
        for (const operation of active)
          if (!operation.committed) {
            operation.abort.abort()
            operation.releaseWait?.('cancelled')
          }
      }
      snapshot = parsed
      notify()
    },
    register<T>(name: MirrorAppCommandName, spec: MirrorAppCommandSpec<T>) {
      if (
        !isMirrorAppCommand(name) ||
        typeof spec.parse !== 'function' ||
        typeof spec.execute !== 'function'
      )
        throw new Error('Invalid companion command port')
      if (commands.has(name))
        throw new Error('Companion command already registered')
      const registration = spec as Registration
      commands.set(name, registration)
      notify()
      return () => {
        if (commands.get(name) === registration) {
          commands.delete(name)
          notify()
        }
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    subscribeJobs(listener: (job: MirrorAppJob) => void) {
      jobListeners.add(listener)
      return () => {
        jobListeners.delete(listener)
      }
    },
    publishJob(job: MirrorAppJob) {
      const parsed = readMirrorAppJob(job)
      if (!parsed || parsed.ownerEpoch !== snapshot?.ownerEpoch) return false
      for (const listener of jobListeners) listener(parsed)
      return true
    },
    retireSession(activationId?: string) {
      if (
        !snapshot ||
        snapshot.sessionActivationId === null ||
        (activationId !== undefined &&
          snapshot.sessionActivationId !== activationId)
      )
        return
      for (const operation of active)
        if (!operation.committed) {
          operation.abort.abort()
          operation.releaseWait?.('cancelled')
        }
      snapshot = {
        ...snapshot,
        sessionActivationId: null,
        phase: 'home',
        revision: snapshot.revision + 1,
      }
      notify()
    },
    retireController(controllerId: string) {
      for (const operation of active)
        if (operation.controllerId === controllerId && !operation.committed) {
          operation.abort.abort()
          operation.releaseWait?.('cancelled')
        }
    },
    reset() {
      invalidate()
      snapshot = null
      notify()
    },
    async handle(
      raw: unknown,
      controllerId: string,
      ownsController: () => boolean
    ): Promise<MirrorAppResult | null> {
      const request = readMirrorAppRequest(raw)
      if (!request) return null
      const start = snapshot
      if (!start || request.ownerEpoch !== start.ownerEpoch)
        return fail(request, 'stale_owner')
      if (!ownsController()) return fail(request, 'cancelled')
      if (request.replayGeneration !== replayGeneration)
        return fail(request, 'expired')
      const key = request.requestId
      const fingerprint = Array.from(
        sha256(new TextEncoder().encode(JSON.stringify(request))),
        (byte) => byte.toString(16).padStart(2, '0')
      ).join('')
      const previous = entries.get(key)
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          return fail(request, 'request_conflict')
        return previous.pending ?? previous.result ?? fail(request, 'expired')
      }
      if (sequences.has(request.replaySequence))
        return fail(request, 'request_conflict')
      if (request.replaySequence <= highestSequence - MIRROR_APP_REPLAY_WINDOW)
        return fail(request, 'expired')
      if (
        request.replaySequence > highestSequence + MIRROR_APP_REPLAY_WINDOW ||
        request.replaySequence === Number.MAX_SAFE_INTEGER
      )
        return fail(request, 'invalid_request')
      const spec = commands.get(request.command)
      if (!spec || !capabilities().includes(request.command))
        return fail(request, 'unsupported')
      if (request.sessionActivationId !== start.sessionActivationId)
        return fail(request, 'stale_session')
      if (spec.mutates && request.expectedRevision !== start.revision)
        return fail(request, 'stale_revision')
      if (active.size >= 32) return fail(request, 'busy')
      let args: unknown
      try {
        args = spec.parse(request.args)
      } catch {
        return fail(request, 'invalid_request')
      }
      if (args === null) return fail(request, 'invalid_request')
      const operation: Active = {
        controllerId,
        abort: new AbortController(),
        committed: false,
      }
      active.add(operation)
      const isCurrent = () =>
        !operation.abort.signal.aborted &&
        ownsController() &&
        snapshot?.ownerEpoch === request.ownerEpoch &&
        snapshot.sessionActivationId === request.sessionActivationId &&
        commands.get(request.command) === spec &&
        (!spec.mutates || snapshot.revision === request.expectedRevision)
      const context: MirrorAppExecution = {
        signal: operation.abort.signal,
        isCurrent,
        async commit(write) {
          if (!spec.mutates || operation.committed || !isCurrent())
            throw new Error('Companion operation cancelled')
          operation.committed = true
          return write()
        },
      }
      const entry: Entry = {
        fingerprint,
        bytes: 0,
        sequence: request.replaySequence,
      }
      entries.set(key, entry)
      sequences.set(request.replaySequence, key)
      highestSequence = Math.max(highestSequence, request.replaySequence)
      let timer: ReturnType<typeof setTimeout> | undefined
      const wait = new Promise<MirrorAppResult>((resolve) => {
        operation.releaseWait = (error) => {
          clearTimeout(timer)
          resolve(fail(request, error))
        }
        timer = setTimeout(() => {
          if (!operation.committed) operation.abort.abort()
          operation.releaseWait?.(operation.committed ? 'busy' : 'expired')
        }, 30_000)
      })
      const pending = Promise.resolve()
        .then(async () => {
          if (!isCurrent()) return fail(request, 'cancelled')
          try {
            const value = await spec.execute(args, context)
            if (
              (!operation.committed && !isCurrent()) ||
              snapshot?.ownerEpoch !== request.ownerEpoch
            )
              return fail(request, 'cancelled')
            if (
              (spec.mutates && !operation.committed) ||
              !isMirrorAppJson(value, true)
            )
              return fail(request, 'invalid_result')
            return {
              version: 1,
              requestId: request.requestId,
              ownerEpoch: request.ownerEpoch,
              ok: true,
              value: JSON.parse(JSON.stringify(value)) as MirrorAppJson,
            } as MirrorAppResult
          } catch {
            return fail(
              request,
              operation.abort.signal.aborted || !ownsController()
                ? 'cancelled'
                : 'failed'
            )
          }
        })
        .then((result) => {
          clearTimeout(timer)
          delete operation.releaseWait
          delete entry.pending
          active.delete(operation)
          if (entries.get(key) === entry && !spec.sensitive) {
            entry.result = result
            entry.bytes = JSON.stringify(result).length
            cachedBytes += entry.bytes
            entries.delete(key)
            entries.set(key, entry)
          }
          trimResults()
          return result
        })
      entry.pending = Promise.race([pending, wait])
      return entry.pending
    },
  }
}
