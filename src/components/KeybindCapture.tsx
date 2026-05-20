import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import {
  comboFromKeyboardEvent,
  comboToKbdLabels,
  describeConflict,
  isModifierCode,
  validateCombo,
  type Combo,
  type Platform,
  type ShortcutAction,
} from '@/lib/keybindings'
import { cn } from '@/lib/utils'

export type KeybindCaptureProps = {
  action: ShortcutAction
  combo: Combo
  otherCombo: Combo
  otherAction: ShortcutAction
  platform: Platform
  // Awaited so a downstream rejection (Rust-side registration refusal —
  // OS-reserved combo we didn't catch locally) keeps the control armed and
  // shows the rejection message inline. Resolving disarms.
  onCommit: (next: Combo) => Promise<void>
  disabled?: boolean
}

export function KeybindCapture({
  action,
  combo,
  otherCombo,
  otherAction,
  platform,
  onCommit,
  disabled,
}: KeybindCaptureProps) {
  const [armed, setArmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const errorId = useId()

  const cancel = useCallback(() => {
    setArmed(false)
    setError(null)
  }, [])

  useEffect(() => {
    if (!armed) return
    buttonRef.current?.focus()
    const handler = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault()
        event.stopPropagation()
        cancel()
        return
      }
      if (isModifierCode(event.code)) {
        // Wait for the non-modifier press that completes the combo.
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const captured = comboFromKeyboardEvent(event, platform)
      const conflict = validateCombo(captured, {
        otherCombo,
        otherAction,
        platform,
      })
      if (conflict) {
        setError(describeConflict(captured, conflict, platform))
        return
      }
      void (async () => {
        try {
          await onCommit(captured)
          setError(null)
          setArmed(false)
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })()
    }
    document.addEventListener('keydown', handler, { capture: true })
    return () =>
      document.removeEventListener('keydown', handler, { capture: true })
  }, [armed, platform, otherCombo, otherAction, onCommit, cancel])

  const handleClick = useCallback(() => {
    if (disabled) return
    if (armed) {
      cancel()
      return
    }
    setError(null)
    setArmed(true)
  }, [armed, cancel, disabled])

  const labels = comboToKbdLabels(combo, platform)
  const actionLabel = action === 'ptt-friends' ? 'push to talk' : 'talk to AI'

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <div
          data-state={armed ? 'armed' : 'idle'}
          aria-hidden={armed ? 'true' : undefined}
          className={cn(
            'flex items-center gap-1 transition-opacity ease-out-token',
            armed && 'opacity-40'
          )}
        >
          {labels.map((label, i) => (
            <Kbd key={`${label}-${i}`}>{label}</Kbd>
          ))}
        </div>
        <Button
          ref={buttonRef}
          type="button"
          size="sm"
          variant={armed ? 'secondary' : 'outline'}
          onClick={handleClick}
          aria-pressed={armed}
          aria-label={
            armed
              ? `Press a combo for ${actionLabel}, or Escape to cancel`
              : `Rebind ${actionLabel}`
          }
          aria-describedby={error ? errorId : undefined}
          disabled={disabled}
          data-state={armed ? 'armed' : 'idle'}
        >
          {armed ? 'Press a key…' : 'Rebind'}
        </Button>
      </div>
      {error ? (
        <span id={errorId} role="alert" className="text-xs text-status-alerted">
          {error}
        </span>
      ) : armed ? (
        <span className="text-xs text-text-muted">
          Press a combo, or Esc to cancel.
        </span>
      ) : null}
    </div>
  )
}
