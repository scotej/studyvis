// F4 — pure mapping from RTCPeerConnection.connectionState to a VideoTile
// focus state. The React wiring (getPeers + connectionstatechange) is covered
// by the running app; this locks the precedence so a peer mid-handshake or
// with a dead link never silently reads as a frozen offline tile.

import { describe, expect, test } from 'vitest'

import { connectionFocusState } from '@/features/session/lifecycle'

const fakeStream = {} as unknown as MediaStream

describe('connectionFocusState', () => {
  test('only "failed" maps to "failed" — and regardless of media', () => {
    expect(connectionFocusState('failed', null)).toBe('failed')
    expect(connectionFocusState('failed', fakeStream)).toBe('failed')
  })

  test('"disconnected" is transient: maps to "connecting", never "failed"', () => {
    // Brief packet loss flickers through 'disconnected' and self-heals, so the
    // tile must not read the terminal "Connection failed" (S1 grace stance).
    expect(connectionFocusState('disconnected', null)).toBe('connecting')
    // Media still flowing — defer to the stream fallback ("online").
    expect(connectionFocusState('disconnected', fakeStream)).toBeUndefined()
  })

  test('new and connecting map to "connecting" only while media is absent', () => {
    expect(connectionFocusState('new', null)).toBe('connecting')
    expect(connectionFocusState('connecting', null)).toBe('connecting')
    // Media is already flowing — defer to the stream fallback ("online").
    expect(connectionFocusState('connecting', fakeStream)).toBeUndefined()
    expect(connectionFocusState('new', fakeStream)).toBeUndefined()
  })

  test('connected/closed/undefined defer to the stream fallback', () => {
    expect(connectionFocusState('connected', fakeStream)).toBeUndefined()
    expect(connectionFocusState('connected', null)).toBeUndefined()
    expect(connectionFocusState('closed', null)).toBeUndefined()
    expect(connectionFocusState(undefined, null)).toBeUndefined()
  })
})
