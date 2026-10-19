import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  writes: [] as Record<string, unknown>[],
  readFailures: 0,
  writeFailures: 0,
  fallbackFailures: 0,
  writeAckFailures: 0,
  fallbackAckFailures: 0,
  saveGate: null as Promise<void> | null,
  friendsGate: null as Promise<void> | null,
  keyWrites: 0,
  record: null as Record<string, unknown> | null,
  focus: {
    score: 70,
    focusedPct: 0.75,
    confidentSamples: 12,
    skippedSamples: 2,
    aiEnabled: 1,
  },
}))

vi.mock('@/lib/db/sessions', () => {
  const record = (row: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase()),
        value,
      ])
    )
  return {
    sessionsGet: vi.fn(async (id: string) => {
      if (state.readFailures > 0) {
        state.readFailures -= 1
        throw new Error('database unavailable')
      }
      return state.rows.get(id) ?? null
    }),
    sessionsInsert: vi.fn(async (row: Record<string, unknown>) => {
      state.writes.push(structuredClone(row))
      if (state.saveGate) await state.saveGate
      if (state.writeFailures > 0) {
        state.writeFailures -= 1
        throw new Error('database write failed')
      }
      state.rows.set(row.id as string, record(row))
      if (state.writeAckFailures > 0) {
        state.writeAckFailures -= 1
        throw new Error('upsert acknowledgement lost')
      }
    }),
    sessionsInsertIfAbsent: vi.fn(async (row: Record<string, unknown>) => {
      if (state.fallbackFailures > 0) {
        state.fallbackFailures -= 1
        throw new Error('fallback write failed')
      }
      if (state.rows.has(row.id as string)) return false
      state.rows.set(row.id as string, record(row))
      if (state.fallbackAckFailures > 0) {
        state.fallbackAckFailures -= 1
        throw new Error('fallback acknowledgement lost')
      }
      return true
    }),
  }
})
vi.mock('@/lib/db/identity', () => ({
  IDENTITY_VERSION: 1,
  identityExists: async () => state.record !== null,
  loadIdentityRecord: async () => state.record,
  identityKeysStatus: async () => 'matching',
  saveKeys: async () => {
    state.keyWrites += 1
  },
  saveIdentityRecord: async (record: Record<string, unknown>) => {
    state.record = record
  },
  signWithKeyring: async () => new Uint8Array(64),
  boxEncryptWithKeyring: vi.fn(),
  boxDecryptWithKeyring: vi.fn(),
}))
vi.mock('@/features/ai/focusStore', () => ({
  snapshotFocusForReport: () => state.focus,
}))
vi.mock('@/stores/friendsStore', () => ({
  useFriendsStore: {
    getState: () => ({
      markStudiedAt: async () => {
        await state.friendsGate
      },
    }),
  },
}))

import { leaveForIdentityRecovery } from '@/features/settings/leaveForIdentityRecovery'
import { buildLeaveHandler } from '@/features/session/lifecycle'
import { hostSession } from '@/features/session/host'
import { joinSession, rejoinSession } from '@/features/session/join'
import { generateIdentity, mnemonicFingerprint } from '@/lib/crypto/identity'
import { bytesToHex } from '@/lib/encoding'
import { sessionsGet } from '@/lib/db/sessions'
import type { TopicRoom } from '@/lib/trystero'
import { useIdentityStore } from '@/stores/identityStore'
import { createSessionStore, useSessionStore } from '@/stores/sessionStore'
import { strings } from '@/strings'

const identity = generateIdentity()
const replacement = generateIdentity()
const topic = 'c'.repeat(64)
const T0 = 1_700_000_000_000
const MIN = 60_000

beforeEach(async () => {
  state.rows.clear()
  state.writes.length = 0
  state.readFailures = state.writeFailures = state.fallbackFailures = 0
  state.writeAckFailures = state.fallbackAckFailures = 0
  state.saveGate = state.friendsGate = null
  state.keyWrites = 0
  Object.assign(state.focus, {
    score: 70,
    focusedPct: 0.75,
    confidentSamples: 12,
    skippedSamples: 2,
    aiEnabled: 1,
  })
  state.record = {
    version: 1,
    ed_pubkey_hex: bytesToHex(identity.edPub),
    x_pubkey_hex: bytesToHex(identity.xPub),
    display_name: 'Original participant',
    created_at: T0,
    mnemonic_fingerprint: mnemonicFingerprint(identity.mnemonic),
  }
  await useIdentityStore.getState().actions.refresh()
  useSessionStore.getState().setPendingSave(null)
  useSessionStore.getState().reset()
  vi.clearAllMocks()
})

afterEach(() => {
  useSessionStore.getState().setPendingSave(null)
  useSessionStore.getState().reset()
  vi.useRealTimers()
})

function beginProductionLeave() {
  vi.useFakeTimers()
  vi.setSystemTime(T0 + 17 * MIN)
  const announceLeave = vi.fn(async () => {})
  const room = { leave: vi.fn(async () => {}) }
  const leave = buildLeaveHandler({
    room: room as unknown as TopicRoom,
    topic,
    startedAt: T0 + 12 * MIN,
    continuesFocus: true,
    localEdPubkey: bytesToHex(identity.edPub),
    localDisplayName: 'Original participant',
  })
  useSessionStore.getState().setPendingInitialTopic('Maths')
  useSessionStore.getState().begin({
    room: room as unknown as TopicRoom,
    leave,
    sessionTopic: topic,
    sessionPassword: 'test',
    isHost: true,
    startedAt: T0 + 12 * MIN,
  })
  useSessionStore.setState({ announceLeave })
  return { room, leave, announceLeave }
}

function priorStint() {
  state.rows.set(topic, {
    id: topic,
    started_at: T0,
    ended_at: T0 + 10 * MIN,
    total_minutes: 10,
    total_duration_ms: 10 * MIN,
    peer_pubkeys: null,
    peer_presence_ms: '{}',
    declared_topic: 'Maths',
    score: 80,
    focused_pct: 0.8,
    confident_samples: 8,
    skipped_samples: 1,
    generated_at: T0 + 10 * MIN,
    ai_enabled: 1,
    local_ed_pubkey: bytesToHex(identity.edPub),
    local_display_name: 'Original participant',
  })
}

function differentIdentityCommit() {
  return useIdentityStore
    .getState()
    .actions.recover(replacement.mnemonic)
    .commit()
}

test('identity settings awaits the ordinary session leave/persistence handler', async () => {
  let finish!: () => void
  const persisted = new Promise<void>((resolve) => (finish = resolve))
  const leave = vi.fn(async () => {
    await persisted
    useSessionStore.getState().markEnded()
  })
  useSessionStore.getState().begin({
    sessionTopic: 'topic',
    sessionPassword: 'password',
    isHost: true,
    startedAt: 1,
    room: {} as never,
    leave,
  })
  const leaving = leaveForIdentityRecovery()
  expect(leave).toHaveBeenCalledOnce()
  expect(useSessionStore.getState().pendingEndReason).toBe('user')
  expect(useSessionStore.getState().status).toBe('active')
  finish()
  await leaving
  expect(useSessionStore.getState().status).toBe('ended')
})

test('a failed leave keeps the session active and makes the ordinary path retryable', async () => {
  const leave = vi.fn(async () => {
    throw new Error('persistence unavailable')
  })
  useSessionStore.getState().begin({
    sessionTopic: 'topic',
    sessionPassword: 'password',
    isHost: true,
    startedAt: 1,
    room: {} as never,
    leave,
  })
  await expect(leaveForIdentityRecovery()).rejects.toThrow(
    'persistence unavailable'
  )
  expect(useSessionStore.getState().status).toBe('active')
  expect(useSessionStore.getState().pendingEndReason).toBeNull()
  await expect(leaveForIdentityRecovery()).rejects.toThrow()
  expect(leave).toHaveBeenCalledTimes(2)
})

test('a real failed upsert blocks identity replacement through reset and concurrent retry saves only its frozen row', async () => {
  priorStint()
  state.writeFailures = 1
  const { room, leave, announceLeave } = beginProductionLeave()
  await expect(leaveForIdentityRecovery()).rejects.toThrow(
    strings.session.errors.savePending
  )
  expect(room.leave).toHaveBeenCalledOnce()
  expect(useSessionStore.getState().status).toBe('ended')
  expect(state.rows.get(topic)?.total_minutes).toBe(10)
  await expect(differentIdentityCommit()).rejects.toThrow(
    strings.identity.sessionRestoreBlocked
  )
  expect(state.keyWrites).toBe(0)

  const pending = useSessionStore.getState().pendingSave!
  useSessionStore.getState().reset()
  expect(useSessionStore.getState().pendingSave).toBe(pending)
  Object.assign(state.focus, { score: 5, confidentSamples: 99 })
  useIdentityStore.setState((s) => ({
    identity: { ...s.identity!, display_name: 'Later name' },
  }))
  for (const start of [
    () => hostSession(),
    () => joinSession(topic, 'test'),
    () => rejoinSession(topic, 'test', true),
    () =>
      useSessionStore.getState().begin({
        room: {} as never,
        leave,
        sessionTopic: topic,
        sessionPassword: 'test',
        isHost: true,
        startedAt: T0,
      }),
  ])
    expect(start).toThrow(strings.session.errors.savePending)
  await expect(differentIdentityCommit()).rejects.toThrow(
    strings.identity.sessionRestoreBlocked
  )

  let release!: () => void
  state.saveGate = new Promise<void>((resolve) => {
    release = resolve
  })
  const retry = leaveForIdentityRecovery()
  const concurrent = leaveForIdentityRecovery()
  expect(state.writes).toHaveLength(2)
  await expect(differentIdentityCommit()).rejects.toThrow(
    strings.identity.sessionRestoreBlocked
  )
  release()
  await Promise.all([retry, concurrent])
  expect(state.writes[1]).toEqual(state.writes[0])
  expect(state.rows.get(topic)).toMatchObject({
    started_at: T0,
    ended_at: T0 + 17 * MIN,
    total_minutes: 15,
    total_duration_ms: 15 * MIN,
    score: 70,
    confident_samples: 12,
    declared_topic: 'Maths',
    local_ed_pubkey: bytesToHex(identity.edPub),
    local_display_name: 'Original participant',
  })
  expect(room.leave).toHaveBeenCalledOnce()
  expect(sessionsGet).toHaveBeenCalledOnce()
  expect(announceLeave).toHaveBeenCalledOnce()
  expect(announceLeave.mock.invocationCallOrder[0]).toBeLessThan(
    room.leave.mock.invocationCallOrder[0]
  )
  expect(useSessionStore.getState().pendingSave).toBeNull()
  await differentIdentityCommit()
  expect(state.record?.ed_pubkey_hex).toBe(bytesToHex(replacement.edPub))
})

test.each(['failure', 'existing row'] as const)(
  'an indeterminate read plus fallback %s keeps identity blocked until a real durable retry',
  async (outcome) => {
    if (outcome === 'existing row') priorStint()
    state.readFailures = 2
    state.fallbackFailures = outcome === 'failure' ? 1 : 0
    const { room } = beginProductionLeave()
    await expect(leaveForIdentityRecovery()).rejects.toThrow(
      strings.session.errors.savePending
    )
    await expect(differentIdentityCommit()).rejects.toThrow(
      strings.identity.sessionRestoreBlocked
    )
    await leaveForIdentityRecovery()
    expect(state.rows.get(topic)?.total_minutes).toBe(
      outcome === 'existing row' ? 15 : 5
    )
    expect(room.leave).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().pendingSave).toBeNull()
    await differentIdentityCommit()
  }
)

test.each(['upsert', 'fallback'] as const)(
  'a committed %s with a lost acknowledgement is never merged a second time',
  async (operation) => {
    if (operation === 'upsert') {
      priorStint()
      state.writeAckFailures = 1
    } else {
      state.readFailures = 2
      state.fallbackAckFailures = 1
    }
    const { room } = beginProductionLeave()
    await expect(leaveForIdentityRecovery()).rejects.toThrow(
      strings.session.errors.savePending
    )
    const minutes = operation === 'upsert' ? 15 : 5
    expect(state.rows.get(topic)?.total_minutes).toBe(minutes)
    await leaveForIdentityRecovery()
    expect(state.rows.get(topic)?.total_minutes).toBe(minutes)
    expect(state.rows.get(topic)?.total_duration_ms).toBe(minutes * MIN)
    expect(room.leave).toHaveBeenCalledOnce()
    expect(state.writes).toHaveLength(operation === 'upsert' ? 2 : 0)
    expect(useSessionStore.getState().pendingSave).toBeNull()
  }
)

test('a failed retry stays actionable and same-identity recovery remains available', async () => {
  state.writeFailures = 2
  const { room } = beginProductionLeave()
  await expect(leaveForIdentityRecovery()).rejects.toThrow(
    strings.session.errors.savePending
  )
  await expect(leaveForIdentityRecovery()).rejects.toThrow(
    'database write failed'
  )
  expect(useSessionStore.getState().pendingSave).not.toBeNull()
  await useIdentityStore.getState().actions.recover(identity.mnemonic).commit()
  await expect(differentIdentityCommit()).rejects.toThrow(
    strings.identity.sessionRestoreBlocked
  )
  await leaveForIdentityRecovery()
  expect(room.leave).toHaveBeenCalledOnce()
  expect(state.writes).toHaveLength(3)
  expect(useSessionStore.getState().pendingSave).toBeNull()
})

test('a successful write does not release admission before the original leave finishes', async () => {
  let release!: () => void
  state.friendsGate = new Promise<void>((resolve) => {
    release = resolve
  })
  beginProductionLeave()
  const leaving = leaveForIdentityRecovery()
  await vi.waitFor(() => expect(state.rows.has(topic)).toBe(true))
  expect(useSessionStore.getState().status).toBe('active')
  expect(() => hostSession()).toThrow(strings.session.errors.savePending)
  await expect(differentIdentityCommit()).rejects.toThrow(
    strings.identity.sessionRestoreBlocked
  )
  release()
  await leaving
  expect(useSessionStore.getState().status).toBe('ended')
  expect(useSessionStore.getState().pendingSave).toBeNull()
  await differentIdentityCommit()
})

test('concurrent Settings leave calls share the actual failing teardown and pending save', async () => {
  let release!: () => void
  state.saveGate = new Promise<void>((resolve) => {
    release = resolve
  })
  state.writeFailures = 1
  const { room } = beginProductionLeave()
  const first = leaveForIdentityRecovery()
  const second = leaveForIdentityRecovery()
  const settled = Promise.allSettled([first, second])
  await vi.waitFor(() => expect(state.writes).toHaveLength(1))
  release()
  expect((await settled).map((result) => result.status)).toEqual([
    'rejected',
    'rejected',
  ])
  expect(room.leave).toHaveBeenCalledOnce()
  expect(useSessionStore.getState().pendingSave).not.toBeNull()
  await leaveForIdentityRecovery()
  expect(state.writes).toHaveLength(2)
  expect(room.leave).toHaveBeenCalledOnce()
})

test('a pending save hides a valid rejoin opportunity without blocking an independent session store', async () => {
  state.writeFailures = 1
  const { leave } = beginProductionLeave()
  useSessionStore.setState({ hadAnyPeer: true })
  await expect(leaveForIdentityRecovery()).rejects.toThrow(
    strings.session.errors.savePending
  )
  expect(useSessionStore.getState().rejoinDeadline).toBeGreaterThan(Date.now())
  expect(useSessionStore.getState().getRejoinRequest()).toBeNull()
  const independent = createSessionStore()
  independent.getState().begin({
    room: {} as never,
    leave,
    sessionTopic: 'independent',
    sessionPassword: 'test',
    isHost: true,
    startedAt: Date.now(),
  })
  expect(independent.getState().status).toBe('active')
  expect(independent.getState().pendingSave).toBeNull()
  await leaveForIdentityRecovery()
  expect(useSessionStore.getState().getRejoinRequest()?.sessionTopic).toBe(
    topic
  )
})
