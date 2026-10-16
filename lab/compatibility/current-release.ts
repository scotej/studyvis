import { readFileSync } from 'node:fs'
import path from 'node:path'
import { verifyMessage } from '@/lib/crypto/identity'
import { serializeAuditForSig, type AuditEventCore } from '@/lib/audit-types'
import {
  inviteAndAccept,
  onboard,
  pairViaContactCard,
  videoState,
} from '../src/flows'
import { scenario } from '../src/scenario'

function resumeRenderers(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGCONT')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}

scenario('current-release-compatibility', async ({ lab, step, check, ui }) => {
  const dist = process.env.STUDYVIS_COMPAT_DIST
  const expectedSha = process.env.STUDYVIS_COMPAT_SHA
  if (!dist || !expectedSha || !/^[a-f0-9]{40}$/.test(expectedSha)) {
    throw new Error(
      'Set STUDYVIS_COMPAT_DIST and the immutable STUDYVIS_COMPAT_SHA'
    )
  }
  const provenance = JSON.parse(
    readFileSync(path.join(dist, 'ci-source.json'), 'utf8')
  ) as { sha: string }
  check(
    'the previous release bundle has exact source provenance',
    provenance.sha === expectedSha
  )
  step(`current frontend meets released source ${expectedSha}`)
  const current = await lab.addMachine({ name: 'current' })
  const previous = await lab.addMachine({ name: 'previous', appDist: dist })
  check(
    'the peers load independently served bundles',
    new URL(current.page().url()).origin !==
      new URL(previous.page().url()).origin
  )
  await Promise.all([
    onboard(current, { displayName: 'Current' }),
    onboard(previous, { displayName: 'Previous' }),
  ])
  await pairViaContactCard(current, previous)
  await inviteAndAccept(current, previous, 'Previous', 'Current')

  step('signed handshakes establish bidirectional camera and microphone tracks')
  for (const machine of [current, previous]) {
    await ui.until(
      async () =>
        (await videoState(machine)).some(
          (video) =>
            !video.muted &&
            video.width > 0 &&
            video.playing &&
            video.tracks.includes('video:live') &&
            video.tracks.includes('audio:live')
        ),
      {
        label: `${machine.name} receives media from the other release`,
        timeoutMs: 30_000,
      }
    )
    check(
      `${machine.name} has a remote authenticated participant`,
      (await ui.text(machine.page())).includes(
        machine === current ? 'Previous' : 'Current'
      )
    )
  }

  const qualifyMicrophones = async (phase: string) => {
    step(`both peers decode microphone audio during push-to-talk ${phase}`)
    for (const [sender, receiver] of [
      [current, previous],
      [previous, current],
    ] as const) {
      const probe = await receiver.page().evaluateHandle(async () => {
        const track = Array.from(document.querySelectorAll('video'))
          .filter((video) => !video.muted)
          .flatMap((video) =>
            video.srcObject instanceof MediaStream
              ? video.srcObject.getAudioTracks()
              : []
          )
          .find((track) => track.readyState === 'live')
        if (!track) throw new Error('remote microphone track is missing')
        const context = new AudioContext()
        try {
          await context.resume()
          const source = context.createMediaStreamSource(
            new MediaStream([track])
          )
          const analyser = context.createAnalyser()
          analyser.fftSize = 4096
          const gain = context.createGain()
          gain.gain.value = 0
          source.connect(analyser)
          analyser.connect(gain)
          gain.connect(context.destination)
          const samples = new Float32Array(analyser.fftSize)
          return {
            sample: () => {
              if (context.state !== 'running' || track.readyState !== 'live')
                throw new Error('remote microphone PCM probe is not live')
              analyser.getFloatTimeDomainData(samples)
              let power = 0
              for (const value of samples) power += value * value
              return Math.sqrt(power / samples.length)
            },
            close: async () => {
              source.disconnect()
              analyser.disconnect()
              gain.disconnect()
              await context.close()
            },
          }
        } catch (error) {
          await context.close()
          throw error
        }
      })
      const enabledSenders = () =>
        ui.evaluate<number>(
          sender.page(),
          'window.__lab.peers().reduce((count, peer) => count + peer.enabledAudioSenders, 0)'
        )
      let peakRms = 0
      let voicedSamples = 0
      try {
        check(
          `${sender.name} starts muted ${phase}`,
          (await enabledSenders()) === 0
        )
        await sender.emit('ptt-friends-pressed', null)
        await ui.until(async () => (await enabledSenders()) > 0, {
          label: `${sender.name} unmutes its microphone ${phase}`,
          timeoutMs: 15_000,
        })
        await ui.until(
          async () => {
            const rms = await probe.evaluate((probe) => probe.sample())
            peakRms = Math.max(peakRms, rms)
            if (rms > 0.02) voicedSamples++
            return voicedSamples >= 3
          },
          {
            label: `${receiver.name} decodes ${sender.name}'s microphone PCM ${phase}`,
            timeoutMs: 15_000,
            intervalMs: 100,
          }
        )
        check(
          `${receiver.name} decodes ${sender.name}'s microphone ${phase}`,
          true
        )
        await sender.emit('ptt-friends-released', null)
        await ui.until(async () => (await enabledSenders()) === 0, {
          label: `${sender.name} mutes on PTT release ${phase}`,
          timeoutMs: 15_000,
        })
        // Chromium's fake microphone pulses, so one quiet sample cannot prove mute.
        let quietSince = Date.now()
        await ui.until(
          async () => {
            if ((await probe.evaluate((probe) => probe.sample())) >= 0.005)
              quietSince = Date.now()
            return Date.now() - quietSince >= 1200
          },
          {
            label: `${receiver.name} receives silence after PTT release ${phase}`,
            timeoutMs: 15_000,
            intervalMs: 100,
          }
        )
        check(
          `${sender.name}'s PTT release restores remote silence ${phase}`,
          true
        )
      } finally {
        process.stderr.write(
          `microphone ${JSON.stringify({ phase, sender: sender.name, receiver: receiver.name, peakRms, voicedSamples })}\n`
        )
        try {
          await sender.emit('ptt-friends-released', null)
        } finally {
          await probe
            .evaluate((probe) => probe.close())
            .finally(() => probe.dispose())
        }
      }
    }
  }
  await qualifyMicrophones('before the outage')

  step('notes and Pomodoro messages cross release boundaries')
  for (const [sender, receiver] of [
    [current, previous],
    [previous, current],
  ] as const) {
    const note = `Compatibility note from ${sender.name}`
    await ui.fill(sender.page(), 'Note to your session', note)
    await ui.click(sender.page(), 'Send the note')
    await ui.waitForText(receiver.page(), note, 20_000)
  }
  await ui.click(previous.page(), 'Open Pomodoro menu')
  await ui.click(previous.page(), 'Start')
  await ui.waitForText(current.page(), 'Focus', 20_000)
  check(
    'current accepts the previous release timer',
    (await ui.text(current.page())).includes('started a Pomodoro')
  )
  await previous
    .page()
    .getByRole('button', { name: /^Pomodoro Focus / })
    .click()
  await ui.click(previous.page(), 'Stop Pomodoro')
  await ui.click(current.page(), 'Open Pomodoro menu')
  await ui.click(current.page(), 'Start')
  await ui.waitForText(previous.page(), 'Current started a Pomodoro', 20_000)

  step('a screen track can be published, stopped and republished')
  const waitNewScreen = async (
    receiver: typeof current,
    previousIds: string[]
  ) => {
    const freshScreen = async () =>
      (await videoState(receiver)).find(
        (video) =>
          video.muted &&
          video.width > 0 &&
          video.trackIds.some((id) => !previousIds.includes(id))
      )
    await ui.until(async () => Boolean(await freshScreen()), {
      label: `${receiver.name} receives a new screen track`,
      timeoutMs: 30_000,
    })
    const initial = (await freshScreen())!
    await ui.until(
      async () =>
        (await videoState(receiver)).some(
          (video) =>
            video.trackIds.some((id) => initial.trackIds.includes(id)) &&
            video.decodedFrames > initial.decodedFrames
        ),
      {
        label: `${receiver.name} decodes advancing screen frames`,
        timeoutMs: 15_000,
      }
    )
    return initial.trackIds
  }
  for (const [publisher, receiver, displayName] of [
    [current, previous, 'Current'],
    [previous, current, 'Previous'],
  ] as const) {
    const seenTrackIds = (await videoState(receiver)).flatMap(
      (video) => video.trackIds
    )
    for (let publication = 0; publication < 2; publication++) {
      await ui.click(publisher.page(), 'Share screen')
      await ui.waitForText(receiver.page(), `${displayName}'s screen`, 30_000)
      seenTrackIds.push(...(await waitNewScreen(receiver, seenTrackIds)))
      await ui.click(publisher.page(), 'Stop sharing')
      await ui.waitForGone(receiver.page(), `${displayName}'s screen`, 20_000)
    }
    check(
      `${receiver.name} decodes a republished screen from the other release`,
      true
    )
  }

  step('media and signed messages resume after an old-renderer outage')
  const renderers = await previous.rendererPids()
  check(
    'the released peer has renderer processes to interrupt',
    renderers.length > 0
  )
  const transportHolds = () =>
    current.backend.logLines(4000).filter((line) => {
      try {
        const event = JSON.parse(line) as { scope: string; msg: string }
        return event.scope === 'p2p.transport' && event.msg === 'hold.armed'
      } catch {
        return false
      }
    }).length
  const holdsBeforeOutage = transportHolds()
  for (const pid of renderers) process.kill(pid, 'SIGSTOP')
  try {
    await new Promise((resolve) => setTimeout(resolve, 15_000))
  } finally {
    resumeRenderers(renderers)
  }
  await ui.until(async () => transportHolds() > holdsBeforeOutage, {
    label: 'the renderer outage actually degrades the current transport',
    timeoutMs: 15_000,
  })
  for (const machine of [current, previous]) {
    await ui.until(
      async () => {
        const before = (await videoState(machine)).filter(
          (video) =>
            !video.muted &&
            video.playing &&
            video.width > 0 &&
            video.tracks.includes('video:live') &&
            video.tracks.includes('audio:live')
        )
        await new Promise((resolve) => setTimeout(resolve, 500))
        return (await videoState(machine)).some(
          (video) =>
            !video.muted &&
            before.some(
              (old) =>
                old.trackIds.some((id) => video.trackIds.includes(id)) &&
                video.decodedFrames > old.decodedFrames
            )
        )
      },
      {
        label: `${machine.name} decodes new remote frames after the outage`,
        timeoutMs: 30_000,
      }
    )
  }
  await qualifyMicrophones('after the outage')
  await ui.fill(
    previous.page(),
    'Note to your session',
    'Released peer resumed'
  )
  await ui.click(previous.page(), 'Send the note')
  await ui.waitForText(current.page(), 'Released peer resumed', 20_000)

  step('persisted remote audit events retain verifiable signatures')
  for (const machine of [current, previous]) {
    const own = machine.backend.identity.loadRecord()!
    await ui.until(
      async () =>
        machine.backend.db
          .auditRows()
          .some((row) => row.who !== own.ed_pubkey_hex),
      {
        label: `${machine.name} persists a signed remote audit event`,
        timeoutMs: 10_000,
      }
    )
    const remote = machine.backend.db
      .auditRows()
      .filter((row) => row.who !== own.ed_pubkey_hex)
    check(`${machine.name} persisted signed remote events`, remote.length > 0)
    for (const row of remote) {
      const core: AuditEventCore = {
        v: 1,
        session_topic: row.session_id,
        ts: row.ts,
        who: row.who,
        kind: row.kind as AuditEventCore['kind'],
        detail: JSON.parse(row.detail),
      }
      check(
        `${machine.name} verifies ${row.kind}`,
        verifyMessage(
          Uint8Array.from(Buffer.from(row.who, 'hex')),
          serializeAuditForSig(core),
          Uint8Array.from(Buffer.from(row.sig, 'hex'))
        )
      )
    }
  }
})
