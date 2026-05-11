import { CheckCircle2, MessageCircle, XCircle } from 'lucide-react'

import { cn } from '@/lib/utils'

export type AiResponseTone = 'neutral' | 'approved' | 'denied'

export type AiResponseBubbleProps = {
  // The text shown to the user. For break-request flows this is the rule
  // layer's verdict reason; for question / topic_change it's the AI's
  // reply text.
  text: string
  // Visual tone. `approved` (green check) for an approved break,
  // `denied` (red x) for a denied break, `neutral` (gray dot) for
  // questions / topic_change / fallback unknown.
  tone?: AiResponseTone
  className?: string
}

// V2-P7 — bubble shown below the AiTextBox after a model reply lands. The
// dialog host owns the request lifecycle; this component is purely
// presentational. Tones map to status tokens so the verdict reads at a
// glance — green for an approved break, red for a denied one, neutral
// for everything else.
export function AiResponseBubble({
  text,
  tone = 'neutral',
  className,
}: AiResponseBubbleProps) {
  if (!text) return null
  const Icon =
    tone === 'approved'
      ? CheckCircle2
      : tone === 'denied'
        ? XCircle
        : MessageCircle
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-start gap-3 rounded-md border bg-bg-raised px-4 py-3 text-sm',
        tone === 'approved' && 'border-status-focused/40',
        tone === 'denied' && 'border-status-alerted/40',
        tone === 'neutral' && 'border-border-default',
        className
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          'mt-0.5 size-4 shrink-0',
          tone === 'approved' && 'text-status-focused',
          tone === 'denied' && 'text-status-alerted',
          tone === 'neutral' && 'text-text-secondary'
        )}
      />
      <p className="text-text-primary">{text}</p>
    </div>
  )
}
