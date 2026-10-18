import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createBrowserConnection } from '@/features/mirror/browserConnection'

const sockets: FakeSocket[] = []
class FakeSocket {
  static OPEN = 1
  readyState = 0
  onclose: ((event: { code: number }) => void) | null = null
  constructor() {
    sockets.push(this)
  }
  close() {
    this.readyState = 3
    this.onclose?.({ code: 1000 })
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  sockets.length = 0
  const storage = new Map<string, string>()
  storage.set('studyvis.mirror.snapshot.v1', JSON.stringify({ cached: true }))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  })
  vi.stubGlobal('window', { isSecureContext: false })
  vi.stubGlobal('location', {
    protocol: 'https:',
    origin: 'https://companion.test',
  })
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('companion pairing ownership (#412)', () => {
  test('late success after Disconnect cannot restore the cleared session', async () => {
    const response = deferred<Response>()
    const fetch = vi.fn(() => response.promise)
    vi.stubGlobal('fetch', fetch)
    const connection = createBrowserConnection()
    const pairing = connection.pair('test-password')
    const signal = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
      .signal!
    connection.disconnect()
    expect(signal.aborted).toBe(true)
    const disconnected = connection.getState()
    response.resolve(new Response(null, { status: 200 }))
    await pairing
    expect(connection.getState()).toEqual(disconnected)
    expect(connection.getState().status).toBe('pairing')
    expect(localStorage.getItem('studyvis.mirror.snapshot.v1')).toBeNull()
    expect(sockets).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each(['success', 'failure', 'rejection'] as const)(
    'an old %s cannot alter a replacement pairing',
    async (outcome) => {
      const older = deferred<Response>()
      const newer = deferred<Response>()
      const fetch = vi
        .fn()
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(newer.promise)
      vi.stubGlobal('fetch', fetch)
      const connection = createBrowserConnection()
      const first = connection.pair('old-password')
      const firstSignal = (fetch.mock.calls[0][1] as RequestInit).signal!
      const second = connection.pair('new-password')
      expect(firstSignal.aborted).toBe(true)
      newer.resolve(new Response(null, { status: 200 }))
      await second
      const current = connection.getState()
      if (outcome === 'rejection')
        older.reject(new Error('stale network error'))
      else
        older.resolve(
          new Response(null, { status: outcome === 'success' ? 200 : 429 })
        )
      await expect(first).resolves.toBeUndefined()
      expect(connection.getState()).toEqual(current)
      expect(connection.getState().error).toBeNull()
      expect(sockets).toHaveLength(1)
      connection.disconnect()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  test('fresh explicit retry works after cancellation and current failures remain visible', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('network unavailable'))
        .mockResolvedValueOnce(new Response(null, { status: 429 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
    )
    const connection = createBrowserConnection()
    await expect(connection.pair('password')).rejects.toThrow(
      'network unavailable'
    )
    await expect(connection.pair('password')).rejects.toThrow('Pairing failed')
    expect(connection.getState().error).toBe('rate_limited')
    connection.disconnect()
    await connection.pair('password')
    expect(connection.getState().status).toBe('connecting')
    expect(sockets).toHaveLength(1)
    connection.disconnect()
    expect(vi.getTimerCount()).toBe(0)
  })
})
