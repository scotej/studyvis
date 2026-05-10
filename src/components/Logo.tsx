import { cn } from '@/lib/utils'

const SIZES = {
  sm: 24,
  md: 32,
  lg: 48,
  xl: 96,
} as const

export type LogoSize = keyof typeof SIZES

export function Logo({
  size = 'md',
  className,
  monochrome = false,
}: {
  size?: LogoSize
  className?: string
  monochrome?: boolean
}) {
  const px = SIZES[size]
  const radius = Math.round(px * 0.25)
  const circleR = Math.round(px * 0.3)
  const squareFill = monochrome ? 'currentColor' : 'var(--color-accent-default)'
  const circleFill = monochrome ? 'transparent' : 'var(--color-status-focused)'
  const circleStroke = monochrome ? 'currentColor' : 'transparent'

  return (
    <svg
      role="img"
      aria-label="StudyVis"
      width={px}
      height={px}
      viewBox={`0 0 ${px} ${px}`}
      className={cn('inline-block shrink-0', className)}
    >
      <rect
        x={0}
        y={0}
        width={px}
        height={px}
        rx={radius}
        ry={radius}
        fill={squareFill}
      />
      <circle
        cx={px / 2}
        cy={px / 2}
        r={circleR}
        fill={circleFill}
        stroke={circleStroke}
        strokeWidth={monochrome ? Math.max(1, Math.round(px / 16)) : 0}
      />
    </svg>
  )
}
