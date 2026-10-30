import assert from 'node:assert/strict'
import { test } from 'node:test'

import { withComponentBrowser } from './component-browser.mjs'

const source = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { MemoryRouter } from 'react-router'
import { Toaster } from 'sonner'
import { ThemeProvider } from '@/design/theme'
import { SessionView } from '@/features/session/SessionView'
import { Report } from '@/features/session/Report'
import { buildLeaveHandler } from '@/features/session/lifecycle'
import { loadReportData } from '@/features/session/reportLoader'
import { deriveTopicTimeline } from '@/features/session/reportData'
import { serializeReportToText } from '@/features/session/reportSerialize'
import { AI_DIALOG_TOPIC_CHANGE } from '@/features/ai/aiDialogChannels'
import { useModelStore } from '@/features/ai/modelStore'
import { readEngineInfo } from '@/features/ai/engine'
import { generateIdentity, signMessage } from '@/lib/crypto/identity'
import { serializeHelloForSig } from '@/features/session/hello'
import { bytesToHex } from '@/lib/encoding'
import { useIdentityStore } from '@/stores/identityStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore, DEFAULT_SETTINGS } from '@/stores/settingsStore'
import { buildAuditEvent, useAuditStore, verifyIncomingAuditEvent } from '@/stores/auditStore'
import { strings } from '@/strings'
import '@/design/index.css'

const T0 = 1700000000000
let now = T0
Date.now = () => now
const topic = 'c'.repeat(64)
const person = generateIdentity()
const ed = bytesToHex(person.edPub)
const callbacks = new Map()
const listeners = new Map()
const rows = new Map()
const audit = []
const sent = []
const exports = []
const journalReads = []
const timelineReads = []
let next = 1
let helloWaiting = false
let releaseHello = () => {}
let currentTransport
let holdTargetedHello = false
let releaseTargetedHello = () => {}
let holdJoinedSignature = false
let joinedSignatureWaiting = false
let releaseJoinedSignature = () => {}
const remotePerson = generateIdentity()
const remoteEd = bytesToHex(remotePerson.edPub)

const record = (args) => Object.fromEntries(
  Object.entries(args).map(([key, value]) => [
    key.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase()), value,
  ]))
Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: {
    unregisterListener: (_event, id) => listeners.delete(id),
  },
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback: fn => { const id = next++; callbacks.set(id, fn); return id },
    unregisterCallback: id => callbacks.delete(id),
    invoke: async (cmd, args = {}) => {
      if (cmd === 'plugin:event|listen') {
        const id = next++; listeners.set(id, args); return id
      }
      if (cmd === 'plugin:event|unlisten') { listeners.delete(args.eventId); return }
      if (cmd === 'plugin:window|available_monitors' || cmd === 'friends_list') return []
      if (cmd === 'plugin:window|is_focused' || cmd === 'plugin:window|is_visible') return true
      if (cmd === 'system_window_style_is_custom_applied') return false
      if (cmd === 'engine_info') return {
        supported: true, support_error: null, installed: true, source: 'bundled',
        version: 'b9095', installing: false, last_error: null, devices: [],
        device_error: null, hardware_identity: { selection: 'auto', topology: [] },
      }
      if (cmd === 'identity_sign') {
        const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(args.message)))
        if (payload.kind === 'joined' && holdJoinedSignature) {
          holdJoinedSignature = false
          joinedSignatureWaiting = true
          await new Promise(resolve => { releaseJoinedSignature = resolve })
          joinedSignatureWaiting = false
        }
        return Array.from(signMessage(person.edPriv, new Uint8Array(args.message)))
      }
      if (cmd === 'session_timeline_get') { timelineReads.push(args.sessionId); return null }
      if (cmd === 'session_journal_read') {
        journalReads.push(args.sessionId)
        return { lines: [], truncated: false }
      }
      if (cmd === 'sessions_get') return rows.get(args.id) ?? null
      if (cmd === 'sessions_insert') { rows.set(args.id, record(args)); return }
      if (cmd === 'sessions_insert_if_absent') {
        if (rows.has(args.id)) return false
        rows.set(args.id, record(args)); return true
      }
      if (cmd === 'audit_event_insert') { audit.push(record(args)); return }
      if (cmd === 'audit_events_list_for_session')
        return audit.filter(row => row.session_id === args.sessionId).sort((a, b) => a.ts - b.ts)
      if (cmd === 'plugin:dialog|save') return '/synthetic/' + args.options.defaultPath
      if (cmd === 'system_write_text_file') { exports.push(args); return }
      if (cmd === 'plugin:store|load') return 1
      return null
    },
  },
})
await new Promise(resolve => setTimeout(resolve, 0))
await readEngineInfo()
useIdentityStore.setState({
  status: 'ready',
  identity: {
    version: 1, ed_pubkey_hex: ed, x_pubkey_hex: bytesToHex(person.xPub),
    display_name: 'Synthetic topic participant', created_at: 1,
    mnemonic_fingerprint: 'synthetic',
  },
})
useSettingsStore.setState({
  status: 'ready', error: null,
  values: { ...DEFAULT_SETTINGS, autoUpdateEnabled: false,
    aiFeaturesEnabled: true, sessionTimelineEnabled: false },
})
useModelStore.setState({ status: 'loading', activeModelId: null })
useSessionStore.getState().reset()
const canvas = document.createElement('canvas')
canvas.width = canvas.height = 32
canvas.getContext('2d').fillRect(0, 0, 32, 32)
Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
  value: async () => canvas.captureStream(1), configurable: true,
})

const begin = (isRejoin, holdHello = false) => {
  const joins = new Set()
  const leaves = new Set()
  const receivers = new Map()
  currentTransport = { joins, leaves, receivers }
  const room = {
    selfId: 'topic-self', getPeers: () => ({}),
    onPeerJoin: fn => { joins.add(fn); return () => joins.delete(fn) },
    onPeerLeave: fn => { leaves.add(fn); return () => leaves.delete(fn) },
    onPeerStream: () => () => {}, addStream: () => {}, removeStream: () => {},
    leave: async () => {},
    makeAction: name => ({
      receive: fn => receivers.set(name, fn),
      send: async (data, target) => {
        sent.push({ name, data, target })
        if (name === 'session-hello' && target && holdTargetedHello)
          await new Promise(resolve => { releaseTargetedHello = resolve })
        if (name === 'session-hello' && holdHello) {
          helloWaiting = true
          await new Promise(resolve => { releaseHello = resolve })
        }
      },
    }),
  }
  const startedAt = now
  const startedAtMono = now - T0
  const leave = buildLeaveHandler({
    room, topic, startedAt, startedAtMono, monotonicNow: () => now - T0,
    continuesFocus: isRejoin, localEdPubkey: ed,
    localDisplayName: 'Synthetic topic participant',
  })
  useSessionStore.getState().begin({
    room, leave, sessionTopic: topic, sessionPassword: 'synthetic', isHost: true,
    isRejoin, startedAt, startedAtMono,
  })
}
useSessionStore.getState().setPendingInitialTopic('Maths')
begin(false)
const root = createRoot(document.getElementById('root'))
function App() {
  const active = useSessionStore(s => s.status === 'active')
  return <MemoryRouter><ThemeProvider><Toaster />{
    active ? <SessionView /> : <div>Ended</div>
  }</ThemeProvider></MemoryRouter>
}
flushSync(() => root.render(<App />))
window.fixture = {
  advance: offset => { now = T0 + offset },
  ready: () => [...listeners.values()].some(item => item.event === AI_DIALOG_TOPIC_CHANGE),
  changeTopic: nextTopic => {
    for (const [id, item] of listeners) if (item.event === AI_DIALOG_TOPIC_CHANGE)
      callbacks.get(item.handler)?.({ event: item.event, id, payload: { new_topic: nextTopic } })
  },
  rejoin: holdHello => {
    // Home's actual pending-topic handoff preserves the resumed AI context.
    const current = useSessionStore.getState().declaredStudyTopic
    useSessionStore.getState().setPendingInitialTopic(current)
    flushSync(() => begin(true, holdHello))
  },
  releaseHello: () => releaseHello(),
  holdJoinedSignature: () => { holdJoinedSignature = true },
  releaseJoinedSignature: () => releaseJoinedSignature(),
  holdTargetedHello: () => { holdTargetedHello = true },
  releaseTargetedHello: () => {
    holdTargetedHello = false
    releaseTargetedHello()
  },
  joinPeer: peerId => { for (const fn of currentTransport.joins) fn(peerId) },
  leavePeer: peerId => { for (const fn of currentTransport.leaves) fn(peerId) },
  admitPeer: peerId => useSessionStore.getState().peerJoined(peerId),
  admitPeerWithOtherIdentity: peerId => useSessionStore.getState().setPeerHello(peerId, {
    ed_pubkey_hex: bytesToHex(generateIdentity().edPub), display_name: 'Other identity', joined_at: now,
  }),
  receiveJoin: async (peerId, { badSignature = false, wrongTopic = false } = {}) => {
    const hello = { v: 1, peer_id: peerId, ed_pubkey_hex: remoteEd,
      display_name: 'Remote friend', joined_at: now }
    currentTransport.receivers.get('session-hello')({ ...hello,
      sig: bytesToHex(signMessage(remotePerson.edPriv, serializeHelloForSig(hello))),
    }, peerId)
    const event = await buildAuditEvent({ sessionTopic: wrongTopic ? 'd'.repeat(64) : topic,
      myEdPubkeyHex: remoteEd, kind: 'joined', detail: {},
      sign: async bytes => signMessage(remotePerson.edPriv, bytes), now: () => now })
    if (badSignature) event.sig = '0'.repeat(128)
    currentTransport.receivers.get('audit')(event, peerId)
  },
  snapshot: () => ({
    status: useSessionStore.getState().status,
    initial: useSessionStore.getState().initialDeclaredTopic,
    current: useSessionStore.getState().declaredStudyTopic,
    row: rows.get(topic), helloWaiting, joinedSignatureWaiting, exports, journalReads, timelineReads,
    sent, joined: useAuditStore.getState().events.filter(event => event.kind === 'joined'),
    peerHistory: useSessionStore.getState().seenPeerEdPubkeys,
    topics: sent.filter(item => ['topic_set', 'topic_change'].includes(item.data?.kind))
      .map(item => ({ kind: item.data.kind, detail: item.data.detail, ts: item.data.ts })),
    verified: sent.filter(item => item.data?.kind)
      .every(item => verifyIncomingAuditEvent(item.data, ed) !== null),
  }),
  report: async () => {
    const data = await loadReportData(topic)
    return {
      topic: deriveTopicTimeline(data.session.declared_topic, data.auditEvents, ed, data.session.started_at),
      audit: data.auditEvents, text: serializeReportToText(data),
    }
  },
  renderReport: () => flushSync(() => root.render(
    <ThemeProvider><Report sessionId={topic} onClose={() => {}} /></ThemeProvider>
  )),
  copy: strings.report,
  stop: () => flushSync(() => root.unmount()),
}
`

for (const scenario of ['changed', 'unchanged', 'hello delayed past change']) {
  test(`rejoin emits the current signed topic: ${scenario} (#418)`, async () => {
    await withComponentBrowser(source, async (page) => {
      await page.waitForFunction(
        () =>
          window.fixture.snapshot().topics.length === 1 &&
          window.fixture.ready()
      )
      const changed = scenario !== 'unchanged'
      const delayed = scenario === 'hello delayed past change'
      if (changed) {
        await page.evaluate(() => {
          window.fixture.advance(120_000)
          window.fixture.changeTopic('Physics')
        })
        await page.waitForFunction(
          () => window.fixture.snapshot().topics.length === 2
        )
      }
      await page.evaluate(() => window.fixture.advance(180_000))
      await page.getByRole('button', { name: 'Leave', exact: true }).click()
      await page.waitForFunction(
        () => window.fixture.snapshot().status === 'ended'
      )
      assert.equal(
        await page.evaluate(() => window.fixture.snapshot().row.declared_topic),
        'Maths'
      )
      await page.evaluate((hold) => {
        window.fixture.advance(240_000)
        window.fixture.rejoin(hold)
      }, delayed)
      if (delayed) {
        await page.waitForFunction(
          () => window.fixture.snapshot().helloWaiting && window.fixture.ready()
        )
        await page.evaluate(() => {
          window.fixture.advance(270_000)
          window.fixture.changeTopic('Chemistry')
        })
        await page.waitForFunction(
          () => window.fixture.snapshot().topics.length === 3
        )
        await page.evaluate(() => {
          window.fixture.advance(280_000)
          window.fixture.releaseHello()
        })
      }
      await page.waitForFunction(
        () =>
          window.fixture
            .snapshot()
            .topics.filter((item) => item.kind === 'topic_set').length === 2
      )
      const live = await page.evaluate(() => window.fixture.snapshot())
      assert.equal(live.initial, 'Maths')
      assert.equal(
        live.current,
        delayed ? 'Chemistry' : changed ? 'Physics' : 'Maths'
      )
      assert.deepEqual(
        live.topics
          .filter((item) => item.kind === 'topic_set')
          .map((item) => item.detail.topic),
        ['Maths', live.current],
        'actual SessionView topic_set must describe the current topic after rejoin'
      )
      assert.equal(live.verified, true)
      await page.evaluate(() => window.fixture.advance(300_000))
      await page.getByRole('button', { name: 'Leave', exact: true }).click()
      await page.waitForFunction(
        () => window.fixture.snapshot().status === 'ended'
      )
      const report = await page.evaluate(() => window.fixture.report())
      const expected = [{ topic: 'Maths', label: 'started' }]
      if (changed) expected.push({ topic: 'Physics', label: '02:00' })
      if (delayed) expected.push({ topic: 'Chemistry', label: '04:30' })
      assert.deepEqual(
        report.topic.map(({ topic, label }) => ({ topic, label })),
        expected
      )
      assert.match(report.text, /Studied Maths/)
      for (const entry of expected)
        assert.ok(report.text.includes(entry.topic + ' (' + entry.label + ')'))
      assert.equal(
        await page.evaluate(() => window.fixture.snapshot().verified),
        true
      )
      assert.equal(
        await page.evaluate(() => window.fixture.snapshot().row.declared_topic),
        'Maths'
      )

      await page.evaluate(() => window.fixture.renderReport())
      await page
        .getByRole('heading', { name: 'Studied Maths', exact: true })
        .waitFor()
      const copy = await page.evaluate(() => window.fixture.copy)
      await page.waitForFunction(
        () => window.fixture.snapshot().journalReads.length > 0
      )
      await page
        .getByText(copy.sections.written.empty, { exact: true })
        .waitFor()
      const io = await page.evaluate(() => window.fixture.snapshot())
      assert.ok(io.timelineReads.length > 0)
      assert.deepEqual([...new Set(io.journalReads)], ['c'.repeat(64)])
      assert.deepEqual([...new Set(io.timelineReads)], ['c'.repeat(64)])
      const topicSection = page
        .getByRole('heading', {
          name: copy.sections.topic.heading,
          exact: true,
        })
        .locator('..')
      for (const entry of expected)
        await topicSection.getByText(entry.topic, { exact: true }).waitFor()
      assert.equal(
        await topicSection.getByText('04:00', { exact: true }).count(),
        0
      )
      await page
        .getByRole('button', { name: copy.export.saveAriaLabel, exact: true })
        .click()
      await page.waitForFunction(
        () => window.fixture.snapshot().exports.length === 1
      )
      await page
        .getByRole('button', { name: copy.export.auditAriaLabel, exact: true })
        .click()
      await page.waitForFunction(
        () => window.fixture.snapshot().exports.length === 2
      )
      const exported = await page.evaluate(
        () => window.fixture.snapshot().exports
      )
      assert.equal(exported[0].contents, report.text)
      assert.deepEqual(JSON.parse(exported[1].contents), report.audit)
      await page.evaluate(() => window.fixture.stop())
    })
  })
}

test('late peers receive the original signed join after their hello', async () => {
  await withComponentBrowser(source, async (page) => {
    await page.waitForFunction(
      () => window.fixture.snapshot().joined.length === 1
    )
    const original = await page.evaluate(
      () => window.fixture.snapshot().joined[0]
    )
    await page.evaluate(() => {
      window.fixture.advance(120_000)
      window.fixture.holdTargetedHello()
      window.fixture.joinPeer('late-peer')
    })
    await page.waitForFunction(() =>
      window.fixture
        .snapshot()
        .sent.some(
          (item) => item.name === 'session-hello' && item.target === 'late-peer'
        )
    )
    assert.equal(
      await page.evaluate(
        () =>
          window.fixture
            .snapshot()
            .sent.filter(
              (item) =>
                item.data?.kind === 'joined' && item.target === 'late-peer'
            ).length
      ),
      0,
      'a pending hello must not be overtaken by the audit event'
    )
    await page.evaluate(() => window.fixture.releaseTargetedHello())
    await page.waitForFunction(() =>
      window.fixture
        .snapshot()
        .sent.some(
          (item) => item.data?.kind === 'joined' && item.target === 'late-peer'
        )
    )
    const delivered = await page.evaluate(
      () =>
        window.fixture
          .snapshot()
          .sent.find(
            (item) =>
              item.data?.kind === 'joined' && item.target === 'late-peer'
          ).data
    )
    const wire = { ...original }
    delete wire.seq
    assert.deepEqual(
      delivered,
      wire,
      'signature and original timestamp are reused'
    )
    assert.equal(
      await page.evaluate(() => window.fixture.snapshot().joined.length),
      1
    )
    assert.equal(
      await page.evaluate(() => window.fixture.snapshot().verified),
      true
    )
    await page.evaluate(() => window.fixture.stop())
  })
})

for (const interruption of [
  'peer leave',
  'controller teardown',
  'controller replacement',
]) {
  test(`a pending targeted hello cannot replay a join after ${interruption}`, async () => {
    await withComponentBrowser(source, async (page) => {
      await page.waitForFunction(
        () => window.fixture.snapshot().joined.length === 1
      )
      await page.evaluate(() => {
        window.fixture.holdTargetedHello()
        window.fixture.joinPeer('departed-peer')
      })
      await page.waitForFunction(() =>
        window.fixture
          .snapshot()
          .sent.some(
            (item) =>
              item.name === 'session-hello' && item.target === 'departed-peer'
          )
      )
      await page.evaluate((action) => {
        if (action === 'peer leave') window.fixture.leavePeer('departed-peer')
        else if (action === 'controller teardown') window.fixture.stop()
        else {
          window.fixture.advance(120_000)
          window.fixture.rejoin(false)
        }
        window.fixture.releaseTargetedHello()
      }, interruption)
      // Drain the released promise and its publication continuation without a
      // timing-dependent sleep; the original callback must have been aborted.
      await page.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 0))
      )
      assert.equal(
        await page.evaluate(
          () =>
            window.fixture
              .snapshot()
              .sent.filter(
                (item) =>
                  item.data?.kind === 'joined' &&
                  item.target === 'departed-peer'
              ).length
        ),
        0
      )
      if (interruption !== 'controller teardown')
        await page.evaluate(() => window.fixture.stop())
    })
  })
}

test('a signed join waits for admission and duplicate delivery remains one row', async () => {
  await withComponentBrowser(source, async (page) => {
    await page.waitForFunction(
      () => window.fixture.snapshot().joined.length === 1
    )
    await page.evaluate(() => window.fixture.receiveJoin('pending-peer'))
    let state = await page.evaluate(() => window.fixture.snapshot())
    assert.equal(state.joined.length, 1)
    assert.deepEqual(
      state.peerHistory,
      [],
      'a provisional hello cannot create history'
    )
    await page.evaluate(() => window.fixture.admitPeer('pending-peer'))
    await page.waitForFunction(
      () => window.fixture.snapshot().joined.length === 2
    )
    await page.evaluate(() => window.fixture.receiveJoin('pending-peer'))
    state = await page.evaluate(() => window.fixture.snapshot())
    assert.equal(state.joined.length, 2, 'the same signed event is idempotent')
    assert.equal(state.peerHistory.length, 1)
    await page.evaluate(() => window.fixture.stop())
  })
})

for (const rejected of [
  'bad signature',
  'wrong session',
  'departed transport',
]) {
  test(`a provisional join cannot enter history with ${rejected}`, async () => {
    await withComponentBrowser(source, async (page) => {
      await page.waitForFunction(
        () => window.fixture.snapshot().joined.length === 1
      )
      await page.evaluate(async (reason) => {
        await window.fixture.receiveJoin('rejected-peer', {
          badSignature: reason === 'bad signature',
          wrongTopic: reason === 'wrong session',
        })
        if (reason === 'departed transport')
          window.fixture.leavePeer('rejected-peer')
        window.fixture.admitPeer('rejected-peer')
      }, rejected)
      assert.equal(
        await page.evaluate(() => window.fixture.snapshot().joined.length),
        1
      )
      await page.evaluate(() => window.fixture.stop())
    })
  })
}

for (const interruption of ['teardown', 'replacement']) {
  test(`a pending joined signature cannot publish after controller ${interruption}`, async () => {
    await withComponentBrowser(source, async (page) => {
      await page.waitForFunction(
        () => window.fixture.snapshot().joined.length === 1
      )
      await page.evaluate(() => {
        window.fixture.advance(120_000)
        window.fixture.holdJoinedSignature()
        window.fixture.rejoin(false)
      })
      await page.waitForFunction(
        () => window.fixture.snapshot().joinedSignatureWaiting
      )
      await page.evaluate((action) => {
        if (action === 'teardown') window.fixture.stop()
        else {
          window.fixture.advance(240_000)
          window.fixture.rejoin(false)
        }
        window.fixture.releaseJoinedSignature()
      }, interruption)
      await page.waitForFunction(
        () => !window.fixture.snapshot().joinedSignatureWaiting
      )
      await page.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 0))
      )
      const state = await page.evaluate(() => window.fixture.snapshot())
      assert.equal(
        state.sent.filter(
          (item) =>
            item.data?.kind === 'joined' && item.data.ts === 1700000120000
        ).length,
        0
      )
      assert.equal(
        state.joined.some((event) => event.ts === 1700000120000),
        false
      )
      if (interruption === 'replacement')
        await page.evaluate(() => window.fixture.stop())
    })
  })
}

test('a provisional join cannot override the final admitted identity binding', async () => {
  await withComponentBrowser(source, async (page) => {
    await page.waitForFunction(
      () => window.fixture.snapshot().joined.length === 1
    )
    await page.evaluate(async () => {
      await window.fixture.receiveJoin('rebound-peer')
      window.fixture.admitPeerWithOtherIdentity('rebound-peer')
    })
    assert.equal(
      await page.evaluate(() => window.fixture.snapshot().joined.length),
      1
    )
    assert.equal(
      await page.evaluate(() => window.fixture.snapshot().peerHistory.length),
      1
    )
    await page.evaluate(() => window.fixture.stop())
  })
})

test('pending signed joins are bounded while admission is outstanding', async () => {
  await withComponentBrowser(source, async (page) => {
    await page.waitForFunction(
      () => window.fixture.snapshot().joined.length === 1
    )
    await page.evaluate(async () => {
      for (let i = 1; i <= 5; i++) {
        window.fixture.advance(i * 1000)
        await window.fixture.receiveJoin('candidate-' + i)
      }
    })
    assert.equal(
      await page.evaluate(() => window.fixture.snapshot().joined.length),
      1
    )
    await page.evaluate(() => {
      for (let i = 1; i <= 5; i++) window.fixture.admitPeer('candidate-' + i)
    })
    assert.equal(
      await page.evaluate(() => window.fixture.snapshot().joined.length),
      5,
      'only four provisional transports may retain a pending event'
    )
    await page.evaluate(() => window.fixture.stop())
  })
})
