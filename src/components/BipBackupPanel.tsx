import { useEffect, useRef, useState } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'

export type BipBackupPanelProps = {
  mnemonic: string[]
  // When provided, the "I've saved them" confirmation checkbox renders and is
  // controlled by the parent (it gates the parent's Continue). Omit for a
  // read-only display with no confirmation.
  confirm?: {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
  }
  className?: string
}

// The 24-word backup surface from DESIGN-SYSTEM §4 / §8.1: mono-font word
// grid, copy-to-clipboard, and the optional "I've saved them" confirmation.
// Extracted from IdentitySetup so the recovery flow and onboarding share one
// component; the onboarding markup, copy, and aria wiring are unchanged.
export function BipBackupPanel({
  mnemonic,
  confirm,
  className,
}: BipBackupPanelProps) {
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = null
      }
    }
  }, [])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(mnemonic.join(' '))
      setCopied(true)
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current)
      }
      copiedTimerRef.current = setTimeout(() => {
        setCopied(false)
        copiedTimerRef.current = null
      }, 1500)
    } catch {
      toast.error("Couldn't copy to clipboard.")
    }
  }

  return (
    <div
      className={cn('flex w-full flex-col items-center gap-8', className)}
      data-slot="bip-backup-panel"
    >
      <section
        className="flex w-full flex-col gap-5 rounded-xl border border-border-default bg-bg-surface p-6"
        aria-label="24-word recovery phrase"
      >
        <ol
          className="grid grid-flow-col grid-rows-8 gap-x-8 gap-y-2 font-mono text-sm leading-snug"
          data-slot="mnemonic-grid"
        >
          {mnemonic.map((word, index) => (
            <li key={index} className="flex items-baseline gap-3 tabular-nums">
              <span className="w-6 text-right text-text-muted">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="text-text-primary">{word}</span>
            </li>
          ))}
        </ol>

        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            aria-label="Copy 24 words to clipboard"
          >
            {copied ? (
              <>
                <CheckIcon /> Copied
              </>
            ) : (
              <>
                <CopyIcon /> Copy to clipboard
              </>
            )}
          </Button>
        </div>
      </section>

      {confirm ? (
        <label className="flex w-full max-w-md cursor-pointer items-start gap-3 text-sm leading-snug text-text-secondary">
          <Checkbox
            className="mt-0.5"
            checked={confirm.checked}
            onCheckedChange={(state) => confirm.onCheckedChange(state === true)}
            aria-describedby="identity-ack-text"
          />
          <span id="identity-ack-text">
            I&apos;ve saved these words. I understand losing them means losing
            this identity.
          </span>
        </label>
      ) : null}
    </div>
  )
}
