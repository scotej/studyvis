import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'

import { SessionOverlayWindow } from '@/features/session/SessionOverlayWindow'

describe('session overlay accessibility', () => {
  test('gives the keyboard-scrollable body a named region', () => {
    const html = renderToStaticMarkup(
      createElement(SessionOverlayWindow, {
        initialSnapshot: {
          item: {
            id: 'message',
            title: 'Detailed update',
            body: 'A message long enough to require keyboard scrolling.',
            tone: 'warning',
            createdAt: 1,
            expiresAt: 60_001,
          },
          queued: 0,
        },
      })
    )

    expect(html).toContain('data-testid="session-overlay-body"')
    expect(html).toContain('role="region"')
    expect(html).toContain('aria-label="Detailed update"')
  })
})
