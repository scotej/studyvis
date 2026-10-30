import { Mic, MicOff } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { strings } from '@/strings'

export type MicToggleButtonProps = {
  enabled: boolean
  onToggle: () => void
  shortcutLabel: string
  disabled?: boolean
}

export function MicToggleButton({
  enabled,
  onToggle,
  shortcutLabel,
  disabled,
}: MicToggleButtonProps) {
  const Icon = enabled ? Mic : MicOff
  return (
    <Button
      type="button"
      variant={enabled ? 'secondary' : 'ghost'}
      size="sm"
      aria-pressed={enabled}
      onClick={onToggle}
      disabled={disabled}
      title={strings.session.mic.toggleShortcut(shortcutLabel)}
      className="gap-2"
    >
      <Icon aria-hidden="true" />
      {enabled ? strings.session.mic.on : strings.session.mic.off}
    </Button>
  )
}
