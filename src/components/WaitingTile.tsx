import { UsersIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { strings } from '@/strings'

export type WaitingTileProps = {
  // 'invite' — never had a peer this session (just invited, sitting alone).
  // 'solo' — a friend had joined and has since left or disconnected; the local
  // session remains live for as long as the user wants to keep studying.
  variant?: 'invite' | 'solo'
  className?: string
}

// U2 — calm "waiting for your friend" tile shown alongside the self tile when
// you're alone in an active session. DESIGN-SYSTEM §10 empty-state pattern:
// secondary-toned copy, NO spinner, no "loading…" text — sitting alone right
// after inviting is the most common first-session moment and shouldn't read
// like a broken screen. Matches the VideoTile footprint so the 1→2 grid
// transition (when the friend arrives) doesn't reflow.
export function WaitingTile({
  variant = 'invite',
  className,
}: WaitingTileProps) {
  const copy =
    variant === 'solo'
      ? {
          title: strings.session.waiting.soloTitle,
          body: strings.session.waiting.soloBody,
        }
      : {
          title: strings.session.waiting.title,
          body: strings.session.waiting.body,
        }
  return (
    <div
      className={cn(
        'flex aspect-video flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border-subtle bg-bg-sunk px-6 text-center',
        className
      )}
      // #95 — sized by VideoGrid like every other tile; see the note on
      // VideoTile's figure for why it carries no height of its own.
      data-testid="waiting-tile"
    >
      <UsersIcon className="size-7 text-text-muted" aria-hidden="true" />
      <p className="text-sm font-medium text-text-secondary">{copy.title}</p>
      <p className="max-w-[28ch] text-xs text-text-muted">{copy.body}</p>
    </div>
  )
}
