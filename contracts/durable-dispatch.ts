import type { CanonicalJsonObject } from './canonical-json.js'
import type {
  CapabilityAssignmentScope,
  CapabilityApprovalOutcome,
  CapabilityDispatchResult,
  CapabilityInvocationIdentity,
} from './capability-dispatch.js'
import type { CapabilityEffect } from './capability-effect.js'

/**
 * Durable capability-dispatch recovery contract (Phase 8 ADR §6-7). The
 * canonical execution journal is the authority for these facts; this
 * contract defines the dispatch state machine, adapter recovery policies,
 * and the port the dispatcher uses for durable barriers.
 */

/**
 * What an adapter promises about repeating its effect after a crash.
 *
 * `idempotent_with_key` was removed (A-13). It promised retry against an
 * external idempotency key, and no key ever reached a dispatcher, so it always
 * failed closed — a declared policy the runtime could not honour reads as a
 * guarantee where there was none. Journals written while it existed still say
 * it; that text narrows to `unknown`, which is what it always behaved as.
 */
export type CapabilityRecoveryPolicy =
  | 'read_only_retryable'
  | 'reconcilable'
  | 'non_retryable'
  | 'unknown'

export type DurableDispatchState =
  | 'requested'
  | 'prepared'
  | 'started'
  | 'committed'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'failed'
  | 'indeterminate'

/** One ordered durable fact for a dispatch stream, as seen by the reducer. */
export interface DurableDispatchStreamEvent {
  readonly type:
    | 'requested'
    | 'prepared'
    | 'started'
    | 'committed'
    | 'accepted'
    | 'rejected'
    | 'cancelled'
    | 'failed'
    | 'indeterminate'
    | 'resolved_not_committed'
    | 'resolved_committed'
    | 'resolved_abandoned'
  readonly attemptId: string
  /** Only meaningful on `failed`: adapter proof that no effect committed. */
  readonly effectCommitted?: boolean
}

/**
 * What an operator may assert about a dispatch whose outcome the runtime
 * cannot establish (ADR §7 option 3).
 *
 * Exactly three, because these are the only assertions that decide what the
 * *next* dispatch on the same identity must do. Anything else is a description
 * of the state, not a resolution of it.
 */
export type OperatorResolutionDecision =
  | 'not_committed'
  | 'committed'
  | 'abandon'

/**
 * Who the journal may honestly say recorded a resolution.
 *
 * Not a user. The loopback API authenticates possession of a per-launch shared
 * secret in one of two scopes and nothing more — there is no user id, session
 * principal, or client certificate anywhere in the server, and `SECURITY.md`
 * states outright that the token is not user authentication. So the strongest
 * truthful principal is the credential scope, the server-side tenant, and the
 * process instance: the journal records *that the local operator surface* did
 * this, never *who* did.
 *
 * Every field is derived server-side. A field in a request body that claims an
 * identity is worse than a constant, because it reads as provenance while
 * carrying none.
 */
export interface OperatorResolutionPrincipal {
  readonly credentialScope: string
  readonly tenantId: string
  readonly processInstanceId: string
}

/**
 * Exact capability results are stored beside an assignment's journal, never
 * inside it (`docs/adr/2026-08-26-Execution-Journal-Content-Separation.md`).
 * The journal records only what is needed to find those bytes again and prove
 * they are the ones the dispatch accepted.
 */
export const CAPABILITY_RESULT_MEDIA_TYPE = 'application/json'

/**
 * The retained-result payload version that names external content instead of
 * carrying it. Version 1 is the two content-bearing forms this replaces: an
 * inline `resultValue`, and a receipt naming a file below the journal
 * directory. Both stay readable; neither is written again.
 */
export const CAPABILITY_RESULT_CONTENT_SCHEMA_VERSION = 2

/** What the journal records about one retained result, and nothing more. */
export interface CapabilityResultContentReceipt {
  /** Content-addressed: the lowercase SHA-256 hex of the canonical bytes. */
  readonly contentId: string
  readonly contentSha256: string
  readonly byteLength: number
  readonly mediaType: typeof CAPABILITY_RESULT_MEDIA_TYPE
  readonly resultSchemaVersion: typeof CAPABILITY_RESULT_CONTENT_SCHEMA_VERSION
}

/**
 * A store write. `conflict` is the tamper case rather than a race: content is
 * addressed by its own digest, so the same identity holding different bytes
 * means what is on disk is not what that identity names.
 */
export type CapabilityResultContentWrite =
  | {
      readonly kind: 'stored'
      readonly receipt: CapabilityResultContentReceipt
    }
  | { readonly kind: 'conflict'; readonly contentId: string }
  | {
      readonly kind: 'too_large'
      readonly byteLength: number
      readonly maxByteLength: number
    }
  /** A fault, reported as an error code because a message can carry a path. */
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * A store read. Every way it can fail to produce the exact accepted bytes is
 * its own arm: a caller that cannot tell "never written" from "changed under
 * us" would replay one as the other.
 */
export type CapabilityResultContentRead =
  | { readonly kind: 'content'; readonly canonical: string }
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'mismatched'
      readonly reason: 'digest' | 'byte_length' | 'receipt'
    }
  /** Present, intact, and not the JSON object a retained result must be. */
  | { readonly kind: 'corrupt' }
  | {
      readonly kind: 'unsafe'
      readonly reason: 'symlink' | 'not_a_file' | 'escapes_store' | 'permissions'
    }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * Where exact capability results live: an assignment-owned content store,
 * outside the execution journal and outside its directory.
 *
 * Injected rather than reached for, so the journal writer holds no opinion
 * about where an owner keeps its content, and a test can drive every failure
 * arm without a filesystem that produces it on demand.
 */
export interface CapabilityResultContentStore {
  /** Idempotent for identical bytes; a conflict is never overwritten. */
  write(canonical: string): Promise<CapabilityResultContentWrite>
  read(
    receipt: CapabilityResultContentReceipt,
  ): Promise<CapabilityResultContentRead>
}

/**
 * How one result-bearing journal record retains its result, as an operator
 * report names it. Three of the four are payload shapes on disk; `unretained`
 * is a value the canonical form rejected, which is retained as nothing at all.
 */
export type CapabilityResultRetentionForm =
  | 'content_reference_v2'
  | 'legacy_inline_v1'
  | 'legacy_journal_receipt_v1'
  | 'unretained'

/**
 * What an operator is told about the results an assignment's journal retains.
 *
 * Counts and closed unions only. The point of the summary is to say whether a
 * journal still holds capability result content, so reproducing any of it here
 * would defeat the thing it reports on.
 */
export interface CapabilityResultRetentionSummary {
  /**
   * Result-bearing records, not dispatches. One operator-resolved dispatch
   * contributes both its decision and its acceptance, and a decision whose
   * acceptance never landed contributes only the first — which is exactly the
   * stranded legacy content this summary must not miss.
   */
  readonly counts: Readonly<Record<CapabilityResultRetentionForm, number>>
  /**
   * True when this journal still holds result content in a payload v1 form.
   * Historical journals are never rewritten — that would invalidate their hash
   * chains — so they are marked instead, and deleting the owning session is
   * what removes them.
   */
  readonly legacyContentBearing: boolean
  /** The retention reason code, present only when the flag above is true. */
  readonly legacyReason?: 'capability_result_v1'
  /**
   * Who owns the exact bytes of the v2 results, when there are any. A kind,
   * never a path: an operator locates content through a route, not through a
   * filesystem path a report handed them.
   */
  readonly contentOwner?: 'assignment-capability-results'
}

/**
 * The result an operator supplies with a `committed` resolution, in the two
 * shapes a caller can express it: the value itself, or a receipt naming
 * content this assignment already holds — either the content store or, for a
 * dispatch older than Phase 3, a file below the journal. Both are validated
 * exactly as an adapter-supplied result is, so an operator cannot smuggle an
 * arbitrary value into the canonical record, and whichever arrives is recorded
 * as payload v2 rather than put back into the journal.
 */
export type OperatorSuppliedResult =
  | { readonly kind: 'inline'; readonly value: unknown }
  | { readonly kind: 'receipt'; readonly receipt: unknown }

export type OperatorResolutionOutcome =
  | { readonly kind: 'recorded'; readonly state: DurableDispatchState }
  | { readonly kind: 'not_found' }
  /** The dispatch is not in a state an operator resolves. */
  | { readonly kind: 'not_resolvable'; readonly state: DurableDispatchState }
  | { readonly kind: 'invalid_result'; readonly reason: string }
  /**
   * The stream kept moving underneath this decision. Distinct from
   * `not_resolvable`, which is a settled answer about a state that was read:
   * this one means no state could be read for long enough to decide against,
   * and the same request may well succeed on the next try.
   */
  | { readonly kind: 'conflict' }

/**
 * The operator write path onto one assignment's dispatch streams.
 *
 * Separate from `CapabilityDurableDispatchPort` because the dispatcher never
 * calls it: a port is defined by its consumer, and this consumer is the
 * operator surface rather than the dispatch path.
 */
export interface CapabilityDispatchResolutionPort {
  /**
   * Safe to call again after a failure. A decision that is already recorded is
   * finished rather than restated, so a retry completes whatever durable step
   * was lost and leaves the recorded principal, reason and time as the attempt
   * that made the decision wrote them.
   *
   * A `committed` decision records the result it attests to alongside that
   * provenance, and a retry finishes the acceptance from what was recorded.
   * `result` is therefore optional on a retry, and a *different* one is
   * refused rather than substituted: the operator named in the journal must
   * not end up attesting to evidence they never supplied.
   */
  recordOperatorResolution(input: {
    readonly dispatchId: string
    readonly scope: CapabilityAssignmentScope
    readonly decision: OperatorResolutionDecision
    readonly principal: OperatorResolutionPrincipal
    readonly reason: string
    readonly recordedAtMs: number
    /** Required by `committed`, meaningless to the other two. */
    readonly result?: OperatorSuppliedResult
    readonly signal?: AbortSignal
  }): Promise<OperatorResolutionOutcome>
}

export type DurableDispatchReduction =
  | { readonly kind: 'valid'; readonly state: DurableDispatchState }
  | { readonly kind: 'invalid'; readonly reason: string }

export type DurableRecoveryDecision =
  | { readonly kind: 'retriable' }
  | { readonly kind: 'retained' }
  | { readonly kind: 'reconcile' }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'terminal' }

export type DurableDispatchRecovery =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'retriable' }
  | {
      readonly kind: 'retained'
      readonly result: CapabilityDispatchResult
    }
  | {
      readonly kind: 'terminal'
      readonly result: CapabilityDispatchResult
    }
  | {
      readonly kind: 'reconcile'
      readonly state: DurableDispatchState
    }
  | {
      readonly kind: 'blocked'
      readonly state: DurableDispatchState
    }
  | {
      /** Same dispatch identity persisted with a different argument digest. */
      readonly kind: 'conflict'
    }

export type DurableInvocationIdentityBinding =
  | {
      readonly kind: 'bound'
      readonly invocation: CapabilityInvocationIdentity
    }
  | {
      readonly kind: 'conflict'
      /** The persisted identity whose argument binding was violated. */
      readonly invocation: CapabilityInvocationIdentity
    }

/**
 * Safe read-path view of one dispatch (Phase 8 ADR §16). Recovery and
 * inspection both expose this validated outcome from the canonical journal;
 * neither reads a legacy authoritative log.
 */
export type DurableDispatchInspection =
  | {
      readonly kind: 'outcome'
      readonly state: DurableDispatchState
      readonly result?: CapabilityDispatchResult
      readonly lastAppliedSequence: number
    }
  | {
      readonly kind: 'unsupported_version'
      readonly lastAppliedSequence: number
    }
  | { readonly kind: 'not_found' }

export type DurableProjectionLagStatus =
  | 'absent'
  | 'current'
  | 'lagging'
  | 'rebuild-required'

/**
 * An operation teardown may perform on one live durable attempt (ADR §7).
 *
 * Deliberately opaque. The dispatch id, the attempt id and the durable
 * session stay captured inside the core closure that produced this, because a
 * shell that had to name them would be rederiving identity the core already
 * owns — and would be able to finalize an attempt other than the one it meant.
 */
export interface DurableTeardownFinalizer {
  /**
   * Record an explicit `indeterminate` for this exact attempt, carrying the
   * decision teardown made.
   */
  finalizeIndeterminate(code: string): Promise<void>
}

/**
 * Where the core hands live attempts to whoever owns their teardown.
 *
 * The registration carries the assignment scope because that is the only
 * identity the shell needs — enough to keep a per-assignment set, and nothing
 * that would let it reach into a dispatch.
 */
export interface DurableTeardownRegistry {
  register(input: {
    readonly scope: CapabilityAssignmentScope
    readonly finalizer: DurableTeardownFinalizer
  }): () => void
}

export interface CapabilityDurableDispatchPort {
  /**
   * Whether this port derives the legacy capability-evidence view from its
   * canonical appends (ADR §9). Only then may the dispatcher stop writing
   * that view directly; otherwise suppressing the legacy writer would drop
   * the evidence rather than relocate it.
   */
  readonly derivesCapabilityEvidence: boolean
  /**
   * Bind one stable provider-turn operation to the first invocation identity
   * that reached the journal. A restarted provider may mint a new tool-call
   * id; the dispatcher must restore this persisted identity before deriving
   * its dispatch id. Reusing the operation with changed arguments conflicts.
   */
  bindInvocationIdentity(input: {
    readonly operationId: string
    readonly invocation: CapabilityInvocationIdentity
    readonly argumentDigest: string
    readonly signal?: AbortSignal
  }): Promise<DurableInvocationIdentityBinding>
  recover(input: {
    readonly dispatchId: string
    readonly argumentDigest: string
  }): Promise<DurableDispatchRecovery>
  inspectOutcome(input: {
    readonly dispatchId: string
  }): Promise<DurableDispatchInspection>
  projectionStatus(
    projectionId: string,
  ): Promise<DurableProjectionLagStatus>
  /**
   * Bring the derived views forward.
   *
   * Called when the assignment is released or the registry closes, while the
   * journal is still open — catch-up reads from it, so once it closes the
   * chance is gone until something reopens the assignment, which for a
   * terminal assignment is never. It does not close the port; barring further
   * use is the registry's job.
   *
   * Required rather than optional, because this is the lifecycle contract: an
   * optional method lets a caller skip the guarantee with nothing saying so.
   * A port that derives nothing implements it as a no-op.
   *
   * Never rejects. Teardown must not fail over a derived view, and the
   * watermark already records whatever is still missing.
   */
  flushProjections(): Promise<void>
  recordRequested(input: {
    readonly dispatchId: string
    readonly attemptId: string
    /** Canonical legacy-evidence identity sealed for projection (ADR §9). */
    readonly identity?: CanonicalJsonObject
    readonly signal?: AbortSignal
  }): Promise<void>
  recordApprovalRequested(input: {
    readonly dispatchId: string
    readonly attemptId: string
    readonly interactionId: string
    readonly identity?: CanonicalJsonObject
    readonly signal?: AbortSignal
  }): Promise<void>
  recordApprovalResolved(input: {
    readonly dispatchId: string
    readonly attemptId: string
    readonly interactionId: string
    readonly approvalOutcome: CapabilityApprovalOutcome
    readonly identity?: CanonicalJsonObject
    readonly signal?: AbortSignal
  }): Promise<void>
  recordPrepared(input: {
    readonly dispatchId: string
    readonly attemptId: string
    readonly argumentDigest: string
    readonly capabilityId: string
    readonly effect: CapabilityEffect
    readonly recoveryPolicy: CapabilityRecoveryPolicy
    readonly identity?: CanonicalJsonObject
    readonly signal?: AbortSignal
  }): Promise<void>
  recordStarted(input: {
    readonly dispatchId: string
    readonly attemptId: string
    readonly identity?: CanonicalJsonObject
    readonly signal?: AbortSignal
  }): Promise<void>
  recordCommitted(input: {
    readonly dispatchId: string
    readonly attemptId: string
    readonly receipt?: CanonicalJsonObject
    readonly identity?: CanonicalJsonObject
    readonly signal?: AbortSignal
  }): Promise<void>
  recordAccepted(input: {
    readonly dispatchId: string
    readonly attemptId: string
    readonly result: CapabilityDispatchResult
    readonly identity?: CanonicalJsonObject
    readonly signal?: AbortSignal
  }): Promise<void>
  recordIndeterminate(input: {
    readonly dispatchId: string
    readonly attemptId: string
    readonly code: string
    readonly identity?: CanonicalJsonObject
    readonly signal?: AbortSignal
  }): Promise<void>
  recordTerminal(input: {
    readonly dispatchId: string
    readonly attemptId: string
    readonly result: CapabilityDispatchResult
    readonly identity?: CanonicalJsonObject
    readonly signal?: AbortSignal
  }): Promise<void>
}
