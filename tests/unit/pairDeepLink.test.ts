import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const native = vi.hoisted(() => ({ getCurrent: vi.fn(), onOpenUrl: vi.fn() }))
vi.mock('@tauri-apps/plugin-deep-link', () => native)

const words = Array<string>(12).fill('abandon')
const url = `studyvis://pair?c=${words.join('-')}`
let runtimeDeliver: (urls: string[]) => void

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  native.onOpenUrl.mockImplementation(async (callback) => {
    runtimeDeliver = callback
    return vi.fn()
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('pair launch delivery', () => {
  test('StrictMode cleanup transfers pending launch IPC to the live subscriber once', async () => {
    let resolve!: (urls: string[]) => void
    native.getCurrent.mockReturnValue(new Promise((done) => (resolve = done)))
    const { subscribePairDeepLink } =
      await import('@/features/friends/pairDeepLink')
    const retired = vi.fn()
    const active = vi.fn()
    subscribePairDeepLink(retired, vi.fn())()
    const cleanup = subscribePairDeepLink(active, vi.fn())
    resolve([url])
    await vi.waitFor(() =>
      expect(active).toHaveBeenCalledExactlyOnceWith(words)
    )
    expect(retired).not.toHaveBeenCalled()
    expect(native.getCurrent).toHaveBeenCalledOnce()
    cleanup()
    const remounted = vi.fn()
    const cleanupRemount = subscribePairDeepLink(remounted, vi.fn())
    await Promise.resolve()
    expect(remounted).not.toHaveBeenCalled()
    runtimeDeliver([url])
    expect(remounted).toHaveBeenCalledExactlyOnceWith(words)
    cleanupRemount()
  })

  test('a result arriving between mounts remains available to the next live subscriber', async () => {
    native.getCurrent.mockResolvedValue([url])
    const { subscribePairDeepLink } =
      await import('@/features/friends/pairDeepLink')
    const retired = vi.fn()
    subscribePairDeepLink(retired, vi.fn())()
    await Promise.resolve()
    const active = vi.fn()
    const cleanup = subscribePairDeepLink(active, vi.fn())
    await vi.waitFor(() =>
      expect(active).toHaveBeenCalledExactlyOnceWith(words)
    )
    expect(retired).not.toHaveBeenCalled()
    expect(native.getCurrent).toHaveBeenCalledOnce()
    cleanup()
  })

  test('production launch and later runtime links each deliver once', async () => {
    native.getCurrent.mockResolvedValue([url])
    const { subscribePairDeepLink } =
      await import('@/features/friends/pairDeepLink')
    const active = vi.fn()
    const cleanup = subscribePairDeepLink(active, vi.fn())
    await vi.waitFor(() => expect(active).toHaveBeenCalledOnce())
    runtimeDeliver([url])
    expect(active).toHaveBeenCalledTimes(2)
    cleanup()
    runtimeDeliver([url])
    expect(active).toHaveBeenCalledTimes(2)
  })
})
