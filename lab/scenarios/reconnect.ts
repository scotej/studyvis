// #264 — a multi-second stall must not end the session, and a peer trystero
// gives up on must not be left on camera.
//
// Freeze bob's renderer outright: Chrome runs WebRTC there, so his ICE agent
// stops answering and alice's transport degrades exactly as it did in the
// field, where the on-device model starved an 8-core laptop for 5.5-9.2 s at
// a time.
//
// Two phases, because the two faults are separate. A stall INSIDE the hold
// must pass unnoticed — nobody leaves at all. A stall PAST it ends with
// trystero declaring the peer closed, and trystero does not close the
// connection when it does that (`SharedPeerManager.clear(…, {destroyPeer:
// false})` empties `bindings` before the close callbacks, so the
// `detachBinding` that would remove our senders early-returns). Left alone it
// keeps transmitting camera and screen to a peer the UI says is gone, which
// is what #264's reporter experienced. The app must shut it.
//
// Both phases assert the stall really degraded the transport, so neither can
// pass over a connection that never noticed.

import {
  inviteAndAccept,
  onboard,
  pairViaContactCard,
  videoState,
} from '../src/flows'
import type { LabMachine } from '../src/machine'
import { scenario } from '../src/scenario'

// Measured against this harness: a 15 s freeze degrades alice's transport for
// ~11 s. That is comfortably past the 5 s after which trystero closes the peer
// — a control run with the hold disabled logs `peer.left` at degradedForMs
// 5003 and the peer never returns — and comfortably inside the hold.
const FREEZE_MS = 15_000
// Past the 20 s hold, so trystero declares the peer closed and abandons the
// connection — the second phase's subject.
const LONG_FREEZE_MS = 35_000

type LogRecord = {
  lvl: string
  scope: string
  msg: string
  data?: Record<string, unknown>
}

function logRecords(machine: LabMachine): LogRecord[] {
  return machine.backend
    .logLines(4000)
    .map((line) => {
      try {
        return JSON.parse(line) as LogRecord
      } catch {
        return null
      }
    })
    .filter((record): record is LogRecord => record !== null)
}

function has(machine: LabMachine, scope: string, msg: string): boolean {
  return logRecords(machine).some(
    (record) => record.scope === scope && record.msg === msg
  )
}

async function paintingVideos(machine: LabMachine): Promise<number> {
  const videos = await videoState(machine)
  return videos.filter((video) => video.width > 0 && video.playing).length
}

// The remote camera tracks this machine is receiving. VideoTile mutes the
// local preview and screen tiles, so an unmuted video is a peer's camera.
async function remoteTrackIds(machine: LabMachine): Promise<string[]> {
  const videos = await videoState(machine)
  return videos.filter((video) => !video.muted).flatMap((v) => v.trackIds)
}

// Frames still arriving over ONE specific set of tracks. A video element that
// no longer carries them — because the app dropped it, or a reconnection
// replaced it — counts as not delivering, which is the point: the question is
// whether the ABANDONED connection is still transmitting, not whether any
// stream is.
async function tracksStillDelivering(
  machine: LabMachine,
  trackIds: readonly string[],
  overMs: number
): Promise<boolean> {
  const framesOver = async (): Promise<number> =>
    (await videoState(machine))
      .filter((video) => video.trackIds.some((id) => trackIds.includes(id)))
      .reduce((total, video) => total + video.decodedFrames, 0)
  const before = await framesOver()
  await new Promise((resolve) => setTimeout(resolve, overMs))
  return (await framesOver()) > before
}

function find(machine: LabMachine, scope: string, msg: string): LogRecord[] {
  return logRecords(machine).filter(
    (record) => record.scope === scope && record.msg === msg
  )
}

async function freeze(machine: LabMachine, ms: number): Promise<void> {
  const pids = await machine.rendererPids()
  if (pids.length === 0) throw new Error('lab: no renderer processes to freeze')
  for (const pid of pids) process.kill(pid, 'SIGSTOP')
  try {
    await new Promise((resolve) => setTimeout(resolve, ms))
  } finally {
    for (const pid of pids) process.kill(pid, 'SIGCONT')
  }
}

scenario('reconnect', async ({ lab, step, check, ui }) => {
  step('two paired machines in one session with media both ways')
  const alice = await lab.addMachine({ name: 'alice' })
  const bob = await lab.addMachine({ name: 'bob' })
  await Promise.all([
    onboard(alice, { displayName: 'Alice' }),
    onboard(bob, { displayName: 'Bob' }),
  ])
  await pairViaContactCard(alice, bob)
  await inviteAndAccept(alice, bob, 'Bob', 'Alice')
  await ui.waitForText(alice.page(), 'Bob', 20_000)
  await ui.until(async () => (await paintingVideos(alice)) >= 2, {
    label: 'alice to play two painting videos',
    timeoutMs: 30_000,
  })
  check(
    'nobody has left yet',
    !has(alice, 'session.lifecycle', 'peer.left') &&
      !has(bob, 'session.lifecycle', 'peer.left')
  )

  step(`bob's renderer is frozen for ${FREEZE_MS / 1000}s`)
  await freeze(bob, FREEZE_MS)

  step('alice held the transport open instead of dropping bob')
  // The hold engaging is what proves the freeze reproduced the bug rather
  // than passing over a transport that never noticed.
  await ui.until(
    () => Promise.resolve(has(alice, 'p2p.transport', 'hold.armed')),
    {
      label: "alice's transport hold to arm",
      timeoutMs: 15_000,
    }
  )
  await ui.until(
    () => Promise.resolve(has(alice, 'p2p.transport', 'hold.recovered')),
    { label: "alice's transport to recover in place", timeoutMs: 30_000 }
  )
  check('the hold never expired', !has(alice, 'p2p.transport', 'hold.expired'))
  check('alice never lost bob', !has(alice, 'session.lifecycle', 'peer.left'))
  check('bob never lost alice', !has(bob, 'session.lifecycle', 'peer.left'))

  step('the session is still live on both sides')
  await ui.until(async () => (await paintingVideos(alice)) >= 2, {
    label: 'alice to still be painting two videos',
    timeoutMs: 30_000,
  })
  await ui.until(async () => (await paintingVideos(bob)) >= 2, {
    label: 'bob to still be painting two videos',
    timeoutMs: 30_000,
  })
  const aliceScreen = await ui.text(alice.page())
  check('alice still sees bob', aliceScreen.includes('Bob'))
  check('alice was never told bob left', !aliceScreen.includes('Bob left'))

  // ---------------------------------------------------------------------
  // Second phase: a stall LONGER than the hold, so trystero really does
  // declare the peer closed. That is the path where it abandons the
  // RTCPeerConnection open — senders still attached, `state.connectedPeer`
  // still pinned — which is what left #264's reporter live on camera inside
  // an empty session, unable to re-form it. The app has to shut that
  // connection itself.
  // ---------------------------------------------------------------------
  step(`bob's renderer is frozen for ${LONG_FREEZE_MS / 1000}s, past the hold`)
  const joinsBefore = find(alice, 'session.lifecycle', 'peer.joined').length
  // Identify the media of the connection that is about to be abandoned, so the
  // assertion below follows THAT connection rather than whatever stream a
  // later reconnection happens to deliver on a replaced element.
  const doomedTracks = await remoteTrackIds(bob)
  check('bob is receiving alice over a known track', doomedTracks.length > 0)
  await freeze(bob, LONG_FREEZE_MS)

  // The hold ends one of two ways once the outage outlasts it: it expires and
  // republishes `disconnected`, or the ICE agent reaches `failed` first, which
  // is terminal and never held. Either way trystero closes the peer; assert on
  // the departure, not on which road it took.
  step('alice lost bob and shut the connection trystero abandoned open')
  await ui.until(
    () =>
      Promise.resolve(find(alice, 'session.lifecycle', 'peer.left').length > 0),
    { label: 'alice to lose bob', timeoutMs: 40_000 }
  )
  const left = find(alice, 'session.lifecycle', 'peer.left').at(-1)
  process.stderr.write(
    `  peer.left: ${JSON.stringify(left?.data)} (hold.expired=${find(alice, 'p2p.transport', 'hold.expired').length})\n`
  )
  check(
    'the departure was recorded as a transport loss',
    left?.data?.awaitingReconnect === true
  )
  check(
    'alice shut the connection trystero abandoned open',
    find(alice, 'session.lifecycle', 'transport.closed_orphan').length > 0
  )

  step('bob stops receiving alice — she is no longer on camera to him')
  check(
    'the abandoned connection stopped delivering frames to bob',
    !(await tracksStillDelivering(bob, doomedTracks, 4_000))
  )

  // Whether the session re-forms after an outage this long depends on how
  // fast the far side notices, so this asserts the held tile RESOLVES rather
  // than which way it resolves — a tile stuck on "Reconnecting…" forever would
  // be its own bug. (The fast path is real but not reproducible here: it needs
  // trystero to give up while the link is merely `disconnected`, and on
  // loopback ICE reaches `failed` about 10 s after `disconnected`, well inside
  // the 20 s hold. Measured separately with the hold shortened — see the PR.)
  step('the held tile resolves rather than sticking forever')
  let resolution = 'unresolved'
  await ui.until(
    () => {
      if (
        find(alice, 'session.lifecycle', 'peer.joined').length > joinsBefore
      ) {
        resolution = 'rejoined'
        return Promise.resolve(true)
      }
      if (
        find(alice, 'session.lifecycle', 'peer.reconnect_expired').length > 0
      ) {
        resolution = 'grace expired'
        return Promise.resolve(true)
      }
      return Promise.resolve(false)
    },
    { label: "alice's held tile to resolve", timeoutMs: 60_000 }
  )
  const rejoin = find(alice, 'session.lifecycle', 'peer.joined').at(-1)
  process.stderr.write(
    `  resolution=${resolution} lastJoin=${JSON.stringify(rejoin?.data)}\n`
  )
  check('the tile resolved one way or the other', resolution !== 'unresolved')
  check(
    'no peer is left showing as reconnecting',
    !(await ui.text(alice.page())).includes('Reconnecting')
  )
})
