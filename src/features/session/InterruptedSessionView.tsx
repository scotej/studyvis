import { UsersIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { tokens } from '@/design/tokens'
import { strings } from '@/strings'

export type InterruptedSessionViewProps = {
  // Null when the session never declared one beyond the default label.
  studyTopic: string | null
  startedAt: number
  // The moment the record was read, captured once at boot. Passed in rather
  // than read here so this stays a pure render (and a story stays stable).
  now: number
  rejoining?: boolean
  onRejoin: () => void
  onEnd: () => void
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

function startedLine(startedAt: number, now: number): string {
  const elapsed = Math.max(0, now - startedAt)
  if (elapsed < MINUTE_MS) return strings.session.interrupted.startedJustNow
  if (elapsed < HOUR_MS) {
    return strings.session.interrupted.startedMinutesAgo(
      Math.floor(elapsed / MINUTE_MS)
    )
  }
  return strings.session.interrupted.startedHoursAgo(
    Math.round(elapsed / HOUR_MS)
  )
}

// #225 — the launch-time decision after StudyVis closed mid-session. A
// full-screen view rather than a banner: this is the first thing the app has
// to say, and the room it describes may be emptying while it is on screen.
// Presentational, so Storybook renders it without the keychain or a store.
export function InterruptedSessionView({
  studyTopic,
  startedAt,
  now,
  rejoining = false,
  onRejoin,
  onEnd,
}: InterruptedSessionViewProps) {
  const copy = strings.session.interrupted
  return (
    <main
      aria-label={copy.ariaLabel}
      className="flex min-h-full flex-col items-center justify-center bg-bg-base px-4 py-4 text-text-primary sm:px-6 sm:py-6"
    >
      <div
        className="flex w-full flex-col items-center gap-6 text-center"
        // Text-dense centered card → the §12 reading measure.
        style={{ maxWidth: tokens.sizes.readingMaxWidth }}
      >
        <div className="flex size-12 items-center justify-center rounded-full bg-bg-raised text-text-secondary">
          <UsersIcon className="size-6" aria-hidden />
        </div>
        <header className="flex flex-col items-center gap-3">
          <p className="text-xs font-medium tracking-wide text-text-muted uppercase">
            {copy.eyebrow}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {copy.heading}
          </h1>
          <p className="max-w-md text-sm leading-snug text-text-secondary">
            {copy.body}
          </p>
        </header>
        <div className="flex max-w-md flex-col gap-1 text-sm leading-snug text-text-secondary">
          {studyTopic ? (
            <p>
              {copy.topicBefore}
              <span className="font-medium text-text-primary">
                {studyTopic}
              </span>
              {copy.topicAfter}
            </p>
          ) : null}
          <p>{startedLine(startedAt, now)}</p>
        </div>
        <div className="flex w-full max-w-xs flex-col gap-3">
          <Button
            size="lg"
            autoFocus
            onClick={onRejoin}
            disabled={rejoining}
            aria-disabled={rejoining || undefined}
          >
            {rejoining ? copy.rejoining : copy.rejoinCta}
          </Button>
          <Button
            size="lg"
            variant="outline"
            onClick={onEnd}
            disabled={rejoining}
            aria-disabled={rejoining || undefined}
          >
            {copy.endCta}
          </Button>
        </div>
        <p className="max-w-md text-xs leading-snug text-text-muted">
          {copy.footnote}
        </p>
      </div>
    </main>
  )
}
