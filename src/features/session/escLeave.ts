// Two-tap Esc-to-leave. A single Esc is a footgun during an active session:
// it broadcasts `left` and tears down the room irreversibly. The first Esc
// arms (shows a hint); a second Esc inside the window actually leaves. If the
// window lapses, the next Esc re-arms.

export const ESC_LEAVE_WINDOW_MS = 3000

export function shouldLeaveOnEsc(
  lastArmedAt: number | null,
  now: number,
  windowMs: number
): boolean {
  if (lastArmedAt === null) return false
  return now - lastArmedAt <= windowMs
}
