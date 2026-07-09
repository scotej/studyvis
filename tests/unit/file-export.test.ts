// R3 — pure-logic tests for the file-export helpers (slug, date stamp, CSV
// builder) and the saveTextFile orchestration via injected seams (no Tauri).

import { describe, expect, test, vi } from 'vitest'

import {
  buildCsv,
  csvCell,
  fileDateStamp,
  saveTextFile,
  slugify,
  type SaveTextFileDeps,
} from '@/lib/fileExport'
import { buildStatsCsvModel, computeStats } from '@/features/stats/statsData'
import type { SessionRecord } from '@/lib/db/sessions'

describe('slugify', () => {
  test('lowercases, dashes runs, trims', () => {
    expect(slugify('Linear Algebra — Set 3')).toBe('linear-algebra-set-3')
    expect(slugify('  spaced  out  ')).toBe('spaced-out')
  })
  test('falls back when nothing survives', () => {
    expect(slugify('!!!')).toBe('export')
    expect(slugify('', 'session')).toBe('session')
  })
})

describe('fileDateStamp', () => {
  test('formats YYYY-MM-DD in the given zone', () => {
    expect(fileDateStamp(Date.UTC(2026, 0, 9, 23, 30), 'UTC')).toBe(
      '2026-01-09'
    )
  })
})

describe('csvCell', () => {
  test('quotes cells with commas, quotes, or newlines', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
    expect(csvCell(42)).toBe('42')
  })

  test('PR-10: neutralizes formula-injection triggers in string cells', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(
      '"\'=HYPERLINK(""http://evil"",""x"")"'
    )
    expect(csvCell('+1+1')).toBe("'+1+1")
    expect(csvCell('-cmd')).toBe("'-cmd")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    // Leading tab is also a trigger; the prefixed cell has no comma/quote/CR/LF
    // so it is not additionally quoted.
    expect(csvCell('\t=cmd')).toBe("'\t=cmd")
    // Leading newline: prefixed, then CSV-quoted because it contains a newline.
    expect(csvCell('\n=cmd')).toBe('"\'\n=cmd"')
    // A negative NUMBER must not be corrupted (stays numeric, no quote prefix).
    expect(csvCell(-5)).toBe('-5')
  })
})

describe('buildCsv', () => {
  test('joins header + rows with CRLF and a trailing newline', () => {
    const csv = buildCsv(
      ['section', 'key', 'value'],
      [
        ['daily', '2026-05-18', 25],
        ['partner', 'Al, ice', 3],
      ]
    )
    expect(csv).toBe(
      'section,key,value\r\ndaily,2026-05-18,25\r\npartner,"Al, ice",3\r\n'
    )
  })
})

describe('buildStatsCsvModel', () => {
  const A = 'a'.repeat(64)
  function session(over: Partial<SessionRecord> = {}): SessionRecord {
    return {
      id: 'x',
      started_at: Date.UTC(2026, 4, 18, 12),
      ended_at: null,
      total_minutes: 30,
      peer_pubkeys: null,
      declared_topic: null,
      score: null,
      focused_pct: null,
      generated_at: null,
      ...over,
    }
  }

  test('emits a daily section then a partner section derived from the summary', () => {
    const now = Date.UTC(2026, 4, 18, 12)
    const summary = computeStats(
      [
        session({
          id: 's1',
          total_minutes: 25,
          peer_pubkeys: JSON.stringify([A]),
        }),
      ],
      [
        {
          ed_pubkey_hex: A,
          x_pubkey_hex: 'x',
          display_name: 'Alice',
          paired_at: 1,
          last_studied_with: null,
        },
      ],
      now,
      'UTC'
    )
    const model = buildStatsCsvModel(summary)
    expect(model.header).toEqual(['section', 'key', 'value'])
    // 30 daily rows + 1 partner row.
    const dailyRows = model.rows.filter((r) => r[0] === 'daily_study_minutes')
    const partnerRows = model.rows.filter((r) => r[0] === 'partner_sessions')
    expect(dailyRows).toHaveLength(30)
    expect(partnerRows).toEqual([['partner_sessions', 'Alice', 1]])
    // The today bucket carries the 25 charted minutes.
    expect(dailyRows.some((r) => r[1] === '2026-05-18' && r[2] === 25)).toBe(
      true
    )
  })
})

describe('saveTextFile', () => {
  test('writes to the picked path and returns saved', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const deps: SaveTextFileDeps = {
      pickPath: vi.fn().mockResolvedValue('/tmp/out.md'),
      writeFile,
    }
    const result = await saveTextFile('hello', { defaultPath: 'out.md' }, deps)
    expect(result).toEqual({ kind: 'saved', path: '/tmp/out.md' })
    expect(writeFile).toHaveBeenCalledWith('/tmp/out.md', 'hello')
  })

  test('returns cancelled and does not write when the picker is dismissed', async () => {
    const writeFile = vi.fn()
    const deps: SaveTextFileDeps = {
      pickPath: vi.fn().mockResolvedValue(null),
      writeFile,
    }
    const result = await saveTextFile('hello', { defaultPath: 'out.md' }, deps)
    expect(result).toEqual({ kind: 'cancelled' })
    expect(writeFile).not.toHaveBeenCalled()
  })

  test('propagates a write failure so the caller can toast', async () => {
    const deps: SaveTextFileDeps = {
      pickPath: vi.fn().mockResolvedValue('/tmp/out.md'),
      writeFile: vi.fn().mockRejectedValue(new Error('disk full')),
    }
    await expect(
      saveTextFile('hello', { defaultPath: 'out.md' }, deps)
    ).rejects.toThrow('disk full')
  })
})
