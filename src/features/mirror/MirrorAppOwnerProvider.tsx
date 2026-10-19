import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useIdentityStore } from '@/stores/identityStore'
import { useSessionStore } from '@/stores/sessionStore'
import { strings } from '@/strings'
import { createMirrorAppOwner } from './appOwner'
import type { MirrorAppSnapshot } from './appBridge'
import { MirrorHostPanel } from './MirrorHostPanel'
import { createMirrorHost } from './runtime'
import {
  registerMirrorAppNotifications,
  registerMirrorReportHandoff,
} from './reportHandoff'
import type { MirrorSessionOwner } from './useSessionMirror'
import {
  MirrorAppOwnerContext as Context,
  useMirrorAppOwner,
} from './useMirrorAppOwner'

export function MirrorAppOwnerProvider({ children }: { children: ReactNode }) {
  const [owner] = useState(() =>
    createMirrorAppOwner({
      createHost: createMirrorHost,
      registerReport: registerMirrorReportHandoff,
      registerNotifications: registerMirrorAppNotifications,
    })
  )
  const phase = useRef<MirrorAppSnapshot['phase']>('loading')
  const update = useMemo(
    () => () => {
      const identity = useIdentityStore.getState()
      const session = useSessionStore.getState()
      owner.update({
        identity:
          identity.status === 'ready' && identity.identity
            ? {
                edPubkeyHex: identity.identity.ed_pubkey_hex,
                displayName: identity.identity.display_name ?? '',
              }
            : null,
        phase:
          identity.status === 'error'
            ? 'identity_error'
            : identity.status !== 'ready'
              ? identity.status === 'absent'
                ? 'onboarding'
                : 'loading'
              : session.status === 'active'
                ? 'session'
                : session.status === 'ended'
                  ? 'report'
                  : phase.current,
        room: session.status === 'active' ? session.room : null,
        topic: session.sessionTopic,
      })
    },
    [owner]
  )
  useLayoutEffect(() => {
    update()
    const identity = useIdentityStore.subscribe(update)
    const session = useSessionStore.subscribe(update)
    return () => {
      identity()
      session()
      void owner.stop()
    }
  }, [owner, update])
  const state = useSyncExternalStore(owner.subscribe, owner.getState)
  const setHomePhase = useMemo(
    () => (next: MirrorAppSnapshot['phase']) => {
      phase.current = next
      update()
    },
    [update]
  )
  const sessionOwner = useMemo<MirrorSessionOwner | undefined>(
    () =>
      state.enabled
        ? {
            ...state,
            takeover: true,
            sessionActivationId: state.activationId,
            start: owner.start,
            stop: owner.stop,
            attach: owner.attach,
            publish: owner.publish,
            setStreams: owner.setStreams,
            notify: owner.notify,
          }
        : undefined,
    [owner, state]
  )
  const value = useMemo(
    () => ({ owner, state, sessionOwner, setHomePhase }),
    [owner, state, sessionOwner, setHomePhase]
  )
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function MirrorAppAccess() {
  const context = useMirrorAppOwner()
  const [open, setOpen] = useState(false)
  const [consent, setConsent] = useState(false)
  const identityReady = useIdentityStore((s) => s.status === 'ready')
  if (!context) return null
  const { owner, state } = context
  const copy = strings.mirror.app
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <aside
        className="flex shrink-0 items-center justify-end gap-3 border-b border-border-subtle bg-bg-surface px-4 py-2"
        aria-label={copy.title}
      >
        {state.enabled ? (
          <span role="status" className="text-sm text-text-secondary">
            {state.connected
              ? strings.mirror.connected
              : strings.mirror.waiting}
          </span>
        ) : null}
        <DialogTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            disabled={!identityReady}
            onClick={() => {
              setConsent(false)
            }}
          >
            {copy.open}
          </Button>
        </DialogTrigger>
      </aside>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.access}</DialogDescription>
        </DialogHeader>
        {!state.enabled ? (
          <div className="flex items-center gap-3">
            <Switch
              id="mirror-app-consent"
              checked={consent}
              onCheckedChange={setConsent}
            />
            <Label htmlFor="mirror-app-consent">{copy.consent}</Label>
          </div>
        ) : null}
        <div
          inert={!state.enabled && !consent}
          className={!state.enabled && !consent ? 'opacity-50' : undefined}
        >
          <MirrorHostPanel
            {...state}
            takeover={state.enabled}
            onStart={async () => {
              if (!state.enabled && !consent) return
              await owner.start()
            }}
            onStop={owner.stop}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
