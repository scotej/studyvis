import { strings } from '../../src/strings'
import {
  BROKER_ACTIONS,
  BROKER_CHALLENGE_MS,
  BROKER_LOGIN_MS,
  brokerSigningBytes,
  type BrokerAccount,
  type BrokerAction,
  type BrokerCredentials,
  type BrokerErrorCode,
  type BrokerProvider,
  type BrokerSignedRequest,
  type BrokerStatus,
  type JsonObject,
} from './protocol'

type SqlRow = Record<string, unknown>
export interface BrokerSql {
  exec<T extends SqlRow = SqlRow>(
    query: string,
    ...bindings: unknown[]
  ): Iterable<T>
}
export interface BrokerState {
  storage: {
    sql: BrokerSql
    transactionSync<T>(callback: () => T): T
    setAlarm(time: number): Promise<void>
  }
}
export type BrokerEnv = {
  BROKER_ORIGIN: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  TURN_KEY_ID?: string
  TURN_KEY_API_TOKEN?: string
  RATE_LIMIT_SECRET?: string
  APPROVED_ACCOUNTS?: string
  TURN_ENABLED?: string
  FREE_ONLY_CONFIRMED?: string
  BROKER?: {
    getByName(name: string): { fetch(request: Request): Promise<Response> }
  }
}
type Dependencies = { fetch: typeof fetch; now: () => number }
type LoginRow = SqlRow & {
  id: string
  public_key: string
  provider: BrokerProvider
  expires_at: number
  state: string
  subject: string | null
  label: string | null
  cookie_hash: string | null
  verifier: string | null
  oidc_nonce: string | null
}
type LinkRow = SqlRow & {
  provider: BrokerProvider
  subject: string
  public_key: string
  label: string
}
type CredentialRow = SqlRow & {
  public_key: string
  username: string
  key_id: string
  expires_at: number
  response: string
}

const MAX_BODY_BYTES = 4096
const MAX_UPSTREAM_BYTES = 65_536
const UPSTREAM_TIMEOUT_MS = 10_000
const NONCE = /^[A-Za-z0-9_-]{43}$/
const PUBLIC_KEY = /^[0-9a-f]{64}$/
const SIGNATURE = /^[0-9a-f]{128}$/
const PROVIDERS: readonly BrokerProvider[] = ['github', 'google']
const COMMON_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
}

class BrokerFailure extends Error {
  code: BrokerErrorCode
  status: number
  constructor(code: BrokerErrorCode, status = 400) {
    super(code)
    this.code = code
    this.status = status
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: COMMON_HEADERS })
}

function failure(error: unknown): Response {
  return error instanceof BrokerFailure
    ? json({ error: error.code }, error.status)
    : json({ error: 'unavailable' }, 503)
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrokerFailure('invalid_request')
  }
  return value as JsonObject
}

function fields(value: JsonObject, names: readonly string[]): void {
  if (Object.keys(value).some((key) => !names.includes(key))) {
    throw new BrokerFailure('invalid_request')
  }
}

function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new BrokerFailure('invalid_request')
  }
  return value
}

function provider(value: unknown): BrokerProvider {
  if (!PROVIDERS.includes(value as BrokerProvider)) {
    throw new BrokerFailure('invalid_request')
  }
  return value as BrokerProvider
}

function subject(value: unknown, selected: BrokerProvider): string {
  return text(
    value,
    selected === 'github' ? /^[0-9]{1,64}$/ : /^[\x20-\x7e]{1,255}$/
  )
}

function bytes(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16))
}

function base64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function random(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)))
}

async function digest(value: string): Promise<string> {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    )
  )
}

function origin(env: BrokerEnv): string {
  const url = new URL(env.BROKER_ORIGIN)
  if (url.protocol !== 'https:' || url.origin !== env.BROKER_ORIGIN) {
    throw new BrokerFailure('unavailable', 503)
  }
  return url.origin
}

async function boundedJson(
  response: Response,
  limit: number
): Promise<unknown> {
  if (!response.body) throw new BrokerFailure('invalid_request')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new BrokerFailure('invalid_request')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const data = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
  } catch {
    throw new BrokerFailure('invalid_request')
  }
}

export class TurnBroker {
  private state: BrokerState
  private env: BrokerEnv
  private deps: Dependencies

  constructor(state: BrokerState, env: BrokerEnv, deps?: Dependencies) {
    this.state = state
    this.env = env
    this.deps = deps ?? {
      fetch: globalThis.fetch.bind(globalThis),
      now: Date.now,
    }
    state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS nonces (
        nonce TEXT PRIMARY KEY, public_key TEXT NOT NULL, action TEXT NOT NULL,
        expires_at INTEGER NOT NULL, ip TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rates (
        bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS links (
        provider TEXT NOT NULL, subject TEXT NOT NULL, public_key TEXT NOT NULL,
        label TEXT NOT NULL, PRIMARY KEY(provider, subject), UNIQUE(public_key, provider)
      );
      CREATE TABLE IF NOT EXISTS logins (
        id TEXT PRIMARY KEY, public_key TEXT NOT NULL, provider TEXT NOT NULL,
        ticket_hash TEXT UNIQUE, oauth_state_hash TEXT UNIQUE, cookie_hash TEXT,
        verifier TEXT, oidc_nonce TEXT, expires_at INTEGER NOT NULL,
        state TEXT NOT NULL, subject TEXT, label TEXT
      );
      CREATE TABLE IF NOT EXISTS credentials (
        public_key TEXT PRIMARY KEY, username TEXT NOT NULL, key_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL, response TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS issued (
        username TEXT PRIMARY KEY, public_key TEXT NOT NULL, key_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS revocations (
        username TEXT PRIMARY KEY, public_key TEXT NOT NULL, key_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS nonces_expiry ON nonces(expires_at);
      CREATE INDEX IF NOT EXISTS rates_expiry ON rates(expires_at);
      CREATE INDEX IF NOT EXISTS logins_expiry ON logins(expires_at);
      CREATE INDEX IF NOT EXISTS credentials_expiry ON credentials(expires_at);
      CREATE INDEX IF NOT EXISTS issued_expiry ON issued(expires_at);
      CREATE INDEX IF NOT EXISTS issued_identity ON issued(public_key);
      CREATE INDEX IF NOT EXISTS revocations_expiry ON revocations(expires_at);
      CREATE INDEX IF NOT EXISTS revocations_identity ON revocations(public_key);
    `)
  }

  private rows<T extends SqlRow>(query: string, ...bindings: unknown[]): T[] {
    return [...this.state.storage.sql.exec<T>(query, ...bindings)]
  }

  private rate(key: string, limit: number, duration: number): void {
    const now = this.deps.now()
    const bucket = `${key}:${Math.floor(now / duration)}`
    const row = this.rows('SELECT count FROM rates WHERE bucket = ?', bucket)[0]
    if (row && Number(row.count) >= limit)
      throw new BrokerFailure('rate_limited', 429)
    this.state.storage.sql.exec(
      'INSERT INTO rates(bucket, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count=count+1',
      bucket,
      now + duration
    )
  }

  private clean(): void {
    const now = this.deps.now()
    for (const table of [
      'nonces',
      'rates',
      'logins',
      'credentials',
      'issued',
      'revocations',
    ]) {
      this.state.storage.sql.exec(
        `DELETE FROM ${table} WHERE expires_at <= ?`,
        now
      )
    }
  }

  private async ip(request: Request): Promise<string> {
    const secret = this.env.RATE_LIMIT_SECRET
    if (!secret || secret.length < 32)
      throw new BrokerFailure('unavailable', 503)
    const value = request.headers.get('CF-Connecting-IP')
    if (!value || value.length > 64 || !/^[0-9a-fA-F:.]+$/.test(value)) {
      throw new BrokerFailure('unavailable', 503)
    }
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const day = Math.floor(this.deps.now() / 86_400_000)
    return base64Url(
      new Uint8Array(
        await crypto.subtle.sign(
          'HMAC',
          key,
          new TextEncoder().encode(`${day}:${value}`)
        )
      )
    )
  }

  private configured(value: BrokerProvider): boolean {
    return value === 'github'
      ? Boolean(this.env.GITHUB_CLIENT_ID && this.env.GITHUB_CLIENT_SECRET)
      : Boolean(this.env.GOOGLE_CLIENT_ID && this.env.GOOGLE_CLIENT_SECRET)
  }

  private approvals(): Record<string, number> {
    let value: unknown
    try {
      value = JSON.parse(this.env.APPROVED_ACCOUNTS ?? '{}')
    } catch {
      return {}
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const result: Record<string, number> = {}
    for (const [key, expiry] of Object.entries(value)) {
      if (
        /^(github:[0-9]{1,64}|google:[\x20-\x7e]{1,255})$/.test(key) &&
        typeof expiry === 'number' &&
        Number.isSafeInteger(expiry) &&
        expiry > this.deps.now()
      )
        result[key] = expiry
    }
    return result
  }

  private linked(publicKey: string): LinkRow[] {
    return this.rows<LinkRow>(
      'SELECT provider, subject, public_key, label FROM links WHERE public_key = ? ORDER BY provider',
      publicKey
    )
  }

  private status(publicKey: string): BrokerStatus {
    const approved = this.approvals()
    const links = this.linked(publicKey).map((link) => ({
      provider: link.provider,
      subject: link.subject,
      label: link.label,
      approved: Boolean(approved[`${link.provider}:${link.subject}`]),
    }))
    return {
      providers: {
        github: this.configured('github'),
        google: this.configured('google'),
      },
      links,
      approved: links.some((link) => link.approved),
      enabled:
        this.env.TURN_ENABLED === 'true' &&
        this.env.FREE_ONLY_CONFIRMED === 'true' &&
        Boolean(this.env.TURN_KEY_ID && this.env.TURN_KEY_API_TOKEN),
      freeOnlyConfirmed: this.env.FREE_ONLY_CONFIRMED === 'true',
      revocationPending:
        this.rows(
          'SELECT username FROM revocations WHERE public_key = ? LIMIT 1',
          publicKey
        ).length > 0,
    }
  }

  private async authenticate(
    action: BrokerAction,
    input: unknown,
    ip: string
  ): Promise<BrokerSignedRequest> {
    const body = object(input)
    fields(body, ['publicKey', 'nonce', 'expiresAt', 'payload', 'signature'])
    const publicKey = text(body.publicKey, PUBLIC_KEY)
    const nonce = text(body.nonce, NONCE)
    const signature = text(body.signature, SIGNATURE)
    const expiresAt = body.expiresAt
    const payload = object(body.payload)
    if (
      typeof expiresAt !== 'number' ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= this.deps.now() ||
      expiresAt > this.deps.now() + BROKER_CHALLENGE_MS
    ) {
      throw new BrokerFailure('unauthorized', 401)
    }
    const key = await crypto.subtle.importKey(
      'raw',
      bytes(publicKey),
      'Ed25519',
      false,
      ['verify']
    )
    const message = brokerSigningBytes(
      origin(this.env),
      action,
      publicKey,
      { nonce, expiresAt },
      payload
    )
    if (
      !(await crypto.subtle.verify('Ed25519', key, bytes(signature), message))
    )
      throw new BrokerFailure('unauthorized', 401)
    this.state.storage.transactionSync(() => {
      const row = this.rows('SELECT * FROM nonces WHERE nonce = ?', nonce)[0]
      if (
        !row ||
        row.public_key !== publicKey ||
        row.action !== action ||
        row.expires_at !== expiresAt ||
        row.ip !== ip
      )
        throw new BrokerFailure('unauthorized', 401)
      this.state.storage.sql.exec('DELETE FROM nonces WHERE nonce = ?', nonce)
      this.rate(`signed:${publicKey}`, 180, 60_000)
    })
    return { publicKey, nonce, expiresAt, payload, signature }
  }

  private async upstream(
    url: string,
    init: RequestInit = {}
  ): Promise<Response> {
    return this.deps.fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  }

  private async upstreamJson(
    url: string,
    init: RequestInit = {}
  ): Promise<JsonObject> {
    const response = await this.upstream(url, init)
    if (!response.ok) throw new BrokerFailure('unavailable', 503)
    return object(await boundedJson(response, MAX_UPSTREAM_BYTES))
  }

  private async startLogin(publicKey: string, payload: JsonObject) {
    fields(payload, ['provider'])
    const selected = provider(payload.provider)
    if (!this.configured(selected)) throw new BrokerFailure('unavailable', 503)
    const id = random()
    const ticket = random()
    const ticketHash = await digest(ticket)
    const expiresAt = this.deps.now() + BROKER_LOGIN_MS
    this.state.storage.transactionSync(() => {
      this.rate(`login:${publicKey}`, 6, 3_600_000)
      this.rate('login:global', 100, 3_600_000)
      this.state.storage.sql.exec(
        'DELETE FROM logins WHERE public_key = ?',
        publicKey
      )
      this.state.storage.sql.exec(
        'INSERT INTO logins(id, public_key, provider, ticket_hash, expires_at, state) VALUES (?, ?, ?, ?, ?, ?)',
        id,
        publicKey,
        selected,
        ticketHash,
        expiresAt,
        'pending'
      )
    })
    return {
      transactionId: id,
      url: `${origin(this.env)}/oauth/start?ticket=${ticket}`,
      expiresAt,
    }
  }

  private poll(publicKey: string, payload: JsonObject) {
    fields(payload, ['transactionId'])
    const id = text(payload.transactionId, NONCE)
    const row = this.rows<LoginRow>(
      'SELECT * FROM logins WHERE id = ? AND public_key = ?',
      id,
      publicKey
    )[0]
    if (!row || row.expires_at <= this.deps.now())
      return { state: 'expired', expiresAt: row?.expires_at ?? this.deps.now() }
    if (row.state === 'ready' && row.subject && row.label) {
      const account: BrokerAccount = {
        provider: row.provider,
        subject: row.subject,
        label: row.label,
        approved: Boolean(this.approvals()[`${row.provider}:${row.subject}`]),
      }
      return { state: 'ready', account, expiresAt: row.expires_at }
    }
    return {
      state: row.state === 'failed' ? 'failed' : 'pending',
      expiresAt: row.expires_at,
    }
  }

  private confirm(publicKey: string, payload: JsonObject): BrokerStatus {
    fields(payload, ['transactionId', 'provider', 'subject'])
    const id = text(payload.transactionId, NONCE)
    const selected = provider(payload.provider)
    const selectedSubject = subject(payload.subject, selected)
    this.state.storage.transactionSync(() => {
      const row = this.rows<LoginRow>(
        'SELECT * FROM logins WHERE id = ? AND public_key = ?',
        id,
        publicKey
      )[0]
      if (
        !row ||
        row.state !== 'ready' ||
        row.expires_at <= this.deps.now() ||
        row.provider !== selected ||
        row.subject !== selectedSubject ||
        !row.label
      )
        throw new BrokerFailure('unauthorized', 401)
      const conflict = this.rows(
        'SELECT public_key FROM links WHERE provider = ? AND subject = ?',
        selected,
        selectedSubject
      )[0]
      const existing = this.rows(
        'SELECT subject FROM links WHERE public_key = ? AND provider = ?',
        publicKey,
        selected
      )[0]
      if (
        (conflict && conflict.public_key !== publicKey) ||
        (existing && existing.subject !== selectedSubject)
      )
        throw new BrokerFailure('conflict', 409)
      this.state.storage.sql.exec(
        'INSERT INTO links(provider, subject, public_key, label) VALUES (?, ?, ?, ?) ON CONFLICT(provider, subject) DO UPDATE SET label=excluded.label',
        selected,
        selectedSubject,
        publicKey,
        row.label
      )
      this.state.storage.sql.exec('DELETE FROM logins WHERE id = ?', id)
    })
    return this.status(publicKey)
  }

  private async oauthStart(url: URL): Promise<Response> {
    if ([...url.searchParams.keys()].length !== 1)
      throw new BrokerFailure('invalid_request')
    const ticket = text(url.searchParams.get('ticket'), NONCE)
    const hash = await digest(ticket)
    const state = random()
    const cookie = random()
    const verifier = random()
    const oidcNonce = random()
    const [stateHash, cookieHash, challenge] = await Promise.all([
      digest(state),
      digest(cookie),
      digest(verifier),
    ])
    let row: LoginRow | undefined
    this.state.storage.transactionSync(() => {
      row = this.rows<LoginRow>(
        'SELECT * FROM logins WHERE ticket_hash = ?',
        hash
      )[0]
      if (
        !row ||
        row.state !== 'pending' ||
        row.expires_at <= this.deps.now() ||
        !this.configured(row.provider)
      )
        throw new BrokerFailure('unauthorized', 401)
      this.state.storage.sql.exec(
        'UPDATE logins SET ticket_hash=NULL, oauth_state_hash=?, cookie_hash=?, verifier=?, oidc_nonce=? WHERE id=?',
        stateHash,
        cookieHash,
        verifier,
        oidcNonce,
        row.id
      )
    })
    if (!row) throw new BrokerFailure('unauthorized', 401)
    const redirect = `${origin(this.env)}/oauth/callback/${row.provider}`
    const auth = new URL(
      row.provider === 'github'
        ? 'https://github.com/login/oauth/authorize'
        : 'https://accounts.google.com/o/oauth2/v2/auth'
    )
    auth.searchParams.set(
      'client_id',
      row.provider === 'github'
        ? this.env.GITHUB_CLIENT_ID!
        : this.env.GOOGLE_CLIENT_ID!
    )
    auth.searchParams.set('redirect_uri', redirect)
    auth.searchParams.set('state', state)
    auth.searchParams.set('code_challenge', challenge)
    auth.searchParams.set('code_challenge_method', 'S256')
    if (row.provider === 'github') {
      auth.searchParams.set('allow_signup', 'false')
    } else {
      auth.searchParams.set('response_type', 'code')
      auth.searchParams.set('scope', 'openid email')
      auth.searchParams.set('nonce', oidcNonce)
    }
    return new Response(null, {
      status: 302,
      headers: {
        ...COMMON_HEADERS,
        Location: auth.toString(),
        'Set-Cookie': `__Host-studyvis-oauth-${row.id}=${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
      },
    })
  }

  private async githubAccount(
    code: string,
    row: LoginRow
  ): Promise<{ subject: string; label: string }> {
    const token = await this.upstreamJson(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: this.env.GITHUB_CLIENT_ID!,
          client_secret: this.env.GITHUB_CLIENT_SECRET!,
          code,
          code_verifier: row.verifier!,
          redirect_uri: `${origin(this.env)}/oauth/callback/github`,
        }),
      }
    )
    const accessToken = text(token.access_token, /^[A-Za-z0-9_.-]{10,1024}$/)
    const user = await this.upstreamJson('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'StudyVis-TURN-broker',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (
      user.type !== 'User' ||
      typeof user.id !== 'number' ||
      !Number.isSafeInteger(user.id) ||
      user.id <= 0
    )
      throw new BrokerFailure('unauthorized', 401)
    return {
      subject: String(user.id),
      label: text(user.login, /^[A-Za-z0-9-]{1,39}$/),
    }
  }

  private async googleAccount(
    code: string,
    row: LoginRow
  ): Promise<{ subject: string; label: string }> {
    const token = await this.upstreamJson(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.env.GOOGLE_CLIENT_ID!,
          client_secret: this.env.GOOGLE_CLIENT_SECRET!,
          code,
          code_verifier: row.verifier!,
          redirect_uri: `${origin(this.env)}/oauth/callback/google`,
          grant_type: 'authorization_code',
        }),
      }
    )
    const jwt = text(
      token.id_token,
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
    )
    const parts = jwt.split('.')
    const decode = (part: string) =>
      Uint8Array.from(
        atob(part.replaceAll('-', '+').replaceAll('_', '/')),
        (c) => c.charCodeAt(0)
      )
    const header = object(
      JSON.parse(new TextDecoder().decode(decode(parts[0])))
    )
    if (header.alg !== 'RS256' || typeof header.kid !== 'string')
      throw new BrokerFailure('unauthorized', 401)
    const jwks = await this.upstreamJson(
      'https://www.googleapis.com/oauth2/v3/certs'
    )
    if (!Array.isArray(jwks.keys)) throw new BrokerFailure('unavailable', 503)
    const jwk = jwks.keys.find(
      (candidate) =>
        candidate &&
        typeof candidate === 'object' &&
        !Array.isArray(candidate) &&
        candidate.kid === header.kid &&
        candidate.kty === 'RSA' &&
        candidate.alg === 'RS256'
    )
    if (!jwk) throw new BrokerFailure('unauthorized', 401)
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk as JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    )
    if (
      !(await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        decode(parts[2]),
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
      ))
    )
      throw new BrokerFailure('unauthorized', 401)
    const claims = object(
      JSON.parse(new TextDecoder().decode(decode(parts[1])))
    )
    const nowSeconds = Math.floor(this.deps.now() / 1000)
    if (
      !['https://accounts.google.com', 'accounts.google.com'].includes(
        String(claims.iss)
      ) ||
      claims.aud !== this.env.GOOGLE_CLIENT_ID ||
      (claims.azp !== undefined && claims.azp !== this.env.GOOGLE_CLIENT_ID) ||
      typeof claims.exp !== 'number' ||
      claims.exp <= nowSeconds ||
      typeof claims.iat !== 'number' ||
      claims.iat > nowSeconds + 60 ||
      claims.nonce !== row.oidc_nonce ||
      claims.email_verified !== true
    )
      throw new BrokerFailure('unauthorized', 401)
    return {
      subject: subject(claims.sub, 'google'),
      label: text(claims.email, /^[^\s<>]{1,254}@[^\s<>]{1,254}$/),
    }
  }

  private async oauthCallback(request: Request, url: URL): Promise<Response> {
    const selected = provider(url.pathname.split('/').at(-1))
    const state = text(url.searchParams.get('state'), NONCE)
    if (
      url.searchParams.getAll('state').length !== 1 ||
      url.searchParams.getAll('code').length > 1
    )
      throw new BrokerFailure('invalid_request')
    const stateHash = await digest(state)
    const row = this.rows<LoginRow>(
      'SELECT * FROM logins WHERE oauth_state_hash = ?',
      stateHash
    )[0]
    if (
      !row ||
      row.provider !== selected ||
      row.expires_at <= this.deps.now() ||
      row.state !== 'pending' ||
      !this.configured(selected)
    )
      throw new BrokerFailure('unauthorized', 401)
    const cookieName = `__Host-studyvis-oauth-${row.id}`
    const cookie = request.headers
      .get('Cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1)
    if (
      !cookie ||
      !NONCE.test(cookie) ||
      (await digest(cookie)) !== row.cookie_hash
    )
      throw new BrokerFailure('unauthorized', 401)
    this.state.storage.transactionSync(() => {
      const current = this.rows(
        'SELECT oauth_state_hash, state FROM logins WHERE id = ?',
        row.id
      )[0]
      if (
        !current ||
        current.oauth_state_hash !== stateHash ||
        current.state !== 'pending'
      )
        throw new BrokerFailure('unauthorized', 401)
      this.state.storage.sql.exec(
        'UPDATE logins SET oauth_state_hash=NULL, cookie_hash=NULL, state=? WHERE id=?',
        'exchanging',
        row.id
      )
    })
    let success = false
    try {
      if (url.searchParams.has('error'))
        throw new BrokerFailure('unauthorized', 401)
      const code = text(
        url.searchParams.get('code'),
        /^[A-Za-z0-9_./~-]{1,2048}$/
      )
      const account =
        selected === 'github'
          ? await this.githubAccount(code, row)
          : await this.googleAccount(code, row)
      if (row.expires_at <= this.deps.now())
        throw new BrokerFailure('unauthorized', 401)
      this.state.storage.sql.exec(
        'UPDATE logins SET state=?, subject=?, label=?, verifier=NULL, oidc_nonce=NULL WHERE id=? AND state=?',
        'ready',
        account.subject,
        account.label,
        row.id,
        'exchanging'
      )
      success = true
    } catch {
      this.state.storage.sql.exec(
        'UPDATE logins SET state=?, verifier=NULL, oidc_nonce=NULL WHERE id=?',
        'failed',
        row.id
      )
    }
    const body = success
      ? strings.turnBrokerBrowser.complete
      : strings.turnBrokerBrowser.failed
    return new Response(body, {
      status: success ? 200 : 400,
      headers: {
        ...COMMON_HEADERS,
        'Content-Type': 'text/plain; charset=utf-8',
        'Set-Cookie': `${cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
      },
    })
  }

  private async credentials(
    publicKey: string,
    payload: JsonObject
  ): Promise<BrokerCredentials> {
    fields(payload, [])
    const status = this.status(publicKey)
    if (!status.enabled) throw new BrokerFailure('disabled', 403)
    if (!status.approved || status.revocationPending)
      throw new BrokerFailure('unauthorized', 401)
    const approved = this.approvals()
    const expiry = Math.max(
      ...this.linked(publicKey).map(
        (link) => approved[`${link.provider}:${link.subject}`] ?? 0
      )
    )
    const now = this.deps.now()
    const cached = this.rows<CredentialRow>(
      'SELECT * FROM credentials WHERE public_key = ?',
      publicKey
    )[0]
    if (
      cached &&
      cached.expires_at > now + 600_000 &&
      cached.expires_at <= expiry
    )
      return JSON.parse(cached.response) as BrokerCredentials
    const ttl = Math.min(3600, Math.floor((expiry - now) / 1000))
    if (ttl < 60) throw new BrokerFailure('unauthorized', 401)
    // The reservation is durable before the external request yields, so racing
    // retries cannot spend the same issuance quota or mint unbounded credentials.
    this.state.storage.transactionSync(() => {
      this.rate(`credentials-hour:${publicKey}`, 6, 3_600_000)
      this.rate(`credentials-day:${publicKey}`, 36, 86_400_000)
      this.rate('credentials-global', 100, 86_400_000)
      const pending = this.rows(
        'SELECT count FROM rates WHERE bucket = ?',
        `issuance:${publicKey}`
      )[0]
      if (pending && Number(pending.count) > now)
        throw new BrokerFailure('rate_limited', 429)
      this.state.storage.sql.exec(
        'INSERT INTO rates(bucket, count, expires_at) VALUES (?, ?, ?) ON CONFLICT(bucket) DO UPDATE SET count=excluded.count, expires_at=excluded.expires_at',
        `issuance:${publicKey}`,
        now + 30_000,
        now + 30_000
      )
    })
    try {
      const keyId = text(this.env.TURN_KEY_ID, /^[0-9a-f]{32}$/)
      const result = await this.upstreamJson(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.env.TURN_KEY_API_TOKEN!}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl }),
        }
      )
      if (!Array.isArray(result.iceServers))
        throw new BrokerFailure('unavailable', 503)
      const servers = result.iceServers.flatMap((entry) => {
        const item = object(entry)
        const input = typeof item.urls === 'string' ? [item.urls] : item.urls
        if (!Array.isArray(input)) throw new BrokerFailure('unavailable', 503)
        const urls = input.filter(
          (url): url is string =>
            typeof url === 'string' &&
            /^turns?:turn\.cloudflare\.com:(3478|443|80|5349)\?transport=(udp|tcp)$/.test(
              url
            )
        )
        if (!urls.length) return []
        return [
          {
            urls,
            username: text(item.username, /^[A-Za-z0-9_.:-]{1,512}$/),
            credential: text(item.credential, /^[A-Za-z0-9_+/.=:-]{1,512}$/),
          },
        ]
      })
      if (servers.length !== 1) throw new BrokerFailure('unavailable', 503)
      const response = { iceServers: servers, expiresAt: now + ttl * 1000 }
      // An unlink can interleave with the provider fetch. Never cache or return
      // credentials once their account authorization has disappeared.
      this.state.storage.sql.exec(
        'INSERT INTO issued(username, public_key, key_id, expires_at) VALUES (?, ?, ?, ?)',
        servers[0].username,
        publicKey,
        keyId,
        response.expiresAt
      )
      if (!this.status(publicKey).approved || !this.status(publicKey).enabled) {
        await this.queueRevocations(publicKey)
        throw new BrokerFailure('unauthorized', 401)
      }
      this.state.storage.sql.exec(
        'INSERT INTO credentials(public_key, username, key_id, expires_at, response) VALUES (?, ?, ?, ?, ?) ON CONFLICT(public_key) DO UPDATE SET username=excluded.username, key_id=excluded.key_id, expires_at=excluded.expires_at, response=excluded.response',
        publicKey,
        servers[0].username,
        keyId,
        response.expiresAt,
        JSON.stringify(response)
      )
      return response
    } finally {
      this.state.storage.sql.exec(
        'DELETE FROM rates WHERE bucket = ?',
        `issuance:${publicKey}`
      )
    }
  }

  private async queueRevocations(publicKey: string): Promise<void> {
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        'INSERT OR IGNORE INTO revocations(username, public_key, key_id, expires_at) SELECT username, public_key, key_id, expires_at FROM issued WHERE public_key = ?',
        publicKey
      )
      this.state.storage.sql.exec(
        'DELETE FROM credentials WHERE public_key = ?',
        publicKey
      )
      this.state.storage.sql.exec(
        'DELETE FROM issued WHERE public_key = ?',
        publicKey
      )
    })
    await this.state.storage.setAlarm(this.deps.now() + 60_000)
    await this.drainRevocations()
  }

  private async drainRevocations(): Promise<void> {
    if (!this.env.TURN_KEY_API_TOKEN) return
    const rows = this.rows<CredentialRow>(
      'SELECT * FROM revocations WHERE expires_at > ? LIMIT 20',
      this.deps.now()
    )
    await Promise.all(
      rows.map(async (row) => {
        if (row.key_id !== this.env.TURN_KEY_ID) return
        try {
          const response = await this.upstream(
            `https://rtc.live.cloudflare.com/v1/turn/keys/${row.key_id}/credentials/${encodeURIComponent(row.username)}/revoke`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${this.env.TURN_KEY_API_TOKEN}`,
              },
            }
          )
          if (response.ok || response.status === 404)
            this.state.storage.sql.exec(
              'DELETE FROM revocations WHERE username = ?',
              row.username
            )
        } catch {
          /* Retry the durable queue until the credential expires. */
        }
      })
    )
  }

  async alarm(): Promise<void> {
    this.clean()
    await this.drainRevocations()
    if (this.rows('SELECT username FROM revocations LIMIT 1').length)
      await this.state.storage.setAlarm(this.deps.now() + 60_000)
  }

  private async unlink(
    publicKey: string,
    payload: JsonObject
  ): Promise<BrokerStatus> {
    fields(payload, ['provider', 'subject'])
    const selected = provider(payload.provider)
    const selectedSubject = subject(payload.subject, selected)
    this.state.storage.sql.exec(
      'DELETE FROM links WHERE public_key = ? AND provider = ? AND subject = ?',
      publicKey,
      selected,
      selectedSubject
    )
    this.state.storage.sql.exec(
      'DELETE FROM logins WHERE public_key = ?',
      publicKey
    )
    await this.queueRevocations(publicKey)
    return this.status(publicKey)
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (url.origin !== origin(this.env))
        throw new BrokerFailure('invalid_request')
      const ip = await this.ip(request)
      this.state.storage.transactionSync(() => {
        this.clean()
        this.rate(`ip:${ip}`, 300, 60_000)
        this.rate('requests-global', 3000, 60_000)
      })
      if (request.method === 'GET' && url.pathname === '/oauth/start')
        return await this.oauthStart(url)
      if (
        request.method === 'GET' &&
        /^\/oauth\/callback\/(github|google)$/.test(url.pathname)
      )
        return await this.oauthCallback(request, url)
      if (request.method !== 'POST' || url.search)
        throw new BrokerFailure('invalid_request')
      if (
        request.headers.get('Content-Type')?.split(';')[0].trim() !==
        'application/json'
      )
        throw new BrokerFailure('invalid_request')
      const input = await boundedJson(
        new Response(request.body),
        MAX_BODY_BYTES
      )
      if (url.pathname === '/v1/challenge') {
        const body = object(input)
        fields(body, ['publicKey', 'action'])
        const publicKey = text(body.publicKey, PUBLIC_KEY)
        if (!BROKER_ACTIONS.includes(body.action as BrokerAction))
          throw new BrokerFailure('invalid_request')
        const nonce = random()
        const expiresAt = this.deps.now() + BROKER_CHALLENGE_MS
        this.state.storage.transactionSync(() => {
          this.rate(`challenge:${publicKey}`, 180, 60_000)
          this.state.storage.sql.exec(
            'INSERT INTO nonces(nonce, public_key, action, expires_at, ip) VALUES (?, ?, ?, ?, ?)',
            nonce,
            publicKey,
            body.action,
            expiresAt,
            ip
          )
        })
        return json({ nonce, expiresAt })
      }
      const action = url.pathname.slice('/v1/'.length) as BrokerAction
      if (!url.pathname.startsWith('/v1/') || !BROKER_ACTIONS.includes(action))
        throw new BrokerFailure('invalid_request')
      const signed = await this.authenticate(action, input, ip)
      const { publicKey, payload } = signed
      switch (action) {
        case 'status':
          fields(payload, [])
          return json(this.status(publicKey))
        case 'login':
          return json(await this.startLogin(publicKey, payload))
        case 'poll':
          return json(this.poll(publicKey, payload))
        case 'confirm':
          return json(this.confirm(publicKey, payload))
        case 'credentials':
          return json(await this.credentials(publicKey, payload))
        case 'unlink':
          return json(await this.unlink(publicKey, payload))
      }
    } catch (error) {
      return failure(error)
    }
  }
}

export default {
  async fetch(request: Request, env: BrokerEnv): Promise<Response> {
    try {
      const expectedOrigin = origin(env)
      const url = new URL(request.url)
      const callerOrigin = request.headers.get('Origin')
      const allowedOrigins = [
        expectedOrigin,
        'tauri://localhost',
        'http://tauri.localhost',
        'https://tauri.localhost',
      ]
      if (
        url.origin !== expectedOrigin ||
        (callerOrigin && !allowedOrigins.includes(callerOrigin))
      )
        throw new BrokerFailure('unauthorized', 401)
      const headers: Record<string, string> = {
        ...COMMON_HEADERS,
        Vary: 'Origin',
      }
      if (callerOrigin) headers['Access-Control-Allow-Origin'] = callerOrigin
      if (request.method === 'OPTIONS') {
        headers['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS'
        headers['Access-Control-Allow-Headers'] = 'Content-Type'
        headers['Access-Control-Max-Age'] = '600'
        return new Response(null, { status: 204, headers })
      }
      if (!env.BROKER) throw new BrokerFailure('unavailable', 503)
      const response =
        await env.BROKER.getByName('studyvis-turn-v1').fetch(request)
      const result = new Response(response.body, response)
      for (const [key, value] of Object.entries(headers))
        result.headers.set(key, value)
      return result
    } catch (error) {
      return failure(error)
    }
  },
}
