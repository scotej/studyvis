import { CheckIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { strings } from '@/strings'

// The import confirm sheet is intentionally its own presentational surface (not
// a tab inside AddFriendDialogView) so a deep-linked card arriving mid-flow has
// somewhere to land. `outcome` is fully derived by the container from the card
// bytes; this component only renders and reports intent.
export type ContactImportOutcome =
  | {
      kind: 'confirm'
      name: string
      shortId: string
      fingerprint: string
      // true on the remote (paste/link/deep-link) path: the safety number must
      // be affirmed before Add is enabled. false on the QR path, where physical
      // presence already authenticates the exchange.
      requireAck: boolean
    }
  | { kind: 'error'; message: string }
  | { kind: 'added'; name: string }

export type ContactImportViewProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  outcome: ContactImportOutcome | null
  acked: boolean
  onAckChange: (value: boolean) => void
  saving: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ContactImportView({
  open,
  onOpenChange,
  outcome,
  acked,
  onAckChange,
  saving,
  onConfirm,
  onCancel,
}: ContactImportViewProps) {
  const copy = strings.friends.addDialog.importCard
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {outcome?.kind === 'added' ? (
          <AddedPanel name={outcome.name} onClose={onCancel} />
        ) : outcome?.kind === 'error' ? (
          <ErrorPanel message={outcome.message} onClose={onCancel} />
        ) : outcome?.kind === 'confirm' ? (
          <ConfirmPanel
            outcome={outcome}
            acked={acked}
            onAckChange={onAckChange}
            saving={saving}
            onConfirm={onConfirm}
            onCancel={onCancel}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{copy.title}</DialogTitle>
            </DialogHeader>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ConfirmPanel({
  outcome,
  acked,
  onAckChange,
  saving,
  onConfirm,
  onCancel,
}: {
  outcome: Extract<ContactImportOutcome, { kind: 'confirm' }>
  acked: boolean
  onAckChange: (value: boolean) => void
  saving: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const copy = strings.friends.addDialog.importCard
  const common = strings.common.actions
  const canAdd = !saving && (!outcome.requireAck || acked)
  return (
    <div className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.body(outcome.name)}</DialogDescription>
      </DialogHeader>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border-default bg-bg-surface px-4 py-3">
        <span className="text-sm text-text-secondary">{copy.idLabel}</span>
        <span className="font-mono text-sm text-text-primary">
          {outcome.shortId}
        </span>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border-default bg-bg-surface p-4">
        <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
          {copy.fingerprintLabel}
        </span>
        <p
          className="text-center font-mono text-lg tabular-nums text-text-primary"
          aria-label={`${copy.fingerprintLabel}: ${outcome.fingerprint}`}
        >
          {outcome.fingerprint}
        </p>
        <p className="text-xs text-text-secondary">
          {copy.fingerprintInstruction}
        </p>
      </div>

      {outcome.requireAck ? (
        <label className="flex items-start gap-3 text-sm text-text-secondary">
          <Checkbox
            checked={acked}
            onCheckedChange={(v) => onAckChange(v === true)}
            className="mt-0.5"
          />
          <span>{copy.fingerprintConfirmLabel}</span>
        </label>
      ) : null}

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          {common.cancel}
        </Button>
        <Button onClick={onConfirm} disabled={!canAdd} aria-disabled={!canAdd}>
          {copy.addCta}
        </Button>
      </DialogFooter>
    </div>
  )
}

function AddedPanel({ name, onClose }: { name: string; onClose: () => void }) {
  const copy = strings.friends.addDialog.importCard
  return (
    <div className="flex flex-col gap-5">
      <DialogHeader className="sr-only">
        <DialogTitle>{copy.addedTitle(name)}</DialogTitle>
      </DialogHeader>
      <div
        role="status"
        className="flex flex-col items-center gap-3 rounded-lg border border-status-focused/40 bg-status-focused/10 px-6 py-8 text-center"
      >
        <CheckIcon className="size-6 text-status-focused" aria-hidden />
        <p className="text-base font-medium text-text-primary">
          {copy.addedTitle(name)}
        </p>
        <p className="text-sm text-text-secondary">{copy.addedBody}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {copy.closeCta}
        </Button>
      </DialogFooter>
    </div>
  )
}

function ErrorPanel({
  message,
  onClose,
}: {
  message: string
  onClose: () => void
}) {
  const copy = strings.friends.addDialog.importCard
  return (
    <div className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>{copy.errorTitle}</DialogTitle>
      </DialogHeader>
      <p
        role="alert"
        className="rounded-md border border-status-alerted/40 bg-status-alerted/10 px-3 py-2 text-sm text-status-alerted"
      >
        {message}
      </p>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {copy.closeCta}
        </Button>
      </DialogFooter>
    </div>
  )
}
