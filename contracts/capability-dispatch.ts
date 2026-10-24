import type { CapabilityEffect } from './capability-effect.js'
import type { CanonicalJsonObject } from './canonical-json.js'
import type {
  CapabilityDurableDispatchPort,
  DurableTeardownRegistry,
  CapabilityRecoveryPolicy,
} from './durable-dispatch.js'

export type CapabilitySourceKind = 'builtin' | 'mcp' | 'pi-host' | 'engine'

export interface CapabilityAssignmentScope {
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
}

export type CapabilityScopeAuthority =
  | { readonly kind: 'mcp-lease'; readonly leaseId: string }
  | { readonly kind: 'runtime-assignment'; readonly processIdentity: string }
  | {
      readonly kind: 'parent-capability'
      readonly endpointId: string
      readonly processIdentity: string
    }

export interface CapabilityExecutionContext {
  readonly contractVersion: 1
  readonly requestId: string
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly taskId?: string
  readonly agentPath: string
  readonly authority: CapabilityScopeAuthority
  readonly workflowId?: string
  readonly workflowStepId?: string
  readonly agentId?: string
  readonly agentDisplayName?: string
  readonly activityScopeId?: string
  /** Provider tool-call order for the turn; see McpBrokerRequestContext. */
  readonly providerCallOrdinal?: number
}

export interface CapabilityInvocationIdentity {
  readonly capabilityId: string
  readonly source: {
    readonly kind: CapabilitySourceKind
    readonly id: string
    readonly version?: string
  }
  readonly toolCallId: string
}

export interface CapabilityInvocation extends CapabilityInvocationIdentity {
  readonly input: unknown
}

export type CapabilityAuthorizationPhase =
  | 'initial'
  | 'before-execute'
  | 'after-result'

export type CapabilityPolicyDecision =
  | { readonly kind: 'allow' }
  | {
      readonly kind: 'deny'
      readonly code: string
      readonly reason: string
      readonly detail?: unknown
    }
  | { readonly kind: 'require-approval'; readonly reason: string }

export interface CapabilityApprovalDescription {
  /** Stable source binding used by the existing exact approval store. */
  readonly serverId: string
  /** Capability-specific approval name; may be more specific than capabilityId. */
  readonly namespacedToolName: string
  readonly title: string
  readonly description: string
}

export interface CapabilityCompletionFence {
  release(): void | Promise<void>
}

export interface CapabilityAcceptedResult {
  readonly value: unknown
  readonly actualCostUsd?: number
}

export type CapabilityLifecycleProjection =
  | { readonly kind: 'awaiting-approval' }
  | { readonly kind: 'running' }
  | {
      readonly kind: 'terminal'
      readonly result: CapabilityDispatchResult
    }

export interface CapabilityLifecycleProjectionResult {
  readonly detail?: unknown
}

export interface CapabilityPreparedExecution {
  readonly effect: CapabilityEffect
  readonly risk: string
  readonly argumentNames: readonly string[]
  readonly policyDecision: CapabilityPolicyDecision
  readonly approval?: CapabilityApprovalDescription
  /**
   * Adapter-declared recovery behavior after the effect has started.
   * Omitted or `unknown` is treated as non-retryable (ADR §7).
   */
  readonly recoveryPolicy?: CapabilityRecoveryPolicy
  projectLifecycle?(
    input: CapabilityLifecycleProjection,
  ): Promise<CapabilityLifecycleProjectionResult | undefined>
  authorize(input: {
    readonly phase: CapabilityAuthorizationPhase
    readonly signal?: AbortSignal
  }): Promise<CapabilityPolicyDecision>
  execute(input: { readonly signal: AbortSignal }): Promise<unknown>
  beginCompletion?(input?: {
    readonly signal: AbortSignal
  }): Promise<CapabilityCompletionFence>
  acceptResult(input: {
    readonly value: unknown
    readonly signal?: AbortSignal
  }): Promise<CapabilityAcceptedResult>
  release?(): void | Promise<void>
}

export interface CapabilityAdapter {
  readonly capabilityId: string
  prepare(input: {
    readonly context: CapabilityExecutionContext
    readonly invocation: CapabilityInvocationIdentity
    readonly arguments: CanonicalJsonObject
    readonly canonicalArguments: string
    readonly argumentDigest: string
    readonly signal: AbortSignal
  }): Promise<CapabilityPreparedExecution>
}

export type CapabilityDispatchResult =
  | {
      readonly status: 'completed'
      readonly dispatchId: string
      readonly value: unknown
      readonly costTracked: boolean
      readonly budgetOverrun: boolean
      readonly actualCostUsd?: number
    }
  | {
      readonly status: 'rejected'
      readonly dispatchId: string
      readonly code: string
      readonly detail?: unknown
    }
  | {
      readonly status: 'cancelled'
      readonly dispatchId: string
      readonly code: string
      readonly detail?: unknown
    }
  | {
      readonly status: 'failed'
      readonly dispatchId: string
      readonly code: string
      readonly detail?: unknown
    }
  | {
      readonly status: 'indeterminate'
      readonly dispatchId: string
      readonly code: string
      readonly detail?: unknown
    }

export type CapabilityDispatchEventType =
  | 'capability.dispatch.requested'
  | 'capability.dispatch.approval_requested'
  | 'capability.dispatch.approval_resolved'
  | 'capability.dispatch.started'
  | 'capability.dispatch.completed'
  | 'capability.dispatch.rejected'
  | 'capability.dispatch.cancelled'
  | 'capability.dispatch.failed'
  | 'capability.dispatch.indeterminate'

export interface CapabilityDispatchEvent {
  readonly contractVersion: 1
  readonly type: CapabilityDispatchEventType
  readonly timestamp: string
  readonly dispatchId: string
  readonly attemptId: string
  readonly requestId: string
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly taskId?: string
  readonly agentPath: string
  readonly agentId?: string
  readonly activityScopeId?: string
  readonly workflowId?: string
  readonly workflowStepId?: string
  readonly authorityKind: CapabilityScopeAuthority['kind']
  readonly capabilityId: string
  readonly sourceKind: CapabilitySourceKind
  readonly sourceId: string
  readonly sourceVersion?: string
  readonly argumentDigest: string
  readonly argumentNames: readonly string[]
  readonly effect?: CapabilityEffect
  readonly code?: string
  readonly interactionId?: string
  readonly approvalOutcome?: CapabilityApprovalOutcome
  readonly costTracked?: boolean
  readonly budgetOverrun?: boolean
  readonly actualCostUsd?: number
}

export interface CapabilityAuthorityPort {
  authorize(input: {
    readonly context: CapabilityExecutionContext
    readonly invocation: CapabilityInvocationIdentity
    readonly phase: CapabilityAuthorizationPhase
    readonly evidence?: unknown
  }): Promise<CapabilityPolicyDecision>
}

export interface CapabilityPolicyPort {
  evaluate(input: {
    readonly context: CapabilityExecutionContext
    readonly invocation: CapabilityInvocationIdentity
    readonly effect: CapabilityEffect
    readonly risk: string
  }): Promise<CapabilityPolicyDecision>
}

export type CapabilityBudgetPreflight =
  | { readonly kind: 'not-metered' }
  | {
      readonly kind: 'metered'
      readonly estimateUsd?: number
    }
  | {
      readonly kind: 'rejected'
      readonly code: string
      readonly reason: string
    }

export interface CapabilityBudgetReservation {
  readonly reservationId: string
}

export interface CapabilityBudgetSettlement {
  readonly costTracked: boolean
  readonly budgetOverrun: boolean
  readonly actualCostUsd?: number
}

export interface CapabilityBudgetPort {
  preflight(input: {
    readonly context: CapabilityExecutionContext
    readonly invocation: CapabilityInvocationIdentity
    readonly effect: CapabilityEffect
    readonly risk: string
  }): Promise<CapabilityBudgetPreflight>
  reserve(input: {
    readonly context: CapabilityExecutionContext
    readonly invocation: CapabilityInvocationIdentity
    readonly preflight: Extract<CapabilityBudgetPreflight, { readonly kind: 'metered' }>
    /** Dispatch cancellation/deadline signal. Dispatchers always provide it. */
    readonly signal?: AbortSignal
  }): Promise<CapabilityBudgetReservation>
  settle(input: {
    readonly reservation: CapabilityBudgetReservation
    readonly actualCostUsd?: number
  }): Promise<CapabilityBudgetSettlement>
  /**
   * Required for ports that can admit metered work under a hard/halt policy.
   * The dispatcher calls this when settlement throws or returns an invalid
   * response so the next hard-budget preflight can fail closed.
   */
  markSettlementUncertain?(input: {
    readonly reservation: CapabilityBudgetReservation
    readonly reason: 'settlement_failed' | 'settlement_result_invalid'
  }): void | Promise<void>
  release(reservation: CapabilityBudgetReservation): void | Promise<void>
}

export type CapabilityApprovalOutcome =
  | 'approved'
  | 'denied'
  | 'expired'
  | 'cancelled'
  | 'interrupted'

export interface CapabilityApprovalInteraction {
  readonly interactionId: string
  readonly reused: boolean
}

export interface CapabilityApprovalPort {
  request(input: {
    readonly context: CapabilityExecutionContext
    readonly invocation: CapabilityInvocationIdentity
    readonly arguments: CanonicalJsonObject
    readonly dispatchId: string
    readonly argumentDigest: string
    readonly canonicalArguments: string
    readonly effect: CapabilityEffect
    readonly risk: string
    readonly description: CapabilityApprovalDescription
    readonly signal: AbortSignal
    readonly onInteraction: (interaction: CapabilityApprovalInteraction) => Promise<void>
  }): Promise<{
    readonly outcome: CapabilityApprovalOutcome
    readonly interaction: CapabilityApprovalInteraction
  }>
}

export interface CapabilityEvidencePort {
  append(event: CapabilityDispatchEvent): void | Promise<void>
}

export interface CapabilityExecutionSchedulerPort {
  run<T>(input: {
    readonly scopeKey: string
    readonly effect: CapabilityEffect
    readonly signal: AbortSignal
    readonly operation: () => Promise<T>
  }): Promise<T>
}

export interface CapabilityDispatcherPorts {
  readonly bindings?: CapabilityInvocationBindingPort
  readonly authority?: CapabilityAuthorityPort
  readonly policy?: CapabilityPolicyPort
  readonly budget?: CapabilityBudgetPort
  readonly approval?: CapabilityApprovalPort
  readonly evidence?: CapabilityEvidencePort
  readonly scheduler?: CapabilityExecutionSchedulerPort
  readonly clock?: { readonly now: () => number }
  readonly ids?: { readonly nextAttemptId: () => string }
  /**
   * Durable execution-journal barrier and replay authority (Phase 8).
   *
   * Resolved per dispatch because a journal is assignment-scoped while the
   * dispatcher is process-global (ADR §1). Returning `undefined` means this
   * assignment has no durable authority and the dispatch proceeds unchanged;
   * throwing means the authority is enrolled but unavailable, which fails the
   * dispatch closed rather than executing without a durability barrier
   * (ADR §7). `deadlineMs` is an absolute clock deadline for the resolution.
   */
  readonly durable?: (input: {
    readonly context: CapabilityExecutionContext
    readonly signal: AbortSignal
    readonly deadlineMs: number
  }) => Promise<CapabilityDurableDispatchPort | undefined>
  /**
   * Where live durable attempts are offered to whoever owns their teardown
   * (AC18). Absent when nothing tears this dispatcher down, in which case a
   * dispatch behaves exactly as before.
   */
  readonly teardown?: DurableTeardownRegistry
}

export interface CapabilityInvocationBindingPort {
  readonly marker: 'capability-invocation-binding-port'
  acquire(
    input: CapabilityInvocationBindingAcquireInput,
  ): CapabilityInvocationBindingAcquisition
  releaseScope(scopeKey: string): void
}

export interface CapabilityInvocationBindingAcquireInput {
  readonly scopeKey: string
  readonly dispatchId: string
  readonly argumentDigest: string
}

export type CapabilityInvocationBindingAcquisition =
  | {
      readonly kind: 'leader'
      complete(result: CapabilityDispatchResult): void
      /**
       * Settle waiting followers without retaining the result, for a failure
       * that describes the infrastructure rather than the invocation. A
       * retained transient failure would be replayed as this call's answer.
       */
      abandon(result: CapabilityDispatchResult): void
    }
  | {
      readonly kind: 'follower'
      wait(signal: AbortSignal): Promise<CapabilityDispatchResult>
    }
  | {
      readonly kind: 'retained'
      readonly result: CapabilityDispatchResult
    }
  | {
      readonly kind: 'conflict'
      readonly code: 'invocation_identity_conflict'
    }
  | {
      readonly kind: 'capacity-exceeded'
      readonly code: 'capacity_exceeded'
    }

export interface CapabilityDispatchRequest {
  readonly context: CapabilityExecutionContext
  readonly invocation: CapabilityInvocation
  readonly adapter: CapabilityAdapter
  /** Opaque, authority-port-validated evidence for the initial check only. */
  readonly initialAuthorityEvidence?: unknown
  readonly signal?: AbortSignal
  readonly deadlineMs?: number
  /** Absolute epoch deadline for the post-execute settlement tail. */
  readonly settlementDeadlineMs?: number
}
