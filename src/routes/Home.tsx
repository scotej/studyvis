import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Settings2Icon } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { tokens } from '@/design/tokens'
import {
  AddFriendDialog,
  ContactImportDialog,
  FriendsList,
  InboxBoot,
  InviteRelayError,
  InviteTimeoutError,
  PairDeepLinkBoot,
  type ContactImportSource,
  type PresenceMap,
} from '@/features/friends'
import type { ValidInvite } from '@/features/friends'
import { IdentityLoadError, useIdentity } from '@/features/identity'
import { Onboarding, useOnboardingState } from '@/features/onboarding'
import {
  inviteToCurrentSession,
  InviteWhileGuestError,
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
import { strings } from '@/strings'

const isDev = import.meta.env.DEV

type View = 'main' | 'settings'

export function Home() {
  const { identity, status, actions } = useIdentity()
  const onboarding = useOnboardingState()
  const friendsStatus = useFriendsStore((s) => s.status)
  const loadFriends = useFriendsStore((s) => s.load)
  // F3 — InboxBoot opens the boot-time presence + inbox trystero rooms, and
  // trystero pins its relay sockets on the FIRST joinRoom for the whole
  // process. So those rooms must not open until settings hydration has
  // resolved, or a saved custom-relay list is silently dropped (the rooms
  // would freeze on the default relays). Gate on hydration finishing — ready
  // OR error (an error leaves `values` at defaults, so default relays are the
  // only option anyway and proceeding beats never starting presence/inbox).
  const settingsStatus = useSettingsStore((s) => s.status)
  const sessionStatus = useSessionStore((s) => s.status)
  const sessionTopic = useSessionStore((s) => s.sessionTopic)
  const [addOpen, setAddOpen] = useState(false)
  // F10 — words prefilled into the Add-friend Enter-code tab from an OS deep
  // link. Set alongside opening the dialog on the join tab; never auto-connects.
  const [deepLinkWords, setDeepLinkWords] = useState<string[]>()
  // Offline ContactCard import — raw bytes located by a scan/paste (via the
  // AddFriendDialog) or an OS studyvis://add# deep link, plus how they arrived
  // (drives whether the safety number is required in the confirm sheet).
  const [importCard, setImportCard] = useState<Uint8Array>()
  const [importSource, setImportSource] =
    useState<ContactImportSource>('remote')
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
          strings.friends.inviteSent(
            friend.display_name?.trim() ||
              strings.friends.addDialog.defaultFriendName
          )
        )
      } catch (err) {
        // F6 — InviteTimeoutError (friend offline; retry queued) and
        // InviteRelayError (relays unreachable; the user's own network) get
        // distinct honest copy, separate from the generic fallback.
        const message =
          err instanceof InviteRelayError
            ? strings.friends.inviteRelayError
            : err instanceof InviteTimeoutError
              ? strings.friends.inviteTimeout
              : err instanceof InviteWhileGuestError
                ? strings.friends.inviteWhileGuest
                : err instanceof Error
                  ? err.message
                  : strings.friends.inviteSendErrorFallback
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
      toast.error(strings.errors.leaveSessionFirst)
      return
    }
    try {
      joinSession(invite.payload.session_topic, invite.payload.session_password)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : strings.friends.joinErrorFallback
      toast.error(message)
    }
  }, [])

  // F10 — an OS-delivered pairing link opens the Add-friend dialog straight on
  // the Enter-code tab with the words prefilled. We leave settings/session if
  // they're showing so the dialog is actually visible. NEVER auto-connects —
  // AddFriendDialog only prefills; the user still presses Connect.
  const handlePairDeepLink = useCallback((words: string[]) => {
    setView('main')
    setDeepLinkWords(words)
    setAddOpen(true)
  }, [])

  // A studyvis://add# ContactCard arrived via the OS. Open the import confirm
  // sheet (remote path → safety number required). Never auto-adds. Closes the
  // Add-friend dialog first (like handleImportCard) so two modals can't stack
  // and any in-flight legacy pairing room is torn down rather than orphaned.
  const handleContactDeepLink = useCallback((cardBytes: Uint8Array) => {
    setView('main')
    setAddOpen(false)
    setDeepLinkWords(undefined)
    setImportSource('remote')
    setImportCard(cardBytes)
  }, [])

  // A friend's ContactCard was scanned/pasted inside the Add-friend dialog. Hand
  // off to the import confirm sheet, closing the add dialog so a single modal is
  // visible. 'qr' relaxes the safety-number gate (physical presence).
  const handleImportCard = useCallback(
    (cardBytes: Uint8Array, source: ContactImportSource) => {
      setAddOpen(false)
      setDeepLinkWords(undefined)
      setImportSource(source)
      setImportCard(cardBytes)
    },
    []
  )

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
      // Enforce the "leave first" guard BEFORE the topic gate too — otherwise
      // accepting an invite mid-session (AI on) would queue pendingStart and
      // pop the topic modal even though runGuestJoin would later refuse.
      if (useSessionStore.getState().status === 'active') {
        toast.error(strings.errors.leaveSessionFirst)
        return
      }
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
        <span className="sr-only">{strings.common.loading}</span>
      </main>
    )
  }

  // D1 — identity.json exists but couldn't be read. Never fall through to
  // Onboarding here; its create path would overwrite the still-valid keychain
  // keys and strand every friend who knows the old pubkey.
  if (status === 'error') {
    return <IdentityLoadError />
  }

  if (status === 'absent' || onboarding.status === 'pending') {
    return <Onboarding onComplete={onboarding.complete} />
  }

  // InboxBoot is rendered exactly once, outside the view selector, so React
  // doesn't unmount + remount it (and tear down the always-on inbox + presence
  // subscriptions) on every settings/session toggle. The identity-readiness
  // gate stays — only render once `useIdentity` has resolved to a record.
  const inbox =
    identity && status === 'ready' && settingsStatus !== 'loading' ? (
      <InboxBoot
        key="inbox-boot"
        myEdPubkeyHex={identity.ed_pubkey_hex}
        onPresenceChange={setPresence}
        onInviteAccepted={handleInviteAccepted}
      />
    ) : null

  // Gate + inbox travel together everywhere a new session can be started.
  // PairDeepLinkBoot rides along too so an OS pairing link is caught no matter
  // which view is showing.
  const tail = (
    <>
      {inbox}
      <PairDeepLinkBoot
        onPairWords={handlePairDeepLink}
        onContactCard={handleContactDeepLink}
      />
      <ContactImportDialog
        open={importCard !== undefined}
        cardBytes={importCard ?? null}
        source={importSource}
        onOpenChange={(next) => {
          if (!next) setImportCard(undefined)
        }}
      />
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
        {/* V3-P7 — Visually-hidden top-level heading. The visible heading on
            this route is "Friends" (h2 inside FriendsListView, used as the
            section's aria-labelledby anchor); add an h1 so SR users see a
            clean hierarchy and routes don't skip levels. */}
        <h1 className="sr-only">{strings.app.homeSrHeading}</h1>
        <div
          className="mx-auto flex w-full items-center justify-end gap-2 px-4 pt-4 sm:px-6 sm:pt-6"
          style={{ maxWidth: tokens.sizes.readingMaxWidth }}
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setView('settings')}
            aria-label={strings.settings.openAriaLabel}
          >
            <Settings2Icon /> {strings.settings.heading}
          </Button>
        </div>
        <FriendsList
          presence={presence}
          onAddFriend={() => setAddOpen(true)}
          onInvite={handleInvite}
        />
        <AddFriendDialog
          open={addOpen}
          onOpenChange={(next) => {
            setAddOpen(next)
            if (!next) setDeepLinkWords(undefined)
          }}
          initialTab={deepLinkWords ? 'join' : undefined}
          initialWords={deepLinkWords}
          onImportCard={handleImportCard}
        />
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
