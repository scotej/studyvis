// V3-P4 — Multi-monitor compositor layout tests. The runtime side (canvas
// drawImage + JPEG encode) is exercised only inside the WebView at runtime
// and is user-verifiable on real multi-monitor hardware; here we pin the
// pure layout math the boot/tick path depends on.

import { describe, expect, test } from 'vitest'

import {
  COMPOSITE_MAX_WIDTH,
  computeCompositeLayout,
  type FrameDims,
} from '@/features/ai/composite'

const EPS = 0.01 // aspect ratio tolerance under floor rounding

function aspectsClose(
  source: FrameDims,
  placement: { width: number; height: number }
): boolean {
  const sourceRatio = source.sourceWidth / source.sourceHeight
  const placementRatio = placement.width / placement.height
  return Math.abs(sourceRatio - placementRatio) <= EPS
}

describe('computeCompositeLayout', () => {
  test('returns an empty layout when given no frames', () => {
    const layout = computeCompositeLayout([])
    expect(layout.outputWidth).toBe(0)
    expect(layout.outputHeight).toBe(0)
    expect(layout.placements).toEqual([])
    expect(layout.scale).toBe(1)
  })

  test('passes a single display through at native resolution when it fits', () => {
    const frames: FrameDims[] = [{ sourceWidth: 1920, sourceHeight: 1080 }]
    const layout = computeCompositeLayout(frames)

    expect(layout.scale).toBe(1)
    expect(layout.outputWidth).toBe(1920)
    expect(layout.outputHeight).toBe(1080)
    expect(layout.placements).toHaveLength(1)
    expect(layout.placements[0]).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    })
    expect(layout.outputWidth).toBeLessThanOrEqual(COMPOSITE_MAX_WIDTH)
  })

  test('shrinks a single display larger than the cap uniformly to ≤ maxWidth', () => {
    const frames: FrameDims[] = [{ sourceWidth: 3840, sourceHeight: 2160 }]
    const layout = computeCompositeLayout(frames)

    expect(layout.scale).toBeCloseTo(COMPOSITE_MAX_WIDTH / 3840)
    expect(layout.outputWidth).toBeLessThanOrEqual(COMPOSITE_MAX_WIDTH)
    expect(layout.placements).toHaveLength(1)
    expect(aspectsClose(frames[0]!, layout.placements[0]!)).toBe(true)
  })

  test('lays two equal displays side-by-side and scales uniformly to ≤ maxWidth', () => {
    const frames: FrameDims[] = [
      { sourceWidth: 1920, sourceHeight: 1080 },
      { sourceWidth: 1920, sourceHeight: 1080 },
    ]
    const layout = computeCompositeLayout(frames)

    // Native side-by-side = 3840 wide → must downscale uniformly.
    expect(layout.scale).toBeLessThan(1)
    expect(layout.scale).toBeCloseTo(COMPOSITE_MAX_WIDTH / 3840)
    expect(layout.outputWidth).toBeLessThanOrEqual(COMPOSITE_MAX_WIDTH)
    expect(layout.placements).toHaveLength(2)
    // Equal sources → equal scaled placements.
    const [a, b] = layout.placements
    expect(a!.width).toBe(b!.width)
    expect(a!.height).toBe(b!.height)
    // Top-aligned, contiguous horizontal strip.
    expect(a!.x).toBe(0)
    expect(a!.y).toBe(0)
    expect(b!.x).toBe(a!.width)
    expect(b!.y).toBe(0)
    // Each placement keeps the source aspect.
    for (let i = 0; i < frames.length; i += 1) {
      expect(aspectsClose(frames[i]!, layout.placements[i]!)).toBe(true)
    }
  })

  test('composes three mixed-size displays with one uniform scale factor', () => {
    const frames: FrameDims[] = [
      { sourceWidth: 1920, sourceHeight: 1080 }, // 16:9
      { sourceWidth: 1280, sourceHeight: 720 }, // 16:9, smaller
      { sourceWidth: 2560, sourceHeight: 1440 }, // 16:9, larger
    ]
    const layout = computeCompositeLayout(frames)

    const nativeWidth = frames.reduce((sum, f) => sum + f.sourceWidth, 0)
    expect(layout.scale).toBeCloseTo(COMPOSITE_MAX_WIDTH / nativeWidth)
    expect(layout.outputWidth).toBeLessThanOrEqual(COMPOSITE_MAX_WIDTH)
    expect(layout.placements).toHaveLength(3)

    // Each placement's size matches floor(source * scale) within rounding.
    for (let i = 0; i < frames.length; i += 1) {
      const f = frames[i]!
      const p = layout.placements[i]!
      expect(p.width).toBeLessThanOrEqual(
        Math.ceil(f.sourceWidth * layout.scale)
      )
      expect(p.height).toBeLessThanOrEqual(
        Math.ceil(f.sourceHeight * layout.scale)
      )
      expect(aspectsClose(f, p)).toBe(true)
    }
    // Placements are contiguous, top-aligned, in input order.
    let cursor = 0
    for (const p of layout.placements) {
      expect(p.x).toBe(cursor)
      expect(p.y).toBe(0)
      cursor += p.width
    }
    expect(cursor).toBe(layout.outputWidth)
    // Output height = max placement height (top-aligned strip).
    const maxHeight = Math.max(...layout.placements.map((p) => p.height))
    expect(layout.outputHeight).toBe(maxHeight)
  })

  test('uniformly scaled means every placement shares the same scale factor', () => {
    const frames: FrameDims[] = [
      { sourceWidth: 1920, sourceHeight: 1080 },
      { sourceWidth: 2560, sourceHeight: 1080 }, // ultrawide
      { sourceWidth: 1280, sourceHeight: 800 },
    ]
    const layout = computeCompositeLayout(frames)

    // Floor rounding can drop each placement by < 1 px relative to the ideal
    // continuous scale; assert all placements use the SAME scale by checking
    // each placement's width/height against the same `layout.scale`.
    for (let i = 0; i < frames.length; i += 1) {
      const f = frames[i]!
      const p = layout.placements[i]!
      const idealWidth = f.sourceWidth * layout.scale
      const idealHeight = f.sourceHeight * layout.scale
      expect(Math.abs(idealWidth - p.width)).toBeLessThan(1)
      expect(Math.abs(idealHeight - p.height)).toBeLessThan(1)
    }
  })

  test('respects a smaller maxWidth override for tests', () => {
    const frames: FrameDims[] = [
      { sourceWidth: 400, sourceHeight: 300 },
      { sourceWidth: 400, sourceHeight: 300 },
    ]
    const layout = computeCompositeLayout(frames, 500)
    expect(layout.outputWidth).toBeLessThanOrEqual(500)
    expect(layout.scale).toBeCloseTo(500 / 800)
  })

  test('drops zero-dimension frames so a degraded display can not blow up the math', () => {
    const frames: FrameDims[] = [
      { sourceWidth: 1920, sourceHeight: 1080 },
      { sourceWidth: 0, sourceHeight: 0 },
      { sourceWidth: 1280, sourceHeight: 720 },
    ]
    const layout = computeCompositeLayout(frames)
    // The zero frame is excluded — only 2 placements come back.
    expect(layout.placements).toHaveLength(2)
    expect(layout.outputWidth).toBeGreaterThan(0)
    expect(layout.outputHeight).toBeGreaterThan(0)
  })

  test('returns empty layout when every frame is degenerate', () => {
    const layout = computeCompositeLayout([
      { sourceWidth: 0, sourceHeight: 0 },
      { sourceWidth: -10, sourceHeight: 50 },
      { sourceWidth: Number.NaN, sourceHeight: 1000 },
    ])
    expect(layout.placements).toEqual([])
    expect(layout.outputWidth).toBe(0)
    expect(layout.outputHeight).toBe(0)
  })

  test('single-display fallback: sum width below cap = no downscale', () => {
    // The sample loop drops 'all displays' to single-display when the OS only
    // grants one. The compositor isn't called in that path, but defensively:
    // a single-frame input always yields a 1:1 placement that fits.
    const frames: FrameDims[] = [{ sourceWidth: 1024, sourceHeight: 768 }]
    const layout = computeCompositeLayout(frames)
    expect(layout.scale).toBe(1)
    expect(layout.outputWidth).toBe(1024)
    expect(layout.outputHeight).toBe(768)
  })
})
