// V3-P4 — Multi-monitor composite layout. Pure layout math, no DOM, so the
// boot/tick path in sampleLoop.ts can be node-tested without the canvas
// pipeline. The runtime side (draw + encode) lives in captureShared.ts as
// `CaptureRuntime.encodeCompositeJpegBase64`.
//
// Strategy: lay every captured display side-by-side at its native pixel size,
// then apply ONE uniform scale factor so the composite is at most
// COMPOSITE_MAX_WIDTH wide. Uniform = every placement uses the same scale, so
// a 4K display next to a 1080p display keeps its 4× pixel-area advantage. The
// model sees the same relative proportions a user would.
//
// Top alignment (`y = 0` for every placement) keeps the geometry trivial: the
// composite height is whichever display ended up tallest after the uniform
// downscale. Vertical centering would shrink each placement's effective area
// only by a few pixels and complicates the math; the model evaluates content,
// not alignment.
//
// The scale uses Math.floor for placement dimensions so the summed widths
// stay ≤ maxWidth even when scale * nativeWidth lands on a fractional boundary
// (Math.round of each term could otherwise nudge the total a pixel over).

export const COMPOSITE_MAX_WIDTH = 2048

export type FrameDims = {
  sourceWidth: number
  sourceHeight: number
}

export type CompositePlacement = {
  // Where this frame draws on the output canvas (top-left in output pixels).
  x: number
  y: number
  width: number
  height: number
}

export type CompositeLayout = {
  outputWidth: number
  outputHeight: number
  // One placement per input frame, in input order. Same length as `frames`.
  placements: ReadonlyArray<CompositePlacement>
  // Uniform scale factor applied to every frame's native dimensions. `1` when
  // the native side-by-side composite already fits under maxWidth.
  scale: number
}

// Pure: compute where every captured display lands on the final composite.
// Returns an empty layout for an empty input (the caller should treat that as
// "no frame to send" and skip the tick).
export function computeCompositeLayout(
  frames: ReadonlyArray<FrameDims>,
  maxWidth: number = COMPOSITE_MAX_WIDTH
): CompositeLayout {
  if (frames.length === 0 || maxWidth <= 0) {
    return { outputWidth: 0, outputHeight: 0, placements: [], scale: 1 }
  }

  // Drop frames with non-positive dimensions before computing the scale so a
  // zero-width display can never blow up the math. Tracking the original
  // index isn't needed — the compositor's caller (snapshotAllScreens) drops
  // matching frames in the same order.
  const usable = frames.filter(
    (f) =>
      Number.isFinite(f.sourceWidth) &&
      Number.isFinite(f.sourceHeight) &&
      f.sourceWidth > 0 &&
      f.sourceHeight > 0
  )
  if (usable.length === 0) {
    return { outputWidth: 0, outputHeight: 0, placements: [], scale: 1 }
  }

  const nativeWidth = usable.reduce((sum, f) => sum + f.sourceWidth, 0)
  const scale = nativeWidth <= maxWidth ? 1 : maxWidth / nativeWidth

  const placements: CompositePlacement[] = []
  let cursorX = 0
  let outputHeight = 0
  for (const f of usable) {
    const width = Math.max(1, Math.floor(f.sourceWidth * scale))
    const height = Math.max(1, Math.floor(f.sourceHeight * scale))
    placements.push({ x: cursorX, y: 0, width, height })
    cursorX += width
    if (height > outputHeight) outputHeight = height
  }

  return {
    outputWidth: cursorX,
    outputHeight,
    placements,
    scale,
  }
}
