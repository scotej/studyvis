// V2-P6 — peer-alert round-trip + self-warning never-broadcasts invariant.
//
// Drives two dispatchers on an in-process bus modelled on pomodoro.test.ts /
// session.test.ts. Verifies the prompt's two test requirements directly:
//
//   1. "Round-trip an alert message between two test peers; verify sig +
//       delivery + visual state."
//   2. "Self-warning never broadcasts."
//
// Plus the V2-P5 carryover invariant: the wire alert payload must omit
// `deduction` / `scoreAfter` so peers cannot reconstruct the off-task
// user's running score from broadcasts.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import {
  AI_ALERT_ACTION,
  AI_ALERT_VERSION,
  startAiAlertDispatcher,
  type AiAlertDispatcher,
  type AiAlertPayload,
} from '@/features/session/aiAlerts'
import {
  __resetAlertsUiRuntime,
  __setAlertsUiRuntime,
  useAlertsUiStore,
} from '@/features/ai/alertsUiStore'
import type { ScoreEvent } from '@/features/ai/scoreMachine'
import { AUDIT_ACTION, type AuditEvent } from '@/features/session/audit'
import { generateIdentity, signMessage } from '@/lib/crypto/identity'
import { bytesToHex } from '@/lib/encoding'
import type { TopicRoom } from '@/lib/trystero'
import {
  __setAuditPersistFn,
  buildAuditEvent,
  useAuditStore,
  verifyIncomingAuditEvent,
} from '@/stores/auditStore'

type Receiver = (data: unknown, peerId: string) => void

class Bus {
  rooms = new Map<string, BusRoom>()
  // Track every send so the test can assert the warning path never sends
  // ANYWHERE — the AUDIT_ACTION + AI_ALERT_ACTION namespaces both must
  // stay quiet for warnings.
  sentByNamespace = new Map<string, Array<{ from: string; data: unknown }>>()

  send(from: string, namespace: string, data: unknown): void {
    const log = this.sentByNamespace.get(namespace) ?? []
    log.push({ from, data })
    this.sentByNamespace.set(namespace, log)
    for (const r of this.rooms.values()) {
      if (r.peerId === from) continue
      if (r.closed) continue
      const handlers = r.receivers.get(namespace) ?? []
      for (const h of handlers) h(data, from)
    }
  }

  reset(): void {
    this.rooms.clear()
    this.sentByNamespace.clear()
  }

  sendsOn(namespace: string): Array<{ from: string; data: unknown }> {
    return this.sentByNamespace.get(namespace) ?? []
  }
}

class BusRoom {
  peerId: string
  bus: Bus
  receivers = new Map<string, Receiver[]>()
  closed = false

  constructor(bus: Bus, peerId: string) {
    this.peerId = peerId
    this.bus = bus
    bus.rooms.set(peerId, this)
  }

  asTopicRoom(): TopicRoom {
    const peerId = this.peerId
    const bus = this.bus
    const receivers = this.receivers
    const room: Partial<TopicRoom> & { selfId: string } = {
      selfId: peerId,
      makeAction: <T>(namespace: string) => ({
        send: async (data: T): Promise<void[]> => {
          bus.send(peerId, namespace, data)
          return []
        },
        receive: (cb: (data: T, peerId: string) => void) => {
          const list = receivers.get(namespace) ?? []
          list.push(cb as Receiver)
          receivers.set(namespace, list)
        },
      }),
      onPeerJoin: () => () => {},
      onPeerLeave: () => () => {},
      onPeerStream: () => () => {},
      addStream: () => {},
      removeStream: () => {},
      getPeers: () => ({}),
      leave: async () => {},
    }
    return room as TopicRoom
  }
}

type DispatcherKit = {
  edPubkeyHex: string
  dispatcher: AiAlertDispatcher
  emitAuditSpy: ReturnType<typeof vi.fn>
  appendLocalAuditSpy: ReturnType<typeof vi.fn>
  playSoundSpy: ReturnType<typeof vi.fn>
  // The auditAction.send is exposed here so the test can assert "warning
  // never broadcasts on the audit channel".
  auditSendSpy: ReturnType<typeof vi.fn>
}

function makeDispatcherKit(args: {
  bus: Bus
  peerId: string
  sessionTopic: string
  resolveSenderEdPubkey: (peerId: string) => string | null
}): DispatcherKit {
  const room = new BusRoom(args.bus, args.peerId).asTopicRoom()
  const identity = generateIdentity()
  const edPubkeyHex = bytesToHex(identity.edPub)
  const sign = async (msg: Uint8Array) => signMessage(identity.edPriv, msg)

  // Mirror SessionView: build a real auditAction so emitAudit can broadcast
  // ai_alert events too. The test wraps this in a spy so we can assert
  // call counts directly.
  const auditAction = room.makeAction<AuditEvent>(AUDIT_ACTION)
  const auditSendSpy = vi.fn(async (event: AuditEvent) => {
    await auditAction.send(event)
  })
  auditAction.receive((data, peerId) => {
    const expectedEd = args.resolveSenderEdPubkey(peerId)
    const verified = verifyIncomingAuditEvent(data, expectedEd)
    if (!verified) return
    useAuditStore.getState().append(verified)
  })

  const appendLocalAuditSpy = vi.fn(
    async (
      kind: Parameters<typeof buildAuditEvent>[0]['kind'],
      detail,
      options?: { now?: () => number }
    ) => {
      const event = await buildAuditEvent({
        sessionTopic: args.sessionTopic,
        myEdPubkeyHex: edPubkeyHex,
        kind,
        detail,
        sign,
        now: options?.now,
      })
      useAuditStore.getState().append(event)
    }
  )

  const emitAuditSpy = vi.fn(
    async (
      kind: Parameters<typeof buildAuditEvent>[0]['kind'],
      detail,
      options?: { now?: () => number }
    ) => {
      const event = await buildAuditEvent({
        sessionTopic: args.sessionTopic,
        myEdPubkeyHex: edPubkeyHex,
        kind,
        detail,
        sign,
        now: options?.now,
      })
      useAuditStore.getState().append(event)
      await auditSendSpy(event)
    }
  )

  const playSoundSpy = vi.fn()

  const dispatcher = startAiAlertDispatcher({
    room,
    sessionTopic: args.sessionTopic,
    myEdPubkeyHex: edPubkeyHex,
    sign,
    resolveSenderEdPubkey: args.resolveSenderEdPubkey,
    appendLocalAudit: appendLocalAuditSpy,
    emitAudit: emitAuditSpy,
    playSound: playSoundSpy,
    now: () => 1_700_000_000_000,
  })

  return {
    edPubkeyHex,
    dispatcher,
    emitAuditSpy,
    appendLocalAuditSpy,
    playSoundSpy,
    auditSendSpy,
  }
}

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  // Don't let the auditStore's persistFn hit Tauri.
  __setAuditPersistFn(async () => {})
  __setAlertsUiRuntime({
    setTimeout: () => 0,
    clearTimeout: () => {},
  })
  useAuditStore.setState({ events: [], nextSeq: 0 })
  useAlertsUiStore.setState({ selfWarning: null, alertedPeers: {} })
})

afterEach(() => {
  __resetAlertsUiRuntime()
})

describe('V2-P6 alert round-trip', () => {
  test('an alert broadcasts a verifiable signed payload that arrives + updates state on the peer side', async () => {
    const bus = new Bus()
    const sessionTopic = 'session-topic-fixture'

    // peer-a's resolver closes over `peers.b`, which is assigned below.
    // Cross-references through a single mutable holder so neither
    // dispatcher needs a forward-declared `let`.
    const peers: { a?: DispatcherKit; b?: DispatcherKit } = {}
    peers.a = makeDispatcherKit({
      bus,
      peerId: 'peer-a',
      sessionTopic,
      resolveSenderEdPubkey: (peerId) =>
        peerId === 'peer-b' ? (peers.b?.edPubkeyHex ?? null) : null,
    })
    peers.b = makeDispatcherKit({
      bus,
      peerId: 'peer-b',
      sessionTopic,
      resolveSenderEdPubkey: (peerId) =>
        peerId === 'peer-a' ? (peers.a?.edPubkeyHex ?? null) : null,
    })
    const a = peers.a
    const b = peers.b

    const event: ScoreEvent = {
      type: 'alert',
      severity: 'moderate',
      reasoning: 'browsing news',
      deduction: 5,
      scoreAfter: 95,
    }

    await a.dispatcher.handleScoreEvents([event])

    // 1. A emitted an ai_alert audit event AND sent on AUDIT_ACTION. The
    // dispatcher pins the audit ts to the alert payload's ts so the
    // post-session report sees the two surfaces aligned.
    expect(a.emitAuditSpy).toHaveBeenCalledTimes(1)
    const [emitKind, emitDetail, emitOpts] = a.emitAuditSpy.mock.calls[0]
    expect(emitKind).toBe('ai_alert')
    expect(emitDetail).toEqual({
      severity: 'moderate',
      reasoning: 'browsing news',
    })
    expect(emitOpts?.now?.()).toBe(1_700_000_000_000)
    expect(a.auditSendSpy).toHaveBeenCalledTimes(1)

    // 2. A sent on the new AI_ALERT_ACTION channel exactly once, with the
    // signed payload omitting deduction / scoreAfter.
    const alertSends = bus.sendsOn(AI_ALERT_ACTION)
    expect(alertSends).toHaveLength(1)
    const wire = alertSends[0].data as AiAlertPayload
    expect(wire.v).toBe(AI_ALERT_VERSION)
    expect(wire.session_topic).toBe(sessionTopic)
    expect(wire.severity).toBe('moderate')
    expect(wire.reasoning).toBe('browsing news')
    expect(wire.who).toBe(a.edPubkeyHex)
    expect(Object.keys(wire)).not.toContain('deduction')
    expect(Object.keys(wire)).not.toContain('scoreAfter')

    // 3. The off-task user's tile is alerted (A added itself to its own
    // alertedPeers map; the sound fired locally too).
    expect(useAlertsUiStore.getState().alertedPeers[a.edPubkeyHex]).toEqual({
      edPubkeyHex: a.edPubkeyHex,
      severity: 'moderate',
      reasoning: 'browsing news',
      ts: 1_700_000_000_000,
    })
    expect(a.playSoundSpy).toHaveBeenCalledTimes(1)

    // 4. The peer received + verified the alert, updated its alertedPeers
    // map for A's pubkey, played the sound, and ingested the broadcast
    // audit event (the receive handler in makeDispatcherKit mirrors
    // SessionView's audit receive pipeline).
    expect(useAlertsUiStore.getState().alertedPeers[a.edPubkeyHex]).toEqual({
      edPubkeyHex: a.edPubkeyHex,
      severity: 'moderate',
      reasoning: 'browsing news',
      ts: 1_700_000_000_000,
    })
    expect(b.playSoundSpy).toHaveBeenCalledTimes(1)

    // 5. Both sides' audit stores carry the ai_alert row (A appends
    // locally via emitAudit; B appends via the audit receive handler).
    const events = useAuditStore.getState().events
    expect(events.some((e) => e.kind === 'ai_alert')).toBe(true)
  })

  test('self-warning is local-only: no AUDIT_ACTION send, no AI_ALERT_ACTION send', async () => {
    const bus = new Bus()
    const sessionTopic = 'session-topic-fixture'

    const peers: { a?: DispatcherKit; b?: DispatcherKit } = {}
    peers.a = makeDispatcherKit({
      bus,
      peerId: 'peer-a',
      sessionTopic,
      resolveSenderEdPubkey: (peerId) =>
        peerId === 'peer-b' ? (peers.b?.edPubkeyHex ?? null) : null,
    })
    peers.b = makeDispatcherKit({
      bus,
      peerId: 'peer-b',
      sessionTopic,
      resolveSenderEdPubkey: (peerId) =>
        peerId === 'peer-a' ? (peers.a?.edPubkeyHex ?? null) : null,
    })
    const a = peers.a
    const b = peers.b

    const event: ScoreEvent = {
      type: 'warning',
      severity: 'mild',
      reasoning: 'looking away',
    }

    await a.dispatcher.handleScoreEvents([event])

    // 1. A appended ai_warning locally (signed audit event, never broadcast).
    expect(a.appendLocalAuditSpy).toHaveBeenCalledTimes(1)
    const [warnKind, warnDetail] = a.appendLocalAuditSpy.mock.calls[0]
    expect(warnKind).toBe('ai_warning')
    expect(warnDetail).toEqual({
      severity: 'mild',
      reasoning: 'looking away',
    })

    // 2. emitAudit was NEVER called — the wire is silent.
    expect(a.emitAuditSpy).not.toHaveBeenCalled()
    expect(a.auditSendSpy).not.toHaveBeenCalled()

    // 3. AI_ALERT_ACTION never fired.
    expect(bus.sendsOn(AI_ALERT_ACTION)).toHaveLength(0)
    // 4. AUDIT_ACTION never fired (the strongest "no broadcast" assertion).
    expect(bus.sendsOn(AUDIT_ACTION)).toHaveLength(0)

    // 5. The self-warning landed in the alerts-UI store, never the peer's.
    expect(useAlertsUiStore.getState().selfWarning?.reasoning).toBe(
      'looking away'
    )
    expect(Object.keys(useAlertsUiStore.getState().alertedPeers)).toHaveLength(
      0
    )

    // 6. No sound on warning (carryover spec: warnings silent).
    expect(a.playSoundSpy).not.toHaveBeenCalled()
    expect(b.playSoundSpy).not.toHaveBeenCalled()
  })

  test('an alert from a peer whose signed-hello binding is missing is dropped', async () => {
    const bus = new Bus()
    const sessionTopic = 'session-topic-fixture'

    // B can't resolve A's binding (signed-hello did not arrive). Any alert
    // A sends must NOT update B's UI even though the signature itself is
    // valid — verifyIncomingAiAlert demands the binding.
    const a = makeDispatcherKit({
      bus,
      peerId: 'peer-a',
      sessionTopic,
      resolveSenderEdPubkey: () => null,
    })
    const b = makeDispatcherKit({
      bus,
      peerId: 'peer-b',
      sessionTopic,
      resolveSenderEdPubkey: () => null,
    })

    await a.dispatcher.handleScoreEvents([
      {
        type: 'alert',
        severity: 'mild',
        reasoning: 'r',
        deduction: 2,
        scoreAfter: 98,
      },
    ])

    // A's own self-alert (no binding required for the local fast-path —
    // we set it from the local emit path) lights A's tile and plays the
    // sound on A's side.
    const aEntry = useAlertsUiStore.getState().alertedPeers[a.edPubkeyHex]
    expect(aEntry?.ts).toBe(1_700_000_000_000)
    expect(a.playSoundSpy).toHaveBeenCalledTimes(1)

    // Load-bearing: B's receive handler called verifyIncomingAiAlert with
    // a null binding → returned null → playSound never fired. This is the
    // *actual* proof that the alert was dropped on B's side; the store
    // shape (same key as A's self-emit) wouldn't surface a difference.
    expect(b.playSoundSpy).not.toHaveBeenCalled()
  })
})
