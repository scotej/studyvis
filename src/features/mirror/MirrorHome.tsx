import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { strings } from '@/strings'
import type { MirrorAppSnapshot } from './appBridge'
import type { MirrorHomeData } from './homeBridge'

export type MirrorHomeProps = {
  snapshot: MirrorAppSnapshot
  data: MirrorHomeData | null
  connected: boolean
  busy: boolean
  error: string | null
  onInvite: (id: string) => void
  onAccept: (id: string) => void
  onRejoin: (source: 'recent' | 'interrupted') => void
  onEndInterrupted: () => void
  onPage: (offset: number) => void
}

export function MirrorHome({
  snapshot,
  data,
  connected,
  busy,
  error,
  onInvite,
  onAccept,
  onRejoin,
  onEndInterrupted,
  onPage,
}: MirrorHomeProps) {
  const copy = strings.mirror.app
  const can = (command: string) =>
    connected && !busy && snapshot.capabilities.some((name) => name === command)
  const ready =
    snapshot.identity !== null &&
    !['loading', 'identity_error', 'onboarding'].includes(snapshot.phase)
  return (
    <main className="min-h-full bg-bg-base px-6 py-6 text-text-primary">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <header>
          <h1 className="text-xl font-semibold">{copy.home}</h1>
          {snapshot.identity?.displayName ? (
            <p className="text-sm text-text-secondary">
              {snapshot.identity.displayName}
            </p>
          ) : null}
        </header>
        {!connected ? (
          <p role="status" className="text-sm text-text-secondary">
            {copy.disconnected}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-status-alerted">
            {error}
          </p>
        ) : null}
        {!ready ? (
          <p role="status" className="text-sm text-text-secondary">
            {snapshot.phase === 'loading' ? copy.loading : copy.unavailable}
          </p>
        ) : !data ? (
          <div aria-busy="true">
            <Skeleton className="h-4 w-full" />
            <span className="sr-only">{strings.common.loading}</span>
          </div>
        ) : (
          <>
            {data.savePending ? (
              <p role="status" className="text-sm text-text-secondary">
                {copy.savePending}
              </p>
            ) : null}
            {data.interrupted ? (
              <section className="flex flex-col gap-3 rounded-lg border border-border-default bg-bg-surface p-4">
                <h2 className="font-semibold">{copy.interrupted}</h2>
                {data.interrupted.topic ? (
                  <p>{data.interrupted.topic}</p>
                ) : null}
                <div className="flex flex-wrap gap-3">
                  <Button
                    disabled={!can('home.rejoin') || data.savePending}
                    onClick={() => onRejoin('interrupted')}
                  >
                    {copy.rejoin}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!can('home.end_interrupted')}
                    onClick={onEndInterrupted}
                  >
                    {copy.endInterrupted}
                  </Button>
                </div>
              </section>
            ) : (
              <>
                {data.rejoinDeadline !== null ? (
                  <Button
                    variant="secondary"
                    disabled={!can('home.rejoin') || data.savePending}
                    onClick={() => onRejoin('recent')}
                  >
                    {copy.rejoin}
                  </Button>
                ) : null}
                {data.invites.length ? (
                  <section className="flex flex-col gap-3">
                    <h2 className="text-lg font-semibold">
                      {copy.invitations}
                    </h2>
                    {data.invites.map((invite) => (
                      <div
                        key={invite.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border-default bg-bg-surface p-4"
                      >
                        <span className="min-w-0 break-words">
                          {invite.displayName}
                        </span>
                        <Button
                          disabled={!can('home.accept') || data.savePending}
                          onClick={() => onAccept(invite.id)}
                        >
                          {copy.accept}
                        </Button>
                      </div>
                    ))}
                  </section>
                ) : null}
                <section className="flex flex-col gap-3">
                  <h2 className="text-lg font-semibold">
                    {strings.friends.list.heading}
                  </h2>
                  {data.friends.length === 0 ? (
                    <p className="text-sm text-text-secondary">{copy.empty}</p>
                  ) : (
                    data.friends.map((friend) => (
                      <div
                        key={friend.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border-default bg-bg-surface p-4"
                      >
                        <div className="min-w-0">
                          <p className="break-words font-medium">
                            {friend.displayName}
                          </p>
                          <p className="text-sm text-text-secondary">
                            {friend.presence === 'online'
                              ? copy.online
                              : copy.offline}
                          </p>
                        </div>
                        <Button
                          disabled={
                            !can('home.invite') ||
                            !data.rosterReady ||
                            data.savePending
                          }
                          onClick={() => onInvite(friend.id)}
                        >
                          {copy.invite}
                        </Button>
                      </div>
                    ))
                  )}
                </section>
                {data.offset > 0 ||
                data.totalFriends > data.offset + data.friends.length ? (
                  <nav
                    className="flex gap-3"
                    aria-label={strings.friends.list.heading}
                  >
                    <Button
                      variant="secondary"
                      disabled={busy || !connected || data.offset === 0}
                      onClick={() => onPage(Math.max(0, data.offset - 64))}
                    >
                      {copy.previous}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={
                        busy ||
                        !connected ||
                        data.offset + data.friends.length >= data.totalFriends
                      }
                      onClick={() => onPage(data.offset + 64)}
                    >
                      {copy.next}
                    </Button>
                  </nav>
                ) : null}
              </>
            )}
          </>
        )}
      </div>
    </main>
  )
}
