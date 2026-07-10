import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  isDatasetEntry,
  loadDataset,
  parseArgs,
  resolveFixturePath,
  summarise,
  type CaseOutcome,
  type DatasetEntry,
  type PredictedLabel,
} from '../ai-eval/evalCore'

// #47 D1(c) — locks the eval harness's pure logic so the 500-line script
// can't silently rot while fixture capture (human-gated) catches up.

function entry(over: Partial<DatasetEntry> = {}): DatasetEntry {
  return {
    id: 'case-001-on-task-typescript',
    declared_topic: 'BST in TypeScript',
    face_path: 'fixtures/case-001-face.jpg',
    screen_path: 'fixtures/case-001-screen.jpg',
    expected_severity: 'on_task',
    scenario: 'coding',
    ...over,
  }
}

function ran(
  expected: DatasetEntry['expected_severity'],
  predicted: PredictedLabel,
  requestSec = 1
): CaseOutcome {
  return {
    kind: 'ran',
    entry: entry({ expected_severity: expected }),
    predicted,
    parseOk: predicted !== 'uncertain',
    parseReason: null,
    rawResponse: '',
    requestSec,
  }
}

describe('summarise', () => {
  test('computes FP/FN over confident rows only', () => {
    const s = summarise([
      ran('on_task', 'on_task'),
      ran('on_task', 'moderate'), // false positive
      ran('on_task', 'uncertain'), // skip — must not count as FP
      ran('moderate', 'moderate'),
      ran('moderate', 'on_task'), // false negative
      ran('blatant', 'uncertain'), // skip — must not count as FN
    ])
    expect(s.ran).toBe(6)
    expect(s.parseFailures).toBe(2)
    // 3 on_task rows, 1 mispredicted (uncertain excluded from the numerator).
    expect(s.falsePositiveRate).toBeCloseTo(1 / 3)
    // 3 off-task rows, 1 missed as on_task.
    expect(s.falseNegativeRate).toBeCloseTo(1 / 3)
    expect(s.matrix.on_task.moderate).toBe(1)
    expect(s.matrix.blatant.uncertain).toBe(1)
  })

  test('skipped outcomes count toward total but not the rates', () => {
    const s = summarise([
      ran('on_task', 'on_task'),
      { kind: 'skipped', entry: entry(), reason: 'missing fixture' },
    ])
    expect(s.total).toBe(2)
    expect(s.ran).toBe(1)
    expect(s.skipped).toBe(1)
    expect(s.falsePositiveRate).toBe(0)
  })

  test('rates are NaN when a class has no rows (no fabricated 0%)', () => {
    const s = summarise([ran('on_task', 'on_task')])
    expect(Number.isNaN(s.falseNegativeRate)).toBe(true)
  })

  test('mean request time averages ran rows', () => {
    const s = summarise([ran('on_task', 'on_task', 2), ran('mild', 'mild', 4)])
    expect(s.meanRequestSec).toBe(3)
  })
})

describe('resolveFixturePath', () => {
  const base = '/data/eval/dataset'
  test('resolves inside the dataset dir', () => {
    expect(resolveFixturePath(base, 'fixtures/a.jpg')).toBe(
      join(base, 'fixtures/a.jpg')
    )
  })
  test('rejects traversal, absolute, and empty paths', () => {
    expect(() => resolveFixturePath(base, '../../etc/passwd')).toThrow(
      /escapes/
    )
    expect(() => resolveFixturePath(base, '/etc/passwd')).toThrow(/absolute/)
    expect(() => resolveFixturePath(base, '')).toThrow(/empty/)
  })
})

describe('isDatasetEntry', () => {
  test('accepts the documented shape and rejects bad severities', () => {
    expect(isDatasetEntry(entry())).toBe(true)
    expect(isDatasetEntry({ ...entry(), expected_severity: 'sleepy' })).toBe(
      false
    )
    expect(isDatasetEntry({ ...entry(), face_path: 42 })).toBe(false)
    expect(isDatasetEntry(null)).toBe(false)
  })
})

describe('parseArgs', () => {
  const DIR = '/default/dataset'
  test('parses required + optional flags in both forms', () => {
    expect(
      parseArgs(['--port', '8080', '--model', 'qwen2_5-vl-3b'], DIR)
    ).toEqual({
      port: 8080,
      model: 'qwen2_5-vl-3b',
      datasetDir: DIR,
      requestTimeoutSec: 300,
    })
    const parsed = parseArgs(['--port=9', '--model=m', '--timeout=10'], DIR)
    expect(parsed).toMatchObject({ port: 9, model: 'm', requestTimeoutSec: 10 })
  })
  test('returns help sentinel; throws on missing/invalid flags', () => {
    expect(parseArgs(['--help'], DIR)).toBe('help')
    expect(() => parseArgs([], DIR)).toThrow(/--port is required/)
    expect(() => parseArgs(['--port', '0', '--model', 'm'], DIR)).toThrow(
      /positive integer/
    )
    expect(() => parseArgs(['--wat'], DIR)).toThrow(/unrecognised/)
  })
})

describe('loadDataset', () => {
  let dir: string | null = null
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  async function freshDir(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'studyvis-eval-'))
    await mkdir(join(dir, 'fixtures'))
    return dir
  }

  test('loads valid entries sorted by filename', async () => {
    const d = await freshDir()
    await writeFile(
      join(d, 'case-002-b.json'),
      JSON.stringify(entry({ id: 'case-002-b' }))
    )
    await writeFile(
      join(d, 'case-001-a.json'),
      JSON.stringify(entry({ id: 'case-001-a' }))
    )
    const entries = await loadDataset(d)
    expect(entries.map((e) => e.id)).toEqual(['case-001-a', 'case-002-b'])
  })

  test('rejects an id/filename mismatch and invalid JSON', async () => {
    const d = await freshDir()
    await writeFile(
      join(d, 'case-001-a.json'),
      JSON.stringify(entry({ id: 'case-999-wrong' }))
    )
    await expect(loadDataset(d)).rejects.toThrow(/does not match filename/)
    await rm(join(d, 'case-001-a.json'))
    await writeFile(join(d, 'case-001-a.json'), '{not json')
    await expect(loadDataset(d)).rejects.toThrow(/invalid JSON/)
  })

  test('rejects entries missing required fields', async () => {
    const d = await freshDir()
    const bad = { ...entry({ id: 'case-001-a' }) } as Record<string, unknown>
    delete bad.declared_topic
    await writeFile(join(d, 'case-001-a.json'), JSON.stringify(bad))
    await expect(loadDataset(d)).rejects.toThrow(/missing required fields/)
  })
})
