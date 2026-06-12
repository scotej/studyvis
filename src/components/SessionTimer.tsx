import { ChevronDown, Timer } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Separator } from '@/components/ui/separator'
import {
  CUSTOM_REST_MAX,
  CUSTOM_REST_MIN,
  CUSTOM_WORK_MAX,
  CUSTOM_WORK_MIN,
  clampCustomMinutes,
  type PomodoroPhase,
  type PomodoroPreset,
  type PomodoroStartArgs,
} from '@/lib/pomodoro-types'
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
  onStart: (args: PomodoroStartArgs) => void
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
  // N5 — custom-split inputs, kept as raw strings so a half-typed value (an
  // empty box, a leading digit) doesn't snap. Clamped to the bounds only at
  // start-time via `clampCustomMinutes`.
  const [customWork, setCustomWork] = useState('45')
  const [customRest, setCustomRest] = useState('15')
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
            <RadioGroup
              className="gap-2 text-sm"
              aria-label={strings.pomodoro.presetLegend}
              value={pickedPreset}
              onValueChange={(value) =>
                setPickedPreset(value as PomodoroPreset)
              }
            >
              <PresetRadio
                value="25/5"
                label={strings.pomodoro.presets['25/5'].label}
                hint={strings.pomodoro.presets['25/5'].hint}
                checked={pickedPreset === '25/5'}
              />
              <PresetRadio
                value="50/10"
                label={strings.pomodoro.presets['50/10'].label}
                hint={strings.pomodoro.presets['50/10'].hint}
                checked={pickedPreset === '50/10'}
              />
              <PresetRadio
                value="custom"
                label={strings.pomodoro.presets.custom.label}
                hint={strings.pomodoro.presets.custom.hint}
                checked={pickedPreset === 'custom'}
              />
            </RadioGroup>
            {pickedPreset === 'custom' ? (
              <CustomDurationFields
                work={customWork}
                rest={customRest}
                onWorkChange={setCustomWork}
                onRestChange={setCustomRest}
              />
            ) : null}
            <Separator />
            <Button
              size="sm"
              onClick={() => {
                onStart(startArgsFor(pickedPreset, customWork, customRest))
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
}: {
  value: PomodoroPreset
  label: string
  hint: string
  checked: boolean
}) {
  const id = `pomodoro-preset-${value}`
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 transition-colors',
        checked
          ? 'border-accent-default bg-bg-raised'
          : 'border-border-default hover:bg-bg-raised'
      )}
    >
      <RadioGroupItem id={id} value={value} className="mt-1" />
      <span className="flex flex-col">
        <span className="font-medium text-text-primary">{label}</span>
        <span className="text-xs text-text-secondary">{hint}</span>
      </span>
    </label>
  )
}

// N5 — the two numeric inputs revealed by the "Custom" preset. Raw-string
// state lives in the parent so a half-typed value never snaps; clamping to
// the bounds happens at start-time.
function CustomDurationFields({
  work,
  rest,
  onWorkChange,
  onRestChange,
}: {
  work: string
  rest: string
  onWorkChange: (value: string) => void
  onRestChange: (value: string) => void
}) {
  const copy = strings.pomodoro.custom
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="pomodoro-custom-work" className="text-xs">
            {copy.workLabel}
          </Label>
          <Input
            id="pomodoro-custom-work"
            type="number"
            inputMode="numeric"
            min={CUSTOM_WORK_MIN}
            max={CUSTOM_WORK_MAX}
            value={work}
            onChange={(e) => onWorkChange(e.target.value)}
            aria-label={copy.workAriaLabel}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="pomodoro-custom-rest" className="text-xs">
            {copy.restLabel}
          </Label>
          <Input
            id="pomodoro-custom-rest"
            type="number"
            inputMode="numeric"
            min={CUSTOM_REST_MIN}
            max={CUSTOM_REST_MAX}
            value={rest}
            onChange={(e) => onRestChange(e.target.value)}
            aria-label={copy.restAriaLabel}
          />
        </div>
      </div>
      <p className="text-xs text-text-secondary">
        {copy.bounds(
          CUSTOM_WORK_MIN,
          CUSTOM_WORK_MAX,
          CUSTOM_REST_MIN,
          CUSTOM_REST_MAX
        )}
      </p>
    </div>
  )
}

// N5 — build the controller start arg from the picked preset + the raw
// custom-input strings. Clamps the custom split to bounds so an out-of-range
// or non-numeric entry can never reach the broadcast.
function startArgsFor(
  preset: PomodoroPreset,
  workInput: string,
  restInput: string
): PomodoroStartArgs {
  if (preset !== 'custom') return { preset }
  const { workMin, restMin } = clampCustomMinutes(
    Number(workInput),
    Number(restInput)
  )
  return {
    preset: 'custom',
    workMs: workMin * 60_000,
    restMs: restMin * 60_000,
  }
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
