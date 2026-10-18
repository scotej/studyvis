import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

// Exercise the production React components and Radix focus behavior in a real
// browser. Only each fixture's persistence/permission boundary is replaced.
export async function withComponentBrowser(source, run) {
  const entry = '/__component-test.tsx'
  const fixtureId = `${process.cwd()}${entry}`
  const server = await createServer({
    cacheDir: join(
      tmpdir(),
      `studyvis-components-${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16)}`
    ),
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      watch: { ignored: ['**/storybook-static/**', '**/dist/**'] },
    },
    plugins: [
      {
        name: 'component-regression-fixture',
        enforce: 'pre',
        resolveId: (id) =>
          id === entry || id === fixtureId ? fixtureId : null,
        load: (id) => (id === fixtureId ? source : null),
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url !== '/') return next()
            res.setHeader('Content-Type', 'text/html')
            void vite
              .transformIndexHtml(
                '/',
                `<!doctype html><html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`
              )
              .then((html) => res.end(html))
              .catch(next)
          })
        },
      },
    ],
  })
  let browser
  const errors = []
  try {
    await server.listen()
    browser = await chromium.launch({
      executablePath: process.env.LAB_CHROME_EXECUTABLE,
    })
    const page = await browser.newPage()
    page.setDefaultTimeout(10000)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.resolvedUrls.local[0], { timeout: 45000 })
    await page.waitForFunction(() => window.fixture, undefined, {
      timeout: 45000,
    })
    await run(page)
    assert.deepEqual(errors, [], 'fixture must have no uncaught browser errors')
  } finally {
    await browser?.close()
    await server.close()
  }
}
