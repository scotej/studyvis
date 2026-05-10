// All audit-log types and pure helpers live in `lib/audit-types.ts` so
// `stores/auditStore.ts` can import them without reaching into features.
// This barrel preserves existing `@/features/session/audit` import paths
// (SessionView, tests, etc.) without any consumer-side churn.

export * from '@/lib/audit-types'
