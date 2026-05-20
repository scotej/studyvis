import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { ScreenCapturePermissionOverlay } from '@/components/ScreenCapturePermissionOverlay'
import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import {
  ALERT_THRESHOLD_MAX,
  ALERT_THRESHOLD_MIN,
  CaptureError,
  DEFAULT_CTX_SIZE,
  effectiveIntervalSec,
  FALLBACK_SAMPLE_INTERVAL_SEC,
  getDownloadRuntime,
  getHfTokenRuntime,
  MAX_SAMPLE_INTERVAL_SEC,
  ModelPickerContainer,
  requestScreenCapturePermission,
  useModelStore,
  useSidecarStore,
  WARNING_THRESHOLD_MAX,
  WARNING_THRESHOLD_MIN,
} from '@/features/ai'
import {
  isCaptureDisplaysMode,
  useSettingsStore,
  type CaptureDisplaysMode,
} from '@/stores/settingsStore'

// V2-P9 — the master AI gate plus the tuning controls prior phases left as
// read-only stubs. When the toggle is off the only thing rendered is the
// toggle itself: no picker, no sliders, no sidecar affordances. When it's on
// the gated controls come alive. Side-effects (permission seed on enable,
// sidecar stop on disable) are orchestrated here so the settings store stays
// in the `@/stores` layer with no `@/features/ai` import.
export function AiCategory() {
  const aiFeaturesEnabled = useSettingsStore((s) => s.values.aiFeaturesEnabled)
  const setAiFeaturesEnabled = useSettingsStore((s) => s.setAiFeaturesEnabled)
  const warningThreshold = useSettingsStore((s) => s.values.warningThreshold)
  const alertThreshold = useSettingsStore((s) => s.values.alertThreshold)
  const sampleIntervalSec = useSettingsStore((s) => s.values.sampleIntervalSec)
  const setWarningThreshold = useSettingsStore((s) => s.setWarningThreshold)
  const setAlertThreshold = useSettingsStore((s) => s.setAlertThreshold)
  const setSampleIntervalSec = useSettingsStore((s) => s.setSampleIntervalSec)
  const debugLogEnabled = useSettingsStore((s) => s.values.debugLogEnabled)
  const setDebugLogEnabled = useSettingsStore((s) => s.setDebugLogEnabled)
  const captureDisplays = useSettingsStore((s) => s.values.captureDisplays)
  const setCaptureDisplays = useSettingsStore((s) => s.setCaptureDisplays)

  const activeModelId = useModelStore((s) => s.activeModelId)
  const measuredFloor = useModelStore((s) => {
    const id = s.activeModelId
    const measured = id
      ? s.records[id]?.benchmark?.sampleIntervalSec
      : undefined
    return typeof measured === 'number' && measured >= 1
      ? measured
      : FALLBACK_SAMPLE_INTERVAL_SEC
  })

  const sidecarStatus = useSidecarStore((s) => s.status)
  const sidecarLastError = useSidecarStore((s) => s.lastError)

  const [permissionOverlayOpen, setPermissionOverlayOpen] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [tokenPresent, setTokenPresent] = useState<boolean | null>(null)

  const refreshTokenPresence = useCallback(async () => {
    try {
      setTokenPresent(await getHfTokenRuntime().present())
    } catch {
      setTokenPresent(null)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot keychain presence check: refreshTokenPresence awaits the Tauri command before any setState fires (same suppression as SessionsCategory / useIdentity.refresh).
    if (aiFeaturesEnabled) void refreshTokenPresence()
  }, [aiFeaturesEnabled, refreshTokenPresence])

  // One-shot OS permission seed (V2-P3 carryover): never call captureScreen()
  // to probe — `requestScreenCapturePermission` is the dedicated seed.
  const seedScreenPermission = useCallback(async () => {
    try {
      await requestScreenCapturePermission()
    } catch (err) {
      if (err instanceof CaptureError && err.code === 'screen_capture_denied') {
        setPermissionOverlayOpen(true)
        return
      }
      // Any other failure (no video track, getDisplayMedia odd in the
      // webview) is not a reason to undo the toggle: screen recording is
      // only needed once a session starts, which is where the loop asks
      // again. Keep AI on so the model picker stays available.
      toast(
        'Pick and download a model now. StudyVis will ask for screen access when you start a session.'
      )
    }
  }, [])

  const handleToggle = useCallback(
    async (next: boolean) => {
      setToggling(true)
      try {
        await setAiFeaturesEnabled(next)
        if (next) {
          await seedScreenPermission()
        } else {
          // V2-P1 carryover: terminate the llama-server child + unwind the
          // health-poll loop the moment the gate closes. Records + on-disk
          // model files are intentionally NOT touched — the toggle is a
          // runtime gate, not an uninstall.
          await useSidecarStore.getState().stop()
        }
      } finally {
        setToggling(false)
      }
    },
    [seedScreenPermission, setAiFeaturesEnabled]
  )

  const handleRetryPermission = useCallback(async () => {
    try {
      await requestScreenCapturePermission()
      setPermissionOverlayOpen(false)
      toast.success('Screen recording granted.')
    } catch (err) {
      if (err instanceof CaptureError && err.code === 'screen_capture_denied') {
        // Still denied — keep the overlay up so the user can open Settings.
        return
      }
      toast.error(
        err instanceof Error ? err.message : 'Could not request access.'
      )
    }
  }, [])

  const handleForgetToken = useCallback(async () => {
    try {
      await getHfTokenRuntime().clear()
      await refreshTokenPresence()
      toast.success('Hugging Face token removed.')
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not remove the token.'
      )
    }
  }, [refreshTokenPresence])

  const handleRestartSidecar = useCallback(async () => {
    if (!activeModelId) {
      toast.error('Pick a model first.')
      return
    }
    setRestarting(true)
    try {
      const paths = await getDownloadRuntime().paths(activeModelId)
      await useSidecarStore.getState().start({
        modelPath: paths.model_path,
        mmprojPath: paths.mmproj_path,
        ctxSize: DEFAULT_CTX_SIZE,
      })
      toast.success('AI model restarting.')
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not restart the model.'
      )
    } finally {
      setRestarting(false)
    }
  }, [activeModelId])

  // Clamp the displayed value through the SAME function the loop uses so the
  // slider can't show a value below `min` (a stale override saved on a faster
  // model, then switched to a slower one) and what the user sees matches
  // what the loop will actually run.
  const effectiveInterval = effectiveIntervalSec(
    measuredFloor,
    sampleIntervalSec
  )

  return (
    <SettingsSection heading="AI">
      <p className="mb-3 text-sm text-text-secondary">
        The vision model runs on this machine and only looks at your camera and
        screen. Nothing leaves your computer. Turn AI on to pick a model,
        benchmark it, and let StudyVis nudge you when you drift off-task.
      </p>

      <SettingsRow
        label="Enable AI features"
        help="Off by default. When off StudyVis is a plain study room with no model, no capture, and no scoring. StudyVis asks for screen access when you start your first session."
        control={
          <Switch
            checked={aiFeaturesEnabled}
            disabled={toggling}
            onCheckedChange={(checked) => void handleToggle(Boolean(checked))}
            aria-label="Enable AI features"
          />
        }
      />

      {!aiFeaturesEnabled ? (
        <SettingsRow
          label="AI is off"
          help="Enable AI features above to choose and benchmark a vision model and tune how often it samples."
        />
      ) : (
        <>
          <div className="pt-4">
            <ModelPickerContainer />
          </div>

          <SettingsRow
            label="Sample interval"
            stack
            help={`How often the model looks (seconds). The floor is what this machine measured (${measuredFloor}s); you can only slow it down, up to ${MAX_SAMPLE_INTERVAL_SEC}s. Takes effect on the next sample.`}
            control={
              <div className="flex items-center gap-4">
                <Slider
                  className="w-full"
                  min={measuredFloor}
                  max={MAX_SAMPLE_INTERVAL_SEC}
                  step={1}
                  value={[effectiveInterval]}
                  onValueChange={([v]) =>
                    void setSampleIntervalSec(v <= measuredFloor ? null : v)
                  }
                  aria-label="Sample interval (seconds)"
                />
                <span className="w-16 shrink-0 text-right text-sm tabular-nums text-text-secondary">
                  {effectiveInterval}s
                </span>
              </div>
            }
          />

          <SettingsRow
            label="Warning after"
            stack
            help="Consecutive off-task samples before StudyVis warns you privately (only you see it)."
            control={
              <div className="flex items-center gap-4">
                <Slider
                  className="w-full"
                  min={WARNING_THRESHOLD_MIN}
                  max={WARNING_THRESHOLD_MAX}
                  step={1}
                  value={[warningThreshold]}
                  onValueChange={([v]) => {
                    void setWarningThreshold(v)
                    // Keep the invariant warning < alert visible immediately.
                    if (v >= alertThreshold) {
                      void setAlertThreshold(
                        Math.min(v + 1, ALERT_THRESHOLD_MAX)
                      )
                    }
                  }}
                  aria-label="Warning after N off-task samples"
                />
                <span className="w-16 shrink-0 text-right text-sm tabular-nums text-text-secondary">
                  {warningThreshold}
                </span>
              </div>
            }
          />

          <SettingsRow
            label="Alert peers after"
            stack
            help="Consecutive off-task samples before your friends see you flagged. Always kept above the warning count."
            control={
              <div className="flex items-center gap-4">
                <Slider
                  className="w-full"
                  min={ALERT_THRESHOLD_MIN}
                  max={ALERT_THRESHOLD_MAX}
                  step={1}
                  value={[alertThreshold]}
                  onValueChange={([v]) => {
                    const floored = Math.max(v, warningThreshold + 1)
                    void setAlertThreshold(
                      Math.min(floored, ALERT_THRESHOLD_MAX)
                    )
                  }}
                  aria-label="Alert peers after N off-task samples"
                />
                <span className="w-16 shrink-0 text-right text-sm tabular-nums text-text-secondary">
                  {alertThreshold}
                </span>
              </div>
            }
          />

          <SettingsRow
            label="Capture displays"
            stack
            help="All displays sends every monitor to the local AI as one image. Peers never see your screen."
            control={
              <RadioGroup
                value={captureDisplays}
                onValueChange={(value) => {
                  if (isCaptureDisplaysMode(value)) {
                    void setCaptureDisplays(value as CaptureDisplaysMode)
                  }
                }}
                className="grid-cols-1 gap-3 sm:grid-flow-col sm:auto-cols-max sm:gap-6"
                aria-label="Capture displays"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem
                    value="primary"
                    id="capture-displays-primary"
                  />
                  <Label htmlFor="capture-displays-primary">Primary only</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="all" id="capture-displays-all" />
                  <Label htmlFor="capture-displays-all">All displays</Label>
                </div>
              </RadioGroup>
            }
          />

          <SettingsRow
            label="AI diagnostics in debug log"
            help="AI sample/parse warnings are written to the developer console when the debug log is on. Same setting as Advanced → Debug log."
            control={
              <Switch
                checked={debugLogEnabled}
                onCheckedChange={(checked) =>
                  void setDebugLogEnabled(Boolean(checked))
                }
                aria-label="AI diagnostics in debug log"
              />
            }
          />

          {tokenPresent ? (
            <SettingsRow
              label="Hugging Face token"
              help="Stored in your OS keychain for gated model downloads (e.g. Gemma). Forgetting it does not delete already-downloaded models."
              control={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleForgetToken()}
                >
                  Forget
                </Button>
              }
            />
          ) : null}

          {sidecarStatus === 'errored' ? (
            <SettingsRow
              label="AI model crashed"
              help={
                sidecarLastError
                  ? `Last error: ${sidecarLastError}`
                  : 'The llama-server sidecar exhausted its restart budget.'
              }
              control={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleRestartSidecar()}
                  disabled={restarting || !activeModelId}
                >
                  Restart
                </Button>
              }
            />
          ) : null}
        </>
      )}

      <ScreenCapturePermissionOverlay
        open={permissionOverlayOpen}
        onOpenChange={setPermissionOverlayOpen}
        onRetry={() => void handleRetryPermission()}
      />
    </SettingsSection>
  )
}
