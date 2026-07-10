import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  KeyRoundIcon,
  UploadIcon,
} from 'lucide-react'
import { toast } from 'sonner'

import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useIdentity } from '@/features/identity'
import { useFriendsStore } from '@/stores/friendsStore'
import { strings } from '@/strings'

export type IdentityCategoryProps = {
  // D4 — opens the full-screen Recover flow (lifted to Settings for the <main>
  // landmark reason). Optional so Storybook can render the category standalone.
  onRestoreIdentity?: () => void
}

// The backup file extension friends recognize; the Rust command writes a
// signed sealed-box (SVFB v2) and ignores the extension, so this is purely a
// default.
const FRIENDS_BACKUP_EXTENSION = 'svfriends'
// Both the Ed25519 authenticity failure ("this backup belongs to a different
// identity") and the unseal failure ("decrypt failed: this backup belongs to a
// different identity") share this substring, so a forged/wrong-identity file
// maps to the friendly copy either way.
const DIFFERENT_IDENTITY_MARKER = 'belongs to a different identity'

type FriendsImportResult = { imported: number; updated: number }

export function IdentityCategory({ onRestoreIdentity }: IdentityCategoryProps) {
  const { identity, status, actions } = useIdentity()
  const reloadFriends = useFriendsStore((s) => s.load)
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [backupBusy, setBackupBusy] = useState(false)
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

  const handleExportFriends = useCallback(async () => {
    setBackupBusy(true)
    try {
      const path = await save({
        defaultPath: `${copy.friendsBackup.exportDefaultName}.${FRIENDS_BACKUP_EXTENSION}`,
        filters: [
          {
            name: copy.friendsBackup.fileFilterName,
            extensions: [FRIENDS_BACKUP_EXTENSION],
          },
        ],
      })
      if (path == null) return
      const count = await invoke<number>('friends_export', { path })
      toast.success(
        count === 0
          ? copy.friendsBackup.exportEmptyToast
          : copy.friendsBackup.exportedToast(count)
      )
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : copy.friendsBackup.exportErrorFallback
      toast.error(message)
    } finally {
      setBackupBusy(false)
    }
  }, [copy.friendsBackup])

  const handleImportFriends = useCallback(async () => {
    setBackupBusy(true)
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [
          {
            name: copy.friendsBackup.fileFilterName,
            extensions: [FRIENDS_BACKUP_EXTENSION],
          },
        ],
      })
      const path = typeof picked === 'string' ? picked : null
      if (path == null) return
      const result = await invoke<FriendsImportResult>('friends_import', {
        path,
      })
      await reloadFriends()
      toast.success(
        copy.friendsBackup.importedToast(result.imported, result.updated)
      )
    } catch (err) {
      // The Rust command returns "decrypt failed: this backup belongs to a
      // different identity" when the file was sealed to another key; map that
      // to friendly copy instead of leaking the raw string.
      const raw = err instanceof Error ? err.message : String(err)
      toast.error(
        raw.includes(DIFFERENT_IDENTITY_MARKER)
          ? copy.friendsBackup.importDifferentIdentity
          : copy.friendsBackup.importErrorFallback
      )
    } finally {
      setBackupBusy(false)
    }
  }, [copy.friendsBackup, reloadFriends])

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
        control={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onRestoreIdentity?.()}
            disabled={!onRestoreIdentity}
          >
            <KeyRoundIcon /> {copy.recoveryPhrase.restoreCta}
          </Button>
        }
      />
      <SettingsRow
        label={copy.friendsBackup.label}
        help={copy.friendsBackup.help}
        control={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void handleExportFriends()}
              disabled={backupBusy}
              aria-label={copy.friendsBackup.exportAriaLabel}
            >
              <DownloadIcon /> {copy.friendsBackup.exportCta}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void handleImportFriends()}
              disabled={backupBusy}
              aria-label={copy.friendsBackup.importAriaLabel}
            >
              <UploadIcon /> {copy.friendsBackup.importCta}
            </Button>
          </div>
        }
      />
    </SettingsSection>
  )
}
