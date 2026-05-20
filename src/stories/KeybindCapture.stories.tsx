import type { Meta, StoryObj } from '@storybook/react-vite'
import { useCallback, useEffect, useRef, useState } from 'react'

import { KeybindCapture } from '@/components/KeybindCapture'
import {
  comboToAccelerator,
  DEFAULT_PTT_AI_COMBO,
  DEFAULT_PTT_FRIENDS_COMBO,
  type Combo,
  type Platform,
} from '@/lib/keybindings'

type HarnessProps = {
  initialCombo?: Combo
  otherCombo?: Combo
  platform?: Platform
  autoArm?: boolean
  // When set, after arming the harness dispatches this keydown so the story
  // captures a real (validated) combo — used by the Conflict story to land
  // on the inline "reserved" message.
  autoConflict?: {
    code: string
    metaKey?: boolean
    ctrlKey?: boolean
    altKey?: boolean
    shiftKey?: boolean
  }
}

function Harness({
  initialCombo = DEFAULT_PTT_FRIENDS_COMBO,
  otherCombo = DEFAULT_PTT_AI_COMBO,
  platform = 'mac',
  autoArm = false,
  autoConflict,
}: HarnessProps) {
  const [combo, setCombo] = useState<Combo>(initialCombo)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const handleCommit = useCallback(async (next: Combo) => {
    setCombo(next)
  }, [])

  useEffect(() => {
    if (!autoArm) return
    // Surface the "armed" visual state in the story without modifying the
    // component's public API. The button is the only interactive child of
    // KeybindCapture, so a single .click() is enough to arm capture.
    const button = rootRef.current?.querySelector('button')
    if (button instanceof HTMLButtonElement) button.click()
    if (autoConflict) {
      // Wait for KeybindCapture's effect to attach its document-level
      // keydown listener (one render + effect tick) before synthesising
      // the press, otherwise the dispatch lands before the listener.
      const id = window.setTimeout(() => {
        const evt = new KeyboardEvent('keydown', {
          code: autoConflict.code,
          metaKey: autoConflict.metaKey ?? false,
          ctrlKey: autoConflict.ctrlKey ?? false,
          altKey: autoConflict.altKey ?? false,
          shiftKey: autoConflict.shiftKey ?? false,
          bubbles: true,
        })
        document.dispatchEvent(evt)
      }, 50)
      return () => window.clearTimeout(id)
    }
  }, [autoArm, autoConflict])

  return (
    <div ref={rootRef} className="min-w-72">
      <KeybindCapture
        action="ptt-friends"
        combo={combo}
        otherCombo={otherCombo}
        otherAction="ptt-ai"
        platform={platform}
        onCommit={handleCommit}
      />
    </div>
  )
}

const meta = {
  title: 'Components/KeybindCapture',
  component: Harness,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Harness>

export default meta
type Story = StoryObj<typeof meta>

// Idle, mac glyphs: ⌘ [
export const IdleMac: Story = { args: { platform: 'mac' } }

// Idle, Windows/Linux: Ctrl [
export const IdleWindows: Story = { args: { platform: 'other' } }

// Armed — click is fired in useEffect so the focus ring + helper line render.
export const Armed: Story = { args: { platform: 'mac', autoArm: true } }

// Already captured a non-default combo (e.g. user rebound to ⌘.).
export const Captured: Story = {
  args: {
    platform: 'mac',
    initialCombo: {
      mod: true,
      ctrl: false,
      alt: false,
      shift: false,
      code: 'Period',
    },
  },
}

// Conflict: arms the capture and synthesises a reserved Ctrl+C press so the
// component's own validation rejects it and shows the inline error copy.
export const Conflict: Story = {
  args: {
    platform: 'other',
    autoArm: true,
    autoConflict: { code: 'KeyC', ctrlKey: true },
  },
}

// Side-by-side: dark + light theme rendering for the /style smoke check.
export const AcceleratorEcho: Story = {
  render: () => (
    <div className="flex flex-col gap-2 text-text-secondary">
      <span className="text-sm">
        Mac default accelerator:{' '}
        <code>{comboToAccelerator(DEFAULT_PTT_FRIENDS_COMBO)}</code>
      </span>
      <span className="text-sm">
        AI default accelerator:{' '}
        <code>{comboToAccelerator(DEFAULT_PTT_AI_COMBO)}</code>
      </span>
    </div>
  ),
}
