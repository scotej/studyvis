import { describe, expect, test, vi } from 'vitest'

import {
  appFields,
  appRecord,
  readMirrorAppRequest,
  readMirrorAppResult,
  readMirrorAppSnapshot,
  type MirrorAppRequest,
} from '@/features/mirror/appBridge'
import {
  createMirrorAppRuntime,
  MIRROR_APP_REPLAY_WINDOW,
  type MirrorAppRuntime,
} from '@/features/mirror/appRuntime'

const initial = {
  version: 1 as const,
  ownerEpoch: 'owner-1',
  replayGeneration: 'test-generation',
  replayNextSequence: 0,
  revision: 1,
  phase: 'home' as const,
  identity: { edPubkeyHex: 'a'.repeat(64), displayName: 'Alice' },
  sessionActivationId: null,
}
const request = (patch: Partial<MirrorAppRequest> = {}): MirrorAppRequest => ({
  version: 1,
  requestId: 'request-1',
  replayGeneration: 'test-generation',
  replaySequence: 0,
  ownerEpoch: 'owner-1',
  sessionActivationId: null,
  expectedRevision: 1,
  command: 'identity.rename',
  args: { name: 'Bob' },
  ...patch,
})
const requestFor = (app: MirrorAppRuntime) => {
  const sequences = new Map<string, number>()
  return (patch: Partial<MirrorAppRequest> = {}) => {
    const id = patch.requestId ?? 'request-1'
    if (!sequences.has(id)) sequences.set(id, sequences.size)
    return request({
      replayGeneration: app.getSnapshot()!.replayGeneration,
      replaySequence: sequences.get(id)!,
      ...patch,
    })
  }
}
const parseName = (input: unknown) =>
  appRecord(input) &&
  appFields(input, ['name']) &&
  typeof input.name === 'string' &&
  input.name.length > 0 &&
  input.name.length <= 64
    ? { name: input.name }
    : null
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('companion app contract', () => {
  test('rejects unsupported commands, extra envelope fields, unsafe maps and unbounded values', () => {
    expect(readMirrorAppRequest(request())).not.toBeNull()
    for (const patch of [
      { command: 'identity_sign' },
      { command: 'system.invoke' },
      { expectedRevision: NaN },
      { ownerEpoch: '' },
      { requestId: '__proto__' },
      { replayGeneration: '' },
      { replaySequence: -1 },
      { replaySequence: 0.5 },
      { replaySequence: Number.MAX_SAFE_INTEGER + 1 },
      { arbitrary: true },
      { args: JSON.parse('{"__proto__":{"injected":true}}') },
      { args: { value: Infinity } },
      { args: 'x'.repeat(262_145) },
    ])
      expect(readMirrorAppRequest({ ...request(), ...patch })).toBeNull()
    expect(
      readMirrorAppRequest(request({ args: Array(2049).fill(null) }))
    ).toBeNull()
    expect(
      readMirrorAppRequest(
        request({ args: Object.create({ inherited: true }) })
      )
    ).toBeNull()
  })

  test('snapshots are exact public projections and results cannot carry secret or native-path fields', () => {
    expect(
      readMirrorAppSnapshot({ ...initial, capabilities: [] })
    ).not.toBeNull()
    expect(
      readMirrorAppSnapshot({
        ...initial,
        capabilities: ['models.download'],
        password: 'secret',
      })
    ).toBeNull()
    expect(
      readMirrorAppSnapshot({ ...initial, phase: 'session', capabilities: [] })
    ).toBeNull()
    for (const key of [
      'edPrivHex',
      'x_priv_hex',
      'mnemonic',
      'password',
      'session_password',
      'credential',
      'token',
      'model_path',
      'mmprojPath',
      'app_log_path',
    ]) {
      expect(
        readMirrorAppResult({
          version: 1,
          requestId: 'one',
          ownerEpoch: 'owner-1',
          ok: true,
          value: { nested: { [key]: 'private' } },
        })
      ).toBeNull()
    }
  })
})

describe('desktop-owned companion app execution', () => {
  test('sustained PTT edges advance beyond the replay window without reopening old writes', async () => {
    const app = createMirrorAppRuntime()
    app.setSnapshot({
      ...initial,
      phase: 'session',
      sessionActivationId: 'session-1',
    })
    const request = requestFor(app)
    const write = vi.fn()
    app.register('session.control', {
      parse: (args) => args,
      mutates: true,
      requiresSession: true,
      execute: async (args, context) => {
        await context.commit(() => write(args))
        return { accepted: true }
      },
    })
    const first = request({
      command: 'session.control',
      sessionActivationId: 'session-1',
      args: { type: 'ptt', active: true },
    })
    for (let index = 0; index < MIRROR_APP_REPLAY_WINDOW + 512; index++) {
      const input =
        index === 0
          ? first
          : request({
              requestId: `ptt-${index}`,
              command: 'session.control',
              sessionActivationId: 'session-1',
              args: { type: 'ptt', active: index % 2 === 0 },
            })
      expect(await app.handle(input, 'one', () => true)).toMatchObject({
        ok: true,
      })
    }
    expect(write).toHaveBeenCalledTimes(MIRROR_APP_REPLAY_WINDOW + 512)
    expect(await app.handle(first, 'new-controller', () => true)).toMatchObject(
      { error: 'expired' }
    )
    expect(write).toHaveBeenCalledTimes(MIRROR_APP_REPLAY_WINDOW + 512)
    const oldGeneration = app.getSnapshot()!.replayGeneration
    app.reset()
    app.setSnapshot(initial)
    expect(app.getSnapshot()!.replayGeneration).not.toBe(oldGeneration)
    expect(await app.handle(first, 'new-controller', () => true)).toMatchObject(
      { error: 'expired' }
    )
    expect(write).toHaveBeenCalledTimes(MIRROR_APP_REPLAY_WINDOW + 512)
  })

  test('sequence collisions, bounded gaps and out-of-order arrivals fail closed', async () => {
    const app = createMirrorAppRuntime()
    app.setSnapshot(initial)
    const request = requestFor(app)
    const execute = vi.fn(() => ({}))
    app.register('home.read', { parse: () => ({}), execute })
    const first = request({ command: 'home.read', args: {} })
    expect(await app.handle(first, 'one', () => true)).toMatchObject({
      ok: true,
    })
    expect(
      await app.handle({ ...first, requestId: 'collision' }, 'one', () => true)
    ).toMatchObject({ error: 'request_conflict' })
    expect(
      await app.handle({ ...first, replaySequence: 1 }, 'one', () => true)
    ).toMatchObject({ error: 'request_conflict' })
    expect(
      await app.handle(
        {
          ...first,
          requestId: 'jump',
          replaySequence: MIRROR_APP_REPLAY_WINDOW + 1,
        },
        'one',
        () => true
      )
    ).toMatchObject({ error: 'invalid_request' })
    for (const sequence of [2, 1])
      expect(
        await app.handle(
          request({
            command: 'home.read',
            args: {},
            requestId: `gap-${sequence}`,
            replaySequence: sequence,
          }),
          'one',
          () => true
        )
      ).toMatchObject({ ok: true })
    expect(execute).toHaveBeenCalledTimes(3)
    expect(app.getSnapshot()?.replayNextSequence).toBe(3)
  })

  test('a committed in-flight write and its lost ACK survive window retirement, session rotation and controller replacement', async () => {
    const app = createMirrorAppRuntime()
    app.setSnapshot(initial)
    const request = requestFor(app)
    const disk = deferred<void>()
    let oldOwns = true
    const write = vi.fn(() => disk.promise)
    app.register('identity.rename', {
      parse: parseName,
      mutates: true,
      execute: async (_args, context) => {
        await context.commit(write)
        return { name: 'Bob' }
      },
    })
    app.register('home.read', { parse: () => ({}), execute: () => ({}) })
    const input = request()
    const pending = app.handle(input, 'old', () => oldOwns)
    await Promise.resolve()
    for (let index = 0; index < MIRROR_APP_REPLAY_WINDOW + 8; index++)
      expect(
        await app.handle(
          request({
            command: 'home.read',
            requestId: `read-${index}`,
            args: {},
          }),
          'old',
          () => oldOwns
        )
      ).toMatchObject({ ok: true })
    oldOwns = false
    app.retireController('old')
    app.setSnapshot({
      ...initial,
      phase: 'session',
      sessionActivationId: 'new-session',
      revision: 2,
    })
    const retry = app.handle(input, 'new', () => true)
    disk.resolve()
    expect(await retry).toEqual(await pending)
    expect(await app.handle(input, 'new', () => true)).toMatchObject({
      ok: true,
    })
    expect(write).toHaveBeenCalledOnce()
  })

  test('public snapshots do not retain mutable references to desktop identity objects', () => {
    const app = createMirrorAppRuntime()
    const identity = { edPubkeyHex: 'a'.repeat(64), displayName: 'Alice' }
    app.setSnapshot({ ...initial, identity })
    Object.assign(identity, { edPrivHex: 'private-desktop-key' })
    expect(app.getSnapshot()?.identity).toEqual(initial.identity)
    Object.assign(app.getSnapshot()!.identity!, { password: 'private' })
    expect(app.getSnapshot()?.identity).toEqual(initial.identity)
  })
  test('advertises only registered, parsed and currently available semantic commands', async () => {
    const app = createMirrorAppRuntime()
    const request = requestFor(app)
    app.setSnapshot(initial)
    expect(app.getSnapshot()?.capabilities).toEqual([])
    expect(await app.handle(request(), 'one', () => true)).toMatchObject({
      error: 'unsupported',
    })
    const execute = vi.fn(async () => ({ ok: true }))
    const unregister = app.register('identity.rename', {
      parse: parseName,
      execute,
    })
    expect(app.getSnapshot()?.capabilities).toEqual(['identity.rename'])
    expect(
      await app.handle(
        request({ args: { name: 'Bob', path: '/forbidden' } }),
        'one',
        () => true
      )
    ).toMatchObject({ error: 'invalid_request' })
    expect(execute).not.toHaveBeenCalled()
    unregister()
    app.register('models.benchmark', {
      parse: () => ({}),
      execute,
      requiresSession: true,
    })
    expect(app.getSnapshot()?.capabilities).toEqual([])
    app.register('engine.install', {
      parse: () => ({}),
      execute,
      available: () => false,
    })
    expect(app.getSnapshot()?.capabilities).toEqual([])
  })

  test.each(['owner', 'session', 'revision', 'controller'] as const)(
    '%s change while a port awaits prevents its actual write boundary',
    async (change) => {
      const app = createMirrorAppRuntime()
      const request = requestFor(app)
      app.setSnapshot(initial)
      const ready = deferred<void>()
      let owns = true
      const write = vi.fn()
      app.register('identity.rename', {
        parse: parseName,
        mutates: true,
        execute: async (_args, context) => {
          await ready.promise
          await context.commit(write)
          return {}
        },
      })
      const pending = app.handle(request(), 'one', () => owns)
      await Promise.resolve()
      if (change === 'owner')
        app.setSnapshot({ ...initial, ownerEpoch: 'owner-2' })
      else if (change === 'session')
        app.setSnapshot({
          ...initial,
          phase: 'session',
          sessionActivationId: 'session-2',
          revision: 2,
        })
      else if (change === 'revision')
        app.setSnapshot({ ...initial, revision: 2 })
      else {
        owns = false
        app.retireController('one')
      }
      ready.resolve()
      expect((await pending)?.ok).toBe(false)
      expect(write).not.toHaveBeenCalled()
    }
  )

  test('in-flight committed writes survive disconnect and deduplicate a lost ACK on the new controller', async () => {
    const app = createMirrorAppRuntime()
    const request = requestFor(app)
    app.setSnapshot(initial)
    const disk = deferred<void>()
    let oldOwns = true
    const write = vi.fn(() => disk.promise)
    app.register('identity.rename', {
      parse: parseName,
      mutates: true,
      execute: async (_args, context) => {
        await context.commit(write)
        return { name: 'Bob' }
      },
    })
    const first = app.handle(request(), 'old', () => oldOwns)
    await Promise.resolve()
    expect(write).toHaveBeenCalledOnce()
    oldOwns = false
    app.retireController('old')
    app.setSnapshot({ ...initial, revision: 2 })
    const retried = app.handle(request(), 'new', () => true)
    disk.resolve()
    expect(await first).toMatchObject({ ok: true, value: { name: 'Bob' } })
    expect(await retried).toEqual(await first)
    expect(await app.handle(request(), 'new', () => true)).toEqual(await first)
    expect(write).toHaveBeenCalledOnce()
    expect(
      await app.handle(request({ args: { name: 'Eve' } }), 'new', () => true)
    ).toMatchObject({ error: 'request_conflict' })
  })

  test('a prior controller cannot cancel the replacement controller operation', async () => {
    const app = createMirrorAppRuntime()
    const request = requestFor(app)
    app.setSnapshot(initial)
    const ready = deferred<void>()
    const write = vi.fn()
    app.register('identity.rename', {
      parse: parseName,
      mutates: true,
      execute: async (_args, context) => {
        await ready.promise
        await context.commit(write)
        return {}
      },
    })
    const pending = app.handle(request(), 'new', () => true)
    await Promise.resolve()
    app.retireController('old')
    ready.resolve()
    expect(await pending).toMatchObject({ ok: true })
    expect(write).toHaveBeenCalledOnce()
  })

  test('sensitive results and evicted ACKs are not replayed or re-executed', async () => {
    const app = createMirrorAppRuntime()
    const request = requestFor(app)
    app.setSnapshot(initial)
    const execute = vi.fn(async () => ({
      operationId: 'one-use-owner-operation',
    }))
    app.register('identity.prepare_recovery', {
      parse: () => ({}),
      sensitive: true,
      execute,
    })
    const input = request({ command: 'identity.prepare_recovery', args: {} })
    expect(await app.handle(input, 'one', () => true)).toMatchObject({
      ok: true,
    })
    expect(await app.handle(input, 'two', () => true)).toMatchObject({
      error: 'expired',
    })
    expect(execute).toHaveBeenCalledOnce()
    app.register('home.read', {
      parse: () => ({}),
      execute: () => ({ ready: true }),
    })
    for (let index = 0; index < 130; index++)
      await app.handle(
        request({ command: 'home.read', requestId: `read-${index}`, args: {} }),
        'one',
        () => true
      )
    expect(
      await app.handle(
        request({ command: 'home.read', requestId: 'read-0', args: {} }),
        'two',
        () => true
      )
    ).toMatchObject({ error: 'expired' })
  })

  test('a mutation cannot succeed without using the commit boundary, and native errors stay categorical', async () => {
    const app = createMirrorAppRuntime()
    const request = requestFor(app)
    app.setSnapshot(initial)
    app.register('identity.rename', {
      parse: parseName,
      mutates: true,
      execute: () => ({ name: 'Bob' }),
    })
    expect(await app.handle(request(), 'one', () => true)).toMatchObject({
      error: 'invalid_result',
    })
    app.register('home.read', {
      parse: () => ({}),
      execute: () => {
        throw new Error('/private/path/token=secret')
      },
    })
    const result = await app.handle(
      request({ command: 'home.read', requestId: 'read', args: {} }),
      'one',
      () => true
    )
    expect(result).toMatchObject({ error: 'failed' })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  test('retiring a session changes its activation and capabilities without discarding the app owner', () => {
    const app = createMirrorAppRuntime()
    app.setSnapshot({
      ...initial,
      phase: 'session',
      sessionActivationId: 'session-1',
    })
    app.register('session.control', {
      parse: () => ({}),
      execute: () => ({}),
      requiresSession: true,
    })
    expect(app.getSnapshot()?.capabilities).toEqual(['session.control'])
    app.retireSession()
    expect(app.getSnapshot()).toMatchObject({
      ownerEpoch: 'owner-1',
      revision: 2,
      phase: 'home',
      sessionActivationId: null,
      capabilities: [],
    })
  })

  test.each([false, true])(
    'a hung operation has a bounded reply and preserves deduplication after commit=%s',
    async (committed) => {
      vi.useFakeTimers()
      try {
        const app = createMirrorAppRuntime()
        const request = requestFor(app)
        app.setSnapshot(initial)
        const disk = deferred<void>()
        const write = vi.fn(() => disk.promise)
        app.register('identity.rename', {
          parse: parseName,
          mutates: true,
          execute: async (_args, context) => {
            if (committed) await context.commit(write)
            else {
              await disk.promise
              await context.commit(write)
            }
            return { name: 'Bob' }
          },
        })
        const pending = app.handle(request(), 'old', () => true)
        await vi.advanceTimersByTimeAsync(30_000)
        expect(await pending).toMatchObject({
          error: committed ? 'busy' : 'expired',
        })
        const retried = await app.handle(request(), 'new', () => true)
        expect(retried).toEqual(await pending)
        disk.resolve()
        await vi.advanceTimersByTimeAsync(0)
        if (committed) {
          expect(write).toHaveBeenCalledOnce()
          expect(await app.handle(request(), 'new', () => true)).toMatchObject({
            ok: true,
          })
        } else expect(write).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    }
  )
})
