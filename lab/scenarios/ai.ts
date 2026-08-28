// The AI accountability pipeline, end to end, with a scripted model.
//
// Everything interesting about this feature lives downstream of the one call
// that needs a multi-gigabyte vision model: streak counting, thresholds, the
// signed alert broadcast, audit rows, the report. The lab's llama stub answers
// that one call from a queue, which turns "does an alert fire after four
// distracted samples" from a thing you watch for into a thing you assert.

import { inviteAndAccept, onboard, pairViaContactCard } from '../src/flows'
import { scenario } from '../src/scenario'

const onTask = JSON.stringify({
  severity: 'on_task',
  reasoning: 'Editing a TypeScript file in an IDE.',
  on_topic_confidence: 0.95,
})
const blatant = JSON.stringify({
  severity: 'blatant',
  reasoning: 'A full-screen video unrelated to the declared topic.',
  on_topic_confidence: 0.05,
})

scenario('ai', async ({ lab, step, check, ui }) => {
  step('two machines, AI on for alice')
  const alice = await lab.addMachine({ name: 'alice', ai: true })
  const bob = await lab.addMachine({ name: 'bob' })
  await Promise.all([
    onboard(alice, { displayName: 'Alice' }),
    onboard(bob, { displayName: 'Bob' }),
  ])
  await pairViaContactCard(alice, bob)

  step('script the model: two focused samples, then a run of distracted ones')
  lab.llama.push({ content: onTask })
  lab.llama.push({ content: onTask })
  for (let i = 0; i < 8; i++) lab.llama.push({ content: blatant })

  step('start a session together')
  await inviteAndAccept(alice, bob, 'Bob', 'Alice')

  step('the sample loop reaches the stub')
  await ui.until(() => lab.llama.requests.length > 0, {
    label: 'the first inference request',
    timeoutMs: 60_000,
  })
  check('the model was asked something', lab.llama.requests.length > 0)

  step('the distracted run trips warning then alert')
  await ui.until(
    () => alice.backend.db.auditRows().some((row) => row.kind === 'ai_alert'),
    { label: 'an ai_alert audit row', timeoutMs: 120_000 }
  )
  const audit = alice.backend.db.auditRows()
  check(
    'a warning was recorded first',
    audit.some((row) => row.kind === 'ai_warning')
  )
  check(
    'an alert was recorded',
    audit.some((row) => row.kind === 'ai_alert')
  )
  check(
    'the alert carries the model reasoning',
    audit
      .filter((row) => row.kind === 'ai_alert')
      .some((row) => row.detail.includes('unrelated to the declared topic'))
  )

  step('the peer is told')
  await ui.until(
    () => bob.backend.db.auditRows().some((row) => row.kind === 'ai_alert'),
    { label: "bob's copy of the signed alert", timeoutMs: 30_000 }
  )
  check(
    'bob received the signed alert',
    bob.backend.db.auditRows().some((row) => row.kind === 'ai_alert')
  )

  step('leaving writes a session row with the focus numbers')
  // Not `click('Leave')` first: at 1280x800 the self-warning badge sits over
  // the button and intercepts the pointer, so the badge is dismissed the way a
  // user would. The overlap is recorded here rather than worked around
  // silently. Escape alone would not do it either — leaving is deliberately a
  // two-tap shortcut (see features/session/escLeave.ts).
  await ui.hover(alice.page(), 'Self-warning', { role: 'status' })
  await ui.click(alice.page(), 'Dismiss off-task warning')
  await ui.click(alice.page(), 'Leave')
  await ui.until(() => alice.backend.db.sessionsList().length > 0, {
    label: 'the session row',
    timeoutMs: 30_000,
  })
  const session = alice.backend.db.sessionsList()[0]
  check('a session row was written', session !== undefined)
  check('it recorded that AI was on', session?.ai_enabled === 1)
  check('it counted the samples', (session?.confident_samples ?? 0) > 0)

  // #236 — the raw observation journal is what the post-session write-up
  // narrates, and it is written by a fire-and-forget append whose failure the
  // app only whispers about at warn level. Assert the file, not the absence of
  // a crash: before `session_journal_append` existed here every append failed
  // and the only symptom was `no unhandled IPC` going red.
  step('the observation journal is on disk and readable')
  const journal = alice.backend.journalRead(session?.id ?? '')
  check('the journal recorded observations', journal.lines.length > 0)
  check(
    'every line is one parseable observation',
    journal.lines.every((line) => {
      try {
        const row = JSON.parse(line) as Record<string, unknown>
        return typeof row.ts === 'number' && typeof row.v === 'string'
      } catch {
        return false
      }
    })
  )
  check('the journal is not reported truncated', journal.truncated === false)

  // #236 — the post-session write-up. This scenario's own header has always
  // claimed it covers "the report"; until the journal commands existed here it
  // could not. The safety property is the one worth asserting: the model is
  // never credited for entries it did not produce. The lab's stub queue is
  // exhausted by the sample loop above, so the write-up finds no usable model
  // output and must fall back to the deterministic digest — and SAY so.
  step('the report writes the session up, and says who wrote it')
  await ui.waitForText(alice.page(), 'Minute by minute')
  await ui.until(
    () => alice.backend.db.sessionTimelineGet(session?.id ?? '') !== null,
    { label: 'the stored write-up row', timeoutMs: 60_000 }
  )
  const timeline = alice.backend.db.sessionTimelineGet(session?.id ?? '')
  check('a write-up row was stored', timeline !== null)
  check(
    'it is labelled as the raw checks, not the model',
    timeline?.source === 'observations'
  )
  check('no model is credited for it', timeline?.model_id === null)
  const entries = JSON.parse(timeline?.entries ?? '[]') as Array<
    Record<string, unknown>
  >
  check('it covers at least one stretch of the session', entries.length > 0)
  check(
    'every entry is a bounded time range with text',
    entries.every(
      (entry) =>
        typeof entry.start_min === 'number' &&
        typeof entry.end_min === 'number' &&
        entry.end_min > entry.start_min &&
        typeof entry.summary === 'string' &&
        entry.summary.length > 0
    )
  )

  check('no unhandled IPC', alice.backend.unhandled.size === 0)
})
