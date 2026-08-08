import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'

import { SessionsCategoryView } from '@/features/settings/categories/SessionsCategoryView'
import type { SessionRecord } from '@/lib/db/sessions'
import { strings } from '@/strings'

const STARTED_AT = Date.UTC(2026, 7, 4, 18, 1, 0)

const sessions = [
  {
    id: 'recent-session',
    started_at: STARTED_AT,
    ended_at: STARTED_AT + 41 * 60_000,
    total_minutes: 41,
    peer_pubkeys: JSON.stringify(['a'.repeat(64)]),
    declared_topic: 'Cell biology',
    score: 92,
    focused_pct: 0.92,
    generated_at: STARTED_AT + 41 * 60_000,
    confident_samples: 12,
    skipped_samples: 0,
    ai_enabled: 1,
  },
  {
    // An older or interrupted row may lack every optional field. It must still
    // offer its local report instead of hiding history the user may need.
    id: 'partial-session',
    started_at: null,
    ended_at: null,
    total_minutes: null,
    peer_pubkeys: null,
    declared_topic: null,
    score: null,
    focused_pct: null,
    generated_at: null,
    confident_samples: null,
    skipped_samples: null,
    ai_enabled: null,
  },
  {
    // Shares the previous row's unavailable timestamp. The action labels
    // remain distinct without exposing a session ID.
    id: 'second-partial-session',
    started_at: null,
    ended_at: null,
    total_minutes: null,
    peer_pubkeys: null,
    declared_topic: null,
    score: null,
    focused_pct: null,
    generated_at: null,
    confident_samples: null,
    skipped_samples: null,
    ai_enabled: null,
  },
  {
    // This starts in the same displayed minute as the most recent row.
    id: 'same-minute-session',
    started_at: STARTED_AT + 30_000,
    ended_at: STARTED_AT + 8 * 60_000,
    total_minutes: 8,
    peer_pubkeys: JSON.stringify([]),
    declared_topic: null,
    score: null,
    focused_pct: null,
    generated_at: null,
    confident_samples: null,
    skipped_samples: null,
    ai_enabled: 0,
  },
] satisfies readonly SessionRecord[]

const meta = {
  title: 'Features/Settings/Sessions',
  component: SessionsCategoryView,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-3xl rounded-lg border border-border-subtle bg-bg-base px-8 py-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SessionsCategoryView>

export default meta
type Story = StoryObj<typeof meta>

export const WithHistory: Story = {
  args: {
    sessions,
    status: 'ready',
    onRetry: fn(),
    onOpenSession: fn(),
    onDelete: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const reportButtons = canvas.getAllByRole('button', {
      name: /^View report for session /,
    })
    await expect(reportButtons).toHaveLength(sessions.length)
    await expect([
      ...new Set(
        reportButtons.map((button) => button.getAttribute('aria-label'))
      ),
    ]).toHaveLength(sessions.length)
    await expect(
      canvas.getAllByText(strings.settings.sessions.meta.unknown)
    ).toHaveLength(2)

    for (const [index, session] of sessions.entries()) {
      reportButtons[index]!.focus()
      await userEvent.keyboard('{Enter}')
      await expect(args.onOpenSession).toHaveBeenNthCalledWith(
        index + 1,
        session.id
      )
    }
    await expect(args.onDelete).not.toHaveBeenCalled()

    await userEvent.click(
      canvas.getAllByRole('button', { name: /^Delete session / })[0]!
    )
    await expect(args.onDelete).toHaveBeenCalledWith(
      sessions[0],
      canvas.getAllByRole('button', { name: /^Delete session / })[0]
    )
  },
}

export const ReturnFocusAfterReport: Story = {
  args: {
    sessions,
    status: 'ready',
    focusSessionId: 'recent-session',
    onFocusRestored: fn(),
    onRetry: fn(),
    onOpenSession: fn(),
    onDelete: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const firstReportButton = within(canvasElement).getByRole('button', {
      name: /^View report for session 1 /,
    })
    await waitFor(() => expect(firstReportButton).toHaveFocus())
    await expect(args.onFocusRestored).toHaveBeenCalledTimes(1)
  },
}

export const ReturnFocusWhileLoading: Story = {
  args: {
    sessions: [],
    status: 'loading',
    focusSessionId: 'recent-session',
    onFocusRestored: fn(),
    onRetry: fn(),
    onOpenSession: fn(),
    onDelete: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const sessionsHeading = within(canvasElement).getByRole('heading', {
      name: strings.settings.sessions.heading,
    })
    await waitFor(() => expect(sessionsHeading).toHaveFocus())
    await expect(args.onFocusRestored).not.toHaveBeenCalled()
  },
}

export const Empty: Story = {
  args: {
    sessions: [],
    status: 'ready',
    onRetry: fn(),
    onOpenSession: fn(),
    onDelete: fn(),
  },
}

export const Loading: Story = {
  args: {
    sessions: [],
    status: 'loading',
    onRetry: fn(),
    onOpenSession: fn(),
    onDelete: fn(),
  },
}

export const LoadError: Story = {
  args: {
    sessions: [],
    status: 'error',
    error: strings.settings.sessions.loadErrorHelp,
    onRetry: fn(),
    onOpenSession: fn(),
    onDelete: fn(),
  },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', {
        name: strings.common.actions.retry,
      })
    )
    await expect(args.onRetry).toHaveBeenCalledTimes(1)
  },
}
