// V2-P5 — JS wrapper around the `system_battery` Tauri command.
//
// ARCHITECTURE.md §2: "Tauri 2 has no first-party battery API. Use the
// `battery` Rust crate inside `src-tauri/src/commands/system.rs` to expose
// system_battery() -> { on_battery: bool, percent: u8 }. The V2 sample loop
// polls this every 60 s and pauses inference when on battery and percent
// <20."
//
// The wrapper exposes a stable JS shape (onBattery + percent) and isolates
// the IPC call so unit tests can substitute a fake without spinning Tauri.
//
// Desktops, VMs, and Linux machines without UPower may report no battery at
// all; the default runtime falls back to "on AC, 100%" so the sample loop
// keeps ticking. This is safer than refusing to run AI on machines whose
// battery state we can't determine.

import { invoke } from '@tauri-apps/api/core'

export type BatteryInfo = {
  onBattery: boolean
  // 0–100; 100 sentinel when battery is absent or unknown.
  percent: number
}

export type BatteryRuntime = {
  read: () => Promise<BatteryInfo>
}

type RawBattery = {
  on_battery: boolean
  percent: number
}

async function defaultRead(): Promise<BatteryInfo> {
  try {
    const raw = await invoke<RawBattery>('system_battery')
    return {
      onBattery: Boolean(raw.on_battery),
      percent: clampPercent(raw.percent),
    }
  } catch (err) {
    // No battery detected, UPower absent on Linux, or platform error.
    // Surface as on-AC so the sample loop keeps running — the alternative
    // (pausing on every machine the crate doesn't support) is worse.
    console.warn('system_battery failed; assuming on AC:', err)
    return { onBattery: false, percent: 100 }
  }
}

function clampPercent(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 100
  if (raw < 0) return 0
  if (raw > 100) return 100
  return Math.round(raw)
}

const defaultRuntime: BatteryRuntime = {
  read: defaultRead,
}

let activeRuntime: BatteryRuntime = defaultRuntime

export function __setBatteryRuntime(runtime: BatteryRuntime): void {
  activeRuntime = runtime
}

export function __resetBatteryRuntime(): void {
  activeRuntime = defaultRuntime
}

export function getBatteryRuntime(): BatteryRuntime {
  return activeRuntime
}

// Convenience helper used by the V2-P5 sample loop. ARCHITECTURE.md §8
// thresholds: pause if on battery AND percent below 20.
export const BATTERY_PAUSE_PERCENT = 20

export function shouldPauseForBattery(info: BatteryInfo): boolean {
  return info.onBattery && info.percent < BATTERY_PAUSE_PERCENT
}
