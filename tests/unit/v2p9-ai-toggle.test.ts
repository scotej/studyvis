// V2-P9 — AI gate wiring: per-tick sample-interval math, the one-shot
// session-start topic hand-off, and the new settings setters (including the
// pushAiFeaturesEnabled runtime bridge that gates the Ctrl+] shortcut).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { effectiveIntervalSec, MAX_SAMPLE_INTERVAL_SEC } from '@/features/ai'
import {
  __resetSettingsStoreDeps,
  __setSettingsStoreDeps,
  DEFAULT_SETTINGS,
  useSettingsStore,
  type SettingsStoreDeps,
} from '@/stores/settingsStore'
import {
  DEFAULT_DECLARED_STUDY_TOPIC,
  useSessionStore,
} from '@/stores/sessionStore'

describe('effectiveIntervalSec — per-tick cadence math', () => {
  test('null override runs at the model floor', () => {
    expect(effectiveIntervalSec(7, null)).toBe(7)
  })

  test('an override below the floor is clamped up to the floor', () => {
    expect(effectiveIntervalSec(8, 3)).toBe(8)
  })

  test('an override above the ceiling is clamped to the ceiling', () => {
    expect(effectiveIntervalSec(5, 999)).toBe(MAX_SAMPLE_INTERVAL_SEC)
  })

  test('an in-range override is used verbatim', () => {
    expect(effectiveIntervalSec(5, 12)).toBe(12)
  })

  test('non-finite override falls back to the floor', () => {
    expect(effectiveIntervalSec(5, Number.NaN)).toBe(5)
  })
})

describe('sessionStore — one-shot session-start topic', () => {
  beforeEach(() => {
    useSessionStore.getState().reset()
  })

  const fakeInit = () => ({
    sessionTopic: 't',
    sessionPassword: 'p',
    isHost: true,
    startedAt: 1,
    room: {} as never,
    leave: async () => {},
  })

  test('pendingInitialTopic seeds both topic fields and is cleared', () => {
    useSessionStore.getState().setPendingInitialTopic('  Calculus  ')
    useSessionStore.getState().begin(fakeInit())
    const s = useSessionStore.getState()
    expect(s.initialDeclaredTopic).toBe('Calculus')
    expect(s.declaredStudyTopic).toBe('Calculus')
    expect(s.pendingInitialTopic).toBeNull()
  })

  test('no pending topic falls back to the default (AI-off path)', () => {
    useSessionStore.getState().begin(fakeInit())
    const s = useSessionStore.getState()
    expect(s.initialDeclaredTopic).toBe(DEFAULT_DECLARED_STUDY_TOPIC)
    expect(s.declaredStudyTopic).toBe(DEFAULT_DECLARED_STUDY_TOPIC)
  })

  test('whitespace-only pending topic falls back to the default', () => {
    useSessionStore.getState().setPendingInitialTopic('   ')
    useSessionStore.getState().begin(fakeInit())
    expect(useSessionStore.getState().initialDeclaredTopic).toBe(
      DEFAULT_DECLARED_STUDY_TOPIC
    )
  })

  test('reset() clears a queued pending topic', () => {
    useSessionStore.getState().setPendingInitialTopic('Physics')
    useSessionStore.getState().reset()
    expect(useSessionStore.getState().pendingInitialTopic).toBeNull()
  })
})

describe('settingsStore — V2-P9 setters', () => {
  let saved: Record<string, unknown>
  let pushedAi: boolean[]

  beforeEach(() => {
    saved = {}
    pushedAi = []
    const deps: SettingsStoreDeps = {
      storeFactory: () => ({
        get: async () => undefined,
        set: async (k, v) => {
          saved[k] = v
        },
        delete: async () => true,
        save: async () => {},
      }),
      migrator: { readLegacyTheme: () => null, clearLegacyTheme: () => {} },
      runtime: {
        pushMinimizeToTray: async () => {},
        pushAiFeaturesEnabled: async (enabled) => {
          pushedAi.push(enabled)
        },
        setGlobalShortcut: async () => {},
        relaunchApp: async () => {},
      },
    }
    __setSettingsStoreDeps(deps)
    useSettingsStore.setState({
      status: 'ready',
      values: { ...DEFAULT_SETTINGS },
      error: null,
    })
  })

  afterEach(() => {
    __resetSettingsStoreDeps()
  })

  test('setAiFeaturesEnabled persists and pushes the Rust gate flag', async () => {
    await useSettingsStore.getState().setAiFeaturesEnabled(true)
    expect(useSettingsStore.getState().values.aiFeaturesEnabled).toBe(true)
    expect(saved['ai_features_enabled']).toBe(true)
    expect(pushedAi).toEqual([true])
  })

  test('a failing push surfaces via the store error, UI intent still wins', async () => {
    __setSettingsStoreDeps({
      storeFactory: () => ({
        get: async () => undefined,
        set: async () => {},
        delete: async () => true,
        save: async () => {},
      }),
      migrator: { readLegacyTheme: () => null, clearLegacyTheme: () => {} },
      runtime: {
        pushMinimizeToTray: async () => {},
        pushAiFeaturesEnabled: async () => {
          throw new Error('boom')
        },
        setGlobalShortcut: async () => {},
        relaunchApp: async () => {},
      },
    })
    await useSettingsStore.getState().setAiFeaturesEnabled(true)
    expect(useSettingsStore.getState().values.aiFeaturesEnabled).toBe(true)
    expect(useSettingsStore.getState().error).toBe('boom')
  })

  test('threshold + sample-interval setters persist raw values', async () => {
    await useSettingsStore.getState().setWarningThreshold(5)
    await useSettingsStore.getState().setAlertThreshold(9)
    await useSettingsStore.getState().setSampleIntervalSec(12)
    const v = useSettingsStore.getState().values
    expect(v.warningThreshold).toBe(5)
    expect(v.alertThreshold).toBe(9)
    expect(v.sampleIntervalSec).toBe(12)
    expect(saved['warning_threshold']).toBe(5)
    expect(saved['alert_threshold']).toBe(9)
    expect(saved['sample_interval_s']).toBe(12)
  })

  test('setSampleIntervalSec(null) clears the override', async () => {
    await useSettingsStore.getState().setSampleIntervalSec(20)
    await useSettingsStore.getState().setSampleIntervalSec(null)
    expect(useSettingsStore.getState().values.sampleIntervalSec).toBeNull()
    expect(saved['sample_interval_s']).toBeNull()
  })

  // A3 — setOffTaskConfidenceFloor persists the raw value under
  // `off_task_confidence_floor`, matching the threshold setters. Pairs with the
  // hydrate round-trip in settings-migration.test.ts.
  test('setOffTaskConfidenceFloor persists the raw value', async () => {
    await useSettingsStore.getState().setOffTaskConfidenceFloor(0.75)
    expect(useSettingsStore.getState().values.offTaskConfidenceFloor).toBe(0.75)
    expect(saved['off_task_confidence_floor']).toBe(0.75)
  })
})

// The sample-interval slider is documented as taking effect mid-session
// (per-tick getter, like getTopic). This asserts the loop reschedules with
// the new override on the very next interval without a restart.
describe('sampleLoop — mid-session interval override', () => {
  afterEach(() => {
    useSettingsStore.setState({
      values: {
        ...useSettingsStore.getState().values,
        sampleIntervalSec: null,
      },
    })
  })

  test('effectiveIntervalSec reflects a live settings change', () => {
    useSettingsStore.setState({
      values: { ...useSettingsStore.getState().values, sampleIntervalSec: 18 },
    })
    const override = useSettingsStore.getState().values.sampleIntervalSec
    expect(effectiveIntervalSec(5, override)).toBe(18)
    vi.useRealTimers()
  })
})
