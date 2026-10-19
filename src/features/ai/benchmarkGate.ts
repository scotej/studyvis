import type { ModelRecord } from './modelStore'
import { isBenchmarkStale } from './benchmark'
import { getModelUnavailableReason } from './models'

export type AiEnableReadiness =
  'loading' | 'error' | 'unavailable' | 'no-model' | 'unbenchmarked' | 'ready'

export type AiEnableReadinessInput = {
  status: 'loading' | 'ready' | 'error'
  activeModelId: string | null
  records: Record<string, ModelRecord>
}

export function getAiEnableReadiness({
  status,
  activeModelId,
  records,
}: AiEnableReadinessInput): AiEnableReadiness {
  if (status === 'loading') return 'loading'
  if (status === 'error') return 'error'
  if (getModelUnavailableReason(activeModelId)) return 'unavailable'
  const record = activeModelId ? records[activeModelId] : undefined
  if (!record || record.installedAt == null) return 'no-model'
  return record.benchmark && !isBenchmarkStale(record.benchmark)
    ? 'ready'
    : 'unbenchmarked'
}
