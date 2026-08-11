import { describe, expect, test, vi } from 'vitest'

import {
  registerPttEventBridge,
  type BridgeListen,
} from '@/features/system/pttEventBridge'

const names = {
  physicalState: 'physical',
  released: 'released',
  pressed: 'pressed',
}

const handlers = {
  onPhysicalState: vi.fn(),
  onReleased: vi.fn(),
  onPressed: vi.fn(),
}

describe('PTT event bridge registration', () => {
  test('registers release paths before Pressed', async () => {
    const order: string[] = []
    const listen: BridgeListen = async (eventName) => {
      order.push(eventName)
      return () => {}
    }

    await expect(
      registerPttEventBridge(listen, names, handlers)
    ).resolves.toHaveLength(3)
    expect(order).toEqual(['physical', 'released', 'pressed'])
  })

  test('unwinds listeners when Pressed registration fails', async () => {
    const removed: string[] = []
    const listen: BridgeListen = async (eventName) => {
      if (eventName === 'pressed') throw new Error('bridge unavailable')
      return () => removed.push(eventName)
    }

    await expect(
      registerPttEventBridge(listen, names, handlers)
    ).rejects.toThrow('bridge unavailable')
    expect(removed).toEqual(['released', 'physical'])
  })

  test('unwinds physical state when Released registration fails', async () => {
    const removed: string[] = []
    const listen: BridgeListen = async (eventName) => {
      if (eventName === 'released') throw new Error('release unavailable')
      return () => removed.push(eventName)
    }

    await expect(
      registerPttEventBridge(listen, names, handlers)
    ).rejects.toThrow('release unavailable')
    expect(removed).toEqual(['physical'])
  })
})
