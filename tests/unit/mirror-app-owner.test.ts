import { describe, expect, test, vi } from 'vitest'

import {
  createMirrorAppOwner,
  type MirrorOwnerSource,
} from '@/features/mirror/appOwner'
import {
  readHomeStart,
  readMirrorHome,
  registerMirrorHome,
  type MirrorHomeData,
} from '@/features/mirror/homeBridge'
import type { MirrorAppExecution } from '@/features/mirror/appRuntime'
import type { MirrorHomeStart } from '@/features/mirror/homeBridge'
import type { MirrorHost, MirrorHostOptions } from '@/features/mirror/runtime'

const identity = { edPubkeyHex: 'a'.repeat(64), displayName: 'Alice' }
const home: MirrorOwnerSource = {
  identity,
  phase: 'home',
  room: null,
  topic: null,
}
const data: MirrorHomeData = {
  friends: [],
  invites: [],
  interrupted: null,
  aiEnabled: false,
  savePending: false,
  rejoinDeadline: null,
  rosterReady: true,
  totalFriends: 0,
  offset: 0,
}
function fixture() {
  let sequence = 0
  let options!: MirrorHostOptions
  const host: MirrorHost = {
    start: vi.fn(async () => ({
      urls: ['https://127.0.0.1/'],
      password: 'local-test',
      certificateUrl: 'https://127.0.0.1/cert',
      generation: 'lease',
      fingerprint: 'test',
      expiresAt: Date.now() + 60_000,
    })),
    stop: vi.fn(async () => {}),
    retireSession: vi.fn(),
    publish: vi.fn(),
    setStreams: vi.fn(),
    sendNotification: vi.fn(),
    finishReport: vi.fn(async () => {}),
  }
  const registerReport = vi.fn(() => vi.fn())
  const owner = createMirrorAppOwner({
    id: () => `opaque-${++sequence}`,
    createHost: (input) => {
      options = input
      return host
    },
    registerReport,
  })
  return {
    owner,
    host,
    registerReport,
    connect: () => options.onConnected(true),
    disconnect: () => options.onConnected(false),
  }
}
async function enabled() {
  const f = fixture()
  f.owner.update(home)
  await f.owner.start()
  f.connect()
  return f
}

describe('app owner and real activation ownership', () => {
  test('explicit app opt-in survives Leave/Home and same-topic rejoin with a new opaque activation', async () => {
    const { owner, host, registerReport } = await enabled()
    expect(host.start).toHaveBeenCalledWith(null, 'app')
    const attach = owner.attach
    owner.update({
      ...home,
      phase: 'session',
      room: {},
      topic: 'private-topic',
    })
    const first = owner.getState().activationId
    expect(first).toBeTruthy()
    const control = vi.fn(() => true)
    const detach = owner.attach('private-topic', control)
    expect(registerReport).toHaveBeenLastCalledWith(
      'private-topic',
      host,
      first
    )
    owner.update({ ...home, phase: 'report', topic: 'private-topic' })
    detach()
    expect(host.retireSession).toHaveBeenCalledTimes(1)
    expect(owner.getState()).toMatchObject({
      enabled: true,
      connected: true,
      activationId: null,
    })
    expect(host.stop).not.toHaveBeenCalled()
    owner.update(home)
    owner.update({
      ...home,
      phase: 'session',
      room: {},
      topic: 'private-topic',
    })
    expect(owner.getState().activationId).not.toBe(first)
    expect(owner.attach).toBe(attach)
    await owner.stop()
    expect(owner.getState().enabled).toBe(false)
    expect(host.stop).toHaveBeenCalledOnce()
  })

  test('outage retires capture and scopes without releasing app capture ownership', async () => {
    const f = await enabled()
    f.owner.update({ ...home, phase: 'session', room: {}, topic: 'private' })
    const scope = f.owner.operationScope()
    scope.pinSession()
    expect(scope.isCurrent()).toBe(true)
    f.disconnect()
    expect(scope.signal.aborted).toBe(true)
    expect(scope.isCurrent()).toBe(false)
    expect(f.owner.getState()).toMatchObject({
      enabled: true,
      connected: false,
    })
    f.connect()
    expect(scope.isCurrent()).toBe(false)
    expect(f.owner.operationScope().isCurrent()).toBe(true)
  })

  test('session pinning cannot follow a later activation and stale controls never reach a new room', async () => {
    const f = await enabled()
    const scope = f.owner.operationScope()
    f.owner.update({ ...home, phase: 'session', room: {}, topic: 'first' })
    scope.pinSession()
    expect(scope.isCurrent()).toBe(true)
    f.owner.update(home)
    f.owner.update({ ...home, phase: 'session', room: {}, topic: 'second' })
    scope.pinSession()
    expect(scope.isCurrent()).toBe(false)
  })

  test('identity replacement revokes host and rotates owner epoch before another write', async () => {
    const f = await enabled()
    const epoch = f.owner.runtime.getSnapshot()!.ownerEpoch
    const scope = f.owner.operationScope()
    f.owner.update({
      ...home,
      identity: { edPubkeyHex: 'b'.repeat(64), displayName: 'Other' },
    })
    expect(scope.isCurrent()).toBe(false)
    expect(f.owner.getState().enabled).toBe(false)
    expect(f.host.stop).toHaveBeenCalledOnce()
    expect(f.owner.runtime.getSnapshot()!.ownerEpoch).not.toBe(epoch)
  })

  test('a committed room start retains its lost-ACK result and never repeats on the next Home activation', async () => {
    const f = await enabled()
    const invite = vi.fn(
      async (_args: MirrorHomeStart, context: MirrorAppExecution) =>
        context.commit(() => {
          f.owner.update({
            ...home,
            phase: 'session',
            room: {},
            topic: 'actual-topic',
          })
          return { accepted: true }
        })
    )
    registerMirrorHome(f.owner.runtime, {
      read: () => data,
      invite,
      accept: invite,
      rejoin: async (_, context) => context.commit(() => ({ accepted: true })),
      endInterrupted: async (context) =>
        context.commit(() => ({ accepted: true })),
    })
    const snapshot = f.owner.runtime.getSnapshot()!
    const request = {
      version: 1,
      requestId: 'lost-ack',
      ownerEpoch: snapshot.ownerEpoch,
      replayGeneration: snapshot.replayGeneration,
      replaySequence: snapshot.replayNextSequence,
      sessionActivationId: null,
      expectedRevision: snapshot.revision,
      command: 'home.invite',
      args: { id: 'b'.repeat(64), topic: null },
    }
    const result = await f.owner.runtime.handle(
      request,
      'controller',
      () => true
    )
    f.owner.update(home)
    expect(
      await f.owner.runtime.handle(request, 'new-controller', () => true)
    ).toEqual(result)
    expect(result).toMatchObject({ ok: true })
    expect(invite).toHaveBeenCalledOnce()
    expect(f.owner.runtime.getSnapshot()!.capabilities).not.toContain(
      'settings.update'
    )
  })
})

test('Home schemas reject unknown fields, paths, invalid topics and secret-bearing projections', () => {
  expect(
    readHomeStart({ id: 'friend', topic: null, invoke: 'identity_sign' })
  ).toBeNull()
  expect(readHomeStart({ id: '../file', topic: null })).toBeNull()
  expect(readHomeStart({ id: 'friend', topic: '  stale  ' })).toBeNull()
  expect(readMirrorHome({ ...data, password: 'secret' })).toBeNull()
  expect(
    readMirrorHome({
      ...data,
      friends: [
        {
          id: 'b'.repeat(64),
          displayName: 'Bob',
          presence: 'online',
          limited: false,
        },
      ],
    })
  ).toMatchObject({ friends: [{ displayName: 'Bob' }] })
})
