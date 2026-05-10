import type { Meta, StoryObj } from '@storybook/react-vite'

import { OnboardingStep } from '@/components/OnboardingStep'

const meta = {
  title: 'Components/OnboardingStep',
  component: OnboardingStep,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof OnboardingStep>

export default meta
type Story = StoryObj<typeof meta>

const sampleContent = (
  <div className="flex flex-col items-center gap-3 text-center">
    <h1 className="text-2xl font-semibold tracking-tight">Step content</h1>
    <p className="max-w-md text-sm leading-snug text-text-secondary">
      Whatever this step needs to say to the user goes here.
    </p>
  </div>
)

export const PrimaryOnly: Story = {
  args: {
    children: sampleContent,
    primaryAction: { label: 'Continue', onClick: () => undefined },
  },
}

export const PrimaryAndSecondary: Story = {
  args: {
    children: sampleContent,
    primaryAction: { label: 'Continue', onClick: () => undefined },
    secondaryAction: { label: 'Skip', onClick: () => undefined },
  },
}

export const WithProgress: Story = {
  args: {
    children: sampleContent,
    progress: { current: 3, total: 6 },
    primaryAction: { label: 'Continue', onClick: () => undefined },
  },
}

export const PrimaryDisabled: Story = {
  args: {
    children: sampleContent,
    progress: { current: 1, total: 6 },
    primaryAction: {
      label: 'Continue',
      onClick: () => undefined,
      disabled: true,
    },
  },
}
