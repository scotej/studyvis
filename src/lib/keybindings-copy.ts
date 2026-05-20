// UI-layer adapter: turns a `lib/keybindings.ts` validation result into the
// user-facing conflict copy. Lives here (not in lib/) so `lib/keybindings`
// stays free of any `strings` dependency, which used to pull the whole
// strings module into every consumer of the pure keybinding utilities
// (notably `stores/settingsStore.ts`). Only `KeybindCapture` needs this.

import { strings } from '@/strings'

import {
  comboToInlineDisplay,
  type Combo,
  type ConflictReason,
  type Platform,
} from './keybindings'

export function describeConflict(
  combo: Combo,
  reason: ConflictReason,
  platform: Platform
): string {
  const inline = comboToInlineDisplay(combo, platform)
  const conflicts = strings.keybindings.conflicts
  switch (reason.kind) {
    case 'modifier_only':
      return conflicts.modifierOnly
    case 'no_modifier':
      return conflicts.noModifier
    case 'self_conflict':
      return conflicts.selfConflict(
        inline,
        strings.keybindings.actionLabels[reason.otherAction]
      )
    case 'reserved':
      return conflicts.reserved(inline)
  }
}
