import { useRef, useState } from 'react'
import { toast } from 'sonner'

import { type OnboardingStepProgress } from '@/components/OnboardingStep'
import { strings } from '@/strings'

import {
  classifyMnemonic,
  decideOverwrite,
  normalizeMnemonicInput,
} from './recoverLogic'
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
  // D5 — the stored mnemonic_fingerprint of the identity already on this
  // device, when one exists. Lets the flow skip the overwrite warning when the
  // typed words recompute to the same fingerprint (a harmless re-commit) and
  // escalate the copy when they're a different identity.
  currentFingerprint?: string | null
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
  currentFingerprint,
  recover,
  onBack,
  onRecovered,
}: RecoverProps) {
  const [value, setValue] = useState('')
  const [phase, setPhase] = useState<RecoverPhase>('input')
  const [error, setError] = useState<RecoverErrorKind | null>(null)
  // D5 — when the confirm is shown, whether the typed words are a DIFFERENT
  // identity (escalated copy) or just an unknown-fingerprint legacy record
  // (generic copy).
  const [confirmDifferent, setConfirmDifferent] = useState(false)
  // D5 — true when the typed words re-committed the identity already on this
  // device, so the done screen mustn't claim friends need re-pairing.
  const [sameIdentity, setSameIdentity] = useState(false)
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
    // D5 — skip the warning when restoring the SAME identity over itself
    // (harmless), escalate it when the words are a DIFFERENT identity.
    setSameIdentity(false)
    setConfirmDifferent(false)
    const decision = decideOverwrite(
      classified.words,
      identityExists,
      currentFingerprint
    )
    if (decision === 'commit') {
      setSameIdentity(identityExists)
      void commit()
      return
    }
    setConfirmDifferent(decision === 'confirm-different')
    setPhase('confirm')
  }

  return (
    <RecoverView
      progress={progress}
      phase={phase}
      value={value}
      wordCount={wordCount}
      error={error}
      identityExists={identityExists}
      confirmDifferent={confirmDifferent}
      sameIdentity={sameIdentity}
      onChange={handleChange}
      onSubmit={handleSubmit}
      onBack={onBack}
      onConfirmOverwrite={() => void commit()}
      onCancelOverwrite={() => {
        pendingCommit.current = null
        setSameIdentity(false)
        setConfirmDifferent(false)
        setPhase('input')
      }}
      onDone={onRecovered}
    />
  )
}
