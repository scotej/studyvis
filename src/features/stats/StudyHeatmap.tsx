// #99 — Year-at-a-glance study calendar (the Anki / GitHub contribution
// grid), hosted as a section inside the Stats dashboard. Pure presentational:
// it takes a computed StudyHeatmap (see statsData.buildStudyHeatmap) so
// Storybook renders every shape without a Tauri runtime, matching the
// FocusInsights split.
//
// Accessibility: the squares are one image, not 371 focus stops — the grid
// carries role="img" with a summary label, and every number the colour
// encodes is repeated as text in the strip below it, so nothing here is
// conveyed by colour alone (DESIGN-SYSTEM §7). Each square keeps a native
// `title` for the pointer path.
//
// All colour comes from the accent token at four opacities, so the scale
// re-themes with the active light/dark map and no raw hex enters this file
// (scripts/check-tokens.ts).

import { Card } from '@/components/ui/card'
import { strings } from '@/strings'

import {
  HEATMAP_LEVEL_MINUTES,
  type HeatmapLevel,
  type StudyHeatmap as StudyHeatmapData,
} from './statsData'

export type StudyHeatmapProps = {
  heatmap: StudyHeatmapData
}

const MINUTES_PER_HOUR = 60

// Index = level. Level 0 is the empty-day well, not a faint accent: a day
// with no study should read as absence, not as a small amount.
const LEVEL_CLASS: Record<HeatmapLevel, string> = {
  0: 'bg-bg-sunk',
  1: 'bg-accent-default/25',
  2: 'bg-accent-default/50',
  3: 'bg-accent-default/75',
  4: 'bg-accent-default',
}

// Row indices (0 = Sunday) that carry a printed weekday label. Three of seven
// is the density GitHub settled on — enough to orient, few enough to stay
// legible against 10px rows.
const WEEKDAY_LABELS: Record<number, string> = {
  1: strings.stats.heatmap.weekdays.monday,
  3: strings.stats.heatmap.weekdays.wednesday,
  5: strings.stats.heatmap.weekdays.friday,
}

export function StudyHeatmap({ heatmap }: StudyHeatmapProps) {
  const copy = strings.stats.heatmap
  const { weeks, months, daysStudied, daysInWindow, totalMinutes } = heatmap
  const hours = Math.round(totalMinutes / MINUTES_PER_HOUR)

  return (
    <section className="flex flex-col gap-3" aria-label={copy.heading}>
      <h3 className="text-sm font-medium tracking-wide text-text-secondary uppercase">
        {copy.heading}
      </h3>
      {daysStudied === 0 ? (
        <p className="rounded-md border border-dashed border-border-subtle bg-bg-surface px-3 py-3 text-sm text-text-secondary">
          {copy.empty}
        </p>
      ) : (
        <Card className="gap-4 py-4">
          <div className="flex flex-col gap-4 px-4">
            <p className="text-xs text-text-muted">{copy.help}</p>
            {/* The grid is wider than the settings pane on a narrow window;
                scroll it rather than shrinking squares below a clickable,
                legible size. */}
            <div className="overflow-x-auto">
              <div
                role="img"
                aria-label={copy.ariaLabel(daysStudied, daysInWindow)}
                className="flex w-fit gap-1"
              >
                <WeekdayGutter />
                {/* pr-6 reserves room for the last month label, which is
                    absolutely placed and so contributes no scroll width of
                    its own — without it the final "Jul" is clipped. */}
                <div className="flex flex-col gap-1 pr-6">
                  <MonthRow months={months} weekCount={weeks.length} />
                  <div className="flex gap-0.5">
                    {weeks.map((week, w) => (
                      <div key={w} className="flex flex-col gap-0.5">
                        {week.map((cell, d) =>
                          cell === null ? (
                            <div key={d} className="size-2.5" />
                          ) : (
                            <div
                              key={d}
                              title={copy.cell(cell.day, cell.minutes)}
                              className={`size-2.5 rounded-sm ${LEVEL_CLASS[cell.level]}`}
                            />
                          )
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <Legend />
            <StatStrip
              daysStudied={daysStudied}
              daysInWindow={daysInWindow}
              hours={hours}
              longestStreak={heatmap.longestStreak}
            />
          </div>
        </Card>
      )}
    </section>
  )
}

// Weekday names sit in their own column so they can't push the grid's rows out
// of alignment: each label row is one square TALL (so the rows stay in step
// with the grid's) but wide enough to hold three characters, since a label
// overflowing to the left of the scroll container would be clipped, not
// scrolled to. pt-4 clears the month row above the grid.
function WeekdayGutter() {
  return (
    <div className="flex flex-col gap-0.5 pt-4 pr-1" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5, 6].map((row) => (
        <div key={row} className="relative h-2.5 w-8">
          {WEEKDAY_LABELS[row] ? (
            <span className="absolute top-0 right-0 text-xs leading-none whitespace-nowrap text-text-muted">
              {WEEKDAY_LABELS[row]}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  )
}

// One slot per week column, so a label lands exactly above the week its month
// opens in. Labels are wider than a 10px slot, so each is absolutely placed
// inside its slot and allowed to overflow to the right — months are ~4.3
// columns apart, which is more than enough room for three characters.
function MonthRow({
  months,
  weekCount,
}: {
  months: StudyHeatmapData['months']
  weekCount: number
}) {
  const labelByWeek = new Map(months.map((m) => [m.weekIndex, m.label]))
  return (
    <div className="flex h-4 gap-0.5" aria-hidden="true">
      {Array.from({ length: weekCount }, (_, w) => (
        <div key={w} className="relative w-2.5 shrink-0">
          {labelByWeek.has(w) ? (
            <span className="absolute top-0 left-0 text-xs leading-none whitespace-nowrap text-text-muted">
              {labelByWeek.get(w)}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function Legend() {
  const copy = strings.stats.heatmap.legend
  const levels: HeatmapLevel[] = [0, 1, 2, 3, 4]
  return (
    <div className="flex items-center gap-2 text-xs text-text-muted">
      <span>{copy.less}</span>
      <div className="flex gap-0.5" aria-hidden="true">
        {levels.map((level) => (
          <div
            key={level}
            title={legendTitle(level)}
            className={`size-2.5 rounded-sm ${LEVEL_CLASS[level]}`}
          />
        ))}
      </div>
      <span>{copy.more}</span>
    </div>
  )
}

function legendTitle(level: HeatmapLevel): string {
  const copy = strings.stats.heatmap.legend
  if (level === 0) return copy.none
  const from = HEATMAP_LEVEL_MINUTES[level - 1]
  const next = HEATMAP_LEVEL_MINUTES[level]
  return copy.level(from, next === undefined ? null : next - 1)
}

// Same value / label / help stack as the Dashboard's StatTile, without its
// Card chrome — these three sit inside the heatmap card, under its own rule.
function StatStrip({
  daysStudied,
  daysInWindow,
  hours,
  longestStreak,
}: {
  daysStudied: number
  daysInWindow: number
  hours: number
  longestStreak: number
}) {
  const copy = strings.stats.heatmap.stats
  return (
    <div className="grid grid-cols-3 gap-4 border-t border-border-subtle pt-4">
      <Stat
        value={String(daysStudied)}
        label={copy.daysStudied}
        help={copy.daysStudiedOf(daysInWindow)}
      />
      <Stat
        value={`${hours} ${copy.hoursUnit(hours)}`}
        label={copy.hours}
        help={copy.hoursHelp}
      />
      <Stat
        value={`${longestStreak} ${copy.days(longestStreak)}`}
        label={copy.longestStreak}
        help={copy.longestStreakHelp}
      />
    </div>
  )
}

function Stat({
  value,
  label,
  help,
}: {
  value: string
  label: string
  help: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-lg font-semibold tracking-tight text-text-primary tabular-nums">
        {value}
      </span>
      <span className="text-sm font-medium text-text-primary">{label}</span>
      <span className="text-xs text-text-muted">{help}</span>
    </div>
  )
}
