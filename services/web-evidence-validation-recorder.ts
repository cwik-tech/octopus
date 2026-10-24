import {
  buildWebEvidenceValidationPayload,
  WEB_EVIDENCE_VALIDATION_PAYLOAD_SCHEMA_VERSION,
  WEB_EVIDENCE_VALIDATION_RECORDED_EVENT_TYPE,
  WEB_EVIDENCE_VALIDATION_STREAM_KIND,
  webEvidenceValidationEventId,
  type WebEvidenceValidationInput,
} from '../domains/browser/web-evidence-validation-journal.js'
import type { CapabilityAssignmentScope } from '../contracts/capability-dispatch.js'
import type { ExecutionJournal } from '../core/execution-journal.js'
import { appendJournalStreamEvent } from '../core/journal-stream-append.js'
import type { WorkspaceExecutionJournalRegistry } from './workspace-execution-journal-registry.js'

/**
 * Puts one sanitized `web.evidence.validation` event onto the assignment's
 * canonical journal. Thin by design, on the `agent.turn` precedent: the
 * domain owns the payload, the registry owns the journal handle and its lock,
 * and this owns only the ordering between them.
 */

export interface WebEvidenceValidationRecorder {
  recordValidation(
    input: WebEvidenceValidationInput & { readonly turnId: string },
  ): Promise<void>
  /** Give the journal back; idempotent and non-terminal. */
  release(): Promise<void>
}

/** Bounds journal resolution for one validation record. */
const WEB_EVIDENCE_RECORDER_RESOLVE_BUDGET_MS = 30_000

/**
 * Resolve the recorder for one validated turn.
 *
 * `undefined` means this workspace records no validation telemetry at all —
 * there is no registry, or the assignment is unenrolled under a mode that
 * forbids new enrollment. A registry that *throws* propagates: shadow and
 * enforce modes exist to produce this evidence, and silently losing it would
 * read as a cohort with zero rejections.
 */
export async function resolveWebEvidenceValidationRecorder(input: {
  readonly registry?: WorkspaceExecutionJournalRegistry | undefined
  readonly scope: CapabilityAssignmentScope
  readonly agentPath: string
  readonly requestId: string
  readonly processIdentity: string
  readonly signal?: AbortSignal | undefined
}): Promise<WebEvidenceValidationRecorder | undefined> {
  const { registry } = input
  if (!registry) return undefined
  const lease = await registry.acquireJournalHandle({
    context: {
      contractVersion: 1,
      requestId: input.requestId,
      sessionId: input.scope.sessionId,
      runId: input.scope.runId,
      assignmentId: input.scope.assignmentId,
      agentPath: input.agentPath,
      authority: {
        kind: 'runtime-assignment',
        processIdentity: input.processIdentity,
      },
    },
    signal: input.signal ?? new AbortController().signal,
    deadlineMs: Date.now() + WEB_EVIDENCE_RECORDER_RESOLVE_BUDGET_MS,
  })
  return lease
    ? createJournalBackedWebEvidenceValidationRecorder(
        lease.journal,
        input.scope.assignmentId,
        () => lease.release(),
      )
    : undefined
}

/**
 * `releaseHandle` is optional so a caller that already owns the journal's
 * lifecycle can record without borrowing anything to give back.
 */
export function createJournalBackedWebEvidenceValidationRecorder(
  journal: ExecutionJournal,
  assignmentId: string,
  releaseHandle?: () => Promise<void>,
): WebEvidenceValidationRecorder {
  return {
    async recordValidation(record) {
      const stream = await journal.scanStream(
        WEB_EVIDENCE_VALIDATION_STREAM_KIND,
        assignmentId,
      )
      await appendJournalStreamEvent(journal, {
        eventId: webEvidenceValidationEventId(assignmentId, record.turnId),
        streamKind: WEB_EVIDENCE_VALIDATION_STREAM_KIND,
        streamId: assignmentId,
        expectedStreamRevision: stream.events.length,
        type: WEB_EVIDENCE_VALIDATION_RECORDED_EVENT_TYPE,
        payloadSchemaVersion: WEB_EVIDENCE_VALIDATION_PAYLOAD_SCHEMA_VERSION,
        payload: buildWebEvidenceValidationPayload(record),
        correlationId: record.turnId,
      })
    },
    async release() {
      await releaseHandle?.()
    },
  }
}
