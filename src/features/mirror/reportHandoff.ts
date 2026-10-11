import { loadReportData } from '@/features/session/reportLoader'
import { logger } from '@/lib/log'
import type { MirrorHost } from './runtime'
import type { MirrorNotification } from './wire'
import type { ResolvedReportData } from '@/features/session/reportSerialize'
import type { MirrorReport } from './reportValidation'

let current: {
  sessionId: string
  publicSessionId: string
  host: MirrorHost
} | null = null

export function projectMirrorReport(
  report: ResolvedReportData,
  publicSessionId: string
): MirrorReport {
  const participants = new Set(report.auditEvents.map((row) => row.who))
  if (report.myEdPubkeyHex) participants.add(report.myEdPubkeyHex)
  try {
    const peers: unknown = JSON.parse(report.session.peer_pubkeys ?? '[]')
    if (Array.isArray(peers))
      for (const peer of peers)
        if (typeof peer === 'string') participants.add(peer)
  } catch {
    /* Legacy reports still resolve names from their audit rows. */
  }
  return {
    ...report,
    // Signed audit exports retain the original journal identifiers. The
    // browser lifecycle uses a separate opaque activation ID.
    mirrorSessionId: publicSessionId,
    nameByEdPubkey: Object.fromEntries(
      Object.entries(report.nameByEdPubkey).filter(([key]) =>
        participants.has(key)
      )
    ),
  }
}

export function notifyCurrentMirror(notification: MirrorNotification): void {
  current?.host.sendNotification(notification)
}

export function registerMirrorReportHandoff(
  sessionId: string,
  host: MirrorHost,
  publicSessionId: string
): () => void {
  const registration = { sessionId, publicSessionId, host }
  current = registration
  return () => {
    if (current === registration) current = null
  }
}

export async function finishMirrorReport(sessionId: string): Promise<void> {
  const registration = current
  if (!registration || registration.sessionId !== sessionId) return
  let active = true
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      active = false
      resolve()
    }, 3000)
  })
  const handoff = async () => {
    try {
      const report = await loadReportData(sessionId)
      if (!active || current !== registration) return
      await registration.host.finishReport(
        projectMirrorReport(report, registration.publicSessionId)
      )
    } catch {
      if (active && current === registration)
        logger.child('mirror').warn('report.unavailable')
    }
  }
  try {
    // A serialized database read shares the grace period with delivery.
    await Promise.race([handoff(), deadline])
  } finally {
    active = false
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
