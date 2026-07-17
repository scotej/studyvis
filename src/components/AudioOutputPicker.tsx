// S4 — Speaker/headphone output picker for the session footer. Mirrors
// AudioDevicePicker (the mic picker) but enumerates `audiooutput` devices and
// applies the choice per-tile via HTMLMediaElement.setSinkId (wired in
// SessionView → VideoTile). setSinkId is unsupported in macOS WKWebView, so
// the component renders nothing there — feature-detected via
// setSinkIdSupported() — rather than offering a control that silently no-ops.

import { useEffect, useState } from 'react'
import { Volume2Icon } from 'lucide-react'

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
  listAudioOutputs,
  setSinkIdSupported,
  type AudioInputOption,
} from '@/features/session/audioDevices'
import { strings } from '@/strings'

export type AudioOutputPickerProps = {
  currentDeviceId: string | null
  onSelect: (deviceId: string) => void
}

export function AudioOutputPicker({
  currentDeviceId,
  onSelect,
}: AudioOutputPickerProps) {
  const [supported] = useState(() => setSinkIdSupported())
  const [devices, setDevices] = useState<AudioInputOption[]>([])

  useEffect(() => {
    if (!supported) return
    let cancelled = false
    const apply = (list: AudioInputOption[]) => {
      if (!cancelled) setDevices(list)
    }
    const refresh = () => {
      listAudioOutputs()
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
  }, [supported])

  if (!supported) return null

  const active = devices.find((d) => d.deviceId === currentDeviceId)
  const label = active?.label ?? strings.session.output.systemDefault

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={strings.session.output.ariaLabel(label)}
          className="gap-2"
        >
          <Volume2Icon />
          <span className="max-w-[14ch] truncate">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[16rem]">
        <DropdownMenuLabel>
          {strings.session.output.menuLabel}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* See AudioDevicePicker — radio semantics replace the dead
            data-active attribute; unpinned (OS default) shows no checked
            row deliberately. */}
        <DropdownMenuRadioGroup
          value={currentDeviceId ?? ''}
          onValueChange={(deviceId) => onSelect(deviceId)}
        >
          {devices.map((d) => (
            <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId}>
              <span className="truncate">{d.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {devices.length === 0 ? (
          <DropdownMenuItem disabled>
            {strings.session.output.empty}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
