// Top-level view orchestrator: switches between loading / identity-error /
// onboarding / active-session / report / settings / friends-list, and owns
// the flows that must survive any of those views — the add-friend dialog,
// contact-card import, deep-link routing, and the AI topic gate that queues a
// host/guest session start behind the "what are you working on?" prompt.
//
// Mount-structure invariants, easy to break by "simplifying" the render:
// - `InboxBoot` renders exactly ONCE, outside the view switch, so the
//   always-on inbox + presence subscriptions never unmount on a view change.
//   The `key="app-tail"` on the `tail` fragment is what ENFORCES that — see
//   the note at its definition; without it, rendering it once here is not
//   enough.
// - The `tail` block (inbox boot, deep-link boot, import dialog, topic gate)
//   travels with EVERY view including the active session, so a deep link or
//   invite arriving mid-session isn't dropped.
// - The identity 'error' status renders IdentityLoadError and must never
//   fall through to Onboarding — its create path would overwrite still-valid
//   keychain keys (D1).

import { Fragment, useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Settings2Icon } from 'lucide-react'
import { toast } from 'sonner'

import { UpdateReadyBanner } from '@/components/UpdateReadyBanner'
import { Button } from '@/components/ui/button'
import { tokens } from '@/design/tokens'
import {
  discardPendingScreenStream,
  preacquireScreenStream,
  useModelStore,
} from '@/features/ai'
import {
  AddFriendDialog,
  ContactImportDialog,
  FriendsList,
  InboxBoot,
  InviteRelayError,
  InviteTimeoutError,
  PairDeepLinkBoot,
  PendingInvites,
  pendingInviteKey,
  usePendingInvitesStore,
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
  rejoinSession,
  Report,
  SessionView,
  TopicGateModal,
} from '@/features/session'
import { Settings, SettingsOverlay } from '@/features/settings'
import type { SettingsCategoryId } from '@/features/settings'
import type { Friend } from '@/lib/db/friends'
import { boxEncryptWithKeyring } from '@/lib/db/identity'
import { useFriendsStore } from '@/stores/friendsStore'
import { useIdentityStore } from '@/stores/identityStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { strings } from '@/strings'

import { joinAndRemovePendingInvite } from './pendingInviteJoin'

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
  // #47 B3 / #190 — a deliberate local ending may be rejoinable until its
  // teardown-time deadline. The store retains credentials and the prior role
  // until the report closes or a successful rejoin begins.
  const sessionEndedBy = useSessionStore((s) => s.endedBy)
  const rejoinDeadline = useSessionStore((s) => s.rejoinDeadline)
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
  // I74 — category the main-view Settings opens on. Normally undefined (the
  // Settings default); the friends-list limited-connection hint deep-links to
  // 'network'. Reset on every open so a hint-driven visit doesn't stick.
  const [settingsCategory, setSettingsCategory] = useState<
    SettingsCategoryId | undefined
  >(undefined)
  // #47 B2 — Settings hosted over a live session (null = closed). Distinct
  // from `view`: SessionView stays mounted underneath so media, peers, and
  // the AI loop keep running. Cleared whenever the session stops being
  // active so a stale overlay can't greet the next session.
  const [sessionSettingsCategory, setSessionSettingsCategory] =
    useState<SettingsCategoryId | null>(null)
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

  // I83 — hydrate the model store at boot, not at Settings → AI mount.
  //
  // `activeModelId` is the gate on the whole AI focus pipeline: SessionView
  // starts no sample loop without it, and `handleTopicSubmit` below skips the
  // gesture-context screen pre-acquire without it. Until this effect existed
  // the ONLY caller of `hydrate()` was ModelPickerContainer, which mounts
  // exclusively inside Settings → AI — so on every launch where the user
  // didn't happen to visit that pane, a fully configured install ran a whole
  // session with AI silently dead and persisted an unscored sessions row
  // (issue #92: score/focused_pct NULL, no ai_* audit rows, no toast, no log).
  // Hydrating here (Home is the main window's root view, mounted before any
  // session can start) makes the persisted model the truth from boot.
  useEffect(() => {
    void useModelStore.getState().hydrate()
  }, [])

  const runHostInvite = useCallback(
    async (friend: Friend) => {
      if (!identity || !identity.display_name) return
      try {
        const result = await inviteToCurrentSession({
          friend,
          sender: {
            edPubkeyHex: identity.ed_pubkey_hex,
            displayName: identity.display_name,
            sign: actions.signWithKeyring,
            encryptTo: boxEncryptWithKeyring,
          },
        })
        const name =
          friend.display_name?.trim() ||
          strings.friends.addDialog.defaultFriendName
        // #47 C2 — a verified delivery ACK earns the confident toast; no ACK
        // gets the honest soft copy (older build, slow answer, or a friend
        // who never added you back).
        if (result.acked) {
          toast.success(strings.friends.inviteSent(name))
        } else {
          toast(strings.friends.inviteSentUnconfirmed(name))
        }
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
    // so the gate + guard share one decision point.) The invite stays on the
    // #47 B1 pending surface for after they leave.
    if (useSessionStore.getState().status === 'active') {
      toast.error(strings.errors.leaveSessionFirst)
      return false
    }
    const key = pendingInviteKey(invite)
    const activeIdentity =
      useIdentityStore.getState().identity?.ed_pubkey_hex.toLowerCase() ?? null
    const pendingState = usePendingInvitesStore.getState()
    const pendingIdentity = pendingState.identityEdPubkeyHex
    const pendingEntry = pendingState.pending.find((entry) => entry.key === key)
    // Invite actions can outlive the identity that created them (for example a
    // Sonner action while Settings restores another identity). Require both the
    // current identity scope and the still-present row before using its session
    // credentials. InboxBoot also dismisses its toast on cleanup; this is the
    // final defense at the irreversible join boundary.
    if (
      !activeIdentity ||
      !pendingIdentity ||
      pendingIdentity !== activeIdentity ||
      pendingEntry?.invite.payload.sig !== invite.payload.sig
    ) {
      return false
    }
    // Removing a friend is a trust revocation. React/store reconciliation is
    // intentionally redundant with this acceptance-time check so a click in
    // the render-to-effect gap cannot join a removed friend's room. Only a
    // ready roster is authoritative: during boot the inbox's database lookup
    // has already validated a live invite while the Zustand list may be empty.
    const sender = invite.from_ed_pubkey.toLowerCase()
    const friendsState = useFriendsStore.getState()
    const isCurrentFriend = friendsState.friends.some(
      (friend) => friend.ed_pubkey_hex.toLowerCase() === sender
    )
    if (friendsState.status === 'ready' && !isCurrentFriend) {
      pendingState.remove(key)
      toast.error(strings.friends.inbox.pending.friendUnavailable)
      return false
    }
    // #47 B1 — re-check expiry at accept time: the toast/banner row may be
    // minutes old, and joining a dead session would strand the user on a
    // waiting tile.
    if (invite.payload.expires_at <= Date.now()) {
      pendingState.remove(key)
      toast.error(strings.friends.inbox.pending.expired)
      return false
    }
    try {
      joinAndRemovePendingInvite(invite, key, pendingIdentity, {
        joinSession,
        removePendingInviteIfCurrent: pendingState.removeIfCurrent,
      })
      return true
    } catch (err) {
      const message =
        err instanceof Error ? err.message : strings.friends.joinErrorFallback
      toast.error(message)
      return false
    }
  }, [])

  // F10 — an OS-delivered pairing link opens the Add-friend dialog straight on
  // the Enter-code tab with the words prefilled. We leave settings/session if
  // they're showing so the dialog is actually visible. NEVER auto-connects —
  // AddFriendDialog only prefills; the user still presses Connect.
  const handlePairDeepLink = useCallback((words: string[]) => {
    // AddFriendDialog only mounts in the main view, not during an active
    // session, so setting addOpen here mid-session would render nothing now AND
    // pop the dialog open with stale words after the session ends. Guard the
    // same way as the invite/join paths — legacy live pairing needs a live
    // rendezvous with the friend anyway, so ask the user to leave first. (The
    // contact-card deep link is fine mid-session — it's a pure local import.)
    if (useSessionStore.getState().status === 'active') {
      toast.error(strings.errors.leaveSessionFirst)
      return
    }
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

  // Adjust-state-during-render (the TopicGateModal pattern, not an effect):
  // when the session stops being active the overlay unmounts with the session
  // branch, but the category state must not survive into the NEXT session.
  const [wasSessionActive, setWasSessionActive] = useState(
    sessionStatus === 'active'
  )
  if ((sessionStatus === 'active') !== wasSessionActive) {
    setWasSessionActive(sessionStatus === 'active')
    if (sessionStatus !== 'active') setSessionSettingsCategory(null)
  }

  const openSessionSettings = useCallback((category?: SettingsCategoryId) => {
    setSessionSettingsCategory(category ?? 'identity')
  }, [])

  const aiOn = () => useSettingsStore.getState().values.aiFeaturesEnabled

  // #47 B3 / #190 — re-enter the room after an accidental local Leave. Reuses
  // the already-declared topic (no AI topic-gate re-prompt) and the
  // credentials the store holds until the Report closes; joinSession's
  // begin() flips status to 'active', unmounting the Report.
  const handleRejoin = useCallback(() => {
    const request = useSessionStore.getState().getRejoinRequest()
    if (!request) return
    const s = useSessionStore.getState()
    // I83 — Rejoin skips the topic gate, so it also used to skip the only
    // gesture-context screen pre-acquire (handleTopicSubmit's). This click IS
    // a user gesture; spend it the same way, or the rejoined session's boot()
    // calls getDisplayMedia gestureless and AI is dead for the second stint.
    // Must precede any await, and the model-store gate matches
    // handleTopicSubmit's.
    if (aiOn()) {
      const models = useModelStore.getState()
      if (models.activeModelId || models.status === 'loading') {
        void preacquireScreenStream()
      }
      s.setPendingInitialTopic(s.declaredStudyTopic)
    }
    try {
      rejoinSession(
        request.sessionTopic,
        request.sessionPassword,
        request.isHost
      )
    } catch (err) {
      // I83 — the rejoin failed, so no SessionView will mount to consume (or
      // unmount to discard) the stream pre-acquired a few lines up. Release it
      // here or the OS screen-recording indicator stays lit with no session
      // behind it until the app quits.
      discardPendingScreenStream()
      const message =
        err instanceof Error ? err.message : strings.friends.joinErrorFallback
      toast.error(message)
    }
  }, [])

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
      // V2-P9 gesture fix — this submit click is the only place a
      // getDisplayMedia() call for the upcoming session's AI screen capture
      // can run inside real transient activation: sampleLoop's boot() (a
      // useEffect, once SessionView mounts) has no gesture of its own. Only
      // bother when a model is actually active — otherwise boot() never
      // runs and nothing would consume the pre-acquired stream. Must be the
      // very first thing this handler does, before any `await`.
      //
      // I83 — a store still mid-hydration counts as "maybe active". Reading a
      // null `activeModelId` out of an unhydrated store used to skip the
      // pre-acquire, and on WebView2 that is fatal rather than degraded:
      // boot()'s gestureless getDisplayMedia is refused outright and the loop
      // dies before its first tick. An unconsumed stream is the cheap side of
      // this trade — SessionView discards it on unmount.
      //
      // The host branch additionally repeats `runHostInvite`'s own
      // identity/display_name guard: that guard returns silently BEFORE the
      // session begins, so SessionView never mounts and nothing would ever
      // release the stream — the OS recording indicator would stay lit with no
      // session behind it.
      const models = useModelStore.getState()
      const canStart =
        req.kind === 'guest' || Boolean(identity && identity.display_name)
      const preacquiredScreen =
        canStart && Boolean(models.activeModelId || models.status === 'loading')
      if (preacquiredScreen) {
        void preacquireScreenStream()
      }
      // Seed the one-shot topic BEFORE the session flips to active so
      // `begin()` writes it into both initialDeclaredTopic (→
      // sessions.declared_topic) and the live declaredStudyTopic.
      useSessionStore.getState().setPendingInitialTopic(topic)
      if (req.kind === 'host') {
        void runHostInvite(req.friend)
      } else if (!runGuestJoin(req.invite) && preacquiredScreen) {
        // The invitation may have expired, been replaced, lost its identity
        // scope, or had its sender removed while the topic modal was open.
        // No SessionView will mount to consume the gesture-time acquisition.
        discardPendingScreenStream()
      }
    },
    [pendingStart, runHostInvite, runGuestJoin, identity]
  )

  if (status === 'loading' || onboarding.status === 'loading') {
    return (
      <main
        className="flex min-h-full items-center justify-center bg-bg-base text-text-secondary"
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
  //
  // The `key` is load-bearing, not decoration. Each branch below returns a
  // different number of children before the tail (main: 1, settings/report/
  // session: 2), and React matches UNKEYED children by position — so an
  // unkeyed tail lands in a slot occupied by `<Settings/>`, the element types
  // differ, and the whole subtree is deleted and rebuilt. That remount tears
  // down presence + the inbox: a `{leaving:true}` goodbye goes out (friends
  // see an offline blip and an N3 "came online" ping), the presence map
  // restarts empty so Invite buttons vanish for up to a sweep, and an invite
  // arriving in the gap is lost. A key makes the slot stable, so the fiber is
  // reused across every branch. Do not remove it when editing these returns.
  const tail = (
    <Fragment key="app-tail">
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
    </Fragment>
  )

  if (sessionStatus === 'active') {
    // PR-23 — render the full tail (not just {inbox}) so PairDeepLinkBoot's
    // onOpenUrl listener and the contact-import dialog stay mounted during a
    // live session. Rendering only {inbox} tore the deep-link subscriber down,
    // so a studyvis:// link clicked mid-session was delivered to zero JS
    // listeners and silently dropped. TopicGateModal stays closed (no pending
    // start during an active session); a contact link opens the import dialog
    // over the session, which is a pure local friend import.
    return (
      <>
        {/* #47 A2 — presence + the invite sender let the host grow a live
            session toward the 4-user mesh. Deliberately runHostInvite, not
            handleInvite: the session already declared its topic at start, so
            the AI topic gate must not re-prompt for a mid-session invite. */}
        {/* #47 B2 — display:contents keeps the wrapper out of layout while
            `inert` removes the session UI from focus + the a11y tree while
            the settings overlay is up (media keeps flowing — inert only
            blocks interaction). */}
        <div inert={sessionSettingsCategory !== null} className="contents">
          <SessionView
            presence={presence}
            onInviteFriend={(friend) => void runHostInvite(friend)}
            onOpenSettings={openSessionSettings}
          />
        </div>
        {sessionSettingsCategory !== null ? (
          <SettingsOverlay
            initialCategory={sessionSettingsCategory}
            onClose={() => setSessionSettingsCategory(null)}
            presence={presence}
          />
        ) : null}
        {tail}
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
          topContent={<PendingInvites onAccept={handleInviteAccepted} />}
          onClose={() => useSessionStore.getState().reset()}
          onRejoin={
            rejoinDeadline !== null && sessionEndedBy === 'user'
              ? handleRejoin
              : undefined
          }
          rejoinDeadline={rejoinDeadline ?? undefined}
          showDiagnosticsExport
        />
        {tail}
      </>
    )
  }

  if (view === 'settings') {
    return (
      <>
        <Settings
          onClose={() => setView('main')}
          initialCategory={settingsCategory}
          presence={presence}
          topContent={<PendingInvites onAccept={handleInviteAccepted} />}
        />
        {tail}
      </>
    )
  }

  return (
    <>
      <main className="min-h-full bg-bg-base text-text-primary">
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
            onClick={() => {
              setSettingsCategory(undefined)
              setView('settings')
            }}
            aria-label={strings.settings.openAriaLabel}
          >
            <Settings2Icon /> {strings.settings.heading}
          </Button>
        </div>
        {/* X6 — the staged-update banner lives only on the dashboard: it's
            the one view where restarting costs nothing. The component
            self-hides mid-session and while nothing is staged. */}
        <UpdateReadyBanner />
        {/* #47 B1 — pending incoming invites persist here for their full
            5-minute validity; accepting funnels through the same topic-gated
            path as the toast. */}
        <PendingInvites onAccept={handleInviteAccepted} />
        <FriendsList
          presence={presence}
          onAddFriend={() => setAddOpen(true)}
          onInvite={handleInvite}
          onOpenNetworkSettings={() => {
            setSettingsCategory('network')
            setView('settings')
          }}
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
