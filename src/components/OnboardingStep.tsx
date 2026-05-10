import { type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type OnboardingStepAction = {
  label: string
  onClick: () => void
  type?: 'submit' | 'button'
  disabled?: boolean
  busy?: boolean
}

export type OnboardingStepProgress = {
  current: number
  total: number
}

export type OnboardingStepProps = {
  children: ReactNode
  progress?: OnboardingStepProgress
  ariaLabel?: string
  primaryAction?: OnboardingStepAction
  secondaryAction?: OnboardingStepAction
}

// Layout primitive for the onboarding flow (DESIGN-SYSTEM.md §4 +
// the §8.1 BIP39 wireframe). Renders a full-bleed canvas with optional
// progress dots in the top-right and an optional action footer.
export function OnboardingStep({
  children,
  progress,
  ariaLabel,
  primaryAction,
  secondaryAction,
}: OnboardingStepProps) {
  return (
    <main
      data-slot="onboarding-step"
      aria-label={ariaLabel}
      className="relative flex min-h-screen flex-col bg-bg-base px-6 py-12 text-text-primary"
    >
      {progress ? (
        <ProgressDots
          current={progress.current}
          total={progress.total}
          className="absolute right-6 top-6"
        />
      ) : null}
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-8">
        {children}
      </div>
      {primaryAction || secondaryAction ? (
        <footer
          data-slot="onboarding-actions"
          className="mx-auto mt-8 flex w-full max-w-2xl items-center justify-end gap-3"
        >
          {secondaryAction ? (
            <Button
              variant="ghost"
              type={secondaryAction.type ?? 'button'}
              onClick={secondaryAction.onClick}
              disabled={secondaryAction.disabled || secondaryAction.busy}
              aria-disabled={
                secondaryAction.disabled || secondaryAction.busy
                  ? true
                  : undefined
              }
            >
              {secondaryAction.label}
            </Button>
          ) : null}
          {primaryAction ? (
            <Button
              type={primaryAction.type ?? 'button'}
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled || primaryAction.busy}
              aria-disabled={
                primaryAction.disabled || primaryAction.busy ? true : undefined
              }
            >
              {primaryAction.label}
            </Button>
          ) : null}
        </footer>
      ) : null}
    </main>
  )
}

function ProgressDots({
  current,
  total,
  className,
}: {
  current: number
  total: number
  className?: string
}) {
  const dots = Array.from({ length: total }, (_, i) => i)
  return (
    <ol
      data-slot="onboarding-progress"
      aria-label={`Step ${current} of ${total}`}
      className={cn('flex items-center gap-1.5', className)}
    >
      {dots.map((i) => {
        const reached = i < current
        return (
          <li
            key={i}
            aria-hidden
            className={cn(
              'size-1.5 rounded-full transition-colors',
              reached ? 'bg-accent-default' : 'bg-border-default'
            )}
          />
        )
      })}
    </ol>
  )
}
