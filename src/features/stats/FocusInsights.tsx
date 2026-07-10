// R7 — Cross-session focus-insights view. Pure presentational: takes a
// computed FocusInsights (see statsInsights.ts) so Storybook renders every
// shape (empty / sparse / populated) without a Tauri runtime. Hosted as a
// section inside the existing Stats Dashboard — no new route.
//
// All chart colors are CSS-variable token references so they re-theme with
// the active dark/light map (DESIGN-SYSTEM.md §2/§5) and no raw hex enters
// this file (scripts/check-tokens.ts). The trend line uses
// isAnimationActive={false}, consistent with the Dashboard's bar chart and
// the reduced-motion posture (no new motion site to gate).

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { Card } from '@/components/ui/card'
import { tokens } from '@/design/tokens'
import { strings } from '@/strings'

import type {
  FocusInsights as FocusInsightsData,
  TimingDistribution,
  TrendPoint,
} from './statsInsights'

export type FocusInsightsViewProps = {
  insights: FocusInsightsData
}

export function FocusInsights({ insights }: FocusInsightsViewProps) {
  const copy = strings.stats.insights
  return (
    <section className="flex flex-col gap-6" aria-label={copy.heading}>
      <h3 className="text-sm font-medium tracking-wide text-text-secondary uppercase">
        {copy.heading}
      </h3>

      {!insights.hasData ? (
        <Empty message={copy.empty} />
      ) : (
        <div className="flex flex-col gap-8">
          {insights.timing.total === 0 && insights.reasons.length === 0 ? (
            // Scored sessions but zero distractions: both sections would
            // show the same empty state, so one shared card covers them.
            <Empty message={copy.noDistractions} />
          ) : (
            <>
              <TimingSection timing={insights.timing} />
              <ReasonsSection reasons={insights.reasons} />
            </>
          )}
          <TrendSection trend={insights.trend} />
        </div>
      )}
    </section>
  )
}

function TimingSection({ timing }: { timing: TimingDistribution }) {
  const copy = strings.stats.insights.timing
  const rows: Array<{ key: keyof typeof copy.buckets; count: number }> = [
    { key: 'early', count: timing.early },
    { key: 'mid', count: timing.mid },
    { key: 'late', count: timing.late },
  ]
  const max = Math.max(1, timing.early, timing.mid, timing.late)
  return (
    <div className="flex flex-col gap-3">
      <SubHeading title={copy.heading} help={copy.help} />
      {timing.total === 0 ? (
        <Empty message={copy.empty} />
      ) : (
        <Card className="gap-3 py-4">
          <ul className="m-0 flex list-none flex-col gap-3 px-4">
            {rows.map((row) => (
              <li key={row.key} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-text-primary">
                    {copy.buckets[row.key]}
                  </span>
                  <span className="text-xs tabular-nums text-text-muted">
                    {copy.count(row.count)}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-bg-sunk">
                  <div
                    className="h-full rounded-full bg-accent-default"
                    style={{ width: `${(row.count / max) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function ReasonsSection({
  reasons,
}: {
  reasons: FocusInsightsData['reasons']
}) {
  const copy = strings.stats.insights.reasons
  return (
    <div className="flex flex-col gap-3">
      <SubHeading title={copy.heading} help={copy.help} />
      {reasons.length === 0 ? (
        <Empty message={copy.empty} />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {reasons.map((r) => (
            <li
              key={r.reasoning}
              className="flex items-start justify-between gap-3 rounded-md border border-border-subtle bg-bg-surface px-3 py-2 text-sm"
            >
              <span className="text-text-primary">{r.reasoning}</span>
              <span className="shrink-0 text-xs font-medium tabular-nums text-text-muted">
                {copy.count(r.count)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function TrendSection({ trend }: { trend: TrendPoint[] }) {
  const copy = strings.stats.insights.trend
  return (
    <div className="flex flex-col gap-3">
      <SubHeading title={copy.heading} help={copy.help} />
      {trend.length === 0 ? (
        <Empty message={copy.empty} />
      ) : (
        <Card className="gap-0 py-4">
          <div className="h-56 w-full px-2">
            <TrendChart trend={trend} />
          </div>
        </Card>
      )}
    </div>
  )
}

function TrendChart({ trend }: { trend: TrendPoint[] }) {
  const data = trend.map((p, i) => ({
    index: i + 1,
    focusedPct: p.focusedPct,
  }))
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart
        data={data}
        margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        accessibilityLayer
      >
        <CartesianGrid stroke="var(--border-subtle)" vertical={false} />
        <XAxis
          dataKey="index"
          interval="preserveStartEnd"
          minTickGap={24}
          tickLine={false}
          axisLine={{ stroke: 'var(--border-subtle)' }}
          tick={{ fill: 'var(--text-muted)', fontSize: tokens.font.size.xs }}
          tickMargin={6}
        />
        <YAxis
          width={36}
          domain={[0, 100]}
          allowDecimals={false}
          tickLine={false}
          axisLine={false}
          tick={{ fill: 'var(--text-muted)', fontSize: tokens.font.size.xs }}
        />
        <Tooltip
          cursor={{ stroke: 'var(--border-default)' }}
          content={<TrendTooltip />}
        />
        <Line
          type="monotone"
          dataKey="focusedPct"
          stroke="var(--accent-default)"
          strokeWidth={2}
          dot={{ fill: 'var(--accent-default)', r: 2 }}
          activeDot={{ r: 4 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

type TrendTooltipProps = {
  active?: boolean
  payload?: Array<{ payload: { index: number; focusedPct: number } }>
}

function TrendTooltip({ active, payload }: TrendTooltipProps) {
  if (!active || !payload || payload.length === 0) return null
  const point = payload[0].payload
  return (
    <div className="rounded-md border border-border-default bg-bg-raised px-3 py-2 text-xs shadow-md">
      <div className="text-text-secondary tabular-nums">
        {strings.stats.insights.trend.point(point.focusedPct)}
      </div>
    </div>
  )
}

function SubHeading({ title, help }: { title: string; help: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-medium text-text-primary">{title}</h4>
      <p className="text-xs text-text-muted">{help}</p>
    </div>
  )
}

function Empty({ message }: { message: string }) {
  return (
    <p className="rounded-md border border-dashed border-border-subtle bg-bg-surface px-3 py-3 text-sm text-text-secondary">
      {message}
    </p>
  )
}
