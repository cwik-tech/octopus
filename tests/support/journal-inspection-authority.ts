/**
 * An authority that admits everything, for tests about something else.
 *
 * Inspection needs a policy to be constructed at all, which is the point of
 * the port. Tests that are about bounds, symlinks or report shape should not
 * restate a policy to get past it, and should not silently exercise the
 * production one either — what production admits is decided in
 * `conversation-inspection-authorization.test.ts` against the real constant.
 */
import type { ExecutionJournalInspectionAuthority } from '../../services/execution-journal-inspection.js'

export const ADMITS_EVERY_INSPECTION: ExecutionJournalInspectionAuthority = {
  authorize: async () => true,
}
