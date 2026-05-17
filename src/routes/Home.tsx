import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Settings2Icon } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  AddFriendDialog,
  FriendsList,
  InboxBoot,
  type PresenceMap,
} from '@/features/friends'
import type { ValidInvite } from '@/features/friends'
import { useIdentity } from '@/features/identity'
import { Onboarding, useOnboardingState } from '@/features/onboarding'
import {
  inviteToCurrentSession,
  joinSession,
  Report,
  SessionView,
  TopicGateModal,
} from '@/features/session'
import { Settings } from '@/features/settings'
import type { Friend } from '@/lib/db/friends'
import { boxEncryptWithKeyring } from '@/lib/db/identity'
import { useFriendsStore } from '@/stores/friendsStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'

const isDev = import.meta.env.DEV

type View = 'main' | 'settings'

export function Home() {
  const { identity, status, actions } = useIdentity()
  const onboarding = useOnboardingState()
  const friendsStatus = useFriendsStore((s) => s.status)
  const loadFriends = useFriendsStore((s) => s.load)
  const sessionStatus = useSessionStore((s) => s.status)
  const sessionTopic = useSessionStore((s) => s.sessionTopic)
  const [addOpen, setAddOpen] = useState(false)
  const [presence, setPresence] = useState<PresenceMap>({})
  const [view, setView] = useState<View>('main')
  // V2-P9 — when AI is on, a session must declare a topic before it goes
  // live. We queue the start request and run it only after the modal
  // resolves; the discriminated union keeps the host/guest payloads distinct.
  const [pendingStart, setPendingStart] = useState<
    { kind: 'host'; friend: Friend } | { kind: 'guest'; invite: ValidInvite }
  >()

  useEffect(() => {
    if (status === 'ready' && friendsStatus === 'idle') {
      void loadFriends()
    }
  }, [status, friendsStatus, loadFriends])

  const runHostInvite = useCallback(
    async (friend: Friend) => {
      if (!identity || !identity.display_name) return
      try {
        await inviteToCurrentSession({
          friend,
          sender: {
            edPubkeyHex: identity.ed_pubkey_hex,
            displayName: identity.display_name,
            sign: actions.signWithKeyring,
            encryptTo: boxEncryptWithKeyring,
          },
        })
        toast.success(
          `Invite sent to ${friend.display_name?.trim() || 'your friend'}.`
        )
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Could not send invite.'
        toast.error(message)
      }
    },
    [identity, actions.signWithKeyring]
  )

  const runGuestJoin = useCallback((invite: ValidInvite) => {
    // Joining while already in a session would tear down the existing one;
    // refuse — the user explicitly leaves first. (Moved here from InboxBoot
    // so the gate + guard share one decision point.)
    if (useSessionStore.getState().status === 'active') {
      toast.error('Leave the current session before joining another.')
      return
    }
    try {
      joinSession(invite.payload.session_topic, invite.payload.session_password)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not join the session.'
      toast.error(message)
    }
  }, [])

  const aiOn = () => useSettingsStore.getState().values.aiFeaturesEnabled

  const handleInvite = useCallback(
    (friend: Friend) => {
      if (aiOn()) setPendingStart({ kind: 'host', friend })
      else void runHostInvite(friend)
    },
    [runHostInvite]
  )

  const handleInviteAccepted = useCallback(
    (invite: ValidInvite) => {
      if (aiOn()) setPendingStart({ kind: 'guest', invite })
      else runGuestJoin(invite)
    },
    [runGuestJoin]
  )

  const handleTopicSubmit = useCallback(
    (topic: string) => {
      const req = pendingStart
      setPendingStart(undefined)
      if (!req) return
      // Seed the one-shot topic BEFORE the session flips to active so
      // `begin()` writes it into both initialDeclaredTopic (→
      // sessions.declared_topic) and the live declaredStudyTopic.
      useSessionStore.getState().setPendingInitialTopic(topic)
      if (req.kind === 'host') void runHostInvite(req.friend)
      else runGuestJoin(req.invite)
    },
    [pendingStart, runHostInvite, runGuestJoin]
  )

  if (status === 'loading' || onboarding.status === 'loading') {
    return (
      <main
        className="flex min-h-screen items-center justify-center bg-bg-base text-text-secondary"
        aria-busy="true"
      >
        <span className="sr-only">Loading…</span>
      </main>
    )
  }

  if (status === 'absent' || onboarding.status === 'pending') {
    return <Onboarding onComplete={onboarding.complete} />
  }

  // InboxBoot is rendered exactly once, outside the view selector, so React
  // doesn't unmount + remount it (and tear down the always-on inbox + presence
  // subscriptions) on every settings/session toggle. The identity-readiness
  // gate stays — only render once `useIdentity` has resolved to a record.
  const inbox =
    identity && status === 'ready' ? (
      <InboxBoot
        key="inbox-boot"
        myEdPubkeyHex={identity.ed_pubkey_hex}
        onPresenceChange={setPresence}
        onInviteAccepted={handleInviteAccepted}
      />
    ) : null

  // Gate + inbox travel together everywhere a new session can be started.
  const tail = (
    <>
      {inbox}
      <TopicGateModal
        open={pendingStart !== undefined}
        onSubmit={handleTopicSubmit}
        onCancel={() => setPendingStart(undefined)}
      />
    </>
  )

  if (sessionStatus === 'active') {
    return (
      <>
        <SessionView />
        {inbox}
      </>
    )
  }

  // V2-P8 — surface the post-session report instead of the V2-P3 splash.
  // Reset is driven by the Close button so the report stays visible until
  // the user dismisses it (no auto-timeout). The audit + pomodoro stores
  // are reset on the NEXT session-start by SessionView's V2-P5 reset
  // effect — this covers the invite-while-on-report path where the user
  // never clicks Close.
  if (sessionStatus === 'ended' && sessionTopic) {
    return (
      <>
        <Report
          sessionId={sessionTopic}
          onClose={() => useSessionStore.getState().reset()}
        />
        {tail}
      </>
    )
  }

  if (view === 'settings') {
    return (
      <>
        <Settings onClose={() => setView('main')} />
        {tail}
      </>
    )
  }

  return (
    <>
      <main className="min-h-screen bg-bg-base text-text-primary">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-end gap-2 px-6 pt-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setView('settings')}
            aria-label="Open settings"
          >
            <Settings2Icon /> Settings
          </Button>
        </div>
        <FriendsList
          presence={presence}
          onAddFriend={() => setAddOpen(true)}
          onInvite={handleInvite}
        />
        <AddFriendDialog open={addOpen} onOpenChange={setAddOpen} />
        {isDev ? (
          <div className="px-6 pb-8 text-center">
            <Link to="/style" className="text-sm text-text-secondary underline">
              /style
            </Link>
          </div>
        ) : null}
      </main>
      {tail}
    </>
  )
}
