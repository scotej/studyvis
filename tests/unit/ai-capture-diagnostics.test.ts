import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  CaptureError,
  getCaptureRuntime,
  type CaptureFrame,
} from '@/features/ai/captureShared'
import { __resetLog, recentRecords } from '@/lib/log'

let now: number

beforeEach(() => {
  now = 0
  __resetLog()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  __resetLog()
})

const records = () => recentRecords().filter((r) => r.scope === 'ai.capture')
const frame = (): CaptureFrame => ({
  bitmap: {
    privateFrame: 'unrelated screen content',
  } as unknown as ImageBitmap,
  sourceWidth: 2560,
  sourceHeight: 1440,
})

function installCanvas(options: {
  fallback?: boolean
  drawMs?: number
  blobCallMs?: number
  blobSettleMs?: number
  arrayBufferMs?: number
  base64Ms?: number
  error?: Error
}) {
  const bytes = new Uint8Array([255, 0, 100])
  const blob = {
    arrayBuffer: async () => {
      now += options.arrayBufferMs ?? 0
      return bytes.buffer
    },
  } as Blob
  const drawImage = vi.fn(() => {
    now += options.drawMs ?? 0
  })
  const convertToBlob = vi.fn(() => {
    now += options.blobCallMs ?? 0
    return Promise.resolve().then(() => {
      now += options.blobSettleMs ?? 0
      if (options.error) throw options.error
      return blob
    })
  })
  const toBlob = vi.fn((callback: BlobCallback) => {
    now += options.blobCallMs ?? 0
    void Promise.resolve().then(() => {
      now += options.blobSettleMs ?? 0
      callback(blob)
    })
  })
  class FakeCanvas {
    getContext = () => ({ drawImage })
    convertToBlob = convertToBlob
    toBlob = toBlob
    width = 0
    height = 0
  }
  if (options.fallback) {
    vi.stubGlobal('OffscreenCanvas', undefined)
    vi.stubGlobal('document', { createElement: () => new FakeCanvas() })
  } else {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas)
  }
  const originalBtoa = btoa
  vi.spyOn(globalThis, 'btoa').mockImplementation((value) => {
    now += options.base64Ms ?? 0
    return originalBtoa(value)
  })
  return { drawImage, convertToBlob, toBlob }
}

function encode() {
  return getCaptureRuntime().encodeJpegBase64({
    frame: frame(),
    targetWidth: 1024,
    targetHeight: 576,
    quality: 0.7,
  })
}

function installVideo(options: {
  attachMs?: number
  playMs?: number
  metadataMs?: number
  frameWaitMs?: number
  pauseMs?: number
  detachMs?: number
  timeout?: boolean
}) {
  class FakeVideo extends EventTarget {
    videoWidth = 1280
    videoHeight = 720
    error = null
    muted = false
    playsInline = false
    autoplay = false
    private stream: unknown = null
    set srcObject(value: unknown) {
      now += value === null ? (options.detachMs ?? 0) : (options.attachMs ?? 0)
      this.stream = value
    }
    get srcObject() {
      return this.stream
    }
    play = vi.fn(() => {
      now += options.playMs ?? 0
      if (!options.timeout) {
        setTimeout(() => {
          now += options.metadataMs ?? 0
          this.dispatchEvent(new Event('loadedmetadata'))
        }, options.metadataMs ?? 0)
      }
      return Promise.resolve()
    })
    pause = vi.fn(() => {
      now += options.pauseMs ?? 0
    })
    requestVideoFrameCallback(callback: () => void) {
      return setTimeout(() => {
        now += options.frameWaitMs ?? 0
        callback()
      }, options.frameWaitMs ?? 0)
    }
  }
  const video = new FakeVideo()
  vi.stubGlobal('HTMLVideoElement', FakeVideo)
  vi.stubGlobal('MediaStream', class {})
  vi.stubGlobal('document', { createElement: () => video })
  const stop = vi.fn()
  const track = {
    kind: 'video',
    readyState: 'live',
    label: 'private camera label',
    id: 'private device identifier',
    getSettings: () => ({ deviceId: 'private settings identifier' }),
    stop,
  } as unknown as MediaStreamTrack
  return { video, track, stop }
}

describe('slow capture diagnostics', () => {
  test('fast captures stay silent, including a duration that rounds up to 1 second', async () => {
    installCanvas({ drawMs: 999.6 })
    await expect(encode()).resolves.toBe('/wBk')
    expect(records()).toEqual([])
  })

  test.each([false, true])(
    'separates native drawing/blob calls from asynchronous waits (fallback=%s)',
    async (fallback) => {
      const canvas = installCanvas({
        fallback,
        drawMs: 1100,
        blobCallMs: 200,
        blobSettleMs: 500,
        arrayBufferMs: 300,
        base64Ms: 100,
      })
      await expect(encode()).resolves.toBe('/wBk')
      expect(canvas.drawImage).toHaveBeenCalledExactlyOnceWith(
        frame().bitmap,
        0,
        0,
        2560,
        1440,
        0,
        0,
        1024,
        576
      )
      expect(records()).toHaveLength(1)
      expect(records()[0]?.data).toEqual({
        operation: 'encode',
        outcome: 'ready',
        elapsedMs: 2200,
        backend: fallback ? 'canvas' : 'offscreen',
        sourceWidth: 2560,
        sourceHeight: 1440,
        targetWidth: 1024,
        targetHeight: 576,
        drawMs: 1100,
        blobCallMs: 200,
        blobSettleMs: 500,
        arrayBufferMs: 300,
        base64Ms: 100,
      })
    }
  )

  test('retains successive slow traces and excludes source content and native error text', async () => {
    const error = new Error('private native error with file content')
    installCanvas({ blobSettleMs: 1000, error })
    await expect(encode()).rejects.toBe(error)
    await expect(encode()).rejects.toBe(error)
    expect(records()).toHaveLength(2)
    for (const record of records()) {
      expect(record.lvl).toBe('debug')
      expect(record.data).toMatchObject({
        operation: 'encode',
        outcome: 'failed',
        elapsedMs: 1000,
        blobCallMs: 0,
        blobSettleMs: 1000,
      })
      expect(JSON.stringify(record)).not.toMatch(/private|content/)
      expect(
        Object.values(record.data ?? {}).every(
          (value) =>
            typeof value === 'number' ||
            ['encode', 'failed', 'offscreen'].includes(String(value))
        )
      ).toBe(true)
    }
  })

  test('attributes composite drawing without logging frame objects or placements', async () => {
    const canvas = installCanvas({ drawMs: 600 })
    await expect(
      getCaptureRuntime().encodeCompositeJpegBase64({
        placements: [
          { frame: frame(), x: 0, y: 0, width: 1024, height: 576 },
          { frame: frame(), x: 1024, y: 0, width: 1024, height: 576 },
        ],
        outputWidth: 2048,
        outputHeight: 576,
        quality: 0.7,
      })
    ).resolves.toBe('/wBk')
    expect(canvas.drawImage).toHaveBeenCalledTimes(2)
    expect(records()[0]?.data).toEqual({
      operation: 'composite',
      outcome: 'ready',
      elapsedMs: 1200,
      backend: 'offscreen',
      targetWidth: 2048,
      targetHeight: 576,
      frameCount: 2,
      drawMs: 1200,
      blobCallMs: 0,
      blobSettleMs: 0,
      arrayBufferMs: 0,
      base64Ms: 0,
    })
  })

  test('separates video attachment/play from metadata/frame readiness without stopping its track', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { video, track, stop } = installVideo({
      attachMs: 200,
      playMs: 100,
      metadataMs: 300,
      frameWaitMs: 400,
    })
    const pending = getCaptureRuntime().extractFrame(track)
    await vi.advanceTimersByTimeAsync(700)
    await expect(pending).resolves.toMatchObject({
      bitmap: video,
      sourceWidth: 1280,
      sourceHeight: 720,
    })
    expect(records()[0]?.data).toEqual({
      operation: 'extract',
      outcome: 'ready',
      elapsedMs: 1000,
      backend: 'video',
      attachMs: 200,
      playMs: 100,
      metadataMs: 300,
      frameWaitMs: 400,
      sourceWidth: 1280,
      sourceHeight: 720,
    })
    expect(JSON.stringify(records())).not.toMatch(/private|identifier|label/)
    expect(video.srcObject).not.toBeNull()
    expect(stop).not.toHaveBeenCalled()
  })

  test('records the unchanged readiness timeout and cleanup on failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { video, track, stop } = installVideo({
      timeout: true,
      pauseMs: 100,
      detachMs: 200,
    })
    const pending = getCaptureRuntime().extractFrame(track)
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'frame_extraction_failed',
      message: 'timed out waiting for first decoded frame after 1500 ms',
    })
    now += 1500
    await vi.advanceTimersByTimeAsync(1500)
    await assertion
    expect(video.pause).toHaveBeenCalledOnce()
    expect(video.srcObject).toBeNull()
    expect(stop).not.toHaveBeenCalled()
    expect(records()[0]?.data).toEqual({
      operation: 'extract',
      outcome: 'failed',
      elapsedMs: 1800,
      backend: 'video',
      attachMs: 0,
      playMs: 0,
      metadataMs: 1500,
      pauseMs: 100,
      detachMs: 200,
    })
  })

  test('records slow video disposal and releases the video without stopping the track', () => {
    const { video, stop } = installVideo({ pauseMs: 600, detachMs: 400 })
    getCaptureRuntime().disposeFrame({
      bitmap: video as unknown as HTMLVideoElement,
      sourceWidth: 1280,
      sourceHeight: 720,
    })
    expect(video.pause).toHaveBeenCalledOnce()
    expect(video.srcObject).toBeNull()
    expect(stop).not.toHaveBeenCalled()
    expect(records()[0]?.data).toEqual({
      operation: 'dispose',
      outcome: 'ready',
      elapsedMs: 1000,
      backend: 'video',
      sourceWidth: 1280,
      sourceHeight: 720,
      pauseMs: 600,
      detachMs: 400,
    })
  })

  test('retains best-effort bitmap disposal even when a slow native close throws', () => {
    vi.stubGlobal('HTMLVideoElement', class {})
    const bitmap = {
      close: () => {
        now += 1000
        throw new CaptureError('encode_failed', 'private native close error')
      },
    } as unknown as ImageBitmap
    expect(() =>
      getCaptureRuntime().disposeFrame({ ...frame(), bitmap })
    ).not.toThrow()
    expect(records()[0]?.data).toEqual({
      operation: 'dispose',
      outcome: 'ready',
      elapsedMs: 1000,
      backend: 'bitmap',
      sourceWidth: 2560,
      sourceHeight: 1440,
      closeMs: 1000,
    })
    expect(JSON.stringify(records())).not.toMatch(/private|error/)
  })
})
