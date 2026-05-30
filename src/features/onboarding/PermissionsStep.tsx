import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  isPermissionGranted,
  requestPermission,
} from '@tauri-apps/plugin-notification'
import { toast } from 'sonner'

import {
  PermissionsStepView,
  type PermissionId,
  type PermissionState,
  type PermissionsState,
} from './PermissionsStepView'
import type { OnboardingStepProgress } from '@/components/OnboardingStep'
import { strings } from '@/strings'

export type PermissionsStepProps = {
  progress?: OnboardingStepProgress
  onContinue: () => void
}

const INITIAL: PermissionsState = {
  camera: 'unknown',
  microphone: 'unknown',
  notifications: 'unknown',
}

// Container for step 2: queries the OS for current permission state on mount,
// and runs the actual prompt when the user clicks each "Grant" button. The
// view itself is presentational (no side effects) so Storybook can render it
// without the camera or notification plugin.
export function PermissionsStep({
  progress,
  onContinue,
}: PermissionsStepProps) {
  const [state, setState] = useState<PermissionsState>(INITIAL)

  const update = useCallback((id: PermissionId, next: PermissionState) => {
    setState((cur) => ({ ...cur, [id]: next }))
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const camera = await queryMediaPermission('camera')
      if (!cancelled && camera) update('camera', camera)
      const mic = await queryMediaPermission('microphone')
      if (!cancelled && mic) update('microphone', mic)
      const note = await queryNotificationPermission()
      if (!cancelled && note) update('notifications', note)
    })()
    return () => {
      cancelled = true
    }
  }, [update])

  const handleGrant = useCallback(
    async (id: PermissionId) => {
      update(id, 'requesting')
      try {
        if (id === 'camera') {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: true,
          })
          stopTracks(stream)
          update('camera', 'granted')
        } else if (id === 'microphone') {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          })
          stopTracks(stream)
          update('microphone', 'granted')
        } else {
          const result = await requestPermission()
          update('notifications', result === 'granted' ? 'granted' : 'denied')
        }
      } catch {
        update(id, 'denied')
      }
    },
    [update]
  )

  const openSettings = useCallback(async (id: PermissionId) => {
    if (id === 'notifications') return
    const command =
      id === 'camera'
        ? 'system_open_camera_settings'
        : 'system_open_microphone_settings'
    try {
      await invoke(command)
    } catch {
      toast.error(strings.onboarding.permissions.openSettingsErrorFallback)
    }
  }, [])

  return (
    <PermissionsStepView
      state={state}
      progress={progress}
      onGrant={(id) => void handleGrant(id)}
      onOpenSettings={(id) => void openSettings(id)}
      onContinue={onContinue}
    />
  )
}

async function queryMediaPermission(
  name: 'camera' | 'microphone'
): Promise<PermissionState | null> {
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.permissions?.query !== 'function'
  ) {
    return null
  }
  try {
    const status = await navigator.permissions.query({
      name: name as PermissionName,
    })
    if (status.state === 'granted') return 'granted'
    if (status.state === 'denied') return 'denied'
    return 'unknown'
  } catch {
    return null
  }
}

async function queryNotificationPermission(): Promise<PermissionState | null> {
  try {
    const granted = await isPermissionGranted()
    return granted ? 'granted' : 'unknown'
  } catch {
    return null
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      // already-stopped tracks throw on some platforms; ignore.
    }
  }
}
