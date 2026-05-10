import {
  useIdentityStore,
  type CreatedIdentity,
  type IdentityActions,
  type IdentityStatus,
} from '@/stores/identityStore'
import { type IdentityRecord } from '@/lib/db/identity'

export type { CreatedIdentity, IdentityStatus }

export type UseIdentityResult = {
  identity: IdentityRecord | null
  status: IdentityStatus
  actions: IdentityActions
}

// Thin selector over the singleton identityStore. Multiple components used to
// instantiate their own copies of this hook (Home + Onboarding), each holding
// independent React state — after IdentitySetupGate.commit() the outer copy
// stayed stale. The store is the single source of truth; the actions object
// is constructed once and is reference-stable, so consumers can safely
// destructure it without churning effect dep arrays.
export function useIdentity(): UseIdentityResult {
  const identity = useIdentityStore((s) => s.identity)
  const status = useIdentityStore((s) => s.status)
  const actions = useIdentityStore((s) => s.actions)
  return { identity, status, actions }
}
