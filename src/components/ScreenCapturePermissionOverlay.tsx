// V2-P3 — Tutorial overlay shown when getDisplayMedia returns
// NotAllowedError on macOS Sequoia. Surfaces the System Settings → Privacy
// & Security → Screen Recording route the user has to take to grant
// per-app access (the WebKit prompt fires but cannot grant on its own).
//
// On other platforms the overlay falls back to a textual instruction; the
// open-settings button is hidden because non-macOS targets don't have an
// equivalent stable URL scheme.

import { useCallback, useState } from 'react'
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

export type ScreenCapturePermissionOverlayProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Optional retry callback wired by V2-P9 / V2-P5: after the user grants
  // access in System Settings and clicks Retry, this triggers another
  // getDisplayMedia attempt.
  onRetry?: () => void
}

export function ScreenCapturePermissionOverlay({
  open,
  onOpenChange,
  onRetry,
}: ScreenCapturePermissionOverlayProps) {
  const [opening, setOpening] = useState(false)
  const isMac = isMacLikePlatform()

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
            : "Couldn't open System Settings."
      toast.error(message)
    } finally {
      setOpening(false)
    }
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby="screen-capture-permission-description"
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
            <DialogTitle>Allow screen recording</DialogTitle>
          </div>
          <DialogDescription id="screen-capture-permission-description">
            StudyVis needs to capture a still image of your screen so the
            on-device AI can check that your study session stays on topic.
            Screen frames never leave this {isMac ? 'Mac' : 'computer'}.
          </DialogDescription>
        </DialogHeader>
        <ol className="ml-1 list-decimal space-y-2 pl-4 text-sm text-text-secondary marker:text-text-muted">
          {isMac ? (
            <>
              <li>
                Click{' '}
                <strong className="text-text-primary">Open Settings</strong>{' '}
                below.
              </li>
              <li>
                Toggle <strong className="text-text-primary">StudyVis</strong>{' '}
                on under{' '}
                <span className="text-text-primary">Screen Recording</span>.
              </li>
              <li>
                macOS may ask you to quit and reopen StudyVis. Do that, then
                come back and click{' '}
                <strong className="text-text-primary">Try again</strong>.
              </li>
            </>
          ) : (
            <>
              <li>
                When the screen-share picker appears, choose your primary
                display.
              </li>
              <li>
                Click <strong className="text-text-primary">Share</strong> to
                allow the on-device AI to read the frame.
              </li>
              <li>
                If the prompt was dismissed, click{' '}
                <strong className="text-text-primary">Try again</strong> below.
              </li>
            </>
          )}
        </ol>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Not now
          </Button>
          {isMac ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleOpenSettings()}
              disabled={opening}
            >
              <ExternalLinkIcon /> Open Settings
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
              Try again
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
