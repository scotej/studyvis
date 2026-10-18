import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withComponentBrowser } from './component-browser.mjs'

const source = `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Toaster } from 'sonner'
import { IdentitySetupGate } from '@/features/identity/IdentitySetupGate'
import { generateIdentity } from '@/lib/crypto/identity'
import '@/design/index.css'
const pending = [], events = []
let created = 0
const root = createRoot(document.getElementById('root'))
function App() {
  const [screen, setScreen] = useState('setup')
  return <>{screen === 'setup' ? <IdentitySetupGate create={() => {
    created++
    const identity = generateIdentity()
    return { mnemonic: identity.mnemonic, commit: () => new Promise((resolve,reject) => pending.push({resolve,reject})) }
  }} onBack={() => { events.push('back'); setScreen('back') }} onConfirmed={() => { events.push('confirmed'); setScreen('name') }} /> : <p>{screen}</p>}<Toaster /></>
}
flushSync(() => root.render(<App />))
window.fixture = {
  settle: (fail = false) => fail ? pending[0].reject(new Error('fixture failure')) : pending[0].resolve(),
  unmount: () => flushSync(() => root.unmount()),
  pending: () => pending.length,
  created: () => created,
  events,
}
`

async function submit(page) {
  await page.getByRole('checkbox').click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.waitForFunction(() => window.fixture.pending() === 1)
}

for (const fail of [false, true]) {
  test(`confirmed identity locks Back during delayed ${fail ? 'failure' : 'success'}`, async () => {
    await withComponentBrowser(source, async (page) => {
      await submit(page)
      const back = page.getByRole('button', { name: 'Back', exact: true })
      assert.equal(await back.isDisabled(), true)
      await page.keyboard.press('Shift+Tab')
      assert.equal(await page.evaluate(() => window.fixture.created()), 1)
      await page.evaluate((failed) => window.fixture.settle(failed), fail)
      if (fail) {
        await page.waitForFunction(
          () => !document.querySelector('button[aria-disabled="true"]')
        )
        assert.equal(await back.isEnabled(), true)
        await back.click()
        assert.deepEqual(await page.evaluate(() => window.fixture.events), [
          'back',
        ])
      } else {
        await page.getByText('name', { exact: true }).waitFor()
        assert.deepEqual(await page.evaluate(() => window.fixture.events), [
          'confirmed',
        ])
      }
    })
  })
  test(`unmount ignores delayed identity ${fail ? 'failure' : 'success'}`, async () => {
    await withComponentBrowser(source, async (page) => {
      await submit(page)
      await page.evaluate(() => window.fixture.unmount())
      await page.evaluate((failed) => window.fixture.settle(failed), fail)
      await page.waitForTimeout(50)
      assert.deepEqual(await page.evaluate(() => window.fixture.events), [])
      assert.equal(await page.locator('[data-sonner-toast]').count(), 0)
    })
  })
}

test('Back remains available before a commit', async () => {
  await withComponentBrowser(source, async (page) => {
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.events), ['back'])
    assert.equal(await page.evaluate(() => window.fixture.pending()), 0)
  })
})
