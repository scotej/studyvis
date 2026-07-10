// "What model should I pick?" — the in-app guide referenced from the
// picker and from Settings → AI. Renders the ARCHITECTURE.md §8 table plus
// the user's measured speeds when available.

import { Disclosure } from '@/components/Disclosure'
import { cn } from '@/lib/utils'
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
  // Storybook renders one expanded instance so the table markup stays
  // inside the axe-core gate (collapsed <details> content isn't audited).
  defaultOpen?: boolean
}

function formatGB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function formatMeasured(record: ModelRecord | undefined): string {
  if (!record?.benchmark) return '—'
  return strings.ai.guide.measured(record.benchmark.p95Sec)
}

export function ModelGuide({
  records,
  className,
  defaultOpen,
}: ModelGuideProps) {
  const copy = strings.ai.guide
  // Default-collapsed: the model cards above already carry the per-model
  // download/RAM/license/speed facts, so the comparison table is opt-in
  // instead of ~600px of repeated data on every visit to the pane. The
  // section keeps the guide reachable by landmark now that the heading
  // lives inside the summary button.
  return (
    <section aria-label={copy.heading}>
      <Disclosure
        defaultOpen={defaultOpen}
        className={cn(
          'rounded-lg border border-border-subtle bg-bg-surface',
          className
        )}
        summaryClassName="rounded-lg p-6"
        summary={
          // Spans, not a heading: <summary> exposes a button role and most
          // AT strips heading semantics inside it, so a heading here would
          // read as neither.
          <span className="flex flex-col gap-2">
            <span className="text-lg font-semibold tracking-tight text-text-primary">
              {copy.heading}
            </span>
            <span className="text-sm text-text-secondary">{copy.body}</span>
          </span>
        }
      >
        <div className="mx-6 overflow-x-auto rounded-md border border-border-subtle">
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
                <th className="px-3 py-2 font-medium">
                  {copy.tableHeaders.ram}
                </th>
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

        <footer className="p-6 pt-4 text-xs text-text-secondary">
          {copy.footer}
        </footer>
      </Disclosure>
    </section>
  )
}
