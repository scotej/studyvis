/// <reference types="node" />

import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  brokerSigningBytes,
  canonicalBrokerJson,
  type BrokerAction,
  type BrokerChallenge,
  type BrokerLogin,
  type BrokerProvider,
  type JsonObject,
} from '../../services/turn-broker/protocol'
import worker, {
  TurnBroker,
  type BrokerEnv,
  type BrokerSql,
  type BrokerState,
} from '../../services/turn-broker/worker'

const ORIGIN = 'https://studyvis-turn.example.workers.dev'
const NOW = Date.parse('2026-10-21T10:00:00Z')
const TURN_KEY_ID = 'a'.repeat(32)
const databases: DatabaseSync[] = []

function hex(input: ArrayBuffer): string {
  return Buffer.from(input).toString('hex')
}

async function identity() {
  const keys = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicKey = hex(await crypto.subtle.exportKey('raw', keys.publicKey))
  return {
    publicKey,
    sign: async (data: Uint8Array<ArrayBuffer>) =>
      hex(await crypto.subtle.sign('Ed25519', keys.privateKey, data)),
  }
}

function storage(): BrokerState {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql: BrokerSql = {
    exec<T extends Record<string, unknown>>(
      query: string,
      ...values: unknown[]
    ): Iterable<T> {
      if (
        !values.length &&
        query.trim().split(';').filter(Boolean).length > 1
      ) {
        db.exec(query)
        return []
      }
      return db.prepare(query).all(...(values as SQLInputValue[])) as T[]
    },
  }
  return {
    storage: {
      sql,
      transactionSync<T>(callback: () => T): T {
        db.exec('SAVEPOINT test_transaction')
        try {
          const result = callback()
          db.exec('RELEASE test_transaction')
          return result
        } catch (error) {
          db.exec('ROLLBACK TO test_transaction; RELEASE test_transaction')
          throw error
        }
      },
      setAlarm: vi.fn(async () => undefined),
    },
  }
}

type TestIdentity = Awaited<ReturnType<typeof identity>>

function harness(overrides: Partial<BrokerEnv> = {}, fetcher?: typeof fetch) {
  let now = NOW
  const env: BrokerEnv = {
    BROKER_ORIGIN: ORIGIN,
    RATE_LIMIT_SECRET: 'test-rate-secret-'.repeat(4),
    GITHUB_CLIENT_ID: 'github-id',
    GITHUB_CLIENT_SECRET: 'github-secret',
    GOOGLE_CLIENT_ID: 'google-id',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    TURN_KEY_ID,
    TURN_KEY_API_TOKEN: 'dedicated-turn-secret',
    APPROVED_ACCOUNTS: JSON.stringify({
      'github:123': NOW + 86_400_000,
      'google:456': NOW + 86_400_000,
    }),
    ...overrides,
  }
  const fetchMock = vi.fn(
    fetcher ??
      (async (input) => {
        const url = String(input)
        if (url === 'https://github.com/login/oauth/access_token')
          return Response.json({ access_token: 'gho_test-access-token' })
        if (url === 'https://api.github.com/user')
          return Response.json({ id: 123, login: 'study-friend', type: 'User' })
        if (url.includes('generate-ice-servers'))
          return Response.json(
            {
              iceServers: [
                { urls: ['stun:stun.cloudflare.com:3478'] },
                {
                  urls: [
                    'turn:turn.cloudflare.com:3478?transport=udp',
                    'turns:turn.cloudflare.com:443?transport=tcp',
                  ],
                  username: 'test-username',
                  credential: 'test-credential',
                },
              ],
            },
            { status: 201 }
          )
        if (url.endsWith('/revoke')) return new Response(null, { status: 204 })
        throw new Error('unexpected egress')
      })
  )
  const state = storage()
  const createBroker = () =>
    new TurnBroker(state, env, {
      fetch: fetchMock as typeof fetch,
      now: () => now,
    })
  let broker = createBroker()
  const request = (path: string, init: RequestInit = {}, ip = '192.0.2.1') =>
    broker.fetch(
      new Request(`${ORIGIN}${path}`, {
        ...init,
        headers: { 'CF-Connecting-IP': ip, ...init.headers },
      })
    )
  const post = (path: string, body: unknown, ip?: string) =>
    request(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      ip
    )
  const envelope = async (
    who: TestIdentity,
    action: BrokerAction,
    payload: JsonObject = {}
  ) => {
    const challenge = (await (
      await post('/v1/challenge', { publicKey: who.publicKey, action })
    ).json()) as BrokerChallenge
    const signature = await who.sign(
      brokerSigningBytes(ORIGIN, action, who.publicKey, challenge, payload)
    )
    return { ...challenge, publicKey: who.publicKey, payload, signature }
  }
  const signed = async (
    who: TestIdentity,
    action: BrokerAction,
    payload: JsonObject = {}
  ) => post(`/v1/${action}`, await envelope(who, action, payload))
  const begin = async (
    who: TestIdentity,
    selected: BrokerProvider = 'github'
  ) => {
    const loginResponse = await signed(who, 'login', { provider: selected })
    expect(loginResponse.status).toBe(200)
    const login = (await loginResponse.json()) as BrokerLogin
    const start = await request(
      new URL(login.url).pathname + new URL(login.url).search
    )
    expect(start.status).toBe(302)
    const authorization = new URL(start.headers.get('Location')!)
    const cookie = start.headers.get('Set-Cookie')!.split(';')[0]
    return { login, authorization, cookie }
  }
  const callback = (
    flow: Awaited<ReturnType<typeof begin>>,
    selected: BrokerProvider = 'github',
    cookie = flow.cookie
  ) =>
    request(
      `/oauth/callback/${selected}?state=${flow.authorization.searchParams.get('state')}&code=test-code`,
      { headers: { Cookie: cookie } }
    )
  const enroll = async (who: TestIdentity) => {
    const flow = await begin(who)
    expect((await callback(flow)).status).toBe(200)
    const response = await signed(who, 'confirm', {
      transactionId: flow.login.transactionId,
      provider: 'github',
      subject: '123',
    })
    expect(response.status).toBe(200)
    return response.json()
  }
  return {
    env,
    state,
    get broker() {
      return broker
    },
    post,
    request,
    signed,
    envelope,
    begin,
    callback,
    enroll,
    fetchMock,
    restart: () => {
      broker = createBroker()
    },
    setNow: (value: number) => {
      now = value
    },
  }
}

function heldIssuance(h: ReturnType<typeof harness>) {
  let started!: () => void
  let release!: (response: Response) => void
  const arrived = new Promise<void>((resolve) => {
    started = resolve
  })
  const response = new Promise<Response>((resolve) => {
    release = resolve
  })
  h.fetchMock.mockImplementationOnce(async (input) => {
    expect(String(input)).toContain('generate-ice-servers')
    started()
    return response
  })
  return {
    arrived,
    release: () =>
      release(
        Response.json({
          iceServers: [
            {
              urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
              username: 'raced-username',
              credential: 'raced-credential',
            },
          ],
        })
      ),
  }
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

describe('TURN broker identity authorization', () => {
  it('uses deterministic payload bytes and separates action and deployment audiences', () => {
    expect(canonicalBrokerJson({ z: [1, true], a: { b: 'value' } })).toBe(
      '{"a":{"b":"value"},"z":[1,true]}'
    )
    expect(() => canonicalBrokerJson(Number.NaN)).toThrow()
    const challenge = { nonce: 'n', expiresAt: NOW }
    expect(
      brokerSigningBytes(ORIGIN, 'status', 'key', challenge, {})
    ).not.toEqual(
      brokerSigningBytes(ORIGIN, 'credentials', 'key', challenge, {})
    )
    expect(
      brokerSigningBytes(ORIGIN, 'status', 'key', challenge, {})
    ).not.toEqual(
      brokerSigningBytes(
        'https://other.example',
        'status',
        'key',
        challenge,
        {}
      )
    )
  })

  it('consumes a nonce exactly once under concurrent replay', async () => {
    const h = harness()
    const who = await identity()
    const body = await h.envelope(who, 'status')
    const responses = await Promise.all([
      h.post('/v1/status', body),
      h.post('/v1/status', body),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 401,
    ])
    expect(h.fetchMock).not.toHaveBeenCalled()
  })

  it('rejects tampering, wrong action, IP changes and expired challenges', async () => {
    const h = harness()
    const who = await identity()
    const body = await h.envelope(who, 'status')
    expect(
      (await h.post('/v1/status', { ...body, payload: { provider: 'github' } }))
        .status
    ).toBe(401)
    expect((await h.post('/v1/credentials', body)).status).toBe(401)
    expect((await h.post('/v1/status', body, '192.0.2.2')).status).toBe(401)
    const wrongAudience = await who.sign(
      brokerSigningBytes(
        'https://another.example',
        'status',
        who.publicKey,
        body,
        {}
      )
    )
    expect(
      (await h.post('/v1/status', { ...body, signature: wrongAudience })).status
    ).toBe(401)
    h.setNow(NOW + 60_001)
    expect((await h.post('/v1/status', body)).status).toBe(401)
  })

  it('fails closed when rate privacy secret is missing and bounds input', async () => {
    const h = harness({ RATE_LIMIT_SECRET: '' })
    expect(
      (
        await h.post('/v1/challenge', {
          publicKey: 'a'.repeat(64),
          action: 'status',
        })
      ).status
    ).toBe(503)
    const valid = harness()
    expect(
      (
        await valid.post('/v1/challenge', {
          publicKey: 'a'.repeat(64),
          action: 'status',
          extra: 'x'.repeat(4096),
        })
      ).status
    ).toBe(400)
    expect(
      (
        await valid.post('/v1/challenge', {
          publicKey: 'a'.repeat(64),
          action: 'status',
          extra: true,
        })
      ).status
    ).toBe(400)
  })
})

describe('TURN broker OAuth account linking', () => {
  it('binds a one-use browser ticket to cookie, provider, PKCE and explicit signed subject confirmation', async () => {
    const h = harness()
    const who = await identity()
    const flow = await h.begin(who)
    expect(flow.authorization.origin).toBe('https://github.com')
    expect(flow.authorization.searchParams.get('code_challenge_method')).toBe(
      'S256'
    )
    expect(flow.authorization.searchParams.get('scope')).toBeNull()
    expect(flow.authorization.searchParams.get('redirect_uri')).toBe(
      `${ORIGIN}/oauth/callback/github`
    )
    expect(
      (
        await h.request(
          new URL(flow.login.url).pathname + new URL(flow.login.url).search
        )
      ).status
    ).toBe(401)
    expect((await h.callback(flow, 'google')).status).toBe(401)
    expect((await h.callback(flow, 'github', '')).status).toBe(401)
    expect(h.fetchMock).not.toHaveBeenCalled()
    expect((await h.callback(flow)).status).toBe(200)
    expect((await h.callback(flow)).status).toBe(401)
    const initial = await (await h.signed(who, 'status')).json()
    expect(initial.links).toEqual([])
    const poll = await (
      await h.signed(who, 'poll', { transactionId: flow.login.transactionId })
    ).json()
    expect(poll).toMatchObject({
      state: 'ready',
      account: { provider: 'github', subject: '123', approved: true },
    })
    expect(
      (
        await h.signed(who, 'confirm', {
          transactionId: flow.login.transactionId,
          provider: 'github',
          subject: '999',
        })
      ).status
    ).toBe(401)
    const confirmed = await (
      await h.signed(who, 'confirm', {
        transactionId: flow.login.transactionId,
        provider: 'github',
        subject: '123',
      })
    ).json()
    expect(confirmed).toMatchObject({
      approved: true,
      links: [{ provider: 'github', subject: '123' }],
    })
    expect(
      h.fetchMock.mock.calls.every(([, init]) => init?.redirect === 'error')
    ).toBe(true)
    const tokenCall = h.fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/access_token')
    )!
    const tokenBody = tokenCall[1]?.body as URLSearchParams
    const expectedChallenge = Buffer.from(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(tokenBody.get('code_verifier')!)
      )
    ).toString('base64url')
    expect(expectedChallenge).toBe(
      flow.authorization.searchParams.get('code_challenge')
    )
  })

  it('never silently moves an OAuth account to another local identity', async () => {
    const h = harness()
    const first = await identity()
    const second = await identity()
    await h.enroll(first)
    const flow = await h.begin(second)
    await h.callback(flow)
    expect(
      (
        await h.signed(first, 'confirm', {
          transactionId: flow.login.transactionId,
          provider: 'github',
          subject: '123',
        })
      ).status
    ).toBe(401)
    expect(
      (
        await h.signed(second, 'confirm', {
          transactionId: flow.login.transactionId,
          provider: 'github',
          subject: '123',
        })
      ).status
    ).toBe(409)
    expect((await (await h.signed(first, 'status')).json()).links).toHaveLength(
      1
    )
    expect((await (await h.signed(second, 'status')).json()).links).toEqual([])
  })

  it('exchanges a browser authorization code once when callbacks race', async () => {
    const h = harness()
    const who = await identity()
    const flow = await h.begin(who)
    const responses = await Promise.all([h.callback(flow), h.callback(flow)])
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 401,
    ])
    expect(
      h.fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/access_token')
      )
    ).toHaveLength(1)
  })

  it('verifies Google ID-token signatures and links opaque subjects after confirmation', async () => {
    const keys = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify']
    )) as CryptoKeyPair
    const jwk = {
      ...(await crypto.subtle.exportKey('jwk', keys.publicKey)),
      kid: 'test-google-key',
      alg: 'RS256',
      use: 'sig',
    }
    let nonce = ''
    const claims: Record<string, unknown> = {
      iss: 'https://accounts.google.com',
      aud: 'google-id',
      sub: 'opaque:stable-google-subject',
      email: 'friend@example.com',
      email_verified: true,
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
    }
    const fetcher = async (input: RequestInfo | URL) => {
      if (String(input) === 'https://www.googleapis.com/oauth2/v3/certs')
        return Response.json({ keys: [jwk] })
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        const header = Buffer.from(
          JSON.stringify({ alg: 'RS256', kid: jwk.kid })
        ).toString('base64url')
        const body = Buffer.from(JSON.stringify({ ...claims, nonce })).toString(
          'base64url'
        )
        const signature = Buffer.from(
          await crypto.subtle.sign(
            'RSASSA-PKCS1-v1_5',
            keys.privateKey,
            new TextEncoder().encode(`${header}.${body}`)
          )
        ).toString('base64url')
        return Response.json({ id_token: `${header}.${body}.${signature}` })
      }
      throw new Error('unexpected provider')
    }
    const h = harness(
      {
        APPROVED_ACCOUNTS: JSON.stringify({
          'google:opaque:stable-google-subject': NOW + 86_400_000,
        }),
      },
      fetcher as typeof fetch
    )
    const who = await identity()
    const flow = await h.begin(who, 'google')
    nonce = flow.authorization.searchParams.get('nonce')!
    expect(flow.authorization.origin).toBe('https://accounts.google.com')
    expect(flow.authorization.searchParams.get('code_challenge_method')).toBe(
      'S256'
    )
    expect(flow.authorization.searchParams.get('scope')).toBe('openid email')
    expect((await h.callback(flow, 'google')).status).toBe(200)
    const status = await (
      await h.signed(who, 'confirm', {
        transactionId: flow.login.transactionId,
        provider: 'google',
        subject: String(claims.sub),
      })
    ).json()
    expect(status).toMatchObject({
      approved: true,
      links: [{ provider: 'google', subject: claims.sub, label: claims.email }],
    })
  })

  it.each([
    'audience',
    'issuer',
    'nonce',
    'signature',
    'expired',
    'unverified-email',
  ] as const)('rejects Google ID tokens with invalid %s', async (invalid) => {
    const keys = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify']
    )) as CryptoKeyPair
    const jwk = {
      ...(await crypto.subtle.exportKey('jwk', keys.publicKey)),
      kid: 'test-key',
      alg: 'RS256',
    }
    let nonce = ''
    const fetcher = async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/certs'))
        return Response.json({ keys: [jwk] })
      const header = Buffer.from(
        JSON.stringify({ alg: 'RS256', kid: jwk.kid })
      ).toString('base64url')
      const body = Buffer.from(
        JSON.stringify({
          iss:
            invalid === 'issuer'
              ? 'https://evil.example'
              : 'https://accounts.google.com',
          aud: invalid === 'audience' ? 'other-id' : 'google-id',
          nonce: invalid === 'nonce' ? 'wrong' : nonce,
          exp: NOW / 1000 + (invalid === 'expired' ? -1 : 3600),
          iat: NOW / 1000,
          sub: '456',
          email: 'friend@example.com',
          email_verified: invalid !== 'unverified-email',
        })
      ).toString('base64url')
      const signature = Buffer.from(
        await crypto.subtle.sign(
          'RSASSA-PKCS1-v1_5',
          keys.privateKey,
          new TextEncoder().encode(
            invalid === 'signature' ? 'different-bytes' : `${header}.${body}`
          )
        )
      ).toString('base64url')
      return Response.json({ id_token: `${header}.${body}.${signature}` })
    }
    const h = harness({}, fetcher as typeof fetch)
    const who = await identity()
    const flow = await h.begin(who, 'google')
    nonce = flow.authorization.searchParams.get('nonce')!
    expect((await h.callback(flow, 'google')).status).toBe(400)
    expect(
      (
        await (
          await h.signed(who, 'poll', {
            transactionId: flow.login.transactionId,
          })
        ).json()
      ).state
    ).toBe('failed')
    expect((await (await h.signed(who, 'status')).json()).links).toEqual([])
  })

  it('does not turn OAuth login alone into bot-resistant approval', async () => {
    const h = harness({
      TURN_ENABLED: 'true',
      FREE_ONLY_CONFIRMED: 'true',
      APPROVED_ACCOUNTS: '{}',
    })
    const who = await identity()
    const result = await h.enroll(who)
    expect(result.approved).toBe(false)
    expect((await h.signed(who, 'credentials')).status).toBe(401)
    expect(
      h.fetchMock.mock.calls.some(([url]) =>
        String(url).includes('generate-ice-servers')
      )
    ).toBe(false)
  })

  it('expires pending links and never persists provider tokens', async () => {
    const h = harness()
    const who = await identity()
    const flow = await h.begin(who)
    await h.callback(flow)
    const rows = [...h.state.storage.sql.exec('SELECT * FROM logins')]
    expect(JSON.stringify(rows)).not.toContain('gho_test-access-token')
    expect(rows[0].verifier).toBeNull()
    h.setNow(NOW + 600_001)
    expect(
      (
        await (
          await h.signed(who, 'poll', {
            transactionId: flow.login.transactionId,
          })
        ).json()
      ).state
    ).toBe('expired')
  })
})

describe('TURN broker free-only controls and credential lifecycle', () => {
  it.each([
    {},
    { TURN_ENABLED: 'true' },
    { FREE_ONLY_CONFIRMED: 'true' },
    {
      TURN_ENABLED: 'true',
      FREE_ONLY_CONFIRMED: 'true',
      TURN_KEY_API_TOKEN: '',
    },
  ])(
    'does not mint credentials until both explicit gates and runtime secret are configured: %j',
    async (flags) => {
      const h = harness(flags)
      const who = await identity()
      await h.enroll(who)
      expect((await h.signed(who, 'credentials')).status).toBe(403)
      expect(
        h.fetchMock.mock.calls.some(([url]) =>
          String(url).includes('generate-ice-servers')
        )
      ).toBe(false)
    }
  )

  it('uses fixed server TTL, filters upstream URLs, caches credentials and revokes on unlink', async () => {
    const h = harness({ TURN_ENABLED: 'true', FREE_ONLY_CONFIRMED: 'true' })
    const who = await identity()
    await h.enroll(who)
    expect((await h.signed(who, 'credentials', { ttl: 172800 })).status).toBe(
      400
    )
    const first = await h.signed(who, 'credentials')
    expect(first.status).toBe(200)
    const credential = await first.json()
    expect(credential).toMatchObject({
      expiresAt: NOW + 3_600_000,
      iceServers: [
        { username: 'test-username', credential: 'test-credential' },
      ],
    })
    expect(
      credential.iceServers[0].urls.every((url: string) => /^turns?:/.test(url))
    ).toBe(true)
    expect(await (await h.signed(who, 'credentials')).json()).toEqual(
      credential
    )
    const issued = h.fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('generate-ice-servers')
    )
    expect(issued).toHaveLength(1)
    expect(JSON.parse(String(issued[0][1]?.body))).toEqual({ ttl: 3600 })
    expect(new Headers(issued[0][1]?.headers).get('Authorization')).toBe(
      'Bearer dedicated-turn-secret'
    )
    const unlinked = await (
      await h.signed(who, 'unlink', { provider: 'github', subject: '123' })
    ).json()
    expect(unlinked).toMatchObject({
      links: [],
      approved: false,
      revocationPending: false,
    })
    expect(
      h.fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/test-username/revoke')
      )
    ).toBe(true)
    expect((await h.signed(who, 'credentials')).status).toBe(401)
    expect([...h.state.storage.sql.exec('SELECT * FROM credentials')]).toEqual(
      []
    )
  })

  it('reserves issuance atomically across concurrent requests', async () => {
    let release!: () => void
    let started!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const arrived = new Promise<void>((resolve) => {
      started = resolve
    })
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/access_token'))
        return Response.json({ access_token: 'gho_test-access-token' })
      if (url.endsWith('/user'))
        return Response.json({ id: 123, login: 'friend', type: 'User' })
      started()
      await held
      return Response.json({
        iceServers: [
          {
            urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
            username: 'unique',
            credential: 'secret',
          },
        ],
      })
    })
    const h = harness(
      { TURN_ENABLED: 'true', FREE_ONLY_CONFIRMED: 'true' },
      upstream as typeof fetch
    )
    const who = await identity()
    await h.enroll(who)
    const request = h.signed(who, 'credentials')
    await arrived
    const second = await h.signed(who, 'credentials')
    expect(second.status).toBe(429)
    release()
    expect((await request).status).toBe(200)
    expect(
      upstream.mock.calls.filter(([url]) =>
        String(url).includes('generate-ice-servers')
      )
    ).toHaveLength(1)
  })

  it('keeps revocation pending and blocks renewal when the provider is down', async () => {
    const h = harness({ TURN_ENABLED: 'true', FREE_ONLY_CONFIRMED: 'true' })
    const who = await identity()
    await h.enroll(who)
    await h.signed(who, 'credentials')
    h.fetchMock.mockImplementationOnce(
      async () => new Response(null, { status: 503 })
    )
    const status = await (
      await h.signed(who, 'unlink', { provider: 'github', subject: '123' })
    ).json()
    expect(status.revocationPending).toBe(true)
    expect(h.state.storage.setAlarm).toHaveBeenCalled()
    await h.broker.alarm()
    expect([...h.state.storage.sql.exec('SELECT * FROM revocations')]).toEqual(
      []
    )
  })

  it('revokes an in-flight issuance when unlink removes the longer of two approved grants', async () => {
    const h = harness({
      TURN_ENABLED: 'true',
      FREE_ONLY_CONFIRMED: 'true',
      APPROVED_ACCOUNTS: JSON.stringify({
        'github:123': NOW + 86_400_000,
        'google:456': NOW + 300_000,
      }),
    })
    const who = await identity()
    await h.enroll(who)
    h.state.storage.sql.exec(
      'INSERT INTO links(provider, subject, public_key, label) VALUES (?, ?, ?, ?)',
      'google',
      '456',
      who.publicKey,
      'friend@example.com'
    )
    const held = heldIssuance(h)
    const request = h.signed(who, 'credentials')
    await held.arrived
    const unlinked = await (
      await h.signed(who, 'unlink', { provider: 'github', subject: '123' })
    ).json()
    expect(unlinked).toMatchObject({
      approved: true,
      links: [{ provider: 'google', subject: '456', approved: true }],
    })
    held.release()
    expect((await request).status).toBe(401)
    expect([...h.state.storage.sql.exec('SELECT * FROM credentials')]).toEqual(
      []
    )
    expect([...h.state.storage.sql.exec('SELECT * FROM issued')]).toEqual([])
    expect(
      h.fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/raced-username/revoke')
      )
    ).toBe(true)
    const replacement = await h.signed(who, 'credentials')
    expect(replacement.status).toBe(200)
    expect((await replacement.json()).expiresAt).toBe(NOW + 300_000)
  })

  it('revokes an in-flight issuance even when the same account is unlinked and relinked', async () => {
    const h = harness({ TURN_ENABLED: 'true', FREE_ONLY_CONFIRMED: 'true' })
    const who = await identity()
    await h.enroll(who)
    const initial = await (await h.signed(who, 'status')).json()
    const held = heldIssuance(h)
    const request = h.signed(who, 'credentials')
    await held.arrived
    expect(
      (await h.signed(who, 'unlink', { provider: 'github', subject: '123' }))
        .status
    ).toBe(200)
    await h.enroll(who)
    expect((await (await h.signed(who, 'status')).json()).links).toEqual(
      initial.links
    )
    held.release()
    expect((await request).status).toBe(401)
    expect([...h.state.storage.sql.exec('SELECT * FROM credentials')]).toEqual(
      []
    )
    expect(
      h.fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/raced-username/revoke')
      )
    ).toBe(true)
  })

  it.each([
    'shortened approval',
    'expired approval',
    'pending revocation',
    'disabled service',
    'changed key',
  ] as const)('rejects in-flight credentials after %s', async (change) => {
    const h = harness({ TURN_ENABLED: 'true', FREE_ONLY_CONFIRMED: 'true' })
    const who = await identity()
    await h.enroll(who)
    const held = heldIssuance(h)
    const request = h.signed(who, 'credentials')
    await held.arrived
    switch (change) {
      case 'shortened approval':
        h.env.APPROVED_ACCOUNTS = JSON.stringify({
          'github:123': NOW + 300_000,
        })
        break
      case 'expired approval':
        h.setNow(NOW + 86_400_001)
        break
      case 'pending revocation':
        h.state.storage.sql.exec(
          'INSERT INTO revocations(username, public_key, key_id, expires_at) VALUES (?, ?, ?, ?)',
          'pending-username',
          who.publicKey,
          TURN_KEY_ID,
          NOW + 3_600_000
        )
        break
      case 'disabled service':
        h.env.TURN_ENABLED = 'false'
        break
      case 'changed key':
        h.env.TURN_KEY_ID = 'b'.repeat(32)
        h.env.TURN_KEY_API_TOKEN = 'replacement-turn-secret'
        break
    }
    held.release()
    expect((await request).status).toBe(401)
    expect([...h.state.storage.sql.exec('SELECT * FROM credentials')]).toEqual(
      []
    )
    expect([...h.state.storage.sql.exec('SELECT * FROM issued')]).toEqual([])
    if (change === 'changed key') {
      expect([
        ...h.state.storage.sql.exec('SELECT username, key_id FROM revocations'),
      ]).toEqual([{ username: 'raced-username', key_id: TURN_KEY_ID }])
    } else if (change !== 'expired approval') {
      expect(
        h.fetchMock.mock.calls.some(([url]) =>
          String(url).endsWith('/raced-username/revoke')
        )
      ).toBe(true)
    }
  })

  it('replaces a cached lease from the retired TURN key after a broker restart', async () => {
    const h = harness({ TURN_ENABLED: 'true', FREE_ONLY_CONFIRMED: 'true' })
    const who = await identity()
    await h.enroll(who)
    expect((await h.signed(who, 'credentials')).status).toBe(200)
    h.env.TURN_KEY_ID = 'b'.repeat(32)
    h.env.TURN_KEY_API_TOKEN = 'replacement-turn-secret'
    h.restart()
    const held = heldIssuance(h)
    const request = h.signed(who, 'credentials')
    await held.arrived
    held.release()
    const replacement = await request
    expect(replacement.status).toBe(200)
    expect((await replacement.json()).iceServers[0].username).toBe(
      'raced-username'
    )
    const generations = h.fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('generate-ice-servers')
    )
    expect(generations).toHaveLength(2)
    expect(String(generations[1][0])).toContain(`/keys/${h.env.TURN_KEY_ID}/`)
    expect(new Headers(generations[1][1]?.headers).get('Authorization')).toBe(
      'Bearer replacement-turn-secret'
    )
    expect([
      ...h.state.storage.sql.exec('SELECT key_id FROM credentials'),
    ]).toEqual([{ key_id: h.env.TURN_KEY_ID }])
    expect((await h.signed(who, 'credentials')).status).toBe(200)
    expect(
      h.fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('generate-ice-servers')
      )
    ).toHaveLength(2)
  })

  it('rejects expired or malformed manual grants', async () => {
    const h = harness({
      TURN_ENABLED: 'true',
      FREE_ONLY_CONFIRMED: 'true',
      APPROVED_ACCOUNTS: JSON.stringify({ 'github:123': NOW - 1 }),
    })
    const who = await identity()
    await h.enroll(who)
    expect((await h.signed(who, 'credentials')).status).toBe(401)
    h.env.APPROVED_ACCOUNTS = 'malformed'
    expect((await h.signed(who, 'credentials')).status).toBe(401)
  })

  it('exposes CORS only to the desktop and broker origins', async () => {
    const h = harness()
    h.env.BROKER = {
      getByName: () => ({ fetch: (request) => h.broker.fetch(request) }),
    }
    const denied = await worker.fetch(
      new Request(`${ORIGIN}/v1/challenge`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://attacker.example' },
      }),
      h.env
    )
    expect(denied.status).toBe(401)
    expect(denied.headers.has('Access-Control-Allow-Origin')).toBe(false)
    const allowed = await worker.fetch(
      new Request(`${ORIGIN}/v1/challenge`, {
        method: 'OPTIONS',
        headers: { Origin: 'tauri://localhost' },
      }),
      h.env
    )
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(
      'tauri://localhost'
    )
    expect(allowed.headers.get('Cache-Control')).toBe('no-store')
  })
})
