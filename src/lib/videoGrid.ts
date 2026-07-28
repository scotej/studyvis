// #95 — how large a session tile is allowed to get. The grid used to pick its
// column count from the tile count alone and let each tile take its share of
// the width, so two people in the default 1280×800 window sat as a pair of
// ~448×252 strips with most of the height under them unused. Instead, try
// every row/column split of `count` tiles and keep the one whose tiles come
// out largest: in a window shorter than 32:9 of usable area (i.e. all of
// them), two people stack rather than sit side by side and each face roughly
// doubles in area.

// Session tiles are 16:9 and stay 16:9 — a tile shaped like its slot would
// mean cropping faces (`object-cover`) or letterboxing screens to fit.
export const VIDEO_TILE_ASPECT = 16 / 9

export type TileFitArgs = {
  count: number
  // Content box of the grid, in CSS pixels.
  width: number
  height: number
  gap: number
  // Legibility floor: the width at which a tile is `videoTileMinHeight` tall.
  minWidth: number
}

export type TileFit = {
  width: number
  // Whether the resulting rows are taller than the slot. The grid scrolls, and
  // has to stop centring its rows — centred overflow puts the first row above
  // the scroll origin, where nothing can reach it.
  scrolls: boolean
}

export function fitTiles({
  count,
  width,
  height,
  gap,
  minWidth,
}: TileFitArgs): TileFit {
  let best = { tile: 0, column: 0 }
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns)
    const byWidth = (width - gap * (columns - 1)) / columns
    const byHeight = ((height - gap * (rows - 1)) / rows) * VIDEO_TILE_ASPECT
    const tile = Math.min(byWidth, byHeight)
    if (tile > best.tile) best = { tile, column: byWidth }
  }
  // The floor protects a tile from the HEIGHT running out: past it the grid
  // scrolls rather than shrink everyone into slivers. It must never outgrow
  // the column the tile sits in, though — a tile wider than its share of the
  // row costs a whole column, and on Windows a scrollbar appearing inside the
  // content box (macOS overlays its own) is enough to trigger that. Before
  // this bound, eight tiles at the 1024×640 minimum went from two columns to
  // one 320-wide strip with 160 px dead on either side the moment the grid
  // started scrolling.
  const raised = Math.max(best.tile, Math.min(minWidth, best.column))
  // Floor rather than round: a tile a fraction of a pixel wider than its share
  // of the row is what makes flex-wrap break a row one tile early.
  const tile = Math.max(0, Math.floor(raised))
  return { width: tile, scrolls: overflows(count, tile, height, gap, width) }
}

// Re-derives the greedy packing flex-wrap will produce at `tile` px per tile,
// and asks whether those rows fit. Greedy is exact here: every tile is the
// same width, so a row holds as many as the width divides into.
function overflows(
  count: number,
  tile: number,
  height: number,
  gap: number,
  width: number
): boolean {
  if (count === 0 || tile <= 0) return false
  const columns = Math.max(1, Math.floor((width + gap) / (tile + gap)))
  const rows = Math.ceil(count / columns)
  return rows * (tile / VIDEO_TILE_ASPECT) + gap * (rows - 1) > height
}
