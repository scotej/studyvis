import { useCallback, useState } from 'react'
import { Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'

import { SettingsRow, SettingsSection } from '@/components/SettingsRow'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Friend } from '@/lib/db/friends'
import { useFriendsStore } from '@/stores/friendsStore'
import { strings } from '@/strings'

export function FriendsCategory() {
  const friends = useFriendsStore((s) => s.friends)
  const remove = useFriendsStore((s) => s.remove)
  const [pendingRemoval, setPendingRemoval] = useState<Friend | null>(null)
  const [removing, setRemoving] = useState(false)
  const copy = strings.settings.friends

  const confirmRemoval = useCallback(async () => {
    if (!pendingRemoval) return
    setRemoving(true)
    try {
      await remove(pendingRemoval.ed_pubkey_hex)
      toast.success(
        copy.removedToast(
          pendingRemoval.display_name?.trim() || copy.defaultFriendName
        )
      )
      setPendingRemoval(null)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : copy.removeErrorFallback
      toast.error(message)
    } finally {
      setRemoving(false)
    }
  }, [pendingRemoval, remove, copy])

  return (
    <>
      <SettingsSection heading={copy.heading}>
        {friends.length === 0 ? (
          <SettingsRow label={copy.emptyLabel} help={copy.emptyHelp} />
        ) : (
          friends.map((friend) => (
            <SettingsRow
              key={friend.ed_pubkey_hex}
              label={friend.display_name?.trim() || shortPubkey(friend)}
              help={shortPubkey(friend)}
              control={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setPendingRemoval(friend)}
                  aria-label={copy.removeAriaLabel(
                    friend.display_name?.trim() || copy.defaultFriendName
                  )}
                >
                  <Trash2Icon /> {copy.removeCta}
                </Button>
              }
            />
          ))
        )}
      </SettingsSection>

      <Dialog
        open={Boolean(pendingRemoval)}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.confirm.title}</DialogTitle>
            <DialogDescription>
              {pendingRemoval
                ? copy.confirm.body(
                    pendingRemoval.display_name?.trim() ||
                      copy.defaultFriendDisplay
                  )
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPendingRemoval(null)}
              disabled={removing}
            >
              {copy.confirm.cancelCta}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmRemoval()}
              disabled={removing}
              aria-disabled={removing}
            >
              {copy.confirm.confirmCta}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function shortPubkey(friend: Friend): string {
  return `${friend.ed_pubkey_hex.slice(0, 12)}…`
}
