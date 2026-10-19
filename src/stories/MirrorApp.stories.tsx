import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import { useIdentityStore } from '@/stores/identityStore'
import { strings } from '@/strings'

import { MirrorApp } from '@/features/mirror/MirrorApp'
import { MirrorHome, type MirrorHomeProps } from '@/features/mirror/MirrorHome'
import {
  MirrorAppAccess,
  MirrorAppOwnerProvider,
} from '@/features/mirror/MirrorAppOwnerProvider'
import type {
  BrowserConnection,
  BrowserConnectionState,
} from '@/features/mirror/browserConnection'
import type { MirrorHomeData } from '@/features/mirror/homeBridge'

const app: NonNullable<BrowserConnectionState['appSnapshot']> = {
  version: 1,
  ownerEpoch: 'story-owner',
  revision: 1,
  replayGeneration: 'story-replay',
  replayNextSequence: 0,
  phase: 'home',
  identity: { edPubkeyHex: 'a'.repeat(64), displayName: 'Alice' },
  sessionActivationId: null,
  capabilities: [
    'home.read',
    'home.invite',
    'home.accept',
    'home.rejoin',
    'home.end_interrupted',
  ],
}
const home: MirrorHomeData = {
  friends: [
    {
      id: 'b'.repeat(64),
      displayName: 'Bob',
      presence: 'online',
      limited: false,
    },
    {
      id: 'c'.repeat(64),
      displayName: 'Charlie',
      presence: 'offline',
      limited: false,
    },
  ],
  invites: [
    { id: 'invite-story', displayName: 'Bob', expiresAt: Date.UTC(2029, 0, 1) },
  ],
  interrupted: null,
  aiEnabled: false,
  savePending: false,
  rejoinDeadline: null,
  rosterReady: true,
  totalFriends: 2,
  offset: 0,
}
function connection(): BrowserConnection {
  const state: BrowserConnectionState = {
    status: 'connected',
    snapshot: null,
    report: null,
    streams: {},
    error: null,
    appSnapshot: app,
  }
  return {
    getState: () => state,
    subscribe: () => () => {},
    pair: fn(async () => {}),
    sendControl: fn(),
    requestControl: fn(async () => false),
    requestApp: fn<BrowserConnection['requestApp']>(async (command) =>
      command === 'home.read'
        ? {
            version: 1,
            requestId: 'story-read',
            ownerEpoch: app.ownerEpoch,
            ok: true,
            value: home,
          }
        : {
            version: 1,
            requestId: 'story-unsupported',
            ownerEpoch: app.ownerEpoch,
            ok: false,
            error: 'unsupported',
          }
    ),
    setCapture: fn(),
    disconnect: fn(),
  }
}
const meta = {
  title: 'Features/MirrorApp',
  component: MirrorApp,
  parameters: { layout: 'fullscreen' },
  args: { connection: connection() },
} satisfies Meta<typeof MirrorApp>
export default meta
type Story = StoryObj<typeof meta>
export const Home: Story = {}
function topicFixture() {
  let state: BrowserConnectionState
  const listeners = new Set<(state: BrowserConnectionState) => void>()
  const requestApp = fn<BrowserConnection['requestApp']>(async () => ({
    version: 1,
    requestId: 'topic-read',
    ownerEpoch: state.appSnapshot!.ownerEpoch,
    ok: true,
    value: { ...home, aiEnabled: true },
  }))
  const reset = () => {
    state = {
      status: 'connected',
      snapshot: null,
      report: null,
      streams: {},
      error: null,
      appSnapshot: { ...app },
    }
    requestApp.mockClear()
  }
  reset()
  return {
    ...connection(),
    getState: () => state,
    subscribe: (listener: (state: BrowserConnectionState) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    requestApp,
    reset,
    changeOwner: () => {
      state = {
        ...state,
        appSnapshot: { ...app, ownerEpoch: 'different-owner' },
      }
      for (const listener of listeners) listener(state)
    },
  }
}
const topicConnection = topicFixture()
export const TopicOwnerChange: Story = {
  args: { connection: topicConnection },
  beforeEach: () => topicConnection.reset(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(
        canvas.getAllByRole('button', {
          name: strings.mirror.app.invite,
        }).length
      ).toBeGreaterThan(0)
    )
    await userEvent.click(
      canvas.getAllByRole('button', {
        name: strings.mirror.app.invite,
      })[0]
    )
    await body.findByRole('dialog', { name: strings.session.topicGate.title })
    topicConnection.changeOwner()
    await waitFor(() =>
      expect(body.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(
      topicConnection.requestApp.mock.calls.some(
        ([command]) => command === 'home.invite'
      )
    ).toBe(false)
  },
}
const props: MirrorHomeProps = {
  snapshot: app,
  data: home,
  connected: true,
  busy: false,
  error: null,
  onInvite: fn(),
  onAccept: fn(),
  onRejoin: fn(),
  onEndInterrupted: fn(),
  onPage: fn(),
}
export const Interrupted: Story = {
  render: () => (
    <MirrorHome
      {...props}
      data={{
        ...home,
        interrupted: {
          startedAt: Date.UTC(2026, 9, 1),
          topic: 'Organic chemistry',
        },
      }}
    />
  ),
}
export const SavePending: Story = {
  render: () => <MirrorHome {...props} data={{ ...home, savePending: true }} />,
}
export const Disconnected: Story = {
  render: () => <MirrorHome {...props} connected={false} />,
}
export const Loading: Story = {
  render: () => (
    <MirrorHome
      {...props}
      snapshot={{ ...app, phase: 'loading' }}
      data={null}
    />
  ),
}
export const IdentityError: Story = {
  render: () => (
    <MirrorHome
      {...props}
      snapshot={{ ...app, phase: 'identity_error', identity: null }}
      data={null}
    />
  ),
}
export const Onboarding: Story = {
  render: () => (
    <MirrorHome
      {...props}
      snapshot={{ ...app, phase: 'onboarding', identity: null }}
      data={null}
    />
  ),
}
export const DesktopAccess: Story = {
  beforeEach: () => {
    const previous = useIdentityStore.getState()
    useIdentityStore.setState({
      status: 'ready',
      identity: {
        version: 1,
        ed_pubkey_hex: 'a'.repeat(64),
        x_pubkey_hex: 'b'.repeat(64),
        display_name: 'Alice',
        created_at: 1,
        mnemonic_fingerprint: 'story',
      },
    })
    return () =>
      useIdentityStore.setState({
        identity: previous.identity,
        status: previous.status,
      })
  },
  render: () => (
    <MirrorAppOwnerProvider>
      <MirrorAppAccess />
    </MirrorAppOwnerProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const trigger = canvas.getByRole('button', {
      name: strings.mirror.app.open,
    })
    await userEvent.click(trigger)
    const dialog = await body.findByRole('dialog', {
      name: strings.mirror.app.title,
    })
    const consent = within(dialog).getByRole('switch', {
      name: strings.mirror.app.consent,
    })
    await expect(consent).not.toBeChecked()
    for (let i = 0; i < 3; i++) {
      await userEvent.tab()
      await expect(dialog).toContainElement(
        canvasElement.ownerDocument.activeElement as HTMLElement
      )
    }
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(body.queryByRole('dialog')).not.toBeInTheDocument()
    )
    await expect(trigger).toHaveFocus()
    await userEvent.click(trigger)
    await body.findByRole('dialog', { name: strings.mirror.app.title })
  },
}
