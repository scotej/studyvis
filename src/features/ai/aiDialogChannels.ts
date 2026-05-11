// V2-P7 — Cross-window event names + payload types for the floating
// Ctrl+] dialog. Shared by the dialog (AiDialogWindow.tsx) and the main
// window's SessionView so the wire shape stays single-sourced.
//
// Naming convention: `ai-dialog:<verb>`. Anything the dialog sends is
// applied by the main window; anything the dialog listens for is
// emitted by the main window (or by the Rust shortcut handler in the
// special case of context kick-offs).

export const AI_DIALOG_WINDOW_LABEL = 'ai-dialog'

// Dialog → main: "I just mounted, please push me the current session
// snapshot." Empty payload; the main window reads its own stores.
export const AI_DIALOG_CONTEXT_REQUEST = 'ai-dialog:context-request'

// Main → dialog: the snapshot the dialog renders against. Main may
// re-emit this any time the declared topic changes mid-session so the
// dialog stays consistent on its NEXT submit.
export const AI_DIALOG_CONTEXT = 'ai-dialog:context'

// Dialog → main: the user (via the AI agent) asked to change the
// declared study topic. Main updates `useSessionStore.declaredStudyTopic`
// and emits a broadcast `topic_change` audit event.
export const AI_DIALOG_TOPIC_CHANGE = 'ai-dialog:topic-change'

// Dialog → main: the user (via the AI agent) asked for a break. The
// rule layer in features/session/break.ts is the arbiter; the dialog
// waits for the matching response below.
export const AI_DIALOG_BREAK_REQUEST = 'ai-dialog:break-request'

// Main → dialog: verdict from the rule layer. The `nonce` field is the
// load-bearing correlation: a stale verdict from a previously-open
// dialog can land here and the dialog drops it because the resolver
// for that nonce is gone.
export const AI_DIALOG_BREAK_RESPONSE = 'ai-dialog:break-response'

export type AiDialogContextPayload = {
  declaredTopic: string
  modelId: string
  recentAuditKinds: ReadonlyArray<string>
}

export type AiDialogTopicChangePayload = {
  new_topic: string
}

export type AiDialogBreakRequestPayload = {
  nonce: string
  requested_duration_sec: number
  ai_recommendation: 'approve' | 'deny'
  ai_reasoning: string
}

export type BreakResponsePayload = {
  nonce: string
  verdict: 'approved' | 'denied'
  reason: string
  // Only present on approve — the actual duration the rule layer
  // committed to (may be clamped from `requested_duration_sec`).
  duration_sec?: number
}
