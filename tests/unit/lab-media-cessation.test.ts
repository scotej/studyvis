import { expect, test } from 'vitest'
import {
  originalInboundVideoCounters,
  originalMediaWindowStopped,
  type MediaTransportSnapshot,
} from '../../lab/src/mediaCessation'

const transport: MediaTransportSnapshot = {
  index: 41,
  connectionState: 'connected',
  receivers: [{ id: 'original-camera', kind: 'video', original: true }],
  rtp: [
    {
      id: 'video-rtp',
      type: 'inbound-rtp',
      kind: 'video',
      trackIdentifier: 'original-camera',
      bytesReceived: 405552,
      packetsReceived: 578,
      framesReceived: 297,
      framesDecoded: 133,
    },
  ],
}
const rendered = {
  before: { frames: 171, matchingVideos: 1 },
  after: { frames: 171, matchingVideos: 1 },
}

test('buffered decoding must drain before a complete unchanged media window passes', () => {
  const inbound = originalInboundVideoCounters([transport])
  expect(originalMediaWindowStopped(rendered, inbound, inbound)).toBe(true)
  expect(
    originalMediaWindowStopped(
      { ...rendered, before: { frames: 133, matchingVideos: 1 } },
      inbound,
      inbound
    )
  ).toBe(false)
  // Removing/replacing a video resets its counter; that transition is not a
  // full stable window. The following unchanged empty window is stopped.
  expect(
    originalMediaWindowStopped(
      { ...rendered, after: { frames: 0, matchingVideos: 0 } },
      inbound,
      []
    )
  ).toBe(false)
  expect(
    originalMediaWindowStopped(
      {
        before: { frames: 0, matchingVideos: 0 },
        after: { frames: 0, matchingVideos: 0 },
      },
      [],
      []
    )
  ).toBe(true)
})

test('rendering silence cannot hide incoming RTP or a changed counter identity', () => {
  const inbound = originalInboundVideoCounters([transport])
  for (const key of ['bytes', 'packets', 'frames'] as const) {
    const changed = [{ ...inbound[0], [key]: inbound[0][key] + 1 }]
    expect(originalMediaWindowStopped(rendered, inbound, changed)).toBe(false)
  }
  expect(
    originalMediaWindowStopped(rendered, inbound, [
      { ...inbound[0], statId: 'new-ssrc' },
    ])
  ).toBe(false)
  expect(
    originalMediaWindowStopped(rendered, inbound, [{ ...inbound[0], bytes: 1 }])
  ).toBe(false)
})

test('a surviving original receiver must have complete matching counters', () => {
  expect(() =>
    originalInboundVideoCounters([{ ...transport, rtp: [] }])
  ).toThrow(/no matching RTP/)
  const wrong = structuredClone(transport)
  wrong.rtp[0].trackIdentifier = 'unrelated-camera'
  expect(() => originalInboundVideoCounters([wrong])).toThrow(/no matching RTP/)
  const incomplete = structuredClone(transport)
  delete incomplete.rtp[0].packetsReceived
  expect(() => originalInboundVideoCounters([incomplete])).toThrow(
    /incomplete RTP/
  )
  expect(
    originalInboundVideoCounters([
      { ...transport, connectionState: 'closed', rtp: [] },
    ])
  ).toEqual([])
})

test('the pre-fault positive control rejects an unobserved or retired original RTP mapping', () => {
  expect(
    originalInboundVideoCounters([transport], { requireLive: true })
  ).toHaveLength(1)
  expect(() => originalInboundVideoCounters([], { requireLive: true })).toThrow(
    /no live original/
  )
  expect(() =>
    originalInboundVideoCounters([{ ...transport, receivers: [] }], {
      requireLive: true,
    })
  ).toThrow(/no live original/)
  expect(() =>
    originalInboundVideoCounters(
      [{ ...transport, connectionState: 'closed', rtp: [] }],
      { requireLive: true }
    )
  ).toThrow(/no live original/)
})
