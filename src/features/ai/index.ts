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
