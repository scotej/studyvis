import { LazyStore } from '@tauri-apps/plugin-store'

export const AI_HARDWARE_FILE = 'ai-hardware.json'
export const AI_COMPUTE_DEVICE_KEY = 'selection'
export const AI_COMPUTE_DEVICE_CACHE_KEY = 'studyvis.aiComputeDevice'

export type AiComputeDeviceSelection = 'auto' | 'cpu' | `device:${string}`

export const DEFAULT_AI_COMPUTE_DEVICE: AiComputeDeviceSelection = 'auto'

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

export function isAiComputeDeviceSelection(
  value: unknown
): value is AiComputeDeviceSelection {
  if (value === 'auto' || value === 'cpu') return true
  if (typeof value !== 'string' || !value.startsWith('device:')) return false
  const deviceId = value.slice('device:'.length)
  return (
    deviceId.length > 0 &&
    deviceId.length <= 128 &&
    !/[\u0000-\u001f\u007f,]/.test(deviceId)
  )
}

export function computeDeviceId(
  selection: AiComputeDeviceSelection
): string | null {
  return selection.startsWith('device:')
    ? selection.slice('device:'.length)
    : null
}

export function computeDeviceFingerprint(
  selection: AiComputeDeviceSelection
): string {
  if (selection === 'auto' || selection === 'cpu') return selection
  return `device-${encodeURIComponent(computeDeviceId(selection) ?? '')}`
}

export function readCachedAiComputeDeviceSelection(): AiComputeDeviceSelection {
  if (typeof window === 'undefined') return DEFAULT_AI_COMPUTE_DEVICE
  try {
    const value = window.localStorage.getItem(AI_COMPUTE_DEVICE_CACHE_KEY)
    return isAiComputeDeviceSelection(value)
      ? value
      : DEFAULT_AI_COMPUTE_DEVICE
  } catch {
    return DEFAULT_AI_COMPUTE_DEVICE
  }
}

function writeCache(selection: AiComputeDeviceSelection): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(AI_COMPUTE_DEVICE_CACHE_KEY, selection)
  } catch {
    // The Tauri store remains canonical. A missing cache only makes the next
    // benchmark conservatively read as the default until hydration completes.
  }
}

let cachedStore: LazyStore | null = null
function hardwareStore(): LazyStore {
  if (!cachedStore) cachedStore = new LazyStore(AI_HARDWARE_FILE)
  return cachedStore
}

export async function hydrateAiComputeDeviceSelection(): Promise<AiComputeDeviceSelection> {
  const cached = readCachedAiComputeDeviceSelection()
  if (!isTauriRuntime()) return cached
  try {
    const stored = await hardwareStore().get<unknown>(AI_COMPUTE_DEVICE_KEY)
    const selection = isAiComputeDeviceSelection(stored)
      ? stored
      : DEFAULT_AI_COMPUTE_DEVICE
    writeCache(selection)
    return selection
  } catch {
    return cached
  }
}

export async function persistAiComputeDeviceSelection(
  selection: AiComputeDeviceSelection
): Promise<void> {
  if (!isAiComputeDeviceSelection(selection)) {
    throw new Error('invalid AI compute device selection')
  }
  if (isTauriRuntime()) {
    const store = hardwareStore()
    await store.set(AI_COMPUTE_DEVICE_KEY, selection)
    await store.save()
  }
  writeCache(selection)
}
