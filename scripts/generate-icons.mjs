#!/usr/bin/env node
// Generates StudyVis app + tray icons from the in-code Logo design.
// One-shot codegen: run after touching the Logo geometry, commit the PNGs.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const ROOT = path.resolve(import.meta.dirname, '..')
const ICONS_DIR = path.join(ROOT, 'src-tauri', 'icons')
const TRAY_DIR = path.join(ICONS_DIR, 'tray')

const ACCENT = '#E8A87C'
const SAGE = '#7FB069'

const APP_SIZES = [32, 64, 128, 256, 512, 1024]
const TRAY_SIZES = [16, 20, 22, 24]

function appSvg(px) {
  const radius = Math.round(px * 0.25)
  const r = Math.round(px * 0.3)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">
  <rect x="0" y="0" width="${px}" height="${px}" rx="${radius}" ry="${radius}" fill="${ACCENT}"/>
  <circle cx="${px / 2}" cy="${px / 2}" r="${r}" fill="${SAGE}"/>
</svg>`
}

function traySvg(px) {
  const radius = Math.max(2, Math.round(px * 0.2))
  const r = Math.round(px * 0.28)
  const stroke = Math.max(1, Math.round(px / 12))
  const inner = stroke / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">
  <rect x="${inner}" y="${inner}" width="${px - inner * 2}" height="${px - inner * 2}"
        rx="${radius}" ry="${radius}" fill="none" stroke="white" stroke-width="${stroke}"/>
  <circle cx="${px / 2}" cy="${px / 2}" r="${r}" fill="white"/>
</svg>`
}

async function render(svg, outPath, size) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(outPath)
}

async function main() {
  await mkdir(ICONS_DIR, { recursive: true })
  await mkdir(TRAY_DIR, { recursive: true })

  const masterSize = 1024
  const masterSvg = appSvg(masterSize)
  const masterPath = path.join(ICONS_DIR, 'icon.png')
  await writeFile(masterPath, await sharp(Buffer.from(masterSvg)).png().toBuffer())

  for (const size of APP_SIZES) {
    const file = size === 256 ? '256x256.png' : `${size}x${size}.png`
    await render(appSvg(size), path.join(ICONS_DIR, file), size)
  }
  await render(appSvg(256), path.join(ICONS_DIR, '128x128@2x.png'), 256)

  for (const size of TRAY_SIZES) {
    await render(traySvg(size), path.join(TRAY_DIR, `${size}x${size}.png`), size)
  }

  console.log('Generated app icons + tray icons under src-tauri/icons/')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
