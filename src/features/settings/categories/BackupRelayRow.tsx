import { useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'

import { SettingsRow } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  managedTurn,
  managedTurnLoginTicket,
  type ManagedTurnSnapshot,
} from '@/lib/managedTurn'
import { useIdentity } from '@/features/identity'
import { useSettingsStore, type TurnPreference } from '@/stores/settingsStore'
import { strings } from '@/strings'
import type { BrokerProvider } from '../../../../services/turn-broker/protocol'

type BackupRelayViewProps = {
  snapshot: ManagedTurnSnapshot
  enabled: boolean
  hasIdentity: boolean
  preference: TurnPreference
  busy?: boolean
  failed?: boolean
  onEnable: (enabled: boolean) => void
  onLogin: (provider: BrokerProvider) => void
  onConfirm: () => void
  onCancel: () => void
  onRefresh: () => void
  onUnlink: (provider: BrokerProvider, subject: string) => void
}

export function BackupRelayView({
  snapshot,
  enabled,
  hasIdentity,
  preference,
  busy = false,
  failed = false,
  onEnable,
  onLogin,
  onConfirm,
  onCancel,
  onRefresh,
  onUnlink,
}: BackupRelayViewProps) {
  const copy = strings.settings.network.backup
  const waiting = snapshot.login !== null && snapshot.pendingAccount === null
  const errorMessage =
    snapshot.error === 'conflict'
      ? copy.conflict
      : snapshot.error === 'rate_limited'
        ? copy.rateLimited
        : copy.error
  const status = !hasIdentity
    ? copy.identityRequired
    : !enabled
      ? copy.disabled
      : failed || snapshot.error
        ? errorMessage
        : snapshot.status === 'checking'
          ? copy.checking
          : waiting
            ? copy.waiting
            : preference === 'never'
              ? copy.never
              : snapshot.approved
                ? snapshot.relayEnabled && snapshot.freeOnlyConfirmed
                  ? copy.ready
                  : copy.approved
                : snapshot.accounts.length
                  ? copy.pending
                  : !snapshot.providers.github && !snapshot.providers.google
                    ? copy.unavailable
                    : copy.signInHelp
  return (
    <SettingsRow
      label={copy.label}
      help={copy.help}
      stack
      control={
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Switch
              id="managed-turn-enabled"
              checked={enabled}
              disabled={!hasIdentity || busy}
              onCheckedChange={onEnable}
            />
            <Label htmlFor="managed-turn-enabled">{copy.enabled}</Label>
          </div>
          <p role="status" className="text-sm text-text-secondary">
            {status}
          </p>
          {enabled && hasIdentity && (
            <>
              {(!snapshot.relayEnabled || !snapshot.freeOnlyConfirmed) && (
                <p className="text-xs text-text-secondary">{copy.freeOnly}</p>
              )}
              {snapshot.pendingAccount ? (
                <div className="flex flex-col gap-2 rounded-md border border-border-default p-3">
                  <p className="text-sm text-text-primary break-words">
                    {snapshot.pendingAccount.label}
                  </p>
                  <p className="text-xs text-text-secondary">
                    {copy.confirmHelp}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={onConfirm} disabled={busy}>
                      {copy.confirm}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={onCancel}
                      disabled={busy}
                    >
                      {copy.cancel}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => onLogin('github')}
                    disabled={busy || waiting || !snapshot.providers.github}
                  >
                    {copy.github}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onLogin('google')}
                    disabled={busy || waiting || !snapshot.providers.google}
                  >
                    {copy.google}
                  </Button>
                  {waiting && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={onCancel}
                      disabled={busy}
                    >
                      {copy.cancel}
                    </Button>
                  )}
                </div>
              )}
              {snapshot.accounts.map((account) => (
                <div
                  key={`${account.provider}:${account.subject}`}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm text-text-primary break-words">
                      {account.label}
                    </span>
                    <span className="text-xs text-text-secondary break-all">
                      {copy.accountId}: {account.provider}:{account.subject}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onUnlink(account.provider, account.subject)}
                    disabled={busy}
                  >
                    {copy.unlink}
                  </Button>
                </div>
              ))}
              {snapshot.accounts.length > 0 && (
                <p className="text-xs text-text-secondary">{copy.unlinkHelp}</p>
              )}
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={onRefresh}
                  disabled={busy || waiting}
                >
                  {copy.retry}
                </Button>
              </div>
            </>
          )}
        </div>
      }
    />
  )
}

export function BackupRelayRow() {
  const { identity, status } = useIdentity()
  const key = status === 'ready' ? (identity?.ed_pubkey_hex ?? null) : null
  const enabled = useSettingsStore(
    (state) => key !== null && state.values.managedTurnIdentities.includes(key)
  )
  const preference = useSettingsStore((state) => state.values.turnPreference)
  const setEnabled = useSettingsStore((state) => state.setManagedTurnEnabled)
  const snapshot = useSyncExternalStore(
    managedTurn.subscribe,
    managedTurn.getSnapshot,
    managedTurn.getSnapshot
  )
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const run = (action: () => Promise<unknown>) => {
    setBusy(true)
    setFailed(false)
    void action()
      .catch(() => setFailed(true))
      .finally(() => setBusy(false))
  }
  const startLogin = async (provider: BrokerProvider) => {
    const ticket = managedTurnLoginTicket(
      await managedTurn.startLogin(provider)
    )
    if (!ticket) throw new Error('invalid login')
    await invoke('system_open_turn_login', { ticket })
  }
  return (
    <BackupRelayView
      snapshot={snapshot}
      enabled={enabled}
      hasIdentity={key !== null}
      preference={preference}
      busy={busy}
      failed={failed}
      onEnable={(value) => {
        if (key) run(() => setEnabled(key, value))
      }}
      onLogin={(provider) => run(() => startLogin(provider))}
      onConfirm={() => run(() => managedTurn.confirmLogin())}
      onCancel={() => managedTurn.cancelLogin()}
      onRefresh={() => run(() => managedTurn.refreshStatus())}
      onUnlink={(provider, subject) =>
        run(() => managedTurn.unlink(provider, subject))
      }
    />
  )
}
