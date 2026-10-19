import {
  appFields,
  appId,
  appRecord,
  appRevision,
  type MirrorAppJson,
} from './appBridge'
import type { MirrorAppExecution, MirrorAppRuntime } from './appRuntime'

export type MirrorHomeData = {
  friends: {
    id: string
    displayName: string
    presence: 'online' | 'offline'
    limited: boolean
  }[]
  invites: { id: string; displayName: string; expiresAt: number }[]
  interrupted: { startedAt: number; topic: string | null } | null
  aiEnabled: boolean
  savePending: boolean
  rejoinDeadline: number | null
  rosterReady: boolean
  totalFriends: number
  offset: number
}
export type MirrorHomeStart = { id: string; topic: string | null }
const topic = (v: unknown): v is string | null =>
  v === null ||
  (typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= 120)
const name = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 256
export function readHomeStart(value: MirrorAppJson): MirrorHomeStart | null {
  return appRecord(value) &&
    appFields(value, ['id', 'topic']) &&
    appId(value.id) &&
    topic(value.topic)
    ? { id: value.id, topic: value.topic }
    : null
}
export function readHomeOffset(
  value: MirrorAppJson
): { offset: number } | null {
  return appRecord(value) &&
    appFields(value, ['offset']) &&
    appRevision(value.offset) &&
    value.offset <= 100_000
    ? { offset: value.offset }
    : null
}
export function readHomeEmpty(
  value: MirrorAppJson
): Record<string, never> | null {
  return appRecord(value) && appFields(value, []) ? {} : null
}
export function readHomeRejoin(
  value: MirrorAppJson
): { source: 'recent' | 'interrupted' } | null {
  return appRecord(value) &&
    appFields(value, ['source']) &&
    (value.source === 'recent' || value.source === 'interrupted')
    ? { source: value.source }
    : null
}
export function readMirrorHome(value: unknown): MirrorHomeData | null {
  if (
    !appRecord(value) ||
    !appFields(value, [
      'friends',
      'invites',
      'interrupted',
      'aiEnabled',
      'savePending',
      'rejoinDeadline',
      'rosterReady',
      'totalFriends',
      'offset',
    ]) ||
    !Array.isArray(value.friends) ||
    value.friends.length > 64 ||
    !Array.isArray(value.invites) ||
    value.invites.length > 16 ||
    typeof value.aiEnabled !== 'boolean' ||
    typeof value.savePending !== 'boolean' ||
    typeof value.rosterReady !== 'boolean' ||
    !appRevision(value.totalFriends) ||
    !appRevision(value.offset) ||
    !(value.rejoinDeadline === null || appRevision(value.rejoinDeadline))
  )
    return null
  const friends: MirrorHomeData['friends'] = []
  const invites: MirrorHomeData['invites'] = []
  for (const friend of value.friends) {
    if (
      !appRecord(friend) ||
      !appFields(friend, ['id', 'displayName', 'presence', 'limited']) ||
      typeof friend.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(friend.id) ||
      !name(friend.displayName) ||
      !['online', 'offline'].includes(String(friend.presence)) ||
      typeof friend.limited !== 'boolean'
    )
      return null
    friends.push({
      id: friend.id,
      displayName: friend.displayName,
      presence: friend.presence as 'online' | 'offline',
      limited: friend.limited,
    })
  }
  for (const invite of value.invites) {
    if (
      !appRecord(invite) ||
      !appFields(invite, ['id', 'displayName', 'expiresAt']) ||
      !appId(invite.id) ||
      !name(invite.displayName) ||
      !appRevision(invite.expiresAt)
    )
      return null
    invites.push({
      id: invite.id,
      displayName: invite.displayName,
      expiresAt: invite.expiresAt,
    })
  }
  let interrupted: MirrorHomeData['interrupted'] = null
  if (value.interrupted !== null) {
    if (
      !appRecord(value.interrupted) ||
      !appFields(value.interrupted, ['startedAt', 'topic']) ||
      !appRevision(value.interrupted.startedAt) ||
      !topic(value.interrupted.topic)
    )
      return null
    interrupted = {
      startedAt: value.interrupted.startedAt,
      topic: value.interrupted.topic,
    }
  }
  return {
    friends,
    invites,
    interrupted,
    aiEnabled: value.aiEnabled,
    savePending: value.savePending,
    rejoinDeadline: value.rejoinDeadline,
    rosterReady: value.rosterReady,
    totalFriends: value.totalFriends,
    offset: value.offset,
  }
}

export function registerMirrorHome(
  runtime: MirrorAppRuntime,
  handlers: {
    read: (offset: number) => MirrorHomeData
    invite: (
      args: MirrorHomeStart,
      context: MirrorAppExecution
    ) => Promise<MirrorAppJson>
    accept: (
      args: MirrorHomeStart,
      context: MirrorAppExecution
    ) => Promise<MirrorAppJson>
    rejoin: (
      source: 'recent' | 'interrupted',
      context: MirrorAppExecution
    ) => Promise<MirrorAppJson>
    endInterrupted: (context: MirrorAppExecution) => Promise<MirrorAppJson>
  }
) {
  const ready = (snapshot: { phase: string }) =>
    ['home', 'report', 'session'].includes(snapshot.phase)
  const unregister = [
    runtime.register('home.read', {
      parse: readHomeOffset,
      execute: ({ offset }) => handlers.read(offset),
    }),
    runtime.register('home.invite', {
      parse: readHomeStart,
      mutates: true,
      available: ready,
      execute: handlers.invite,
    }),
    runtime.register('home.accept', {
      parse: readHomeStart,
      mutates: true,
      available: (snapshot) => ready(snapshot) && snapshot.phase !== 'session',
      execute: handlers.accept,
    }),
    runtime.register('home.rejoin', {
      parse: readHomeRejoin,
      mutates: true,
      available: (snapshot) => ready(snapshot) && snapshot.phase !== 'session',
      execute: ({ source }, context) => handlers.rejoin(source, context),
    }),
    runtime.register('home.end_interrupted', {
      parse: readHomeEmpty,
      mutates: true,
      available: (snapshot) => snapshot.phase === 'home',
      execute: (_, context) => handlers.endInterrupted(context),
    }),
  ]
  return () => {
    for (const remove of unregister) remove()
  }
}
