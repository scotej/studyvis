// V2-P8 — `auditStore.flushPending()` is load-bearing for the post-session
// report: the leave handler calls it before reading audit_events back out
// of SQLite, so the final 'left' (and any in-flight ai_alert) lands on
// disk before the report queries.

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { AUDIT_EVENT_VERSION, type AuditEvent } from '@/lib/audit-types'
import { __setAuditPersistFn, useAuditStore } from '@/stores/auditStore'

let counter = 0

function fakeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  counter += 1
  return {
    v: AUDIT_EVENT_VERSION,
    session_topic: 'topic-fixture',
    ts: 1_700_000_000_000 + counter,
    who: 'edpub-hex',
    kind: 'joined',
    detail: {},
    sig: `sig-${counter}`,
    ...overrides,
  }
}

describe('useAuditStore.flushPending', () => {
  beforeEach(() => {
    useAuditStore.setState({ events: [], nextSeq: 0 })
    counter = 0
  })
  afterEach(() => {
    // Restore the production persistFn (a Tauri invoke) — no test reuse
    // because each test wires its own fake.
    __setAuditPersistFn(async () => {
      /* default no-op for follow-up tests */
    })
  })

  test('resolves immediately when no persists are in flight', async () => {
    __setAuditPersistFn(async () => {})
    await expect(
      useAuditStore.getState().flushPending()
    ).resolves.toBeUndefined()
  })

  test('awaits in-flight persists kicked off by append()', async () => {
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const persists: Array<{ event: AuditEvent; settled: boolean }> = []
    __setAuditPersistFn((event) => {
      const entry: { event: AuditEvent; settled: boolean } = {
        event,
        settled: false,
      }
      persists.push(entry)
      return new Promise<void>((resolve) => {
        // Manual control over when the persist settles so the assertion
        // about "flushPending is still pending" is deterministic.
        const releaser = () => {
          entry.settled = true
          resolve()
        }
        if (persists.length === 1) releaseFirst = releaser
        else releaseSecond = releaser
      })
    })

    useAuditStore.getState().append(fakeEvent())
    useAuditStore.getState().append(fakeEvent())

    let flushed = false
    const flushPromise = useAuditStore
      .getState()
      .flushPending()
      .then(() => {
        flushed = true
      })
    // Yield once: flushPending awaits Promise.allSettled — until both
    // persists settle, `flushed` must still be false.
    await Promise.resolve()
    expect(flushed).toBe(false)
    expect(persists.every((p) => !p.settled)).toBe(true)

    releaseFirst()
    await Promise.resolve()
    expect(flushed).toBe(false)
    releaseSecond()
    await flushPromise
    expect(flushed).toBe(true)
    expect(persists.every((p) => p.settled)).toBe(true)
  })

  test('swallows persist rejections so the report path still progresses', async () => {
    __setAuditPersistFn(async () => {
      throw new Error('disk full')
    })
    // Suppress the console.error noise the production catch handler emits.
    const original = console.error
    console.error = () => {}
    try {
      useAuditStore.getState().append(fakeEvent())
      await expect(
        useAuditStore.getState().flushPending()
      ).resolves.toBeUndefined()
    } finally {
      console.error = original
    }
  })
})
