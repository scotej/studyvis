// V2-P4 — Parse a llama-server response into a focus-judgment.
//
// llama-server's `response_format: { type: "json_object" }` constrains output
// to valid JSON via GBNF grammar, but small vision models still occasionally
// stray (markdown fences, leading "Sure, here you go:" prose, an extra field,
// a confidence outside [0,1]). This module is the safety net.
//
// Strategy: cheap path first (raw JSON.parse → strip markdown fences →
// JSON.parse), fall through to a string-aware bracket scanner for embedded
// objects. On any parse or schema failure we return a structured ok=false
// result carrying a safe on_task fallback so the sample loop never crashes
// on a malformed inference. Per ARCHITECTURE.md §8 the default-on-uncertainty
// is "on_task" — false positives are worse than false negatives.
//
// Manual type-guards (matching src/features/friends/inbox.ts and
// src/features/session/hello.ts) instead of zod: house style avoids runtime
// validation libs and the schema is three fields wide.

export type Severity = 'on_task' | 'mild' | 'moderate' | 'blatant'

export const SEVERITIES: ReadonlyArray<Severity> = [
  'on_task',
  'mild',
  'moderate',
  'blatant',
]

export type Judgment = {
  severity: Severity
  reasoning: string
  on_topic_confidence: number
}

export type ParseSuccess = {
  ok: true
  value: Judgment
}

export type ParseFallback = {
  ok: false
  fallback: Judgment
  reason: string
  raw: string
}

export type ParseResult = ParseSuccess | ParseFallback

function isSeverity(v: unknown): v is Severity {
  return v === 'on_task' || v === 'mild' || v === 'moderate' || v === 'blatant'
}

function isJudgment(value: unknown): value is Judgment {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<Judgment>
  if (!isSeverity(v.severity)) return false
  if (typeof v.reasoning !== 'string') return false
  const conf = v.on_topic_confidence
  if (typeof conf !== 'number' || !Number.isFinite(conf)) return false
  if (conf < 0 || conf > 1) return false
  return true
}

function buildFallback(reason: string, raw: string): ParseFallback {
  return {
    ok: false,
    fallback: {
      severity: 'on_task',
      reasoning: `parse failed: ${reason}`,
      on_topic_confidence: 0.5,
    },
    reason,
    raw,
  }
}

// Strip a leading ```json … ``` (or plain ```) markdown fence. Models that
// add prose around their JSON typically wrap the JSON in a code block; this
// is the cheapest accommodation before we fall through to a real scanner.
function stripMarkdownFences(input: string): string {
  const trimmed = input.trim()
  const fence = /^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```\s*$/m
  const match = fence.exec(trimmed)
  if (match) return match[1].trim()
  return trimmed
}

// String-aware scan for the first balanced JSON object in `input`. Handles
// `{"reasoning": "use of 'why}' is fine"}` correctly — a naive bracket counter
// would close on the `}` inside the string literal.
function extractFirstJsonObject(input: string): string | null {
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== '{') continue
    let depth = 0
    let inString = false
    let escaping = false
    for (let j = i; j < input.length; j++) {
      const ch = input[j]
      if (inString) {
        if (escaping) {
          escaping = false
        } else if (ch === '\\') {
          escaping = true
        } else if (ch === '"') {
          inString = false
        }
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return input.slice(i, j + 1)
      }
    }
  }
  return null
}

// Optional logger seam for tests; production calls console.warn which is
// fine in both the browser (sample loop) and Node (eval harness).
type ParseLogger = (...args: unknown[]) => void
let activeLogger: ParseLogger = (...args) => console.warn(...args)

export function __setParseLogger(logger: ParseLogger): void {
  activeLogger = logger
}

export function __resetParseLogger(): void {
  activeLogger = (...args) => console.warn(...args)
}

// Max prefix of `raw` we emit to the logger. The full string is preserved on
// the ParseFallback.raw field for debugging — the logger snippet just keeps
// console output bounded when a model returns hundreds of tokens of prose,
// and avoids flooding logs with on-screen text that may be sensitive.
const LOG_SNIPPET_MAX = 200

function logFallback(reason: string, raw: string): void {
  const snippet =
    raw.length > LOG_SNIPPET_MAX
      ? `${raw.slice(0, LOG_SNIPPET_MAX)}…[${raw.length} chars total]`
      : raw
  activeLogger('[parseJudgment] fallback:', reason, { snippet })
}

export function parseJudgment(raw: string): ParseResult {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    const reason = 'empty response'
    logFallback(reason, raw)
    return buildFallback(reason, raw)
  }

  const trimmed = raw.trim()

  // Path 1: raw is already a JSON object.
  const direct = tryParse(trimmed)
  if (direct.ok && isJudgment(direct.value)) {
    return { ok: true, value: pickJudgment(direct.value) }
  }

  // Path 2: strip a markdown code fence and re-try.
  const dewrapped = stripMarkdownFences(trimmed)
  if (dewrapped !== trimmed) {
    const fenced = tryParse(dewrapped)
    if (fenced.ok && isJudgment(fenced.value)) {
      return { ok: true, value: pickJudgment(fenced.value) }
    }
  }

  // Path 3: scan for an embedded JSON object inside arbitrary prose.
  const embedded = extractFirstJsonObject(dewrapped)
  if (embedded) {
    const inner = tryParse(embedded)
    if (inner.ok && isJudgment(inner.value)) {
      return { ok: true, value: pickJudgment(inner.value) }
    }
    if (inner.ok) {
      // Parsed JSON but failed schema validation — surface the why.
      const reason = describeSchemaFailure(inner.value)
      logFallback(reason, raw)
      return buildFallback(reason, raw)
    }
  }

  const reason = 'no valid JSON object found in response'
  logFallback(reason, raw)
  return buildFallback(reason, raw)
}

function tryParse(
  input: string
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(input) }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// Keep only the three documented fields. A model that returns extra keys
// (e.g. {"severity": "...", "reasoning": "...", "on_topic_confidence": 0.7,
// "tokens_used": 42}) is still valid; we drop the unknown keys instead of
// rejecting the payload.
function pickJudgment(j: Judgment): Judgment {
  return {
    severity: j.severity,
    reasoning: j.reasoning,
    on_topic_confidence: j.on_topic_confidence,
  }
}

function describeSchemaFailure(value: unknown): string {
  if (!value || typeof value !== 'object') return 'not a JSON object'
  const v = value as Partial<Judgment>
  if (!isSeverity(v.severity)) {
    return `invalid severity: ${JSON.stringify(v.severity)}`
  }
  if (typeof v.reasoning !== 'string') {
    return `invalid reasoning: ${JSON.stringify(v.reasoning)}`
  }
  if (
    typeof v.on_topic_confidence !== 'number' ||
    !Number.isFinite(v.on_topic_confidence) ||
    v.on_topic_confidence < 0 ||
    v.on_topic_confidence > 1
  ) {
    return `invalid on_topic_confidence: ${JSON.stringify(v.on_topic_confidence)}`
  }
  return 'schema validation failed'
}
