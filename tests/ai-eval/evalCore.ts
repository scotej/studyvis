// #47 D1(c) — the harness's pure logic (CLI parsing, dataset loading +
// validation, fixture-path traversal guard, confusion-matrix math), extracted
// from run.ts so vitest can exercise it: run.ts executes main() at module
// load, so importing it from a test would fire the whole eval. run.ts stays
// the thin orchestration shell (sidecar HTTP + report printing).

import { readdir, readFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

import { SEVERITIES, type Severity } from '../../src/features/ai/parseJudgment'

export const DEFAULT_REQUEST_TIMEOUT_SEC = 300

export type CliArgs = {
  port: number
  model: string
  datasetDir: string
  requestTimeoutSec: number
}

export function parseArgs(
  argv: string[],
  defaultDatasetDir: string
): CliArgs | 'help' {
  let port: number | null = null
  let model: string | null = null
  let datasetDir = defaultDatasetDir
  let requestTimeoutSec = DEFAULT_REQUEST_TIMEOUT_SEC

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
      return 'help'
    } else {
      throw new Error(`unrecognised argument: ${arg}`)
    }
  }

  if (port === null) throw new Error('--port is required')
  if (model === null) throw new Error('--model is required')
  return { port, model, datasetDir, requestTimeoutSec }
}

export function parseIntStrict(raw: string | undefined, flag: string): number {
  const value = requireValue(raw, flag)
  const n = Number.parseInt(value, 10)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer, got ${value}`)
  }
  return n
}

export function requireValue(raw: string | undefined, flag: string): string {
  if (raw === undefined || raw.length === 0) {
    throw new Error(`${flag} expects a non-empty value`)
  }
  return raw
}

export type DatasetEntry = {
  id: string
  declared_topic: string
  face_path: string
  screen_path: string
  expected_severity: Severity
  scenario: string
  notes?: string
}

export function isDatasetEntry(value: unknown): value is DatasetEntry {
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

export async function loadDataset(dir: string): Promise<DatasetEntry[]> {
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

// A2 — a parse failure now yields an UNCERTAIN verdict (not a fabricated
// on_task), so the eval reports it as its own predicted bucket rather than
// crediting/blaming the model with an on_task call it never made. Keeps the
// FP/FN rates honest: an uncertain row is neither a false positive nor a
// false negative — it's a skip.
export const PREDICTED_LABELS = [...SEVERITIES, 'uncertain'] as const
export type PredictedLabel = (typeof PREDICTED_LABELS)[number]

export type CaseOutcome =
  | {
      kind: 'ran'
      entry: DatasetEntry
      predicted: PredictedLabel
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

export async function loadJpegBase64(path: string): Promise<string | null> {
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
export function resolveFixturePath(
  datasetDir: string,
  fixtureRel: string
): string {
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

export function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—'
}

export type Summary = {
  total: number
  ran: number
  skipped: number
  parseFailures: number
  matrix: Record<Severity, Record<PredictedLabel, number>>
  falsePositiveRate: number
  falseNegativeRate: number
  meanRequestSec: number
}

export function summarise(outcomes: CaseOutcome[]): Summary {
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
    // A2 — an 'uncertain' prediction is a skip: it is neither a false positive
    // (an on_task row "flagged" off-task) nor a false negative (an off_task
    // row "missed" as on_task). It only inflates `parseFailures`, which is
    // surfaced separately.
    if (outcome.entry.expected_severity === 'on_task') {
      onTaskRows++
      if (outcome.predicted !== 'on_task' && outcome.predicted !== 'uncertain')
        onTaskMispredictions++
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

export function blankMatrix(): Record<
  Severity,
  Record<PredictedLabel, number>
> {
  const inner = (): Record<PredictedLabel, number> => ({
    on_task: 0,
    mild: 0,
    moderate: 0,
    blatant: 0,
    uncertain: 0,
  })
  return {
    on_task: inner(),
    mild: inner(),
    moderate: inner(),
    blatant: inner(),
  }
}
