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
}

// Width of one tile in the best-fitting split, ignoring any legibility floor —
// the caller clamps, because whether the result was clamped is also what tells
// it the tiles no longer fit and the grid has to scroll.
export function fitTileWidth({
  count,
  width,
  height,
  gap,
}: TileFitArgs): number {
  let best = 0
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns)
    const byWidth = (width - gap * (columns - 1)) / columns
    const byHeight = ((height - gap * (rows - 1)) / rows) * VIDEO_TILE_ASPECT
    best = Math.max(best, Math.min(byWidth, byHeight))
  }
  // Floor rather than round: a tile a fraction of a pixel wider than its share
  // of the row is what makes flex-wrap break a row one tile early.
  return Math.max(0, Math.floor(best))
}
