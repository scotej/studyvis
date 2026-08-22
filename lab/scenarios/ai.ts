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
  check('no unhandled IPC', alice.backend.unhandled.size === 0)
})
