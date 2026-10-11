import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  finishMirrorReport,
  projectMirrorReport,
  registerMirrorReportHandoff,
} from '@/features/mirror/reportHandoff'
import type { MirrorHost } from '@/features/mirror/runtime'
import type { ResolvedReportData } from '@/features/session/reportSerialize'

const loader = vi.hoisted(() => ({ load: vi.fn() }))
const log = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('@/features/session/reportLoader', () => ({
  loadReportData: loader.load,
}))
vi.mock('@/lib/log', () => ({
  logger: { child: () => log },
}))

const own = 'a'.repeat(64)
const peer = 'b'.repeat(64)
const auditPeer = 'c'.repeat(64)
function report(): ResolvedReportData {
  return {
    session: {
      id: 'private-session-topic',
      started_at: 1000,
      ended_at: 61_000,
      total_minutes: 1,
      total_duration_ms: 60_000,
      peer_pubkeys: JSON.stringify([peer]),
      peer_presence_ms: JSON.stringify({ [peer]: 30_000 }),
      declared_topic: 'Read chapter two',
      score: 95,
      focused_pct: 0.95,
      generated_at: 61_000,
      confident_samples: 5,
      skipped_samples: 1,
      ai_enabled: 1,
      local_ed_pubkey: own,
      local_display_name: 'Alice',
    },
    auditEvents: [
      {
        session_id: 'private-session-topic',
        who: auditPeer,
        ts: 30_000,
        kind: 'joined',
        detail: '{}',
        sig: 'signature',
      },
    ],
    timeline: {
      session_id: 'private-session-topic',
      generated_at: 61_000,
      model_id: 'model',
      source: 'model',
      entries: '[]',
      truncated: 0,
    },
    myEdPubkeyHex: own,
    nameByEdPubkey: {
      [own]: 'Alice',
      [peer]: 'Bob',
      [auditPeer]: 'Charlie',
      ...Object.fromEntries(
        Array.from({ length: 300 }, (_, index) => [
          index.toString(16).padStart(64, '0'),
          `Unrelated friend ${index}`,
        ])
      ),
    },
  }
}

const unregister: (() => void)[] = []
afterEach(() => {
  for (const cleanup of unregister.splice(0)) cleanup()
  loader.load.mockReset()
  log.warn.mockReset()
  vi.useRealTimers()
})

describe('companion report privacy and ownership', () => {
  test('only participant names cross the LAN and signed journal data retains its original ids', () => {
    const original = report()
    const projected = projectMirrorReport(original, 'public-generation')
    expect(Object.keys(projected.nameByEdPubkey).sort()).toEqual(
      [own, peer, auditPeer].sort()
    )
    expect(projected.mirrorSessionId).toBe('public-generation')
    expect(projected.session).toEqual(original.session)
    expect(projected.auditEvents).toEqual(original.auditEvents)
    expect(projected.timeline).toEqual(original.timeline)
    expect(original.session.id).toBe('private-session-topic')
    expect(Object.keys(original.nameByEdPubkey)).toHaveLength(303)
  })

  test('a delayed report load cannot deliver to a replacement companion', async () => {
    let loaded!: (report: ResolvedReportData) => void
    loader.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          loaded = resolve
        })
    )
    const first = {
      finishReport: vi.fn(async () => {}),
    } as unknown as MirrorHost
    const second = {
      finishReport: vi.fn(async () => {}),
    } as unknown as MirrorHost
    unregister.push(
      registerMirrorReportHandoff(
        'private-session-topic',
        first,
        'generation-one'
      )
    )
    const pending = finishMirrorReport('private-session-topic')
    unregister.push(
      registerMirrorReportHandoff(
        'private-session-topic',
        second,
        'generation-two'
      )
    )
    loaded(report())
    await pending
    expect(first.finishReport).not.toHaveBeenCalled()
    expect(second.finishReport).not.toHaveBeenCalled()
  })

  test('late unregistration of the old host preserves the new report owner', async () => {
    const first = {
      finishReport: vi.fn(async () => {}),
    } as unknown as MirrorHost
    const second = {
      finishReport: vi.fn(async () => {}),
    } as unknown as MirrorHost
    const stopFirst = registerMirrorReportHandoff(
      'private-session-topic',
      first,
      'generation-one'
    )
    unregister.push(
      registerMirrorReportHandoff(
        'private-session-topic',
        second,
        'generation-two'
      )
    )
    stopFirst()
    loader.load.mockResolvedValue(report())
    await finishMirrorReport('private-session-topic')
    expect(first.finishReport).not.toHaveBeenCalled()
    expect(second.finishReport).toHaveBeenCalledWith(
      projectMirrorReport(report(), 'generation-two')
    )
  })

  test('a hung report loader cannot hold Leave beyond the handoff deadline', async () => {
    vi.useFakeTimers()
    loader.load.mockImplementation(() => new Promise(() => {}))
    const host = {
      finishReport: vi.fn(async () => {}),
    } as unknown as MirrorHost
    unregister.push(
      registerMirrorReportHandoff('private-session-topic', host, 'generation')
    )
    let finished = false
    const pending = finishMirrorReport('private-session-topic').then(() => {
      finished = true
    })
    await vi.advanceTimersByTimeAsync(2999)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(finished).toBe(true)
    expect(host.finishReport).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a report loaded after the deadline cannot deliver to the still-current companion', async () => {
    vi.useFakeTimers()
    let loaded!: (value: ResolvedReportData) => void
    loader.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          loaded = resolve
        })
    )
    const host = {
      finishReport: vi.fn(async () => {}),
    } as unknown as MirrorHost
    unregister.push(
      registerMirrorReportHandoff('private-session-topic', host, 'generation')
    )
    const pending = finishMirrorReport('private-session-topic')
    await vi.advanceTimersByTimeAsync(3000)
    await pending
    loaded(report())
    await vi.advanceTimersByTimeAsync(0)
    expect(host.finishReport).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a report loader rejected after the deadline does not log a current failure', async () => {
    vi.useFakeTimers()
    let failed!: (reason: Error) => void
    loader.load.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failed = reject
        })
    )
    const host = {
      finishReport: vi.fn(async () => {}),
    } as unknown as MirrorHost
    unregister.push(
      registerMirrorReportHandoff('private-session-topic', host, 'generation')
    )
    const pending = finishMirrorReport('private-session-topic')
    await vi.advanceTimersByTimeAsync(3000)
    await pending
    failed(new Error('late database failure'))
    await vi.advanceTimersByTimeAsync(0)
    expect(host.finishReport).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('loading and a stalled delivery share the same three-second grace period', async () => {
    vi.useFakeTimers()
    let loaded!: (value: ResolvedReportData) => void
    loader.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          loaded = resolve
        })
    )
    const host = {
      finishReport: vi.fn(() => new Promise(() => {})),
    } as unknown as MirrorHost
    unregister.push(
      registerMirrorReportHandoff('private-session-topic', host, 'generation')
    )
    let finished = false
    const pending = finishMirrorReport('private-session-topic').then(() => {
      finished = true
    })
    await vi.advanceTimersByTimeAsync(2000)
    loaded(report())
    await vi.advanceTimersByTimeAsync(0)
    expect(host.finishReport).toHaveBeenCalledWith(
      projectMirrorReport(report(), 'generation')
    )
    await vi.advanceTimersByTimeAsync(999)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(finished).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('successful delivery and current load failures both clear the owned deadline', async () => {
    vi.useFakeTimers()
    const host = {
      finishReport: vi.fn(async () => {}),
    } as unknown as MirrorHost
    unregister.push(
      registerMirrorReportHandoff('private-session-topic', host, 'generation')
    )
    loader.load.mockResolvedValueOnce(report())
    await finishMirrorReport('private-session-topic')
    expect(host.finishReport).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    loader.load.mockRejectedValueOnce(new Error('current database failure'))
    await finishMirrorReport('private-session-topic')
    expect(log.warn).toHaveBeenCalledExactlyOnceWith('report.unavailable')
    expect(vi.getTimerCount()).toBe(0)
  })
})
