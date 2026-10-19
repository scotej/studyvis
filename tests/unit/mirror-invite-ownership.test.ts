import { afterEach, expect, test, vi } from 'vitest'
const transport = vi.hoisted(() => ({
  join: vi.fn(),
  send: vi.fn(async () => {}),
  leave: vi.fn(async () => {}),
  peer: null as (() => void) | null,
}))
vi.mock('@/lib/trystero', () => ({ joinTopic: transport.join }))
import {
  buildInviteEnvelope,
  sendInviteEnvelope,
} from '@/features/friends/invite'
const sender = {
  edPubkeyHex: 'a'.repeat(64),
  displayName: 'Alice',
  sign: vi.fn(async () => new Uint8Array(64)),
  encryptTo: vi.fn(async () => ({
    nonce: new Uint8Array(24),
    ciphertext: new Uint8Array(32),
  })),
}
const recipient = { edPubkeyHex: 'b'.repeat(64), xPubkeyHex: 'c'.repeat(64) }
const session = { sessionTopic: 'topic', sessionPassword: 'secret' }
afterEach(() => {
  vi.clearAllMocks()
  transport.peer = null
})
test('owner loss during native signing prevents later encryption', async () => {
  let release!: (bytes: Uint8Array) => void
  let current = true
  const signing = {
    ...sender,
    sign: () =>
      new Promise<Uint8Array>((resolve) => {
        release = resolve
      }),
  }
  const result = buildInviteEnvelope(signing, recipient, session, {
    isCurrent: () => current,
  })
  current = false
  release(new Uint8Array(64))
  await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  expect(sender.encryptTo).not.toHaveBeenCalled()
})
test('owner loss during encryption prevents envelope delivery', async () => {
  let release!: (result: { nonce: Uint8Array; ciphertext: Uint8Array }) => void
  let current = true
  const encryptTo = vi.fn(
    () =>
      new Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }>((resolve) => {
        release = resolve
      })
  )
  const result = buildInviteEnvelope(
    { ...sender, encryptTo },
    recipient,
    session,
    { isCurrent: () => current }
  )
  await vi.waitFor(() => expect(encryptTo).toHaveBeenCalledOnce())
  current = false
  release({ nonce: new Uint8Array(24), ciphertext: new Uint8Array(32) })
  await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  expect(transport.join).not.toHaveBeenCalled()
})
test('a peer arriving after controller loss never receives the queued invite', async () => {
  transport.join.mockImplementation(() => ({
    makeAction: () => ({ send: transport.send, receive: () => {} }),
    onPeerJoin: (callback: () => void) => {
      transport.peer = callback
      return () => {}
    },
    leave: transport.leave,
  }))
  let current = true
  const result = sendInviteEnvelope(
    recipient,
    { v: 1, from_ed_pubkey: sender.edPubkeyHex, nonce: '', ciphertext: '' },
    { isCurrent: () => current, sendTimeoutMs: 1000 }
  )
  await vi.waitFor(() => expect(transport.peer).not.toBeNull())
  current = false
  transport.peer!()
  await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  expect(transport.send).not.toHaveBeenCalled()
  expect(transport.leave).toHaveBeenCalledOnce()
})
