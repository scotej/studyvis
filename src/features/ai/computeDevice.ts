import { LazyStore } from '@tauri-apps/plugin-store'

export const AI_HARDWARE_FILE = 'ai-hardware.json'
export const AI_COMPUTE_DEVICE_KEY = 'selection'
export const AI_COMPUTE_DEVICE_CACHE_KEY = 'studyvis.aiComputeDevice'

export type AiComputeDeviceSelection = 'auto' | 'cpu' | `device:${string}`

export const DEFAULT_AI_COMPUTE_DEVICE: AiComputeDeviceSelection = 'auto'

// This is returned by Rust, which reads the canonical Tauri store immediately
// before spawning llama-server. `topology` is null when the native engine
// could not safely resolve the accelerator layout; callers must treat that as
// unbenchmarked rather than accidentally trusting a localStorage mirror.
export type AiHardwareTopologyDevice = {
  id: string
  label: string
}

export type AiHardwareIdentity = {
  selection: AiComputeDeviceSelection
  topology: AiHardwareTopologyDevice[] | null
}

type HardwareStore = Pick<LazyStore, 'get' | 'set' | 'save'>

let testTauriRuntime: boolean | null = null
let testHardwareStore: HardwareStore | null = null

function isTauriRuntime(): boolean {
  if (testTauriRuntime !== null) return testTauriRuntime
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

function hasUnsafeDeviceChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (char === ',' || code <= 0x1f || code === 0x7f) return true
  }
  return false
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
    !hasUnsafeDeviceChar(deviceId)
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

function isAiHardwareTopologyDevice(
  value: unknown
): value is AiHardwareTopologyDevice {
  const id =
    typeof value === 'object' && value !== null
      ? (value as { id?: unknown }).id
      : undefined
  const label =
    typeof value === 'object' && value !== null
      ? (value as { label?: unknown }).label
      : undefined
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof id === 'string' &&
    isAiComputeDeviceSelection(`device:${id}`) &&
    typeof label === 'string' &&
    label.length > 0 &&
    label.length <= 256
  )
}

export function isAiHardwareIdentity(
  value: unknown
): value is AiHardwareIdentity {
  if (typeof value !== 'object' || value === null) return false
  const { selection, topology } = value as {
    selection?: unknown
    topology?: unknown
  }
  return (
    isAiComputeDeviceSelection(selection) &&
    (topology === null ||
      (Array.isArray(topology) &&
        topology.length <= 128 &&
        topology.every(isAiHardwareTopologyDevice)))
  )
}

function identitiesEqual(
  left: AiHardwareIdentity,
  right: AiHardwareIdentity
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

let currentHardwareIdentity: AiHardwareIdentity | null = null
// Set as soon as hydration or a user write knows which canonical selection we
// expect. A late engine_info response for the old selection is then ignored
// instead of re-validating its old benchmark during the write window.
let expectedCanonicalSelection: AiComputeDeviceSelection | null = null

function discardCurrentAiHardwareIdentity(): void {
  currentHardwareIdentity = null
}

// Only Rust can establish this value: it reads the canonical store and probes
// the engine topology in the same native process that launches the sidecar.
// The browser cache remains solely a UI bootstrap hint and is deliberately not
// allowed to make a persisted benchmark current.
export function setCurrentAiHardwareIdentity(identity: unknown): void {
  if (!isAiHardwareIdentity(identity)) {
    discardCurrentAiHardwareIdentity()
    return
  }
  if (
    expectedCanonicalSelection !== null &&
    identity.selection !== expectedCanonicalSelection
  ) {
    return
  }
  currentHardwareIdentity = identity
}

export function clearCurrentAiHardwareIdentity(): void {
  expectedCanonicalSelection = null
  discardCurrentAiHardwareIdentity()
}

export function currentAiHardwareIdentity(): AiHardwareIdentity | null {
  return currentHardwareIdentity
}

export function isResolvedAiHardwareIdentity(
  identity: AiHardwareIdentity | null
): identity is AiHardwareIdentity {
  return identity !== null && identity.topology !== null
}

export function aiHardwareIdentitiesEqual(
  left: AiHardwareIdentity,
  right: AiHardwareIdentity
): boolean {
  return identitiesEqual(left, right)
}

export function readCachedAiComputeDeviceSelection(): AiComputeDeviceSelection {
  if (typeof window === 'undefined') return DEFAULT_AI_COMPUTE_DEVICE
  try {
    const value = window.localStorage.getItem(AI_COMPUTE_DEVICE_CACHE_KEY)
    return isAiComputeDeviceSelection(value) ? value : DEFAULT_AI_COMPUTE_DEVICE
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
function hardwareStore(): HardwareStore {
  if (testHardwareStore) return testHardwareStore
  if (!cachedStore) cachedStore = new LazyStore(AI_HARDWARE_FILE)
  return cachedStore
}

// Unit-only seam for the delayed canonical-store reads that occur in the
// Tauri webview. Keeping the real LazyStore behind this narrow interface lets
// the regression test control get(A) versus save(B) deterministically.
export function __setAiComputeDeviceTestRuntime(
  runtime: { tauri: boolean; store: HardwareStore } | null
): void {
  testTauriRuntime = runtime?.tauri ?? null
  testHardwareStore = runtime?.store ?? null
  selectionOperation = 0
}

// One operation counter protects both sides of the canonical-store race:
// a hydration begun from stored A must not later rewrite the expected
// selection/cache after a user has successfully persisted B.
let selectionOperation = 0

export type AiComputeDeviceSelectionGuard = {
  hydrationSnapshot: () => number
  markUserChoice: () => number
  isCurrent: (operation: number) => boolean
}

// Used by AiCategory's async hydration effect. Kept here so the same
// deterministic operation rule is unit-tested rather than duplicated in JSX.
export function createAiComputeDeviceSelectionGuard(): AiComputeDeviceSelectionGuard {
  let operation = 0
  return {
    hydrationSnapshot: () => operation,
    markUserChoice: () => {
      operation += 1
      return operation
    },
    isCurrent: (candidate) => candidate === operation,
  }
}

export async function hydrateAiComputeDeviceSelection(): Promise<AiComputeDeviceSelection> {
  const cached = readCachedAiComputeDeviceSelection()
  if (!isTauriRuntime()) return cached
  const hydrationOperation = selectionOperation
  try {
    const stored = await hardwareStore().get<unknown>(AI_COMPUTE_DEVICE_KEY)
    if (hydrationOperation !== selectionOperation) {
      // A user save began while get() was pending. Return a harmless bootstrap
      // hint; never let this stale completion alter canonical expectations or
      // localStorage after the newer save.
      return readCachedAiComputeDeviceSelection()
    }
    const selection = isAiComputeDeviceSelection(stored)
      ? stored
      : DEFAULT_AI_COMPUTE_DEVICE
    expectedCanonicalSelection = selection
    if (currentHardwareIdentity?.selection !== selection) {
      discardCurrentAiHardwareIdentity()
    }
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
  const persistOperation = ++selectionOperation
  // Invalidate before the async write: a click changing CPU/Auto/eGPU must
  // never leave the old native identity eligible while persistence is pending.
  expectedCanonicalSelection = selection
  discardCurrentAiHardwareIdentity()
  try {
    if (isTauriRuntime()) {
      const store = hardwareStore()
      await store.set(AI_COMPUTE_DEVICE_KEY, selection)
      await store.save()
    }
    if (persistOperation === selectionOperation) writeCache(selection)
  } catch (error) {
    // The prior canonical value is unknown to this module after a failed
    // write. Accept no identity until a fresh native read establishes it.
    if (persistOperation === selectionOperation) {
      expectedCanonicalSelection = null
      discardCurrentAiHardwareIdentity()
    }
    throw error
  }
}
