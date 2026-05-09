import { useEffect, useRef, useState } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

import type { Mnemonic } from '@/lib/crypto/identity'

export type IdentitySetupProps = {
  mnemonic: Mnemonic
  onConfirm: () => void | Promise<void>
}

export function IdentitySetup({ mnemonic, onConfirm }: IdentitySetupProps) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [copied, setCopied] = useState(false)
  const [submitting, setSubmitting] = useState(false)
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

  async function handleContinue() {
    if (!acknowledged || submitting) return
    setSubmitting(true)
    try {
      await onConfirm()
    } catch (err) {
      console.error(err)
      toast.error('Could not save identity.')
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-base px-6 py-12 text-text-primary">
      <div className="flex w-full max-w-2xl flex-col items-center gap-8">
        <header className="flex flex-col items-center gap-3 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Save these 24 words somewhere safe
          </h1>
          <p className="max-w-md text-sm leading-snug text-text-secondary">
            If you lose this laptop, these words are the only way to recover
            this identity. Pen and paper. No cloud sync.
          </p>
        </header>

        <section
          className="flex w-full flex-col gap-5 rounded-xl border border-border-default bg-bg-surface p-6"
          aria-label="24-word recovery phrase"
        >
          <ol
            className="grid grid-flow-col grid-rows-8 gap-x-8 gap-y-2 font-mono text-sm leading-snug"
            data-slot="mnemonic-grid"
          >
            {mnemonic.map((word, index) => (
              <li
                key={index}
                className="flex items-baseline gap-3 tabular-nums"
              >
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

        <label className="flex w-full max-w-md cursor-pointer items-start gap-3 text-sm leading-snug text-text-secondary">
          <Checkbox
            className="mt-0.5"
            checked={acknowledged}
            onCheckedChange={(state) => setAcknowledged(state === true)}
            aria-describedby="identity-ack-text"
          />
          <span id="identity-ack-text">
            I&apos;ve saved these words. I understand losing them means losing
            this identity.
          </span>
        </label>

        <div className="flex w-full justify-end">
          <Button
            onClick={handleContinue}
            disabled={!acknowledged || submitting}
            aria-disabled={!acknowledged || submitting}
          >
            Continue
          </Button>
        </div>
      </div>
    </main>
  )
}
