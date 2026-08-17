import type { Meta, StoryObj } from '@storybook/react-vite'

import { TitleBar } from '@/components/TitleBar'

// V3-P6 — Drift check for the opt-in custom titlebar. The Storybook
// toolbar (`.storybook/preview.tsx`) flips between dark and light themes
// for free; this file enumerates all three release-matrix desktop platforms
// (shipped macOS/Windows plus the Linux candidate) and the
// maximized-vs-restored visual swap.

const meta = {
  title: 'Components/TitleBar',
  component: TitleBar,
  parameters: { layout: 'fullscreen' },
  args: {
    // No-op so the buttons render without trying to talk to Tauri.
    // Real wiring is in `TitleBar.tsx`'s default branch which awaits
    // `getCurrentWindow().minimize()` etc.
    onControl: () => undefined,
  },
} satisfies Meta<typeof TitleBar>

export default meta
type Story = StoryObj<typeof meta>

// `min-h-32` keeps the band visible against a generous app-canvas swatch so
// the drag region's border-bottom is verifiable against `bg-bg-base`.

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-32 flex-col">
      {children}
      <div className="flex flex-1 items-center justify-center bg-bg-base text-text-secondary">
        <span className="text-xs">app canvas</span>
      </div>
    </div>
  )
}

export const Mac: Story = {
  args: { platform: 'mac' },
  render: (args) => (
    <Frame>
      <TitleBar {...args} />
    </Frame>
  ),
}

export const Windows: Story = {
  args: { platform: 'windows' },
  render: (args) => (
    <Frame>
      <TitleBar {...args} />
    </Frame>
  ),
}

export const Linux: Story = {
  args: { platform: 'linux' },
  render: (args) => (
    <Frame>
      <TitleBar {...args} />
    </Frame>
  ),
}

export const WindowsMaximized: Story = {
  args: { platform: 'windows', forceMaximized: true },
  render: (args) => (
    <Frame>
      <TitleBar {...args} />
    </Frame>
  ),
}

// Side-by-side comparison so a reviewer can spot drift between all three
// platforms in one screenshot. Useful when validating that the wordmark
// vertical centre and chrome band height stay aligned across the macOS overlay
// inset and the Windows/Linux control clusters.
export const AllPlatforms: Story = {
  render: () => (
    <div className="flex flex-col gap-6 p-6">
      <div className="overflow-hidden rounded-md border border-border-default">
        <Frame>
          <TitleBar platform="mac" onControl={() => undefined} />
        </Frame>
      </div>
      <div className="overflow-hidden rounded-md border border-border-default">
        <Frame>
          <TitleBar platform="windows" onControl={() => undefined} />
        </Frame>
      </div>
      <div className="overflow-hidden rounded-md border border-border-default">
        <Frame>
          <TitleBar platform="linux" onControl={() => undefined} />
        </Frame>
      </div>
      <div className="overflow-hidden rounded-md border border-border-default">
        <Frame>
          <TitleBar
            platform="windows"
            forceMaximized
            onControl={() => undefined}
          />
        </Frame>
      </div>
    </div>
  ),
}
