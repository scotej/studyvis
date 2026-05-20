// V2-P3 — Tutorial overlay shown when getDisplayMedia returns
// NotAllowedError on macOS Sequoia. Surfaces the System Settings → Privacy
// & Security → Screen Recording route the user has to take to grant
// per-app access (the WebKit prompt fires but cannot grant on its own).
//
// On other platforms the overlay falls back to a textual instruction; the
// open-settings button is hidden because non-macOS targets don't have an
// equivalent stable URL scheme.

import { Fragment, useCallback, useState, type ReactNode } from 'react'
import { ShieldAlertIcon, ExternalLinkIcon } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { isMacLikePlatform } from '@/lib/utils'
import { strings } from '@/strings'

export type ScreenCapturePermissionOverlayProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Optional retry callback wired by V2-P9 / V2-P5: after the user grants
  // access in System Settings and clicks Retry, this triggers another
  // getDisplayMedia attempt.
  onRetry?: () => void
}

// Renders **bold** spans in the strings.ts step text. We keep markdown-flavoured
// bold markers in the strings module (so the source of truth stays in one
// place) and resolve them here at render time.
function renderStep(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={i} className="text-text-primary">
          {part.slice(2, -2)}
        </strong>
      )
    }
    return <Fragment key={i}>{part}</Fragment>
  })
}

export function ScreenCapturePermissionOverlay({
  open,
  onOpenChange,
  onRetry,
}: ScreenCapturePermissionOverlayProps) {
  const [opening, setOpening] = useState(false)
  const isMac = isMacLikePlatform()
  const copy = strings.permissions.screenCapture

  const handleOpenSettings = useCallback(async () => {
    setOpening(true)
    try {
      await invoke('system_open_screen_capture_settings')
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : copy.openSettingsErrorFallback
      toast.error(message)
    } finally {
      setOpening(false)
    }
  }, [copy.openSettingsErrorFallback])

  const steps = isMac ? copy.stepsMac : copy.stepsOther

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Two ids so the "Heads-up" indicator paragraph also lands in the
        // accessible description Radix announces on open (Copilot review,
        // PR #38). DialogPrimitive.Content forwards space-separated
        // aria-describedby per ARIA semantics.
        aria-describedby="screen-capture-permission-description screen-capture-permission-indicator-note"
        showCloseButton={false}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex size-9 items-center justify-center rounded-full bg-status-warning/15 text-status-warning"
            >
              <ShieldAlertIcon className="size-5" />
            </span>
            <DialogTitle>{copy.title}</DialogTitle>
          </div>
          <DialogDescription id="screen-capture-permission-description">
            {copy.body(isMac)}
          </DialogDescription>
        </DialogHeader>
        <ol className="ml-1 list-decimal space-y-2 pl-4 text-sm text-text-secondary marker:text-text-muted">
          {steps.map((step, i) => (
            <li key={i}>{renderStep(step)}</li>
          ))}
        </ol>
        {/* D5 — the macOS recording indicator (and its Windows counterpart)
            stays on for the whole AI session. The id is referenced from
            DialogContent's aria-describedby so SRs read it on open. */}
        <p
          id="screen-capture-permission-indicator-note"
          className="text-sm text-text-secondary"
        >
          {copy.indicatorNote}
        </p>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {copy.cancelCta}
          </Button>
          {isMac ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleOpenSettings()}
              disabled={opening}
            >
              <ExternalLinkIcon /> {copy.openSettingsCta}
            </Button>
          ) : null}
          {onRetry ? (
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                onOpenChange(false)
                onRetry()
              }}
            >
              {copy.tryAgainCta}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
