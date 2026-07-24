// N3 — the "friend came online" notification decision. The baseline guard
// dodges boot's initial sweep, but must not swallow a friend who genuinely
// arrives later in the session.

import { describe, expect, test } from 'vitest'

import { shouldNotifyFriendOnline } from '@/features/friends/friendOnlineNotify'
import { ONLINE_WINDOW_MS } from '@/features/friends/presence'

const NOW = 1_700_000_000_000

describe('shouldNotifyFriendOnline', () => {
  test('a friend already online when we subscribed is suppressed', () => {
    // Their first heartbeat lands seconds after the subscribe: first ONLINE
    // resolution, inside the settle window — boot's sweep, not an arrival.
    expect(
      shouldNotifyFriendOnline({
        online: true,
        was: false,
        hadBaseline: false,
        watchStartedAt: NOW - 3_000,
        now: NOW,
      })
    ).toBe(false)
  })

  test('a friend offline at subscribe who arrives later notifies', () => {
    expect(
      shouldNotifyFriendOnline({
        online: true,
        was: false,
        hadBaseline: false,
        watchStartedAt: NOW - 20 * 60_000,
        now: NOW,
      })
    ).toBe(true)
  })

  test('a goodbye then a return inside the settle window notifies', () => {
    // The goodbye already established the baseline, so the return is a real
    // edge even though the settle window has not elapsed.
    expect(
      shouldNotifyFriendOnline({
        online: true,
        was: false,
        hadBaseline: true,
        watchStartedAt: NOW - 20_000,
        now: NOW,
      })
    ).toBe(true)
  })

  test('a normal re-arrival long after the baseline notifies', () => {
    expect(
      shouldNotifyFriendOnline({
        online: true,
        was: false,
        hadBaseline: true,
        watchStartedAt: NOW - 4 * 60 * 60_000,
        now: NOW,
      })
    ).toBe(true)
  })

  test('a freshly added friend who is already online is suppressed', () => {
    // ContactCard import mid-session: their watch starts at the add, so the
    // import stays silent for its own settle window.
    expect(
      shouldNotifyFriendOnline({
        online: true,
        was: false,
        hadBaseline: false,
        watchStartedAt: NOW - 5_000,
        now: NOW,
      })
    ).toBe(false)
  })

  test('the settle bound is exactly ONLINE_WINDOW_MS', () => {
    const base = {
      online: true,
      was: false,
      hadBaseline: false,
      now: NOW,
    }
    expect(
      shouldNotifyFriendOnline({
        ...base,
        watchStartedAt: NOW - ONLINE_WINDOW_MS + 1,
      })
    ).toBe(false)
    expect(
      shouldNotifyFriendOnline({
        ...base,
        watchStartedAt: NOW - ONLINE_WINDOW_MS,
      })
    ).toBe(true)
  })

  test('an unknown watch start is treated as just-started', () => {
    expect(
      shouldNotifyFriendOnline({
        online: true,
        was: false,
        hadBaseline: false,
        watchStartedAt: undefined,
        now: NOW,
      })
    ).toBe(false)
  })

  test('nothing fires without an offline→online edge', () => {
    const settled = { watchStartedAt: NOW - 60 * 60_000, now: NOW }
    // Still online from the previous tick.
    expect(
      shouldNotifyFriendOnline({
        online: true,
        was: true,
        hadBaseline: true,
        ...settled,
      })
    ).toBe(false)
    // An offline tick (sweep aging them out) never notifies.
    expect(
      shouldNotifyFriendOnline({
        online: false,
        was: true,
        hadBaseline: true,
        ...settled,
      })
    ).toBe(false)
  })
})
