import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  finishMirrorReport,
  projectMirrorReport,
  registerMirrorReportHandoff,
} from '@/features/mirror/reportHandoff'
import { useSettingsStore } from '@/stores/settingsStore'
import { serializeReportToText } from '@/features/session/reportSerialize'
import { strings } from '@/strings'
import type { MirrorHost } from '@/features/mirror/runtime'
import type { ResolvedReportData } from '@/features/session/reportSerialize'

const journal = vi.hoisted(() => ({
  read: vi.fn(async () => ({
    observations: [],
    truncated: false,
    unreadableLines: 0,
  })),
}))
vi.mock('@/features/session/sessionJournal', async (original) => ({
  ...(await original<typeof import('@/features/session/sessionJournal')>()),
  readObservations: journal.read,
}))
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
      covered_until: 61_000,
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
  journal.read.mockReset()
  useSettingsStore.setState((s) => ({
    values: { ...s.values, aiFeaturesEnabled: false },
  }))
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

describe('bounded companion written account (#410)', () => {
  function setup(
    original: ResolvedReportData = { ...report(), timeline: null }
  ) {
    useSettingsStore.setState((s) => ({
      values: {
        ...s.values,
        aiFeaturesEnabled: true,
        sessionTimelineEnabled: true,
      },
    }))
    loader.load.mockResolvedValue(original)
    const finish = vi
      .fn<(report: unknown) => Promise<void>>()
      .mockResolvedValue()
    const host = { finishReport: finish } as unknown as MirrorHost
    unregister.push(
      registerMirrorReportHandoff('private-session-topic', host, 'generation')
    )
    return { finish }
  }

  function rejoinedReport(coveredUntil: number | null | undefined) {
    const original = report()
    original.session.ended_at = 121_000
    original.timeline = {
      ...original.timeline!,
      generated_at: 500_000,
      covered_until: coveredUntil,
      entries: JSON.stringify([
        { start_min: 0, end_min: 1, summary: 'Only the first stint' },
      ]),
    }
    return original
  }

  test.each([61_000, null, undefined])(
    'a nonempty row with coverage %s is replaced by the full rejoined journal',
    async (coveredUntil) => {
      const original = rejoinedReport(coveredUntil)
      const { finish } = setup(original)
      journal.read.mockResolvedValue({
        observations: [
          {
            ts: 2000,
            verdict: 'on_task',
            reasoning: 'First stint maths',
            confidence: 1,
            topic: 'Maths',
          },
          {
            ts: 91_000,
            verdict: 'on_task',
            reasoning: 'Second stint physics',
            confidence: 1,
            topic: 'Physics',
          },
        ] as never[],
        truncated: false,
        unreadableLines: 0,
      })
      await finishMirrorReport('private-session-topic')
      const delivered = finish.mock.calls[0][0] as ResolvedReportData
      expect(delivered.timeline).toMatchObject({
        source: 'observations',
        covered_until: 121_000,
      })
      const text = serializeReportToText(delivered)
      expect(text).toContain('First stint maths')
      expect(text).toContain('Second stint physics')
      expect(text).not.toContain('Only the first stint')
      expect(original.timeline?.source).toBe('model')
    }
  )

  test('a fully covered model row remains available when generation settings are disabled', async () => {
    const original = rejoinedReport(121_000)
    const { finish } = setup(original)
    useSettingsStore.setState((s) => ({
      values: {
        ...s.values,
        aiFeaturesEnabled: false,
        sessionTimelineEnabled: false,
      },
    }))
    await finishMirrorReport('private-session-topic')
    const delivered = finish.mock.calls[0][0] as ResolvedReportData
    expect(delivered.timeline).toBe(original.timeline)
    expect(journal.read).not.toHaveBeenCalled()
  })

  test.each(
    [61_000, null].flatMap((coverage) =>
      ['unreadable', 'empty', 'ai-disabled', 'writeups-disabled'].map(
        (failure) => ({ coverage, failure })
      )
    )
  )(
    'obsolete coverage $coverage is not presented as complete when $failure',
    async ({ coverage, failure }) => {
      const { finish } = setup(rejoinedReport(coverage))
      if (failure === 'unreadable')
        journal.read.mockRejectedValue(new Error('permission denied'))
      else
        journal.read.mockResolvedValue({
          observations: [],
          truncated: false,
          unreadableLines: 0,
        })
      if (failure === 'ai-disabled' || failure === 'writeups-disabled') {
        useSettingsStore.setState((s) => ({
          values: {
            ...s.values,
            aiFeaturesEnabled: failure !== 'ai-disabled',
            sessionTimelineEnabled: failure !== 'writeups-disabled',
          },
        }))
      }
      await finishMirrorReport('private-session-topic')
      const delivered = finish.mock.calls[0][0] as ResolvedReportData
      expect(delivered.timeline).toBeNull()
      expect(serializeReportToText(delivered)).toContain(
        strings.report.sections.written.unavailable
      )
      expect(serializeReportToText(delivered)).not.toContain(
        'Only the first stint'
      )
      if (failure.endsWith('disabled'))
        expect(journal.read).not.toHaveBeenCalled()
    }
  )

  test('hands off labelled observations and matching export without waiting for model inference', async () => {
    const { finish } = setup()
    journal.read.mockResolvedValue({
      observations: [
        {
          ts: 2000,
          verdict: 'on_task',
          reasoning: 'Working on integrals',
          confidence: 1,
          topic: 'Maths',
        },
      ] as never[],
      truncated: true,
      unreadableLines: 0,
    })
    await finishMirrorReport('private-session-topic')
    const delivered = finish.mock.calls[0][0] as ResolvedReportData
    expect(delivered.timeline?.source).toBe('observations')
    expect(delivered.timeline?.truncated).toBe(1)
    expect(serializeReportToText(delivered)).toContain('Working on integrals')
    expect(serializeReportToText(delivered)).toContain(
      strings.report.sections.written.sourceNote.observations
    )
    expect(serializeReportToText(delivered)).not.toContain(
      strings.report.sections.written.empty
    )
  })

  test('unreadable journal retains a truthful report rather than losing the handoff', async () => {
    const { finish } = setup()
    journal.read.mockRejectedValue(new Error('permission denied'))
    await finishMirrorReport('private-session-topic')
    const delivered = finish.mock.calls[0][0] as ResolvedReportData
    expect(serializeReportToText(delivered)).toContain(
      strings.report.sections.written.unavailable
    )
  })

  test('a hung or superseded journal read cannot extend Leave or deliver a stale report', async () => {
    vi.useFakeTimers()
    const { finish } = setup()
    let release: ((value: never) => void) | undefined
    journal.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const pending = finishMirrorReport('private-session-topic')
    await vi.advanceTimersByTimeAsync(3000)
    await pending
    release?.({
      observations: [],
      truncated: false,
      unreadableLines: 0,
    } as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(finish).not.toHaveBeenCalled()
  })
})
