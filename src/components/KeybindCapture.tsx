import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import {
  comboFromKeyboardEvent,
  comboToKbdLabels,
  isModifierCode,
  validateCombo,
  type Combo,
  type Platform,
  type ShortcutAction,
} from '@/lib/keybindings'
import { describeConflict } from '@/lib/keybindings-copy'
import { setShortcutCaptureActive } from '@/lib/shortcutCapture'
import { cn } from '@/lib/utils'
import { strings } from '@/strings'

type CaptureOperation = {
  cancel: () => void
  active: boolean
  committing: boolean
  keyDown: string | null
  releaseCodes: string[]
  committed: boolean
}
// #393 — keyboard capture is document-wide, so ownership must be shared by
// every control in this document rather than one armed flag per instance.
let activeCapture: CaptureOperation | null = null
function syncNativeCapture(): Promise<void> {
  return setShortcutCaptureActive(activeCapture?.active === true)
}

export type KeybindCaptureProps = {
  action: ShortcutAction
  combo: Combo
  otherCombo: Combo
  otherAction: ShortcutAction
  additionalBindings?: readonly { combo: Combo; action: ShortcutAction }[]
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
  additionalBindings,
  platform,
  onCommit,
  disabled,
}: KeybindCaptureProps) {
  const [armed, setArmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const errorId = useId()
  const captureRef = useRef<CaptureOperation | null>(null)

  const cancel = useCallback(() => {
    const capture = captureRef.current
    if (capture) capture.active = false
    if (activeCapture === capture) activeCapture = null
    captureRef.current = null
    setArmed(false)
    setError(null)
    void syncNativeCapture().catch(() => {})
  }, [])

  useEffect(
    () => () => {
      const capture = captureRef.current
      if (capture) capture.active = false
      if (activeCapture === capture) activeCapture = null
      void syncNativeCapture().catch(() => {})
    },
    []
  )

  useEffect(() => {
    const handleBlur = () => {
      const capture = captureRef.current
      if (capture?.active && activeCapture === capture) cancel()
    }
    const handleVisibility = () => {
      if (document.hidden) handleBlur()
    }
    window.addEventListener('blur', handleBlur)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('blur', handleBlur)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [cancel])

  useEffect(() => {
    const capture = captureRef.current
    if (!armed || !capture) return
    buttonRef.current?.focus()
    const handler = (event: KeyboardEvent) => {
      if (!capture.active || activeCapture !== capture) return
      // Held-key autorepeat fires a stream of keydowns — ignore them so a
      // single press doesn't queue multiple commit attempts (the second one
      // would race against the optimistic set + Rust re-register).
      if (event.repeat) return
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
      if (capture.committing) return
      const captured = comboFromKeyboardEvent(event, platform)
      const conflict = validateCombo(captured, {
        otherCombo,
        otherAction,
        additionalBindings,
        platform,
      })
      if (conflict) {
        setError(describeConflict(captured, conflict, platform))
        return
      }
      capture.keyDown = event.code
      capture.releaseCodes = [
        event.code,
        ...(event.metaKey
          ? ['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight']
          : []),
        ...(event.ctrlKey ? ['ControlLeft', 'ControlRight'] : []),
        ...(event.altKey ? ['AltLeft', 'AltRight'] : []),
        ...(event.shiftKey ? ['ShiftLeft', 'ShiftRight'] : []),
      ]
      capture.committing = true
      void (async () => {
        try {
          await onCommit(captured)
          capture.committed = true
          if (capture.active && activeCapture === capture && !capture.keyDown)
            cancel()
        } catch (err) {
          if (!capture.active || activeCapture !== capture) return
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          if (!capture.committed) capture.committing = false
        }
      })()
    }
    const handleRelease = (event: KeyboardEvent) => {
      if (!capture.releaseCodes.includes(event.code)) return
      capture.keyDown = null
      if (capture.committed && capture.active && activeCapture === capture)
        cancel()
    }
    document.addEventListener('keydown', handler, { capture: true })
    document.addEventListener('keyup', handleRelease, { capture: true })
    return () => {
      document.removeEventListener('keydown', handler, { capture: true })
      document.removeEventListener('keyup', handleRelease, { capture: true })
    }
  }, [
    armed,
    platform,
    otherCombo,
    otherAction,
    additionalBindings,
    onCommit,
    cancel,
  ])

  const handleClick = useCallback(() => {
    if (disabled) return
    if (armed) {
      cancel()
      return
    }
    activeCapture?.cancel()
    const capture: CaptureOperation = {
      cancel,
      active: true,
      committing: false,
      keyDown: null,
      releaseCodes: [],
      committed: false,
    }
    captureRef.current = capture
    activeCapture = capture
    setError(null)
    void syncNativeCapture().then(
      () => {
        if (capture.active && activeCapture === capture) setArmed(true)
      },
      (err: unknown) => {
        if (!capture.active || activeCapture !== capture) return
        cancel()
        setError(err instanceof Error ? err.message : String(err))
      }
    )
  }, [armed, cancel, disabled])

  const labels = comboToKbdLabels(combo, platform)
  const actionLabel = strings.keybindings.actionLabelsLower[action]
  const capture = strings.keybindings.capture

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <div
          data-state={armed ? 'armed' : 'idle'}
          aria-hidden={armed ? 'true' : undefined}
          className="flex items-center gap-1 transition-opacity ease-out-token"
        >
          {labels.map((label, i) => (
            <Kbd key={`${label}-${i}`}>{label}</Kbd>
          ))}
        </div>
        <Button
          ref={buttonRef}
          type="button"
          size="sm"
          // The armed 'secondary' variant has no border while idle
          // 'outline' does; a transparent border keeps the intrinsic width
          // identical across the swap so the chips beside it never move.
          className={cn(armed && 'border border-transparent')}
          variant={armed ? 'secondary' : 'outline'}
          onClick={handleClick}
          aria-pressed={armed}
          aria-label={
            armed
              ? capture.armAriaLabel(actionLabel)
              : capture.rebindAriaLabel(actionLabel)
          }
          aria-describedby={error ? errorId : undefined}
          disabled={disabled}
          data-state={armed ? 'armed' : 'idle'}
        >
          {/* Both labels grid-stacked in one cell with the inactive one
              invisible: the button's width is the max of the two, so the
              idle↔armed swap ("Rebind" / "Press a key…") never nudges the
              Kbd chips beside it. */}
          <span className="grid text-center">
            <span
              className={cn('col-start-1 row-start-1', armed && 'invisible')}
              aria-hidden={armed || undefined}
            >
              {capture.rebind}
            </span>
            <span
              className={cn('col-start-1 row-start-1', !armed && 'invisible')}
              aria-hidden={!armed || undefined}
            >
              {capture.pressKey}
            </span>
          </span>
        </Button>
      </div>
      {error ? (
        <span
          id={errorId}
          role="alert"
          className="max-w-[36ch] text-right text-xs break-words text-status-alerted"
        >
          {error}
        </span>
      ) : armed ? (
        <span className="max-w-[36ch] text-right text-xs text-text-muted">
          {capture.help}
        </span>
      ) : null}
    </div>
  )
}
