/// <reference types="vite/client" />
import { invoke } from '@tauri-apps/api/core'
import { prepareBundledBenchmarkImages } from '@/features/ai/benchmark'
import { buildFocusRequest } from '@/features/ai/focusRequest'
import { parseJudgment } from '@/features/ai/parseJudgment'
import { getAiAgentRuntime, waitForSidecarReady } from '@/features/ai/aiAgent'
import { useSidecarStore, type SidecarStatus } from '@/features/ai/sidecar'
import { isAiHardwareIdentity } from '@/features/ai/computeDevice'
import type { ModelPaths } from '@/features/ai/download'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSessionStore } from '@/stores/sessionStore'
import { generateSessionTimeline } from '@/features/session/sessionTimeline'
import { sessionTimelineGet } from '@/lib/db/sessionTimeline'
import { assertSyntheticFocusImages } from './aiInferenceChecks'

type CanaryWindow = Window & {
  __ciAssertStopped: (port?: number) => Promise<void>
}

export async function run() {
  const modelId = 'qwen2_5-vl-3b'
  const sessionId = 'cb'.repeat(32)
  const host = window as unknown as CanaryWindow
  useSettingsStore.setState((state) => ({
    values: {
      ...state.values,
      aiFeaturesEnabled: true,
      engineAutoInstall: false,
    },
    status: 'ready',
  }))
  useSessionStore.setState({ status: 'ended', sessionTopic: sessionId })
  const paths = await invoke<ModelPaths>('model_paths', { modelId })
  const port = await useSidecarStore.getState().start({
    modelPath: paths.model_path,
    mmprojPath: paths.mmproj_path,
    ctxSize: 4096,
  })
  if (!port) throw new Error('native CPU sidecar did not start')
  await waitForSidecarReady(modelId, getAiAgentRuntime(), {
    unavailableMessage: 'native CPU sidecar never became healthy',
  })
  const status = await invoke<SidecarStatus>('sidecar_status')
  const hardware = status.hardware_identity
  if (
    !isAiHardwareIdentity(hardware) ||
    hardware.selection !== 'cpu' ||
    hardware.topology?.length !== 0
  ) {
    throw new Error('canary did not resolve CPU execution')
  }
  const images = await prepareBundledBenchmarkImages()
  const body = buildFocusRequest({
    modelId,
    topic: 'Studying algebra at a desk',
    ...images,
    imageMimeType: images.mimeType,
  })
  const focusImageCount = assertSyntheticFocusImages(body, images)
  const started = performance.now()
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  })
  if (!response.ok) throw new Error(`focus HTTP ${response.status}`)
  const json = (await response.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const judgment = parseJudgment(json.choices?.[0]?.message?.content ?? '')
  if (!judgment.ok)
    throw new Error('real focus inference returned an invalid judgment')
  const focusMs = performance.now() - started
  await useSidecarStore.getState().stop()
  await host.__ciAssertStopped(port)
  const start = 1_700_000_000_000
  const observations = [
    {
      ts: start + 1000,
      verdict: judgment.value.severity,
      reasoning: judgment.value.reasoning,
      confidence: judgment.value.on_topic_confidence,
      topic: 'Algebra',
    },
    {
      ts: start + 61000,
      verdict: 'on_task' as const,
      reasoning: 'Worked through algebra equations in a notebook',
      confidence: 0.9,
      topic: 'Algebra',
    },
    {
      ts: start + 121000,
      verdict: 'mild' as const,
      reasoning: 'Briefly looked away before returning to equations',
      confidence: 0.7,
      topic: 'Algebra',
    },
  ]
  const timelineStarted = performance.now()
  const timeline = await generateSessionTimeline({
    sessionId,
    modelId,
    declaredTopic: 'Algebra',
    startedAtMs: start,
    journal: { observations, truncated: false, unreadableLines: 0 },
  })
  const stored = await sessionTimelineGet(sessionId)
  if (
    !timeline ||
    timeline.source !== 'model' ||
    timeline.modelId !== modelId ||
    timeline.entries.length === 0
  ) {
    throw new Error(
      'real write-up fell back instead of completing model inference'
    )
  }
  if (
    !stored ||
    stored.source !== 'model' ||
    stored.model_id !== modelId ||
    stored.entries !== JSON.stringify(timeline.entries)
  ) {
    throw new Error(
      'native timeline persistence disagrees with the generated write-up'
    )
  }
  const stopped = await invoke<SidecarStatus>('sidecar_status')
  if (stopped.running || stopped.starting || stopped.port !== null)
    throw new Error('timeline left the native sidecar running')
  await host.__ciAssertStopped()
  return {
    judgment: judgment.value,
    timeline,
    stored,
    focusMs,
    timelineMs: performance.now() - timelineStarted,
    hardwareIdentity: hardware,
    focusImageCount,
  }
}
