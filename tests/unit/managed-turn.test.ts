import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  brokerSigningBytes,
  type BrokerAccount,
  type BrokerAction,
  type BrokerSignedRequest,
  type BrokerStatus,
} from '../../services/turn-broker/protocol'
import { signMessage, verifyMessage } from '@/lib/crypto/identity'
import { bytesToHex, hexToBytes } from '@/lib/encoding'
import {
  MANAGED_TURN_BROKER_ORIGIN,
  ManagedTurnController,
  managedTurnLoginTicket,
} from '@/lib/managedTurn'
import { createManagedTurnPeerConnection } from '@/lib/webrtc/managedTurnPeerConnection'
import * as ed from '@noble/ed25519'

const privateKey = new Uint8Array(32).fill(7)
const publicKey = bytesToHex(ed.getPublicKey(privateKey))
const otherKey = 'bb'.repeat(32)
const linkedAccount: BrokerAccount = {
  provider: 'github',
  subject: '123',
  label: 'old-friend',
  approved: true,
}
const loginUrl = `${MANAGED_TURN_BROKER_ORIGIN}/oauth/start?ticket=${'a'.repeat(43)}`

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

class FakeConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = 'connected'
  updates: RTCConfiguration[] = []
  restarts = 0
  private config: RTCConfiguration
  constructor(config: RTCConfiguration) {
    super()
    this.config = config
  }
  getConfiguration() {
    return structuredClone(this.config)
  }
  setConfiguration(config: RTCConfiguration) {
    if (this.connectionState === 'closed') throw new Error('closed')
    this.config = structuredClone(config)
    this.updates.push(config)
  }
  restartIce() {
    this.restarts += 1
  }
  close() {
    this.connectionState = 'closed'
  }
}

function harness(initial: Partial<BrokerStatus> = {}) {
  let status: BrokerStatus = {
    providers: { github: true, google: true },
    links: [linkedAccount],
    approved: true,
    enabled: true,
    freeOnlyConfirmed: true,
    ...initial,
  }
  let issued = 0
  const calls: { action: string; body: Record<string, unknown> }[] = []
  const overrides = new Map<
    string,
    (body: Record<string, unknown>) => unknown | Promise<unknown>
  >()
  const fetcher: typeof fetch = async (input, init) => {
    expect(init?.credentials).toBe('omit')
    expect(init?.redirect).toBe('error')
    expect(init?.cache).toBe('no-store')
    const action = new URL(String(input)).pathname.split('/').at(-1)!
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ action, body })
    if (action === 'challenge') {
      return Response.json({
        nonce: 'n'.repeat(43),
        expiresAt: Date.now() + 60_000,
      })
    }
    const signed = body as BrokerSignedRequest
    if (signed.publicKey === publicKey) {
      expect(
        verifyMessage(
          hexToBytes(publicKey),
          brokerSigningBytes(
            MANAGED_TURN_BROKER_ORIGIN,
            action as BrokerAction,
            publicKey,
            signed,
            signed.payload
          ),
          hexToBytes(signed.signature)
        )
      ).toBe(true)
    }
    const override = overrides.get(action)
    if (override) return Response.json(await override(body))
    if (action === 'status') return Response.json(status)
    if (action === 'credentials') {
      issued += 1
      return Response.json({
        iceServers: [
          {
            urls: ['turns:turn.cloudflare.com:443?transport=tcp'],
            username: `temporary-${issued}`,
            credential: `ephemeral-secret-${issued}`,
          },
        ],
        expiresAt: Date.now() + 60 * 60_000,
      })
    }
    if (action === 'login')
      return Response.json({
        transactionId: 'login-transaction',
        url: loginUrl,
        expiresAt: Date.now() + 600_000,
      })
    if (action === 'poll')
      return Response.json({
        state: 'ready',
        account: linkedAccount,
        expiresAt: Date.now() + 600_000,
      })
    if (action === 'confirm') return Response.json(status)
    if (action === 'unlink') {
      status = { ...status, links: [], approved: false }
      return Response.json(status)
    }
    throw new Error('unexpected request')
  }
  const controller = new ManagedTurnController({
    fetch: fetcher,
    sign: async (message) => signMessage(privateKey, message),
  })
  const connect = async () => {
    controller.setIdentity(publicKey)
    controller.setEnabled(true)
    await controller.refreshStatus()
    await controller.refreshCredentials()
  }
  return {
    controller,
    calls,
    overrides,
    connect,
    setStatus: (next: BrokerStatus) => {
      status = next
    },
  }
}

const controllers: ManagedTurnController[] = []

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-21T00:00:00Z') })
})
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  vi.useRealTimers()
})

function setup(initial?: Partial<BrokerStatus>) {
  const result = harness(initial)
  controllers.push(result.controller)
  return result
}

describe('optional relay identity and OAuth lifecycle', () => {
  test('existing local identities make no request until explicit per-identity opt-in', async () => {
    const { controller, calls } = setup()
    controller.setIdentity(publicKey.toUpperCase())
    await controller.refreshStatus()
    await controller.refreshCredentials()
    expect(calls).toEqual([])
    expect(controller.getSnapshot().identityEdPubkeyHex).toBe(publicKey)
    controller.setEnabled(true)
    await controller.refreshStatus()
    await controller.refreshCredentials()
    expect(calls.map((call) => call.action)).toEqual([
      'challenge',
      'status',
      'challenge',
      'credentials',
    ])
    expect(controller.getIceServers()).toHaveLength(1)
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(
      'ephemeral-secret'
    )
    controller.setIdentity(otherKey)
    expect(controller.getIceServers()).toEqual([])
    await controller.refreshStatus()
    expect(calls).toHaveLength(4)
  })

  test.each([
    { approved: false },
    { enabled: false },
    { freeOnlyConfirmed: false },
  ])('no credential issuance when server policy is %j', async (policy) => {
    const { controller, calls, connect } = setup(policy)
    await connect()
    expect(controller.getIceServers()).toEqual([])
    expect(calls.some((call) => call.action === 'credentials')).toBe(false)
  })

  test('provider success requires an explicit identity-bound confirmation', async () => {
    const { controller, calls, connect, setStatus } = setup({
      links: [],
      approved: false,
      enabled: false,
    })
    await connect()
    expect(await controller.startLogin('github')).toBe(loginUrl)
    await controller.pollLogin()
    expect(controller.getSnapshot().status).toBe('confirm')
    expect(controller.getSnapshot().accounts).toEqual([])
    expect(calls.some((call) => call.action === 'confirm')).toBe(false)
    setStatus({
      providers: { github: true, google: true },
      links: [linkedAccount],
      approved: true,
      enabled: false,
      freeOnlyConfirmed: false,
    })
    await controller.confirmLogin()
    const confirmation = calls.find((call) => call.action === 'confirm')!
    expect(confirmation.body.publicKey).toBe(publicKey)
    expect(confirmation.body.payload).toEqual({
      transactionId: 'login-transaction',
      provider: 'github',
      subject: '123',
    })
    expect(controller.getSnapshot().status).toBe('linked')
    expect(controller.getIceServers()).toEqual([])
  })

  test('cancelling an in-flight browser login cannot resurrect it', async () => {
    const { controller, connect, overrides } = setup({ enabled: false })
    await connect()
    const login = deferred<unknown>()
    const entered = deferred<void>()
    overrides.set('login', async () => {
      entered.resolve()
      return login.promise
    })
    const pending = controller.startLogin('google').catch(() => {})
    await entered.promise
    controller.cancelLogin()
    login.resolve({
      transactionId: 'late',
      url: loginUrl,
      expiresAt: Date.now() + 600_000,
    })
    await pending
    expect(controller.getSnapshot().login).toBeNull()
    expect(controller.getSnapshot().status).toBe('linked')
  })

  test('late responses and signatures cannot disclose or restore a replaced identity', async () => {
    const { controller, calls, connect, overrides } = setup({ enabled: false })
    await connect()
    const response = deferred<unknown>()
    const entered = deferred<void>()
    overrides.set('status', async () => {
      entered.resolve()
      return response.promise
    })
    const pending = controller.refreshStatus().catch(() => {})
    await entered.promise
    controller.setIdentity(otherKey)
    const count = calls.length
    response.resolve({
      providers: { github: true, google: true },
      links: [linkedAccount],
      approved: true,
      enabled: true,
      freeOnlyConfirmed: true,
    })
    await pending
    expect(controller.getSnapshot().identityEdPubkeyHex).toBe(otherKey)
    expect(controller.getSnapshot().accounts).toEqual([])
    expect(controller.getIceServers()).toEqual([])
    expect(calls).toHaveLength(count)
  })

  test('an in-flight keychain signature cannot authenticate a superseded identity', async () => {
    const signed = deferred<Uint8Array>()
    const entered = deferred<void>()
    const calls: string[] = []
    const controller = new ManagedTurnController({
      fetch: async (input) => {
        calls.push(String(input))
        return Response.json({
          nonce: 'x'.repeat(43),
          expiresAt: Date.now() + 60_000,
        })
      },
      sign: async () => {
        entered.resolve()
        return signed.promise
      },
    })
    controllers.push(controller)
    controller.setIdentity(publicKey)
    controller.setEnabled(true)
    const pending = controller.refreshStatus().catch(() => {})
    await entered.promise
    controller.setIdentity(otherKey)
    signed.resolve(new Uint8Array(64))
    await pending
    expect(calls).toEqual([`${MANAGED_TURN_BROKER_ORIGIN}/v1/challenge`])
    expect(controller.getSnapshot().status).toBe('idle')
  })

  test('only the exact fixed-origin browser ticket URL is accepted', () => {
    expect(managedTurnLoginTicket(loginUrl)).toBe('a'.repeat(43))
    for (const raw of [
      loginUrl + '&token=secret',
      loginUrl + '#fragment',
      loginUrl.replace('/oauth/start', '/other'),
      loginUrl.replace('studyvis-turn.', 'evil.'),
      loginUrl.replace('https:', 'http:'),
      loginUrl.replace('https://', 'https://user@'),
    ]) {
      expect(managedTurnLoginTicket(raw)).toBeNull()
    }
  })
})

describe('temporary credentials and active peer configurations', () => {
  test('never suppresses issuance and immediately removes managed credentials', async () => {
    const { controller, calls, connect } = setup()
    controller.setPreference('never')
    await connect()
    expect(calls.some((call) => call.action === 'credentials')).toBe(false)
    controller.setPreference('auto')
    await controller.refreshCredentials()
    expect(controller.getIceServers()).toHaveLength(1)
    controller.setPreference('never')
    expect(controller.getIceServers()).toEqual([])
  })

  test('policy revocation is effective during synchronous status notifications', async () => {
    const { controller, connect, overrides } = setup()
    await connect()
    expect(controller.getIceServers()).toHaveLength(1)
    const observed: RTCIceServer[][] = []
    controller.subscribe(() => {
      if (!controller.getSnapshot().approved)
        observed.push(controller.getIceServers())
    })
    overrides.set('status', () => ({
      providers: { github: true, google: true },
      links: [],
      approved: false,
      enabled: false,
      freeOnlyConfirmed: true,
    }))
    await controller.refreshStatus()
    expect(observed).toEqual([[]])
    expect(controller.getIceServers()).toEqual([])
  })

  test('a warm pool using its old config receives current credentials; live peers rotate without restart', async () => {
    const { controller, connect } = setup()
    const Constructor = createManagedTurnPeerConnection(
      FakeConnection as unknown as typeof RTCPeerConnection,
      controller
    )
    const stun = { urls: 'stun:stun.example.test:3478' }
    const custom = {
      urls: 'turn:own.example.test:3478',
      username: 'own',
      credential: 'own-secret',
    }
    const poolConfig = {
      iceServers: [stun, custom],
      iceTransportPolicy: 'all' as const,
    }
    const before = new Constructor(poolConfig) as unknown as FakeConnection
    await connect()
    expect(before.getConfiguration().iceServers).toEqual([
      stun,
      custom,
      ...controller.getIceServers(),
    ])
    const peer = new Constructor(poolConfig) as unknown as FakeConnection
    const first = controller.getIceServers()[0]
    await vi.advanceTimersByTimeAsync(50 * 60_000)
    const next = controller.getIceServers()[0]
    expect(next.username).not.toBe(first.username)
    expect(peer.getConfiguration()).toEqual({
      ...poolConfig,
      iceServers: [stun, custom, next],
    })
    expect(before.getConfiguration().iceServers).toEqual([stun, custom, next])
    expect(peer.restarts).toBe(0)
    expect(before.restarts).toBe(0)
    expect(poolConfig.iceServers).toEqual([stun, custom])
    controller.setPreference('never')
    expect(peer.getConfiguration().iceServers).toEqual([stun, custom])
  })

  test('managed servers never participate in a user-owned relay-only configuration', async () => {
    const { controller, connect } = setup()
    await connect()
    const Constructor = createManagedTurnPeerConnection(
      FakeConnection as unknown as typeof RTCPeerConnection,
      controller
    )
    const custom = {
      urls: 'turn:own.example.test:3478',
      username: 'u',
      credential: 'c',
    }
    const peer = new Constructor({
      iceServers: [custom],
      iceTransportPolicy: 'relay',
    }) as unknown as FakeConnection
    expect(peer.getConfiguration().iceServers).toEqual([custom])
    await controller.refreshCredentials()
    expect(peer.getConfiguration().iceServers).toEqual([custom])
    const managed = new Constructor({}) as unknown as FakeConnection
    expect(managed.getConfiguration().iceTransportPolicy).toBeUndefined()
  })

  test('expired leases cannot be used after a suspended timer or renewal outage', async () => {
    const { controller, connect, overrides } = setup()
    await connect()
    overrides.set('credentials', () => {
      throw new Error('upstream body with secret must not escape')
    })
    vi.setSystemTime(Date.now() + 61 * 60_000)
    expect(controller.getIceServers()).toEqual([])
    await expect(controller.refreshCredentials()).rejects.toThrow('unavailable')
    expect(controller.getSnapshot().error).toBe('unavailable')
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(
      'upstream body'
    )
  })

  test('unlink blocks a late credential renewal', async () => {
    const { controller, connect, overrides } = setup()
    await connect()
    const response = deferred<unknown>()
    const entered = deferred<void>()
    overrides.set('credentials', async () => {
      entered.resolve()
      return response.promise
    })
    const pending = controller.refreshCredentials()
    await entered.promise
    await controller.unlink('github', '123')
    response.resolve({
      iceServers: [
        {
          urls: ['turns:turn.cloudflare.com:443?transport=tcp'],
          username: 'late',
          credential: 'late-secret',
        },
      ],
      expiresAt: Date.now() + 3_600_000,
    })
    await pending
    expect(controller.getSnapshot().approved).toBe(false)
    expect(controller.getIceServers()).toEqual([])
  })

  test('an old status response cannot reauthorize a successfully unlinked account', async () => {
    const { controller, connect, overrides, calls } = setup()
    await connect()
    const response = deferred<unknown>()
    const entered = deferred<void>()
    overrides.set('status', async () => {
      entered.resolve()
      return response.promise
    })
    const pending = controller.refreshStatus()
    await entered.promise
    await controller.unlink('github', '123')
    const count = calls.length
    response.resolve({
      providers: { github: true, google: true },
      links: [linkedAccount],
      approved: true,
      enabled: true,
      freeOnlyConfirmed: true,
    })
    await pending
    expect(controller.getSnapshot().approved).toBe(false)
    expect(controller.getSnapshot().accounts).toEqual([])
    expect(controller.getIceServers()).toEqual([])
    expect(calls).toHaveLength(count)
  })

  test('status started during unlink cannot restore the removed account after commit', async () => {
    const { controller, connect, overrides, calls } = setup()
    await connect()
    const unlinkResponse = deferred<unknown>()
    const unlinkEntered = deferred<void>()
    const statusResponse = deferred<unknown>()
    const statusEntered = deferred<void>()
    overrides.set('unlink', async () => {
      unlinkEntered.resolve()
      return unlinkResponse.promise
    })
    overrides.set('status', async () => {
      statusEntered.resolve()
      return statusResponse.promise
    })
    const unlink = controller.unlink('github', '123')
    await unlinkEntered.promise
    const staleStatus = controller.refreshStatus()
    await statusEntered.promise
    unlinkResponse.resolve({
      providers: { github: true, google: true },
      links: [],
      approved: false,
      enabled: true,
      freeOnlyConfirmed: true,
    })
    await unlink
    const count = calls.length
    statusResponse.resolve({
      providers: { github: true, google: true },
      links: [linkedAccount],
      approved: true,
      enabled: true,
      freeOnlyConfirmed: true,
    })
    await staleStatus
    expect(controller.getSnapshot().accounts).toEqual([])
    expect(controller.getSnapshot().approved).toBe(false)
    expect(controller.getIceServers()).toEqual([])
    expect(calls).toHaveLength(count)
  })

  test('status started during confirmation cannot erase the confirmed link after commit', async () => {
    const { controller, connect, overrides } = setup({
      links: [],
      approved: false,
      enabled: false,
    })
    await connect()
    await controller.startLogin('github')
    await controller.pollLogin()
    const confirmResponse = deferred<unknown>()
    const confirmEntered = deferred<void>()
    const statusResponse = deferred<unknown>()
    const statusEntered = deferred<void>()
    overrides.set('confirm', async () => {
      confirmEntered.resolve()
      return confirmResponse.promise
    })
    overrides.set('status', async () => {
      statusEntered.resolve()
      return statusResponse.promise
    })
    const confirmation = controller.confirmLogin()
    await confirmEntered.promise
    const staleStatus = controller.refreshStatus()
    await statusEntered.promise
    confirmResponse.resolve({
      providers: { github: true, google: true },
      links: [linkedAccount],
      approved: true,
      enabled: false,
      freeOnlyConfirmed: false,
    })
    await confirmation
    statusResponse.resolve({
      providers: { github: true, google: true },
      links: [],
      approved: false,
      enabled: false,
      freeOnlyConfirmed: false,
    })
    await staleStatus
    expect(controller.getSnapshot().accounts).toEqual([linkedAccount])
    expect(controller.getSnapshot().approved).toBe(true)
    expect(controller.getSnapshot().status).toBe('linked')
    expect(controller.getSnapshot().login).toBeNull()
  })

  test('native close without an event releases the warm peer from future updates', async () => {
    const { controller, connect } = setup()
    const Constructor = createManagedTurnPeerConnection(
      FakeConnection as unknown as typeof RTCPeerConnection,
      controller
    )
    const peer = new Constructor({}) as unknown as FakeConnection
    const getConfig = vi.spyOn(peer, 'getConfiguration')
    peer.close()
    await connect()
    expect(getConfig).not.toHaveBeenCalled()
    expect(peer.updates).toEqual([])
  })

  test('credential responses cannot redirect the client to an arbitrary TURN host', async () => {
    const { controller, connect, overrides } = setup({ enabled: false })
    await connect()
    overrides.set('credentials', () => ({
      iceServers: [
        {
          urls: ['turn:attacker.test:3478?transport=udp'],
          username: 'u',
          credential: 'c',
        },
      ],
      expiresAt: Date.now() + 3_600_000,
    }))
    overrides.set('status', () => ({
      providers: { github: true, google: true },
      links: [linkedAccount],
      approved: true,
      enabled: true,
      freeOnlyConfirmed: true,
    }))
    await controller.refreshStatus()
    await expect(controller.refreshCredentials()).rejects.toThrow(
      'invalid_response'
    )
    expect(controller.getIceServers()).toEqual([])
  })
})
