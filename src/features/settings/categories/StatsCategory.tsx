import { Dashboard } from '@/features/stats'

// Thin category wrapper, same shape as SessionsCategory → Report: the
// feature owns the data shell + render; the category just mounts it.
export function StatsCategory() {
  return <Dashboard />
}
