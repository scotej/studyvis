import { AlertTriangleIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { tokens } from '@/design/tokens'
import { strings } from '@/strings'

export type IdentityLoadErrorViewProps = {
  // 'file' (D1) — identity.json unreadable; keys presumed intact, so Retry
  // leads. 'keysMissing' (#47 E1) — the keychain definitively holds no keys;
  // retrying can't fix that, so the 24-word restore leads.
  variant?: 'file' | 'keysMissing'
  retrying: boolean
  onRetry: () => void
  onRecover: () => void
}

// D1 — the calm "we couldn't read your identity file" screen. Presentational so
// Storybook renders it without the keychain commands. It deliberately offers no
// "create a new identity" path: the private keys may still be valid in the
// keychain, and a fresh identity would abandon them and strand every friend who
// knows the old pubkey.
export function IdentityLoadErrorView({
  variant = 'file',
  retrying,
  onRetry,
  onRecover,
}: IdentityLoadErrorViewProps) {
  const copy =
    variant === 'keysMissing'
      ? strings.identity.keysMissing
      : strings.identity.loadError
  const retryButton = (
    <Button
      size="lg"
      variant={variant === 'keysMissing' ? 'outline' : 'default'}
      autoFocus={variant === 'file'}
      onClick={onRetry}
      disabled={retrying}
      aria-disabled={retrying || undefined}
    >
      {copy.retryCta}
    </Button>
  )
  const recoverButton = (
    <Button
      size="lg"
      variant={variant === 'keysMissing' ? 'default' : 'outline'}
      autoFocus={variant === 'keysMissing'}
      onClick={onRecover}
    >
      {copy.recoverCta}
    </Button>
  )
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
          {variant === 'keysMissing' ? (
            <>
              {recoverButton}
              {retryButton}
            </>
          ) : (
            <>
              {retryButton}
              {recoverButton}
            </>
          )}
        </div>
      </div>
    </main>
  )
}
