import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { Toaster } from '@/components/ui/sonner'
import {
  AddFriendDialogView,
  type AddFriendPhase,
  type AddFriendTab,
} from '@/features/friends/AddFriendDialogView'

const MOCK_WORDS = [
  'ocean',
  'ladder',
  'cinnamon',
  'trumpet',
  'cobalt',
  'hammock',
  'pine',
  'mirror',
  'quartz',
  'fountain',
  'pencil',
  'bridge',
]

type StoryArgs = {
  initialTab: AddFriendTab
  phase: AddFriendPhase
  missingDisplayName: boolean
}

function Harness({ initialTab, phase, missingDisplayName }: StoryArgs) {
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState<AddFriendTab>(initialTab)
  return (
    <>
      <AddFriendDialogView
        open={open}
        onOpenChange={setOpen}
        tab={tab}
        onTabChange={setTab}
        phase={phase}
        missingDisplayName={missingDisplayName}
        onStartHost={() => {
          // no-op for story
        }}
        onJoinSubmit={() => {
          // no-op for story
        }}
        onCancel={() => setOpen(false)}
        onCopyWords={async () => true}
      />
      <Toaster position="bottom-right" />
    </>
  )
}

const meta = {
  title: 'Features/AddFriendDialog',
  component: Harness,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Harness>

export default meta
type Story = StoryObj<typeof meta>

export const PreState: Story = {
  args: {
    initialTab: 'host',
    phase: { kind: 'idle' },
    missingDisplayName: false,
  },
}

export const MissingDisplayName: Story = {
  args: {
    initialTab: 'host',
    phase: { kind: 'idle' },
    missingDisplayName: true,
  },
}

export const HostInProgress: Story = {
  args: {
    initialTab: 'host',
    phase: { kind: 'host-waiting', words: MOCK_WORDS },
    missingDisplayName: false,
  },
}

export const JoinInProgress: Story = {
  args: {
    initialTab: 'join',
    phase: { kind: 'join-progress' },
    missingDisplayName: false,
  },
}

export const Success: Story = {
  args: {
    initialTab: 'host',
    phase: { kind: 'success', name: 'Alice' },
    missingDisplayName: false,
  },
}

export const Error: Story = {
  args: {
    initialTab: 'join',
    phase: {
      kind: 'error',
      message: "Couldn't reach your friend. Try again?",
    },
    missingDisplayName: false,
  },
}
