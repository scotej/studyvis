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

// Match mirror.rs: reserve the controller before Set-Cookie reaches the
// browser, and reject a second unauthenticated request while it is reserved.
function pairingHost() {
  const headers = deferred<void>()
  let reserved = false
  let cookie: string | null = null
  const cookies: (string | null)[] = []
  const aborted: boolean[] = []
  const fetch = vi.fn((_url: string, options: RequestInit) => {
    const index = cookies.length
    const credentialed = options.credentials === 'same-origin'
    const sentCookie = credentialed ? cookie : null
    cookies.push(sentCookie)
    aborted.push(false)
    if (sentCookie === 'controller-token')
      return Promise.resolve(new Response(null, { status: 200 }))
    if (JSON.parse(options.body as string).password !== 'ABCDEFGH')
      return Promise.resolve(new Response(null, { status: 401 }))
    if (reserved) return Promise.resolve(new Response(null, { status: 409 }))
    reserved = true
    return new Promise<Response>((resolve, reject) => {
      const abort = () => {
        // Aborting transport cannot undo the host's committed reservation.
        aborted[index] = true
        reject(new DOMException('Request aborted', 'AbortError'))
      }
      if (options.signal?.aborted) abort()
      else options.signal?.addEventListener('abort', abort, { once: true })
      void headers.promise.then(() => {
        options.signal?.removeEventListener('abort', abort)
        if (aborted[index]) return
        if (credentialed) cookie = 'controller-token'
        resolve(
          new Response(null, {
            status: 200,
            headers: {
              'Set-Cookie':
                '__Host-studyvis-mirror=controller-token; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200',
            },
          })
        )
      })
    })
  })
  return {
    fetch,
    cookies,
    aborted,
    releaseHeaders: () => headers.resolve(),
    isReserved: () => reserved,
    hasCookie: () => cookie !== null,
  }
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
    connection.disconnect()
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
      const second = connection.pair('new-password')
      expect(fetch).toHaveBeenCalledOnce()
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
      expect(fetch).toHaveBeenCalledTimes(2)
      newer.resolve(new Response(null, { status: 200 }))
      await second
      expect(sockets).toHaveLength(1)
      connection.disconnect()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  test('Disconnect preserves a reserved host credential without reopening the cleared view', async () => {
    const host = pairingHost()
    vi.stubGlobal('fetch', host.fetch)
    const connection = createBrowserConnection()
    const first = connection.pair('abcd-efgh')
    expect(host.isReserved()).toBe(true)
    expect(host.hasCookie()).toBe(false)
    connection.disconnect()
    const cleared = connection.getState()
    host.releaseHeaders()
    await first
    expect(host.hasCookie()).toBe(true)
    expect(host.aborted).toEqual([false])
    expect(connection.getState()).toEqual(cleared)
    expect(localStorage.getItem('studyvis.mirror.snapshot.v1')).toBeNull()
    expect(sockets).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)

    await connection.pair('ABCDEFGH')
    expect(host.cookies).toEqual([null, 'controller-token'])
    expect(connection.getState().status).toBe('connecting')
    expect(connection.getState().error).toBeNull()
    expect(sockets).toHaveLength(1)
    connection.disconnect()
  })

  test.each(['Disconnect', 'replacement'] as const)(
    'a fresh Connect after %s waits for the reserved response cookie',
    async (action) => {
      const host = pairingHost()
      vi.stubGlobal('fetch', host.fetch)
      const connection = createBrowserConnection()
      const first = connection.pair('ABCDEFGH')
      if (action === 'Disconnect') connection.disconnect()
      const waiting = connection.getState()
      const second = connection.pair('ABCDEFGH')
      expect(host.isReserved()).toBe(true)
      expect(host.hasCookie()).toBe(false)
      expect(host.fetch).toHaveBeenCalledOnce()
      expect(host.aborted).toEqual([false])
      expect(connection.getState()).toEqual(waiting)
      host.releaseHeaders()
      await Promise.all([first, second])
      expect(host.cookies).toEqual([null, 'controller-token'])
      expect(connection.getState().status).toBe('connecting')
      expect(connection.getState().error).toBeNull()
      expect(sockets).toHaveLength(1)
      connection.disconnect()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  test('only the latest queued Connect uses the retained cookie', async () => {
    const host = pairingHost()
    vi.stubGlobal('fetch', host.fetch)
    const connection = createBrowserConnection()
    const first = connection.pair('ABCDEFGH')
    const superseded = connection.pair('wrong password')
    const latest = connection.pair('ABCDEFGH')
    host.releaseHeaders()
    await Promise.all([first, superseded, latest])
    expect(host.cookies).toEqual([null, 'controller-token'])
    expect(host.fetch.mock.calls[1][1].body).toBe(
      JSON.stringify({ password: 'ABCDEFGH' })
    )
    expect(sockets).toHaveLength(1)
    connection.disconnect()
  })

  test('Disconnect invalidates a queued Connect as well as the pending response', async () => {
    const host = pairingHost()
    vi.stubGlobal('fetch', host.fetch)
    const connection = createBrowserConnection()
    const first = connection.pair('ABCDEFGH')
    const queued = connection.pair('ABCDEFGH')
    connection.disconnect()
    const cleared = connection.getState()
    host.releaseHeaders()
    await Promise.all([first, queued])
    expect(host.hasCookie()).toBe(true)
    expect(host.cookies).toEqual([null])
    expect(connection.getState()).toEqual(cleared)
    expect(sockets).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

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
