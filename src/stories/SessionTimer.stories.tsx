import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { SessionTimer } from '@/components/SessionTimer'
import type { PomodoroPreset } from '@/lib/pomodoro-types'

const NOW = Date.now()

const meta = {
  title: 'Components/SessionTimer',
  component: SessionTimer,
  parameters: { layout: 'centered' },
  args: {
    phase: 'idle',
    preset: null,
    endsAt: null,
    iAmBroadcaster: false,
    broadcasterName: null,
    onStart: () => {},
    onStop: () => {},
  },
} satisfies Meta<typeof SessionTimer>

export default meta
type Story = StoryObj<typeof meta>

export const Idle: Story = {}

export const ActiveWork25Self: Story = {
  args: {
    phase: 'work-25',
    preset: '25/5',
    endsAt: NOW + 18 * 60_000,
    iAmBroadcaster: true,
    broadcasterName: 'you',
  },
}

export const ActiveRest5Peer: Story = {
  args: {
    phase: 'rest-5',
    preset: '25/5',
    endsAt: NOW + 3 * 60_000,
    iAmBroadcaster: false,
    broadcasterName: 'Alice',
  },
}

export const ActiveWork50Peer: Story = {
  args: {
    phase: 'work-50',
    preset: '50/10',
    endsAt: NOW + 42 * 60_000,
    iAmBroadcaster: false,
    broadcasterName: 'Bo',
  },
}

// N5 — an active custom split (45/15). Labels as Focus/Break like the legacy
// presets; the exact minutes ride in the snapshot, not the phase name.
export const ActiveCustomSelf: Story = {
  args: {
    phase: 'work-custom',
    preset: 'custom',
    endsAt: NOW + 40 * 60_000,
    iAmBroadcaster: true,
    broadcasterName: 'you',
  },
}

// Interactive: start + stop locally so the popover flow can be exercised
// in Storybook without wiring the real controller.
export const Interactive: Story = {
  render: () => {
    const [phase, setPhase] = useState<
      | 'idle'
      | 'work-25'
      | 'rest-5'
      | 'work-50'
      | 'rest-10'
      | 'work-custom'
      | 'rest-custom'
    >('idle')
    const [preset, setPreset] = useState<PomodoroPreset | null>(null)
    const [endsAt, setEndsAt] = useState<number | null>(null)
    return (
      <SessionTimer
        phase={phase}
        preset={preset}
        endsAt={endsAt}
        iAmBroadcaster={phase !== 'idle'}
        broadcasterName={phase === 'idle' ? null : 'you'}
        onStart={(args) => {
          setPreset(args.preset)
          if (args.preset === 'custom') {
            setPhase('work-custom')
            setEndsAt(Date.now() + args.workMs)
            return
          }
          setPhase(args.preset === '25/5' ? 'work-25' : 'work-50')
          const work = args.preset === '25/5' ? 25 : 50
          setEndsAt(Date.now() + work * 60_000)
        }}
        onStop={() => {
          setPhase('idle')
          setPreset(null)
          setEndsAt(null)
        }}
      />
    )
  },
}
