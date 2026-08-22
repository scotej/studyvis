// Saving a file goes through the one command that writes to a caller-supplied
// path, so it is worth a scenario: the picker is answered by the lab, the file
// lands where the app asked, and a second save replaces rather than appends.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { onboard } from '../src/flows'
import { scenario } from '../src/scenario'

scenario('exports', async ({ lab, step, check }) => {
  step('one onboarded machine')
  const alice = await lab.addMachine({ name: 'alice' })
  await onboard(alice, { displayName: 'Alice' })

  step('the app writes where the save dialog pointed it')
  const target = path.join(alice.backend.dir, 'export.txt')
  alice.backend.queueDialogAnswer(target)
  await alice.backend.invoke('system_write_text_file', {
    path: target,
    contents: 'first',
  })
  check(
    'the file has the first contents',
    readFileSync(target, 'utf8') === 'first'
  )

  step('a second save replaces it, as std::fs::write does')
  await alice.backend.invoke('system_write_text_file', {
    path: target,
    contents: 'second',
  })
  check(
    'the file was replaced, not appended to',
    readFileSync(target, 'utf8') === 'second'
  )

  step('a path outside the machine is refused, not silently redirected')
  let refused = false
  await alice.backend
    .invoke('system_write_text_file', {
      path: '/tmp/studyvis-lab-should-not-exist.txt',
      contents: 'nope',
    })
    .catch(() => {
      refused = true
    })
  check('writing outside the workdir throws', refused)
})
