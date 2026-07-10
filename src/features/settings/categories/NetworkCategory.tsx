import { useState } from 'react'
import { ChevronRightIcon } from 'lucide-react'

import { RelayDiagnostics } from '@/components/RelayDiagnostics'
import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import {
  isTurnPreference,
  isValidRelayUrl,
  isValidTurnUrl,
  useSettingsStore,
  type TurnPreference,
} from '@/stores/settingsStore'
import { strings } from '@/strings'

export function NetworkCategory() {
  const turn = useSettingsStore((s) => s.values.turnPreference)
  const setTurn = useSettingsStore((s) => s.setTurnPreference)
  const copy = strings.settings.network

  return (
    <SettingsSection heading={copy.heading}>
      <SettingsRow label={copy.about.label} help={copy.about.help} />
      <SettingsRow
        label={copy.preference.label}
        help={copy.preference.help}
        stack
        control={
          <RadioGroup
            value={turn}
            onValueChange={(value) => {
              if (isTurnPreference(value)) {
                void setTurn(value as TurnPreference)
              }
            }}
            aria-label={copy.preference.ariaLabel}
            className="gap-3"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="auto" id="turn-auto" />
              <Label htmlFor="turn-auto">{copy.preference.options.auto}</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="always" id="turn-always" />
              <Label htmlFor="turn-always">
                {copy.preference.options.always}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="never" id="turn-never" />
              <Label htmlFor="turn-never">
                {copy.preference.options.never}
              </Label>
            </div>
          </RadioGroup>
        }
      />

      <SettingsRow
        label={copy.diagnostics.label}
        help={copy.diagnostics.help}
        stack
        control={<RelayDiagnostics />}
      />

      <AdvancedConnectionRow />
    </SettingsSection>
  )
}

// F3 — Advanced disclosure for user-supplied relay URLs + one TURN server.
// Default-collapsed so the calm default surface is unchanged; the inputs start
// empty (STUN-only, built-in relays) on a fresh install.
function AdvancedConnectionRow() {
  const copy = strings.settings.network.advanced
  return (
    <details className="group border-b border-border-subtle py-4 last:border-b-0">
      <summary className="flex cursor-pointer list-none items-start justify-between gap-4 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-accent-ring">
        <span className="flex flex-col gap-1">
          <span className="text-sm font-medium text-text-primary">
            {copy.toggleLabel}
          </span>
          <span className="text-xs text-text-secondary">{copy.toggleHelp}</span>
        </span>
        <ChevronRightIcon
          className="mt-0.5 size-4 shrink-0 text-text-secondary group-open:rotate-90"
          aria-hidden
        />
      </summary>
      <div className="mt-4 flex flex-col gap-6">
        <CustomRelaysField />
        <TurnServerField />
      </div>
    </details>
  )
}

function CustomRelaysField() {
  const copy = strings.settings.network.advanced.relays
  const stored = useSettingsStore((s) => s.values.customRelayUrls)
  const setCustomRelayUrls = useSettingsStore((s) => s.setCustomRelayUrls)
  const [text, setText] = useState(() => stored.join('\n'))

  // Any non-blank line that isn't a wss:// URL will be dropped on save —
  // flag it so the user isn't left wondering why a relay vanished.
  const hasInvalid = text
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .some((l) => l.length > 0 && !isValidRelayUrl(l))

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="custom-relays" className="text-sm font-medium">
        {copy.label}
      </Label>
      <p className="text-xs text-text-secondary">{copy.help}</p>
      <Textarea
        id="custom-relays"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void setCustomRelayUrls(text)}
        placeholder={copy.placeholder}
        aria-label={copy.ariaLabel}
        aria-invalid={hasInvalid || undefined}
        spellCheck={false}
        className="font-mono text-xs"
        rows={3}
      />
      {hasInvalid ? (
        <p className="text-xs text-status-warning" role="alert">
          {copy.invalid}
        </p>
      ) : null}
    </div>
  )
}

function TurnServerField() {
  const copy = strings.settings.network.advanced.turn
  const stored = useSettingsStore((s) => s.values.turnServer)
  const setTurnServer = useSettingsStore((s) => s.setTurnServer)

  const [url, setUrl] = useState(() => stored?.url ?? '')
  const [username, setUsername] = useState(() => stored?.username ?? '')
  const [credential, setCredential] = useState(() => stored?.credential ?? '')

  const commit = () => void setTurnServer({ url, username, credential })

  const urlInvalid = url.trim().length > 0 && !isValidTurnUrl(url)
  const active = stored !== null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-text-primary">
          {copy.label}
        </span>
        <p className="text-xs text-text-secondary">{copy.help}</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="turn-url" className="text-xs text-text-secondary">
          {copy.urlLabel}
        </Label>
        <Input
          id="turn-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={commit}
          placeholder={copy.urlPlaceholder}
          aria-label={copy.urlAriaLabel}
          aria-invalid={urlInvalid || undefined}
          spellCheck={false}
        />
        {urlInvalid ? (
          <p className="text-xs text-status-warning" role="alert">
            {copy.invalidUrl}
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label
            htmlFor="turn-username"
            className="text-xs text-text-secondary"
          >
            {copy.usernameLabel}
          </Label>
          <Input
            id="turn-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onBlur={commit}
            aria-label={copy.usernameAriaLabel}
            spellCheck={false}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label
            htmlFor="turn-credential"
            className="text-xs text-text-secondary"
          >
            {copy.credentialLabel}
          </Label>
          <Input
            id="turn-credential"
            type="password"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            onBlur={commit}
            aria-label={copy.credentialAriaLabel}
            spellCheck={false}
          />
        </div>
      </div>
      {active ? (
        <p className="text-xs text-status-focused">{copy.active}</p>
      ) : null}
    </div>
  )
}
