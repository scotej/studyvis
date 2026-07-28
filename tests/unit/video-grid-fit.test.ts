// #95 — tile sizing for the session grid. The old layout picked a column count
// from the tile count alone, so two people in the default window sat as two
// small strips over a lot of empty space. These lock the three properties that
// matter: the split chosen is the one that makes tiles biggest, the width never
// outgrows the column it sits in (a tile that does costs a whole column the
// moment a scrollbar appears), and `scrolls` tells the truth.

import { describe, expect, test } from 'vitest'

import { fitTiles, VIDEO_TILE_ASPECT } from '@/lib/videoGrid'

const GAP = 16
// The width at which a tile is the 180 px `videoTileMinHeight` tall.
const FLOOR = 320

// The video column of a session in the default 1280×800 window: the 320 audit
// rail and the 24 px page padding come off the width, the footer and padding
// come off the height.
const DEFAULT_SLOT = { width: 912, height: 684 }
// The same column at the 1024×640 window minimum...
const MIN_SLOT = { width: 656, height: 524 }
// ...and what it becomes once a scrolling grid draws a classic 15 px scrollbar
// inside its content box, as Windows does. 2 × 320 + 16 = 656 exactly, so this
// is the width where a hard floor would cost a column.
const MIN_SLOT_SCROLLBAR = { width: 641, height: 524 }

const fit = (count: number, slot: { width: number; height: number }) =>
  fitTiles({ count, ...slot, gap: GAP, minWidth: FLOOR })

// Re-derives how flex-wrap packs tiles of `width`, the same greedy rule the
// browser uses when every item is the same width.
function packing(
  count: number,
  width: number,
  slot: { width: number; height: number }
) {
  const columns = Math.max(1, Math.floor((slot.width + GAP) / (width + GAP)))
  const rows = Math.ceil(count / columns)
  const perRow = Math.min(count, columns)
  return {
    columns,
    rows,
    perRow,
    width: perRow * width + (perRow - 1) * GAP,
    height: rows * (width / VIDEO_TILE_ASPECT) + (rows - 1) * GAP,
  }
}

describe('fitTiles', () => {
  test('two people stack in the default session slot rather than sit side by side', () => {
    // Side by side each tile could only be (912 - 16) / 2 = 448 wide — the old
    // fixed two-column layout. One per row is height-bound instead, and bigger.
    expect(fit(2, DEFAULT_SLOT)).toEqual({ width: 593, scrolls: false })
  })

  test('two people sit side by side once the slot is wide enough to pay for it', () => {
    // 3000×400 is wider than the 32:9 a side-by-side pair needs, so the second
    // column stops costing height.
    const result = fitTiles({
      count: 2,
      width: 3000,
      height: 400,
      gap: GAP,
      minWidth: FLOOR,
    })
    expect(result).toEqual({ width: 711, scrolls: false })
    expect(packing(2, result.width, { width: 3000, height: 400 }).rows).toBe(1)
  })

  test('one tile fills whichever axis binds first', () => {
    // Height-bound: 684 tall → 1216 wide, more than the slot has.
    expect(fit(1, DEFAULT_SLOT).width).toBe(912)
    // Width-bound: a short, wide slot.
    expect(
      fitTiles({ count: 1, width: 912, height: 300, gap: GAP, minWidth: FLOOR })
        .width
    ).toBe(533)
  })

  test('screen shares are just more tiles: 3, 4 and 8 fit like any other count', () => {
    // Two people, one of them sharing.
    expect(fit(3, DEFAULT_SLOT)).toEqual({ width: 448, scrolls: false })
    // Two people both sharing — four tiles, sized as four people would be.
    expect(fit(4, DEFAULT_SLOT)).toEqual({ width: 448, scrolls: false })
    // Four people all sharing: three columns at 293 rather than two at the 320
    // floor, which would have needed a fourth row and scrolled.
    expect(fit(8, DEFAULT_SLOT)).toEqual({ width: 293, scrolls: false })
  })

  test('the floor gives way to the width rather than cost a column', () => {
    // The regression this guards: with a hard 320 floor, the 15 px scrollbar a
    // scrolling grid draws on Windows left 641 px — one tile short of two
    // columns — and eight tiles collapsed into a single 320-wide strip with
    // 160 px dead on either side and twice the scrolling.
    const result = fit(8, MIN_SLOT_SCROLLBAR)
    expect(result.width).toBeLessThan(FLOOR)
    expect(packing(8, result.width, MIN_SLOT_SCROLLBAR).perRow).toBe(2)
    // Without the scrollbar there is room for the floor exactly.
    expect(fit(8, MIN_SLOT).width).toBe(FLOOR)
    expect(packing(8, FLOOR, MIN_SLOT).perRow).toBe(2)
  })

  test('the floor still holds when it is the height that ran out', () => {
    // 8 tiles at the window minimum: two 320-wide columns fit across, and the
    // grid scrolls rather than shrink them to fit four rows into 524 px.
    expect(fit(8, MIN_SLOT)).toEqual({ width: 320, scrolls: true })
  })

  test('the chosen width always packs inside the slot', () => {
    const slots = [
      DEFAULT_SLOT,
      MIN_SLOT,
      MIN_SLOT_SCROLLBAR,
      { width: 1856, height: 984 }, // a maximized 1440p window
      { width: 400, height: 900 }, // narrow and tall
    ]
    for (const slot of slots) {
      for (let count = 1; count <= 8; count += 1) {
        const { width, scrolls } = fit(count, slot)
        const packed = packing(count, width, slot)
        // Never wider than the slot — that is the failure that costs a column.
        expect(packed.width).toBeLessThanOrEqual(slot.width + 0.5)
        // And `scrolls` agrees with the packing it will actually get.
        expect(scrolls).toBe(packed.height > slot.height)
      }
    }
  })

  test('more tiles never means bigger tiles', () => {
    let previous = Infinity
    for (let count = 1; count <= 8; count += 1) {
      const { width } = fit(count, DEFAULT_SLOT)
      expect(width).toBeLessThanOrEqual(previous)
      previous = width
    }
  })

  test('a slot with nothing in it, or nothing to put in it, is zero — never negative', () => {
    expect(fit(0, DEFAULT_SLOT)).toEqual({ width: 0, scrolls: false })
    expect(
      fitTiles({ count: 2, width: 0, height: 0, gap: GAP, minWidth: FLOOR })
    ).toEqual({ width: 0, scrolls: false })
    // Slot narrower than the gaps it would need.
    expect(
      fitTiles({ count: 4, width: 10, height: 10, gap: GAP, minWidth: FLOOR })
        .width
    ).toBe(0)
  })
})
