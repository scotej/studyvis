import {
  readObservations,
  windowObservations,
} from '@/features/session/sessionJournal'
import { observationTimelineEntries } from '@/features/session/sessionTimeline'
import { writtenTimelineEntries } from '@/features/session/reportSerialize'
import { useSettingsStore } from '@/stores/settingsStore'
import { storedWriteUpIsStale } from '@/lib/db/sessionTimeline'
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
  const startedAt = performance.now()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      active = false
      resolve()
    }, 3000)
  })
  const handoff = async () => {
    try {
      let report = await loadReportData(sessionId)
      if (!active || current !== registration) return
      if (
        storedWriteUpIsStale(report.timeline ?? null, report.session.ended_at)
      )
        report = { ...report, timeline: null }
      const settings = useSettingsStore.getState().values
      // #410: the companion disconnects after this bounded handoff. Give it
      // the journal's deterministic account without starting or waiting for
      // model narration; the source label keeps that distinction explicit.
      if (
        writtenTimelineEntries(report.timeline).length === 0 &&
        settings.aiFeaturesEnabled &&
        settings.sessionTimelineEnabled
      ) {
        // #410 — optional enrichment must leave time for the report itself
        // and its report_saved acknowledgment within the same Leave grace.
        const journalBudget = Math.min(
          500,
          Math.max(0, 2000 - (performance.now() - startedAt))
        )
        let journalTimeout: ReturnType<typeof setTimeout> | undefined
        try {
          const journal =
            journalBudget > 0
              ? await Promise.race([
                  readObservations(sessionId),
                  new Promise<null>((resolve) => {
                    journalTimeout = setTimeout(
                      () => resolve(null),
                      journalBudget
                    )
                  }),
                ])
              : null
          if (!active || current !== registration) return
          if (journal) {
            const entries = observationTimelineEntries(
              windowObservations(
                journal.observations,
                report.session.started_at
              )
            )
            const incomplete = journal.truncated || journal.unreadableLines > 0
            if (entries.length > 0)
              report = {
                ...report,
                timeline: {
                  session_id: sessionId,
                  generated_at: Date.now(),
                  covered_until: incomplete
                    ? null
                    : (report.session.ended_at ?? Date.now()),
                  model_id: null,
                  source: 'observations',
                  entries: JSON.stringify(entries),
                  truncated: incomplete ? 1 : 0,
                },
              }
          }
        } catch {
          // Coverage-aware report copy still describes unavailable accounts
          // truthfully when a journal cannot be read within this handoff.
        } finally {
          if (journalTimeout !== undefined) clearTimeout(journalTimeout)
        }
      }
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
