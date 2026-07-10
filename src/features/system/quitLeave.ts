// #47 A1 — a confirmed quit mid-session must run the session leave handler
// (audit flush → sessions upsert → markStudied, see buildLeaveHandler in
// features/session/lifecycle.ts) before `app_quit`, or the whole session is
// silently lost: no sessions row, no report, no stats credit. Bounded by a
// timeout so a hung room.leave() / IPC call can never trap the user in an
// app they just asked to quit — persistence is best-effort, quitting is not.

export const QUIT_LEAVE_TIMEOUT_MS = 5_000

export async function leaveBeforeQuit(
  leave: (() => Promise<void>) | null,
  timeoutMs: number = QUIT_LEAVE_TIMEOUT_MS
): Promise<void> {
  if (!leave) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      leave().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
