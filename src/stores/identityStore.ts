// Zustand store owning the local identity lifecycle. `create()`/`recover()`
// persist NOTHING — they return `{ record, commit }` and keys reach the
// keychain only when `commit()` runs (after the user confirms their backup),
// so an abandoned onboarding never mints a half-saved identity. The mnemonic
// itself is never persisted anywhere. Note the module-load side effect at the
// bottom of this file: importing the store fires the initial `refresh()`.

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

// 'error' (D1): identity.json exists but couldn't be read/parsed (bit-rot,
// partial write, bad serde). The private keys are still valid in the keychain,
// so the user must NOT be routed into new-identity onboarding (its create path
// would overwrite them and strand every friend who knows the old pubkey).
export type IdentityStatus = 'loading' | 'absent' | 'ready' | 'error'

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
    // The ONLY clean route to 'absent' is identity_exists() returning false.
    // Any throw — or a present-but-unreadable file — resolves to 'error' so a
    // corrupt load never steers the user into create-new onboarding (D1).
    let exists: boolean
    try {
      exists = await identityExists()
    } catch (err) {
      console.error('useIdentity.refresh: identity_exists failed:', err)
      set({ identity: null, status: 'error' })
      return
    }
    if (!exists) {
      set({ identity: null, status: 'absent' })
      return
    }
    try {
      const record = await loadIdentityRecord()
      // File exists; a null/unparseable record is a corrupt-file signal, not a
      // fresh user. Route to 'error', never 'absent'.
      set(
        record
          ? { identity: record, status: 'ready' }
          : { identity: null, status: 'error' }
      )
    } catch (err) {
      console.error('useIdentity.refresh: identity_load_record failed:', err)
      set({ identity: null, status: 'error' })
    }
  }

  // The single persistence path. Both new-identity creation and 24-word
  // recovery funnel through here so there is exactly one place that writes
  // keys to the keychain and the public record to identity.json.
  //
  // `allowOverwrite` is the D1 belt-and-braces guard: the create path passes
  // false, so even if a corrupt-load somehow reached onboarding, the commit
  // re-checks identity_exists() and refuses to clobber a present identity.json.
  // Recovery passes true — it has already shown the explicit overwrite confirm.
  // The keychain command (identity_save_keys) enforces the same on its side.
  const buildCommit = (id: Identity, allowOverwrite: boolean) => {
    // Preserve the existing display name across a re-commit so a Settings/D1
    // recovery of the SAME identity (D5 harmless re-commit, no confirm shown)
    // doesn't silently blank it. Onboarding create starts from no identity, so
    // this degrades to '' there (DisplayNameStep sets it next); the D1 error
    // path has an unreadable record, so there's nothing to preserve either.
    const record = recordFromIdentity(id, get().identity?.display_name ?? '')
    const commit = async () => {
      if (!allowOverwrite && (await identityExists())) {
        throw new Error(
          'identity already exists; refusing to overwrite without explicit confirmation'
        )
      }
      await saveKeys(
        bytesToHex(id.edPriv),
        bytesToHex(id.xPriv),
        allowOverwrite
      )
      await saveIdentityRecord(record)
      set({ identity: record, status: 'ready' })
    }
    return { record, commit }
  }

  const create: IdentityActions['create'] = () => {
    const id = generateIdentity()
    const { record, commit } = buildCommit(id, false)
    return { mnemonic: id.mnemonic, record, commit }
  }

  const recover: IdentityActions['recover'] = (mnemonic) => {
    const id: Identity = { mnemonic, ...deriveFromMnemonic(mnemonic) }
    return buildCommit(id, true)
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
