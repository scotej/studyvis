// First-run benchmark: spin up the sidecar with the chosen model, send 3
// fixed chat-completions requests built from a bundled desk image (re-encoded
// into a 384×384 face JPEG + a 1024×576 screen JPEG so the two slots mirror the
// live tick's real prefill cost), measure per-request latency. Results feed
// `useModelStore.recordBenchmark` so the picker can show "Speed on your
// machine" and the AI sample loop (V2-P5) can pick a
// `sample_interval = max(5, ceil(p95 + 1))`.
//
// `p50` and `p95` from 3 samples are coarse — we document this explicitly
// rather than pretending 3 samples produce true percentiles. The number is
// honest enough to choose between "fastest" (~3 s/check) and "heaviest"
// (~25 s/check), which is the only call the user is making.

import benchmarkImageUrl from './assets/benchmark-desk.png'
import { FACE_FRAME_QUALITY, FACE_FRAME_SIZE } from './captureFace'
import { SCREEN_FRAME_MAX_WIDTH, SCREEN_FRAME_QUALITY } from './captureScreen'
import { getCaptureRuntime, type CaptureFrame } from './captureShared'
import { buildFocusRequest, type FocusChatRequest } from './focusRequest'
import type { ModelSpec } from './models'
import { useSidecarStore } from './sidecar'

export const BENCHMARK_SAMPLE_COUNT = 3

// A1/NEW-FINDING-2 — the live screen frame is downscaled to up to
// SCREEN_FRAME_MAX_WIDTH (1024) wide; the bundled benchmark asset is only
// 384×384. For a fixed-grid ViT (Moondream2, Gemma) image area is irrelevant,
// but Qwen2.5-VL is a dynamic-resolution ViT in llama.cpp — its vision-token
// count scales with image area, so a 384-wide screen slot costs ~3-4× less
// prefill than a real 1024-wide screen frame. That makes p95 → sampleIntervalSec
// understate live cost (and over-trips A6's backoff, which also keys off this
// p95). So the benchmark letterboxes the bundled asset onto a 1024×576 (16:9)
// screen-sized JPEG for the SCREEN slot — close to a typical real screen frame's
// area — while the FACE slot stays at the live 384×384. Both slots are JPEG
// (matching the live tick); only the pixels are synthetic.
const BENCHMARK_SCREEN_WIDTH = SCREEN_FRAME_MAX_WIDTH
const BENCHMARK_SCREEN_HEIGHT = Math.round((SCREEN_FRAME_MAX_WIDTH * 9) / 16)
// A1 — the benchmark now sends the SAME request shape as the live focus tick
// (two images, the full FOCUS_SYSTEM_PROMPT, grammar-constrained 200-token
// decode) via `buildFocusRequest`, so the p95 it measures reflects real
// per-tick cost. A representative topic keeps the prompt prefill identical in
// structure to a real session.
const BENCHMARK_TOPIC = 'Studying'

export type BenchmarkResult = {
  // Wall-clock seconds per chat-completion request, in invocation order.
  samplesSec: number[]
  // p50 = sorted samples middle value; with n=3 this is sorted[1].
  p50Sec: number
  // p95 = sorted samples top value; with n=3 this is sorted[2] (max).
  // Coarse but adequate for picking sample cadence.
  p95Sec: number
  // ARCHITECTURE.md §8: sample_interval = max(5, ceil(p95 + 1))
  sampleIntervalSec: number
  // Unix epoch seconds when the benchmark completed.
  completedAtSec: number
}

export type BenchmarkProgress =
  | { phase: 'starting-sidecar' }
  | { phase: 'loading-image' }
  | { phase: 'warmup' }
  | { phase: 'sample'; index: number; total: number }
  | { phase: 'done'; result: BenchmarkResult }

// A1/NEW-FINDING-2 — the two image slots the benchmark request carries. The
// FACE slot mirrors the live 384×384 camera frame; the SCREEN slot mirrors the
// live ~1024-wide screen frame so the measured p95 reflects real prefill cost
// on a dynamic-resolution ViT (Qwen2.5-VL). Both are JPEG, like the live tick.
export type BenchmarkImages = {
  faceBase64: string
  screenBase64: string
  mimeType: string
}

export type BenchmarkRuntime = {
  prepareImages: () => Promise<BenchmarkImages>
  startSidecar: (params: {
    modelPath: string
    mmprojPath: string | null
    ctxSize: number
  }) => Promise<{ port: number }>
  stopSidecar: () => Promise<void>
  // Wait for the sidecar's HTTP server to be ready. Returns once /health
  // responds 2xx; rejects if the sidecar errors out.
  waitForHealthy: (port: number, timeoutMs: number) => Promise<void>
  // Run a single chat completion and return wall-clock seconds. Implementations
  // SHOULD set a reasonable per-request timeout themselves; the runtime here
  // doesn't enforce one because llama-server's first inference is the model
  // warmup, which can legitimately take 30-90s on CPU.
  runChatCompletion: (
    port: number,
    body: ChatCompletionRequest
  ) => Promise<number>
  now: () => number
}

// A1 — the benchmark request body is now the shared focus request shape, so
// the runtime carries the same type the live loop + eval harness send.
export type ChatCompletionRequest = FocusChatRequest

const HEALTH_TIMEOUT_MS = 90_000 // covers cold-start projector load on CPU

// Decode the bundled desk PNG and re-encode it into the two JPEG slots the
// live tick sends: a 384×384 face frame and a 1024×576 screen frame. Routing
// through the shared CaptureRuntime encoder keeps the screen slot's area (and
// thus Qwen vision-token cost) representative of a real session. Uses
// createImageBitmap + OffscreenCanvas, so it only runs in the real
// app/Storybook DOM — unit tests stub `prepareImages` (same as the old
// `loadBenchmarkImage`).
export async function prepareBundledBenchmarkImages(): Promise<BenchmarkImages> {
  // Vite resolves the import to a URL we fetch at runtime; the PNG is bundled
  // into dist as a hashed asset, so this works in dev, production, Storybook.
  const response = await fetch(benchmarkImageUrl)
  if (!response.ok) {
    throw new Error(
      `failed to load bundled benchmark image (HTTP ${response.status})`
    )
  }
  const blob = await response.blob()
  const bitmap = await createImageBitmap(blob)
  const frame: CaptureFrame = {
    bitmap,
    sourceWidth: bitmap.width,
    sourceHeight: bitmap.height,
  }
  const cap = getCaptureRuntime()
  try {
    const faceBase64 = await cap.encodeJpegBase64({
      frame,
      targetWidth: FACE_FRAME_SIZE,
      targetHeight: FACE_FRAME_SIZE,
      quality: FACE_FRAME_QUALITY,
    })
    const screenBase64 = await cap.encodeJpegBase64({
      frame,
      targetWidth: BENCHMARK_SCREEN_WIDTH,
      targetHeight: BENCHMARK_SCREEN_HEIGHT,
      quality: SCREEN_FRAME_QUALITY,
    })
    return { faceBase64, screenBase64, mimeType: 'image/jpeg' }
  } finally {
    cap.disposeFrame(frame)
  }
}

const defaultRuntime: BenchmarkRuntime = {
  prepareImages: prepareBundledBenchmarkImages,
  startSidecar: async ({ modelPath, mmprojPath, ctxSize }) => {
    const port = await useSidecarStore
      .getState()
      .start({ modelPath, mmprojPath, ctxSize })
    if (port == null) {
      const err = useSidecarStore.getState().lastError
      throw new Error(err ?? 'sidecar_start returned null')
    }
    return { port }
  },
  stopSidecar: async () => {
    await useSidecarStore.getState().stop()
  },
  waitForHealthy: async (port, timeoutMs) => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`)
        if (res.ok) return
      } catch {
        // probe failed; retry until the deadline
      }
      await sleep(500)
    }
    throw new Error(`sidecar /health did not return 2xx within ${timeoutMs} ms`)
  },
  runChatCompletion: async (port, body) => {
    // Generous upper bound: warmup on a CPU-only 7B run is ~60–90 s; subsequent
    // samples land in 15–30 s. 5 minutes covers warmup + a wide tail. Without
    // an abort, a hung llama-server (or stalled connection) would block the
    // benchmark indefinitely and prevent runBenchmark's `finally` from
    // stopping the sidecar.
    const REQUEST_TIMEOUT_MS = 5 * 60 * 1000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const start = performance.now()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(
          `chat/completions returned HTTP ${res.status}${text ? `: ${text}` : ''}`
        )
      }
      // Drain the body so the connection is reusable; we don't care about the
      // text for the benchmark.
      await res.text()
      return (performance.now() - start) / 1000
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(
          `The model didn't respond within ${REQUEST_TIMEOUT_MS / 1000}s. It may be stuck; try restarting it.`,
          { cause: err }
        )
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  },
  now: () => Date.now(),
}

let activeRuntime: BenchmarkRuntime = defaultRuntime

export function __setBenchmarkRuntime(runtime: BenchmarkRuntime): void {
  activeRuntime = runtime
}

export function __resetBenchmarkRuntime(): void {
  activeRuntime = defaultRuntime
}

export function getBenchmarkRuntime(): BenchmarkRuntime {
  return activeRuntime
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export type BenchmarkOptions = {
  ctxSize?: number
  // The picker passes resolved absolute paths from `model_paths`.
  modelPath: string
  mmprojPath: string
  onProgress?: (p: BenchmarkProgress) => void
}

export type BenchmarkSamplesInput = {
  samplesSec: number[]
  completedAtSec: number
}

export function summariseBenchmark({
  samplesSec,
  completedAtSec,
}: BenchmarkSamplesInput): BenchmarkResult {
  if (samplesSec.length === 0) {
    throw new Error('benchmark requires at least one sample')
  }
  const sorted = [...samplesSec].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const p50Sec =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  const p95Sec = sorted[sorted.length - 1]
  const sampleIntervalSec = Math.max(5, Math.ceil(p95Sec + 1))
  return { samplesSec, p50Sec, p95Sec, sampleIntervalSec, completedAtSec }
}

// Turns a label like "model.gguf" path into a stable model-string for the
// chat completion request body. llama-server's OpenAI-compatible endpoint
// accepts an arbitrary string here when only one model is loaded at a time,
// but logs/UIs surface it, so we use the registry's id.
export async function runBenchmark(
  spec: ModelSpec,
  opts: BenchmarkOptions
): Promise<BenchmarkResult> {
  const runtime = activeRuntime
  const onProgress = opts.onProgress ?? (() => {})
  onProgress({ phase: 'loading-image' })
  const images = await runtime.prepareImages()

  onProgress({ phase: 'starting-sidecar' })

  const samplesSec: number[] = []
  try {
    const { port } = await runtime.startSidecar({
      modelPath: opts.modelPath,
      mmprojPath: opts.mmprojPath,
      ctxSize: opts.ctxSize ?? 4096,
    })
    await runtime.waitForHealthy(port, HEALTH_TIMEOUT_MS)

    // A1 — mirror the live tick's two-image shape (a camera frame + a screen
    // frame). NEW-FINDING-2: the two slots now carry distinct re-encodes of the
    // bundled asset — a 384×384 face and a 1024×576 screen — so the measured
    // p95 reflects the real per-tick prefill cost (the screen slot's larger
    // area is what a dynamic-resolution ViT like Qwen2.5-VL actually pays for).
    const requestBody = buildFocusRequest({
      modelId: spec.id,
      topic: BENCHMARK_TOPIC,
      faceBase64: images.faceBase64,
      screenBase64: images.screenBase64,
      imageMimeType: images.mimeType,
    })

    // Discard one cold-start sample before measuring. Model load + first
    // inference is dramatically slower than steady state (CPU 7B warmup
    // ~60–90 s vs subsequent 15–30 s). Including it made p95 = the warmup
    // sample, inflating `sampleIntervalSec` 5–10× — and `sampleLoop`'s
    // floor clamp then prevented the user from lowering it.
    onProgress({ phase: 'warmup' })
    await runtime.runChatCompletion(port, requestBody)

    for (let i = 0; i < BENCHMARK_SAMPLE_COUNT; i += 1) {
      onProgress({
        phase: 'sample',
        index: i + 1,
        total: BENCHMARK_SAMPLE_COUNT,
      })
      const sec = await runtime.runChatCompletion(port, requestBody)
      samplesSec.push(sec)
    }
  } finally {
    // Free the model's RAM — the V2-P3+ session loop will start the sidecar
    // explicitly when the user joins a session with AI on. Always called,
    // even on startSidecar / waitForHealthy / chat-completion failures, so
    // a partially-initialised sidecar can't leak past benchmark exit.
    try {
      await runtime.stopSidecar()
    } catch {
      // best-effort
    }
  }

  const result = summariseBenchmark({
    samplesSec,
    completedAtSec: Math.floor(runtime.now() / 1000),
  })
  onProgress({ phase: 'done', result })
  return result
}
