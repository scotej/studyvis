// V2-P3 — In-footer dropdown that swaps the active microphone for the live
// session without renegotiating SDP. The list is refreshed on `devicechange`
// so plugging a headset mid-session re-populates the menu automatically.
// V3 will move this into a richer Settings → Devices pane; V2 keeps it on
// the session footer because that's where the mute / PTT controls already
// live.

import { useEffect, useState } from 'react'
import { MicIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import {
  listAudioInputs,
  type AudioInputOption,
} from '@/features/session/audioDevices'
import { strings } from '@/strings'

export type AudioDevicePickerProps = {
  // The deviceId currently in use, or null if we haven't pinned one (initial
  // session state — OS default mic).
  currentDeviceId: string | null
  onSelect: (deviceId: string) => Promise<void> | void
  // While a swap is in flight the trigger goes disabled. The session view
  // owns this state so multiple swaps queue cleanly.
  swapping: boolean
}

export function AudioDevicePicker({
  currentDeviceId,
  onSelect,
  swapping,
}: AudioDevicePickerProps) {
  const [devices, setDevices] = useState<AudioInputOption[]>([])

  // setState happens inside the `.then` callback (not the effect body) so
  // the react-hooks/set-state-in-effect rule treats this as a subscription:
  // external system (mediaDevices) → async callback → setState. The
  // `cancelled` flag drops the result if the picker unmounts mid-fetch.
  useEffect(() => {
    let cancelled = false
    const apply = (list: AudioInputOption[]) => {
      if (!cancelled) setDevices(list)
    }
    const refresh = () => {
      listAudioInputs()
        .then(apply)
        .catch((err) => console.error('enumerateDevices failed:', err))
    }
    refresh()
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.addEventListener !== 'function'
    ) {
      return () => {
        cancelled = true
      }
    }
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener('devicechange', refresh)
    }
  }, [])

  const active = devices.find((d) => d.deviceId === currentDeviceId)
  const label = active?.label ?? strings.session.audio.systemDefault

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={swapping}
          aria-label={strings.session.audio.micAriaLabel(label)}
          className="gap-2"
        >
          <MicIcon />
          <span className="max-w-[14ch] truncate">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[16rem]">
        <DropdownMenuLabel>{strings.session.audio.menuLabel}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* Radio semantics (menuitemradio + aria-checked + dot indicator):
            with two identically-named devices ("USB Audio Device") the open
            menu is otherwise the only place selection can be told apart —
            and it used to carry a dead data-active attribute no CSS ever
            consumed. An unpinned session (OS-default mic) has no checked
            row, deliberately: we don't know which device the OS resolved. */}
        <DropdownMenuRadioGroup
          value={currentDeviceId ?? ''}
          onValueChange={(deviceId) => void onSelect(deviceId)}
        >
          {devices.map((d) => (
            <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId}>
              <span className="truncate">{d.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {devices.length === 0 ? (
          <DropdownMenuItem disabled>
            {strings.session.audio.empty}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
