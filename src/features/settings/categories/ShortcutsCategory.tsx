import { useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'

import { useAiPlatformSupported } from '@/features/ai'
import { KeybindCapture } from '@/components/KeybindCapture'
import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import {
  comboToAccelerator,
  DEFAULT_MIC_TOGGLE_COMBO,
  DEFAULT_PTT_AI_COMBO,
  DEFAULT_PTT_FRIENDS_COMBO,
  parseAccelerator,
  type Combo,
  type Platform,
} from '@/lib/keybindings'
import { isMacLikePlatform } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settingsStore'
import { strings } from '@/strings'

function detectPlatform(): Platform {
  return isMacLikePlatform() ? 'mac' : 'other'
}

function isLinuxPlatform(): boolean {
  return (
    typeof navigator !== 'undefined' && /Linux|X11/.test(navigator.userAgent)
  )
}

function comboFromAccelerator(accelerator: string, fallback: Combo): Combo {
  return parseAccelerator(accelerator) ?? fallback
}

export function ShortcutsCategory() {
  const pttFriendsAccelerator = useSettingsStore(
    (s) => s.values.pttFriendsAccelerator
  )
  const pttAiAccelerator = useSettingsStore((s) => s.values.pttAiAccelerator)
  const micToggleAccelerator = useSettingsStore(
    (s) => s.values.micToggleAccelerator
  )
  const aiPreferenceEnabled = useSettingsStore(
    (s) => s.values.aiFeaturesEnabled
  )
  const aiPlatformSupported = useAiPlatformSupported(aiPreferenceEnabled)
  const aiFeaturesEnabled = aiPreferenceEnabled && aiPlatformSupported === true
  const setShortcutAccelerator = useSettingsStore(
    (s) => s.setShortcutAccelerator
  )
  const resetShortcutsToDefaults = useSettingsStore(
    (s) => s.resetShortcutsToDefaults
  )
  const copy = strings.settings.shortcuts

  // Memoize the parsed combos so KeybindCapture's `otherCombo` reference is
  // stable across renders (its keydown-listener effect depends on it).
  const pttFriendsCombo = useMemo(
    () =>
      comboFromAccelerator(pttFriendsAccelerator, DEFAULT_PTT_FRIENDS_COMBO),
    [pttFriendsAccelerator]
  )
  const pttAiCombo = useMemo(
    () => comboFromAccelerator(pttAiAccelerator, DEFAULT_PTT_AI_COMBO),
    [pttAiAccelerator]
  )

  const micToggleCombo = useMemo(
    () => comboFromAccelerator(micToggleAccelerator, DEFAULT_MIC_TOGGLE_COMBO),
    [micToggleAccelerator]
  )
  const additionalMicBinding = useMemo(
    () => [{ combo: micToggleCombo, action: 'mic-toggle' as const }],
    [micToggleCombo]
  )
  const additionalAiBinding = useMemo(
    () => [{ combo: pttAiCombo, action: 'ptt-ai' as const }],
    [pttAiCombo]
  )

  const handleCommitMicToggle = useCallback(
    async (next: Combo) => {
      await setShortcutAccelerator('mic-toggle', comboToAccelerator(next))
    },
    [setShortcutAccelerator]
  )

  const handleCommitFriends = useCallback(
    async (next: Combo) => {
      await setShortcutAccelerator('ptt-friends', comboToAccelerator(next))
    },
    [setShortcutAccelerator]
  )

  const handleCommitAi = useCallback(
    async (next: Combo) => {
      await setShortcutAccelerator('ptt-ai', comboToAccelerator(next))
    },
    [setShortcutAccelerator]
  )

  const handleReset = useCallback(() => {
    // The pair resets together; registration/persistence refusals stay visible.
    void resetShortcutsToDefaults().catch((err) => {
      toast.error(
        strings.settings.shortcuts.reset.resetError(
          err instanceof Error ? err.message : String(err)
        )
      )
    })
  }, [resetShortcutsToDefaults])

  const p = detectPlatform()

  return (
    <SettingsSection heading={copy.heading}>
      <SettingsRow
        label={copy.pttFriends.label}
        help={copy.pttFriends.help}
        className="items-start"
        control={
          <KeybindCapture
            action="ptt-friends"
            combo={pttFriendsCombo}
            otherCombo={pttAiCombo}
            otherAction="ptt-ai"
            additionalBindings={additionalMicBinding}
            platform={p}
            onCommit={handleCommitFriends}
          />
        }
      />
      <SettingsRow
        label={copy.pttAi.label}
        help={aiFeaturesEnabled ? copy.pttAi.helpOn : copy.pttAi.helpOff}
        className="items-start"
        control={
          <KeybindCapture
            action="ptt-ai"
            combo={pttAiCombo}
            otherCombo={pttFriendsCombo}
            otherAction="ptt-friends"
            additionalBindings={additionalMicBinding}
            platform={p}
            onCommit={handleCommitAi}
          />
        }
      />
      <SettingsRow
        label={copy.micToggle.label}
        help={copy.micToggle.help}
        className="items-start"
        control={
          <KeybindCapture
            action="mic-toggle"
            combo={micToggleCombo}
            otherCombo={pttFriendsCombo}
            otherAction="ptt-friends"
            additionalBindings={additionalAiBinding}
            platform={p}
            onCommit={handleCommitMicToggle}
          />
        }
      />
      {isLinuxPlatform() ? (
        <SettingsRow
          label={copy.pttAi.fallbackLabel}
          help={copy.pttAi.fallbackHelp}
          control={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!aiFeaturesEnabled}
              onClick={() => {
                void invoke('ai_dialog_toggle').catch((err) => {
                  toast.error(
                    copy.pttAi.fallbackError(
                      err instanceof Error ? err.message : String(err)
                    )
                  )
                })
              }}
            >
              {copy.pttAi.fallbackCta}
            </Button>
          }
        />
      ) : null}
      <SettingsRow
        label={copy.reset.label}
        help={copy.reset.help}
        control={
          <Button type="button" size="sm" variant="ghost" onClick={handleReset}>
            {copy.reset.cta}
          </Button>
        }
      />
    </SettingsSection>
  )
}
