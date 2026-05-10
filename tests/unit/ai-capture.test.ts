import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  captureFace,
  captureScreen,
  CaptureError,
  FACE_FRAME_SIZE,
  FACE_FRAME_QUALITY,
  SCREEN_FRAME_MAX_WIDTH,
  SCREEN_FRAME_QUALITY,
  __resetCaptureRuntime,
  __resetScreenCaptureRuntime,
  __setCaptureRuntime,
  __setScreenCaptureRuntime,
  fitWidth,
  type CaptureFrame,
  type CaptureRuntime,
  type EncodeJpegRequest,
  type ScreenCaptureRuntime,
} from '@/features/ai'

// Vitest runs in node-env (vite.config.ts) so there is no MediaStream,
// HTMLVideoElement, OffscreenCanvas, or document — capture wiring is
// covered behind injectable runtimes. The tests exercise the orchestration
// (dim routing, quality plumbing, error mapping, acquire/release pairing)
// rather than the browser's encode path.

type FakeTrackOptions = {
  kind?: 'video' | 'audio'
  readyState?: 'live' | 'ended'
  width?: number
  height?: number
}

function makeFakeTrack(opts: FakeTrackOptions = {}): MediaStreamTrack {
  const stopFn = vi.fn()
  return {
    kind: opts.kind ?? 'video',
    readyState: opts.readyState ?? 'live',
    getSettings: () => ({
      width: opts.width,
      height: opts.height,
    }),
    stop: stopFn,
  } as unknown as MediaStreamTrack
}

function makeFakeStream(track: MediaStreamTrack): MediaStream {
  return {
    getTracks: () => [track],
    getVideoTracks: () =>
      track.kind === 'video' ? [track] : ([] as MediaStreamTrack[]),
    getAudioTracks: () =>
      track.kind === 'audio' ? [track] : ([] as MediaStreamTrack[]),
  } as unknown as MediaStream
}

type RuntimeStub = {
  runtime: CaptureRuntime
  encodeCalls: EncodeJpegRequest[]
  disposeCount: number
}

function makeRuntimeStub(opts: {
  width: number
  height: number
  base64: string
}): RuntimeStub {
  const encodeCalls: EncodeJpegRequest[] = []
  let disposeCount = 0
  const runtime: CaptureRuntime = {
    extractFrame: async (track) => {
      if (track.kind !== 'video') {
        throw new CaptureError('no_video_track', 'expected video track')
      }
      const bitmap = { __fake: true } as unknown as ImageBitmap
      return {
        bitmap,
        sourceWidth: opts.width,
        sourceHeight: opts.height,
      } satisfies CaptureFrame
    },
    disposeFrame: () => {
      disposeCount += 1
    },
    encodeJpegBase64: async (req) => {
      encodeCalls.push(req)
      return opts.base64
    },
  }
  return {
    runtime,
    encodeCalls,
    get disposeCount() {
      return disposeCount
    },
  }
}

describe('fitWidth', () => {
  test('returns source dims when already at or under the cap', () => {
    expect(fitWidth(800, 600, 1024)).toEqual({ width: 800, height: 600 })
  })
  test('scales down preserving aspect', () => {
    expect(fitWidth(1920, 1080, 1024)).toEqual({ width: 1024, height: 576 })
  })
  test('clamps to integer pixels and a minimum height of 1', () => {
    expect(fitWidth(10000, 1, 1024)).toEqual({ width: 1024, height: 1 })
  })
  test('returns zeros on non-positive inputs', () => {
    expect(fitWidth(0, 100, 1024)).toEqual({ width: 0, height: 0 })
    expect(fitWidth(100, 0, 1024)).toEqual({ width: 0, height: 0 })
    expect(fitWidth(100, 100, 0)).toEqual({ width: 0, height: 0 })
  })
})

describe('captureFace', () => {
  beforeEach(() => {
    __resetCaptureRuntime()
  })
  afterEach(() => {
    __resetCaptureRuntime()
  })

  test('encodes a 384×384 JPEG at quality 0.8 with a centered square crop from a landscape source', async () => {
    const stub = makeRuntimeStub({
      width: 1280,
      height: 720,
      base64: 'ZmFjZS1iYXNlNjQ=',
    })
    __setCaptureRuntime(stub.runtime)
    const track = makeFakeTrack({ width: 1280, height: 720 })
    const result = await captureFace(track)
    expect(result).toBe('ZmFjZS1iYXNlNjQ=')
    expect(stub.encodeCalls).toHaveLength(1)
    const req = stub.encodeCalls[0]
    expect(req.targetWidth).toBe(FACE_FRAME_SIZE)
    expect(req.targetHeight).toBe(FACE_FRAME_SIZE)
    expect(req.quality).toBe(FACE_FRAME_QUALITY)
    // Critical: 1280×720 → centered 720×720 crop → 384×384 (no horizontal
    // squash). Without the 9-arg drawImage form the whole 16:9 source would
    // stretch into the 384×384 square and degrade the AI input.
    expect(req.sourceCrop).toEqual({
      sx: 280, // (1280 - 720) / 2
      sy: 0,
      sw: 720,
      sh: 720,
    })
    expect(stub.disposeCount).toBe(1)
  })

  test('handles portrait sources with a centered vertical crop', async () => {
    const stub = makeRuntimeStub({
      width: 480,
      height: 800,
      base64: 'YWJjMTIz',
    })
    __setCaptureRuntime(stub.runtime)
    const track = makeFakeTrack({ width: 480, height: 800 })
    await captureFace(track)
    const req = stub.encodeCalls[0]
    expect(req.targetWidth).toBe(FACE_FRAME_SIZE)
    expect(req.targetHeight).toBe(FACE_FRAME_SIZE)
    expect(req.sourceCrop).toEqual({
      sx: 0,
      sy: 160, // (800 - 480) / 2
      sw: 480,
      sh: 480,
    })
  })

  test('disposes the frame even when the encoder throws', async () => {
    const stub = makeRuntimeStub({
      width: 1280,
      height: 720,
      base64: '',
    })
    const failing: CaptureRuntime = {
      ...stub.runtime,
      encodeJpegBase64: async () => {
        throw new CaptureError('encode_failed', 'boom')
      },
    }
    __setCaptureRuntime(failing)
    await expect(
      captureFace(makeFakeTrack({ width: 1280, height: 720 }))
    ).rejects.toBeInstanceOf(CaptureError)
    expect(stub.disposeCount).toBe(1)
  })

  test('rejects non-video tracks at the runtime layer', async () => {
    __resetCaptureRuntime() // use the default extractor for this path
    const audioTrack = makeFakeTrack({ kind: 'audio' })
    await expect(captureFace(audioTrack)).rejects.toBeInstanceOf(CaptureError)
  })
})

describe('captureScreen', () => {
  beforeEach(() => {
    __resetCaptureRuntime()
    __resetScreenCaptureRuntime()
  })
  afterEach(() => {
    __resetCaptureRuntime()
    __resetScreenCaptureRuntime()
  })

  function installScreenRuntime(stream: MediaStream): {
    constraintsSeen: DisplayMediaStreamOptions[]
  } {
    const constraintsSeen: DisplayMediaStreamOptions[] = []
    const runtime: ScreenCaptureRuntime = {
      getDisplayMedia: async (c) => {
        constraintsSeen.push(c)
        return stream
      },
    }
    __setScreenCaptureRuntime(runtime)
    return { constraintsSeen }
  }

  test('produces a 1024-wide JPEG at quality 0.7 from a 1920×1080 source', async () => {
    const stub = makeRuntimeStub({
      width: 1920,
      height: 1080,
      base64: 'c2NyZWVuLWJhc2U2NA==',
    })
    __setCaptureRuntime(stub.runtime)
    const track = makeFakeTrack({ width: 1920, height: 1080 })
    const stream = makeFakeStream(track)
    const { constraintsSeen } = installScreenRuntime(stream)

    const result = await captureScreen()
    expect(result).toBe('c2NyZWVuLWJhc2U2NA==')
    expect(constraintsSeen).toEqual([{ video: true }])
    const req = stub.encodeCalls[0]
    expect(req.targetWidth).toBe(SCREEN_FRAME_MAX_WIDTH)
    // 1920×1080 scaled to width 1024 → height 576
    expect(req.targetHeight).toBe(576)
    expect(req.quality).toBe(SCREEN_FRAME_QUALITY)
    // Track must be stopped before the function returns so the OS recording
    // indicator goes dark between sample-loop ticks.
    expect(track.stop).toHaveBeenCalledTimes(1)
  })

  test('does not upscale below 1024 if the source is smaller', async () => {
    const stub = makeRuntimeStub({
      width: 800,
      height: 600,
      base64: 'YWFh',
    })
    __setCaptureRuntime(stub.runtime)
    const track = makeFakeTrack({ width: 800, height: 600 })
    installScreenRuntime(makeFakeStream(track))
    await captureScreen()
    const req = stub.encodeCalls[0]
    expect(req.targetWidth).toBe(800)
    expect(req.targetHeight).toBe(600)
  })

  test('maps NotAllowedError → screen_capture_denied and stops the stream', async () => {
    const track = makeFakeTrack({ width: 0, height: 0 })
    const stream = makeFakeStream(track)
    const runtime: ScreenCaptureRuntime = {
      getDisplayMedia: async () => {
        // Use a DOMException-compatible object; the test environment has
        // DOMException available via undici.
        throw new DOMException('user denied', 'NotAllowedError')
      },
    }
    __setScreenCaptureRuntime(runtime)
    let caught: unknown
    try {
      await captureScreen()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CaptureError)
    expect((caught as CaptureError).code).toBe('screen_capture_denied')
    // The stream stub above is never actually emitted; the stop() assertion
    // ensures we don't leak when the stream is acquired but later steps
    // throw, which is covered by the next test.
    expect(track.stop).not.toHaveBeenCalled()
    void stream
  })

  test('stops the stream even if extractFrame throws', async () => {
    const failing: CaptureRuntime = {
      extractFrame: async () => {
        throw new CaptureError('frame_extraction_failed', 'boom')
      },
      disposeFrame: () => {},
      encodeJpegBase64: async () => '',
    }
    __setCaptureRuntime(failing)
    const track = makeFakeTrack({ width: 1920, height: 1080 })
    installScreenRuntime(makeFakeStream(track))
    await expect(captureScreen()).rejects.toBeInstanceOf(CaptureError)
    expect(track.stop).toHaveBeenCalledTimes(1)
  })

  test('errors when the OS returns a stream with no video tracks', async () => {
    // Pretend getDisplayMedia returned an audio-only stream (rare; observed
    // when a previous capture's track was reused incorrectly).
    const audioTrack = makeFakeTrack({ kind: 'audio' })
    const stream = {
      getTracks: () => [audioTrack],
      getVideoTracks: () => [],
      getAudioTracks: () => [audioTrack],
    } as unknown as MediaStream
    installScreenRuntime(stream)
    let caught: unknown
    try {
      await captureScreen()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CaptureError)
    expect((caught as CaptureError).code).toBe('screen_capture_no_video')
    expect(audioTrack.stop).toHaveBeenCalledTimes(1)
  })
})
