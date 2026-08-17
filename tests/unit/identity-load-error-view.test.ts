import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'

import { IdentityLoadErrorView } from '@/features/identity/IdentityLoadErrorView'

const noop = () => undefined

function render(variant: 'keysMissing' | 'keychainUnavailable'): string {
  return renderToStaticMarkup(
    createElement(IdentityLoadErrorView, {
      variant,
      retrying: false,
      onRetry: noop,
      onRecover: noop,
    })
  )
}

describe('IdentityLoadErrorView keychain failures', () => {
  test('an unavailable credential store gives Linux guidance and no recovery action', () => {
    const html = render('keychainUnavailable')

    expect(html).toContain('Unlock your keychain to continue')
    expect(html).toContain('Secret Service provider')
    expect(html).toContain('Try again')
    expect(html).not.toContain('Restore from backup')
    expect(html.match(/<button/g)).toHaveLength(1)
  })

  test('a definitive no-entry result keeps recovery as the primary action', () => {
    const html = render('keysMissing')
    const recoverIndex = html.indexOf('Restore from backup')
    const retryIndex = html.indexOf('Check again')

    expect(recoverIndex).toBeGreaterThan(-1)
    expect(retryIndex).toBeGreaterThan(recoverIndex)
    expect(html.match(/<button/g)).toHaveLength(2)
  })
})
