import { sha256 } from '@noble/hashes/sha2.js'

import { bytesToHex } from '@/lib/crypto/identity'

const enc = new TextEncoder()

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function digestHex(label: string, payload: string): string {
  return bytesToHex(sha256(enc.encode(label + payload)))
}

export function inboxTopic(edPubkey: Uint8Array): string {
  return digestHex('studyvis:inbox:v1:', bytesToBase64(edPubkey))
}

export function inboxPassword(edPubkey: Uint8Array): string {
  return digestHex('studyvis:inbox-pw:v1:', bytesToBase64(edPubkey))
}

export function pairTopic(words: string[]): string {
  return digestHex('studyvis:pair:v1:', words.join('-'))
}

export function pairPassword(words: string[]): string {
  return digestHex('studyvis:pair-pw:v1:', words.join('-'))
}

export function sessionTopic(sessionId: Uint8Array): string {
  return digestHex('studyvis:session:v1:', bytesToHex(sessionId))
}
