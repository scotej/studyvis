import { useCallback, useEffect, useState } from 'react'

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

export type UseIdentityResult = {
  identity: IdentityRecord | null
  status: IdentityStatus
  actions: {
    create: () => CreatedIdentity
    signWithKeyring: (message: Uint8Array) => Promise<Uint8Array>
    refresh: () => Promise<void>
  }
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

export function useIdentity(): UseIdentityResult {
  const [identity, setIdentity] = useState<IdentityRecord | null>(null)
  const [status, setStatus] = useState<IdentityStatus>('loading')

  const refresh = useCallback(async () => {
    const exists = await identityExists()
    if (!exists) {
      setIdentity(null)
      setStatus('absent')
      return
    }
    const record = await loadIdentityRecord()
    setIdentity(record)
    setStatus(record ? 'ready' : 'absent')
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount load: refresh awaits the Tauri commands before any setState fires
    void refresh()
  }, [refresh])

  const create = useCallback((): CreatedIdentity => {
    const id = generateIdentity()
    const record = recordFromIdentity(id, '')
    const commit = async () => {
      await saveKeys(bytesToHex(id.edPriv), bytesToHex(id.xPriv))
      await saveIdentityRecord(record)
      setIdentity(record)
      setStatus('ready')
    }
    return { mnemonic: id.mnemonic, record, commit }
  }, [])

  return {
    identity,
    status,
    actions: {
      create,
      signWithKeyring,
      refresh,
    },
  }
}
