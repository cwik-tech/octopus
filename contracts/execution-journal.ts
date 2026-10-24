import type { CanonicalJsonObject } from './canonical-json.js'

/**
 * Canonical durable execution-journal contract (Phase 8 ADR). The journal is
 * the authoritative append-only history of execution facts for one execution
 * scope. Domain modules own their payload schemas; this contract owns only
 * the envelope, identity, and append/scan outcome shapes.
 */

export const EXECUTION_JOURNAL_SCHEMA_VERSION = 1

export type ExecutionJournalScopeKind = 'assignment' | 'batch' | 'conversation'

/**
 * What one conversation activity journal records.
 *
 * A conversation is a logical owner; the physical journal belongs to one
 * bounded activity below it, so a long conversation never reopens all of its
 * prior lifecycle. Later phases widen this union as their first writer lands —
 * publications, planning attempts, and builds each become an activity kind.
 * Widening is additive: older bytes keep parsing.
 */
export type ExecutionJournalActivityKind = 'turn'

export interface ExecutionJournalScopeIdentity {
  readonly scopeKind: ExecutionJournalScopeKind
  readonly scopeId: string
  readonly tenantId: string
  readonly sessionId?: string
  readonly runId?: string
  readonly assignmentId?: string
  /** Present only on a conversation scope: the logical owner of the activity. */
  readonly conversationId?: string
  /** Absent on historical Run-session journals. */
  readonly ownerKind?: 'run-session' | 'create-resource-architect'
  /** Present only on a conversation scope: what the activity records. */
  readonly activityKind?: ExecutionJournalActivityKind
}

export interface ExecutionJournalEvent<TPayload extends CanonicalJsonObject = CanonicalJsonObject> {
  readonly schemaVersion: 1
  readonly eventId: string
  readonly sequence: number
  readonly recordedAt: string
  readonly scopeKind: ExecutionJournalScopeKind
  readonly scopeId: string
  readonly tenantId: string
  readonly sessionId?: string
  readonly runId?: string
  readonly assignmentId?: string
  readonly conversationId?: string
  /** Absent on historical Run-session journals. */
  readonly ownerKind?: 'run-session' | 'create-resource-architect'
  readonly activityKind?: ExecutionJournalActivityKind
  readonly streamKind: string
  readonly streamId: string
  readonly streamRevision: number
  readonly type: string
  readonly payloadSchemaVersion: number
  readonly appendRequestDigest: string
  readonly correlationId: string
  readonly causationEventId?: string
  readonly sourceSequenceId?: string
  readonly sourceOrdinal?: number
  readonly executionAttemptId?: string
  readonly previousEventHash: string
  readonly eventHash: string
  readonly payload: TPayload
}

export interface ExecutionJournalManifest {
  readonly schemaVersion: 1
  readonly scopeKind: ExecutionJournalScopeKind
  readonly scopeId: string
  readonly tenantId: string
  readonly sessionId?: string
  readonly runId?: string
  readonly assignmentId?: string
  readonly conversationId?: string
  /** Absent on historical Run-session journals. */
  readonly ownerKind?: 'run-session' | 'create-resource-architect'
  readonly activityKind?: ExecutionJournalActivityKind
  readonly createdAt: string
  readonly journalRelativePath: string
  readonly initialSequence: 0
  readonly initialPreviousEventHash: string
  readonly createdBy: {
    readonly implementation: string
    readonly version: number
  }
}

/**
 * Caller-owned append fields. The writer canonicalizes these into
 * `appendRequestDigest` before it adds sequence, recording time, and hash
 * fields. `expectedStreamRevision` is the caller's optimistic view of how
 * many events the stream already contains (0 for the first event).
 */
export interface ExecutionJournalAppendInput {
  readonly eventId: string
  readonly streamKind: string
  readonly streamId: string
  readonly expectedStreamRevision: number
  readonly type: string
  readonly payloadSchemaVersion: number
  readonly payload: CanonicalJsonObject
  readonly correlationId: string
  readonly causationEventId?: string
  readonly sourceSequenceId?: string
  readonly sourceOrdinal?: number
  readonly executionAttemptId?: string
  /** May stop lock acquisition or validation; never an in-flight write. */
  readonly signal?: AbortSignal
}

export type ExecutionJournalAppendOutcome =
  | {
      readonly kind: 'appended'
      readonly event: ExecutionJournalEvent
    }
  | {
      readonly kind: 'already-accepted'
      readonly event: ExecutionJournalEvent
    }
  | {
      readonly kind: 'revision-conflict'
      readonly expectedRevision: number
      readonly actualRevision: number
    }
  | {
      readonly kind: 'event-identity-conflict'
      readonly eventId: string
    }

export interface ExecutionJournalScanSummary {
  readonly eventCount: number
  readonly lastSequence: number
  readonly events: readonly ExecutionJournalEvent[]
  readonly truncatedFragmentBytes: number
}

export type ExecutionJournalFailureCode =
  | 'append_invalid'
  | 'closed'
  | 'corrupt'
  /** The same event identity was reused for different content. */
  | 'event_identity_conflict'
  /**
   * A hard per-scope bound was reached. Not damage and not a conflict: the
   * journal is intact and the operation is refused because completing it would
   * take the scope past a size its contract fixes.
   */
  | 'limit_exceeded'
  | 'lock_timeout'
  /** The manifest's identity changed under a live journal. Damage. */
  | 'manifest_conflict'
  /**
   * The manifest could not be read at all. Distinct from `manifest_conflict`:
   * a manifest that is momentarily missing or unreadable is an environment
   * fault, not evidence that the journal's identity changed.
   */
  | 'manifest_unavailable'
  | 'path_unsafe'
  | 'permissions_unsafe'
  /**
   * A handle met a recoverable fault and was retired. The assignment's durable
   * history is intact; a fresh handle re-derives its index from disk.
   */
  | 'retired'
  /** Another writer advanced the stream; a concurrency conflict, not damage. */
  | 'revision_conflict'
  | 'scope_invalid'
  | 'unsupported_version'
  /** A write stopped before its record ended. The torn tail is truncatable. */
  | 'write_incomplete'

export class ExecutionJournalError extends Error {
  readonly code: ExecutionJournalFailureCode

  constructor(
    code: ExecutionJournalFailureCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options)
    this.code = code
    this.name = 'ExecutionJournalError'
  }
}
