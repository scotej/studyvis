import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { build } from 'vite'

test('validated TURN configurations construct real WebRTC connections', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const result = await build({
    root,
    logLevel: 'error',
    plugins: [
      {
        name: 'turn-uri-constructor-check',
        resolveId(id) {
          if (id === 'turn-uri-check') return '\0turn-uri-check'
        },
        load(id) {
          if (id === '\0turn-uri-check')
            return `
          export { isValidTurnUrl, normalizeTurnServer, useSettingsStore } from ${JSON.stringify(`${root}src/stores/settingsStore.ts`)}
          export { buildIceOptions } from ${JSON.stringify(`${root}src/lib/trystero/ice.ts`)}
        `
        },
      },
    ],
    build: {
      write: false,
      rollupOptions: {
        input: 'turn-uri-check',
        preserveEntrySignatures: 'strict',
      },
    },
  })
  const output = (Array.isArray(result) ? result[0] : result).output
  const entry = output.find((item) => item.type === 'chunk' && item.isEntry)
  assert.ok(entry)
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.LAB_CHROME_EXECUTABLE
      ? { executablePath: process.env.LAB_CHROME_EXECUTABLE }
      : {}),
  })
  try {
    const page = await browser.newPage()
    await page.route('**/*', (route) => {
      const asset = output.find(
        (item) =>
          item.fileName === new URL(route.request().url()).pathname.slice(1)
      )
      return route.fulfill({
        contentType: asset?.type === 'chunk' ? 'text/javascript' : 'text/html',
        body: asset?.type === 'chunk' ? asset.code : '<html></html>',
      })
    })
    await page.goto('http://studyvis.test/')
    const results = await page.evaluate(async (file) => {
      const {
        isValidTurnUrl,
        normalizeTurnServer,
        useSettingsStore,
        buildIceOptions,
      } = await import(`/${file}`)
      const accepted = [
        'turn:relay.example',
        'turn:relay.example:3478?transport=udp',
        'turn:192.0.2.1:3478?transport=tcp',
        'turn:[2001:db8::1]:3478',
        'turns:relay.example:443?transport=tcp',
        'turns:[::1]:5349',
        'turn:[v1.foo]',
        'turn:host%20',
        'turn:foo%3Abar',
        'turn:foo!bar',
        'turn:127.0.0.999',
        'turn:host?transport=UDP',
        'turns:host?transport=udp',
      ]
      const rejected = [
        'turn://relay.example',
        'turn:host:invalid',
        'turn:[bad',
        'turn:host?transport=bogus',
        'turn:host:99999',
        'turn:host/path',
      ]
      const valid = accepted.map((url) => {
        if (!isValidTurnUrl(url)) throw new Error(`rejected valid URI ${url}`)
        const server = normalizeTurnServer({
          url,
          username: 'test',
          credential: 'test',
        })
        useSettingsStore.setState((state) => ({
          values: { ...state.values, turnServer: server },
        }))
        const options = buildIceOptions('auto')
        const pc = new RTCPeerConnection({
          iceServers: options.turnConfig ?? [],
        })
        pc.close()
        return {
          url,
          retained: (options.turnConfig ?? []).some(
            (item) => item.urls === url
          ),
        }
      })
      const invalid = rejected.map((url) => {
        const server = { url, username: 'test', credential: 'test' }
        useSettingsStore.setState((state) => ({
          values: { ...state.values, turnServer: server },
        }))
        const options = buildIceOptions('auto')
        const pc = new RTCPeerConnection({
          iceServers: options.turnConfig ?? [],
        })
        pc.close()
        return {
          url,
          accepted: isValidTurnUrl(url),
          normalized: normalizeTurnServer(server),
          retained: (options.turnConfig ?? []).some(
            (item) => item.urls === url
          ),
        }
      })
      return { valid, invalid }
    }, entry.fileName)
    assert.ok(
      results.valid.every((item) => item.retained),
      JSON.stringify(results)
    )
    assert.ok(
      results.invalid.every(
        (item) => !item.accepted && item.normalized === null && !item.retained
      ),
      JSON.stringify(results)
    )
  } finally {
    await browser.close()
  }
})
