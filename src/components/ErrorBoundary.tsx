import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { strings } from '@/strings'

// PR-31 — the app had no error boundary anywhere, so any uncaught render throw
// (a recharts render on unexpected data, a malformed persisted row, a null
// deref in a settings sub-panel) propagated to the root and React unmounted the
// WHOLE tree, leaving a blank white window with no recovery — and taking the
// always-on P2P inbox/presence and any live session down with it. This catches
// a render fault, keeps the app shell mounted, and offers a retry that remounts
// the subtree so a single feature fault degrades gracefully instead of bricking
// the window. A class component is required: error boundaries have no hooks API.

type ErrorBoundaryProps = {
  children: ReactNode
  // Optional label for diagnostics logging so a per-surface boundary can say
  // which surface faulted.
  surface?: string
}

type ErrorBoundaryState = { hasError: boolean }

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Local console only — no telemetry (PLAN §3). The stack helps a friend
    // paste diagnostics from the dev console if they hit this.
    console.error(
      `[error-boundary${this.props.surface ? `:${this.props.surface}` : ''}]`,
      error,
      info.componentStack
    )
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false })
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="flex min-h-full flex-1 items-center justify-center p-8"
      >
        <div className="flex max-w-sm flex-col items-center gap-4 text-center">
          <span
            aria-hidden="true"
            className="flex size-12 items-center justify-center rounded-full bg-status-warning/15 text-status-warning"
          >
            <AlertTriangle className="size-6" />
          </span>
          <div className="flex flex-col gap-2">
            <h2 className="text-base font-medium text-text-primary">
              {strings.app.error.title}
            </h2>
            <p className="text-sm text-text-secondary">
              {strings.app.error.body}
            </p>
          </div>
          <Button size="sm" onClick={this.handleRetry}>
            <RotateCcw /> {strings.app.error.retry}
          </Button>
        </div>
      </div>
    )
  }
}
