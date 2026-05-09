import { create } from 'zustand'

type PttState = {
  active: boolean
  press: () => void
  release: () => void
}

export const usePttStore = create<PttState>((set) => ({
  active: false,
  press: () => set({ active: true }),
  release: () => set({ active: false }),
}))
