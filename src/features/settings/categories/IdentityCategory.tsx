import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { toast } from 'sonner'

import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useIdentity } from '@/features/identity'
import { strings } from '@/strings'

export function IdentityCategory() {
  const { identity, status, actions } = useIdentity()
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copy = strings.settings.identity

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing local form state to async-loaded identity; the rule is aggressive on this hydrate-once pattern (same suppression as useIdentity.refresh).
    setName(identity?.display_name ?? '')
  }, [identity?.display_name])

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    }
  }, [])

  const handleSave = useCallback(async () => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === identity?.display_name) return
    setSubmitting(true)
    try {
      await actions.setDisplayName(trimmed)
      toast.success(copy.displayName.savedToast)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : copy.displayName.saveError
      toast.error(message)
    } finally {
      setSubmitting(false)
    }
  }, [name, identity?.display_name, actions, copy.displayName])

  const handleCopy = useCallback(async () => {
    if (!identity) return
    try {
      await navigator.clipboard.writeText(identity.ed_pubkey_hex)
      setCopied(true)
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(strings.common.errors.copyToClipboard)
    }
  }, [identity])

  const dirty = name.trim() !== (identity?.display_name ?? '').trim()
  const canSave = dirty && name.trim().length > 0 && !submitting

  return (
    <SettingsSection heading={copy.heading}>
      <SettingsRow
        label={copy.displayName.label}
        help={copy.displayName.help}
        stack
        control={
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void handleSave()
            }}
            className="flex items-center gap-2"
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={copy.displayName.placeholder}
              disabled={status !== 'ready' || submitting}
              maxLength={64}
              className="max-w-sm"
              aria-label={copy.displayName.ariaLabel}
            />
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={!canSave}
              aria-disabled={!canSave}
            >
              {copy.displayName.saveCta}
            </Button>
          </form>
        }
      />
      <SettingsRow
        label={copy.publicKey.label}
        help={copy.publicKey.help}
        stack
        control={
          <div className="flex items-center gap-2">
            <code className="block max-w-full overflow-x-auto rounded-md border border-border-subtle bg-bg-sunk px-3 py-2 font-mono text-xs text-text-secondary">
              {identity?.ed_pubkey_hex ?? '…'}
            </code>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void handleCopy()}
              disabled={!identity}
              aria-label={copy.publicKey.copyAriaLabel}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </Button>
          </div>
        }
      />
      <SettingsRow
        label={copy.recoveryPhrase.label}
        help={copy.recoveryPhrase.help}
        disabled
      />
    </SettingsSection>
  )
}
