import { createJournalBackedWorkflowRecorder } from '../workflows/workflow-journal.js'
import type { WorkflowJournalRecorder } from '../workflows/workflow-journal.js'
import type { WorkspaceExecutionJournalRegistry } from './workspace-execution-journal-registry.js'

/**
 * Store options for a workflow mutation performed outside the runner.
 *
 * Cancellation, terminal reconciliation during recovery, and human-input
 * submission are all authoritative workflow transitions, and all three used to
 * build `FileSystemWorkflowStateStore` with no recorder. That bumps
 * `workflow-state.json`'s revision while the canonical journal stays where it
 * was, so the projection leads the journal and a rebuild replays a state that
 * silently omits the mutation (ADR §9).
 *
 * `{}` — no recorder, snapshot-first authority unchanged — is returned in
 * exactly two cases:
 *
 * - the process has no registry at all; or
 * - the assignment has not enrolled *and* the configured mode does not permit
 *   new enrollment (`services/workspace-execution-journal-registry.ts:433`).
 *
 * It is **not** true that an unenrolled assignment always gets `{}`. Under
 * `authoritative`, resolving here opens and enrols an assignment that has none
 * — the same rule the runner and the dispatcher already follow, since the mode
 * governs enrollment of new assignments and enrollment is thereafter sticky
 * (ADR §16). An earlier version of this comment claimed the narrower contract;
 * it described neither the registry nor this helper.
 */
export async function resolveWorkflowJournalRecorder(input: {
  readonly registry?: WorkspaceExecutionJournalRegistry | undefined
  readonly task: {
    readonly sessionId: string
    readonly runId: string
    readonly assignmentId?: string | undefined
  }
  readonly requestId: string
  readonly processIdentity: string
  readonly signal?: AbortSignal
}): Promise<{ readonly journal?: WorkflowJournalRecorder }> {
  const { registry } = input
  if (!registry) return {}

  // A registry that throws means the authority is enrolled but unavailable,
  // which must not silently fall back to the legacy path (ADR §7), so the
  // failure propagates to the caller.
  const journal = await registry.resolveJournalHandle({
    context: {
      contractVersion: 1,
      requestId: input.requestId,
      sessionId: input.task.sessionId,
      runId: input.task.runId,
      assignmentId: input.task.assignmentId ?? input.task.runId,
      agentPath: 'workflows/runner',
      authority: {
        kind: 'runtime-assignment',
        processIdentity: input.processIdentity,
      },
    },
    signal: input.signal ?? new AbortController().signal,
    deadlineMs: Date.now() + WORKFLOW_RECORDER_RESOLVE_BUDGET_MS,
  })
  return journal ? { journal: createJournalBackedWorkflowRecorder(journal) } : {}
}

/** Bounds journal resolution for an out-of-runner workflow mutation. */
const WORKFLOW_RECORDER_RESOLVE_BUDGET_MS = 30_000
