import { DownloadIcon, RotateCcwIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { tokens } from '@/design/tokens'
import { useUpdaterStore } from '@/features/updater'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/sessionStore'
import { strings } from '@/strings'

export type UpdateReadyBannerViewProps = {
  version: string
  installing: boolean
  onRestart: () => void
  onDismiss: () => void
  className?: string
}

// X6 — the one place an update is allowed to interrupt. It appears only once
// the new version is downloaded and its signature verified, so "Restart now"
// is a couple of seconds and never a surprise download.
//
// Deliberately quiet: `aria-live="polite"`, no modal, no toast.
export function UpdateReadyBannerView({
  version,
  installing,
  onRestart,
  onDismiss,
  className,
}: UpdateReadyBannerViewProps) {
  const copy = strings.updater.banner

  return (
    <section
      role="status"
      aria-live="polite"
      aria-label={copy.ariaLabel}
      className={cn('mx-auto w-full px-4 pt-4 sm:px-6', className)}
      style={{ maxWidth: tokens.sizes.readingMaxWidth }}
    >
      <div className="flex items-start gap-3 rounded-md border border-accent-default/40 bg-bg-surface px-4 py-3">
        <span
          aria-hidden="true"
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-default/15 text-accent-default"
        >
          <DownloadIcon className="size-4" />
        </span>
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-text-primary">
              {copy.title(version)}
            </span>
            <span className="text-sm text-text-secondary">{copy.body}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={onRestart} disabled={installing}>
              <RotateCcwIcon />
              {installing ? copy.installing : copy.restartCta}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onDismiss}
              disabled={installing}
              aria-label={copy.dismissAriaLabel}
            >
              {copy.laterCta}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}

// Container. Dismissing hides the banner for this process only — the staged
// update stays reachable from Settings → About, so dismissing can't strand
// someone on an old build.
export function UpdateReadyBanner({ className }: { className?: string }) {
  const status = useUpdaterStore((s) => s.status)
  const version = useUpdaterStore((s) => s.version)
  const dismissed = useUpdaterStore((s) => s.dismissed)
  const installing = useUpdaterStore((s) => s.installing)
  const installAndRestart = useUpdaterStore((s) => s.installAndRestart)
  const dismiss = useUpdaterStore((s) => s.dismiss)
  const sessionActive = useSessionStore((s) => s.status === 'active')

  const handleRestart = async () => {
    const ok = await installAndRestart()
    // Only reachable when the swap failed and we're still running — the
    // success path has already relaunched or been taken over by the installer.
    if (!ok) toast.error(strings.updater.errors.installFailed)
  }

  // Never mid-session: the download is already suppressed there (UpdaterBoot),
  // but an update staged before the session started could otherwise surface
  // over a live video grid and offer to restart out of it.
  if (status !== 'ready' || !version || dismissed || sessionActive) return null

  return (
    <UpdateReadyBannerView
      version={version}
      installing={installing}
      onRestart={() => void handleRestart()}
      onDismiss={dismiss}
      className={className}
    />
  )
}
