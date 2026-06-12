import type { Meta, StoryObj } from '@storybook/react-vite'

import { IdentityChoiceStep } from '@/features/onboarding/IdentityChoiceStep'

const noop = () => undefined

const meta = {
  title: 'Features/Onboarding/IdentityChoice',
  component: IdentityChoiceStep,
  parameters: { layout: 'fullscreen' },
  args: {
    progress: { current: 3, total: 6 },
    onCreate: noop,
    onRecover: noop,
  },
} satisfies Meta<typeof IdentityChoiceStep>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

// U3 — the choice fork carries a [Back] to the previous onboarding step.
export const WithBack: Story = {
  args: { onBack: noop },
}
