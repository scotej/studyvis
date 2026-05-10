import { useState } from 'react'

import {
  OnboardingStep,
  type OnboardingStepProgress,
} from '@/components/OnboardingStep'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export type DisplayNameStepProps = {
  progress?: OnboardingStepProgress
  initialValue?: string
  submitting: boolean
  error: string | null
  onSubmit: (name: string) => void
}

const MAX_LENGTH = 64

export function DisplayNameStep({
  progress,
  initialValue = '',
  submitting,
  error,
  onSubmit,
}: DisplayNameStepProps) {
  const [value, setValue] = useState(initialValue)
  const trimmed = value.trim()
  const disabled = submitting || trimmed.length === 0

  return (
    <OnboardingStep
      ariaLabel="Pick a display name"
      progress={progress}
      primaryAction={{
        label: 'Continue',
        onClick: () => {
          if (!disabled) onSubmit(trimmed)
        },
        disabled,
        busy: submitting,
      }}
    >
      <form
        className="flex w-full max-w-md flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault()
          if (disabled) return
          onSubmit(trimmed)
        }}
      >
        <header className="flex flex-col items-center gap-3 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            What should friends see?
          </h1>
          <p className="max-w-sm text-sm leading-snug text-text-secondary">
            Pick anything — your name, a nickname, an emoji. You can change it
            in Settings.
          </p>
        </header>

        <div className="flex flex-col gap-2">
          <Label htmlFor="onboarding-display-name">Display name</Label>
          <Input
            id="onboarding-display-name"
            autoFocus
            maxLength={MAX_LENGTH}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={
              error ? 'onboarding-display-name-error' : undefined
            }
          />
          {error ? (
            <p
              id="onboarding-display-name-error"
              className="text-xs text-status-alerted"
            >
              {error}
            </p>
          ) : null}
        </div>
      </form>
    </OnboardingStep>
  )
}
