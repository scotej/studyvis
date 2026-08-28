// #236 — the raw per-session AI observation journal, and the deterministic
// windowing that turns it into a minute-by-minute breakdown.
//
// The focus loop already produces one text judgment per check; until now only
// the off-task ones survived, as `ai_warning` / `ai_alert` audit rows. A
// session's on-task stretches — the part a written timeline is mostly made of —
// were discarded the moment the score machine had read them. Every resolved
// check now appends one NDJSON line to a per-session file beside the database
// (`commands/session_journal.rs`), which the post-session write-up reads back.
//
// Nothing here is signed, broadcast, or shown to peers: it is local evidence
// for the local user's own report, and it never leaves the machine. No frame
// ever reaches it — only the model's own words about what it saw.
//
// The windowing below is pure so it can be unit-tested, and because it is both
// the model's input AND the fallback rendering when the model writes nothing:
// a timeline assembled straight from these windows is still a real
// minute-by-minute account, just an unpolished one.

import { invoke } from '@tauri-apps/api/core'

import {
  isUncertainVerdict,
  type SampleVerdict,
  type Severity,
} from '@/features/ai/parseJudgment'
import { logger } from '@/lib/log'
import { useSettingsStore } from '@/stores/settingsStore'

const log = logger.child('session.journal')

// A resolved check whose response couldn't be read is recorded as such rather
// than dropped: "the AI looked and couldn't tell" is part of what happened.
export type ObservationVerdict = Severity | 'uncertain'

export type SessionObservation = {
  ts: number
  verdict: ObservationVerdict
  // The model's own reasoning for this check. Clamped on write.
  reasoning: string
  // `on_topic_confidence` from the judgment; null for an uncertain check.
  confidence: number | null
  // The declared topic at the moment of the check, so a mid-session topic
  // change is visible in the write-up without re-deriving it from audit rows.
  topic: string
}

// Line budget. The Rust side refuses anything above 4 KiB; these keep a normal
// line an order of magnitude below that.
export const MAX_REASONING_LENGTH = 300
export const MAX_TOPIC_LENGTH = 120

// At most this many windows in one timeline. A one-minute window is the
// requested granularity, but an all-day session must not produce a 480-entry
// report or an unbounded number of model requests, so long sessions widen the
// window instead of growing the count.
export const MAX_WINDOWS = 60

// Distinct reasoning strings carried into one window's digest. The focus model
// runs at temperature 0, so repeats are the norm and three distinct notes
// already describe a minute well.
export const MAX_WINDOW_NOTES = 3

export type SessionJournalRuntime = {
  append: (sessionId: string, lines: string[]) => Promise<void>
  read: (sessionId: string) => Promise<{ lines: string[]; truncated: boolean }>
  now: () => number
}

const defaultRuntime: SessionJournalRuntime = {
  append: async (sessionId, lines) => {
    await invoke('session_journal_append', { sessionId, lines })
  },
  read: (sessionId) =>
    invoke<{ lines: string[]; truncated: boolean }>('session_journal_read', {
      sessionId,
    }),
  now: () => Date.now(),
}

let activeRuntime: SessionJournalRuntime = defaultRuntime

export function __setSessionJournalRuntime(
  runtime: SessionJournalRuntime
): void {
  activeRuntime = runtime
}

export function __resetSessionJournalRuntime(): void {
  activeRuntime = defaultRuntime
}

// Collapse-then-clamp, shared with the write-up in sessionTimeline.ts: every
// string that reaches a journal line, a prompt, or a rendered entry goes
// through exactly this.
export function boundedText(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

// One JSON object per line. Keys are short because a long session writes
// thousands of them, and the file is read back whole.
export function serializeObservation(observation: SessionObservation): string {
  return JSON.stringify({
    ts: Math.round(observation.ts),
    v: observation.verdict,
    r: boundedText(observation.reasoning, MAX_REASONING_LENGTH),
    c: observation.confidence,
    t: boundedText(observation.topic, MAX_TOPIC_LENGTH),
  })
}

function isVerdict(value: unknown): value is ObservationVerdict {
  return (
    value === 'on_task' ||
    value === 'mild' ||
    value === 'moderate' ||
    value === 'blatant' ||
    value === 'uncertain'
  )
}

// Manual type-guards rather than a validation library, matching the house style
// in parseJudgment.ts. A line this cannot read is skipped, never fatal: a
// partially written tail must not cost the user the rest of their timeline.
export function parseObservation(line: string): SessionObservation | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null
  const raw = parsed as Record<string, unknown>
  if (typeof raw.ts !== 'number' || !Number.isFinite(raw.ts)) return null
  if (!isVerdict(raw.v)) return null
  const confidence =
    typeof raw.c === 'number' && Number.isFinite(raw.c) ? raw.c : null
  return {
    ts: raw.ts,
    verdict: raw.v,
    reasoning: typeof raw.r === 'string' ? raw.r : '',
    confidence,
    topic: typeof raw.t === 'string' ? raw.t : '',
  }
}

// Fire-and-forget, like `auditStore.append`: the sample loop must never wait on
// disk, and a failed journal line costs a line of narrative, nothing else.
export async function appendObservation(
  sessionId: string,
  observation: SessionObservation
): Promise<void> {
  try {
    await activeRuntime.append(sessionId, [serializeObservation(observation)])
  } catch (err) {
    log.warn('append.failed', { err })
  }
}

// The sample loop's own verdict, as one journal record. An unreadable response
// is kept as `uncertain` with the parser's reason rather than dropped: a
// stretch the AI could not read is part of the account of the session.
export function observationFromVerdict(
  verdict: SampleVerdict,
  topic: string,
  ts: number
): SessionObservation {
  if (isUncertainVerdict(verdict)) {
    return {
      ts,
      verdict: 'uncertain',
      reasoning: verdict.reason,
      confidence: null,
      topic,
    }
  }
  return {
    ts,
    verdict: verdict.severity,
    reasoning: verdict.reasoning,
    confidence: verdict.on_topic_confidence,
    topic,
  }
}

// Called once per resolved check from the session's score-event dispatcher.
// Both gates are read here rather than captured, so turning the setting off
// mid-session stops the next line — the same per-tick-getter discipline the
// sample loop uses for topic and cadence.
export async function recordSampleObservation(args: {
  sessionId: string | null
  verdict: SampleVerdict
  topic: string
}): Promise<void> {
  if (!args.sessionId) return
  if (!useSettingsStore.getState().values.sessionTimelineEnabled) return
  await appendObservation(
    args.sessionId,
    observationFromVerdict(args.verdict, args.topic, activeRuntime.now())
  )
}

export type SessionJournalRead = {
  observations: SessionObservation[]
  // The file held more than was returned — a session long enough to hit the
  // size cap. The report says so rather than presenting a partial account as
  // the whole session.
  truncated: boolean
  unreadableLines: number
}

export async function readObservations(
  sessionId: string
): Promise<SessionJournalRead> {
  const raw = await activeRuntime.read(sessionId)
  const observations: SessionObservation[] = []
  let unreadableLines = 0
  for (const line of raw.lines) {
    const parsed = parseObservation(line)
    if (parsed) observations.push(parsed)
    else unreadableLines += 1
  }
  observations.sort((a, b) => a.ts - b.ts)
  return { observations, truncated: raw.truncated, unreadableLines }
}

export type ObservationWindow = {
  // Whole minutes from the first observation, inclusive start / exclusive end.
  startMin: number
  endMin: number
  onTask: number
  offTask: number
  uncertain: number
  // Declared topics seen during the window, first-seen order.
  topics: string[]
  // Distinct reasoning strings, most frequent first.
  notes: string[]
}

// Window width for a session of `spanMinutes`, so the timeline never exceeds
// MAX_WINDOWS entries. One minute is the floor — the requested granularity —
// and anything longer widens in whole minutes from there. The divisor is the
// number of distinct minutes the span touches, not the span itself: a session
// spanning exactly 60 minutes occupies minutes 0 through 60, which is 61
// windows at width 1.
export function windowMinutesFor(spanMinutes: number): number {
  if (!Number.isFinite(spanMinutes) || spanMinutes <= 0) return 1
  const minutesTouched = Math.floor(spanMinutes) + 1
  return Math.max(1, Math.ceil(minutesTouched / MAX_WINDOWS))
}

// Groups observations into fixed-width windows anchored on the first one.
// Empty windows are dropped rather than rendered as a gap: a paused capture
// (break, camera off, pomodoro rest) produces no observations, and inventing
// "nothing happened" rows for it would read as an accusation.
export function windowObservations(
  observations: ReadonlyArray<SessionObservation>
): ObservationWindow[] {
  if (observations.length === 0) return []
  const sorted = [...observations].sort((a, b) => a.ts - b.ts)
  const anchor = sorted[0].ts
  const spanMinutes = (sorted[sorted.length - 1].ts - anchor) / 60_000
  const width = windowMinutesFor(spanMinutes)

  const byIndex = new Map<
    number,
    { window: ObservationWindow; counts: Map<string, number> }
  >()
  for (const observation of sorted) {
    const minute = Math.max(0, Math.floor((observation.ts - anchor) / 60_000))
    const index = Math.floor(minute / width)
    let bucket = byIndex.get(index)
    if (!bucket) {
      bucket = {
        window: {
          startMin: index * width,
          endMin: (index + 1) * width,
          onTask: 0,
          offTask: 0,
          uncertain: 0,
          topics: [],
          notes: [],
        },
        counts: new Map(),
      }
      byIndex.set(index, bucket)
    }
    if (observation.verdict === 'uncertain') bucket.window.uncertain += 1
    else if (observation.verdict === 'on_task') bucket.window.onTask += 1
    else bucket.window.offTask += 1

    const topic = observation.topic.trim()
    if (topic && !bucket.window.topics.includes(topic)) {
      bucket.window.topics.push(topic)
    }
    const note = observation.reasoning.trim()
    if (note) bucket.counts.set(note, (bucket.counts.get(note) ?? 0) + 1)
  }

  return Array.from(byIndex.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, bucket]) => ({
      ...bucket.window,
      notes: Array.from(bucket.counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_WINDOW_NOTES)
        .map(([note]) => note),
    }))
}
