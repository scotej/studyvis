import { lazy, Suspense } from 'react'

import { SettingsSection } from '@/components/SettingsRow'
import { Skeleton } from '@/components/ui/skeleton'
import { strings } from '@/strings'

// Dashboard statically pulls recharts (the study-minutes chart plus
// FocusInsights) — a large vendor dep that no launch path renders. Lazy-load
// it so recharts lands in its own chunk fetched only when the Stats pane
// opens, keeping it out of the cold-start bundle.
const Dashboard = lazy(() =>
  import('@/features/stats/Dashboard').then((m) => ({ default: m.Dashboard }))
)

// Thin category wrapper, same shape as SessionsCategory → Report: the
// feature owns the data shell + render; the category just mounts it.
export function StatsCategory() {
  return (
    <Suspense fallback={<DashboardFallback />}>
      <Dashboard />
    </Suspense>
  )
}

// Shaped like the eventual dashboard (§10): the real heading, the two stat
// tiles, and the chart card. Only visible for the brief chunk fetch — the
// Dashboard's own loading/empty states take over once it mounts.
function DashboardFallback() {
  return (
    <SettingsSection heading={strings.stats.heading}>
      <div className="flex flex-col gap-8">
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
        </div>
        <Skeleton className="h-56 w-full rounded-lg" />
      </div>
    </SettingsSection>
  )
}
