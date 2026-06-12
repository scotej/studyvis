import { CameraIcon, CheckIcon, MicIcon, BellIcon } from 'lucide-react'

import {
  OnboardingStep,
  type OnboardingStepProgress,
} from '@/components/OnboardingStep'
import { Button } from '@/components/ui/button'
import { isMacLikePlatform } from '@/lib/utils'
import { strings } from '@/strings'

export type PermissionId = 'camera' | 'microphone' | 'notifications'

export type PermissionState = 'unknown' | 'granted' | 'denied' | 'requesting'

export type PermissionsState = Record<PermissionId, PermissionState>

export type PermissionsStepViewProps = {
  state: PermissionsState
  progress?: OnboardingStepProgress
  onGrant: (id: PermissionId) => void
  onOpenSettings: (id: PermissionId) => void
  onContinue: () => void
  onBack?: () => void
}

const ROWS: Array<{
  id: PermissionId
  title: string
  description: string
  Icon: typeof CameraIcon
}> = [
  {
    id: 'camera',
    title: strings.onboarding.permissions.rows.camera.title,
    description: strings.onboarding.permissions.rows.camera.description,
    Icon: CameraIcon,
  },
  {
    id: 'microphone',
    title: strings.onboarding.permissions.rows.microphone.title,
    description: strings.onboarding.permissions.rows.microphone.description,
    Icon: MicIcon,
  },
  {
    id: 'notifications',
    title: strings.onboarding.permissions.rows.notifications.title,
    description: strings.onboarding.permissions.rows.notifications.description,
    Icon: BellIcon,
  },
]

export function PermissionsStepView({
  state,
  progress,
  onGrant,
  onOpenSettings,
  onContinue,
  onBack,
}: PermissionsStepViewProps) {
  const anyDenied = ROWS.some((r) => state[r.id] === 'denied')
  // A camera/mic grant flipped on in System Settings only takes effect after a
  // relaunch (macOS TCC is process-cached), so the deep-linked denied state
  // needs an explicit reopen hint the generic note doesn't give.
  const mediaDeniedOnMac =
    isMacLikePlatform() &&
    ROWS.some((r) => r.id !== 'notifications' && state[r.id] === 'denied')

  return (
    <OnboardingStep
      ariaLabel={strings.onboarding.permissions.ariaLabel}
      progress={progress}
      secondaryAction={
        onBack
          ? { label: strings.common.actions.back, onClick: onBack }
          : undefined
      }
      primaryAction={{
        label: strings.common.actions.continue,
        onClick: onContinue,
      }}
    >
      <header className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          {strings.onboarding.permissions.heading}
        </h1>
        <p className="max-w-md text-sm leading-snug text-text-secondary">
          {strings.onboarding.permissions.body}
        </p>
        <p className="max-w-md text-xs text-text-muted">
          {strings.onboarding.permissions.privacyNote}
        </p>
      </header>

      <ul
        className="flex w-full flex-col gap-3"
        aria-label={strings.onboarding.permissions.listAriaLabel}
      >
        {ROWS.map((row) => (
          <PermissionRow
            key={row.id}
            id={row.id}
            title={row.title}
            description={row.description}
            Icon={row.Icon}
            state={state[row.id]}
            onGrant={() => onGrant(row.id)}
            onOpenSettings={() => onOpenSettings(row.id)}
          />
        ))}
      </ul>

      <p className="max-w-md text-center text-xs text-text-muted">
        {strings.onboarding.permissions.headphonesHint}
      </p>

      {mediaDeniedOnMac ? (
        <p
          role="status"
          className="max-w-md text-center text-xs text-text-secondary"
        >
          {strings.onboarding.permissions.reopenHint}
        </p>
      ) : anyDenied ? (
        <p
          role="status"
          className="max-w-md text-center text-xs text-text-secondary"
        >
          {strings.onboarding.permissions.denialNote}
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
  onOpenSettings,
}: {
  id: PermissionId
  title: string
  description: string
  Icon: typeof CameraIcon
  state: PermissionState
  onGrant: () => void
  onOpenSettings: () => void
}) {
  const granted = state === 'granted'
  const requesting = state === 'requesting'
  const denied = state === 'denied'
  // A hard-denied camera/mic grant won't re-prompt from getUserMedia, so the
  // denied state routes to System Settings instead of a no-op retry. The
  // deep-link is macOS-only (matching system_open_screen_capture_settings), so
  // off-mac and notifications fall back to "Try again".
  const deniedRoutesToSettings =
    denied && id !== 'notifications' && isMacLikePlatform()

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
            aria-label={strings.onboarding.permissions.grantedAriaLabel(title)}
          >
            <CheckIcon className="size-4" aria-hidden />{' '}
            {strings.onboarding.permissions.grantedLabel}
          </span>
        ) : deniedRoutesToSettings ? (
          <Button variant="outline" size="sm" onClick={onOpenSettings}>
            {strings.onboarding.permissions.openSettingsCta}
          </Button>
        ) : (
          <Button
            variant={denied ? 'outline' : 'default'}
            size="sm"
            onClick={onGrant}
            disabled={requesting}
            aria-disabled={requesting ? true : undefined}
          >
            {denied
              ? strings.onboarding.permissions.tryAgainCta
              : strings.onboarding.permissions.grantCta}
          </Button>
        )}
      </div>
    </li>
  )
}
