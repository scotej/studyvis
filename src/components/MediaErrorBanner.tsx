import { AlertTriangle, ExternalLink, RotateCcw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { mediaErrorKind } from '@/lib/mediaError'
import { cn } from '@/lib/utils'
import { strings } from '@/strings'

export type MediaErrorBannerProps = {
  // The DOMException `name` from the failed getUserMedia call. We switch on
  // the name (not the raw `message`) so the surfaced copy stays calm and
  // specific; the browser's own message never reaches the UI.
  errorName: string
  onRetry: () => void
  // Wired only for the permission-denied case, where jumping to the OS
  // privacy pane is the real fix. Omitted otherwise (matches the
  // ScreenCapturePermissionOverlay `onRetry?` pattern).
  onOpenSettings?: () => void
  className?: string
}

// Inline recovery banner shown when camera/mic acquisition fails at session
// join. Replaces the old raw-message dead-end: calm copy keyed on the error
// name, plus a "Try again" action that re-attempts acquisition.
export function MediaErrorBanner({
  errorName,
  onRetry,
  onOpenSettings,
  className,
}: MediaErrorBannerProps) {
  const kind = mediaErrorKind(errorName)
  const copy = strings.session.mediaErrors[kind]

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        'mb-4 flex items-start gap-3 rounded-md border border-status-warning/40 bg-bg-surface px-4 py-3',
        className
      )}
    >
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-status-warning/15 text-status-warning"
      >
        <AlertTriangle className="size-4" />
      </span>
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-text-primary">
            {copy.title}
          </span>
          <span className="text-sm text-text-secondary">{copy.body}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onRetry}>
            <RotateCcw /> {strings.session.mediaErrors.tryAgainCta}
          </Button>
          {onOpenSettings ? (
            <Button variant="secondary" size="sm" onClick={onOpenSettings}>
              <ExternalLink /> {strings.session.mediaErrors.openSettingsCta}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
