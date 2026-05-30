// Maps a getUserMedia DOMException name to a stable copy bucket. Switching
// on `err.name` (not the raw `err.message`) keeps the surfaced text calm,
// specific, and localisable — the browser's own message ("Requested device
// not found") never reaches the UI. Pure and node-testable; the banner that
// consumes this owns the strings + rendering.

export type MediaErrorKind =
  | 'denied'
  | 'notFound'
  | 'inUse'
  | 'overconstrained'
  | 'generic'

export function mediaErrorKind(name: string | undefined): MediaErrorKind {
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'denied'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'notFound'
    case 'NotReadableError':
    case 'TrackStartError':
      return 'inUse'
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'overconstrained'
    default:
      return 'generic'
  }
}
