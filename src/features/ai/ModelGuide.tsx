// "What model should I pick?" — the in-app guide referenced from the
// picker and from Settings → AI. Renders the ARCHITECTURE.md §8 table plus
// the user's measured speeds when available.

import { strings } from '@/strings'

import {
  SUPPORTED_MODELS,
  totalDownloadBytes,
  type ModelSpec,
  tierLabel,
} from './models'
import type { ModelRecord } from './modelStore'

export type ModelGuideProps = {
  records: Record<string, ModelRecord>
  className?: string
}

function formatGB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function formatMeasured(record: ModelRecord | undefined): string {
  if (!record?.benchmark) return '—'
  return strings.ai.guide.measured(record.benchmark.p95Sec)
}

export function ModelGuide({ records, className }: ModelGuideProps) {
  const copy = strings.ai.guide
  return (
    <section
      className={
        'flex flex-col gap-4 rounded-lg border border-border-subtle bg-bg-surface p-6' +
        (className ? ` ${className}` : '')
      }
      aria-labelledby="model-guide-heading"
    >
      <header className="flex flex-col gap-2">
        <h3
          id="model-guide-heading"
          className="text-lg font-semibold tracking-tight text-text-primary"
        >
          {copy.heading}
        </h3>
        <p className="text-sm text-text-secondary">{copy.body}</p>
      </header>

      <div className="overflow-hidden rounded-md border border-border-subtle">
        <table className="w-full text-left text-sm">
          <thead className="bg-bg-raised text-xs uppercase tracking-wide text-text-secondary">
            <tr>
              <th className="px-3 py-2 font-medium">
                {copy.tableHeaders.tier}
              </th>
              <th className="px-3 py-2 font-medium">
                {copy.tableHeaders.model}
              </th>
              <th className="px-3 py-2 font-medium">
                {copy.tableHeaders.download}
              </th>
              <th className="px-3 py-2 font-medium">{copy.tableHeaders.ram}</th>
              <th className="px-3 py-2 font-medium">
                {copy.tableHeaders.license}
              </th>
              <th className="px-3 py-2 font-medium">
                {copy.tableHeaders.yourSpeed}
              </th>
            </tr>
          </thead>
          <tbody>
            {SUPPORTED_MODELS.map((spec: ModelSpec) => (
              <tr
                key={spec.id}
                className="border-t border-border-subtle align-top"
              >
                <td className="px-3 py-2 text-text-primary">
                  {tierLabel(spec.defaultTier)}
                </td>
                <td className="px-3 py-2 text-text-primary">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">{spec.displayName}</span>
                    <span className="font-mono text-xs text-text-secondary">
                      {spec.quantLabel}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 text-text-secondary">
                  {formatGB(totalDownloadBytes(spec))}
                </td>
                <td className="px-3 py-2 text-text-secondary">
                  {spec.ramRequiredGB} GB
                </td>
                <td className="px-3 py-2 text-text-secondary">
                  {spec.license}
                </td>
                <td className="px-3 py-2 text-text-primary">
                  {formatMeasured(records[spec.id])}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="text-xs text-text-secondary">{copy.footer}</footer>
    </section>
  )
}
