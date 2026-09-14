import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { build } from 'vite'

// Uses the same optional Chrome executable override as the desktop lab.
test('production benchmark images load under the shipped CSP', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const result = await build({
    root,
    logLevel: 'error',
    plugins: [
      {
        name: 'benchmark-image-check',
        resolveId(id) {
          if (id === 'benchmark-image-check') return '\0benchmark-image-check'
        },
        load(id) {
          if (id === '\0benchmark-image-check') {
            return `export { prepareBundledBenchmarkImages } from ${JSON.stringify(`${root}src/features/ai/benchmark.ts`)}`
          }
        },
      },
    ],
    build: {
      write: false,
      rollupOptions: {
        input: 'benchmark-image-check',
        preserveEntrySignatures: 'strict',
      },
    },
  })
  const output = (Array.isArray(result) ? result[0] : result).output
  const entry = output.find((item) => item.type === 'chunk' && item.isEntry)
  assert.ok(entry)
  const csp = JSON.parse(
    readFileSync(`${root}src-tauri/tauri.conf.json`, 'utf8')
  ).app.security.csp
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.LAB_CHROME_EXECUTABLE
      ? { executablePath: process.env.LAB_CHROME_EXECUTABLE }
      : {}),
  })
  try {
    const page = await browser.newPage()
    await page.route('http://studyvis.test/**', (route) => {
      const filename = new URL(route.request().url()).pathname.slice(1)
      if (!filename) {
        return route.fulfill({
          contentType: 'text/html',
          headers: { 'Content-Security-Policy': csp },
          body: '<html></html>',
        })
      }
      const asset = output.find((item) => item.fileName === filename)
      if (!asset) return route.fulfill({ status: 404 })
      return route.fulfill({
        contentType: asset.type === 'chunk' ? 'text/javascript' : 'image/png',
        body: asset.type === 'chunk' ? asset.code : Buffer.from(asset.source),
      })
    })
    await page.goto('http://studyvis.test/')
    const images = await page.evaluate(async (entryFile) => {
      const { prepareBundledBenchmarkImages } = await import(`/${entryFile}`)
      const images = await prepareBundledBenchmarkImages()
      const dimensions = async (base64) => {
        const bytes = Uint8Array.from(atob(base64), (char) =>
          char.charCodeAt(0)
        )
        const bitmap = await createImageBitmap(
          new Blob([bytes], { type: images.mimeType })
        )
        const size = [bitmap.width, bitmap.height]
        bitmap.close()
        return size
      }
      return {
        mimeType: images.mimeType,
        face: await dimensions(images.faceBase64),
        screen: await dimensions(images.screenBase64),
      }
    }, entry.fileName)
    assert.deepEqual(images, {
      mimeType: 'image/jpeg',
      face: [384, 384],
      screen: [1024, 576],
    })
  } finally {
    await browser.close()
  }
})
