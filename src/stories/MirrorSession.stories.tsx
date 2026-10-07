import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'

import { MirrorSession } from '@/features/mirror/MirrorSession'
import type {
  BrowserConnection,
  BrowserConnectionState,
} from '@/features/mirror/browserConnection'
import type { MirrorSessionSnapshot } from '@/features/mirror/sessionBridge'
import { strings } from '@/strings'

const SELF = 'a'.repeat(64)
const ALICE = 'b'.repeat(64)
const BLAKE = 'c'.repeat(64)
const START = Date.UTC(2026, 9, 7, 12)
const snapshot: MirrorSessionSnapshot = {
  version: 1,
  sessionId: 'mirror-story-session',
  status: 'active',
  self: { edPubkeyHex: SELF, displayName: 'You' },
  startedAt: START,
  elapsedMs: 25 * 60_000,
  declaredTopic: 'Linear algebra',
  aiEnabled: true,
  aiAvailable: true,
  aiEnableNeedsConsent: false,
  aiStatus: 'paused',
  aiAction: null,
  peers: {
    alice: {
      peerId: 'alice',
      hasStream: false,
      ptt: false,
      reconnecting: false,
      edPubkeyHex: ALICE,
      displayName: 'Alice',
      joinedAt: START,
    },
    blake: {
      peerId: 'blake',
      hasStream: false,
      ptt: false,
      reconnecting: true,
      edPubkeyHex: BLAKE,
      displayName: 'Blake',
      joinedAt: START,
    },
  },
  names: { [SELF]: 'You', [ALICE]: 'Alice', [BLAKE]: 'Blake' },
  tiles: [
    {
      key: 'self:camera',
      peerId: null,
      name: 'You',
      local: true,
      variant: 'camera',
      state: 'focused',
      ptt: false,
      cameraOff: false,
    },
    {
      key: 'alice:camera',
      peerId: 'alice',
      name: 'Alice',
      local: false,
      variant: 'camera',
      state: 'connecting',
      ptt: false,
      cameraOff: false,
    },
    {
      key: 'blake:camera',
      peerId: 'blake',
      name: 'Blake',
      local: false,
      variant: 'camera',
      state: 'reconnecting',
      ptt: false,
      cameraOff: false,
    },
  ],
  hadAnyPeer: true,
  cameraOn: true,
  pttActive: false,
  screenSharing: false,
  audit: [
    {
      seq: 1,
      name: 'Alice',
      description: 'joined',
      ts: START,
      iconKind: 'joined',
    },
  ],
  notes: [
    {
      id: 'note-1',
      fromEdPubkeyHex: ALICE,
      mine: false,
      text: 'Ready for problem four?',
      ts: START,
    },
  ],
  images: [],
  chat: {
    directMessages: {},
    aiMessages: [],
    aiSending: false,
    directSending: false,
  },
  pomodoro: {
    phase: 'work-25',
    preset: '25/5',
    endsAt: Date.UTC(2029, 0, 1),
    iAmBroadcaster: true,
    broadcasterName: 'You',
  },
  warning: null,
  breakEndsAt: null,
  canInvite: true,
  sessionFull: false,
  friends: [
    {
      ed_pubkey_hex: 'd'.repeat(64),
      x_pubkey_hex: 'e'.repeat(64),
      display_name: 'Devin',
      paired_at: START,
      last_studied_with: null,
    },
  ],
  onlineFriends: ['d'.repeat(64)],
}

function connection(
  patch: Partial<BrowserConnectionState> = {}
): BrowserConnection {
  const state: BrowserConnectionState = {
    status: 'connected',
    snapshot,
    report: null,
    streams: {},
    error: null,
    ...patch,
  }
  return {
    getState: () => state,
    subscribe: () => () => {},
    pair: fn(async () => {}),
    sendControl: fn(),
    setCapture: fn(),
    disconnect: fn(),
  }
}

const meta = {
  title: 'Session/BrowserCompanion',
  component: MirrorSession,
  parameters: { layout: 'fullscreen' },
  args: { connection: connection() },
} satisfies Meta<typeof MirrorSession>
export default meta
type Story = StoryObj<typeof meta>

export const Connected: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole('button', {
        name: strings.session.camera.toggleAriaLabel,
      })
    )
    await expect(args.connection.sendControl).toHaveBeenCalledWith({
      type: 'camera',
      on: false,
    })
  },
}
export const OfflineReview: Story = {
  args: {
    connection: connection({
      status: 'disconnected',
      snapshot: { ...snapshot, offlineImagesOmitted: true },
    }),
  },
}
export const Pairing: Story = {
  args: { connection: connection({ status: 'pairing', snapshot: null }) },
}
export const PairingRateLimited: Story = {
  args: {
    connection: connection({
      status: 'pairing',
      snapshot: null,
      error: 'rate_limited',
    }),
  },
}
export const AnotherBrowserConnected: Story = {
  args: {
    connection: connection({
      status: 'pairing',
      snapshot: null,
      error: 'in_use',
    }),
  },
}
export const SessionMovedToAnotherTab: Story = {
  args: {
    connection: connection({
      status: 'disconnected',
      error: 'session_moved',
    }),
  },
}
export const ActionFailed: Story = {
  args: {
    connection: connection({
      snapshot: { ...snapshot, controlError: strings.mirror.imageSendFailed },
    }),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('alert')).toHaveTextContent(
      strings.mirror.imageSendFailed
    )
    await userEvent.click(
      canvas.getByRole('button', { name: strings.mirror.dismissError })
    )
    await expect(args.connection.sendControl).toHaveBeenCalledWith({
      type: 'dismiss_error',
    })
  },
}
export const InvalidSavedSnapshot: Story = {
  args: {
    connection: connection({
      status: 'disconnected',
      snapshot: { version: 1, notes: null },
    }),
  },
}
export const SavedReport: Story = {
  args: {
    connection: connection({
      status: 'disconnected',
      report: {
        session: {
          id: 'mirror-story-session',
          started_at: START,
          ended_at: START + 25 * 60_000,
          total_minutes: 25,
          peer_pubkeys: JSON.stringify([ALICE]),
          declared_topic: 'Linear algebra',
          score: null,
          focused_pct: null,
          generated_at: null,
          confident_samples: 0,
          skipped_samples: 0,
          ai_enabled: 0,
        },
        auditEvents: [],
        nameByEdPubkey: { [SELF]: 'You', [ALICE]: 'Alice' },
        myEdPubkeyHex: SELF,
      },
    }),
  },
}
export const ReportStorageUnavailable: Story = {
  args: {
    connection: connection({
      ...SavedReport.args?.connection?.getState(),
      reportCached: false,
    }),
  },
}
