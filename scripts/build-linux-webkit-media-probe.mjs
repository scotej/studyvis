import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { build } from 'vite'

const outputPath = process.argv[2]
if (!outputPath)
  throw new Error('usage: build-linux-webkit-media-probe.mjs <output.html>')

// Bundle the installed, patched peer implementation so the native probe follows
// the same automatic negotiation and rollback path as the shipped application.
const result = await build({
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  build: {
    write: false,
    minify: false,
    lib: {
      entry: fileURLToPath(
        new URL(
          '../node_modules/@trystero-p2p/core/dist/peer.mjs',
          import.meta.url
        )
      ),
      name: 'StudyVisPeerProbe',
      formats: ['iife'],
    },
  },
})
const outputs = (Array.isArray(result) ? result : [result]).flatMap(
  (bundle) => bundle.output
)
if (outputs.length !== 1 || outputs[0].type !== 'chunk')
  throw new Error('native peer probe must be one self-contained script')
const html = await readFile(
  new URL('./check-linux-webkit-media.html', import.meta.url),
  'utf8'
)
await writeFile(
  outputPath,
  html.replace('<script>', `<script>\n${outputs[0].code}\n</script>\n<script>`)
)
