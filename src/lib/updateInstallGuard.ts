import { strings } from '@/strings'

let installation: symbol | null = null

// Session admission is synchronous through sessionStore.begin. Holding this
// reservation before updater IPC prevents every later admission until relaunch.
export function reserveUpdateInstall(): (() => void) | null {
  if (installation !== null) return null
  const token = Symbol()
  installation = token
  return () => {
    if (installation === token) installation = null
  }
}

export function isUpdateInstallReserved(): boolean {
  return installation !== null
}

export function assertSessionAdmissionAllowed(): void {
  if (isUpdateInstallReserved()) {
    throw new Error(strings.updater.sessionStartBlocked)
  }
}
