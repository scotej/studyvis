import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { MirrorHostPanel } from '@/features/mirror/MirrorHostPanel'
import { strings } from '@/strings'

const config = {
  urls: ['https://192.168.1.12:8443/', 'https://127.0.0.1:8443/'],
  password: 'demo-pairing-password',
  fingerprint: 'abcd'.repeat(16),
  certificateUrl: 'http://192.168.1.12:8444/certificate.crt',
  certificateUrls: ['http://192.168.1.12:8444/certificate.crt'],
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
export const MultipleInterfaces: Story = {
  args: {
    config: {
      ...config,
      urls: ['https://10.0.0.4:8443', 'https://192.168.1.12:8443'],
      certificateUrl: 'http://10.0.0.4:8444/certificate.crt',
      certificateUrls: [
        'http://10.0.0.4:8444/certificate.crt',
        'http://192.168.1.12:8444/certificate.crt',
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const links = canvas.getAllByRole('textbox', { name: strings.mirror.link })
    await expect(links).toHaveLength(1)
    await expect(links[0]).toHaveValue('https://10.0.0.4:8443')
    await expect(
      canvas.queryByRole('textbox', {
        name: strings.mirror.certificateDownload,
      })
    ).not.toBeInTheDocument()
  },
}
export const CertificateSetup: Story = {
  args: { config },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText(strings.mirror.certificateSetup))
  },
}
export const Connected: Story = {
  args: { config, connected: true, takeover: true },
}
export const Expired: Story = {
  args: { config: { ...config, expiresAt: 1 }, takeover: true },
}
export const Starting: Story = { args: { starting: true } }
