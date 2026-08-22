import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'

import { PttIndicator } from '@/components/PttIndicator'
import {
  PTT_ACTIVE_ATTR,
  PTT_INDICATOR_ATTR,
  PTT_SCOPE_ATTR,
} from '@/features/system/pttRenderProbe'

// vitest runs node-env here with no jsdom, so this renders to static markup
// rather than mounting. That is enough for what these tests pin: the badge is
// a pure function of `active`, and the whole of #265 is which mechanism hides
// it.
function markup(props: Parameters<typeof PttIndicator>[0]): string {
  return renderToStaticMarkup(<PttIndicator {...props} />)
}

function classesOf(html: string): string[] {
  const match = /class="([^"]*)"/.exec(html)
  return match ? match[1].split(/\s+/).filter(Boolean) : []
}

describe('PttIndicator', () => {
  // I90 / #265 — an idle badge must be unpaintable, not merely transparent. A
  // transparent one survived every layer of instrumentation and still showed
  // a lit dot on macOS.
  test('hides the idle badge with visibility, not opacity alone', () => {
    const classes = classesOf(markup({ active: false }))
    expect(classes).toContain('invisible')
    expect(classes).toContain('opacity-0')
  })

  test('paints the active badge', () => {
    const classes = classesOf(markup({ active: true }))
    expect(classes).toContain('opacity-100')
    expect(classes).not.toContain('invisible')
  })

  // `visibility: hidden` keeps the box, so the caption row it sits in cannot
  // reflow as the badge lights and clears.
  test('never unmounts, so the row keeps its width in both states', () => {
    for (const active of [true, false]) {
      expect(markup({ active })).toContain(`${PTT_INDICATOR_ATTR}=""`)
    }
  })

  // The #226 render probe reads these attributes to say what was actually
  // committed; they are the only record of the badge that is not derived from
  // the store the badge is showing.
  test('keeps the render-probe attributes for both scopes', () => {
    const self = markup({ active: true, scope: 'self' })
    expect(self).toContain(`${PTT_SCOPE_ATTR}="self"`)
    expect(self).toContain(`${PTT_ACTIVE_ATTR}="true"`)

    const peer = markup({ active: false })
    expect(peer).toContain(`${PTT_SCOPE_ATTR}="peer"`)
    expect(peer).toContain(`${PTT_ACTIVE_ATTR}="false"`)
  })
})
