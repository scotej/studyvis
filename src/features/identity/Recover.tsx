import { useRef, useState } from 'react'
import { toast } from 'sonner'

import { type OnboardingStepProgress } from '@/components/OnboardingStep'
import { strings } from '@/strings'

import { classifyMnemonic, normalizeMnemonicInput } from './recoverLogic'
import {
  RecoverView,
  type RecoverErrorKind,
  type RecoverPhase,
} from './RecoverView'

export type RecoverProps = {
  progress?: OnboardingStepProgress
  // True when identity.json / the keychain already hold an identity; gates the
  // explicit overwrite confirmation.
  identityExists: boolean
  // The identityStore `recover` action: derives keys from the words and
  // returns a deferred commit that writes through the one persistence path.
  recover: (mnemonic: string[]) => { commit: () => Promise<void> }
  onBack: () => void
  onRecovered: () => void
}

// Container for the 24-word recovery flow. Owns the input → (confirm) →
// commit → done state machine; never writes the mnemonic anywhere.
export function Recover({
  progress,
  identityExists,
  recover,
  onBack,
  onRecovered,
}: RecoverProps) {
  const [value, setValue] = useState('')
  const [phase, setPhase] = useState<RecoverPhase>('input')
  const [error, setError] = useState<RecoverErrorKind | null>(null)
  const pendingCommit = useRef<(() => Promise<void>) | null>(null)

  const wordCount = normalizeMnemonicInput(value).length

  function handleChange(next: string) {
    setValue(next)
    if (error) setError(null)
  }

  async function commit() {
    const run = pendingCommit.current
    if (!run) return
    setPhase('submitting')
    try {
      await run()
      pendingCommit.current = null
      setPhase('done')
    } catch (err) {
      console.error(err)
      toast.error(strings.common.errors.savingIdentity)
      setPhase('input')
    }
  }

  function handleSubmit() {
    const classified = classifyMnemonic(value)
    if (classified.kind !== 'valid') {
      setError(classified.kind)
      return
    }
    setError(null)
    try {
      pendingCommit.current = recover(classified.words).commit
    } catch (err) {
      // classifyMnemonic already validated length + checksum, so deriving keys
      // shouldn't throw on these words. A throw here is genuinely unexpected
      // (e.g. a crypto-lib internal failure); surface the generic recovery
      // error instead of the misleading "invalid mnemonic" inline message,
      // and log it for diagnosis. Mirrors the commit() failure path.
      console.error(err)
      toast.error(strings.common.errors.savingIdentity)
      return
    }
    if (identityExists) {
      setPhase('confirm')
      return
    }
    void commit()
  }

  return (
    <RecoverView
      progress={progress}
      phase={phase}
      value={value}
      wordCount={wordCount}
      error={error}
      identityExists={identityExists}
      onChange={handleChange}
      onSubmit={handleSubmit}
      onBack={onBack}
      onConfirmOverwrite={() => void commit()}
      onCancelOverwrite={() => {
        pendingCommit.current = null
        setPhase('input')
      }}
      onDone={onRecovered}
    />
  )
}
