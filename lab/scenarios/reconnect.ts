// #264 — a multi-second stall must not end the session.
//
// The bug: trystero closes a peer 5 s after its RTCPeerConnection reports
// `disconnected`, and Chrome reports that after ~2.5 s of not receiving. A
// laptop whose renderer is starved for longer than that — which is what the
// on-device model does to an 8-core machine on battery — loses the peer for
// good, because without TURN the connection often never re-forms.
//
// So freeze bob's renderer outright. Chrome runs WebRTC there, so his ICE
// agent stops answering and alice's transport degrades exactly as it did in
// the field. The scenario asserts BOTH halves: that the stall really did
// degrade the transport (alice armed the hold), and that the session came
// through it without anyone leaving.

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
  const frozen = await bob.rendererPids()
  check('bob has renderer processes to freeze', frozen.length > 0)
  for (const pid of frozen) process.kill(pid, 'SIGSTOP')
  try {
    await new Promise((resolve) => setTimeout(resolve, FREEZE_MS))
  } finally {
    for (const pid of frozen) process.kill(pid, 'SIGCONT')
  }

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
})
