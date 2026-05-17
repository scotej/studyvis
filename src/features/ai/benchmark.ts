// First-run benchmark: spin up the sidecar with the chosen model, send 3
// fixed chat-completions requests with a bundled 384×384 PNG, measure
// per-request latency. Results feed `useModelStore.recordBenchmark` so the
// picker can show "Speed on your machine" and the AI sample loop (V2-P5)
// can pick a `sample_interval = max(5, ceil(p95 + 1))`.
//
// `p50` and `p95` from 3 samples are coarse — we document this explicitly
// rather than pretending 3 samples produce true percentiles. The number is
// honest enough to choose between "fastest" (~3 s/check) and "heaviest"
// (~25 s/check), which is the only call the user is making.

import benchmarkImageUrl from './assets/benchmark-desk.png'
import type { ModelSpec } from './models'
import { useSidecarStore } from './sidecar'

export const BENCHMARK_SAMPLE_COUNT = 3
const BENCHMARK_PROMPT =
  'Describe the desk scene in this picture in one short sentence.'
const BENCHMARK_MAX_TOKENS = 32

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

export type BenchmarkRuntime = {
  loadBenchmarkImage: () => Promise<{ base64: string; mimeType: string }>
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

export type ChatCompletionRequest = {
  model: string
  messages: ChatMessage[]
  max_tokens: number
  temperature: number
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: ChatContentBlock[] | string
}

export type ChatContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

const HEALTH_TIMEOUT_MS = 90_000 // covers cold-start projector load on CPU

export async function loadBundledBenchmarkImage(): Promise<{
  base64: string
  mimeType: string
}> {
  // Vite resolves the import to a URL we fetch at runtime; the PNG is
  // bundled into dist as a hashed asset, so this works equivalently in dev,
  // production, and Storybook.
  const response = await fetch(benchmarkImageUrl)
  if (!response.ok) {
    throw new Error(
      `failed to load bundled benchmark image (HTTP ${response.status})`
    )
  }
  const blob = await response.blob()
  const ab = await blob.arrayBuffer()
  const bytes = new Uint8Array(ab)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i])
  }
  const base64 = btoa(bin)
  return { base64, mimeType: blob.type || 'image/png' }
}

const defaultRuntime: BenchmarkRuntime = {
  loadBenchmarkImage: loadBundledBenchmarkImage,
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
          `chat/completions stalled past ${REQUEST_TIMEOUT_MS / 1000}s — sidecar may be hung`,
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
  const image = await runtime.loadBenchmarkImage()

  onProgress({ phase: 'starting-sidecar' })

  const samplesSec: number[] = []
  try {
    const { port } = await runtime.startSidecar({
      modelPath: opts.modelPath,
      mmprojPath: opts.mmprojPath,
      ctxSize: opts.ctxSize ?? 4096,
    })
    await runtime.waitForHealthy(port, HEALTH_TIMEOUT_MS)

    const dataUri = `data:${image.mimeType};base64,${image.base64}`
    const requestBody = {
      model: spec.id,
      messages: [
        {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: BENCHMARK_PROMPT },
            { type: 'image_url' as const, image_url: { url: dataUri } },
          ],
        },
      ],
      max_tokens: BENCHMARK_MAX_TOKENS,
      temperature: 0,
    }

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
