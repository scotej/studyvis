import { useCallback, useEffect, useRef, useState } from 'react'

import {
  AiResponseBubble,
  type AiResponseTone,
} from '@/components/AiResponseBubble'
import { AiTextBox } from '@/components/AiTextBox'

import { handleUserText, AiAgentError } from './aiAgent'
import {
  AI_DIALOG_BREAK_REQUEST,
  AI_DIALOG_BREAK_RESPONSE,
  AI_DIALOG_CONTEXT,
  AI_DIALOG_CONTEXT_REQUEST,
  AI_DIALOG_TOPIC_CHANGE,
  type AiDialogContextPayload,
  type BreakResponsePayload,
} from './aiDialogChannels'

// V2-P7 — Floating Ctrl+] dialog hosted in a separate Tauri WebviewWindow.
// The OS-level window itself (transparent, alwaysOnTop, no decorations,
// fullScreenAuxiliary on macOS) is created by the Rust `toggle_ai_dialog`
// command; this component is what the window's React root mounts.
//
// Why separate window: NSWindowCollectionBehaviorFullScreenAuxiliary is
// what makes the dialog appear OVER macOS fullscreen apps. That bit can
// only be set on a real NSWindow; an in-app portal would inherit the
// main window's collection behavior and disappear when the user goes
// fullscreen on another app. (ARCHITECTURE.md §12.)
//
// Cross-window IPC: the dialog never touches stores in the main window —
// each Tauri WebviewWindow runs an isolated JS context. Instead the
// dialog requests its context on mount via the `ai-dialog:context-request`
// event and applies intents back via the `ai-dialog:*` event names
// declared in `aiDialogChannels.ts`. The main window's SessionView is the
// other half of the protocol.

export type AiDialogRuntime = {
  // Listen for an event targeted at this dialog window. Defaults to
  // `getCurrentWindow().listen` from @tauri-apps/api. Tests + Storybook
  // inject a stub.
  listen: <T>(
    event: string,
    handler: (payload: T) => void
  ) => Promise<() => void>
  // Emit a JS event to ANY listener (defaults to `emit` from
  // @tauri-apps/api/event — fan-out, not window-targeted).
  emit: (event: string, payload?: unknown) => Promise<void>
  // Close the current window. Defaults to `getCurrentWindow().close()`.
  // The shortcut-handler-driven toggle in Rust calls `destroy()` on its
  // side; this close path is for Esc + blur + the X button.
  close: () => Promise<void>
  now: () => number
}

export type AiDialogWindowProps = {
  // Initial context — Storybook + tests pre-populate this. In the live
  // dialog window, mount with `null` and the dialog requests context via
  // the IPC channel on mount.
  initialContext?: AiDialogContextPayload | null
  // Test seam — production wires Tauri's listen/emit + window.close. The
  // standalone window entrypoint (`ai-dialog-main.tsx`) injects the live
  // runtime; Storybook stories inject a noop runtime so they render
  // outside Tauri.
  runtime?: AiDialogRuntime
  // Test seam for the agent call — defaults to `aiAgent.handleUserText`.
  // Storybook variants inject canned replies so the bubble states render
  // without a sidecar.
  handle?: typeof handleUserText
  // Optional hook for stories that want to override the verdict text.
  forceState?: {
    text: string
    pending: boolean
    response: { text: string; tone: AiResponseTone } | null
  }
}

type DialogState = {
  text: string
  pending: boolean
  response: { text: string; tone: AiResponseTone } | null
}

const INITIAL_STATE: DialogState = {
  text: '',
  pending: false,
  response: null,
}

export function AiDialogWindow({
  initialContext = null,
  runtime,
  handle = handleUserText,
  forceState,
}: AiDialogWindowProps) {
  const [context, setContext] = useState<AiDialogContextPayload | null>(
    initialContext
  )
  const [state, setState] = useState<DialogState>(INITIAL_STATE)
  // Outstanding break-request nonces awaiting a verdict from the main
  // window. Map nonce → resolver so a late response from a previous
  // request doesn't surface as the current dialog reply.
  const pendingNonces = useRef<
    Map<string, (resp: BreakResponsePayload) => void>
  >(new Map())

  const effective = forceState ?? state

  // Context exchange + break-response listener. The dialog requests its
  // context on mount and re-listens for any future broadcasts (e.g. the
  // topic changed after another open).
  useEffect(() => {
    if (!runtime) return
    let cancelled = false
    const unlistens: Array<() => void> = []

    void (async () => {
      const offContext = await runtime.listen<AiDialogContextPayload>(
        AI_DIALOG_CONTEXT,
        (payload) => {
          if (cancelled) return
          setContext(payload)
        }
      )
      unlistens.push(offContext)

      const offBreakResp = await runtime.listen<BreakResponsePayload>(
        AI_DIALOG_BREAK_RESPONSE,
        (payload) => {
          if (cancelled) return
          const resolver = pendingNonces.current.get(payload.nonce)
          if (!resolver) return
          pendingNonces.current.delete(payload.nonce)
          resolver(payload)
        }
      )
      unlistens.push(offBreakResp)

      // Now that we're listening, ask for context.
      try {
        await runtime.emit(AI_DIALOG_CONTEXT_REQUEST, {})
      } catch (err) {
        console.warn('[ai-dialog] context request failed:', err)
      }
    })()

    return () => {
      cancelled = true
      for (const off of unlistens) off()
    }
  }, [runtime])

  // Close-on-blur + close-on-Esc. The window builder sets focused=true on
  // creation, and the OS hands focus to whatever the user clicks on after,
  // including the main window — so a blur means "the user moved on" and
  // is the click-outside-closes signal (DOM events outside the window
  // never reach this JS context). Esc is a DOM-side keyboard fallback
  // for the same intent.
  useEffect(() => {
    if (!runtime) return
    let cancelled = false
    let offBlur: (() => void) | null = null

    void (async () => {
      offBlur = await runtime.listen('tauri://blur', () => {
        if (cancelled) return
        void runtime.close()
      })
    })()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void runtime.close()
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      cancelled = true
      offBlur?.()
      window.removeEventListener('keydown', onKey)
    }
  }, [runtime])

  const submit = useCallback(async () => {
    if (effective.pending) return
    const trimmed = state.text.trim()
    if (trimmed.length === 0) return
    if (!context) {
      setState((s) => ({
        ...s,
        response: {
          text: "Session context isn't loaded yet — try again in a moment.",
          tone: 'denied',
        },
      }))
      return
    }
    setState({
      text: trimmed,
      pending: true,
      response: null,
    })

    try {
      const reply = await handle({
        text: trimmed,
        declaredTopic: context.declaredTopic,
        modelId: context.modelId,
        recentAuditKinds: context.recentAuditKinds,
      })

      if (reply.intent === 'topic_change') {
        try {
          await runtime?.emit(AI_DIALOG_TOPIC_CHANGE, {
            new_topic: reply.payload.new_topic,
          })
        } catch (err) {
          console.warn('[ai-dialog] topic emit failed:', err)
        }
        setState({
          text: '',
          pending: false,
          response: { text: reply.reply_text, tone: 'neutral' },
        })
        return
      }

      if (reply.intent === 'break_request') {
        if (!runtime) {
          setState({
            text: '',
            pending: false,
            response: {
              text: 'Break requests need the dialog to be running inside the app.',
              tone: 'denied',
            },
          })
          return
        }
        const nonce = generateNonce(runtime.now())
        const verdict = await new Promise<BreakResponsePayload>((resolve) => {
          pendingNonces.current.set(nonce, resolve)
          void runtime
            .emit(AI_DIALOG_BREAK_REQUEST, {
              nonce,
              requested_duration_sec: reply.payload.duration_sec,
              ai_recommendation: reply.payload.recommendation,
              ai_reasoning: reply.payload.reasoning,
            })
            .catch((err) => {
              console.warn('[ai-dialog] break-request emit failed:', err)
            })
        })
        setState({
          text: '',
          pending: false,
          response: {
            text: verdict.reason,
            tone: verdict.verdict === 'approved' ? 'approved' : 'denied',
          },
        })
        return
      }

      // question | unknown — purely informational.
      setState({
        text: '',
        pending: false,
        response: { text: reply.reply_text, tone: 'neutral' },
      })
    } catch (err) {
      let text = 'Something went wrong.'
      if (err instanceof AiAgentError) {
        text = err.message
      } else if (err instanceof Error) {
        text = err.message
      }
      setState((s) => ({
        ...s,
        pending: false,
        response: { text, tone: 'denied' },
      }))
    }
  }, [context, effective.pending, handle, runtime, state.text])

  return (
    <div
      data-testid="ai-dialog-window"
      className="flex h-screen w-screen items-center justify-center bg-transparent p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-border-default bg-bg-raised p-4 shadow-lg">
        <header className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium text-text-primary">
            Ask the AI
          </span>
          <span className="text-xs text-text-secondary">Esc to close</span>
        </header>
        <AiTextBox
          value={effective.text}
          onChange={(next) => setState((s) => ({ ...s, text: next }))}
          onSubmit={submit}
          pending={effective.pending}
        />
        {effective.response ? (
          <div className="mt-3">
            <AiResponseBubble
              text={effective.response.text}
              tone={effective.response.tone}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}

function generateNonce(seed: number): string {
  // Web-Crypto is available in WebViews; fall back to Math.random for
  // Storybook / test contexts where the API may not be wired up.
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }
  return `${seed}-${Math.floor(Math.random() * 1e9)}`
}
