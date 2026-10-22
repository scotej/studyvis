import { afterEach, describe, expect, test, vi } from 'vitest'

import { createManagedTurnPeerConnection } from '@/lib/webrtc/managedTurnPeerConnection'

const OLD: RTCIceServer = {
  urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
  username: 'old',
  credential: 'old-secret',
}
const NEXT: RTCIceServer = {
  ...OLD,
  username: 'next',
  credential: 'next-secret',
}

function selected(candidateType: string, url?: string): RTCStatsReport {
  return new Map([
    [
      'transport',
      { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
    ],
    ['pair', { id: 'pair', type: 'candidate-pair', localCandidateId: 'local' }],
    ['local', { id: 'local', type: 'local-candidate', candidateType, url }],
  ]) as unknown as RTCStatsReport
}

class NativeConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = 'connected'
  config: RTCConfiguration
  readonly restartIce = vi.fn()
  readonly getStats = vi.fn(async () => selected('relay', OLD.urls[0]))

  constructor(config: RTCConfiguration) {
    super()
    this.config = structuredClone(config)
  }
  getConfiguration() {
    return structuredClone(this.config)
  }
  setConfiguration(config: RTCConfiguration) {
    this.config = structuredClone(config)
  }
  close() {
    this.connectionState = 'closed'
  }
}

function setup(config: RTCConfiguration = {}, ready = true) {
  let servers = [OLD]
  let changed = () => {}
  const Constructor = createManagedTurnPeerConnection(
    NativeConnection as unknown as typeof RTCPeerConnection,
    {
      getIceServers: () => structuredClone(servers),
      subscribeIceServers: (listener) => {
        changed = listener
        return () => {}
      },
    }
  )
  const connection = new Constructor(config) as unknown as NativeConnection
  if (ready) connection.dispatchEvent(new Event('studyvis:trystero-ready'))
  return {
    connection,
    rotate: (next = [NEXT]) => {
      servers = next
      changed()
    },
  }
}

afterEach(() => vi.useRealTimers())

describe('#499 active managed TURN allocation renewal', () => {
  test('restarts the selected managed allocation after replacing its credentials', async () => {
    const h = setup()
    h.rotate()
    await vi.waitFor(() =>
      expect(h.connection.restartIce).toHaveBeenCalledOnce()
    )
    expect(h.connection.config.iceServers).toEqual([NEXT])
  })

  test.each(['host', 'srflx', 'prflx'])(
    'preserves a selected %s path',
    async (type) => {
      const h = setup()
      h.connection.getStats.mockResolvedValue(selected(type))
      h.rotate()
      await Promise.resolve()
      expect(h.connection.restartIce).not.toHaveBeenCalled()
    }
  )

  test('does not renew a user-owned relay allocation', async () => {
    const h = setup()
    h.connection.getStats.mockResolvedValue(
      selected('relay', 'turn:own.example:3478')
    )
    h.rotate()
    await Promise.resolve()
    expect(h.connection.restartIce).not.toHaveBeenCalled()
  })

  test('supports engines that omit the selected relay URL and transport report', async () => {
    const h = setup()
    const report = new Map(selected('relay'))
    report.delete('transport')
    Object.assign(report.get('pair'), { nominated: true, state: 'succeeded' })
    h.connection.getStats.mockResolvedValue(report as unknown as RTCStatsReport)
    h.rotate()
    await vi.waitFor(() =>
      expect(h.connection.restartIce).toHaveBeenCalledOnce()
    )
  })

  test('same-credential notifications and opt-out do not restart ICE', async () => {
    const h = setup()
    h.rotate([OLD])
    h.rotate([])
    await Promise.resolve()
    expect(h.connection.getStats).not.toHaveBeenCalled()
    expect(h.connection.restartIce).not.toHaveBeenCalled()
    expect(h.connection.config.iceServers).toEqual([])
  })

  test.each(['close', 'opt-out', 'newer-lease'])(
    'discards stats superseded by %s',
    async (action) => {
      const h = setup()
      let resolve!: (report: RTCStatsReport) => void
      h.connection.getStats.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done
        })
      )
      h.rotate()
      if (action === 'close') h.connection.close()
      else if (action === 'opt-out') h.rotate([])
      else h.rotate([{ ...NEXT, username: 'latest' }])
      resolve(selected('relay'))
      await Promise.resolve()
      await Promise.resolve()
      expect(h.connection.restartIce).toHaveBeenCalledTimes(
        action === 'newer-lease' ? 1 : 0
      )
    }
  )

  test('a duplicate notification does not cancel a pending renewal', async () => {
    const h = setup()
    let resolve!: (report: RTCStatsReport) => void
    h.connection.getStats.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    h.rotate()
    h.rotate()
    resolve(selected('relay'))
    await vi.waitFor(() =>
      expect(h.connection.restartIce).toHaveBeenCalledOnce()
    )
  })

  test.each(['connecting', 'disconnected'] as const)(
    'renews after a %s allocation becomes connected',
    async (state) => {
      const h = setup()
      h.connection.connectionState = state
      h.rotate()
      expect(h.connection.getStats).not.toHaveBeenCalled()
      h.connection.connectionState = 'connected'
      h.connection.dispatchEvent(new Event('connectionstatechange'))
      h.connection.dispatchEvent(new Event('connectionstatechange'))
      await vi.waitFor(() =>
        expect(h.connection.restartIce).toHaveBeenCalledOnce()
      )
      expect(h.connection.getStats).toHaveBeenCalledTimes(2)
    }
  )

  test('a resumed direct path stays untouched and a deferred opt-out cancels renewal', async () => {
    const direct = setup()
    direct.connection.connectionState = 'disconnected'
    direct.connection.getStats.mockResolvedValue(selected('host'))
    direct.rotate()
    direct.connection.connectionState = 'connected'
    direct.connection.dispatchEvent(new Event('connectionstatechange'))
    const disabled = setup()
    disabled.connection.connectionState = 'connecting'
    disabled.rotate()
    disabled.rotate([])
    disabled.connection.connectionState = 'connected'
    disabled.connection.dispatchEvent(new Event('connectionstatechange'))
    await Promise.resolve()
    expect(direct.connection.restartIce).not.toHaveBeenCalled()
    expect(disabled.connection.getStats).not.toHaveBeenCalled()
    expect(disabled.connection.restartIce).not.toHaveBeenCalled()
  })

  test('a connected event during stats collection rechecks the newly selected path', async () => {
    const h = setup()
    let resolve!: (report: RTCStatsReport) => void
    h.connection.getStats.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    h.rotate()
    h.connection.connectionState = 'disconnected'
    h.connection.dispatchEvent(new Event('connectionstatechange'))
    h.connection.getStats.mockResolvedValue(selected('host'))
    h.connection.connectionState = 'connected'
    h.connection.dispatchEvent(new Event('connectionstatechange'))
    resolve(selected('relay'))
    await vi.waitFor(() =>
      expect(h.connection.getStats).toHaveBeenCalledTimes(2)
    )
    expect(h.connection.restartIce).not.toHaveBeenCalled()
  })

  test('waits for authenticated room activation after native ICE has connected', async () => {
    const h = setup({}, false)
    h.rotate()
    h.connection.dispatchEvent(new Event('connectionstatechange'))
    expect(h.connection.getStats).not.toHaveBeenCalled()
    h.connection.dispatchEvent(new Event('studyvis:trystero-ready'))
    await vi.waitFor(() =>
      expect(h.connection.restartIce).toHaveBeenCalledOnce()
    )
  })

  test('retries unavailable native stats once and checks the current path again', async () => {
    vi.useFakeTimers()
    const h = setup()
    h.connection.getStats.mockRejectedValueOnce(
      new Error('private native details')
    )
    h.rotate()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.connection.getStats).toHaveBeenCalledTimes(2)
    expect(h.connection.restartIce).toHaveBeenCalledOnce()
  })

  test('unavailable stats cannot cause repeated restarts or an unbounded timer', async () => {
    vi.useFakeTimers()
    const h = setup()
    h.connection.getStats.mockResolvedValue(
      new Map() as unknown as RTCStatsReport
    )
    h.rotate()
    await vi.runAllTimersAsync()
    expect(h.connection.getStats).toHaveBeenCalledTimes(2)
    expect(h.connection.restartIce).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
