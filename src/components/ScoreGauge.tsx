import { useEffect, useId, useRef, useState } from 'react'

import { tokens } from '@/design/tokens'
import { cn } from '@/lib/utils'

export type ScoreGaugeProps = {
  // Final score in [0, 100]. Values outside the range clamp.
  score: number
  // Diameter of the gauge in px. Defaults to 192 (matches the post-session
  // hero size in DESIGN-SYSTEM.md §6 motion rule #5). The gauge scales
  // proportionally — stroke width, label sizes all derive from this.
  size?: number
  // When true, the arc sweeps from 0 to `score` over `tokens.motion.duration
  // .reveal` with `tokens.motion.easing.spring`. Defaults to true; pass
  // false in Storybook so the visual snapshot is deterministic.
  animate?: boolean
  // Accessible label. Falls back to "Focus score" when omitted.
  label?: string
  className?: string
}

const DEFAULT_SIZE = 192

// Post-session arc gauge from DESIGN-SYSTEM.md §4 ("Post-session arc gauge
// from 0–100") + §6 motion rule #5 ("Post-session score reveal: `reveal`
// duration, `spring` easing, gauge sweep from 0 to final score. Sound:
// none.").
//
// Sweeps from 6 o'clock counter-clockwise through 12 o'clock back to 6
// o'clock, covering 270° of the circle. The unfilled portion uses a
// muted border color; the filled portion uses the accent token, which
// switches with the light/dark theme via CSS variables. No theme-specific
// colors are inlined here.
export function ScoreGauge({
  score,
  size = DEFAULT_SIZE,
  animate = true,
  label,
  className,
}: ScoreGaugeProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)))
  const headingId = useId()
  const strokeWidth = Math.max(8, Math.round(size / 14))
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  // Sweep arc covers 270° (3/4 of the circle). The remaining 90° is the
  // open mouth at the bottom of the gauge where the score label sits.
  const sweepFraction = 0.75
  const arcLength = circumference * sweepFraction
  const targetOffset = arcLength * (1 - clamped / 100)

  // Animate `currentOffset` from `arcLength` (empty) → `targetOffset`. Each
  // render with a new clamped value re-runs the sweep so re-mounting the
  // gauge (e.g. opening the report twice) replays the reveal.
  const [currentOffset, setCurrentOffset] = useState<number>(
    animate ? arcLength : targetOffset
  )
  const reduceMotionRef = useRef(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    reduceMotionRef.current = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches
  }, [])
  useEffect(() => {
    if (!animate || reduceMotionRef.current) {
      setCurrentOffset(targetOffset)
      return
    }
    // Defer one frame so the initial offset paints before the transition,
    // otherwise the browser composites both states in the same paint and
    // the sweep is invisible.
    const raf = window.requestAnimationFrame(() => {
      setCurrentOffset(targetOffset)
    })
    return () => window.cancelAnimationFrame(raf)
  }, [animate, targetOffset])

  // Open the arc at the bottom: rotate so the gap is centered there.
  const rotation = 135
  const transition = animate
    ? `stroke-dashoffset ${tokens.motion.duration.reveal}ms ${tokens.motion.easing.spring}`
    : 'none'

  const accessibleLabel = label ?? 'Focus score'

  return (
    <div
      role="img"
      aria-labelledby={headingId}
      className={cn(
        'relative inline-flex flex-col items-center justify-center',
        className
      )}
      style={{ width: size, height: size }}
      data-testid="score-gauge"
    >
      <span id={headingId} className="sr-only">
        {accessibleLabel}: {clamped} out of 100
      </span>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
      >
        <g transform={`rotate(${rotation} ${size / 2} ${size / 2})`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--color-border-subtle)"
            strokeWidth={strokeWidth}
            strokeDasharray={`${arcLength} ${circumference}`}
            strokeDashoffset={0}
            strokeLinecap="round"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--color-accent-default)"
            strokeWidth={strokeWidth}
            strokeDasharray={`${arcLength} ${circumference}`}
            strokeDashoffset={currentOffset}
            strokeLinecap="round"
            style={{ transition }}
          />
        </g>
      </svg>
      <div
        className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-text-primary"
        aria-hidden="true"
      >
        <span
          className="font-semibold tabular-nums tracking-tight"
          style={{ fontSize: size / 4 }}
        >
          {clamped}
        </span>
        <span
          className="text-text-secondary"
          style={{ fontSize: size / 14, marginTop: size / 48 }}
        >
          / 100
        </span>
      </div>
    </div>
  )
}
