import { describe, expect, test } from 'vitest'

import { invitableFriends } from '@/features/session'
import type { Friend } from '@/lib/db/friends'

function friend(seed: string, name: string | null): Friend {
  return {
    ed_pubkey_hex: seed.repeat(64).slice(0, 64),
    x_pubkey_hex: seed.repeat(64).slice(0, 64),
    display_name: name,
    paired_at: 1_700_000_000_000,
    last_studied_with: null,
  }
}

const ALEX = friend('a', 'Alex')
const BLAKE = friend('b', 'Blake')
const CASEY = friend('c', null)

describe('invitableFriends (#47 A2)', () => {
  test('keeps only online friends', () => {
    const rows = invitableFriends(
      [ALEX, BLAKE, CASEY],
      (ed) => ed === ALEX.ed_pubkey_hex,
      new Set()
    )
    expect(rows).toEqual([ALEX])
  })

  test('filters friends already in the session', () => {
    const rows = invitableFriends(
      [ALEX, BLAKE],
      () => true,
      new Set([BLAKE.ed_pubkey_hex])
    )
    expect(rows).toEqual([ALEX])
  })

  test('empty when nobody is online', () => {
    expect(invitableFriends([ALEX, BLAKE], () => false, new Set())).toEqual([])
  })
})
