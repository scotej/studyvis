import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { Toaster } from '@/components/ui/sonner'
import {
  ContactImportView,
  type ContactImportOutcome,
} from '@/features/friends/ContactImportView'

type StoryArgs = {
  outcome: ContactImportOutcome
}

function Harness({ outcome }: StoryArgs) {
  const [open, setOpen] = useState(true)
  const [acked, setAcked] = useState(false)
  return (
    <>
      <ContactImportView
        open={open}
        onOpenChange={setOpen}
        outcome={outcome}
        acked={acked}
        onAckChange={setAcked}
        saving={false}
        onConfirm={() => setOpen(false)}
        onCancel={() => setOpen(false)}
      />
      <Toaster position="bottom-right" />
    </>
  )
}

const meta = {
  title: 'Features/ContactImport',
  component: Harness,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Harness>

export default meta
type Story = StoryObj<typeof meta>

const FINGERPRINT = '48213 90271 33518 07642'

// Remote (paste/link) path: the safety number must be affirmed before Add.
export const ConfirmRemote: Story = {
  args: {
    outcome: {
      kind: 'confirm',
      name: 'Alice',
      shortId: 'a1b2c3d4',
      fingerprint: FINGERPRINT,
      requireAck: true,
    },
  },
}

// In-person QR path: safety number shown but Add is enabled without the check.
export const ConfirmQr: Story = {
  args: {
    outcome: {
      kind: 'confirm',
      name: 'Alice',
      shortId: 'a1b2c3d4',
      fingerprint: FINGERPRINT,
      requireAck: false,
    },
  },
}

export const Added: Story = {
  args: { outcome: { kind: 'added', name: 'Alice' } },
}

export const SelfCardError: Story = {
  args: {
    outcome: {
      kind: 'error',
      message: "That's your own code — share it with a friend instead.",
    },
  },
}

export const TamperError: Story = {
  args: {
    outcome: {
      kind: 'error',
      message:
        'This code looks damaged or altered. Ask your friend to send it again.',
    },
  },
}
