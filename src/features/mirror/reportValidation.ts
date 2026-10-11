import type { ResolvedReportData } from '@/features/session/reportSerialize'

export type MirrorReport = ResolvedReportData & { mirrorSessionId?: string }

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length <= max
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
const nullableNumber = (v: unknown) => v === null || number(v)
const timestamp = (v: unknown) =>
  number(v) && Math.abs(v as number) <= 8_640_000_000_000_000

export function readMirrorReport(value: unknown): MirrorReport | null {
  if (
    !record(value) ||
    !record(value.session) ||
    !Array.isArray(value.auditEvents) ||
    value.auditEvents.length > 100_000 ||
    !record(value.nameByEdPubkey) ||
    !(
      value.mirrorSessionId === undefined || text(value.mirrorSessionId, 128)
    ) ||
    !(value.myEdPubkeyHex === null || text(value.myEdPubkeyHex, 64))
  )
    return null
  const s = value.session
  if (
    !text(s.id, 128) ||
    ![
      'started_at',
      'ended_at',
      'total_minutes',
      'score',
      'focused_pct',
      'generated_at',
      'confident_samples',
      'skipped_samples',
      'ai_enabled',
    ].every((key) => nullableNumber(s[key])) ||
    !timestamp(s.started_at) ||
    !(s.ended_at === null || timestamp(s.ended_at)) ||
    !(s.generated_at === null || timestamp(s.generated_at)) ||
    !(s.declared_topic === null || text(s.declared_topic, 500)) ||
    !(s.peer_pubkeys === null || text(s.peer_pubkeys, 8192)) ||
    !(s.local_ed_pubkey == null || text(s.local_ed_pubkey, 64)) ||
    !(s.local_display_name == null || text(s.local_display_name, 500)) ||
    !(s.total_duration_ms == null || number(s.total_duration_ms)) ||
    !(s.peer_presence_ms == null || text(s.peer_presence_ms, 65_536)) ||
    Object.keys(value.nameByEdPubkey).length > 256 ||
    Object.entries(value.nameByEdPubkey).some(
      ([key, name]) => !text(key, 64) || !text(name, 500)
    )
  )
    return null
  if (
    value.auditEvents.some(
      (row) =>
        !record(row) ||
        !text(row.session_id, 128) ||
        !timestamp(row.ts) ||
        !text(row.who, 64) ||
        !text(row.kind, 128) ||
        !text(row.detail, 65_536) ||
        !text(row.sig, 256)
    )
  )
    return null
  const timeline = value.timeline
  if (
    timeline != null &&
    (!record(timeline) ||
      !text(timeline.session_id, 128) ||
      !timestamp(timeline.generated_at) ||
      !(timeline.model_id === null || text(timeline.model_id, 256)) ||
      !text(timeline.source, 128) ||
      !text(timeline.entries, 1024 * 1024) ||
      !number(timeline.truncated))
  )
    return null
  return value as unknown as MirrorReport
}
