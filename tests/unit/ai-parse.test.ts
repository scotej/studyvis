import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  parseJudgment,
  __resetParseLogger,
  __setParseLogger,
  type Judgment,
  type ParseResult,
} from '@/features/ai'

const VALID: Judgment = {
  severity: 'on_task',
  reasoning: 'IDE shows typescript code matching declared topic',
  on_topic_confidence: 0.92,
}

function expectFallback(result: ParseResult, raw: string): void {
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.fallback.severity).toBe('on_task')
  expect(result.fallback.on_topic_confidence).toBe(0.5)
  expect(result.fallback.reasoning.startsWith('parse failed: ')).toBe(true)
  expect(result.raw).toBe(raw)
  expect(result.reason.length).toBeGreaterThan(0)
}

describe('parseJudgment', () => {
  beforeEach(() => {
    // Silence logger so adversarial fixtures don't fill the test output.
    __setParseLogger(() => {})
  })
  afterEach(() => {
    __resetParseLogger()
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
    const logger = vi.fn()
    __setParseLogger(logger)
    parseJudgment('total nonsense, no JSON here')
    expect(logger).toHaveBeenCalled()
    const args = logger.mock.calls[0]
    expect(args[0]).toContain('[parseJudgment]')
  })

  test('does not log on a successful parse', () => {
    const logger = vi.fn()
    __setParseLogger(logger)
    parseJudgment(JSON.stringify(VALID))
    expect(logger).not.toHaveBeenCalled()
  })
})
