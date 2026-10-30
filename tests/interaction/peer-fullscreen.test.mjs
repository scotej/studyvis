import assert from 'node:assert/strict'
import { test } from 'node:test'

import { withComponentBrowser } from './component-browser.mjs'

const source = `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { VideoTile } from '@/components/VideoTile'
import { ScreenShareViewer } from '@/components/ScreenShareViewer'
import '@/design/index.css'
const streams = []
function capture() {
  const canvas = document.createElement('canvas')
  canvas.width = 640; canvas.height = 360
  const context = canvas.getContext('2d')
  context.fillRect(0, 0, canvas.width, canvas.height)
  const stream = canvas.captureStream(1)
  streams.push(stream)
  return stream
}
function Fixture() {
  const [stream, setStream] = useState(capture)
  const [open, setOpen] = useState(false)
  window.fixture = {
    replace: () => flushSync(() => setStream(capture())),
    stream: () => stream,
    tracks: () => streams.flatMap(s => s.getTracks().map(t => t.readyState)),
  }
  return <>
    <VideoTile name="Alice" stream={stream} volume={0.35} onVolumeChange={() => {}} onExpand={() => setOpen(true)} />
    <VideoTile name="You" stream={stream} isLocal onExpand={() => setOpen(true)} />
    <VideoTile name="Camera off" stream={stream} cameraOff onExpand={() => setOpen(true)} />
    <VideoTile name="Reconnecting" stream={null} onExpand={() => setOpen(true)} />
    <ScreenShareViewer name="Alice" stream={stream} open={open} onOpenChange={setOpen} />
  </>
}
createRoot(document.getElementById('root')).render(<Fixture />)
`

test('peer fullscreen preserves camera playback and restores keyboard focus', async () => {
  await withComponentBrowser(source, async (page) => {
    const trigger = page.getByRole('button', {
      name: 'View Alice in fullscreen',
      exact: true,
    })
    assert.equal(await page.getByRole('button').count(), 1)
    await trigger.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Alice', exact: true })
    await dialog.waitFor()
    await page.waitForFunction(() => {
      const video = document.querySelector(
        '[data-testid="screen-share-viewer-video"]'
      )
      return (
        video.srcObject === window.fixture.stream() &&
        video.videoWidth > 0 &&
        video.readyState >= 2
      )
    })
    assert.deepEqual(
      await page.evaluate(() => {
        const viewer = document.querySelector(
          '[data-testid="screen-share-viewer-video"]'
        )
        const camera = document.querySelector(
          '[data-testid="video-tile"] video'
        )
        return {
          extraVideoMuted: viewer.muted,
          cameraMuted: camera.muted,
          cameraVolume: camera.volume,
        }
      }),
      { extraVideoMuted: true, cameraMuted: false, cameraVolume: 0.35 }
    )
    await page.evaluate(() => window.fixture.replace())
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="screen-share-viewer-video"]')
          .srcObject === window.fixture.stream()
    )
    await page.keyboard.press('Tab')
    assert.equal(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement)
      ),
      true
    )
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(
      await trigger.evaluate((el) => el === document.activeElement),
      true
    )
    assert.deepEqual(await page.evaluate(() => window.fixture.tracks()), [
      'live',
      'live',
    ])
    await trigger.click()
    await dialog.waitFor()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(
      await trigger.evaluate((el) => el === document.activeElement),
      true
    )
  })
})
