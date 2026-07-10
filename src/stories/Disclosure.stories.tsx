import type { Meta, StoryObj } from '@storybook/react-vite'

import { Disclosure } from '@/components/Disclosure'

const meta = {
  title: 'Components/Disclosure',
  component: Disclosure,
} satisfies Meta<typeof Disclosure>

export default meta
type Story = StoryObj<typeof meta>

// The settings-row variant (Settings → Network → Advanced connection
// settings): borderless summary inside a bordered row.
export const SettingsRowVariant: Story = {
  args: {
    className: 'border-b border-border-subtle py-4 last:border-b-0',
    summaryClassName: 'rounded-md',
    summary: (
      <span className="flex flex-col gap-1">
        <span className="text-sm font-medium text-text-primary">
          Advanced connection settings
        </span>
        <span className="text-xs text-text-secondary">
          Add your own relays. Most people never need these.
        </span>
      </span>
    ),
    children: (
      <p className="mt-4 text-sm text-text-secondary">Revealed content.</p>
    ),
  },
}

// The card variant (Settings → AI → model guide): the whole card is the
// disclosure, summary carries the card padding.
export const CardVariant: Story = {
  args: {
    className: 'rounded-lg border border-border-subtle bg-bg-surface',
    summaryClassName: 'rounded-lg p-6',
    summary: (
      <span className="flex flex-col gap-2">
        <span className="text-lg font-semibold tracking-tight text-text-primary">
          What model should I pick?
        </span>
        <span className="text-sm text-text-secondary">
          Smaller models run faster; bigger ones are more thorough.
        </span>
      </span>
    ),
    children: (
      <p className="p-6 pt-0 text-sm text-text-secondary">Revealed content.</p>
    ),
  },
}
