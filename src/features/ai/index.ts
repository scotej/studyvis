export {
  useSidecarStore,
  DEFAULT_CTX_SIZE,
  ERR_AI_DISABLED,
  ERR_BENCHMARK_REQUIRES_AI_OFF,
  ERR_ENGINE_NOT_INSTALLED,
  HEALTH_POLL_INTERVAL_MS,
  SIDECAR_HEALTH_RETRY_MS,
  SIDECAR_HEALTH_TIMEOUT_MS,
  __setSidecarRuntime,
  __resetSidecarRuntime,
} from './sidecar'
export type {
  SidecarRuntime,
  SidecarStatus,
  SidecarStartPurpose,
} from './sidecar'

export {
  getEngineRuntime,
  __setEngineRuntime,
  __resetEngineRuntime,
} from './engine'
export type {
  EngineDevice,
  EngineInfo,
  EngineSource,
  EnginePhase,
  EngineProgressEvent,
  EngineRuntime,
} from './engine'

export {
  AI_COMPUTE_DEVICE_CACHE_KEY,
  AI_COMPUTE_DEVICE_KEY,
  AI_HARDWARE_FILE,
  DEFAULT_AI_COMPUTE_DEVICE,
  aiHardwareIdentitiesEqual,
  clearCurrentAiHardwareIdentity,
  computeDeviceFingerprint,
  computeDeviceId,
  createAiComputeDeviceSelectionGuard,
  currentAiHardwareIdentity,
  hydrateAiComputeDeviceSelection,
  isAiHardwareIdentity,
  isAiComputeDeviceSelection,
  isResolvedAiHardwareIdentity,
  persistAiComputeDeviceSelection,
  readCachedAiComputeDeviceSelection,
  setCurrentAiHardwareIdentity,
} from './computeDevice'
export type {
  AiComputeDeviceSelection,
  AiComputeDeviceSelectionGuard,
  AiHardwareIdentity,
  AiHardwareTopologyDevice,
} from './computeDevice'

export {
  SUPPORTED_MODELS,
  getModel,
  modelCardGroups,
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
  InterruptedDownload,
} from './modelStore'

export { getAiEnableReadiness } from './benchmarkGate'
export type { AiEnableReadiness, AiEnableReadinessInput } from './benchmarkGate'

export {
  runBenchmark,
  summariseBenchmark,
  prepareBundledBenchmarkImages,
  isBenchmarkStale,
  currentInferenceEngineFingerprint,
  inferenceEngineFingerprintFor,
  INFERENCE_ENGINE_FINGERPRINT,
  __setBenchmarkRuntime,
  __resetBenchmarkRuntime,
  BENCHMARK_SAMPLE_COUNT,
} from './benchmark'
export type {
  BenchmarkResult,
  BenchmarkProgress,
  BenchmarkRuntime,
  BenchmarkImages,
  BenchmarkOptions,
  BenchmarkSamplesInput,
  ChatCompletionRequest,
} from './benchmark'

export {
  buildFocusRequest,
  topicTextBlock,
  FOCUS_MAX_TOKENS,
} from './focusRequest'
export type { FocusChatRequest, FocusRequestArgs } from './focusRequest'

export { captureFace, FACE_FRAME_SIZE, FACE_FRAME_QUALITY } from './captureFace'

export {
  captureScreen,
  requestScreenCapturePermission,
  preacquireScreenStream,
  takePendingScreenStream,
  discardPendingScreenStream,
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
  EncodeCompositeJpegRequest,
  CompositePlacementInput,
  SourceCrop,
} from './captureShared'

export { COMPOSITE_MAX_WIDTH, computeCompositeLayout } from './composite'
export type {
  FrameDims,
  CompositePlacement,
  CompositeLayout,
} from './composite'

export {
  FOCUS_SYSTEM_PROMPT,
  FOCUS_SYSTEM_PROMPT_VERSION,
} from './systemPrompt'

export { parseJudgment, isUncertainVerdict, SEVERITIES } from './parseJudgment'
export type {
  Severity,
  Judgment,
  SampleVerdict,
  UncertainVerdict,
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
export type {
  ModelPickerContainerHandle,
  ModelPickerContainerProps,
} from './ModelPickerContainer'

export {
  step as scoreMachineStep,
  initialScoreMachineState,
  normaliseThresholds,
  clampWarningThreshold,
  clampAlertThreshold,
  clampConfidenceFloor,
  SEVERITY_DEDUCTIONS,
  INITIAL_SCORE,
  SCORE_FLOOR,
  DEFAULT_WARNING_THRESHOLD,
  DEFAULT_ALERT_THRESHOLD,
  WARNING_THRESHOLD_MIN,
  WARNING_THRESHOLD_MAX,
  ALERT_THRESHOLD_MIN,
  ALERT_THRESHOLD_MAX,
  DEFAULT_CONFIDENCE_FLOOR,
  CONFIDENCE_FLOOR_MIN,
  CONFIDENCE_FLOOR_MAX,
} from './scoreMachine'
export type {
  ScoreMachineState,
  ScoreThresholds,
  ScoreEvent,
  StepInput,
  StepResult,
  InternalSeverity,
} from './scoreMachine'

export {
  useFocusStore,
  resetFocusForSessionStart,
  __setFocusStoreThresholdReader,
  __resetFocusStoreThresholdReader,
} from './focusStore'
export type { FocusStoreThresholdReader } from './focusStore'

export { useBreakStore } from './breakStore'

export { AiDialogWindow } from './AiDialogWindow'
export type { AiDialogWindowProps, AiDialogRuntime } from './AiDialogWindow'

export {
  handleUserText,
  parseAgentReply,
  AGENT_SYSTEM_PROMPT,
  AGENT_REQUEST_TIMEOUT_MS,
  AiAgentError,
  __setAiAgentRuntime,
  __resetAiAgentRuntime,
  getAiAgentRuntime,
} from './aiAgent'
export type {
  AgentIntent,
  AgentReply,
  AiAgentRuntime,
  BreakRequestPayload as AgentBreakRequestPayload,
  HandleUserTextInput,
  TopicChangePayload,
} from './aiAgent'

export {
  AI_DIALOG_WINDOW_LABEL,
  AI_DIALOG_BREAK_REQUEST,
  AI_DIALOG_BREAK_RESPONSE,
  AI_DIALOG_CONTEXT,
  AI_DIALOG_CONTEXT_REQUEST,
  AI_DIALOG_TOPIC_CHANGE,
} from './aiDialogChannels'
export type {
  AiDialogContextPayload,
  AiDialogTopicChangePayload,
  AiDialogBreakRequestPayload,
  BreakResponsePayload,
} from './aiDialogChannels'

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
  MAX_REQUEST_TIMEOUT_MS,
  REQUEST_TIMEOUT_P95_FACTOR,
  SCREEN_ACQUIRE_TIMEOUT_MS,
  effectiveRequestTimeoutMs,
  BATTERY_POLL_INTERVAL_MS,
  FALLBACK_SAMPLE_INTERVAL_SEC,
  MAX_SAMPLE_INTERVAL_SEC,
  effectiveIntervalSec,
  nextBackoffState,
  initialBackoffState,
  SLOW_TICK_FACTOR,
  BACKOFF_ENGAGE_AFTER,
  BACKOFF_RECOVER_AFTER,
  BACKOFF_MULTIPLIER,
  STALL_NOTICE_AFTER_MS,
  STALL_CHECK_INTERVAL_MS,
  SCHEDULER_LAG_MIN_MS,
  SCHEDULER_LAG_RATIO,
  schedulerLagIsMaterial,
  STARVE_PROBE_INTERVAL_MS,
  STARVE_THRESHOLD_MS,
  startStarveProbe,
} from './sampleLoop'
export type {
  SampleLoopRuntime,
  SampleLoopOptions,
  SampleLoopHandle,
  SampleLoopStartReason,
  SampleBlockReason,
  SampleRecoveryInfo,
  ScoreEventsDispatchContext,
  BackoffState,
  StarveProbe,
} from './sampleLoop'
