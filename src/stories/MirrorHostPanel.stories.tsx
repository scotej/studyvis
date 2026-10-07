import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { MirrorHostPanel } from '@/features/mirror/MirrorHostPanel'

const config = {
  urls: ['https://192.168.1.12:8443/'],
  password: 'demo-pairing-password',
  fingerprint: 'abcd'.repeat(16),
  certificateUrl: 'http://192.168.1.12:8444/certificate.crt',
  expiresAt: Date.UTC(2029, 0, 1),
  generation: 'demo-generation',
}
const meta = {
  title: 'Session/BrowserCompanionHost',
  component: MirrorHostPanel,
  args: {
    config: null,
    starting: false,
    connected: false,
    takeover: false,
    onStart: fn(async () => {}),
    onStop: fn(async () => {}),
  },
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MirrorHostPanel>
export default meta
type Story = StoryObj<typeof meta>
export const Start: Story = {}
export const Pairing: Story = { args: { config } }
export const Connected: Story = {
  args: { config, connected: true, takeover: true },
}
export const Expired: Story = {
  args: { config: { ...config, expiresAt: 1 }, takeover: true },
}
export const Starting: Story = { args: { starting: true } }
