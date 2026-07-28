// #95 — tile sizing for the session grid. The old layout picked a column count
// from the tile count alone, so two people in the default window sat as two
// small strips over a lot of empty space. These lock the two properties that
// matter: the split chosen is the one that makes tiles biggest, and whatever it
// returns actually fits in the slot.

import { describe, expect, test } from 'vitest'

import { fitTileWidth, VIDEO_TILE_ASPECT } from '@/lib/videoGrid'

const GAP = 16

// The video column of a session in the default 1280×800 window: the 320 audit
// rail and the 24 px page padding come off the width, the footer and padding
// come off the height.
const DEFAULT_SLOT = { width: 912, height: 684 }

// Re-derives how flex-wrap will pack tiles of `tileWidth` and asserts the
// result stays inside the slot in both axes.
function packs(count: number, tileWidth: number, slot: typeof DEFAULT_SLOT) {
  const columns = Math.max(
    1,
    Math.floor((slot.width + GAP) / (tileWidth + GAP))
  )
  const rows = Math.ceil(count / columns)
  const tileHeight = tileWidth / VIDEO_TILE_ASPECT
  return {
    width: Math.min(count, columns) * tileWidth + (columns - 1) * GAP,
    height: rows * tileHeight + (rows - 1) * GAP,
  }
}

describe('fitTileWidth', () => {
  test('two people stack in the default session slot rather than sit side by side', () => {
    // Side by side each tile could only be (912 - 16) / 2 = 448 wide — the old
    // fixed two-column layout. One per row is height-bound instead, and bigger.
    expect(fitTileWidth({ count: 2, ...DEFAULT_SLOT, gap: GAP })).toBe(593)
  })

  test('two people sit side by side once the slot is wide enough to pay for it', () => {
    // 3000×400 is wider than the 32:9 a side-by-side pair needs, so the second
    // column stops costing height.
    const width = fitTileWidth({
      count: 2,
      width: 3000,
      height: 400,
      gap: GAP,
    })
    expect(width).toBe(711)
    expect(
      packs(2, width, { width: 3000, height: 400 }).width
    ).toBeLessThanOrEqual(3000)
  })

  test('one tile fills whichever axis binds first', () => {
    // Height-bound: 684 tall → 1216 wide, more than the slot has.
    expect(fitTileWidth({ count: 1, ...DEFAULT_SLOT, gap: GAP })).toBe(912)
    // Width-bound: a short, wide slot.
    expect(fitTileWidth({ count: 1, width: 912, height: 300, gap: GAP })).toBe(
      533
    )
  })

  test('the chosen width always packs inside the slot', () => {
    const slots = [
      DEFAULT_SLOT,
      { width: 656, height: 524 }, // the 1024×640 window minimum
      { width: 1856, height: 1000 }, // a maximized 1440p window
      { width: 400, height: 900 }, // narrow and tall
    ]
    for (const slot of slots) {
      for (let count = 1; count <= 8; count += 1) {
        const width = fitTileWidth({ count, ...slot, gap: GAP })
        const packed = packs(count, width, slot)
        expect(packed.width).toBeLessThanOrEqual(slot.width + 0.5)
        expect(packed.height).toBeLessThanOrEqual(slot.height + 0.5)
      }
    }
  })

  test('more tiles never means bigger tiles', () => {
    let previous = Infinity
    for (let count = 1; count <= 8; count += 1) {
      const width = fitTileWidth({ count, ...DEFAULT_SLOT, gap: GAP })
      expect(width).toBeLessThanOrEqual(previous)
      previous = width
    }
  })

  test('a slot with nothing in it, or nothing to put in it, is zero — never negative', () => {
    expect(fitTileWidth({ count: 0, ...DEFAULT_SLOT, gap: GAP })).toBe(0)
    expect(fitTileWidth({ count: 2, width: 0, height: 0, gap: GAP })).toBe(0)
    // Slot narrower than the gaps it would need: the caller's floor takes over.
    expect(fitTileWidth({ count: 4, width: 10, height: 10, gap: GAP })).toBe(0)
  })
})
