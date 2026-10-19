import { strings } from '@/strings'

let commit: { token: symbol; blocksSessions: boolean } | null = null

export class IdentityCommitBlockedError extends Error {}

export function reserveIdentityCommit(blocksSessions: boolean): () => void {
  if (commit)
    throw new IdentityCommitBlockedError(strings.identity.commitInProgress)
  const token = Symbol()
  commit = { token, blocksSessions }
  return () => {
    if (commit?.token === token) commit = null
  }
}

export function assertSessionIdentityStable(): void {
  if (commit?.blocksSessions)
    throw new Error(strings.identity.sessionStartBlocked)
}
