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

import { readdir, readFile, stat } from 'node:fs/promises'
import {
  resolve,
  dirname,
  basename,
  isAbsolute,
  join,
  relative,
} from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  parseJudgment,
  SEVERITIES,
  type Severity,
} from '../../src/features/ai/parseJudgment'
import {
  FOCUS_SYSTEM_PROMPT,
  FOCUS_SYSTEM_PROMPT_VERSION,
} from '../../src/features/ai/systemPrompt'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DATASET_DIR = resolve(HERE, 'dataset')

type CliArgs = {
  port: number
  model: string
  datasetDir: string
  requestTimeoutSec: number
}

function parseArgs(argv: string[]): CliArgs {
  let port: number | null = null
  let model: string | null = null
  let datasetDir = DEFAULT_DATASET_DIR
  let requestTimeoutSec = 300

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--port') {
      port = parseIntStrict(next, '--port')
      i++
    } else if (arg.startsWith('--port=')) {
      port = parseIntStrict(arg.slice('--port='.length), '--port')
    } else if (arg === '--model') {
      model = requireValue(next, '--model')
      i++
    } else if (arg.startsWith('--model=')) {
      model = requireValue(arg.slice('--model='.length), '--model')
    } else if (arg === '--dataset') {
      datasetDir = resolve(requireValue(next, '--dataset'))
      i++
    } else if (arg.startsWith('--dataset=')) {
      datasetDir = resolve(
        requireValue(arg.slice('--dataset='.length), '--dataset')
      )
    } else if (arg === '--timeout') {
      requestTimeoutSec = parseIntStrict(next, '--timeout')
      i++
    } else if (arg.startsWith('--timeout=')) {
      requestTimeoutSec = parseIntStrict(
        arg.slice('--timeout='.length),
        '--timeout'
      )
    } else if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    } else {
      throw new Error(`unrecognised argument: ${arg}`)
    }
  }

  if (port === null) throw new Error('--port is required')
  if (model === null) throw new Error('--model is required')
  return { port, model, datasetDir, requestTimeoutSec }
}

function parseIntStrict(raw: string | undefined, flag: string): number {
  const value = requireValue(raw, flag)
  const n = Number.parseInt(value, 10)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer, got ${value}`)
  }
  return n
}

function requireValue(raw: string | undefined, flag: string): string {
  if (raw === undefined || raw.length === 0) {
    throw new Error(`${flag} expects a non-empty value`)
  }
  return raw
}

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

type DatasetEntry = {
  id: string
  declared_topic: string
  face_path: string
  screen_path: string
  expected_severity: Severity
  scenario: string
  notes?: string
}

function isDatasetEntry(value: unknown): value is DatasetEntry {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<DatasetEntry>
  return (
    typeof v.id === 'string' &&
    typeof v.declared_topic === 'string' &&
    typeof v.face_path === 'string' &&
    typeof v.screen_path === 'string' &&
    typeof v.expected_severity === 'string' &&
    SEVERITIES.includes(v.expected_severity as Severity) &&
    typeof v.scenario === 'string' &&
    (v.notes === undefined || typeof v.notes === 'string')
  )
}

async function loadDataset(dir: string): Promise<DatasetEntry[]> {
  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !f.startsWith('_') && !f.startsWith('.'))
    .sort()
  const entries: DatasetEntry[] = []
  for (const file of files) {
    const path = join(dir, file)
    const raw = await readFile(path, 'utf-8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`dataset/${file}: invalid JSON — ${msg}`, { cause: err })
    }
    if (!isDatasetEntry(parsed)) {
      throw new Error(`dataset/${file}: missing required fields`)
    }
    const idFromName = basename(file, '.json')
    if (parsed.id !== idFromName) {
      throw new Error(
        `dataset/${file}: id "${parsed.id}" does not match filename "${idFromName}"`
      )
    }
    entries.push(parsed)
  }
  return entries
}

type CaseOutcome =
  | {
      kind: 'ran'
      entry: DatasetEntry
      predicted: Severity
      parseOk: boolean
      parseReason: string | null
      rawResponse: string
      requestSec: number
    }
  | {
      kind: 'skipped'
      entry: DatasetEntry
      reason: string
    }

async function loadJpegBase64(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path)
    return buf.toString('base64')
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null
    throw err
  }
}

// Reject absolute fixture paths and any relative path that escapes datasetDir
// after resolution. A malicious or fat-fingered dataset entry pointing at
// e.g. `../../etc/passwd` would otherwise read whatever file the harness
// process can see.
function resolveFixturePath(datasetDir: string, fixtureRel: string): string {
  if (fixtureRel.length === 0) {
    throw new Error(`fixture path is empty`)
  }
  if (isAbsolute(fixtureRel)) {
    throw new Error(`fixture path is absolute: "${fixtureRel}"`)
  }
  const resolved = resolve(datasetDir, fixtureRel)
  const rel = relative(datasetDir, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`fixture path escapes dataset directory: "${fixtureRel}"`)
  }
  return resolved
}

type ChatRequest = {
  model: string
  messages: Array<
    | { role: 'system'; content: string }
    | {
        role: 'user'
        content: Array<
          | { type: 'text'; text: string }
          | { type: 'image_url'; image_url: { url: string } }
        >
      }
  >
  temperature: number
  max_tokens: number
  response_format: { type: 'json_object' }
}

function buildRequest(
  model: string,
  entry: DatasetEntry,
  faceB64: string,
  screenB64: string
): ChatRequest {
  return {
    model,
    messages: [
      { role: 'system', content: FOCUS_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Declared topic: ${entry.declared_topic}` },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${faceB64}` },
          },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${screenB64}` },
          },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 200,
    response_format: { type: 'json_object' },
  }
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

function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—'
}

type Summary = {
  total: number
  ran: number
  skipped: number
  parseFailures: number
  matrix: Record<Severity, Record<Severity, number>>
  falsePositiveRate: number
  falseNegativeRate: number
  meanRequestSec: number
}

function summarise(outcomes: CaseOutcome[]): Summary {
  const matrix = blankMatrix()
  let onTaskRows = 0
  let onTaskMispredictions = 0
  let offTaskRows = 0
  let offTaskMissed = 0
  let parseFailures = 0
  let ranCount = 0
  let totalSeconds = 0
  for (const outcome of outcomes) {
    if (outcome.kind !== 'ran') continue
    ranCount++
    totalSeconds += outcome.requestSec
    matrix[outcome.entry.expected_severity][outcome.predicted]++
    if (!outcome.parseOk) parseFailures++
    if (outcome.entry.expected_severity === 'on_task') {
      onTaskRows++
      if (outcome.predicted !== 'on_task') onTaskMispredictions++
    } else {
      offTaskRows++
      if (outcome.predicted === 'on_task') offTaskMissed++
    }
  }
  return {
    total: outcomes.length,
    ran: ranCount,
    skipped: outcomes.length - ranCount,
    parseFailures,
    matrix,
    falsePositiveRate: onTaskRows > 0 ? onTaskMispredictions / onTaskRows : NaN,
    falseNegativeRate: offTaskRows > 0 ? offTaskMissed / offTaskRows : NaN,
    meanRequestSec: ranCount > 0 ? totalSeconds / ranCount : NaN,
  }
}

function blankMatrix(): Record<Severity, Record<Severity, number>> {
  const inner = () => ({ on_task: 0, mild: 0, moderate: 0, blatant: 0 })
  return {
    on_task: inner(),
    mild: inner(),
    moderate: inner(),
    blatant: inner(),
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
    `${pad('expected\\predicted')} ` + SEVERITIES.map((s) => pad(s)).join('')
  )
  for (const expected of SEVERITIES) {
    const cells = SEVERITIES.map((predicted) =>
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
  const args = parseArgs(process.argv.slice(2))
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
      const predicted: Severity = parsed.ok
        ? parsed.value.severity
        : parsed.fallback.severity
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
