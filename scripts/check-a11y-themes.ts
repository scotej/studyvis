import { spawnSync } from 'node:child_process'

for (const theme of ['dark', 'light']) {
  console.log(`Auditing every Storybook story in ${theme} at 1024×640`)
  const result = spawnSync(
    'test-storybook',
    ['--url', 'http://127.0.0.1:6006', '--maxWorkers', '2'],
    {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      timeout: 600_000,
      env: { ...process.env, STUDYVIS_A11Y_THEME: theme },
    }
  )
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
