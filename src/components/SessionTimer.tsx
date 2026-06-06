import { ChevronDown, Timer } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import type { PomodoroPhase, PomodoroPreset } from '@/lib/pomodoro-types'
import { cn } from '@/lib/utils'
import { strings } from '@/strings'

export type SessionTimerProps = {
  phase: PomodoroPhase
  preset: PomodoroPreset | null
  endsAt: number | null
  iAmBroadcaster: boolean
  // Optional broadcaster display name for the "broadcaster: <name>" label.
  // When `iAmBroadcaster` is true this is "you"; otherwise the resolved
  // peer display name (or a fallback).
  broadcasterName: string | null
  onStart: (preset: PomodoroPreset) => void
  onStop: () => void
  className?: string
}

const PHASE_LABEL: Record<Exclude<PomodoroPhase, 'idle'>, string> = strings
  .pomodoro.phaseLabels

// Bottom-bar timer per the V1-P9 prompt + DESIGN-SYSTEM.md §4 inventory.
// Idle: shows "[Pomodoro ▾]" trigger that opens a small popover with
// preset radios + Start. Active: shows phase label, mm:ss countdown,
// "broadcaster: <name>" badge, and a Stop control inside the popover.
export function SessionTimer({
  phase,
  preset,
  endsAt,
  iAmBroadcaster,
  broadcasterName,
  onStart,
  onStop,
  className,
}: SessionTimerProps) {
  const [open, setOpen] = useState(false)
  const [pickedPreset, setPickedPreset] = useState<PomodoroPreset>(
    preset ?? '25/5'
  )
  const remaining = useRemainingMs(endsAt)
  const active = phase !== 'idle'
  const phaseLabel = active
    ? PHASE_LABEL[phase as Exclude<PomodoroPhase, 'idle'>]
    : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="secondary"
          className={cn('gap-2', className)}
          aria-label={
            active
              ? strings.pomodoro.triggerAriaLabel(
                  phaseLabel ?? '',
                  formatMs(remaining)
                )
              : strings.pomodoro.triggerIdleAriaLabel
          }
        >
          <Timer className="size-4" strokeWidth={1.5} aria-hidden="true" />
          {active ? (
            <span className="flex items-center gap-2">
              <span className="text-text-secondary">{phaseLabel}</span>
              <span className="font-mono tabular-nums">
                {formatMs(remaining)}
              </span>
            </span>
          ) : (
            <span>{strings.pomodoro.label}</span>
          )}
          <ChevronDown
            className="size-3.5 text-text-secondary"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72"
        role="dialog"
        aria-label={strings.pomodoro.controlsAriaLabel}
      >
        {active ? (
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-sm font-medium text-text-primary">
                {strings.pomodoro.activeTitle(
                  phaseLabel ?? '',
                  preset ?? '25/5'
                )}
              </p>
              <p className="text-xs text-text-secondary">
                {iAmBroadcaster
                  ? strings.pomodoro.drivingSelf
                  : strings.pomodoro.drivenBy(
                      broadcasterName ?? strings.session.broadcasterFallback
                    )}
              </p>
            </div>
            {/* Single-driver model: only the broadcaster can stop the shared
                timer. For receivers the stop() controller call is a no-op the
                broadcaster's next tick would resurrect within 5s, so we show
                a read-only active view (title + "driven by") instead. */}
            {iAmBroadcaster && (
              <>
                <Separator />
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    onStop()
                    setOpen(false)
                  }}
                >
                  {strings.pomodoro.stopCta}
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium text-text-primary">
              {strings.pomodoro.startTitle}
            </p>
            <fieldset className="flex flex-col gap-2 text-sm">
              <legend className="sr-only">
                {strings.pomodoro.presetLegend}
              </legend>
              <PresetRadio
                value="25/5"
                label={strings.pomodoro.presets['25/5'].label}
                hint={strings.pomodoro.presets['25/5'].hint}
                checked={pickedPreset === '25/5'}
                onSelect={() => setPickedPreset('25/5')}
              />
              <PresetRadio
                value="50/10"
                label={strings.pomodoro.presets['50/10'].label}
                hint={strings.pomodoro.presets['50/10'].hint}
                checked={pickedPreset === '50/10'}
                onSelect={() => setPickedPreset('50/10')}
              />
            </fieldset>
            <Separator />
            <Button
              size="sm"
              onClick={() => {
                onStart(pickedPreset)
                setOpen(false)
              }}
            >
              {strings.pomodoro.startCta}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function PresetRadio({
  value,
  label,
  hint,
  checked,
  onSelect,
}: {
  value: PomodoroPreset
  label: string
  hint: string
  checked: boolean
  onSelect: () => void
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 transition-colors',
        checked
          ? 'border-accent-default bg-bg-raised'
          : 'border-border-default hover:bg-bg-raised'
      )}
    >
      <input
        type="radio"
        name="pomodoro-preset"
        value={value}
        checked={checked}
        onChange={onSelect}
        className="mt-1 accent-accent-default"
      />
      <span className="flex flex-col">
        <span className="font-medium text-text-primary">{label}</span>
        <span className="text-xs text-text-secondary">{hint}</span>
      </span>
    </label>
  )
}

// Returns ms remaining until `endsAt` (or 0 when null). Drives a 1-second
// tick so the countdown updates in the bottom-bar without re-rendering the
// whole SessionView. Tracks `now` rather than the derived `remaining` so
// the effect body never calls setState synchronously.
function useRemainingMs(endsAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (endsAt == null) return
    const handle = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(handle)
  }, [endsAt])
  if (endsAt == null) return 0
  return Math.max(0, endsAt - now)
}

function formatMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
