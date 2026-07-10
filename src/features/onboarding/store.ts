// Onboarding-completion flag, persisted as `onboarding_completed_at` in the
// Tauri store file `app-state.json` (separate from settings.json). Outside a
// Tauri runtime (Storybook / node tests) `readOnboardingCompletedAt()`
// resolves to null and the writes no-op; `useOnboardingState()` maps that to
// a 'pending' status, so onboarding simply renders.

import { useCallback, useEffect, useState } from 'react'
import { LazyStore } from '@tauri-apps/plugin-store'

const STORE_FILE = 'app-state.json'
const KEY_COMPLETED_AT = 'onboarding_completed_at'

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

let cached: LazyStore | null = null
function getStore(): LazyStore {
  if (!cached) cached = new LazyStore(STORE_FILE)
  return cached
}

export async function readOnboardingCompletedAt(): Promise<number | null> {
  if (!isTauriRuntime()) return null
  const value = await getStore().get<number>(KEY_COMPLETED_AT)
  return typeof value === 'number' ? value : null
}

export async function writeOnboardingCompletedAt(): Promise<void> {
  if (!isTauriRuntime()) return
  const store = getStore()
  await store.set(KEY_COMPLETED_AT, Date.now())
  await store.save()
}

export async function resetOnboardingCompletedAt(): Promise<void> {
  if (!isTauriRuntime()) return
  const store = getStore()
  await store.delete(KEY_COMPLETED_AT)
  await store.save()
}

export type OnboardingPersistStatus = 'loading' | 'pending' | 'completed'

export type UseOnboardingState = {
  status: OnboardingPersistStatus
  complete: () => Promise<void>
  reset: () => Promise<void>
}

export function useOnboardingState(): UseOnboardingState {
  // Outside of Tauri (Storybook / Vitest) we have no persistent store; fall
  // straight through to "pending" so the flow is renderable in isolation.
  const [status, setStatus] = useState<OnboardingPersistStatus>(() =>
    isTauriRuntime() ? 'loading' : 'pending'
  )

  useEffect(() => {
    if (!isTauriRuntime()) return
    let cancelled = false
    void readOnboardingCompletedAt()
      .then((value) => {
        if (cancelled) return
        setStatus(value ? 'completed' : 'pending')
      })
      .catch((err) => {
        if (cancelled) return
        // Surface and fall back to pending so a corrupted store doesn't
        // strand the user without onboarding.
        console.error('readOnboardingCompletedAt failed:', err)
        setStatus('pending')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const complete = useCallback(async () => {
    try {
      await writeOnboardingCompletedAt()
    } catch (err) {
      console.error('writeOnboardingCompletedAt failed:', err)
    }
    setStatus('completed')
  }, [])

  const reset = useCallback(async () => {
    try {
      await resetOnboardingCompletedAt()
    } catch (err) {
      console.error('resetOnboardingCompletedAt failed:', err)
    }
    setStatus('pending')
  }, [])

  return { status, complete, reset }
}
