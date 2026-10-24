import type { ExecutionJournalScopeIdentity } from '../../contracts/execution-journal.js'

/**
 * The one identity the projection-recovery worker and its parent both open.
 *
 * Shared as source rather than passed as an argument, so neither side has to
 * parse an unchecked JSON blob back into a typed shape it then trusts.
 */
export const PROJECTION_RECOVERY_IDENTITY = {
  scopeKind: 'assignment',
  scopeId: 'assignment-projection-recovery',
  tenantId: 'tenant-test',
  sessionId: 'session-projection-recovery',
  runId: 'run-projection-recovery',
  assignmentId: 'assignment-projection-recovery',
} satisfies ExecutionJournalScopeIdentity
// `satisfies` rather than an annotation: the scope fields are optional on the
// interface, so annotating would widen them to `string | undefined` and force
// every reader to invent a fallback for a value that is right here.
