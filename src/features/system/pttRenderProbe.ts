// #226 — the reported symptom was a lit indicator, and every record the app
// wrote about it was derived from the same store the indicator was supposed to
// be showing. A render fault was therefore invisible by construction: the logs
// could only ever agree with themselves.
//
// This reads what was actually committed to the DOM. It takes a structural
// root rather than `document` so it is testable in this repo's node-env vitest
// (no jsdom, no RTL); `PttListener` supplies the real `document` as a default
// argument at the call site.
//
// What it can and cannot prove: it observes the committed attribute and,
// optionally, the computed opacity that actually hides or shows the badge. It
// cannot see a compositor or GPU paint failure. When a surface is missing it
// reports `surfaces: 0` / `selfLit: null` rather than inventing `false` — an
// honest "not observed" beats a false negative in an archive someone will
// reason from later.

import type { PttRenderObservation } from './pttInvariants'

export type PttRenderElement = {
  getAttribute: (name: string) => string | null
}

export type PttRenderRoot = {
  querySelectorAll: (selector: string) => Iterable<PttRenderElement>
}

export const PTT_INDICATOR_ATTR = 'data-ptt-indicator'
export const PTT_ACTIVE_ATTR = 'data-ptt-active'
export const PTT_SCOPE_ATTR = 'data-ptt-scope'
export const PTT_HOLD_ATTR = 'data-ptt-hold'

const INDICATOR_SELECTOR = `[${PTT_INDICATOR_ATTR}]`
const HOLD_SELECTOR = `[${PTT_HOLD_ATTR}]`

// The badge is shown by opacity, not by mounting, so "lit" is an opacity
// question. Anything above a whisker counts as visible to the user.
const OPACITY_LIT_THRESHOLD = 0.5

function attrIsTrue(element: PttRenderElement, name: string): boolean | null {
  const raw = element.getAttribute(name)
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

export function readPttRenderState(
  root: PttRenderRoot | null | undefined,
  computeOpacity?: (element: PttRenderElement) => number | null
): PttRenderObservation {
  const empty: PttRenderObservation = {
    selfLit: null,
    opacityLit: null,
    peerLit: 0,
    peerTiles: 0,
    holdButtonPressed: null,
    surfaces: 0,
    probeError: false,
  }
  if (!root) return empty

  try {
    let selfLit: boolean | null = null
    let opacityLit: boolean | null = null
    let peerLit = 0
    let peerTiles = 0
    let surfaces = 0
    let selfElement: PttRenderElement | null = null

    for (const element of root.querySelectorAll(INDICATOR_SELECTOR)) {
      surfaces += 1
      const scope = element.getAttribute(PTT_SCOPE_ATTR)
      const lit = attrIsTrue(element, PTT_ACTIVE_ATTR)
      if (scope === 'self') {
        selfElement = element
        // Two self tiles would mean a duplicated local tile, which is itself
        // worth seeing: OR them so a lit one is never masked by an unlit one.
        selfLit = selfLit === true ? true : lit
        continue
      }
      peerTiles += 1
      if (lit === true) peerLit += 1
    }

    let holdButtonPressed: boolean | null = null
    for (const element of root.querySelectorAll(HOLD_SELECTOR)) {
      surfaces += 1
      holdButtonPressed = attrIsTrue(element, PTT_HOLD_ATTR)
    }

    if (selfElement && computeOpacity) {
      const opacity = computeOpacity(selfElement)
      if (opacity !== null && Number.isFinite(opacity)) {
        opacityLit = opacity > OPACITY_LIT_THRESHOLD
      }
    }

    return {
      selfLit,
      opacityLit,
      peerLit,
      peerTiles,
      holdButtonPressed,
      surfaces,
      probeError: false,
    }
  } catch {
    // The probe must never cost the app a frame or a record. A failure is
    // reported as a fact so the invariants stand down rather than firing on
    // an observation that was never made.
    return { ...empty, probeError: true }
  }
}
