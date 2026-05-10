import { CameraIcon, CheckIcon, MicIcon, BellIcon } from 'lucide-react'

import {
  OnboardingStep,
  type OnboardingStepProgress,
} from '@/components/OnboardingStep'
import { Button } from '@/components/ui/button'

export type PermissionId = 'camera' | 'microphone' | 'notifications'

export type PermissionState = 'unknown' | 'granted' | 'denied' | 'requesting'

export type PermissionsState = Record<PermissionId, PermissionState>

export type PermissionsStepViewProps = {
  state: PermissionsState
  progress?: OnboardingStepProgress
  onGrant: (id: PermissionId) => void
  onContinue: () => void
}

const ROWS: Array<{
  id: PermissionId
  title: string
  description: string
  Icon: typeof CameraIcon
}> = [
  {
    id: 'camera',
    title: 'Camera',
    description: 'Lets your friends see you while you study together.',
    Icon: CameraIcon,
  },
  {
    id: 'microphone',
    title: 'Microphone',
    description:
      'Used only while you hold the talk key — your mic stays muted otherwise.',
    Icon: MicIcon,
  },
  {
    id: 'notifications',
    title: 'Notifications',
    description: "So you see invites when StudyVis isn't focused.",
    Icon: BellIcon,
  },
]

export function PermissionsStepView({
  state,
  progress,
  onGrant,
  onContinue,
}: PermissionsStepViewProps) {
  const anyDenied = ROWS.some((r) => state[r.id] === 'denied')

  return (
    <OnboardingStep
      ariaLabel="Permissions"
      progress={progress}
      primaryAction={{ label: 'Continue', onClick: onContinue }}
    >
      <header className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          A few permissions to study together
        </h1>
        <p className="max-w-md text-sm leading-snug text-text-secondary">
          StudyVis only asks for what a session needs. You can change any of
          these later in Settings.
        </p>
      </header>

      <ul className="flex w-full flex-col gap-3" aria-label="Permission list">
        {ROWS.map((row) => (
          <PermissionRow
            key={row.id}
            id={row.id}
            title={row.title}
            description={row.description}
            Icon={row.Icon}
            state={state[row.id]}
            onGrant={() => onGrant(row.id)}
          />
        ))}
      </ul>

      <p className="max-w-md text-center text-xs text-text-muted">
        Headphones recommended — built-in mics + speakers can echo when several
        friends are talking.
      </p>

      {anyDenied ? (
        <p
          role="status"
          className="max-w-md text-center text-xs text-text-secondary"
        >
          You can grant any of these later in Settings.
        </p>
      ) : null}
    </OnboardingStep>
  )
}

function PermissionRow({
  id,
  title,
  description,
  Icon,
  state,
  onGrant,
}: {
  id: PermissionId
  title: string
  description: string
  Icon: typeof CameraIcon
  state: PermissionState
  onGrant: () => void
}) {
  const granted = state === 'granted'
  const requesting = state === 'requesting'
  const denied = state === 'denied'

  return (
    <li
      data-permission={id}
      data-state={state}
      className="flex items-center gap-4 rounded-lg border border-border-default bg-bg-surface p-4"
    >
      <div className="flex size-9 items-center justify-center rounded-md bg-bg-raised text-text-secondary">
        <Icon className="size-5" aria-hidden />
      </div>
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium text-text-primary">{title}</span>
        <span className="text-xs text-text-secondary">{description}</span>
      </div>
      <div className="flex shrink-0 items-center">
        {granted ? (
          <span
            className="flex items-center gap-1 text-sm text-status-focused"
            aria-label={`${title} permission granted`}
          >
            <CheckIcon className="size-4" aria-hidden /> Granted
          </span>
        ) : (
          <Button
            variant={denied ? 'outline' : 'default'}
            size="sm"
            onClick={onGrant}
            disabled={requesting}
            aria-disabled={requesting ? true : undefined}
          >
            {requesting ? 'Requesting…' : denied ? 'Try again' : 'Grant'}
          </Button>
        )}
      </div>
    </li>
  )
}
