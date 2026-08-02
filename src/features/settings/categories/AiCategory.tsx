import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { ScreenCapturePermissionOverlay } from '@/components/ScreenCapturePermissionOverlay'
import {
  SettingsRow,
  SettingsSection,
  settingsRowChrome,
} from '@/components/SettingsRow'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
  getAiEnableReadiness,
  getDownloadRuntime,
  getEngineRuntime,
  getHfTokenRuntime,
  getModel,
  MAX_SAMPLE_INTERVAL_SEC,
  ModelPickerContainer,
  preacquireScreenStream,
  requestScreenCapturePermission,
  useModelStore,
  useSidecarStore,
  WARNING_THRESHOLD_MAX,
  WARNING_THRESHOLD_MIN,
  type EngineInfo,
  type EngineProgressEvent,
  type ModelPickerContainerHandle,
} from '@/features/ai'
import { useSessionStore } from '@/stores/sessionStore'
import {
  isCaptureDisplaysMode,
  useSettingsStore,
  type CaptureDisplaysMode,
} from '@/stores/settingsStore'
import { strings } from '@/strings'

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// A3 — the off-task-sensitivity slider's lowest user-reachable value. The
// programmatic floor CONFIDENCE_FLOOR_MIN is 0, which is the special "gate
// disabled / trust every off-task call" value; exposing it on the slider would
// make a full drag-left jump discontinuously from "skip almost every off-task
// call" (0.05) to "count every off-task call" (0) — the opposite of the
// fewer-false-alarms direction the user is dragging toward. We keep 0 as the
// internal disable and start the UI at 0.05.
const CONFIDENCE_FLOOR_UI_MIN = 0.05

// The master AI gate controls live capture and scoring, not model setup.
// Downloads, selection, engine setup, and optional benchmarks remain available
// while AI is off. Side-effects (permission seed on enable, sidecar stop on
// disable) are orchestrated here so the settings store stays in the `@/stores`
// layer with no `@/features/ai` import.
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
  const engineAutoInstall = useSettingsStore((s) => s.values.engineAutoInstall)
  const setEngineAutoInstall = useSettingsStore((s) => s.setEngineAutoInstall)
  const sessionActive = useSessionStore((s) => s.status === 'active')
  const copy = strings.settings.ai

  const activeModelId = useModelStore((s) => s.activeModelId)
  const modelStatus = useModelStore((s) => s.status)
  const modelRecords = useModelStore((s) => s.records)
  const measuredSampleInterval = activeModelId
    ? modelRecords[activeModelId]?.benchmark?.sampleIntervalSec
    : undefined
  const hasMeasuredFloor =
    typeof measuredSampleInterval === 'number' && measuredSampleInterval >= 1
  const measuredFloor = hasMeasuredFloor
    ? (measuredSampleInterval as number)
    : FALLBACK_SAMPLE_INTERVAL_SEC

  const sidecarStatus = useSidecarStore((s) => s.status)
  const sidecarLastError = useSidecarStore((s) => s.lastError)

  const [permissionOverlayOpen, setPermissionOverlayOpen] = useState(false)
  const [benchmarkWarningOpen, setBenchmarkWarningOpen] = useState(false)
  const [modelSetupBusy, setModelSetupBusy] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [tokenPresent, setTokenPresent] = useState<boolean | null>(null)
  const [engineInfo, setEngineInfo] = useState<EngineInfo | null>(null)
  const [engineProgress, setEngineProgress] =
    useState<EngineProgressEvent | null>(null)
  const [installingEngine, setInstallingEngine] = useState(false)
  const modelPickerSectionRef = useRef<HTMLDivElement>(null)
  const modelPickerRef = useRef<ModelPickerContainerHandle>(null)

  const refreshEngineInfo = useCallback(async () => {
    try {
      setEngineInfo(await getEngineRuntime().info())
    } catch {
      setEngineInfo(null)
    }
  }, [])

  // Engine setup remains visible while AI is off, so keep presence and live
  // install progress current for the whole time this settings pane is open.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot engine presence check: refreshEngineInfo awaits the Tauri command before any setState fires (same suppression as refreshTokenPresence above).
    void refreshEngineInfo()
    let unlisten: (() => void) | null = null
    let disposed = false
    void getEngineRuntime()
      .subscribeProgress((event) => {
        if (event.phase === 'done' || event.phase === 'failed') {
          setEngineProgress(null)
          void refreshEngineInfo()
        } else {
          setEngineProgress(event)
        }
      })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [refreshEngineInfo])

  const refreshTokenPresence = useCallback(async () => {
    try {
      setTokenPresent(await getHfTokenRuntime().present())
    } catch {
      setTokenPresent(null)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot keychain presence check: refreshTokenPresence awaits the Tauri command before any setState fires (same suppression as SessionsCategory / useIdentity.refresh).
    void refreshTokenPresence()
  }, [refreshTokenPresence])

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

  const applyToggle = useCallback(
    async (next: boolean) => {
      // V2-P9 gesture fix — when a session is already running, flipping AI
      // on fires sampleLoop's boot() from a useEffect the instant
      // aiFeaturesEnabled lands, with no gesture of its own to acquire the
      // long-lived screen stream. THIS click is the only gesture available,
      // so pre-acquire (stashed for boot() to consume) before any of the
      // slower `setAiFeaturesEnabled` IPC round-trips below can eat the
      // transient-activation window. Must run before any `await`.
      if (next && sessionActive) {
        void preacquireScreenStream()
      }
      setToggling(true)
      try {
        await setAiFeaturesEnabled(next)
        if (next) {
          // The pre-acquire above already covers the mid-session case;
          // seeding again here would be a second getDisplayMedia() call
          // with no gesture left to satisfy it.
          if (!sessionActive) await seedScreenPermission()
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
    [seedScreenPermission, setAiFeaturesEnabled, sessionActive]
  )

  const handleToggle = useCallback(
    (next: boolean) => {
      if (!next) {
        void applyToggle(false)
        return
      }

      if (
        modelSetupBusy ||
        (!aiFeaturesEnabled &&
          (sidecarStatus === 'starting' ||
            sidecarStatus === 'running' ||
            sidecarStatus === 'stopping'))
      ) {
        toast.info(copy.enable.benchmarkBusyToast)
        return
      }

      const readiness = getAiEnableReadiness({
        status: modelStatus,
        activeModelId,
        records: modelRecords,
      })
      if (readiness === 'loading') {
        toast.info(copy.enable.loadingToast)
        return
      }
      if (readiness === 'error') {
        toast.error(copy.enable.modelErrorToast)
        return
      }
      if (readiness === 'no-model') {
        toast.info(copy.enable.pickModelFirstToast)
        modelPickerSectionRef.current?.scrollIntoView({ block: 'start' })
        return
      }
      if (readiness === 'unbenchmarked') {
        setBenchmarkWarningOpen(true)
        return
      }
      void applyToggle(true)
    },
    [
      activeModelId,
      aiFeaturesEnabled,
      applyToggle,
      copy.enable,
      modelRecords,
      modelSetupBusy,
      modelStatus,
      sidecarStatus,
    ]
  )

  const handleBenchmarkFirst = useCallback(() => {
    setBenchmarkWarningOpen(false)
    modelPickerSectionRef.current?.scrollIntoView({ block: 'start' })
    modelPickerRef.current?.benchmarkSelected()
  }, [])

  const handleEnableAnyway = useCallback(() => {
    setBenchmarkWarningOpen(false)
    // This callback is the user's click. applyToggle pre-acquires the screen
    // stream synchronously before its first await when a session is active.
    void applyToggle(true)
  }, [applyToggle])

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

  // Reinstall stops a running sidecar first (Rust side does it too — Windows
  // can't swap loaded DLLs), so mid-session it would kill the live AI loop;
  // the button is locked during sessions like the model picker's actions.
  const handleInstallEngine = useCallback(async () => {
    setInstallingEngine(true)
    try {
      await getEngineRuntime().install()
      await refreshEngineInfo()
      toast.success(copy.engine.installedToast)
    } catch {
      // The row's help shows the persisted last_error after refresh; the
      // toast stays calm instead of relaying a raw backend string.
      await refreshEngineInfo()
      toast.error(copy.engine.installErrorFallback)
    } finally {
      setInstallingEngine(false)
    }
  }, [copy.engine, refreshEngineInfo])

  const engineBusy =
    installingEngine ||
    engineProgress !== null ||
    (engineInfo?.installing ?? false)

  const engineHelp = (() => {
    if (engineProgress) {
      if (engineProgress.phase === 'verifying') return copy.engine.helpVerifying
      if (engineProgress.phase === 'extracting')
        return copy.engine.helpExtracting
      return engineProgress.total_bytes > 0
        ? copy.engine.helpDownloading(
            formatMb(engineProgress.bytes_received),
            formatMb(engineProgress.total_bytes)
          )
        : copy.engine.helpDownloadingIndeterminate(
            formatMb(engineProgress.bytes_received)
          )
    }
    if (!engineInfo) return copy.engine.helpMissingManual
    if (!engineInfo.supported) return copy.engine.helpUnsupported
    if (engineInfo.installing) return copy.engine.helpExtracting
    if (engineInfo.installed) {
      return engineInfo.source === 'bundled'
        ? copy.engine.helpBundled(engineInfo.version)
        : copy.engine.helpManaged(engineInfo.version)
    }
    if (engineInfo.last_error)
      return copy.engine.helpInstallError(engineInfo.last_error)
    return engineAutoInstall
      ? copy.engine.helpMissingAuto
      : copy.engine.helpMissingManual
  })()

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
      {/* No own margin: the h2's mb-3 above and the first row's py-4 below
          already carry the section rhythm. */}
      <p className="text-sm text-text-secondary">{copy.intro}</p>

      <SettingsRow
        label={copy.enable.label}
        help={copy.enable.help}
        control={
          <Switch
            checked={aiFeaturesEnabled}
            disabled={toggling || (!aiFeaturesEnabled && modelSetupBusy)}
            onCheckedChange={(checked) => void handleToggle(Boolean(checked))}
            aria-label={copy.enable.ariaLabel}
          />
        }
      />

      {!aiFeaturesEnabled ? (
        <SettingsRow label={copy.modelOff.label} help={copy.modelOff.help} />
      ) : (
        // D5 — only meaningful while AI can sample.
        <p className={cn(settingsRowChrome, 'text-sm text-text-secondary')}>
          {copy.screenIndicatorNote}
        </p>
      )}

      <div ref={modelPickerSectionRef} className={settingsRowChrome}>
        <ModelPickerContainer
          ref={modelPickerRef}
          onBusyChange={setModelSetupBusy}
        />
      </div>

      <SettingsRow
        label={copy.engine.label}
        help={
          // Progress is conveyed as text (no spinner, DESIGN-SYSTEM §10);
          // the live region announces phase changes to screen readers.
          <span role="status" aria-live="polite">
            {engineHelp}
          </span>
        }
        control={
          engineInfo?.supported === false ? undefined : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleInstallEngine()}
              disabled={
                engineBusy ||
                modelSetupBusy ||
                (sessionActive && aiFeaturesEnabled)
              }
              aria-label={copy.engine.installAria}
            >
              {engineInfo?.installed
                ? copy.engine.reinstallCta
                : copy.engine.installCta}
            </Button>
          )
        }
      />

      <SettingsRow
        label={copy.engine.auto.label}
        help={copy.engine.auto.help}
        control={
          <Switch
            checked={engineAutoInstall}
            onCheckedChange={(checked) =>
              void setEngineAutoInstall(Boolean(checked))
            }
            aria-label={copy.engine.auto.ariaLabel}
          />
        }
      />

      {aiFeaturesEnabled ? (
        <>
          <SettingsRow
            label={copy.sampleInterval.label}
            stack
            help={
              hasMeasuredFloor
                ? copy.sampleInterval.helpMeasured(
                    measuredFloor,
                    MAX_SAMPLE_INTERVAL_SEC
                  )
                : copy.sampleInterval.helpDefault(
                    measuredFloor,
                    MAX_SAMPLE_INTERVAL_SEC
                  )
            }
            control={
              <div className="flex max-w-md items-center gap-4">
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
              <div className="flex max-w-md items-center gap-4">
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
              <div className="flex max-w-md items-center gap-4">
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
              <div className="flex max-w-md items-center gap-4">
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
                className="grid-flow-col auto-cols-max gap-6"
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
      ) : null}

      <Dialog
        open={benchmarkWarningOpen}
        onOpenChange={setBenchmarkWarningOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.benchmarkWarning.title}</DialogTitle>
            <DialogDescription>
              {copy.benchmarkWarning.description(
                (activeModelId && getModel(activeModelId)?.displayName) ||
                  copy.benchmarkWarning.fallbackModelName,
                FALLBACK_SAMPLE_INTERVAL_SEC
              )}{' '}
              {copy.benchmarkWarning.recommendation}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setBenchmarkWarningOpen(false)}
            >
              {copy.benchmarkWarning.keepOffCta}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleEnableAnyway}
              disabled={toggling}
            >
              {copy.benchmarkWarning.enableAnywayCta}
            </Button>
            <Button type="button" onClick={handleBenchmarkFirst}>
              {copy.benchmarkWarning.benchmarkFirstCta}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ScreenCapturePermissionOverlay
        open={permissionOverlayOpen}
        onOpenChange={setPermissionOverlayOpen}
        onRetry={() => void handleRetryPermission()}
      />
    </SettingsSection>
  )
}
