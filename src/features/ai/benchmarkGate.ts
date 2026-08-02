import type { ModelRecord } from './modelStore'

export type AiEnableReadiness =
  'loading' | 'error' | 'no-model' | 'unbenchmarked' | 'ready'

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
  const record = activeModelId ? records[activeModelId] : undefined
  if (!record || record.installedAt == null) return 'no-model'
  return record.benchmark ? 'ready' : 'unbenchmarked'
}
