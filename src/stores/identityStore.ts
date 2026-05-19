import { create } from 'zustand'

import {
  bytesToHex,
  deriveFromMnemonic,
  generateIdentity,
  mnemonicFingerprint,
  type Identity,
  type Mnemonic,
} from '@/lib/crypto/identity'
import {
  identityExists,
  loadIdentityRecord,
  saveIdentityRecord,
  saveKeys,
  signWithKeyring,
  IDENTITY_VERSION,
  type IdentityRecord,
} from '@/lib/db/identity'

export type IdentityStatus = 'loading' | 'absent' | 'ready'

export type CreatedIdentity = {
  mnemonic: Mnemonic
  record: IdentityRecord
  commit: () => Promise<void>
}

export type RecoveredIdentity = {
  record: IdentityRecord
  commit: () => Promise<void>
}

export type IdentityActions = {
  create: () => CreatedIdentity
  // Re-derives the keypairs from a 24-word backup the user still holds and
  // returns the same deferred-commit shape `create` does. Throws if the
  // mnemonic is not a valid BIP39 phrase (callers pre-validate; the throw is
  // a defensive backstop). The words are never persisted.
  recover: (mnemonic: Mnemonic) => RecoveredIdentity
  signWithKeyring: (message: Uint8Array) => Promise<Uint8Array>
  refresh: () => Promise<void>
  setDisplayName: (name: string) => Promise<void>
}

type IdentityState = {
  identity: IdentityRecord | null
  status: IdentityStatus
  // Stable object reference — actions never change identity across renders,
  // so consumers can safely include `actions.signWithKeyring` in dep arrays
  // without churn (the SessionView pipeline used to tear down on every
  // identity-store mutation because `useIdentity` rebuilt this object per
  // render).
  actions: IdentityActions
}

function recordFromIdentity(id: Identity, displayName: string): IdentityRecord {
  return {
    version: IDENTITY_VERSION,
    ed_pubkey_hex: bytesToHex(id.edPub),
    x_pubkey_hex: bytesToHex(id.xPub),
    display_name: displayName,
    created_at: Date.now(),
    mnemonic_fingerprint: mnemonicFingerprint(id.mnemonic),
  }
}

export const useIdentityStore = create<IdentityState>((set, get) => {
  const refresh: IdentityActions['refresh'] = async () => {
    try {
      const exists = await identityExists()
      if (!exists) {
        set({ identity: null, status: 'absent' })
        return
      }
      const record = await loadIdentityRecord()
      set({ identity: record, status: record ? 'ready' : 'absent' })
    } catch (err) {
      // Surface to the user via console; fall back to absent so they aren't
      // stuck on a blank loading screen. A V1-P3 corrupted-file recovery path
      // is owed — see memory carryovers.
      console.error('useIdentity.refresh failed:', err)
      set({ identity: null, status: 'absent' })
    }
  }

  // The single persistence path. Both new-identity creation and 24-word
  // recovery funnel through here so there is exactly one place that writes
  // keys to the keychain and the public record to identity.json.
  const buildCommit = (id: Identity) => {
    const record = recordFromIdentity(id, '')
    const commit = async () => {
      await saveKeys(bytesToHex(id.edPriv), bytesToHex(id.xPriv))
      await saveIdentityRecord(record)
      set({ identity: record, status: 'ready' })
    }
    return { record, commit }
  }

  const create: IdentityActions['create'] = () => {
    const id = generateIdentity()
    const { record, commit } = buildCommit(id)
    return { mnemonic: id.mnemonic, record, commit }
  }

  const recover: IdentityActions['recover'] = (mnemonic) => {
    const id: Identity = { mnemonic, ...deriveFromMnemonic(mnemonic) }
    return buildCommit(id)
  }

  const setDisplayName: IdentityActions['setDisplayName'] = async (name) => {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('display name must not be empty')
    const current = get().identity
    if (!current) throw new Error('no identity loaded')
    const next: IdentityRecord = { ...current, display_name: trimmed }
    await saveIdentityRecord(next)
    set({ identity: next })
  }

  return {
    identity: null,
    status: 'loading',
    actions: { create, recover, signWithKeyring, refresh, setDisplayName },
  }
})

// Kick the initial load once at module import so every consumer of
// `useIdentity` reads the same in-flight load. Idempotent: subsequent calls
// to `actions.refresh()` re-query the underlying Tauri commands. We don't
// bind a per-mount effect in the hook — that's what made every consumer
// fire its own load and produce stale outer copies after the inner
// IdentitySetupGate.commit() finished.
void useIdentityStore.getState().actions.refresh()
