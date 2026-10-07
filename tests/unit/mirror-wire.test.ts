import { describe, expect, test } from 'vitest'

import {
  MIRROR_MAX_MESSAGE,
  MirrorCodec,
  isMirrorMessage,
  isSignalMessage,
  type MirrorMessage,
} from '@/features/mirror/wire'

async function encode(codec: MirrorCodec, message: MirrorMessage) {
  const frames: string[] = []
  await codec.send(message, async (frame) => {
    frames.push(frame)
  })
  return frames
}

function decode(codec: MirrorCodec, frames: string[]) {
  return frames.map((frame) => codec.receive(frame)).filter(Boolean)
}

describe('the mirror connection framing', () => {
  test('large shared images survive fragmentation and are transferred once', async () => {
    const sender = new MirrorCodec()
    const receiver = new MirrorCodec()
    const image = 'data'.repeat(30_000)
    const first: MirrorMessage = {
      type: 'snapshot',
      snapshot: { images: [image, image], timer: 100 },
    }
    const firstFrames = await encode(sender, first)
    expect(firstFrames.length).toBeGreaterThan(2)
    expect(decode(receiver, firstFrames)).toEqual([first])

    const next: MirrorMessage = {
      type: 'snapshot',
      snapshot: { images: [image], timer: 99 },
    }
    const nextFrames = await encode(sender, next)
    expect(nextFrames.length).toBe(1)
    expect(decode(receiver, nextFrames)).toEqual([next])
  })

  test('simultaneous messages never interleave attachment fragments', async () => {
    const sender = new MirrorCodec()
    const receiver = new MirrorCodec()
    const frames: string[] = []
    const messages: MirrorMessage[] = [
      { type: 'snapshot', snapshot: { image: 'a'.repeat(60_000) } },
      { type: 'snapshot', snapshot: { image: 'b'.repeat(60_000) } },
    ]
    const write = async (frame: string) => {
      frames.push(frame)
      await Promise.resolve()
    }
    await Promise.all(messages.map((message) => sender.send(message, write)))
    expect(decode(receiver, frames)).toEqual(messages)
  })

  test('a refused oversized message does not poison later attachments', async () => {
    const sender = new MirrorCodec()
    const receiver = new MirrorCodec()
    const reused = 'image'.repeat(2000)
    await expect(
      encode(sender, {
        type: 'snapshot',
        snapshot: { reused, tooLarge: 'x'.repeat(MIRROR_MAX_MESSAGE) },
      })
    ).rejects.toThrow()
    const valid: MirrorMessage = { type: 'snapshot', snapshot: { reused } }
    expect(decode(receiver, await encode(sender, valid))).toEqual([valid])
  })

  test('each fresh connection independently transfers all required attachments', async () => {
    const message: MirrorMessage = {
      type: 'snapshot',
      snapshot: { image: 'a'.repeat(60_000) },
    }
    await encode(new MirrorCodec(), message)
    expect(
      decode(new MirrorCodec(), await encode(new MirrorCodec(), message))
    ).toEqual([message])
  })

  test('missing, repeated, or reordered fragments fail closed', async () => {
    const frames = await encode(new MirrorCodec(), {
      type: 'snapshot',
      snapshot: { image: 'a'.repeat(60_000) },
    })
    expect(() => new MirrorCodec().receive(frames[1])).toThrow()
    const receiver = new MirrorCodec()
    receiver.receive(frames[0])
    expect(() => receiver.receive(frames[0])).toThrow()
    const reordered = new MirrorCodec()
    reordered.receive(frames[0])
    expect(() => reordered.receive(frames[2])).toThrow()
  })

  test('unknown attachment references cannot be rendered as trusted content', () => {
    const receiver = new MirrorCodec()
    expect(() =>
      receiver.receive(
        JSON.stringify({
          v: 1,
          type: 'message',
          id: 1,
          index: 0,
          total: 1,
          data: JSON.stringify({
            type: 'snapshot',
            snapshot: { $mirrorString: 50 },
          }),
        })
      )
    ).toThrow()
  })

  test.each([
    { v: 1, type: 'message', id: 1, index: 0, total: 0, data: '' },
    { v: 1, type: 'message', id: 1, index: 0, total: 1_000_000, data: '' },
    { v: 1, type: 'message', id: -1, index: 0, total: 1, data: '' },
    { v: 2, type: 'message', id: 1, index: 0, total: 1, data: '' },
    {
      v: 1,
      type: 'message',
      id: 1,
      index: 0,
      total: 1,
      data: 'x'.repeat(24_001),
    },
  ])('malformed bounded frame is rejected', (frame) => {
    expect(() => new MirrorCodec().receive(JSON.stringify(frame))).toThrow()
  })
})

test('mirror envelopes accept supported negotiation and reject oversized input', () => {
  expect(
    isSignalMessage({ type: 'capture', camera: true, screen: false })
  ).toBe(true)
  expect(
    isSignalMessage({ type: 'streams', streams: { bob: 'stream-id' } })
  ).toBe(true)
  expect(isSignalMessage({ type: 'streams', streams: [] })).toBe(false)
  expect(
    isSignalMessage({ type: 'offer', sdp: 'x'.repeat(192 * 1024 + 1) })
  ).toBe(false)
  expect(
    isMirrorMessage({ type: 'signal', signal: { type: 'delete_files' } })
  ).toBe(false)
  expect(
    isMirrorMessage({
      type: 'notification',
      title: 'a',
      body: 'b'.repeat(2049),
    })
  ).toBe(false)
  expect(isMirrorMessage({ type: 'identity_sign', message: 'anything' })).toBe(
    false
  )
})
