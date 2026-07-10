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
  CONFIDENCE_FLOOR_MAX,
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
import { strings } from '@/strings'

// A3 — the off-task-sensitivity slider's lowest user-reachable value. The
// programmatic floor CONFIDENCE_FLOOR_MIN is 0, which is the special "gate
// disabled / trust every off-task call" value; exposing it on the slider would
// make a full drag-left jump discontinuously from "skip almost every off-task
// call" (0.05) to "count every off-task call" (0) — the opposite of the
// fewer-false-alarms direction the user is dragging toward. We keep 0 as the
// internal disable and start the UI at 0.05.
const CONFIDENCE_FLOOR_UI_MIN = 0.05

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
  const offTaskConfidenceFloor = useSettingsStore(
    (s) => s.values.offTaskConfidenceFloor
  )
  const setWarningThreshold = useSettingsStore((s) => s.setWarningThreshold)
  const setAlertThreshold = useSettingsStore((s) => s.setAlertThreshold)
  const setOffTaskConfidenceFloor = useSettingsStore(
    (s) => s.setOffTaskConfidenceFloor
  )
  const setSampleIntervalSec = useSettingsStore((s) => s.setSampleIntervalSec)
  const debugLogEnabled = useSettingsStore((s) => s.values.debugLogEnabled)
  const setDebugLogEnabled = useSettingsStore((s) => s.setDebugLogEnabled)
  const captureDisplays = useSettingsStore((s) => s.values.captureDisplays)
  const setCaptureDisplays = useSettingsStore((s) => s.setCaptureDisplays)
  const copy = strings.settings.ai

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
      toast(copy.permissions.pickModelFirstBody)
    }
  }, [copy.permissions.pickModelFirstBody])

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
      toast.success(copy.permissions.grantedToast)
    } catch (err) {
      if (err instanceof CaptureError && err.code === 'screen_capture_denied') {
        // Still denied — keep the overlay up so the user can open Settings.
        return
      }
      toast.error(
        err instanceof Error
          ? err.message
          : copy.permissions.requestErrorFallback
      )
    }
  }, [copy.permissions])

  const handleForgetToken = useCallback(async () => {
    try {
      await getHfTokenRuntime().clear()
      await refreshTokenPresence()
      toast.success(copy.hfToken.removedToast)
    } catch (err) {
      toast.error(
        err instanceof Error
          ? `${copy.hfToken.removeErrorPrefix}${err.message}`
          : copy.hfToken.removeErrorPrefix.replace(/: $/, '.')
      )
    }
  }, [refreshTokenPresence, copy.hfToken])

  const handleRestartSidecar = useCallback(async () => {
    if (!activeModelId) {
      toast.error(copy.sidecar.pickModelFirstToast)
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
      toast.success(copy.sidecar.restartedToast)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : copy.sidecar.restartErrorFallback
      )
    } finally {
      setRestarting(false)
    }
  }, [activeModelId, copy.sidecar])

  // Clamp the displayed value through the SAME function the loop uses so the
  // slider can't show a value below `min` (a stale override saved on a faster
  // model, then switched to a slower one) and what the user sees matches
  // what the loop will actually run.
  const effectiveInterval = effectiveIntervalSec(
    measuredFloor,
    sampleIntervalSec
  )

  return (
    <SettingsSection heading={copy.heading}>
      <p className="mb-3 text-sm text-text-secondary">{copy.intro}</p>
      {/* D5 — canonical screen-recording indicator note. Only meaningful once
          AI can actually sample; with the gate off nothing records, so the
          three-sentence OS-indicator explainer would be noise above the only
          control on the pane. */}
      {aiFeaturesEnabled ? (
        <p className="mb-3 text-sm text-text-secondary">
          {copy.screenIndicatorNote}
        </p>
      ) : null}

      <SettingsRow
        label={copy.enable.label}
        help={copy.enable.help}
        control={
          <Switch
            checked={aiFeaturesEnabled}
            disabled={toggling}
            onCheckedChange={(checked) => void handleToggle(Boolean(checked))}
            aria-label={copy.enable.ariaLabel}
          />
        }
      />

      {!aiFeaturesEnabled ? (
        <SettingsRow label={copy.modelOff.label} help={copy.modelOff.help} />
      ) : (
        <>
          <div className="pt-4">
            <ModelPickerContainer />
          </div>

          <SettingsRow
            label={copy.sampleInterval.label}
            stack
            help={copy.sampleInterval.help(
              measuredFloor,
              MAX_SAMPLE_INTERVAL_SEC
            )}
            control={
              <div className="flex items-center gap-4">
                <Slider
                  className="w-full"
                  min={measuredFloor}
                  // Keep the Radix range valid when a slow model's measured
                  // floor exceeds the ceiling (min must never be > max).
                  max={Math.max(measuredFloor, MAX_SAMPLE_INTERVAL_SEC)}
                  step={1}
                  value={[effectiveInterval]}
                  onValueChange={([v]) =>
                    void setSampleIntervalSec(v <= measuredFloor ? null : v)
                  }
                  aria-label={copy.sampleInterval.ariaLabel}
                />
                <span className="w-16 shrink-0 text-right text-sm tabular-nums text-text-secondary">
                  {effectiveInterval}s
                </span>
              </div>
            }
          />

          <SettingsRow
            label={copy.warnAfter.label}
            stack
            help={copy.warnAfter.help}
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
                  aria-label={copy.warnAfter.ariaLabel}
                />
                <span className="w-16 shrink-0 text-right text-sm tabular-nums text-text-secondary">
                  {warningThreshold}
                </span>
              </div>
            }
          />

          <SettingsRow
            label={copy.alertAfter.label}
            stack
            help={copy.alertAfter.help}
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
                  aria-label={copy.alertAfter.ariaLabel}
                />
                <span className="w-16 shrink-0 text-right text-sm tabular-nums text-text-secondary">
                  {alertThreshold}
                </span>
              </div>
            }
          />

          <SettingsRow
            label={copy.confidenceFloor.label}
            stack
            help={copy.confidenceFloor.help}
            control={
              <div className="flex items-center gap-4">
                <Slider
                  className="w-full"
                  min={CONFIDENCE_FLOOR_UI_MIN}
                  max={CONFIDENCE_FLOOR_MAX}
                  step={0.05}
                  // Clamp the displayed value up to the UI min so a 0 persisted
                  // by an older build (or a hand-edited settings.json) can't
                  // park the thumb past the slider's left edge.
                  value={[
                    Math.max(CONFIDENCE_FLOOR_UI_MIN, offTaskConfidenceFloor),
                  ]}
                  onValueChange={([v]) => void setOffTaskConfidenceFloor(v)}
                  aria-label={copy.confidenceFloor.ariaLabel}
                />
                <span className="w-16 shrink-0 text-right text-sm tabular-nums text-text-secondary">
                  {Math.round(
                    Math.max(CONFIDENCE_FLOOR_UI_MIN, offTaskConfidenceFloor) *
                      100
                  )}
                  %
                </span>
              </div>
            }
          />

          <SettingsRow
            label={copy.captureDisplays.label}
            stack
            help={copy.captureDisplays.help}
            control={
              <RadioGroup
                value={captureDisplays}
                onValueChange={(value) => {
                  if (isCaptureDisplaysMode(value)) {
                    void setCaptureDisplays(value as CaptureDisplaysMode)
                  }
                }}
                className="grid-cols-1 gap-3 sm:grid-cols-none sm:grid-flow-col sm:auto-cols-max sm:gap-6"
                aria-label={copy.captureDisplays.ariaLabel}
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem
                    value="primary"
                    id="capture-displays-primary"
                  />
                  <Label htmlFor="capture-displays-primary">
                    {copy.captureDisplays.options.primary}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="all" id="capture-displays-all" />
                  <Label htmlFor="capture-displays-all">
                    {copy.captureDisplays.options.all}
                  </Label>
                </div>
              </RadioGroup>
            }
          />

          <SettingsRow
            label={copy.diagnostics.label}
            help={copy.diagnostics.help}
            control={
              <Switch
                checked={debugLogEnabled}
                onCheckedChange={(checked) =>
                  void setDebugLogEnabled(Boolean(checked))
                }
                aria-label={copy.diagnostics.ariaLabel}
              />
            }
          />

          {tokenPresent ? (
            <SettingsRow
              label={copy.hfToken.label}
              help={copy.hfToken.help}
              control={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleForgetToken()}
                >
                  {copy.hfToken.forgetCta}
                </Button>
              }
            />
          ) : null}

          {sidecarStatus === 'errored' ? (
            <SettingsRow
              label={copy.sidecar.label}
              help={
                sidecarLastError
                  ? copy.sidecar.helpLastError(sidecarLastError)
                  : copy.sidecar.helpExhausted
              }
              control={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleRestartSidecar()}
                  disabled={restarting || !activeModelId}
                >
                  {copy.sidecar.restartCta}
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
