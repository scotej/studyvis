import { beforeEach, describe, expect, test } from 'vitest'

import {
  buildNotePayload,
  NOTE_MAX_LENGTH,
  verifyIncomingNote,
} from '@/features/session/notes'
import { NOTES_CAP, useNotesStore } from '@/features/session/notesStore'
import {
  bytesToHex,
  generateIdentity,
  signMessage,
} from '@/lib/crypto/identity'

const TOPIC = 'session-topic-fixture'

function makeSigner() {
  const identity = generateIdentity()
  return {
    edHex: bytesToHex(identity.edPub),
    sign: async (msg: Uint8Array) => signMessage(identity.edPriv, msg),
  }
}

describe('session notes wire (#47 B6)', () => {
  test('round-trips: built payload verifies against the hello-bound key', async () => {
    const sam = makeSigner()
    const payload = await buildNotePayload({
      sessionTopic: TOPIC,
      myEdPubkeyHex: sam.edHex,
      text: '  brb 5  ',
      sign: sam.sign,
    })
    expect(payload.text).toBe('brb 5')
    const verified = verifyIncomingNote(payload, sam.edHex, TOPIC)
    expect(verified?.text).toBe('brb 5')
  })

  test('drops a note whose sender does not match the hello binding', async () => {
    const sam = makeSigner()
    const mallory = makeSigner()
    const payload = await buildNotePayload({
      sessionTopic: TOPIC,
      myEdPubkeyHex: sam.edHex,
      text: 'hi',
      sign: sam.sign,
    })
    expect(verifyIncomingNote(payload, mallory.edHex, TOPIC)).toBeNull()
    expect(verifyIncomingNote(payload, null, TOPIC)).toBeNull()
  })

  test('drops a cross-session note and a tampered text', async () => {
    const sam = makeSigner()
    const payload = await buildNotePayload({
      sessionTopic: TOPIC,
      myEdPubkeyHex: sam.edHex,
      text: 'hi',
      sign: sam.sign,
    })
    expect(verifyIncomingNote(payload, sam.edHex, 'other-session')).toBeNull()
    expect(
      verifyIncomingNote({ ...payload, text: 'hijacked' }, sam.edHex, TOPIC)
    ).toBeNull()
  })

  test('caps the built text and rejects over-cap or empty incoming text', async () => {
    const sam = makeSigner()
    const long = 'x'.repeat(NOTE_MAX_LENGTH + 50)
    const payload = await buildNotePayload({
      sessionTopic: TOPIC,
      myEdPubkeyHex: sam.edHex,
      text: long,
      sign: sam.sign,
    })
    expect(payload.text).toHaveLength(NOTE_MAX_LENGTH)
    expect(verifyIncomingNote(payload, sam.edHex, TOPIC)).not.toBeNull()
    expect(
      verifyIncomingNote({ ...payload, text: '   ' }, sam.edHex, TOPIC)
    ).toBeNull()
  })
})

describe('notesStore (#47 B6)', () => {
  beforeEach(() => {
    useNotesStore.getState().reset()
  })

  test('appends in order and resets clean', () => {
    const store = useNotesStore.getState()
    store.append({ fromEdPubkeyHex: 'a', mine: true, text: 'one', ts: 1 })
    store.append({ fromEdPubkeyHex: 'b', mine: false, text: 'two', ts: 2 })
    expect(useNotesStore.getState().notes.map((n) => n.text)).toEqual([
      'one',
      'two',
    ])
    useNotesStore.getState().reset()
    expect(useNotesStore.getState().notes).toHaveLength(0)
  })

  test('caps the feed at NOTES_CAP, dropping the oldest', () => {
    const store = useNotesStore.getState()
    for (let i = 0; i < NOTES_CAP + 10; i++) {
      store.append({ fromEdPubkeyHex: 'a', mine: true, text: `n${i}`, ts: i })
    }
    const notes = useNotesStore.getState().notes
    expect(notes).toHaveLength(NOTES_CAP)
    expect(notes[0].text).toBe('n10')
  })
})
