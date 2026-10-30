import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withComponentBrowser } from './component-browser.mjs'
const source = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ShortcutsCategory } from '@/features/settings/categories/ShortcutsCategory'
import { isKeybindCaptureActive } from '@/lib/shortcutCapture'
import { useSettingsStore } from '@/stores/settingsStore'
import '@/design/index.css'
const commits = [], pending = []
useSettingsStore.setState({setShortcutAccelerator: (action,accelerator) => {
  commits.push({action,accelerator})
  return new Promise((resolve,reject) => pending.push({resolve,reject}))
}})
const root = createRoot(document.getElementById('root'))
flushSync(() => root.render(<ShortcutsCategory />))
window.fixture = {
  commits,
  captureActive: isKeybindCaptureActive,
  unmount: () => flushSync(() => root.unmount()),
  settle: (index,fail=false) => fail ? pending[index].reject(new Error('Shortcut refused.')) : pending[index].resolve(),
}
`

const captures = (page) => page.locator('button[aria-pressed]')

test('selecting AI capture disarms friends and assigns the next key only to AI', async () => {
  await withComponentBrowser(source, async (page) => {
    const controls = captures(page)
    await controls.nth(0).click()
    await controls.nth(1).click()
    assert.equal(await controls.nth(0).getAttribute('aria-pressed'), 'false')
    assert.equal(await controls.nth(1).getAttribute('aria-pressed'), 'true')
    await page.keyboard.press('Control+k')
    assert.deepEqual(await page.evaluate(() => window.fixture.commits), [
      { action: 'ptt-ai', accelerator: 'CmdOrCtrl+K' },
    ])
    await page.evaluate(() => window.fixture.settle(0))
    await page.waitForFunction(
      () =>
        document.querySelectorAll('button[aria-pressed="true"]').length === 0
    )
    await controls.nth(0).click()
    await page.keyboard.press('Escape')
    assert.equal(await controls.nth(0).getAttribute('aria-pressed'), 'false')
  })
})

for (const fail of [false, true]) {
  test(`an old pending ${fail ? 'failure' : 'success'} cannot affect a new capture`, async () => {
    await withComponentBrowser(source, async (page) => {
      const controls = captures(page)
      await controls.nth(0).click()
      await page.keyboard.press('Control+k')
      await controls.nth(1).click()
      await page.evaluate((failed) => window.fixture.settle(0, failed), fail)
      await page.waitForTimeout(50)
      assert.equal(await controls.nth(1).getAttribute('aria-pressed'), 'true')
      assert.equal(await page.getByRole('alert').count(), 0)
      await page.keyboard.press('Control+l')
      assert.deepEqual(
        await page.evaluate(() => window.fixture.commits.map((c) => c.action)),
        ['ptt-friends', 'ptt-ai']
      )
      await page.evaluate(() => window.fixture.settle(1))
      await page.waitForFunction(
        () =>
          document.querySelectorAll('button[aria-pressed="true"]').length === 0
      )
    })
  })
}

test('all microphone shortcuts reject collisions before committing', async () => {
  await withComponentBrowser(source, async (page) => {
    const controls = captures(page)
    await controls.nth(0).click()
    await page.keyboard.press('Control+Backslash')
    await page.getByRole('alert').waitFor()
    assert.match(
      await page.getByRole('alert').innerText(),
      /Always-on microphone/
    )
    assert.deepEqual(await page.evaluate(() => window.fixture.commits), [])
    await controls.nth(2).click()
    await page.keyboard.press('Control+BracketLeft')
    await page.getByRole('alert').waitFor()
    assert.match(await page.getByRole('alert').innerText(), /Push to talk/)
    await page.keyboard.press('Control+BracketRight')
    assert.match(await page.getByRole('alert').innerText(), /Talk to AI/)
    assert.deepEqual(await page.evaluate(() => window.fixture.commits), [])
    await page.keyboard.press('Control+k')
    assert.deepEqual(await page.evaluate(() => window.fixture.commits), [
      { action: 'mic-toggle', accelerator: 'CmdOrCtrl+K' },
    ])
    await page.evaluate(() => window.fixture.settle(0))
    await page.waitForFunction(() => !window.fixture.captureActive())
  })
})

const nativeSource =
  source +
  `
window.isTauri = true
const nativeCalls = [], nativePending = []
window.__TAURI_INTERNALS__ = {invoke: (command,args) => {
  if(command !== 'system_set_shortcut_capture_active') throw new Error('Unexpected native command: ' + command)
  nativeCalls.push(args.active)
  return new Promise((resolve) => nativePending.push(resolve))
}}
Object.assign(window.fixture, {nativeCalls, settleNative: (index) => nativePending[index]()})
`

for (const end of ['cancel', 'unmount']) {
  test(`native shortcuts are suppressed before capture arms and restored on ${end}`, async () => {
    await withComponentBrowser(nativeSource, async (page) => {
      const controls = captures(page)
      await controls.nth(2).click()
      await page.waitForFunction(() => window.fixture.nativeCalls.length === 1)
      assert.deepEqual(await page.evaluate(() => window.fixture.nativeCalls), [
        true,
      ])
      assert.equal(await controls.nth(2).getAttribute('aria-pressed'), 'false')
      assert.equal(
        await page.evaluate(() => window.fixture.captureActive()),
        true
      )
      await page.keyboard.press('Control+k')
      assert.deepEqual(await page.evaluate(() => window.fixture.commits), [])
      await page.evaluate(() => window.fixture.settleNative(0))
      await page.waitForFunction(
        () =>
          document.querySelectorAll('button[aria-pressed="true"]').length === 1
      )
      if (end === 'unmount') await page.evaluate(() => window.fixture.unmount())
      else await page.keyboard.press('Escape')
      await page.waitForFunction(() => window.fixture.nativeCalls.length === 2)
      assert.deepEqual(await page.evaluate(() => window.fixture.nativeCalls), [
        true,
        false,
      ])
      assert.equal(
        await page.evaluate(() => window.fixture.captureActive()),
        false
      )
      await page.evaluate(() => window.fixture.settleNative(1))
    })
  })
}

test('a committed held combo stays suppressed until its key is released', async () => {
  await withComponentBrowser(nativeSource, async (page) => {
    const control = captures(page).nth(2)
    await control.click()
    await page.waitForFunction(() => window.fixture.nativeCalls.length === 1)
    await page.evaluate(() => window.fixture.settleNative(0))
    await page.waitForFunction(
      () =>
        document.querySelectorAll('button[aria-pressed="true"]').length === 1
    )
    await page.keyboard.down('Control')
    await page.keyboard.down('k')
    await page.waitForFunction(() => window.fixture.commits.length === 1)
    await page.evaluate(() => window.fixture.settle(0))
    await page.waitForTimeout(30)
    assert.equal(await control.getAttribute('aria-pressed'), 'true')
    assert.equal(
      await page.evaluate(() => window.fixture.captureActive()),
      true
    )
    assert.deepEqual(await page.evaluate(() => window.fixture.nativeCalls), [
      true,
    ])
    await page.keyboard.up('k')
    await page.keyboard.up('Control')
    await page.waitForFunction(() => window.fixture.nativeCalls.length === 2)
    assert.deepEqual(await page.evaluate(() => window.fixture.nativeCalls), [
      true,
      false,
    ])
    await page.evaluate(() => window.fixture.settleNative(1))
    assert.equal(await control.getAttribute('aria-pressed'), 'false')
  })
})

test('releasing Command completes capture even when macOS omits the character keyup', async () => {
  await withComponentBrowser(
    nativeSource.replace(
      'const root =',
      `Object.defineProperty(navigator, 'userAgent', {value: 'Macintosh', configurable: true})\nconst root =`
    ),
    async (page) => {
      const control = captures(page).nth(2)
      await control.click()
      await page.waitForFunction(() => window.fixture.nativeCalls.length === 1)
      await page.evaluate(() => window.fixture.settleNative(0))
      await page.waitForFunction(
        () =>
          document.querySelectorAll('button[aria-pressed="true"]').length === 1
      )
      await page.evaluate(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'k',
            code: 'KeyK',
            metaKey: true,
            bubbles: true,
          })
        )
      })
      await page.waitForFunction(() => window.fixture.commits.length === 1)
      await page.evaluate(() => window.fixture.settle(0))
      assert.equal(await control.getAttribute('aria-pressed'), 'true')
      await page.evaluate(() => {
        document.dispatchEvent(
          new KeyboardEvent('keyup', {
            key: 'Meta',
            code: 'MetaLeft',
            bubbles: true,
          })
        )
      })
      await page.waitForFunction(() => window.fixture.nativeCalls.length === 2)
      assert.equal(await control.getAttribute('aria-pressed'), 'false')
      assert.equal(
        await page.evaluate(() => window.fixture.captureActive()),
        false
      )
      await page.evaluate(() => window.fixture.settleNative(1))
    }
  )
})

test('losing window focus cancels capture and restores native shortcuts', async () => {
  await withComponentBrowser(nativeSource, async (page) => {
    const control = captures(page).nth(2)
    await control.click()
    await page.waitForFunction(() => window.fixture.nativeCalls.length === 1)
    await page.evaluate(() => window.fixture.settleNative(0))
    await page.waitForFunction(
      () =>
        document.querySelectorAll('button[aria-pressed="true"]').length === 1
    )
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.waitForFunction(() => window.fixture.nativeCalls.length === 2)
    assert.equal(await control.getAttribute('aria-pressed'), 'false')
    assert.equal(
      await page.evaluate(() => window.fixture.captureActive()),
      false
    )
    await page.evaluate(() => window.fixture.settleNative(1))
  })
})
