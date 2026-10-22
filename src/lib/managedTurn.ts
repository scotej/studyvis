import {
  brokerSigningBytes,
  type BrokerAccount,
  type BrokerAction,
  type BrokerChallenge,
  type BrokerProvider,
  type JsonObject,
} from '../../services/turn-broker/protocol'
import { signWithKeyring } from '@/lib/db/identity'
import { bytesToHex } from '@/lib/encoding'
import type { TurnPreference } from '@/stores/settingsStore'

export const MANAGED_TURN_BROKER_ORIGIN =
  'https://studyvis-turn.ashcroft-estate.workers.dev'

const REQUEST_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 3_000
const RETRY_INTERVAL_MS = 30_000
const MAX_CREDENTIAL_TTL_MS = 60 * 60_000
const MAX_RESPONSE_BYTES = 32_768

export type ManagedTurnStatus =
  | 'idle'
  | 'checking'
  | 'signed-out'
  | 'pending'
  | 'confirm'
  | 'linked'
  | 'unavailable'
  | 'error'

export type ManagedTurnSnapshot = {
  identityEdPubkeyHex: string | null
  status: ManagedTurnStatus
  providers: Record<BrokerProvider, boolean>
  accounts: BrokerAccount[]
  approved: boolean
  relayEnabled: boolean
  freeOnlyConfirmed: boolean
  login: { transactionId: string; url: string; expiresAt: number } | null
  pendingAccount: BrokerAccount | null
  error: string | null
}

type CredentialLease = {
  publicKey: string
  iceServers: RTCIceServer[]
  expiresAt: number
}

type ControllerOptions = {
  fetch?: typeof fetch
  sign?: (message: Uint8Array) => Promise<Uint8Array>
  now?: () => number
}

function initialSnapshot(publicKey: string | null): ManagedTurnSnapshot {
  return {
    identityEdPubkeyHex: publicKey,
    status: 'idle',
    providers: { github: false, google: false },
    accounts: [],
    approved: false,
    relayEnabled: false,
    freeOnlyConfirmed: false,
    login: null,
    pendingAccount: null,
    error: null,
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function account(value: unknown): value is BrokerAccount {
  return (
    object(value) &&
    (value.provider === 'github' || value.provider === 'google') &&
    typeof value.subject === 'string' &&
    value.subject.length > 0 &&
    value.subject.length <= 256 &&
    typeof value.label === 'string' &&
    value.label.length > 0 &&
    value.label.length <= 320 &&
    typeof value.approved === 'boolean'
  )
}

export function managedTurnLoginTicket(raw: string): string | null {
  try {
    const url = new URL(raw)
    const ticket = url.searchParams.get('ticket')
    return url.origin === MANAGED_TURN_BROKER_ORIGIN &&
      url.pathname === '/oauth/start' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      [...url.searchParams].length === 1 &&
      ticket !== null &&
      /^[A-Za-z0-9_-]{43}$/.test(ticket)
      ? ticket
      : null
  } catch {
    return null
  }
}

class ManagedTurnRequestError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.code = code
  }
}

export class ManagedTurnController {
  private snapshot = initialSnapshot(null)
  private enabled = false
  private preference: TurnPreference = 'auto'
  private generation = 0
  private abort = new AbortController()
  private lease: CredentialLease | null = null
  private listeners = new Set<() => void>()
  private iceListeners = new Set<() => void>()
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private renewTimer: ReturnType<typeof setTimeout> | null = null
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private credentialRequest: Promise<void> | null = null
  private statusRequest: Promise<void> | null = null
  private readonly fetcher: typeof fetch
  private readonly sign: (message: Uint8Array) => Promise<Uint8Array>
  private readonly now: () => number

  constructor(options: ControllerOptions = {}) {
    this.fetcher = options.fetch ?? ((...args) => fetch(...args))
    this.sign = options.sign ?? signWithKeyring
    this.now = options.now ?? Date.now
  }

  getSnapshot = (): ManagedTurnSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeIceServers = (listener: () => void): (() => void) => {
    this.iceListeners.add(listener)
    return () => this.iceListeners.delete(listener)
  }

  getIceServers = (): RTCIceServer[] => {
    if (
      !this.canUseRelay() ||
      !this.lease ||
      this.lease.publicKey !== this.snapshot.identityEdPubkeyHex ||
      this.lease.expiresAt <= this.now()
    ) {
      return []
    }
    return structuredClone(this.lease.iceServers)
  }

  setIdentity(publicKey: string | null): void {
    const next = publicKey?.toLowerCase() ?? null
    if (next !== null && !/^[a-f0-9]{64}$/.test(next)) {
      throw new ManagedTurnRequestError('invalid_request')
    }
    if (next === this.snapshot.identityEdPubkeyHex) return
    this.enabled = false
    this.reset(next)
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.reset(this.snapshot.identityEdPubkeyHex)
    if (enabled && this.snapshot.identityEdPubkeyHex) {
      void this.refreshStatus().catch(() => {})
    }
  }

  setPreference(preference: TurnPreference): void {
    if (this.preference === preference) return
    this.preference = preference
    if (preference === 'never') {
      this.clearLease()
    } else if (this.canUseRelay()) {
      void this.refreshCredentials().catch(() => {})
    }
  }

  refreshStatus = (): Promise<void> => {
    if (!this.isActive()) return Promise.resolve()
    if (this.statusRequest) return this.statusRequest
    const generation = this.generation
    const accountGeneration = this.accountGeneration
    if (!this.snapshot.login) this.publish({ status: 'checking', error: null })
    const pending = this.request('status', {}, generation)
      .then((value) => {
        if (accountGeneration !== this.accountGeneration) return
        this.acceptStatus(value, generation)
        if (this.canUseRelay()) void this.refreshCredentials().catch(() => {})
      })
      .catch((error: unknown) => {
        if (accountGeneration === this.accountGeneration) {
          this.reportError(error, generation)
        }
        throw this.safeError(error)
      })
      .finally(() => {
        if (this.statusRequest === pending) this.statusRequest = null
      })
    this.statusRequest = pending
    return pending
  }

  startLogin = async (provider: BrokerProvider): Promise<string> => {
    const generation = this.generation
    this.requireActive(generation)
    if (this.pendingUnlinks > 0) {
      throw new ManagedTurnRequestError('cancelled')
    }
    const loginGeneration = ++this.loginGeneration
    this.clearPoll()
    this.publish({ login: null, pendingAccount: null, error: null })
    try {
      const value = await this.request(
        'login',
        { provider },
        generation,
        loginGeneration
      )
      if (
        !object(value) ||
        typeof value.transactionId !== 'string' ||
        value.transactionId.length === 0 ||
        value.transactionId.length > 256 ||
        typeof value.url !== 'string' ||
        !managedTurnLoginTicket(value.url) ||
        !this.validExpiry(value.expiresAt, 10 * 60_000)
      ) {
        throw new ManagedTurnRequestError('invalid_response')
      }
      this.requireActive(generation)
      if (loginGeneration !== this.loginGeneration) {
        throw new ManagedTurnRequestError('cancelled')
      }
      this.publish({
        status: 'pending',
        login: {
          transactionId: value.transactionId,
          url: value.url,
          expiresAt: value.expiresAt as number,
        },
      })
      this.schedulePoll()
      return value.url
    } catch (error) {
      if (loginGeneration !== this.loginGeneration) {
        throw new ManagedTurnRequestError('cancelled')
      }
      this.reportError(error, generation)
      throw this.safeError(error)
    }
  }

  cancelLogin = (): void => {
    this.loginGeneration += 1
    this.clearPoll()
    this.publish({
      login: null,
      pendingAccount: null,
      status: this.snapshot.accounts.length > 0 ? 'linked' : 'signed-out',
      error: null,
    })
  }

  pollLogin = async (): Promise<void> => {
    this.clearPoll()
    const generation = this.generation
    const loginGeneration = this.loginGeneration
    const login = this.snapshot.login
    if (!this.isActive() || !login || this.snapshot.status === 'confirm') return
    if (login.expiresAt <= this.now()) {
      this.publish({ status: 'error', error: 'expired', login: null })
      return
    }
    try {
      const value = await this.request(
        'poll',
        { transactionId: login.transactionId },
        generation,
        loginGeneration
      )
      if (!object(value)) throw new ManagedTurnRequestError('invalid_response')
      this.requireActive(generation)
      if (this.snapshot.login !== login) return
      if (value.state === 'ready' && account(value.account)) {
        this.publish({ status: 'confirm', pendingAccount: value.account })
      } else if (value.state === 'pending') {
        this.schedulePoll()
      } else if (value.state === 'failed' || value.state === 'expired') {
        this.publish({ status: 'error', error: value.state, login: null })
      } else {
        throw new ManagedTurnRequestError('invalid_response')
      }
    } catch (error) {
      if (this.snapshot.login !== login) return
      this.reportError(error, generation)
      if (generation === this.generation && this.snapshot.login === login) {
        this.schedulePoll(RETRY_INTERVAL_MS)
      }
      throw this.safeError(error)
    }
  }

  confirmLogin = async (): Promise<void> => {
    const generation = this.generation
    const loginGeneration = this.loginGeneration
    const { login, pendingAccount } = this.snapshot
    this.requireActive(generation)
    if (!login || !pendingAccount || login.expiresAt <= this.now()) {
      throw new ManagedTurnRequestError('expired')
    }
    const accountGeneration = ++this.accountGeneration
    this.statusRequest = null
    try {
      const value = await this.request(
        'confirm',
        {
          transactionId: login.transactionId,
          provider: pendingAccount.provider,
          subject: pendingAccount.subject,
        },
        generation,
        loginGeneration
      )
      this.requireActive(generation)
      if (
        this.snapshot.login !== login ||
        accountGeneration !== this.accountGeneration
      )
        return
      this.accountGeneration += 1
      this.statusRequest = null
      this.clearLease()
      this.clearPoll()
      this.publish({ login: null, pendingAccount: null })
      this.acceptStatus(value, generation)
      if (this.canUseRelay()) await this.refreshCredentials()
    } catch (error) {
      if (
        generation === this.generation &&
        loginGeneration === this.loginGeneration &&
        accountGeneration === this.accountGeneration
      ) {
        this.accountGeneration += 1
        this.statusRequest = null
        this.clearLease()
        this.publish({ approved: false })
        this.reportError(error, generation)
      }
      throw this.safeError(error)
    }
  }

  unlink = async (provider: BrokerProvider, subject: string): Promise<void> => {
    const generation = this.generation
    this.requireActive(generation)
    this.pendingUnlinks += 1
    // PR-499 — unlink deletes every broker login for this identity, including
    // actions still waiting for a challenge or keychain signature locally.
    this.loginGeneration += 1
    this.clearPoll()
    const accountGeneration = ++this.accountGeneration
    this.statusRequest = null
    // Stop local issuance before the server round-trip, including a previously
    // started renewal which might otherwise repopulate the cache afterwards.
    this.clearLease()
    this.publish({
      approved: false,
      login: null,
      pendingAccount: null,
      status: this.snapshot.accounts.length > 0 ? 'linked' : 'signed-out',
      error: null,
    })
    try {
      const value = await this.request(
        'unlink',
        { provider, subject },
        generation
      )
      this.requireActive(generation)
      if (accountGeneration !== this.accountGeneration) return
      this.accountGeneration += 1
      this.statusRequest = null
      this.clearLease()
      this.acceptStatus(value, generation)
      if (this.canUseRelay()) await this.refreshCredentials()
    } catch (error) {
      if (
        generation === this.generation &&
        accountGeneration === this.accountGeneration
      ) {
        this.accountGeneration += 1
        this.statusRequest = null
        this.clearLease()
        this.publish({ approved: false })
        this.reportError(error, generation)
      }
      throw this.safeError(error)
    } finally {
      if (generation === this.generation) this.pendingUnlinks -= 1
    }
  }

  refreshCredentials = (): Promise<void> => {
    if (!this.canUseRelay()) return Promise.resolve()
    if (this.credentialRequest) return this.credentialRequest
    const generation = this.generation
    const accountGeneration = this.accountGeneration
    const credentialGeneration = this.leaseGeneration
    const pending = this.request('credentials', {}, generation)
      .then((value) => {
        if (
          credentialGeneration !== this.leaseGeneration ||
          accountGeneration !== this.accountGeneration ||
          !this.canUseRelay()
        ) {
          return
        }
        if (
          !object(value) ||
          !this.validExpiry(value.expiresAt, MAX_CREDENTIAL_TTL_MS) ||
          !Array.isArray(value.iceServers) ||
          value.iceServers.length < 1 ||
          value.iceServers.length > 4
        ) {
          throw new ManagedTurnRequestError('invalid_response')
        }
        const iceServers = value.iceServers.map(
          (server: unknown): RTCIceServer => {
            if (
              !object(server) ||
              !Array.isArray(server.urls) ||
              server.urls.length < 1 ||
              server.urls.length > 8 ||
              !server.urls.every(
                (url: unknown) =>
                  typeof url === 'string' &&
                  /^turns?:turn\.cloudflare\.com:(3478|443|80|5349)\?transport=(udp|tcp)$/.test(
                    url
                  )
              ) ||
              typeof server.username !== 'string' ||
              server.username.length < 1 ||
              server.username.length > 512 ||
              typeof server.credential !== 'string' ||
              server.credential.length < 1 ||
              server.credential.length > 512
            ) {
              throw new ManagedTurnRequestError('invalid_response')
            }
            return {
              urls: [...server.urls] as string[],
              username: server.username,
              credential: server.credential,
            }
          }
        )
        this.requireActive(generation)
        this.lease = {
          publicKey: this.snapshot.identityEdPubkeyHex!,
          iceServers,
          expiresAt: value.expiresAt as number,
        }
        this.emitIce()
        this.scheduleLease()
      })
      .catch((error: unknown) => {
        if (
          generation !== this.generation ||
          accountGeneration !== this.accountGeneration ||
          credentialGeneration !== this.leaseGeneration
        )
          return
        this.reportError(error, generation)
        if (generation === this.generation && this.canUseRelay()) {
          this.scheduleRenew(RETRY_INTERVAL_MS)
        }
        throw this.safeError(error)
      })
      .finally(() => {
        if (this.credentialRequest === pending) this.credentialRequest = null
      })
    this.credentialRequest = pending
    return pending
  }

  resume = (): void => {
    if (!this.isActive()) return
    if (this.lease && this.lease.expiresAt <= this.now()) this.clearLease()
    if (this.snapshot.login && !this.snapshot.pendingAccount) {
      void this.pollLogin().catch(() => {})
    }
    void this.refreshStatus().catch(() => {})
  }

  dispose(): void {
    this.enabled = false
    this.reset(null)
  }

  private leaseGeneration = 0
  private loginGeneration = 0
  private accountGeneration = 0
  private pendingUnlinks = 0

  private reset(publicKey: string | null): void {
    this.generation += 1
    this.accountGeneration += 1
    this.loginGeneration += 1
    this.pendingUnlinks = 0
    this.abort.abort()
    this.abort = new AbortController()
    this.statusRequest = null
    this.credentialRequest = null
    this.clearPoll()
    this.clearLease()
    this.snapshot = initialSnapshot(publicKey)
    for (const listener of this.listeners) listener()
  }

  private clearPoll(): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  private clearLease(): void {
    this.leaseGeneration += 1
    this.credentialRequest = null
    this.lease = null
    if (this.renewTimer !== null) clearTimeout(this.renewTimer)
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer)
    this.renewTimer = null
    this.expiryTimer = null
    this.emitIce()
  }

  private publish(change: Partial<ManagedTurnSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change }
    for (const listener of this.listeners) listener()
  }

  private emitIce(): void {
    for (const listener of this.iceListeners) listener()
  }

  private isActive(): boolean {
    return this.enabled && this.snapshot.identityEdPubkeyHex !== null
  }

  private canUseRelay(): boolean {
    return (
      this.isActive() &&
      this.preference !== 'never' &&
      this.snapshot.approved &&
      this.snapshot.relayEnabled &&
      this.snapshot.freeOnlyConfirmed
    )
  }

  private requireActive(generation: number, loginGeneration?: number): void {
    if (
      !this.isActive() ||
      generation !== this.generation ||
      (loginGeneration !== undefined &&
        loginGeneration !== this.loginGeneration)
    ) {
      throw new ManagedTurnRequestError('cancelled')
    }
  }

  private validExpiry(value: unknown, maxTtl: number): value is number {
    return (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value > this.now() &&
      value <= this.now() + maxTtl + 5_000
    )
  }

  private acceptStatus(value: unknown, generation: number): void {
    this.requireActive(generation)
    if (
      !object(value) ||
      !object(value.providers) ||
      typeof value.providers.github !== 'boolean' ||
      typeof value.providers.google !== 'boolean' ||
      !Array.isArray(value.links) ||
      value.links.length > 8 ||
      !value.links.every(account) ||
      typeof value.approved !== 'boolean' ||
      typeof value.enabled !== 'boolean' ||
      typeof value.freeOnlyConfirmed !== 'boolean'
    ) {
      throw new ManagedTurnRequestError('invalid_response')
    }
    this.publish({
      providers: {
        github: value.providers.github,
        google: value.providers.google,
      },
      accounts: value.links,
      approved: value.approved,
      relayEnabled: value.enabled,
      freeOnlyConfirmed: value.freeOnlyConfirmed,
      status: this.snapshot.login
        ? this.snapshot.pendingAccount
          ? 'confirm'
          : 'pending'
        : value.links.length > 0
          ? 'linked'
          : 'signed-out',
      error: null,
    })
    if (!this.canUseRelay()) this.clearLease()
  }

  private schedulePoll(delay = POLL_INTERVAL_MS): void {
    this.clearPoll()
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.pollLogin().catch(() => {})
    }, delay)
  }

  private scheduleRenew(delay: number): void {
    if (this.renewTimer !== null) clearTimeout(this.renewTimer)
    this.renewTimer = setTimeout(() => {
      this.renewTimer = null
      void this.refreshCredentials().catch(() => {})
    }, delay)
  }

  private scheduleLease(): void {
    if (!this.lease) return
    const remaining = this.lease.expiresAt - this.now()
    this.scheduleRenew(
      Math.max(1_000, remaining - Math.min(10 * 60_000, remaining * 0.2))
    )
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer)
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null
      this.lease = null
      this.emitIce()
    }, remaining)
  }

  private safeError(error: unknown): ManagedTurnRequestError {
    return error instanceof ManagedTurnRequestError
      ? error
      : new ManagedTurnRequestError('unavailable')
  }

  private reportError(error: unknown, generation: number): void {
    if (generation !== this.generation) return
    const code = this.safeError(error).code
    if (code === 'cancelled') return
    if (code === 'unauthorized' || code === 'disabled') this.clearLease()
    this.publish({
      status:
        code === 'unavailable' || code === 'disabled' ? 'unavailable' : 'error',
      error: code,
    })
  }

  private async request(
    action: BrokerAction,
    payload: JsonObject,
    generation: number,
    loginGeneration?: number
  ): Promise<unknown> {
    this.requireActive(generation, loginGeneration)
    const publicKey = this.snapshot.identityEdPubkeyHex!
    const challenge = await this.post(
      '/v1/challenge',
      { publicKey, action },
      generation,
      loginGeneration
    )
    if (
      !object(challenge) ||
      typeof challenge.nonce !== 'string' ||
      challenge.nonce.length < 32 ||
      challenge.nonce.length > 256 ||
      !this.validExpiry(challenge.expiresAt, 60_000)
    ) {
      throw new ManagedTurnRequestError('invalid_response')
    }
    this.requireActive(generation, loginGeneration)
    const message = brokerSigningBytes(
      MANAGED_TURN_BROKER_ORIGIN,
      action,
      publicKey,
      challenge as BrokerChallenge,
      payload
    )
    const signature = await this.sign(message)
    this.requireActive(generation, loginGeneration)
    if (signature.length !== 64)
      throw new ManagedTurnRequestError('unauthorized')
    return this.post(
      `/v1/${action}`,
      {
        publicKey,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
        payload,
        signature: bytesToHex(signature),
      },
      generation,
      loginGeneration
    )
  }

  private async post(
    path: string,
    body: object,
    generation: number,
    loginGeneration?: number
  ): Promise<unknown> {
    this.requireActive(generation, loginGeneration)
    const abort = new AbortController()
    const epochSignal = this.abort.signal
    const cancel = () => abort.abort()
    epochSignal.addEventListener('abort', cancel, { once: true })
    const timeout = setTimeout(cancel, REQUEST_TIMEOUT_MS)
    try {
      const response = await this.fetcher(
        `${MANAGED_TURN_BROKER_ORIGIN}${path}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: abort.signal,
        }
      )
      this.requireActive(generation, loginGeneration)
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
        throw new ManagedTurnRequestError('invalid_response')
      }
      const text = await response.text()
      this.requireActive(generation, loginGeneration)
      if (text.length > MAX_RESPONSE_BYTES)
        throw new ManagedTurnRequestError('invalid_response')
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        throw new ManagedTurnRequestError('invalid_response')
      }
      if (!response.ok) {
        const allowed = [
          'invalid_request',
          'unauthorized',
          'conflict',
          'rate_limited',
          'unavailable',
          'disabled',
        ]
        throw new ManagedTurnRequestError(
          object(value) &&
            typeof value.error === 'string' &&
            allowed.includes(value.error)
            ? value.error
            : 'unavailable'
        )
      }
      return value
    } finally {
      clearTimeout(timeout)
      epochSignal.removeEventListener('abort', cancel)
    }
  }
}

export const managedTurn = new ManagedTurnController()
