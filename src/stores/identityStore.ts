import { create } from 'zustand'

import {
  bytesToHex,
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

export type IdentityActions = {
  create: () => CreatedIdentity
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

  const create: IdentityActions['create'] = () => {
    const id = generateIdentity()
    const record = recordFromIdentity(id, '')
    const commit = async () => {
      await saveKeys(bytesToHex(id.edPriv), bytesToHex(id.xPriv))
      await saveIdentityRecord(record)
      set({ identity: record, status: 'ready' })
    }
    return { mnemonic: id.mnemonic, record, commit }
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
    actions: { create, signWithKeyring, refresh, setDisplayName },
  }
})

// Kick the initial load once at module import so every consumer of
// `useIdentity` reads the same in-flight load. Idempotent: subsequent calls
// to `actions.refresh()` re-query the underlying Tauri commands. We don't
// bind a per-mount effect in the hook — that's what made every consumer
// fire its own load and produce stale outer copies after the inner
// IdentitySetupGate.commit() finished.
void useIdentityStore.getState().actions.refresh()
