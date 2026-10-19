export const MIRROR_APP_COMMANDS = [
  'home.read',
  'home.invite',
  'home.accept',
  'home.rejoin',
  'home.end_interrupted',
  'friends.read',
  'friends.card',
  'friends.prepare_import',
  'friends.commit_import',
  'friends.pair',
  'friends.remove',
  'friends.backup_export',
  'friends.backup_import',
  'history.list',
  'history.report',
  'history.delete',
  'history.clear',
  'stats.read',
  'stats.export',
  'exports.read',
  'exports.release',
  'settings.read',
  'settings.update',
  'models.read',
  'models.download',
  'models.cancel',
  'models.select',
  'models.benchmark',
  'models.remove',
  'engine.read',
  'engine.install',
  'engine.restart',
  'engine.device',
  'identity.rename',
  'identity.prepare_recovery',
  'identity.commit_recovery',
  'identity.prepare_create',
  'identity.commit_create',
  'system.autostart',
  'system.diagnostics',
  'system.open_data_folder',
  'system.open_log',
  'system.replay_onboarding',
  'system.relaunch',
  'updater.read',
  'updater.check',
  'updater.install',
  'session.control',
] as const

export type MirrorAppCommandName = (typeof MIRROR_APP_COMMANDS)[number]
export type MirrorAppJson =
  | null
  | boolean
  | number
  | string
  | MirrorAppJson[]
  | { [key: string]: MirrorAppJson }
export type MirrorAppError =
  | 'invalid_request'
  | 'unsupported'
  | 'stale_owner'
  | 'stale_session'
  | 'stale_revision'
  | 'cancelled'
  | 'busy'
  | 'expired'
  | 'request_conflict'
  | 'failed'
  | 'invalid_result'

export type MirrorAppRequest = {
  version: 1
  requestId: string
  ownerEpoch: string
  sessionActivationId: string | null
  expectedRevision: number
  command: MirrorAppCommandName
  args: MirrorAppJson
}

export type MirrorAppResult = {
  version: 1
  requestId: string
  ownerEpoch: string
} & ({ ok: true; value: MirrorAppJson } | { ok: false; error: MirrorAppError })

export type MirrorAppSnapshot = {
  version: 1
  ownerEpoch: string
  revision: number
  phase:
    'loading' | 'identity_error' | 'onboarding' | 'home' | 'session' | 'report'
  identity: { edPubkeyHex: string; displayName: string } | null
  sessionActivationId: string | null
  capabilities: MirrorAppCommandName[]
}

export type MirrorAppJob = {
  ownerEpoch: string
  jobId: string
  revision: number
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number | null
}

const commands: ReadonlySet<string> = new Set(MIRROR_APP_COMMANDS)
const errors: ReadonlySet<string> = new Set([
  'invalid_request',
  'unsupported',
  'stale_owner',
  'stale_session',
  'stale_revision',
  'cancelled',
  'busy',
  'expired',
  'request_conflict',
  'failed',
  'invalid_result',
])
const phases: ReadonlySet<string> = new Set([
  'loading',
  'identity_error',
  'onboarding',
  'home',
  'session',
  'report',
])
const unsafeKeys =
  /^(?:__proto__|prototype|constructor|ed_?priv(?:ate)?(?:_?hex)?|x_?priv(?:ate)?(?:_?hex)?|private_?key|mnemonic|password|session_?password|credential|token|model_?path|mmproj_?path|log_?path|app_?log_?path)$/i

export const appId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)
export const appRevision = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
export const appRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype ||
    Object.getPrototypeOf(v) === null)

export function appFields(
  v: Record<string, unknown>,
  fields: readonly string[]
): boolean {
  return (
    Object.keys(v).length === fields.length &&
    fields.every((k) => Object.hasOwn(v, k))
  )
}

export function isMirrorAppCommand(v: unknown): v is MirrorAppCommandName {
  return typeof v === 'string' && commands.has(v)
}

// Domain ports must additionally parse their exact semantic input schema.
export function isMirrorAppJson(
  v: unknown,
  publicResult = false
): v is MirrorAppJson {
  let count = 0
  let bytes = 0
  const walk = (value: unknown, depth: number): boolean => {
    if (++count > 8192 || depth > 12) return false
    if (value === null || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value === 'string') {
      bytes += value.length
      return value.length <= 262_144 && bytes <= 524_288
    }
    if (Array.isArray(value))
      return (
        value.length <= 2048 && value.every((item) => walk(item, depth + 1))
      )
    if (!appRecord(value)) return false
    const entries = Object.entries(value)
    return (
      entries.length <= 128 &&
      entries.every(([key, item]) => {
        bytes += key.length
        return (
          key.length <= 128 &&
          bytes <= 524_288 &&
          !['__proto__', 'prototype', 'constructor'].includes(key) &&
          (!publicResult || !unsafeKeys.test(key)) &&
          walk(item, depth + 1)
        )
      })
    )
  }
  return walk(v, 0)
}

export function readMirrorAppRequest(v: unknown): MirrorAppRequest | null {
  if (
    !appRecord(v) ||
    !appFields(v, [
      'version',
      'requestId',
      'ownerEpoch',
      'sessionActivationId',
      'expectedRevision',
      'command',
      'args',
    ]) ||
    v.version !== 1 ||
    !appId(v.requestId) ||
    !appId(v.ownerEpoch) ||
    !(v.sessionActivationId === null || appId(v.sessionActivationId)) ||
    !appRevision(v.expectedRevision) ||
    !isMirrorAppCommand(v.command) ||
    !isMirrorAppJson(v.args)
  )
    return null
  return {
    version: 1,
    requestId: v.requestId,
    ownerEpoch: v.ownerEpoch,
    sessionActivationId: v.sessionActivationId,
    expectedRevision: v.expectedRevision,
    command: v.command,
    args: v.args,
  }
}

export function readMirrorAppSnapshot(v: unknown): MirrorAppSnapshot | null {
  if (
    !appRecord(v) ||
    !appFields(v, [
      'version',
      'ownerEpoch',
      'revision',
      'phase',
      'identity',
      'sessionActivationId',
      'capabilities',
    ]) ||
    v.version !== 1 ||
    !appId(v.ownerEpoch) ||
    !appRevision(v.revision) ||
    typeof v.phase !== 'string' ||
    !phases.has(v.phase) ||
    !(v.sessionActivationId === null || appId(v.sessionActivationId)) ||
    !Array.isArray(v.capabilities) ||
    v.capabilities.length > MIRROR_APP_COMMANDS.length ||
    !v.capabilities.every(isMirrorAppCommand) ||
    new Set(v.capabilities).size !== v.capabilities.length
  )
    return null
  if (v.phase === 'session' && v.sessionActivationId === null) return null
  if (
    v.identity !== null &&
    (!appRecord(v.identity) ||
      !appFields(v.identity, ['edPubkeyHex', 'displayName']) ||
      typeof v.identity.edPubkeyHex !== 'string' ||
      !/^[a-f0-9]{64}$/.test(v.identity.edPubkeyHex) ||
      typeof v.identity.displayName !== 'string' ||
      v.identity.displayName.length > 64)
  )
    return null
  const parsed = v as MirrorAppSnapshot
  return {
    ...parsed,
    identity: parsed.identity ? { ...parsed.identity } : null,
    capabilities: [...parsed.capabilities],
  }
}

export function readMirrorAppResult(v: unknown): MirrorAppResult | null {
  if (
    !appRecord(v) ||
    v.version !== 1 ||
    !appId(v.requestId) ||
    !appId(v.ownerEpoch)
  )
    return null
  if (
    v.ok === true &&
    appFields(v, ['version', 'requestId', 'ownerEpoch', 'ok', 'value']) &&
    isMirrorAppJson(v.value, true)
  )
    return v as MirrorAppResult
  if (
    v.ok === false &&
    appFields(v, ['version', 'requestId', 'ownerEpoch', 'ok', 'error']) &&
    typeof v.error === 'string' &&
    errors.has(v.error)
  )
    return v as MirrorAppResult
  return null
}

export function readMirrorAppJob(v: unknown): MirrorAppJob | null {
  return appRecord(v) &&
    appFields(v, ['ownerEpoch', 'jobId', 'revision', 'status', 'progress']) &&
    appId(v.ownerEpoch) &&
    appId(v.jobId) &&
    appRevision(v.revision) &&
    typeof v.status === 'string' &&
    ['pending', 'running', 'completed', 'failed', 'cancelled'].includes(
      v.status
    ) &&
    (v.progress === null ||
      (typeof v.progress === 'number' &&
        Number.isFinite(v.progress) &&
        v.progress >= 0 &&
        v.progress <= 1))
    ? (v as MirrorAppJob)
    : null
}
