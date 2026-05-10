#!/usr/bin/env tsx
// Generates the 384×384 benchmark image bundled with the AI feature for
// V2-P2's first-run benchmark. We commit the produced PNG so installs don't
// need sharp at runtime; this script is the canonical source of truth and
// runs once when the rendered image needs refreshing.
//
// Run: `npx tsx scripts/generate-benchmark-image.ts`

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'

const SIZE = 384
const OUT = resolve(
  import.meta.dirname,
  '..',
  'src',
  'features',
  'ai',
  'assets',
  'benchmark-desk.png'
)

// A flat-shaded synthetic "desk" scene: brown surface, dark grey monitor with
// a lighter screen rectangle, off-white paper square, accent-tinted mug.
// Realistic enough to give the vision projector something to embed; not
// claiming to be photographic.
const DESK = '#8a6a4a'
const WALL = '#2a2e36'
const MONITOR = '#1a1d24'
const SCREEN = '#3b6a8c'
const PAPER = '#ece9df'
const MUG = '#e8a87c'
const PEN = '#222630'

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" fill="${WALL}"/>
  <rect x="0" y="220" width="${SIZE}" height="${SIZE - 220}" fill="${DESK}"/>
  <rect x="56" y="80" width="180" height="140" rx="6" fill="${MONITOR}"/>
  <rect x="68" y="92" width="156" height="116" fill="${SCREEN}"/>
  <rect x="120" y="220" width="52" height="14" fill="${MONITOR}"/>
  <rect x="248" y="180" width="100" height="60" rx="4" fill="${PAPER}"/>
  <rect x="256" y="195" width="80" height="3" fill="#888"/>
  <rect x="256" y="208" width="64" height="3" fill="#888"/>
  <rect x="256" y="221" width="72" height="3" fill="#888"/>
  <rect x="280" y="240" width="50" height="6" fill="${PEN}"/>
  <circle cx="320" cy="290" r="22" fill="${MUG}"/>
  <rect x="334" y="278" width="14" height="22" rx="6" fill="${MUG}"/>
</svg>
`

async function main() {
  const png = await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9, palette: true })
    .toBuffer()
  await writeFile(OUT, png)
  process.stdout.write(
    `wrote ${OUT} (${png.byteLength} bytes, ${SIZE}×${SIZE})\n`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
