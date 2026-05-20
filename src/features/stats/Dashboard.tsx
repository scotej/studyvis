// V3-P1 — Local stats dashboard (PLAN.md §5 V3, Settings → Stats).
//
// Splits like features/session/Report.tsx:
//   - `Dashboard`     — data-fetching shell. Reads the local sessions +
//                       friends tables, runs the pure transforms, owns
//                       loading / error / empty.
//   - `DashboardView` — pure presentational. Takes a StatsSummary so
//                       Storybook renders every shape (0 / 1 / 30+
//                       sessions) without a Tauri runtime.
//
// Everything is computed on-device from rows already persisted locally;
// nothing is transmitted (PLAN.md §4 principle 1, §6 non-goal "telemetry").

import { useCallback, useEffect, useState } from 'react'

import { SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { tokens } from '@/design/tokens'
import { listFriends, type Friend } from '@/lib/db/friends'
import { listSessions, type SessionRecord } from '@/lib/db/sessions'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { strings } from '@/strings'

import {
  computeStats,
  STREAK_MIN_MINUTES,
  TOP_PARTNERS_LIMIT,
  type DailyFocus,
  type StatsSummary,
} from './statsData'

export type DashboardLoader = () => Promise<{
  sessions: SessionRecord[]
  friends: Friend[]
}>

export type DashboardProps = {
  // Storybook / test hook so a story can drive the data path without
  // Tauri. Production omits it; the shell falls through to the live
  // sessions_list + friends_list invocations.
  __loader?: DashboardLoader
  // Injectable clock so the trailing-30-day window + streak grace are
  // deterministic in stories. Production uses Date.now().
  now?: number
}

type Status =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; summary: StatsSummary }

async function defaultLoader(): Promise<{
  sessions: SessionRecord[]
  friends: Friend[]
}> {
  const [sessions, friends] = await Promise.all([listSessions(), listFriends()])
  return { sessions, friends }
}

export function Dashboard({ __loader, now }: DashboardProps) {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [reloadKey, setReloadKey] = useState(0)
  const retry = useCallback(() => setReloadKey((k) => k + 1), [])

  useEffect(() => {
    let cancelled = false
    const loader = __loader ?? defaultLoader
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot load (re-armed by reloadKey on Retry); the loader awaits the Tauri commands before the productive setState (same suppression as SessionsCategory / Report).
    setStatus({ kind: 'loading' })
    loader()
      .then(({ sessions, friends }) => {
        if (cancelled) return
        setStatus({
          kind: 'ready',
          summary: computeStats(sessions, friends, now ?? Date.now()),
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setStatus({
          kind: 'error',
          message:
            err instanceof Error
              ? err.message
              : strings.stats.loadErrorFallback,
        })
      })
    return () => {
      cancelled = true
    }
  }, [__loader, now, reloadKey])

  if (status.kind === 'loading') {
    return (
      <SettingsSection heading={strings.stats.heading}>
        <div
          role="status"
          aria-label={strings.stats.loadingAriaLabel}
          className="flex flex-col gap-3 py-3"
        >
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-32 w-full" />
        </div>
      </SettingsSection>
    )
  }
  if (status.kind === 'error') {
    return (
      <SettingsSection heading={strings.stats.heading}>
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-dashed border-border-subtle bg-bg-surface px-3 py-3 text-sm text-text-muted"
        >
          <span>{status.message}</span>
          <Button variant="ghost" size="sm" onClick={retry}>
            {strings.common.actions.retry}
          </Button>
        </div>
      </SettingsSection>
    )
  }
  return <DashboardView summary={status.summary} />
}

export type DashboardViewProps = {
  summary: StatsSummary
}

export function DashboardView({ summary }: DashboardViewProps) {
  const { totalSessions, daily, streak, partners, score } = summary
  const topPartners = partners.slice(0, TOP_PARTNERS_LIMIT)

  return (
    <SettingsSection heading={strings.stats.heading}>
      <p className="pb-4 text-xs text-text-muted">{strings.stats.disclaimer}</p>

      {totalSessions === 0 ? (
        <Empty message={strings.stats.empty} />
      ) : (
        <div className="flex flex-col gap-8">
          <div className="grid grid-cols-2 gap-4">
            <StatTile
              value={String(streak)}
              unit={strings.stats.streak.unit(streak)}
              label={strings.stats.streak.label}
              help={strings.stats.streak.help(STREAK_MIN_MINUTES)}
            />
            <StatTile
              value={score.average == null ? '—' : String(score.average)}
              unit={score.average == null ? '' : strings.stats.avgScore.unit}
              label={strings.stats.avgScore.label}
              help={
                score.scoredSessions === 0
                  ? strings.stats.avgScore.helpNoScores
                  : strings.stats.avgScore.help(score.scoredSessions)
              }
            />
          </div>

          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-medium tracking-tight text-text-secondary uppercase">
              {strings.stats.focused.heading}
            </h3>
            <Card className="gap-0 py-4">
              <div className="h-56 w-full px-2">
                <FocusChart daily={daily} />
              </div>
            </Card>
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-medium tracking-tight text-text-secondary uppercase">
              {strings.stats.partners.heading}
            </h3>
            {topPartners.length === 0 ? (
              <Empty message={strings.stats.partners.empty} />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {topPartners.map((p) => (
                  <li
                    key={p.edPubkeyHex}
                    className="flex items-center justify-between gap-3 rounded-md border border-border-subtle bg-bg-surface px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate text-text-primary">
                      {p.name}
                    </span>
                    <span className="shrink-0 text-xs font-medium tabular-nums text-text-muted">
                      {strings.stats.partners.sessions(p.sessions)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </SettingsSection>
  )
}

function StatTile({
  value,
  unit,
  label,
  help,
}: {
  value: string
  unit: string
  label: string
  help: string
}) {
  return (
    <Card className="gap-2 py-4">
      <div className="flex flex-col gap-1 px-4">
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-semibold tracking-tight text-text-primary tabular-nums">
            {value}
          </span>
          {unit ? (
            <span className="text-sm text-text-secondary">{unit}</span>
          ) : null}
        </div>
        <span className="text-sm font-medium text-text-primary">{label}</span>
        <span className="text-xs text-text-muted">{help}</span>
      </div>
    </Card>
  )
}

// Colors are passed as CSS-variable references so the chart re-themes with
// the active dark/light token map (DESIGN-SYSTEM.md §2/§5) and no raw hex
// enters this file (house rule / scripts/check-tokens.ts).
function FocusChart({ daily }: { daily: DailyFocus[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={daily}
        margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        accessibilityLayer
      >
        <CartesianGrid stroke="var(--border-subtle)" vertical={false} />
        <XAxis
          dataKey="label"
          interval="preserveStartEnd"
          minTickGap={24}
          tickLine={false}
          axisLine={{ stroke: 'var(--border-subtle)' }}
          tick={{ fill: 'var(--text-muted)', fontSize: tokens.font.size.xs }}
          tickMargin={6}
        />
        <YAxis
          width={32}
          allowDecimals={false}
          tickLine={false}
          axisLine={false}
          tick={{ fill: 'var(--text-muted)', fontSize: tokens.font.size.xs }}
        />
        <Tooltip
          cursor={{ fill: 'var(--bg-raised)', fillOpacity: 0.5 }}
          content={<FocusTooltip />}
        />
        <Bar
          dataKey="minutes"
          fill="var(--accent-default)"
          radius={[tokens.radius.sm, tokens.radius.sm, 0, 0]}
          maxBarSize={16}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}

type FocusTooltipProps = {
  active?: boolean
  payload?: Array<{ payload: DailyFocus }>
}

function FocusTooltip({ active, payload }: FocusTooltipProps) {
  if (!active || !payload || payload.length === 0) return null
  const point = payload[0].payload
  return (
    <div className="rounded-md border border-border-default bg-bg-raised px-3 py-2 text-xs shadow-md">
      <div className="font-medium text-text-primary">{point.day}</div>
      <div className="text-text-secondary tabular-nums">
        {strings.stats.focused.minutes(point.minutes)}
      </div>
    </div>
  )
}

function Empty({ message }: { message: string }) {
  return (
    <p className="rounded-md border border-dashed border-border-subtle bg-bg-surface px-3 py-3 text-sm text-text-muted">
      {message}
    </p>
  )
}
