import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { Toaster } from '@/components/ui/sonner'
import {
  AddFriendDialogView,
  type AddFriendMode,
  type AddFriendPhase,
  type AddFriendTab,
} from '@/features/friends/AddFriendDialogView'

// A representative (fake) ContactCard link so the QR renders in card stories.
const MOCK_CARD_LINK =
  'studyvis://add#AhESM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8AESIzRFVmd4iZBkFsaWNl' +
  'x1p2q3r4s5t6u7v8w9x0y1z2a3b4c5d6e7f8g9h0iJkLmNoPqRsTuVwXyZ012345'

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
  initialMode?: AddFriendMode
  phase: AddFriendPhase
  missingDisplayName: boolean
  myCardLink?: string | null
  cardBuildError?: boolean
}

function Harness({
  initialTab,
  initialMode = 'legacy',
  phase,
  missingDisplayName,
  myCardLink = MOCK_CARD_LINK,
  cardBuildError = false,
}: StoryArgs) {
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState<AddFriendTab>(initialTab)
  const [mode, setMode] = useState<AddFriendMode>(initialMode)
  return (
    <>
      <AddFriendDialogView
        open={open}
        onOpenChange={setOpen}
        mode={mode}
        onModeChange={setMode}
        tab={tab}
        onTabChange={setTab}
        phase={phase}
        missingDisplayName={missingDisplayName}
        myCardLink={myCardLink}
        cardBuildError={cardBuildError}
        onCopyCard={async () => true}
        onImportText={() => {
          // no-op for story
        }}
        onStartHost={() => {
          // no-op for story
        }}
        onJoinSubmit={() => {
          // no-op for story
        }}
        onCancel={() => setOpen(false)}
        onCopyLink={async () => true}
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

// The primary offline surface: your ContactCard (QR + copy) plus the import box.
export const CardSurface: Story = {
  args: {
    initialTab: 'host',
    initialMode: 'card',
    phase: { kind: 'idle' },
    missingDisplayName: false,
  },
}

export const CardBuilding: Story = {
  args: {
    initialTab: 'host',
    initialMode: 'card',
    phase: { kind: 'idle' },
    missingDisplayName: false,
    myCardLink: null,
  },
}

export const CardBuildError: Story = {
  args: {
    initialTab: 'host',
    initialMode: 'card',
    phase: { kind: 'idle' },
    missingDisplayName: false,
    cardBuildError: true,
  },
}

// Legacy 12-word live-pairing surface (reached via the "older StudyVis?" link).
export const PreState: Story = {
  args: {
    initialTab: 'host',
    initialMode: 'legacy',
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

export const HostWaitingForPeer: Story = {
  args: {
    initialTab: 'host',
    phase: { kind: 'host-waiting', words: MOCK_WORDS, peerArrived: false },
    missingDisplayName: false,
  },
}

export const HostPeerJoined: Story = {
  args: {
    initialTab: 'host',
    phase: { kind: 'host-waiting', words: MOCK_WORDS, peerArrived: true },
    missingDisplayName: false,
  },
}

export const HostStillWaiting: Story = {
  args: {
    initialTab: 'host',
    phase: {
      kind: 'host-waiting',
      words: MOCK_WORDS,
      peerArrived: false,
      longWait: true,
    },
    missingDisplayName: false,
  },
}

export const JoinForm: Story = {
  args: {
    initialTab: 'join',
    phase: { kind: 'idle' },
    missingDisplayName: false,
  },
}

export const JoinWaitingForPeer: Story = {
  args: {
    initialTab: 'join',
    phase: { kind: 'join-progress', peerArrived: false },
    missingDisplayName: false,
  },
}

export const JoinPeerJoined: Story = {
  args: {
    initialTab: 'join',
    phase: { kind: 'join-progress', peerArrived: true },
    missingDisplayName: false,
  },
}

export const JoinStillSearching: Story = {
  args: {
    initialTab: 'join',
    phase: { kind: 'join-progress', peerArrived: false, longWait: true },
    missingDisplayName: false,
  },
}

// F1 — network-trouble hint (blames the user's network, not the friend).
export const HostNetworkTrouble: Story = {
  args: {
    initialTab: 'host',
    phase: {
      kind: 'host-waiting',
      words: MOCK_WORDS,
      peerArrived: false,
      networkTrouble: true,
    },
    missingDisplayName: false,
  },
}

// F5 — peer arrived but no direct link formed (strict NAT, no TURN).
export const HostLinkStalled: Story = {
  args: {
    initialTab: 'host',
    phase: {
      kind: 'host-waiting',
      words: MOCK_WORDS,
      peerArrived: true,
      linkStalled: true,
    },
    missingDisplayName: false,
  },
}

export const JoinNetworkTrouble: Story = {
  args: {
    initialTab: 'join',
    phase: { kind: 'join-progress', peerArrived: false, networkTrouble: true },
    missingDisplayName: false,
  },
}

export const JoinLinkStalled: Story = {
  args: {
    initialTab: 'join',
    phase: { kind: 'join-progress', peerArrived: true, linkStalled: true },
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
