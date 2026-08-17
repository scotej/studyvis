import { createContext, useContext } from 'react'

import type { WindowStyleMode } from '@/stores/settingsStore'

// One process-lifetime value for the frame Rust actually applied at boot.
// `main.tsx` resolves it before React renders, App provides it once, and every
// chrome-sensitive descendant consumes this context. The default keeps
// Storybook/web-only renders on native chrome without consulting localStorage.
export const AppliedWindowStyleContext =
  createContext<WindowStyleMode>('system')

export function useAppliedWindowStyle(): WindowStyleMode {
  return useContext(AppliedWindowStyleContext)
}
