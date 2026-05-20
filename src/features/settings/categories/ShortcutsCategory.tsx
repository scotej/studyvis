import { useCallback, useMemo } from 'react'

import { KeybindCapture } from '@/components/KeybindCapture'
import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import {
  comboToAccelerator,
  DEFAULT_PTT_AI_COMBO,
  DEFAULT_PTT_FRIENDS_COMBO,
  parseAccelerator,
  type Combo,
  type Platform,
} from '@/lib/keybindings'
import { isMacLikePlatform } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settingsStore'

function detectPlatform(): Platform {
  return isMacLikePlatform() ? 'mac' : 'other'
}

function comboFromAccelerator(accelerator: string, fallback: Combo): Combo {
  return parseAccelerator(accelerator) ?? fallback
}

export function ShortcutsCategory() {
  const pttFriendsAccelerator = useSettingsStore(
    (s) => s.values.pttFriendsAccelerator
  )
  const pttAiAccelerator = useSettingsStore((s) => s.values.pttAiAccelerator)
  const aiFeaturesEnabled = useSettingsStore((s) => s.values.aiFeaturesEnabled)
  const setShortcutAccelerator = useSettingsStore(
    (s) => s.setShortcutAccelerator
  )
  const resetShortcutsToDefaults = useSettingsStore(
    (s) => s.resetShortcutsToDefaults
  )

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
    void resetShortcutsToDefaults()
  }, [resetShortcutsToDefaults])

  const p = detectPlatform()

  return (
    <SettingsSection heading="Shortcuts">
      <SettingsRow
        label="Push to talk · friends"
        help="Hold to unmute your microphone for everyone in the session."
        control={
          <KeybindCapture
            action="ptt-friends"
            combo={pttFriendsCombo}
            otherCombo={pttAiCombo}
            otherAction="ptt-ai"
            platform={p}
            onCommit={handleCommitFriends}
          />
        }
      />
      <SettingsRow
        label="Talk to AI"
        help={
          aiFeaturesEnabled
            ? 'Opens the floating AI dialog over any app.'
            : 'Active when AI features are on.'
        }
        control={
          <KeybindCapture
            action="ptt-ai"
            combo={pttAiCombo}
            otherCombo={pttFriendsCombo}
            otherAction="ptt-friends"
            platform={p}
            onCommit={handleCommitAi}
          />
        }
      />
      <SettingsRow
        label="Reset to defaults"
        help="Restores the original combos for both shortcuts."
        control={
          <Button type="button" size="sm" variant="ghost" onClick={handleReset}>
            Reset
          </Button>
        }
      />
    </SettingsSection>
  )
}
