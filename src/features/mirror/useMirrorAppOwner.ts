import { createContext, useContext } from 'react'
import type { MirrorAppOwner } from './appOwner'
import type { MirrorAppSnapshot } from './appBridge'
import type { MirrorSessionOwner } from './useSessionMirror'

export type MirrorAppOwnerContextValue = {
  owner: MirrorAppOwner
  state: ReturnType<MirrorAppOwner['getState']>
  sessionOwner: MirrorSessionOwner | undefined
  setHomePhase: (phase: MirrorAppSnapshot['phase']) => void
}
export const MirrorAppOwnerContext =
  createContext<MirrorAppOwnerContextValue | null>(null)
export function useMirrorAppOwner() {
  return useContext(MirrorAppOwnerContext)
}
