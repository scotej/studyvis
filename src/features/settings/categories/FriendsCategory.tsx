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

export function FriendsCategory() {
  const friends = useFriendsStore((s) => s.friends)
  const remove = useFriendsStore((s) => s.remove)
  const [pendingRemoval, setPendingRemoval] = useState<Friend | null>(null)
  const [removing, setRemoving] = useState(false)

  const confirmRemoval = useCallback(async () => {
    if (!pendingRemoval) return
    setRemoving(true)
    try {
      await remove(pendingRemoval.ed_pubkey_hex)
      toast.success(
        `Removed ${pendingRemoval.display_name?.trim() || 'your friend'}.`
      )
      setPendingRemoval(null)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Couldn't remove that friend."
      toast.error(message)
    } finally {
      setRemoving(false)
    }
  }, [pendingRemoval, remove])

  return (
    <>
      <SettingsSection heading="Friends">
        {friends.length === 0 ? (
          <SettingsRow
            label="No friends yet"
            help="Pair with a friend from the main view to see them here."
          />
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
                  aria-label={`Remove ${friend.display_name?.trim() || 'your friend'}`}
                >
                  <Trash2Icon /> Remove
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
            <DialogTitle>Remove this friend?</DialogTitle>
            <DialogDescription>
              {pendingRemoval
                ? `${pendingRemoval.display_name?.trim() || 'This friend'} will be removed from your friends list. To study together again you'll need to pair from scratch.`
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
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmRemoval()}
              disabled={removing}
              aria-disabled={removing}
            >
              Remove
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
