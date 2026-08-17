import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  FIELDS_MAX_ARRAY,
  FIELDS_MAX_KEYS,
  FLUSH_MAX_BATCH,
  FIELD_MAX_CHARS,
  MSG_MAX_CHARS,
  PENDING_MAX,
  REDACTED,
  REDACTED_MNEMONIC,
  RING_CAPACITY,
  SINK_FAILURE_LIMIT,
  SINK_MAX_LINES_PER_CALL,
  STACK_MAX_CHARS,
  THROTTLE_KEYS_MAX,
  THROTTLE_WINDOW_MS,
  TRUNCATED,
  __resetLog,
  __setLogRecordSink,
  __setLogRuntime,
  flushLog,
  formatRecords,
  installLogSink,
  logHealth,
  logger,
  parseRecordLines,
  recentRecords,
  redactFields,
  sanitizeText,
  setLogContext,
  type LogRecord,
} from '@/lib/log'

// Manual clock + timer queue: the module forks globalThis vs window for
// setTimeout, and every flush assertion needs the trailing-edge debounce to
// fire exactly when the test says so.
function makeClock() {
  let now = 1_700_000_000_000
  const timers = new Map<number, () => void>()
  let nextHandle = 1
  return {
    install() {
      __setLogRuntime({
        now: () => now,
        setTimeout: (handler: () => void) => {
          const handle = nextHandle++
          timers.set(handle, handler)
          return handle
        },
        clearTimeout: (handle: unknown) => {
          timers.delete(handle as number)
        },
      })
    },
    advance(ms: number) {
      now += ms
    },
    runTimers() {
      const due = [...timers.values()]
      timers.clear()
      for (const handler of due) handler()
    },
    get pendingTimers() {
      return timers.size
    },
  }
}

let clock: ReturnType<typeof makeClock>
let consoleError: ReturnType<typeof vi.spyOn>
let consoleWarn: ReturnType<typeof vi.spyOn>
let consoleInfo: ReturnType<typeof vi.spyOn>
let consoleDebug: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  __resetLog()
  clock = makeClock()
  clock.install()
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {})
  consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  __resetLog()
})

function captured(): LogRecord[] {
  return recentRecords()
}

describe('record shape', () => {
  test('carries the schema, an ISO timestamp from the clock, and a rising seq', () => {
    logger.child('session').info('one')
    logger.child('session').info('two')
    const records = captured()
    expect(records).toHaveLength(2)
    expect(records[0]?.v).toBe(1)
    expect(records[0]?.ts).toBe(new Date(1_700_000_000_000).toISOString())
    expect(records[0]?.seq).toBe(1)
    expect(records[1]?.seq).toBe(2)
    expect(records[0]?.run).toMatch(/^[0-9a-f]{8}$/)
    expect(records[0]?.win).toBe('main')
  })

  test('child scopes join with a dot', () => {
    logger.child('session').child('break').warn('denied')
    expect(captured()[0]?.scope).toBe('session.break')
  })

  test('a record logged on the root lands under the app scope', () => {
    logger.warn('rootless')
    expect(captured()[0]?.scope).toBe('app')
  })

  test('data is omitted when there are no fields, and when redaction empties them', () => {
    logger.info('bare')
    logger.info('only-a-function', { fn: () => undefined })
    const records = captured()
    expect(records[0]).not.toHaveProperty('data')
    expect(records[1]).not.toHaveProperty('data')
  })

  test('setLogContext stamps sess on later records and clears it again', () => {
    setLogContext({ sess: 'abcd1234-full-topic-must-not-leak' })
    logger.info('joined')
    setLogContext({ sess: undefined })
    logger.info('left')
    const records = captured()
    expect(records[0]?.sess).toBe('abcd1234')
    expect(records[1]?.sess).toBeUndefined()
  })

  test('the first record of a run describes the run', () => {
    __resetLog()
    clock.install()
    installLogSink({
      window: 'ai-dialog',
      appVersion: '9.9.9-test',
      installGlobalHandlers: false,
    })
    const first = captured()[0]
    expect(first?.msg).toBe('run.start')
    expect(first?.win).toBe('ai-dialog')
    expect(first?.data?.app).toBe('9.9.9-test')
    expect(first?.data?.schema).toBe(1)
  })
})

describe('console mirror', () => {
  test('warn and error reach the console with the gate off', () => {
    logger.child('nostr.pool').warn('relay.notice', { notice: 'rate limited' })
    logger.child('nostr.pool').error('relay.failed')
    expect(consoleWarn).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(consoleWarn.mock.calls[0]?.[0]).toBe('[nostr.pool] relay.notice')
    expect(consoleWarn.mock.calls[0]?.[1]).toEqual({ notice: 'rate limited' })
  })

  test('info and debug are silent with the gate off and audible with it on', () => {
    logger.info('quiet')
    logger.debug('quieter')
    expect(consoleInfo).not.toHaveBeenCalled()
    expect(consoleDebug).not.toHaveBeenCalled()

    installLogSink({
      window: 'main',
      appVersion: '0.0.0',
      debugEnabled: () => true,
      installGlobalHandlers: false,
    })
    logger.info('loud')
    logger.debug('louder')
    expect(consoleInfo).toHaveBeenCalled()
    expect(consoleDebug).toHaveBeenCalledTimes(1)
  })

  test('the gate is read per record, not cached at install', () => {
    let enabled = false
    installLogSink({
      window: 'main',
      appVersion: '0.0.0',
      debugEnabled: () => enabled,
      installGlobalHandlers: false,
    })
    logger.debug('before')
    enabled = true
    logger.debug('after')
    expect(consoleDebug).toHaveBeenCalledTimes(1)
    expect(consoleDebug.mock.calls[0]?.[0]).toBe('[app] after')
  })

  test('console arity never exceeds two arguments', () => {
    logger.warn('no-fields')
    logger.warn('with-fields', { a: 1 })
    expect(consoleWarn.mock.calls[0]).toHaveLength(1)
    expect(consoleWarn.mock.calls[1]).toHaveLength(2)
  })
})

describe('sanitizeText (the I80 contract, generalised)', () => {
  test('control and format characters become single spaces, meaning survives', () => {
    const forged = 'ok\nrestricted: policy\u202Ereversed\r\n'
    const clean = sanitizeText(forged)
    expect(clean).not.toMatch(/[\p{Cc}\p{Cf}]/u)
    expect(clean).toContain('restricted: policy')
    expect(clean).toContain('reversed')
  })

  test('clamps with a trailing ellipsis', () => {
    const clean = sanitizeText('x'.repeat(5_000))
    expect(clean.length).toBe(FIELD_MAX_CHARS + 1)
    expect(clean.endsWith('…')).toBe(true)
  })

  test('an interpolated message records as one clamped line', () => {
    logger.warn(`peer said:\n${'y'.repeat(500)}`)
    const msg = captured()[0]?.msg ?? ''
    expect(msg).not.toContain('\n')
    expect(msg.length).toBe(MSG_MAX_CHARS + 1)
  })
})

describe('redaction', () => {
  test('secret-named string keys are replaced without being sampled', () => {
    const out = redactFields({
      username: 'scott',
      credential: 'hunter2',
      turnCredential: 'hunter2',
      apiKey: 'sk-live-abc',
      hfToken: 'hf_abc',
      tokenCount: 512,
    })
    expect(out.username).toBe('scott')
    expect(out.credential).toBe(REDACTED)
    expect(out.turnCredential).toBe(REDACTED)
    expect(out.apiKey).toBe(REDACTED)
    expect(out.hfToken).toBe(REDACTED)
    expect(out.tokenCount).toBe(512)
  })

  test('secret keys are redacted at depth too', () => {
    const out = redactFields({ turn: { server: { password: 'p' } } })
    expect(JSON.stringify(out)).not.toContain('"p"')
  })

  test.each([12, 15, 18, 21, 24])('a %i-word run is redacted', (count) => {
    const words = Array.from({ length: count }, () => 'abandon').join(' ')
    expect(sanitizeText(words)).toBe(REDACTED_MNEMONIC)
  })

  test('a newline-joined mnemonic is redacted (stripping runs first)', () => {
    const words = Array.from({ length: 12 }, () => 'abandon').join('\n')
    expect(sanitizeText(words)).toBe(REDACTED_MNEMONIC)
  })

  test('an eleven-word run is left alone', () => {
    const words = Array.from({ length: 11 }, () => 'abandon').join(' ')
    expect(sanitizeText(words)).toBe(words)
  })

  test('a long lowercase run is prose, not a mnemonic', () => {
    // The normal ai.parse failure is a couple of hundred words of lowercase
    // model prose. Redacting that would throw away the most useful field on
    // the record, so only an exactly-BIP39-length run counts.
    const prose = Array.from({ length: 60 }, () => 'prose').join(' ')
    expect(sanitizeText(prose, 5_000)).toBe(prose)
  })

  test('home directories lose the username on all three platforms', () => {
    expect(sanitizeText('/Users/scott/Library/app.db')).toBe(
      '/Users/~/Library/app.db'
    )
    expect(sanitizeText('/home/scott/.local/share/app.db')).toBe(
      '/home/~/.local/share/app.db'
    )
    expect(sanitizeText('C:\\Users\\scott\\AppData\\app.db')).toBe(
      'C:\\Users\\~\\AppData\\app.db'
    )
  })

  test('a profile folder with a space in it loses all of it', () => {
    // A Windows account created from a full name gives C:\Users\John Smith.
    // Stopping the match at the space left the surname in the blob.
    expect(sanitizeText('C:\\Users\\John Smith\\AppData\\app.db')).toBe(
      'C:\\Users\\~\\AppData\\app.db'
    )
    expect(sanitizeText('/Users/John Smith/Library/app.db')).toBe(
      '/Users/~/Library/app.db'
    )
  })

  test('long hex truncates to eight characters, short hex does not', () => {
    const pubkey = 'a'.repeat(64)
    expect(sanitizeText(pubkey)).toBe(`${'a'.repeat(8)}…`)
    expect(sanitizeText('abcdef0123456789')).toBe('abcdef0123456789')
  })

  test('an Error expands to name, message and a longer-clamped stack', () => {
    const err = new TypeError('boom')
    err.stack = `TypeError: boom\n${'s'.repeat(5_000)}`
    const out = redactFields({ err, other: 'o'.repeat(5_000) }) as {
      err: { name: string; message: string; stack: string }
      other: string
    }
    expect(out.err.name).toBe('TypeError')
    expect(out.err.message).toBe('boom')
    expect(out.err.stack.length).toBe(STACK_MAX_CHARS + 1)
    expect(out.other.length).toBe(FIELD_MAX_CHARS + 1)
  })

  test('objects, arrays and depth are all bounded and still serialisable', () => {
    const wide: Record<string, number> = {}
    for (let i = 0; i < 200; i += 1) wide[`k${i}`] = i
    const out = redactFields({
      wide,
      long: Array.from({ length: 100 }, (_, i) => i),
      deep: { a: { b: { c: { d: 'too far' } } } },
    }) as { wide: Record<string, unknown>; long: unknown[] }
    expect(Object.keys(out.wide)).toHaveLength(FIELDS_MAX_KEYS + 1)
    expect(out.long).toHaveLength(FIELDS_MAX_ARRAY + 1)
    expect(out.long[FIELDS_MAX_ARRAY]).toBe(TRUNCATED)
    expect(() => JSON.stringify(out)).not.toThrow()
    expect(JSON.stringify(out)).toContain('too far'.slice(0, 0) + TRUNCATED)
  })

  test('a self-referencing object records as circular and still stringifies', () => {
    const cycle: Record<string, unknown> = { name: 'loop' }
    cycle.self = cycle
    const out = redactFields({ cycle })
    expect(JSON.stringify(out)).toContain('[circular]')
  })

  test('the caller object is never mutated', () => {
    const fields = { credential: 'hunter2', nested: { password: 'p' } }
    redactFields(fields)
    expect(fields.credential).toBe('hunter2')
    expect(fields.nested.password).toBe('p')
  })

  test('nothing sensitive survives the whole pipeline', () => {
    logger.error('identity.recover_failed', {
      mnemonic: Array.from({ length: 12 }, () => 'abandon').join(' '),
      err: new Error(
        'failed at /Users/scott/Library/studyvis for key ' + 'f'.repeat(64)
      ),
      turnCredential: 'hunter2',
    })
    const record = captured()[0]!
    const serialised = JSON.stringify(record) + formatRecords([record])
    expect(serialised).not.toContain('abandon abandon')
    expect(serialised).not.toContain('scott')
    expect(serialised).not.toContain('hunter2')
    expect(serialised).not.toContain('f'.repeat(64))
  })
})

describe('ring buffer and throttle', () => {
  test('the ring evicts oldest-first and the gap is visible in seq', () => {
    for (let i = 0; i < RING_CAPACITY + 50; i += 1) logger.info(`m${i}`)
    const records = captured()
    expect(records).toHaveLength(RING_CAPACITY)
    expect(records[0]?.msg).toBe('m50')
    expect(records[0]?.seq).toBe(51)
  })

  test('identical records inside the window collapse onto one', () => {
    for (let i = 0; i < 20; i += 1) logger.warn('join.error', { room: 'x' })
    const records = captured()
    expect(records).toHaveLength(1)
    expect(records[0]?.n).toBe(20)
    expect(consoleWarn).toHaveBeenCalledTimes(1)
  })

  test('interleaved keys each collapse — the real flood shape', () => {
    for (let i = 0; i < 20; i += 1) {
      logger.warn('a')
      logger.warn('b')
    }
    const records = captured()
    expect(records).toHaveLength(2)
    expect(records[0]?.n).toBe(20)
    expect(records[1]?.n).toBe(20)
  })

  test('the window reopens once it has elapsed', () => {
    logger.warn('again')
    clock.advance(THROTTLE_WINDOW_MS + 1)
    logger.warn('again')
    expect(captured()).toHaveLength(2)
  })

  test('debug records never throttle because each one is timeline evidence', () => {
    for (let i = 0; i < 5; i += 1) {
      logger.debug('sample.resolved', { tick: i })
    }
    const records = captured()
    expect(records).toHaveLength(5)
    expect(records.map((record) => record.data?.tick)).toEqual([0, 1, 2, 3, 4])
    expect(records.every((record) => record.n === undefined)).toBe(true)
  })

  test('a flood cannot evict the boot record', () => {
    logger.info('run.start')
    for (let i = 0; i < 2_000; i += 1) logger.warn('flood')
    expect(captured().some((r) => r.msg === 'run.start')).toBe(true)
  })

  test('the throttle map stays bounded under churn', () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      for (let i = 0; i < THROTTLE_KEYS_MAX + 32; i += 1) logger.info(`k${i}`)
    }
    expect(logHealth().buffered).toBeLessThanOrEqual(RING_CAPACITY)
  })
})

describe('flush and sink', () => {
  function installWriter(impl?: (lines: string[]) => Promise<void>) {
    const writeLines = vi.fn(impl ?? (() => Promise.resolve()))
    installLogSink({
      window: 'main',
      appVersion: '0.0.0',
      writeLines,
      installGlobalHandlers: false,
    })
    return writeLines
  }

  test('nothing is written before a sink exists, and the backlog drains after', async () => {
    for (let i = 0; i < 10; i += 1) logger.info(`pre${i}`)
    expect(logHealth().pending).toBe(10)
    const writeLines = installWriter()
    await flushLog()
    expect(writeLines).toHaveBeenCalledTimes(1)
    // 10 pre-install records plus run.start.
    expect(writeLines.mock.calls[0]?.[0]).toHaveLength(11)
  })

  test('a burst inside the debounce window becomes one call', async () => {
    const writeLines = installWriter()
    await flushLog()
    writeLines.mockClear()
    for (let i = 0; i < 20; i += 1) logger.info(`m${i}`)
    expect(writeLines).not.toHaveBeenCalled()
    clock.runTimers()
    expect(writeLines).toHaveBeenCalledTimes(1)
    expect(writeLines.mock.calls[0]?.[0]).toHaveLength(20)
  })

  test('a full batch flushes without the timer firing', async () => {
    const writeLines = installWriter()
    await flushLog()
    writeLines.mockClear()
    for (let i = 0; i < FLUSH_MAX_BATCH; i += 1) logger.info(`m${i}`)
    expect(writeLines).toHaveBeenCalledTimes(1)
  })

  test('an error record flushes immediately', async () => {
    const writeLines = installWriter()
    await flushLog()
    writeLines.mockClear()
    logger.error('install.failed')
    expect(writeLines).toHaveBeenCalledTimes(1)
  })

  test('records queued during a write are drained without another emit', async () => {
    const writeLines = installWriter()
    await flushLog()
    writeLines.mockClear()
    logger.error('first')
    // Still in flight: the queue below cannot start its own drain.
    logger.info('queued-behind')
    await Promise.resolve()
    await Promise.resolve()
    expect(logHealth().pending).toBe(1)
    clock.runTimers()
    await flushLog()
    expect(logHealth().pending).toBe(0)
    expect(writeLines).toHaveBeenCalledTimes(2)
  })

  test('flushLog waits for records queued while it was awaiting', async () => {
    let calls = 0
    const writeLines = vi.fn(async () => {
      calls += 1
      if (calls === 1) logger.info('written-during-flush')
      await Promise.resolve()
    })
    installLogSink({
      window: 'main',
      appVersion: '0.0.0',
      writeLines,
      installGlobalHandlers: false,
    })
    await flushLog()
    expect(writeLines).toHaveBeenCalledTimes(2)
    expect(logHealth().pending).toBe(0)
  })

  // #226 — applog.rs's render_batch writes the FIRST MAX_LINES_PER_CALL lines
  // of a batch and returns Ok for the rest, so an over-ceiling batch silently
  // lost its NEWEST records: precisely the incident tail a bug report is
  // exported for. `enqueue` drops oldest-first, so the two ends disagreed.
  test('a batch over the sink ceiling is chunked, in order, with no loss', async () => {
    const seen: string[][] = []
    const writeLines = installWriter(async (lines) => {
      seen.push(lines)
    })
    const total = SINK_MAX_LINES_PER_CALL * 2 + 37
    for (let i = 0; i < total; i += 1) logger.debug(`burst${i}`)
    await flushLog()

    expect(writeLines.mock.calls.length).toBeGreaterThan(1)
    for (const chunk of seen) {
      expect(chunk.length).toBeLessThanOrEqual(SINK_MAX_LINES_PER_CALL)
    }
    // Order across the chunk boundaries must be the emission order, and every
    // burst record must survive — `run.start` rides along ahead of them.
    const burst = seen
      .flat()
      .map((line) => JSON.parse(line).msg as string)
      .filter((msg) => msg.startsWith('burst'))
    expect(burst).toEqual(Array.from({ length: total }, (_, i) => `burst${i}`))
    expect(logHealth().pending).toBe(0)
  })

  test('a chunk rejection keeps the chunks already written', async () => {
    let call = 0
    installWriter(async () => {
      call += 1
      if (call === 2) throw new Error('nope')
    })
    for (let i = 0; i < SINK_MAX_LINES_PER_CALL * 3; i += 1) {
      logger.debug(`burst${i}`)
    }
    await flushLog()
    // One failed drain, not one per chunk — the sink must survive a single
    // transient rejection rather than spending its whole failure budget.
    expect(logHealth().writeFailures).toBe(1)
    expect(logHealth().sinkDisabled).toBe(false)
  })

  test('a rejecting sink never throws into the caller', async () => {
    installWriter(() => Promise.reject(new Error('nope')))
    await flushLog()
    expect(logHealth().writeFailures).toBe(1)
    logger.info('still fine')
    await expect(flushLog()).resolves.toBeUndefined()
  })

  test('a repeatedly failing sink is disabled for the run', async () => {
    const writeLines = installWriter(() => Promise.reject(new Error('nope')))
    for (let i = 0; i < SINK_FAILURE_LIMIT; i += 1) {
      logger.error(`fail${i}`)
      await flushLog()
    }
    expect(logHealth().sinkDisabled).toBe(true)
    const before = writeLines.mock.calls.length
    logger.error('after')
    await flushLog()
    expect(writeLines.mock.calls).toHaveLength(before)
  })

  test('a wedged sink cannot grow memory without bound', async () => {
    const releases: (() => void)[] = []
    installWriter(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve)
        })
    )
    for (let i = 0; i < PENDING_MAX + 100; i += 1) logger.info(`m${i}`)
    expect(logHealth().pending).toBeLessThanOrEqual(PENDING_MAX)
    expect(logHealth().droppedRecords).toBeGreaterThan(0)
    for (const release of releases) release()
  })

  test('every line handed to the sink is one parseable JSON object', async () => {
    const writeLines = installWriter()
    logger.warn('relay.notice', { notice: '", "lvl": "error"\nforged' })
    await flushLog()
    const lines = writeLines.mock.calls.flatMap((call) => call[0])
    for (const line of lines) {
      expect(line).not.toContain('\n')
      expect(() => JSON.parse(line)).not.toThrow()
    }
    const forged = lines
      .map((line) => JSON.parse(line) as LogRecord)
      .find((r) => r.msg === 'relay.notice')
    expect(forged?.lvl).toBe('warn')
    expect(String(forged?.data?.notice)).toContain('forged')
  })

  test('debug always reaches disk while the gate controls only its console mirror', async () => {
    let enabled = false
    const writeLines = vi.fn<(lines: string[]) => Promise<void>>()
    writeLines.mockResolvedValue(undefined)
    installLogSink({
      window: 'main',
      appVersion: '0.0.0',
      debugEnabled: () => enabled,
      writeLines,
      installGlobalHandlers: false,
    })
    await flushLog()
    writeLines.mockClear()
    consoleDebug.mockClear()
    logger.debug('off')
    await flushLog()
    expect(writeLines).toHaveBeenCalledTimes(1)
    const firstBatch = writeLines.mock.calls.flatMap((call) => call[0])
    expect(
      firstBatch.some((line) => (JSON.parse(line) as LogRecord).msg === 'off')
    ).toBe(true)
    expect(consoleDebug).not.toHaveBeenCalled()
    expect(captured().some((r) => r.msg === 'off')).toBe(true)
    writeLines.mockClear()
    enabled = true
    logger.debug('on')
    await flushLog()
    expect(writeLines).toHaveBeenCalledTimes(1)
    expect(consoleDebug).toHaveBeenCalledTimes(1)
  })

  test('a collapsed burst is still counted on disk', async () => {
    const writeLines = installWriter()
    for (let i = 0; i < 5; i += 1) logger.warn('join.error')
    await flushLog()
    const lines = writeLines.mock.calls.flatMap((call) => call[0])
    const repeat = lines
      .map((line) => JSON.parse(line) as LogRecord)
      .find((r) => r.msg === 'repeat')
    expect(repeat?.data?.n).toBe(4)
  })

  test('folds that outlive their window are still counted on disk', async () => {
    // The dangerous spacing: slower than the 1 s flush debounce, faster than
    // the 10 s throttle window, so the window rolls over before any drain has
    // reported the tally. Zeroing it there lost every fold.
    const writeLines = installWriter()
    await flushLog()
    writeLines.mockClear()
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 5; i += 1) {
        logger.warn('join.error')
        clock.advance(2_000)
      }
    }
    await flushLog()
    const counted = writeLines.mock.calls
      .flatMap((call) => call[0])
      .map((line) => JSON.parse(line) as LogRecord)
      .reduce(
        (total, r) =>
          r.msg === 'join.error'
            ? total + 1
            : r.msg === 'repeat'
              ? total + Number(r.data?.n ?? 0)
              : total,
        0
      )
    expect(counted).toBe(15)
  })

  test('flushLog resolves when no sink is installed', async () => {
    logger.info('orphan')
    await expect(flushLog()).resolves.toBeUndefined()
    expect(logHealth().pending).toBe(1)
  })
})

describe('reading back', () => {
  test('formatRecords is oldest-first, shows repeats, one line per record', () => {
    logger.warn('a')
    logger.warn('a')
    clock.advance(THROTTLE_WINDOW_MS + 1)
    logger.error('b', { code: 7 })
    const text = formatRecords(captured())
    const lines = text.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('[app] a ×2')
    expect(lines[1]).toContain('[app] b')
    expect(lines[1]).toContain('{"code":7}')
  })

  test('parseRecordLines skips a truncated leading fragment', () => {
    const good = JSON.stringify({ scope: 'app', msg: 'ok' })
    expect(parseRecordLines(['{"scope":"ap', good])).toHaveLength(1)
  })
})

describe('environment', () => {
  test('every level is safe with no window, no sink and no Tauri', async () => {
    expect(typeof window).toBe('undefined')
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    expect(captured()).toHaveLength(4)
    await expect(flushLog()).resolves.toBeUndefined()
  })

  test('the record sink sees every record after redaction', () => {
    const seen: LogRecord[] = []
    __setLogRecordSink((record) => seen.push(record))
    logger.warn('relay.notice', { credential: 'hunter2' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.data?.credential).toBe(REDACTED)
  })

  test('__resetLog clears the ring, the queue and the seams', () => {
    __setLogRecordSink(() => {
      throw new Error('should have been cleared')
    })
    logger.info('before')
    __resetLog()
    expect(recentRecords()).toHaveLength(0)
    expect(logHealth()).toEqual({
      buffered: 0,
      pending: 0,
      droppedRecords: 0,
      writeFailures: 0,
      sinkDisabled: false,
    })
  })
})
