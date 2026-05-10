import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { Toaster } from '@/components/ui/sonner'
import { AddFriendStepView } from '@/features/onboarding/AddFriendStepView'
import { DisplayNameStep } from '@/features/onboarding/DisplayNameStep'
import {
  PermissionsStepView,
  type PermissionsState,
} from '@/features/onboarding/PermissionsStepView'
import { TutorialStep } from '@/features/onboarding/TutorialStep'
import { WelcomeStep } from '@/features/onboarding/WelcomeStep'

const PROGRESS_TOTAL = 6

const meta = {
  title: 'Features/Onboarding',
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster position="bottom-right" />
      </>
    ),
  ],
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Welcome: Story = {
  render: () => (
    <WelcomeStep
      progress={{ current: 1, total: PROGRESS_TOTAL }}
      onContinue={() => undefined}
    />
  ),
}

export const PermissionsAllUnknown: Story = {
  render: () => (
    <PermissionsStepView
      progress={{ current: 2, total: PROGRESS_TOTAL }}
      state={{
        camera: 'unknown',
        microphone: 'unknown',
        notifications: 'unknown',
      }}
      onGrant={() => undefined}
      onContinue={() => undefined}
    />
  ),
}

export const PermissionsMixed: Story = {
  render: () => (
    <PermissionsStepView
      progress={{ current: 2, total: PROGRESS_TOTAL }}
      state={{
        camera: 'granted',
        microphone: 'requesting',
        notifications: 'denied',
      }}
      onGrant={() => undefined}
      onContinue={() => undefined}
    />
  ),
}

export const PermissionsAllGranted: Story = {
  render: () => (
    <PermissionsStepView
      progress={{ current: 2, total: PROGRESS_TOTAL }}
      state={{
        camera: 'granted',
        microphone: 'granted',
        notifications: 'granted',
      }}
      onGrant={() => undefined}
      onContinue={() => undefined}
    />
  ),
}

export const PermissionsInteractive: Story = {
  render: () => {
    function Demo() {
      const [state, setState] = useState<PermissionsState>({
        camera: 'unknown',
        microphone: 'unknown',
        notifications: 'unknown',
      })
      return (
        <PermissionsStepView
          progress={{ current: 2, total: PROGRESS_TOTAL }}
          state={state}
          onGrant={(id) =>
            setState((cur) => ({
              ...cur,
              [id]: cur[id] === 'granted' ? 'denied' : 'granted',
            }))
          }
          onContinue={() => undefined}
        />
      )
    }
    return <Demo />
  },
}

export const DisplayName: Story = {
  render: () => (
    <DisplayNameStep
      progress={{ current: 4, total: PROGRESS_TOTAL }}
      submitting={false}
      error={null}
      onSubmit={() => undefined}
    />
  ),
}

export const DisplayNameSubmitting: Story = {
  render: () => (
    <DisplayNameStep
      progress={{ current: 4, total: PROGRESS_TOTAL }}
      initialValue="Sam"
      submitting={true}
      error={null}
      onSubmit={() => undefined}
    />
  ),
}

export const DisplayNameError: Story = {
  render: () => (
    <DisplayNameStep
      progress={{ current: 4, total: PROGRESS_TOTAL }}
      initialValue="Sam"
      submitting={false}
      error="Could not save name."
      onSubmit={() => undefined}
    />
  ),
}

export const AddFriendInitial: Story = {
  render: () => (
    <AddFriendStepView
      progress={{ current: 5, total: PROGRESS_TOTAL }}
      justAdded={false}
      onAdd={() => undefined}
      onContinue={() => undefined}
    />
  ),
}

export const AddFriendPaired: Story = {
  render: () => (
    <AddFriendStepView
      progress={{ current: 5, total: PROGRESS_TOTAL }}
      justAdded={true}
      onAdd={() => undefined}
      onContinue={() => undefined}
    />
  ),
}

export const Tutorial: Story = {
  render: () => (
    <TutorialStep
      progress={{ current: 6, total: PROGRESS_TOTAL }}
      onContinue={() => undefined}
    />
  ),
}
