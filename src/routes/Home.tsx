import { useEffect } from 'react'
import { Link } from 'react-router'

import { Button } from '@/components/ui/button'
import { Logo } from '@/components/Logo'
import { IdentitySetupGate, useIdentity } from '@/features/identity'
import { useFriendsStore } from '@/stores/friendsStore'

const isDev = import.meta.env.DEV

export function Home() {
  const { identity, status, actions } = useIdentity()
  const friendsCount = useFriendsStore((s) => s.friends.length)
  const friendsStatus = useFriendsStore((s) => s.status)
  const loadFriends = useFriendsStore((s) => s.load)

  useEffect(() => {
    if (status === 'ready' && friendsStatus === 'idle') {
      void loadFriends()
    }
  }, [status, friendsStatus, loadFriends])

  if (status === 'loading') {
    return (
      <main
        className="flex min-h-screen items-center justify-center bg-bg-base text-text-secondary"
        aria-busy="true"
      />
    )
  }

  if (status === 'absent') {
    return <IdentitySetupGate create={actions.create} />
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-base text-text-primary">
      <div className="flex flex-col items-center gap-6">
        <Logo size="xl" />
        <h1 className="text-2xl font-semibold tracking-tight">StudyVis</h1>
        <p className="text-sm text-text-secondary">
          Identity ready. Friends: {friendsCount}
        </p>
        {identity ? (
          <code className="font-mono text-xs text-text-muted">
            {identity.ed_pubkey_hex.slice(0, 16)}…
          </code>
        ) : null}
        <Button>Get started</Button>
        {isDev ? (
          <Link to="/style" className="text-sm text-text-secondary underline">
            /style
          </Link>
        ) : null}
      </div>
    </main>
  )
}
