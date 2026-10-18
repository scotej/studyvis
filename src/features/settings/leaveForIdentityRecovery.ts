import { useSessionStore } from '@/stores/sessionStore'
import { strings } from '@/strings'

export async function leaveForIdentityRecovery(): Promise<void> {
  const session = useSessionStore.getState()
  if (session.status !== 'active') return
  if (!session.leave)
    throw new Error(strings.session.errors.leaveFailedFallback)
  session.setPendingEndReason('user')
  try {
    await session.leave()
  } catch (error) {
    const current = useSessionStore.getState()
    if (current.leave === session.leave) current.clearPendingEndReason('user')
    throw error
  }
}
