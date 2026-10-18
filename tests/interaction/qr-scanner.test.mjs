import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withComponentBrowser } from './component-browser.mjs'

const source = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { PairQrScanner } from '@/components/PairQrScanner'
const requests = [], tracks = [], errors = []
navigator.mediaDevices.getUserMedia = constraints => new Promise((resolve,reject) => requests.push({constraints,resolve,reject}))
const root = createRoot(document.getElementById('root'))
flushSync(() => root.render(<PairQrScanner label="Scan friend code" onDecode={() => {}} onError={() => errors.push('camera')} />))
window.fixture = {
  cancel: () => flushSync(() => root.unmount()),
  reject: index => requests[index].reject(new DOMException('Denied','NotAllowedError')),
  resolve: index => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 16
    canvas.getContext('2d').fillRect(0,0,16,16)
    const stream = canvas.captureStream(1)
    tracks.push(...stream.getTracks())
    requests[index].resolve(stream)
  },
  requests: () => requests.map(r => r.constraints),
  tracks: () => tracks.map(t => t.readyState),
  errors,
}
`

test('cancelled first acquisition starts no fallback after late rejection', async () => {
  await withComponentBrowser(source, async (page) => {
    await page.evaluate(() => window.fixture.cancel())
    await page.evaluate(() => window.fixture.reject(0))
    await page.waitForTimeout(50)
    assert.equal(
      (await page.evaluate(() => window.fixture.requests())).length,
      1
    )
    assert.deepEqual(await page.evaluate(() => window.fixture.errors), [])
  })
})

for (const fallback of [false, true]) {
  test(`cancelled ${fallback ? 'fallback' : 'initial'} acquisition stops its late stream`, async () => {
    await withComponentBrowser(source, async (page) => {
      if (fallback) {
        await page.evaluate(() => window.fixture.reject(0))
        await page.waitForFunction(() => window.fixture.requests().length === 2)
      }
      await page.evaluate(() => window.fixture.cancel())
      await page.evaluate(
        (index) => window.fixture.resolve(index),
        fallback ? 1 : 0
      )
      await page.waitForFunction(() => window.fixture.tracks()[0] === 'ended')
      assert.deepEqual(await page.evaluate(() => window.fixture.errors), [])
    })
  })
}

for (const fail of [false, true]) {
  test(`live fallback ${fail ? 'reports one failure' : 'succeeds and releases on cancel'}`, async () => {
    await withComponentBrowser(source, async (page) => {
      await page.evaluate(() => window.fixture.reject(0))
      await page.waitForFunction(() => window.fixture.requests().length === 2)
      assert.deepEqual(
        await page.evaluate(() => window.fixture.requests()[1]),
        { video: true }
      )
      if (fail) {
        await page.evaluate(() => window.fixture.reject(1))
        await page.waitForFunction(() => window.fixture.errors.length === 1)
      } else {
        await page.evaluate(() => window.fixture.resolve(1))
        await page.waitForFunction(
          () => document.querySelector('video')?.srcObject
        )
        assert.deepEqual(await page.evaluate(() => window.fixture.tracks()), [
          'live',
        ])
        await page.evaluate(() => window.fixture.cancel())
        assert.deepEqual(await page.evaluate(() => window.fixture.tracks()), [
          'ended',
        ])
      }
    })
  })
}
