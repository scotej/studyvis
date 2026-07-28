import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { parseJudgment, type Judgment, type ParseResult } from '@/features/ai'
import {
  FIELD_MAX_CHARS,
  __resetLog,
  __setLogRecordSink,
  type LogRecord,
} from '@/lib/log'

const VALID: Judgment = {
  severity: 'on_task',
  reasoning: 'IDE shows typescript code matching declared topic',
  on_topic_confidence: 0.92,
}

function expectFallback(result: ParseResult, raw: string): void {
  expect(result.ok).toBe(false)
  if (result.ok) return
  // A2 — a parse failure is now an UNCERTAIN verdict, NOT a fabricated on_task.
  // The fallback carries no severity / confidence; the consumer treats it as a
  // skip that neither resets the streak nor counts toward focused-time %.
  expect(result.fallback.kind).toBe('uncertain')
  expect('severity' in result.fallback).toBe(false)
  expect(result.fallback.reason).toBe(result.reason)
  expect(result.raw).toBe(raw)
  expect(result.reason.length).toBeGreaterThan(0)
}

describe('parseJudgment', () => {
  let records: LogRecord[]

  beforeEach(() => {
    __resetLog()
    records = []
    __setLogRecordSink((record) => records.push(record))
    // Silence the console mirror so adversarial fixtures don't fill the test
    // output.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    __resetLog()
  })

  test('parses a well-formed JSON response', () => {
    const raw = JSON.stringify(VALID)
    const result = parseJudgment(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(VALID)
  })

  test('parses all four severities', () => {
    for (const severity of [
      'on_task',
      'mild',
      'moderate',
      'blatant',
    ] as const) {
      const raw = JSON.stringify({ ...VALID, severity })
      const result = parseJudgment(raw)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.severity).toBe(severity)
    }
  })

  test('strips a ```json ... ``` markdown fence', () => {
    const raw = '```json\n' + JSON.stringify(VALID) + '\n```'
    const result = parseJudgment(raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(VALID)
  })

  test('strips a plain ``` ... ``` markdown fence', () => {
    const raw = '```\n' + JSON.stringify(VALID) + '\n```'
    const result = parseJudgment(raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(VALID)
  })

  test('extracts the first JSON object when wrapped in leading prose', () => {
    const raw = `Sure! Here's my answer: ${JSON.stringify(VALID)}`
    const result = parseJudgment(raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(VALID)
  })

  test('extracts the first JSON object when wrapped in trailing prose', () => {
    const raw = `${JSON.stringify(VALID)}\n\nLet me know if you need clarification.`
    const result = parseJudgment(raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(VALID)
  })

  test('handles JSON containing a "}" inside a string field', () => {
    const tricky: Judgment = {
      severity: 'mild',
      reasoning: 'user typed "why}" in chat, glancing away from IDE',
      on_topic_confidence: 0.4,
    }
    const raw = `Reasoning below: ${JSON.stringify(tricky)} — done.`
    const result = parseJudgment(raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(tricky)
  })

  test('drops unknown fields rather than rejecting the payload', () => {
    const padded = {
      ...VALID,
      tokens_used: 42,
      model_name: 'qwen2.5-vl-3b',
    }
    const result = parseJudgment(JSON.stringify(padded))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual(VALID)
      expect(Object.keys(result.value).sort()).toEqual([
        'on_topic_confidence',
        'reasoning',
        'severity',
      ])
    }
  })

  test('falls back when the response is plain prose with no JSON', () => {
    const raw =
      'I think the user is currently studying. They appear focused on the screen.'
    expectFallback(parseJudgment(raw), raw)
  })

  test('falls back when the response is malformed JSON (unquoted keys)', () => {
    const raw = '{severity: on_task, reasoning: "ok", on_topic_confidence: 0.9}'
    expectFallback(parseJudgment(raw), raw)
  })

  test('falls back when the response is truncated', () => {
    const raw = '{"severity": "on_task", "reasoning": "ok"'
    expectFallback(parseJudgment(raw), raw)
  })

  test('falls back on an empty string', () => {
    const raw = ''
    const result = parseJudgment(raw)
    expectFallback(result, raw)
    if (!result.ok) expect(result.reason).toContain('empty response')
  })

  test('falls back on a whitespace-only string', () => {
    const raw = '   \n\t  '
    const result = parseJudgment(raw)
    expectFallback(result, raw)
    if (!result.ok) expect(result.reason).toContain('empty response')
  })

  test('falls back when severity is not in the allowed enum', () => {
    const raw = JSON.stringify({ ...VALID, severity: 'critical' })
    const result = parseJudgment(raw)
    expectFallback(result, raw)
    if (!result.ok) expect(result.reason).toContain('severity')
  })

  test('falls back when on_topic_confidence is out of [0, 1]', () => {
    const raw = JSON.stringify({ ...VALID, on_topic_confidence: 1.4 })
    const result = parseJudgment(raw)
    expectFallback(result, raw)
    if (!result.ok) expect(result.reason).toContain('on_topic_confidence')
  })

  test('falls back when on_topic_confidence is the wrong type', () => {
    const raw = JSON.stringify({ ...VALID, on_topic_confidence: 'high' })
    const result = parseJudgment(raw)
    expectFallback(result, raw)
    if (!result.ok) expect(result.reason).toContain('on_topic_confidence')
  })

  test('falls back when reasoning is missing', () => {
    const raw = JSON.stringify({
      severity: 'on_task',
      on_topic_confidence: 0.5,
    })
    const result = parseJudgment(raw)
    expectFallback(result, raw)
    if (!result.ok) expect(result.reason).toContain('reasoning')
  })

  test('handles JSON wrapped in markdown with surrounding prose', () => {
    const raw = `Here is my analysis:

\`\`\`json
${JSON.stringify(VALID)}
\`\`\`

Let me know.`
    const result = parseJudgment(raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(VALID)
  })

  test('takes the first valid JSON object when the model returns multiple', () => {
    const first: Judgment = {
      severity: 'moderate',
      reasoning: 'first object',
      on_topic_confidence: 0.3,
    }
    const second: Judgment = {
      severity: 'on_task',
      reasoning: 'second object',
      on_topic_confidence: 0.9,
    }
    const raw = `${JSON.stringify(first)}\n${JSON.stringify(second)}`
    const result = parseJudgment(raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(first)
  })

  test('logs the raw response when falling back', () => {
    parseJudgment('total nonsense, no JSON here')
    expect(records).toHaveLength(1)
    expect(records[0]?.scope).toBe('ai.parse')
    expect(records[0]?.msg).toBe('parse.fallback')
    expect(records[0]?.data?.snippet).toBe('total nonsense, no JSON here')
  })

  test('does not log on a successful parse', () => {
    parseJudgment(JSON.stringify(VALID))
    expect(records).toHaveLength(0)
  })

  test('truncates the logged raw snippet on long responses; full raw stays on the result', () => {
    const longRaw = 'prose '.repeat(200) + 'no json here'
    const result = parseJudgment(longRaw)
    expect(result.ok).toBe(false)
    const snippet = String(records[0]?.data?.snippet)
    expect(snippet.length).toBe(FIELD_MAX_CHARS + 1)
    expect(snippet.endsWith('…')).toBe(true)
    // The pre-clamp length is a field rather than a suffix, so a reader can
    // still tell how much was dropped.
    expect(records[0]?.data?.rawLength).toBe(longRaw.length)
    if (!result.ok) expect(result.raw).toBe(longRaw)
  })

  test('model output can never forge a log line', () => {
    parseJudgment('sure!\nlvl=error [app] everything is fine')
    const snippet = String(records[0]?.data?.snippet)
    expect(snippet).not.toMatch(/[\p{Cc}\p{Cf}]/u)
    expect(snippet).toContain('everything is fine')
  })
})
