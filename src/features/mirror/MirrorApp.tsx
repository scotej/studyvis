import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TopicGateModal } from '@/features/session/TopicGateModal'
import { strings } from '@/strings'
import type { BrowserConnection } from './browserConnection'
import type { MirrorAppCommandName, MirrorAppJson } from './appBridge'
import { readMirrorHome, type MirrorHomeData } from './homeBridge'
import { MirrorHome } from './MirrorHome'
import { MirrorSession } from './MirrorSession'

export type MirrorSettingsRenderer = (props: {
  connection: BrowserConnection
  initialCategory?: string
  onClose: () => void
}) => ReactNode
export type MirrorAppProps = {
  connection: BrowserConnection
  renderSettings?: MirrorSettingsRenderer
}

export function MirrorApp({ connection, renderSettings }: MirrorAppProps) {
  const state = useSyncExternalStore(connection.subscribe, connection.getState)
  const snapshot = state.appSnapshot
  const [view, setView] = useState<'auto' | 'home' | 'settings'>('auto')
  const activation = `${snapshot?.ownerEpoch ?? ''}:${snapshot?.sessionActivationId ?? ''}`
  const [previousActivation, setPreviousActivation] = useState(activation)
  if (previousActivation !== activation) {
    setPreviousActivation(activation)
    setView('auto')
  }
  const [home, setHome] = useState<{
    owner: string
    data: MirrorHomeData
  } | null>(null)
  const [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [pairing, setPairing] = useState(false)
  const [pending, setPending] = useState<{
    command: 'home.invite' | 'home.accept'
    id: string
    scope: string
  } | null>(null)
  const readRun = useRef(0)
  const connected = state.status === 'connected'
  const owner = snapshot?.ownerEpoch
  const canRead = snapshot?.capabilities.includes('home.read') ?? false
  const read = useCallback(async () => {
    if (!owner || !connected || !canRead) return
    const run = ++readRun.current
    const result = await connection.requestApp('home.read', { offset })
    if (
      run !== readRun.current ||
      connection.getState().appSnapshot?.ownerEpoch !== owner
    )
      return
    if (result.ok) {
      const data = readMirrorHome(result.value)
      if (data) {
        setHome({ owner, data })
        return
      }
    }
    setError(strings.mirror.controlFailed)
  }, [connection, owner, connected, canRead, offset])
  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void read()
    })
    const timer = window.setInterval(() => {
      void read()
    }, 3000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [read, snapshot?.revision])
  const data = home && home.owner === owner ? home.data : null
  const request = async (
    command: MirrorAppCommandName,
    args: MirrorAppJson
  ) => {
    if (busy || !connected || !snapshot?.capabilities.includes(command)) return
    const epoch = snapshot.ownerEpoch
    setBusy(true)
    setError(null)
    try {
      const result = await connection.requestApp(command, args)
      if (connection.getState().appSnapshot?.ownerEpoch !== epoch) return
      if (!result.ok) setError(strings.mirror.controlFailed)
      else {
        setPending(null)
        void read()
      }
    } finally {
      setBusy(false)
    }
  }
  const start = (command: 'home.invite' | 'home.accept', id: string) => {
    if (data?.aiEnabled && snapshot?.phase !== 'session')
      setPending({ command, id, scope: activation })
    else void request(command, { id, topic: null })
  }
  if (!snapshot) return <MirrorSession connection={connection} />
  const showSession =
    snapshot.phase === 'session' || (state.report !== null && view !== 'home')
  const settings =
    view === 'settings' &&
    renderSettings &&
    snapshot.capabilities.includes('settings.read')
  return (
    <div className="flex min-h-full flex-col bg-bg-base text-text-primary">
      <nav
        className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-b border-border-default px-4 py-2"
        aria-label={strings.mirror.title}
      >
        {snapshot.phase !== 'session' && state.report !== null ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setView(view === 'home' ? 'auto' : 'home')}
          >
            {view === 'home'
              ? strings.report.ariaLabel
              : strings.mirror.app.home}
          </Button>
        ) : null}
        {renderSettings && snapshot.capabilities.includes('settings.read') ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={!connected}
            onClick={() => setView('settings')}
          >
            {strings.settings.heading}
          </Button>
        ) : null}
      </nav>
      <div
        inert={Boolean(settings)}
        className={settings ? 'hidden' : 'contents'}
      >
        {showSession ? (
          <MirrorSession
            connection={connection}
            onCloseReport={() => setView('home')}
            onRejoin={
              data?.rejoinDeadline !== null &&
              data?.rejoinDeadline !== undefined
                ? () => {
                    void request('home.rejoin', { source: 'recent' })
                  }
                : undefined
            }
            rejoinDeadline={data?.rejoinDeadline ?? undefined}
          />
        ) : (
          <MirrorHome
            snapshot={snapshot}
            data={data}
            connected={connected}
            busy={busy}
            error={error}
            onInvite={(id) => start('home.invite', id)}
            onAccept={(id) => start('home.accept', id)}
            onRejoin={(source) => {
              void request('home.rejoin', { source })
            }}
            onEndInterrupted={() => {
              void request('home.end_interrupted', {})
            }}
            onPage={setOffset}
          />
        )}
      </div>
      {!connected && !showSession ? (
        <form
          className="mx-auto flex w-full max-w-md flex-col gap-3 px-6 pb-6"
          onSubmit={(event) => {
            event.preventDefault()
            if (!password.trim() || pairing) return
            setPairing(true)
            setError(null)
            void connection
              .pair(password)
              .then(() => setPassword(''))
              .catch(() => setError(strings.mirror.pairFailed))
              .finally(() => setPairing(false))
          }}
        >
          <Label htmlFor="mirror-app-password">{strings.mirror.password}</Label>
          <Input
            id="mirror-app-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            maxLength={64}
            autoComplete="one-time-code"
          />
          <Button disabled={pairing || password.trim().length === 0}>
            {strings.mirror.pair}
          </Button>
        </form>
      ) : null}
      {settings
        ? renderSettings({ connection, onClose: () => setView('auto') })
        : null}
      <TopicGateModal
        open={pending !== null && pending.scope === activation}
        onCancel={() => setPending(null)}
        onSubmit={(topic) => {
          if (pending?.scope === activation)
            void request(pending.command, { id: pending.id, topic })
        }}
      />
    </div>
  )
}
