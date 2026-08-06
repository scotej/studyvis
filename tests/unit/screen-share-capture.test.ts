import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  EntireScreenShareRequiredError,
  requestScreenShareStream,
  SCREEN_SHARE_MAX_FPS,
  type ScreenShareCaptureRuntime,
} from '@/features/session/screenShare'

const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130.0.0.0'
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15'

function track(
  kind: 'video' | 'audio',
  displaySurface?: string
): MediaStreamTrack {
  return {
    kind,
    getSettings: () => ({ displaySurface }),
    stop: vi.fn(),
  } as unknown as MediaStreamTrack
}

function stream(...tracks: MediaStreamTrack[]): MediaStream {
  return {
    getTracks: () => tracks,
    getVideoTracks: () =>
      tracks.filter((candidate) => candidate.kind === 'video'),
  } as unknown as MediaStream
}

function runtime(
  userAgent: string,
  captured: MediaStream
): ScreenShareCaptureRuntime & {
  getDisplayMedia: ReturnType<typeof vi.fn>
} {
  return {
    userAgent,
    getDisplayMedia: vi.fn().mockResolvedValue(captured),
  }
}

describe('screen-share capture source policy', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('prefers and accepts an entire monitor on Windows', async () => {
    const video = track('video', 'monitor')
    const captured = stream(video)
    const captureRuntime = runtime(WINDOWS_UA, captured)

    const attempt = requestScreenShareStream(captureRuntime)

    // getDisplayMedia must be called before the first await so WebView2's
    // transient user activation is still live.
    expect(captureRuntime.getDisplayMedia).toHaveBeenCalledWith({
      video: {
        frameRate: { max: SCREEN_SHARE_MAX_FPS },
        displaySurface: 'monitor',
      },
      audio: false,
      monitorTypeSurfaces: 'include',
    })
    await expect(attempt).resolves.toBe(captured)
    expect(video.stop).not.toHaveBeenCalled()
  })

  test('uses the browser capture adapter when no runtime is injected', async () => {
    const video = track('video', 'monitor')
    const captured = stream(video)
    const getDisplayMedia = vi.fn().mockResolvedValue(captured)
    vi.stubGlobal('navigator', {
      userAgent: WINDOWS_UA,
      mediaDevices: { getDisplayMedia },
    })

    const attempt = requestScreenShareStream()

    expect(getDisplayMedia).toHaveBeenCalledTimes(1)
    await expect(attempt).resolves.toBe(captured)
    expect(video.stop).not.toHaveBeenCalled()
  })

  test.each(['window', 'browser', undefined])(
    'rejects a %s source on Windows and stops every returned track',
    async (displaySurface) => {
      const video = track('video', displaySurface)
      const audio = track('audio')
      const captured = stream(video, audio)
      const publish = vi.fn()

      await expect(
        requestScreenShareStream(runtime(WINDOWS_UA, captured)).then(publish)
      ).rejects.toBeInstanceOf(EntireScreenShareRequiredError)

      expect(video.stop).toHaveBeenCalledTimes(1)
      expect(audio.stop).toHaveBeenCalledTimes(1)
      expect(publish).not.toHaveBeenCalled()
    }
  )

  test('rejects a Windows capture with no video track', async () => {
    const audio = track('audio')

    await expect(
      requestScreenShareStream(runtime(WINDOWS_UA, stream(audio)))
    ).rejects.toBeInstanceOf(EntireScreenShareRequiredError)

    expect(audio.stop).toHaveBeenCalledTimes(1)
  })

  test('rejects a Windows capture whose track settings cannot be read', async () => {
    const video = {
      kind: 'video',
      getSettings: () => {
        throw new Error('settings unavailable')
      },
      stop: vi.fn(),
    } as unknown as MediaStreamTrack

    await expect(
      requestScreenShareStream(runtime(WINDOWS_UA, stream(video)))
    ).rejects.toBeInstanceOf(EntireScreenShareRequiredError)

    expect(video.stop).toHaveBeenCalledTimes(1)
  })

  test('keeps the existing source choice on macOS', async () => {
    const video = track('video', 'window')
    const captured = stream(video)
    const captureRuntime = runtime(MAC_UA, captured)

    await expect(requestScreenShareStream(captureRuntime)).resolves.toBe(
      captured
    )
    expect(captureRuntime.getDisplayMedia).toHaveBeenCalledWith({
      video: { frameRate: { max: SCREEN_SHARE_MAX_FPS } },
      audio: false,
    })
    expect(video.stop).not.toHaveBeenCalled()
  })
})
