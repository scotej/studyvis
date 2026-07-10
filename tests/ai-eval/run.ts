#!/usr/bin/env tsx
// V2-P4 — Evaluation harness for the focus-detection system prompt.
//
// Loads tests/ai-eval/dataset/case-*.json, sends each entry's face+screen
// fixtures to a running llama-server, parses the response via
// parseJudgment, and prints a confusion matrix + FP/FN rates per
// PLAN.md §5 V2 success criteria (FP < 5% on the 100-item set).
//
// The sidecar is NOT started by this script. The user runs StudyVis,
// enables AI features so the sidecar is alive, then invokes:
//
//   tsx tests/ai-eval/run.ts --port <p> --model <model-id>
//
// Sidecar port surfaces in app logs (see useSidecarStore). The model-id is
// the registry id (see src/features/ai/models.ts).
//
// Re-run on every system-prompt iteration and paste the result block into
// tests/ai-eval/RESULTS.md before merging — see README.md.
//
// #47 D1(c) — the pure logic (CLI parsing, dataset validation, fixture-path
// guard, confusion-matrix math) lives in ./evalCore and is unit-tested by
// tests/unit/ai-eval-core.test.ts; this file is the orchestration shell.

import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildFocusRequest,
  type FocusChatRequest,
} from '../../src/features/ai/focusRequest'
import { parseJudgment, SEVERITIES } from '../../src/features/ai/parseJudgment'
import { FOCUS_SYSTEM_PROMPT_VERSION } from '../../src/features/ai/systemPrompt'

import {
  fmt,
  loadDataset,
  loadJpegBase64,
  parseArgs,
  PREDICTED_LABELS,
  resolveFixturePath,
  summarise,
  type CaseOutcome,
  type CliArgs,
  type DatasetEntry,
  type PredictedLabel,
  type Summary,
} from './evalCore'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DATASET_DIR = resolve(HERE, 'dataset')

function printUsage(): void {
  console.error(
    `usage: tsx tests/ai-eval/run.ts --port <p> --model <id> [--dataset <dir>] [--timeout <sec>]\n` +
      `\n` +
      `  --port      llama-server port (printed by the running app)\n` +
      `  --model     model id from src/features/ai/models.ts (e.g. qwen2_5-vl-3b)\n` +
      `  --dataset   path to dataset dir (default: tests/ai-eval/dataset)\n` +
      `  --timeout   per-request timeout in seconds (default: 300)\n`
  )
}

type ChatRequest = FocusChatRequest

// The request shape is shared with the live sample loop + the first-run
// benchmark via `buildFocusRequest` (A1) so eval numbers predict runtime
// behaviour and the three can't drift (I11 topic-injection hardening included).
function buildRequest(
  model: string,
  entry: DatasetEntry,
  faceB64: string,
  screenB64: string
): ChatRequest {
  return buildFocusRequest({
    modelId: model,
    topic: entry.declared_topic,
    faceBase64: faceB64,
    screenBase64: screenB64,
  })
}

async function callSidecar(
  port: number,
  body: ChatRequest,
  timeoutSec: number
): Promise<{ text: string; elapsedSec: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000)
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
        `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`
      )
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const text = json?.choices?.[0]?.message?.content ?? ''
    return { text, elapsedSec: (performance.now() - start) / 1000 }
  } catch (err) {
    // AbortError surfaces as a generic DOMException — translate it into a
    // clear timeout message so operators can distinguish "model is slow"
    // from "fetch crashed". Matches the convention in benchmark.ts.
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(
        `request timed out after ${timeoutSec}s — model may be slow or the sidecar is hung`,
        { cause: err }
      )
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function healthCheck(port: number): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/health`)
  if (!res.ok) {
    throw new Error(
      `sidecar at 127.0.0.1:${port} responded HTTP ${res.status} on /health`
    )
  }
}

function printReport(args: CliArgs, summary: Summary): void {
  const PAD = 9
  const pad = (s: string): string => s.padEnd(PAD)
  console.log('')
  console.log(`Model:              ${args.model}`)
  console.log(`Prompt version:     v${FOCUS_SYSTEM_PROMPT_VERSION}`)
  console.log(`Dataset entries:    ${summary.total}`)
  console.log(`Ran:                ${summary.ran}`)
  console.log(`Skipped:            ${summary.skipped}`)
  console.log(`Parse failures:     ${summary.parseFailures}`)
  console.log(
    `Mean request time:  ${fmt(summary.meanRequestSec, 2)} s/inference`
  )
  console.log('')
  console.log(
    `False-positive rate: ${fmt(summary.falsePositiveRate * 100, 1)} %  (on_task wrongly flagged; target < 5 %)`
  )
  console.log(
    `False-negative rate: ${fmt(summary.falseNegativeRate * 100, 1)} %  (off-task missed entirely)`
  )
  console.log('')
  console.log('Confusion matrix (rows = expected, cols = predicted):')
  console.log(
    `${pad('expected\\predicted')} ` +
      PREDICTED_LABELS.map((s) => pad(s)).join('')
  )
  for (const expected of SEVERITIES) {
    const cells = PREDICTED_LABELS.map((predicted) =>
      pad(String(summary.matrix[expected][predicted]))
    )
    console.log(`${pad(expected)} ${cells.join('')}`)
  }
}

function printSkipped(outcomes: CaseOutcome[]): void {
  const skipped = outcomes.filter((o) => o.kind === 'skipped')
  if (skipped.length === 0) return
  console.log('')
  console.log('Skipped entries:')
  for (const s of skipped) {
    if (s.kind !== 'skipped') continue
    console.log(`  - ${s.entry.id}: ${s.reason}`)
  }
}

function printParseFailures(outcomes: CaseOutcome[]): void {
  const fails = outcomes.filter(
    (o): o is Extract<CaseOutcome, { kind: 'ran' }> =>
      o.kind === 'ran' && !o.parseOk
  )
  if (fails.length === 0) return
  console.log('')
  console.log('Parse failures (raw response snippets):')
  for (const f of fails) {
    const snippet = f.rawResponse.slice(0, 120).replace(/\n/g, ' ')
    console.log(`  - ${f.entry.id}: ${f.parseReason}`)
    console.log(`      raw: ${snippet}${f.rawResponse.length > 120 ? '…' : ''}`)
  }
}

async function ensureDatasetDir(dir: string): Promise<void> {
  let info
  try {
    info = await stat(dir)
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      throw new Error(`dataset directory not found: ${dir}`, { cause: err })
    }
    throw err
  }
  if (!info.isDirectory()) {
    throw new Error(`dataset path is not a directory: ${dir}`)
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2), DEFAULT_DATASET_DIR)
  if (parsed === 'help') {
    printUsage()
    process.exit(0)
  }
  const args = parsed
  await ensureDatasetDir(args.datasetDir)
  await healthCheck(args.port)
  const entries = await loadDataset(args.datasetDir)
  if (entries.length === 0) {
    throw new Error(`no dataset entries found in ${args.datasetDir}`)
  }

  const outcomes: CaseOutcome[] = []
  for (const entry of entries) {
    let facePath: string
    let screenPath: string
    try {
      facePath = resolveFixturePath(args.datasetDir, entry.face_path)
      screenPath = resolveFixturePath(args.datasetDir, entry.screen_path)
    } catch (err) {
      outcomes.push({
        kind: 'skipped',
        entry,
        reason:
          err instanceof Error
            ? err.message
            : `invalid fixture path: ${String(err)}`,
      })
      continue
    }
    const [faceB64, screenB64] = await Promise.all([
      loadJpegBase64(facePath),
      loadJpegBase64(screenPath),
    ])
    if (!faceB64 || !screenB64) {
      const missing: string[] = []
      if (!faceB64) missing.push(`face_path ${entry.face_path}`)
      if (!screenB64) missing.push(`screen_path ${entry.screen_path}`)
      outcomes.push({
        kind: 'skipped',
        entry,
        reason: `missing fixture: ${missing.join(', ')}`,
      })
      continue
    }

    const body = buildRequest(args.model, entry, faceB64, screenB64)
    try {
      const { text, elapsedSec } = await callSidecar(
        args.port,
        body,
        args.requestTimeoutSec
      )
      const parsed = parseJudgment(text)
      const predicted: PredictedLabel = parsed.ok
        ? parsed.value.severity
        : 'uncertain'
      outcomes.push({
        kind: 'ran',
        entry,
        predicted,
        parseOk: parsed.ok,
        parseReason: parsed.ok ? null : parsed.reason,
        rawResponse: text,
        requestSec: elapsedSec,
      })
      const verdict = predicted === entry.expected_severity ? 'PASS' : 'FAIL'
      process.stdout.write(
        `[${verdict}] ${entry.id} expected=${entry.expected_severity} predicted=${predicted} (${elapsedSec.toFixed(1)}s)\n`
      )
    } catch (err) {
      outcomes.push({
        kind: 'skipped',
        entry,
        reason: `request failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  const summary = summarise(outcomes)
  printReport(args, summary)
  printSkipped(outcomes)
  printParseFailures(outcomes)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
