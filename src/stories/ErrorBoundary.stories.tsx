import type { Meta, StoryObj } from '@storybook/react-vite'

import { ErrorBoundary } from '@/components/ErrorBoundary'

// A child that throws on render so the boundary shows its recovery fallback.
function Thrower(): never {
  throw new Error('storybook: simulated render fault')
}

const meta = {
  title: 'Components/ErrorBoundary',
  component: ErrorBoundary,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ErrorBoundary>

export default meta
type Story = StoryObj<typeof meta>

// The caught-fault fallback: calm message + "Try again" that remounts the
// subtree. This is what the user sees instead of a blank window.
export const Faulted: Story = {
  args: {
    children: <Thrower />,
  },
}

// Healthy passthrough — the boundary is invisible when nothing throws.
export const Healthy: Story = {
  args: {
    children: (
      <div className="p-8 text-sm text-text-secondary">
        Everything is fine — the boundary renders its children.
      </div>
    ),
  },
}
