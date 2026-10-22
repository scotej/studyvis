export type BrokerProvider = 'github' | 'google'
export type BrokerAction =
  'status' | 'login' | 'poll' | 'confirm' | 'credentials' | 'unlink'

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }
export type BrokerChallenge = { nonce: string; expiresAt: number }
export type BrokerSignedRequest = BrokerChallenge & {
  publicKey: string
  payload: JsonObject
  signature: string
}
export type BrokerAccount = {
  provider: BrokerProvider
  subject: string
  label: string
  approved: boolean
}
export type BrokerStatus = {
  providers: Record<BrokerProvider, boolean>
  links: BrokerAccount[]
  approved: boolean
  enabled: boolean
  freeOnlyConfirmed: boolean
  revocationPending?: boolean
}
export type BrokerLogin = {
  transactionId: string
  url: string
  expiresAt: number
}
export type BrokerPoll = {
  state: 'pending' | 'ready' | 'failed' | 'expired'
  account?: BrokerAccount
  expiresAt: number
}
export type BrokerIceServer = {
  urls: string[]
  username: string
  credential: string
}
export type BrokerCredentials = {
  iceServers: BrokerIceServer[]
  expiresAt: number
}
export type BrokerErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'conflict'
  | 'rate_limited'
  | 'unavailable'
  | 'disabled'

export const BROKER_ACTIONS: readonly BrokerAction[] = [
  'status',
  'login',
  'poll',
  'confirm',
  'credentials',
  'unlink',
]
export const BROKER_CHALLENGE_MS = 60_000
export const BROKER_LOGIN_MS = 600_000
export const BROKER_CREDENTIAL_MS = 3_600_000

export function canonicalBrokerJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('invalid protocol number')
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalBrokerJson).join(',')}]`
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalBrokerJson(value[key])}`)
    .join(',')}}`
}

export function brokerSigningBytes(
  audience: string,
  action: BrokerAction,
  publicKey: string,
  challenge: BrokerChallenge,
  payload: JsonObject
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    [
      'StudyVis TURN broker v1',
      audience,
      action,
      publicKey,
      challenge.nonce,
      String(challenge.expiresAt),
      canonicalBrokerJson(payload),
    ].join('\n')
  )
}
