// V2-P3 — Renders for SESSION_ENDED_SPLASH_MS after a session tears down
// (host leaves, last peer leaves, user clicks Leave). The audit log + the
// pomodoro state have already been reset by the leave handler; only the
// session header / room state lingers in the `ended` status so the splash
// can show a calm "you left" confirmation before idle.
//
// V2-P5 will extend this with the post-session score gauge from
// DESIGN-SYSTEM.md §6.5 (ScoreGauge); V2-P3 keeps it lightweight.

import { CheckCircle2Icon } from 'lucide-react'

export type SessionEndedSplashProps = {
  // Duration the session ran for, in seconds. The splash formats it as
  // mm:ss; null hides the duration.
  durationSeconds: number | null
  peerNames: string[]
}

export function SessionEndedSplash({
  durationSeconds,
  peerNames,
}: SessionEndedSplashProps) {
  const duration = formatDuration(durationSeconds)
  const withWhom =
    peerNames.length === 0
      ? null
      : peerNames.length === 1
        ? peerNames[0]
        : peerNames.length === 2
          ? `${peerNames[0]} and ${peerNames[1]}`
          : `${peerNames.slice(0, -1).join(', ')}, and ${peerNames[peerNames.length - 1]}`

  return (
    <main
      role="status"
      aria-live="polite"
      className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg-base text-text-primary"
    >
      <span
        aria-hidden="true"
        className="flex size-12 items-center justify-center rounded-full bg-status-focused/15 text-status-focused"
      >
        <CheckCircle2Icon className="size-7" />
      </span>
      <h1 className="text-xl font-semibold tracking-tight">Session ended.</h1>
      <p className="text-sm text-text-secondary">
        {withWhom ? `Studied with ${withWhom}` : 'Studied solo'}
        {duration ? ` for ${duration}` : ''}.
      </p>
    </main>
  )
}

function formatDuration(seconds: number | null): string | null {
  if (seconds == null || seconds < 0) return null
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  if (m === 0) return `${s} second${s === 1 ? '' : 's'}`
  if (s === 0) return `${m} minute${m === 1 ? '' : 's'}`
  return `${m} min ${s.toString().padStart(2, '0')} s`
}
