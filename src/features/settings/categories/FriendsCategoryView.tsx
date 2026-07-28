// Presentational half of Settings → Friends (#101). Every value it renders is
// derived on the device — the friends row, the live presence map, and local
// session history — so the pane can answer "who is this, really?" and "how
// much have we actually studied?" without storing anything new.
//
// Split out from FriendsCategory for the same reason FriendsListView is split
// from FriendsList: the container needs Tauri to say anything at all, and
// Storybook (plus the axe-core gate that rides on it) needs the populated
// states this pane only reaches with real data behind it.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { CheckIcon, ChevronRightIcon, CopyIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'

import {
  SettingsRow,
  SettingsSection,
  settingsRowChrome,
} from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import {
  formatLastTogether,
  presenceLabel,
  shortPubkey,
  type FriendPresenceState,
} from '@/features/friends'
import type { PartnerStudyTotals } from '@/features/stats/statsData'
import type { Friend } from '@/lib/db/friends'
import { cn } from '@/lib/utils'
import { strings } from '@/strings'

export type FriendDetail = {
  friend: Friend
  // Null when the caller has no presence subscription to read (Storybook, or
  // a host that never threaded the map down). Rendering "Offline" in that
  // case would be a claim the pane cannot back up, so the row is dropped.
  presence: FriendPresenceState | null
  // pairFingerprint(me, friend) — the Signal-style safety number both sides
  // compute identically. Null until the local identity has loaded.
  safetyNumber: string | null
  study: PartnerStudyTotals
}

export type StudyHistoryStatus = 'loading' | 'ready' | 'error'

export type FriendsCategoryViewProps = {
  details: ReadonlyArray<FriendDetail>
  // Only the "Studied together" / "Last together" rows depend on this; the
  // rest of a panel renders immediately from the friends row itself.
  studyStatus: StudyHistoryStatus
  onRemove: (friend: Friend) => void
  now?: number
  // ed_pubkey_hex of a panel to render already open. Storybook uses it to keep
  // the expanded content inside the axe-core gate, exactly as Disclosure's
  // defaultOpen does.
  defaultExpanded?: string
}

export function FriendsCategoryView({
  details,
  studyStatus,
  onRemove,
  now,
  defaultExpanded,
}: FriendsCategoryViewProps) {
  const copy = strings.settings.friends
  return (
    <SettingsSection heading={copy.heading}>
      {details.length === 0 ? (
        <SettingsRow label={copy.emptyLabel} help={copy.emptyHelp} />
      ) : (
        details.map((detail) => (
          <FriendEntry
            key={detail.friend.ed_pubkey_hex}
            detail={detail}
            studyStatus={studyStatus}
            onRemove={onRemove}
            now={now}
            defaultOpen={defaultExpanded === detail.friend.ed_pubkey_hex}
          />
        ))
      )}
    </SettingsSection>
  )
}

type FriendEntryProps = {
  detail: FriendDetail
  studyStatus: StudyHistoryStatus
  onRemove: (friend: Friend) => void
  now?: number
  defaultOpen: boolean
}

function FriendEntry({
  detail,
  studyStatus,
  onRemove,
  now,
  defaultOpen,
}: FriendEntryProps) {
  const copy = strings.settings.friends
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()
  const { friend, presence } = detail
  const name = friend.display_name?.trim()
  const short = shortPubkey(friend.ed_pubkey_hex)
  // Key material renders mono everywhere else in the app (Identity pane,
  // pairing dialogs) — the fingerprint here should match.
  const shortChip = <span className="font-mono">{short}</span>
  const status = presence ? presenceLabel(presence, now) : null
  // A nameless friend's label is already the fingerprint; repeating it in the
  // help line would stack the same string twice.
  const help = name ? (
    status ? (
      <>
        {shortChip} · {status}
      </>
    ) : (
      shortChip
    )
  ) : (
    status
  )

  return (
    <div className={settingsRowChrome}>
      <div className="flex flex-row items-center justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-medium text-text-primary">
            {name || shortChip}
          </span>
          {help ? (
            <span className="text-xs break-words text-text-secondary">
              {help}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setOpen((prev) => !prev)}
            aria-expanded={open}
            // Only while the panel is mounted — a dangling aria-controls id is
            // invalid (same reason SettingsLayout drops its rail's).
            aria-controls={open ? panelId : undefined}
            // The visible row label must appear in the accessible name (WCAG
            // 2.5.3) — for a nameless friend that's the fingerprint, which
            // also keeps the buttons distinguishable to a screen reader.
            aria-label={
              open
                ? copy.detail.hideAriaLabel(name || short)
                : copy.detail.showAriaLabel(name || short)
            }
          >
            {/* Instant rotation, no transition — DESIGN-SYSTEM §6 keeps
                transform motion out of the app (same as Disclosure). */}
            <ChevronRightIcon className={cn(open && 'rotate-90')} />
            {copy.detail.toggleCta}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onRemove(friend)}
            aria-label={copy.removeAriaLabel(name || short)}
          >
            <Trash2Icon /> {copy.removeCta}
          </Button>
        </div>
      </div>
      {open ? (
        <FriendPanel
          id={panelId}
          detail={detail}
          studyStatus={studyStatus}
          name={name || short}
          now={now}
        />
      ) : null}
    </div>
  )
}

function FriendPanel({
  id,
  detail,
  studyStatus,
  name,
  now,
}: {
  id: string
  detail: FriendDetail
  studyStatus: StudyHistoryStatus
  name: string
  now?: number
}) {
  const copy = strings.settings.friends.detail
  const { friend, presence, safetyNumber, study } = detail
  return (
    <dl
      id={id}
      className="mt-4 flex flex-col gap-4 rounded-md border border-border-subtle bg-bg-sunk px-4 py-4"
    >
      {presence ? (
        <PanelRow term={copy.statusLabel}>
          {presenceLabel(presence, now)}
        </PanelRow>
      ) : null}
      <PanelRow term={copy.safetyNumberLabel} help={copy.safetyNumberHelp}>
        {safetyNumber ? (
          <div className="flex items-start gap-2">
            <code className="font-mono text-sm tracking-wide tabular-nums select-all">
              {safetyNumber}
            </code>
            <CopyButton
              value={safetyNumber}
              ariaLabel={copy.safetyNumberCopyAriaLabel(name)}
            />
          </div>
        ) : (
          copy.safetyNumberPending
        )}
      </PanelRow>
      <PanelRow term={copy.publicKeyLabel} help={copy.publicKeyHelp}>
        <div className="flex items-start gap-2">
          <code className="min-w-0 font-mono text-xs break-all select-all">
            {friend.ed_pubkey_hex}
          </code>
          <CopyButton
            value={friend.ed_pubkey_hex}
            ariaLabel={copy.publicKeyCopyAriaLabel(name)}
          />
        </div>
      </PanelRow>
      <PanelRow term={copy.addedLabel}>
        {formatAdded(friend.paired_at)}
      </PanelRow>
      <PanelRow term={copy.studiedLabel}>
        {studyStatus === 'loading' ? copy.studiedLoading : null}
        {studyStatus === 'error' ? copy.studiedError : null}
        {studyStatus === 'ready' ? formatStudied(study) : null}
      </PanelRow>
      {studyStatus === 'ready' && study.sessions > 0 ? (
        <PanelRow term={copy.lastTogetherLabel}>
          {formatLastTogether(study.lastAt, now)}
        </PanelRow>
      ) : null}
    </dl>
  )
}

function PanelRow({
  term,
  help,
  children,
}: {
  term: string
  help?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1 sm:grid sm:grid-cols-[9rem_1fr] sm:gap-x-4">
      <dt className="text-xs font-medium text-text-secondary">{term}</dt>
      <dd className="min-w-0 text-xs text-text-primary">
        {children}
        {help ? <p className="mt-1 text-text-secondary">{help}</p> : null}
      </dd>
    </div>
  )
}

function CopyButton({
  value,
  ariaLabel,
}: {
  value: string
  ariaLabel: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(strings.common.errors.copyToClipboard)
    }
  }, [value])

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="shrink-0"
      onClick={() => void handleCopy()}
      aria-label={ariaLabel}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  )
}

function formatAdded(ts: number | null): string {
  if (ts === null) return strings.settings.friends.detail.addedUnknown
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  })
}

function formatStudied(study: PartnerStudyTotals): string {
  const copy = strings.settings.friends.detail
  if (study.sessions === 0) return copy.studiedNone
  return copy.studiedSummary(
    copy.studiedSessions(study.sessions),
    formatDuration(study.minutes)
  )
}

function formatDuration(minutes: number): string {
  const copy = strings.settings.friends.detail
  if (minutes < 60) return copy.durationMinutes(minutes)
  return copy.durationHours(Math.floor(minutes / 60), minutes % 60)
}
