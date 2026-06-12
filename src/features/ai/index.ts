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
  InterruptedDownload,
} from './modelStore'

export {
  runBenchmark,
  summariseBenchmark,
  prepareBundledBenchmarkImages,
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

export {
  parseJudgment,
  isUncertainVerdict,
  SEVERITIES,
  __setParseLogger,
  __resetParseLogger,
} from './parseJudgment'
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
} from './sampleLoop'
export type {
  SampleLoopRuntime,
  SampleLoopOptions,
  SampleLoopHandle,
  SampleLoopStartReason,
  BackoffState,
} from './sampleLoop'
