import { AlertTriangleIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { tokens } from '@/design/tokens'
import { strings } from '@/strings'

export type IdentityLoadErrorViewProps = {
  retrying: boolean
  onRetry: () => void
  onRecover: () => void
}

// D1 — the calm "we couldn't read your identity file" screen. Presentational so
// Storybook renders it without the keychain commands. It deliberately offers no
// "create a new identity" path: the private keys are still valid in the
// keychain, and a fresh identity would abandon them and strand every friend who
// knows the old pubkey.
export function IdentityLoadErrorView({
  retrying,
  onRetry,
  onRecover,
}: IdentityLoadErrorViewProps) {
  const copy = strings.identity.loadError
  return (
    <main
      aria-label={copy.ariaLabel}
      className="flex min-h-full flex-col items-center justify-center bg-bg-base px-4 py-4 text-text-primary sm:px-6 sm:py-6"
    >
      <div
        className="flex w-full flex-col items-center gap-6 text-center"
        // Text-dense centered card → the §12 reading measure, not the wide
        // onboarding measure.
        style={{ maxWidth: tokens.sizes.readingMaxWidth }}
      >
        <div className="flex size-12 items-center justify-center rounded-full bg-bg-raised text-text-secondary">
          <AlertTriangleIcon className="size-6" aria-hidden />
        </div>
        <header className="flex flex-col items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {copy.heading}
          </h1>
          <p className="max-w-md text-sm leading-snug text-text-secondary">
            {copy.body}
          </p>
        </header>
        <p className="max-w-md text-xs leading-snug text-text-muted">
          {copy.recoverNote}
        </p>
        <div className="flex w-full max-w-xs flex-col gap-3">
          <Button
            size="lg"
            autoFocus
            onClick={onRetry}
            disabled={retrying}
            aria-disabled={retrying || undefined}
          >
            {copy.retryCta}
          </Button>
          <Button size="lg" variant="outline" onClick={onRecover}>
            {copy.recoverCta}
          </Button>
        </div>
      </div>
    </main>
  )
}
