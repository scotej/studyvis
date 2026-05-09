import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { Toaster } from '@/components/ui/sonner'
import {
  AddFriendDialogView,
  type AddFriendPhase,
  type AddFriendTab,
  type DisplayNamePhase,
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
  displayNamePhase: DisplayNamePhase
}

function Harness({ initialTab, phase, displayNamePhase }: StoryArgs) {
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
        displayNamePhase={displayNamePhase}
        onSetDisplayName={async () => {
          // no-op for story
        }}
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
    displayNamePhase: { kind: 'collected' },
  },
}

export const NeedsDisplayName: Story = {
  args: {
    initialTab: 'host',
    phase: { kind: 'idle' },
    displayNamePhase: {
      kind: 'collecting',
      submitting: false,
      error: null,
    },
  },
}

export const HostInProgress: Story = {
  args: {
    initialTab: 'host',
    phase: { kind: 'host-waiting', words: MOCK_WORDS },
    displayNamePhase: { kind: 'collected' },
  },
}

export const JoinInProgress: Story = {
  args: {
    initialTab: 'join',
    phase: { kind: 'join-progress' },
    displayNamePhase: { kind: 'collected' },
  },
}

export const Success: Story = {
  args: {
    initialTab: 'host',
    phase: { kind: 'success', name: 'Alice' },
    displayNamePhase: { kind: 'collected' },
  },
}

export const Error: Story = {
  args: {
    initialTab: 'join',
    phase: {
      kind: 'error',
      message: "Couldn't reach your friend. Try again?",
    },
    displayNamePhase: { kind: 'collected' },
  },
}
