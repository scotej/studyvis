export {
  useSidecarStore,
  DEFAULT_CTX_SIZE,
  ERR_AI_DISABLED,
  HEALTH_POLL_INTERVAL_MS,
  __setSidecarRuntime,
  __resetSidecarRuntime,
} from './sidecar'
export type { SidecarRuntime, SidecarStatus } from './sidecar'

export {
  SUPPORTED_MODELS,
  getModel,
  tierLabel,
  totalDownloadBytes,
  modelDownloadUrls,
  huggingfaceResolveUrl,
} from './models'
export type { ModelSpec, ModelTier, ModelFileSpec } from './models'

export {
  __setDownloadRuntime,
  __resetDownloadRuntime,
  getDownloadRuntime,
  specToFileRequests,
} from './download'
export type {
  DownloadRuntime,
  ModelInstallState,
  ModelFileState,
  ModelPaths,
  ProgressEvent,
  ProgressPhase,
  ModelFileKind,
  HeadResult,
  DownloadFileRequest,
} from './download'

export {
  __setHfTokenRuntime,
  __resetHfTokenRuntime,
  getHfTokenRuntime,
} from './hfToken'
export type { HfTokenRuntime } from './hfToken'

export {
  useModelStore,
  __setModelStoreDeps,
  __resetModelStoreDeps,
} from './modelStore'
export type {
  ModelRecord,
  ModelStoreSnapshot,
  ModelStoreDeps,
} from './modelStore'

export {
  runBenchmark,
  summariseBenchmark,
  loadBundledBenchmarkImage,
  __setBenchmarkRuntime,
  __resetBenchmarkRuntime,
  BENCHMARK_SAMPLE_COUNT,
} from './benchmark'
export type {
  BenchmarkResult,
  BenchmarkProgress,
  BenchmarkRuntime,
  BenchmarkOptions,
  BenchmarkSamplesInput,
  ChatCompletionRequest,
  ChatMessage,
  ChatContentBlock,
} from './benchmark'

export { captureFace, FACE_FRAME_SIZE, FACE_FRAME_QUALITY } from './captureFace'

export {
  captureScreen,
  requestScreenCapturePermission,
  SCREEN_FRAME_MAX_WIDTH,
  SCREEN_FRAME_QUALITY,
  __setScreenCaptureRuntime,
  __resetScreenCaptureRuntime,
} from './captureScreen'
export type { ScreenCaptureRuntime } from './captureScreen'

export {
  CaptureError,
  fitWidth,
  __setCaptureRuntime,
  __resetCaptureRuntime,
  getCaptureRuntime,
} from './captureShared'
export type {
  CaptureRuntime,
  CaptureFrame,
  CaptureErrorCode,
  EncodeJpegRequest,
  SourceCrop,
} from './captureShared'

export {
  FOCUS_SYSTEM_PROMPT,
  FOCUS_SYSTEM_PROMPT_VERSION,
} from './systemPrompt'

export {
  parseJudgment,
  SEVERITIES,
  __setParseLogger,
  __resetParseLogger,
} from './parseJudgment'
export type {
  Severity,
  Judgment,
  ParseResult,
  ParseSuccess,
  ParseFallback,
} from './parseJudgment'

export { ModelPicker } from './ModelPicker'
export type {
  ModelPickerProps,
  PickerStateForModel,
  PickerActions,
  DownloadPhase,
} from './ModelPicker'
export {
  emptyPickerState,
  progressEventToPhase,
  downloadFraction,
} from './picker-helpers'
export { ModelGuide } from './ModelGuide'
export type { ModelGuideProps } from './ModelGuide'
export { ModelPickerContainer } from './ModelPickerContainer'

export {
  step as scoreMachineStep,
  initialScoreMachineState,
  normaliseThresholds,
  clampWarningThreshold,
  clampAlertThreshold,
  SEVERITY_DEDUCTIONS,
  INITIAL_SCORE,
  SCORE_FLOOR,
  DEFAULT_WARNING_THRESHOLD,
  DEFAULT_ALERT_THRESHOLD,
  WARNING_THRESHOLD_MIN,
  WARNING_THRESHOLD_MAX,
  ALERT_THRESHOLD_MIN,
  ALERT_THRESHOLD_MAX,
} from './scoreMachine'
export type {
  ScoreMachineState,
  ScoreThresholds,
  ScoreEvent,
  StepInput,
  StepResult,
} from './scoreMachine'

export {
  useFocusStore,
  __setFocusStoreThresholdReader,
  __resetFocusStoreThresholdReader,
} from './focusStore'
export type { FocusStoreThresholdReader } from './focusStore'

export { useBreakStore } from './breakStore'

export {
  useAlertsUiStore,
  __setAlertsUiRuntime,
  __resetAlertsUiRuntime,
  PEER_ALERT_TTL_MS,
  WARNING_TTL_MS,
} from './alertsUiStore'
export type {
  AlertSeverity,
  SelfWarningState,
  AlertedPeerEntry,
  AlertsUiRuntime,
} from './alertsUiStore'

export {
  playPeerAlertSound,
  alertSoundUrl,
  __setAlertSoundRuntime,
  __resetAlertSoundRuntime,
} from './alertSound'
export type { AlertSoundRuntime } from './alertSound'

export {
  BATTERY_PAUSE_PERCENT,
  shouldPauseForBattery,
  getBatteryRuntime,
  __setBatteryRuntime,
  __resetBatteryRuntime,
} from './battery'
export type { BatteryInfo, BatteryRuntime } from './battery'

export {
  startSampleLoop,
  __setSampleLoopRuntime,
  __resetSampleLoopRuntime,
  getSampleLoopRuntime,
  REQUEST_TIMEOUT_MS,
  BATTERY_POLL_INTERVAL_MS,
  FALLBACK_SAMPLE_INTERVAL_SEC,
} from './sampleLoop'
export type {
  SampleLoopRuntime,
  SampleLoopOptions,
  SampleLoopHandle,
  SampleLoopStartReason,
} from './sampleLoop'
