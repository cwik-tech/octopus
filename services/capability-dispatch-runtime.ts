import { randomUUID } from 'node:crypto'

import type {
  CapabilityAssignmentScope,
  CapabilityApprovalPort,
  CapabilityAuthorizationPhase,
  CapabilityAuthorityPort,
  CapabilityBudgetPort,
  CapabilityDispatchRequest,
  CapabilityDispatchResult,
  CapabilityEvidencePort,
  CapabilityExecutionContext,
  CapabilityInvocationIdentity,
  CapabilityPolicyDecision,
  CapabilityPolicyPort,
} from '../contracts/capability-dispatch.js'
import type { RuntimeCapabilityAuthorityPort } from '../contracts/runtime-capability-authority.js'
import { CapabilityDispatcher } from '../core/capability-dispatcher.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../core/capability-execution-scheduler.js'
import { CapabilityInvocationBindings } from '../core/capability-invocation-bindings.js'
import type { McpApprovalCoordinator } from '../domains/mcp/mcp-approval-coordinator.js'
import { validateMcpRunLease } from '../domains/mcp/mcp-broker-policy.js'
import type {
  McpBrokerRequestContext,
  McpRunLeaseClaims,
} from '../domains/mcp/mcp-runtime.js'
import { WorkspaceCapabilityEvidenceWriter } from './workspace-capability-evidence-writer.js'
import {
  WorkspaceExecutionJournalRegistry,
  type ExecutionJournalMode,
} from './workspace-execution-journal-registry.js'
import type { CapabilityDispatchLifecycle } from '../contracts/capability-dispatch-lifecycle.js'
import { CapabilityDispatchLifecycleCoordinator } from './capability-dispatch-lifecycle.js'
import { whenDefined } from '../core/optional-properties.js'

const DEFAULT_MAX_ACTIVE_PER_SCOPE = 32
const DEFAULT_MAX_RETAINED_PER_SCOPE = 256

export interface CapabilityDispatchRuntimeOptions {
  readonly workspacePath: string
  readonly leaseResolver: (
    context: Pick<McpBrokerRequestContext, 'leaseId'>,
  ) => McpRunLeaseClaims | null | Promise<McpRunLeaseClaims | null>
  readonly runtimeAuthority: RuntimeCapabilityAuthorityPort
  readonly approvalCoordinator?: Pick<McpApprovalCoordinator, 'requestApproval'>
  readonly policy?: CapabilityPolicyPort
  readonly budget?: CapabilityBudgetPort
  readonly now?: () => number
  readonly maxActivePerScope?: number
  readonly maxRetainedPerScope?: number
  readonly assignmentLifecycle?: CapabilityAssignmentLifecyclePort
  /** Bounds the release drain; see `capability-dispatch-lifecycle.ts`. */
  readonly releaseDrainTimeoutMs?: number
  /**
   * How long a graceful shutdown lets in-flight dispatches finish before it
   * aborts and finalizes them (AC18). A product option, not a test hook:
   * deployments with slower external effects legitimately need a wider
   * window. Must be a finite, non-negative number of milliseconds.
   */
  readonly shutdownDeadlineMs?: number
  /**
   * The shared admission/drain/finalization authority. Omitted when this
   * runtime is the only dispatch participant in the process and constructs
   * its own coordinator; the composition root injects one when several
   * participants must share a single shutdown window (AC18). `releaseDrainTimeoutMs`
   * and `shutdownDeadlineMs` configure the coordinator this runtime
   * constructs and are ignored when one is injected.
   */
  readonly lifecycle?: CapabilityDispatchLifecycle
  /**
   * Durable execution-journal authority (Phase 8). Omitted or `disabled`
   * leaves dispatch on the legacy authority for unenrolled assignments;
   * assignments already holding canonical events stay journal-authoritative
   * regardless, because authority is sticky (ADR §16).
   */
  readonly executionJournal?: {
    readonly mode: ExecutionJournalMode
    readonly tenantId: string
  }
  /**
   * A registry this runtime shares rather than owns.
   *
   * `released` and `closed` are per-registry state, so a second registry in one
   * process does not honour the first's teardown bar and can reopen a journal
   * barred for a terminal assignment (ADR §16). The composition root therefore
   * owns one and injects it here; when it does, it also owns closing it.
   *
   * Takes precedence over `executionJournal`, which remains for callers that
   * legitimately own their own runtime and registry.
   */
  readonly executionJournalRegistry?: WorkspaceExecutionJournalRegistry
}

export interface CapabilityAssignmentLifecyclePort {
  subscribeTaskTerminal(
    listener: (scope: CapabilityAssignmentScope) => void | Promise<void>,
  ): () => void
}

/** Owns the one parent-process dispatcher and its live-process resources. */
export class CapabilityDispatchRuntime {
  readonly authority: CapabilityAuthorityPort
  readonly approval: CapabilityApprovalPort | undefined
  readonly dispatcher: Pick<CapabilityDispatcher, 'dispatch'>
  readonly evidencePort: CapabilityEvidencePort
  private readonly evidence: WorkspaceCapabilityEvidenceWriter
  private readonly journals: WorkspaceExecutionJournalRegistry | undefined
  /** False when the registry was injected; its owner closes it. */
  private readonly ownsJournals: boolean
  private readonly bindings: CapabilityInvocationBindings
  private readonly kernelDispatcher: CapabilityDispatcher
  /**
   * The shared admission/drain/finalization authority (AC18). Owned here
   * when this runtime is the process's only dispatch participant; injected
   * by the composition root when several participants share one shutdown
   * window.
   */
  private readonly lifecycle: CapabilityDispatchLifecycle
  private closePromise: Promise<void> | undefined
  private unsubscribeAssignmentLifecycle: (() => void) | undefined

  constructor(options: CapabilityDispatchRuntimeOptions) {
    const now = options.now ?? Date.now
    this.authority = new CapabilityDispatchAuthority({
      leaseResolver: options.leaseResolver,
      runtimeAuthority: options.runtimeAuthority,
      now,
    })
    this.approval = options.approvalCoordinator
      ? new CapabilityApprovalCoordinatorPort(options.approvalCoordinator)
      : undefined
    this.evidence = new WorkspaceCapabilityEvidenceWriter({
      workspacePath: options.workspacePath,
    })
    this.evidencePort = this.evidence
    this.lifecycle =
      options.lifecycle ??
      new CapabilityDispatchLifecycleCoordinator({
        ...whenDefined(options.releaseDrainTimeoutMs, (value) => ({
          releaseDrainTimeoutMs: value,
        })),
        ...whenDefined(options.shutdownDeadlineMs, (value) => ({
          shutdownDeadlineMs: value,
        })),
      })
    if (options.executionJournalRegistry) {
      this.journals = options.executionJournalRegistry
      this.ownsJournals = false
    } else if (options.executionJournal) {
      this.journals = new WorkspaceExecutionJournalRegistry({
        workspacePath: options.workspacePath,
        tenantId: options.executionJournal.tenantId,
        mode: options.executionJournal.mode,
      })
      this.ownsJournals = true
    } else {
      this.journals = undefined
      this.ownsJournals = false
    }
    this.bindings = new CapabilityInvocationBindings({
      maxActivePerScope:
        options.maxActivePerScope ?? DEFAULT_MAX_ACTIVE_PER_SCOPE,
      maxRetainedPerScope:
        options.maxRetainedPerScope ?? DEFAULT_MAX_RETAINED_PER_SCOPE,
    })
    this.kernelDispatcher = new CapabilityDispatcher({
      bindings: this.bindings,
      authority: this.authority,
      policy: options.policy ?? ALLOW_POLICY,
      budget: options.budget ?? NOT_METERED_BUDGET,
      ...whenDefined(this.approval, (approval) => ({ approval })),
      evidence: this.evidence,
      scheduler: new PerAuthorityCapabilityExecutionScheduler(),
      clock: { now },
      ids: { nextAttemptId: randomUUID },
      ...whenDefined(this.journals, (journals) => ({
        durable: (input: Parameters<typeof journals.resolve>[0]) =>
          journals.resolve(input),
      })),
      teardown: this.lifecycle.teardown,
    })
    this.dispatcher = {
      dispatch: (request) => this.dispatch(request),
    }
    this.unsubscribeAssignmentLifecycle =
      options.assignmentLifecycle?.subscribeTaskTerminal((scope) =>
        this.releaseAssignment(scope),
      )
  }

  /**
   * Refuse new dispatch, without disturbing work already running (AC18).
   *
   * Synchronous and separate from `close` on purpose. A graceful shutdown has
   * to bar both entry paths at the same moment — the HTTP listener and this
   * one — and then let what is already in flight finish. Barring only at
   * `close` would keep admitting out-of-band MCP and worker work while the
   * server waits for the requests it already has.
   *
   * Idempotent, and never the thing that ends a dispatch: only the deadline
   * in `close` does that.
   */
  beginShutdown(): void {
    this.lifecycle.beginShutdown()
    this.unsubscribeAssignmentLifecycle?.()
    this.unsubscribeAssignmentLifecycle = undefined
  }

  /**
   * Drain until the deadline, finalize what is left, then close the evidence
   * writer and — only when owned — the journals.
   *
   * `deadlineMs` is an *absolute* clock deadline, so a caller that has
   * already spent part of one shutdown window passes what remains of it
   * rather than starting a fresh one — two windows in series would be a
   * shutdown twice as long as anybody configured.
   *
   * A failed finalization rejects and leaves the journals open: they must
   * not close over a decision that was never recorded. The rejection is not
   * memoized, so a caller can retry after a transient fault.
   */
  close(options?: { readonly deadlineMs?: number }): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.beginShutdown()
    // Called synchronously, so an invalid absolute deadline throws here —
    // after the bar, before any memo — exactly as it did when the runtime
    // validated the deadline itself.
    const lifecycleClose = this.lifecycle.close(options)
    const handled = lifecycleClose
      .then(async () => {
        await this.evidence.close()
        // Journals close after in-flight dispatches drain, never before — and
        // only when this runtime owns them. Closing an injected registry here
        // would tear down journals other consumers in this process still hold.
        if (this.ownsJournals) await this.journals?.close()
      })
      .catch((error: unknown) => {
        this.closePromise = undefined
        throw error
      })
    this.closePromise = handled
    return handled
  }

  /** Call only from verified assignment teardown after new dispatches are barred. */
  async releaseAssignment(scope: CapabilityAssignmentScope): Promise<void> {
    // Validates the identity, then bars the assignment — both synchronously,
    // before the first await, so no dispatch can slip in between the bar and
    // the drain snapshot the lifecycle takes below.
    this.bindings.releaseAssignment(scope)
    await this.lifecycle.releaseAssignment(scope)
    await this.evidence.releaseAssignment(scope)
    // Drains and closes the assignment's journal, and bars a later reopen.
    await this.journals?.releaseAssignment(scope)
  }

  private dispatch(
    request: CapabilityDispatchRequest,
  ): Promise<CapabilityDispatchResult> {
    const scope = {
      sessionId: request.context.sessionId,
      runId: request.context.runId,
      assignmentId: request.context.assignmentId,
    }
    return this.lifecycle
      .run({
        scope,
        operation: (lifecycleSignal) => {
          const combined = combineAbortSignals(
            request.signal,
            lifecycleSignal,
          )
          return this.kernelDispatcher
            .dispatch({ ...request, signal: combined.signal })
            .finally(() => combined.release())
        },
      })
      .then((outcome) => {
        if (outcome.kind === 'ran') return outcome.result
        // Refused ahead of the bindings, the durable authority and the
        // adapter, so a dispatch for a closing lifecycle or a released
        // assignment never runs an external effect it could not then record.
        return outcome.code === 'lifecycle_shutting_down'
          ? {
              status: 'failed',
              dispatchId: 'runtime-closed',
              code: 'dispatch_runtime_closed',
            }
          : {
              status: 'failed',
              dispatchId: 'assignment-released',
              code: 'dispatch_assignment_released',
            }
      })
  }
}

interface CapabilityDispatchAuthorityOptions {
  readonly leaseResolver: CapabilityDispatchRuntimeOptions['leaseResolver']
  readonly runtimeAuthority: RuntimeCapabilityAuthorityPort
  readonly now: () => number
}

export class CapabilityDispatchAuthority implements CapabilityAuthorityPort {
  constructor(private readonly options: CapabilityDispatchAuthorityOptions) {}

  async authorize(input: {
    readonly context: CapabilityExecutionContext
    readonly invocation: CapabilityInvocationIdentity
    readonly phase: CapabilityAuthorizationPhase
    readonly evidence?: unknown
  }): Promise<CapabilityPolicyDecision> {
    if (input.evidence !== undefined && input.phase !== 'initial') {
      return authorityDenied('runtime_authority_invalid')
    }
    switch (input.context.authority.kind) {
      case 'mcp-lease':
        return this.authorizeMcpLease(input.context)
      case 'runtime-assignment':
        return this.authorizeRuntime(input.context, input.evidence)
      case 'parent-capability':
        if (input.context.authority.endpointId !== input.invocation.capabilityId) {
          return authorityDenied('capability_endpoint_mismatch')
        }
        return this.authorizeRuntime(input.context, input.evidence)
    }
  }

  private async authorizeMcpLease(
    context: CapabilityExecutionContext,
  ): Promise<CapabilityPolicyDecision> {
    const authority = context.authority
    if (authority.kind !== 'mcp-lease') {
      return authorityDenied('lease_invalid')
    }
    try {
      const brokerContext = toMcpBrokerContext(context, authority.leaseId)
      const claims = await this.options.leaseResolver({
        leaseId: authority.leaseId,
      })
      const error = validateMcpRunLease(
        brokerContext,
        claims,
        this.options.now(),
      )
      if (error) return authorityDenied(error.code)
      if (claims?.taskId !== context.taskId) {
        return authorityDenied('lease_invalid')
      }
      return { kind: 'allow' }
    } catch {
      return authorityDenied('lease_invalid')
    }
  }

  private async authorizeRuntime(
    context: CapabilityExecutionContext,
    evidence?: unknown,
  ): Promise<CapabilityPolicyDecision> {
    const authority = context.authority
    if (
      authority.kind === 'mcp-lease' ||
      !context.taskId
    ) {
      return authorityDenied('runtime_authority_invalid')
    }
    try {
      const resolution = await this.options.runtimeAuthority.authorize(
        {
          sessionId: context.sessionId,
          runId: context.runId,
          assignmentId: context.assignmentId,
          taskId: context.taskId,
          processIdentity: authority.processIdentity,
          ...(context.workflowId ? { workflowId: context.workflowId } : {}),
        },
        evidence === undefined
          ? undefined
          : { kind: 'reuse-evidence', evidence },
      )
      if (
        resolution.taskId !== context.taskId ||
        (context.workflowId !== undefined &&
          resolution.workflowId !== context.workflowId)
      ) {
        return authorityDenied('runtime_authority_invalid')
      }
      return { kind: 'allow' }
    } catch {
      return authorityDenied('runtime_authority_invalid')
    }
  }
}

export class CapabilityApprovalCoordinatorPort implements CapabilityApprovalPort {
  constructor(
    private readonly coordinator: Pick<McpApprovalCoordinator, 'requestApproval'>,
  ) {}

  async request(
    input: Parameters<CapabilityApprovalPort['request']>[0],
  ): ReturnType<CapabilityApprovalPort['request']> {
    const decision = await this.coordinator.requestApproval({
      context: toMcpBrokerContext(
        input.context,
        approvalLeaseId(input.context),
      ),
      serverId: input.description.serverId,
      namespacedToolName: input.description.namespacedToolName,
      toolCallId: input.invocation.toolCallId,
      toolRisk: input.effect.kind,
      arguments: input.arguments,
      signal: input.signal,
      onInteraction: (interaction) => input.onInteraction({
        interactionId: interaction.interactionId,
        reused: interaction.status === 'approved-run',
      }),
    })
    return {
      outcome: decision.outcome,
      interaction: {
        interactionId: decision.interaction.interactionId,
        reused: decision.reused,
      },
    }
  }
}

const ALLOW_POLICY = Object.freeze<CapabilityPolicyPort>({
  evaluate: async () => ({ kind: 'allow' }),
})

const NOT_METERED_BUDGET = Object.freeze<CapabilityBudgetPort>({
  preflight: async () => ({ kind: 'not-metered' }),
  reserve: async () => {
    throw new Error('An unmetered capability cannot reserve budget.')
  },
  settle: async () => ({ costTracked: false, budgetOverrun: false }),
  release: async () => undefined,
})

function toMcpBrokerContext(
  context: CapabilityExecutionContext,
  leaseId: string,
): McpBrokerRequestContext {
  return {
    contractVersion: 1,
    requestId: context.requestId,
    leaseId,
    sessionId: context.sessionId,
    runId: context.runId,
    assignmentId: context.assignmentId,
    ...(context.workflowId ? { workflowId: context.workflowId } : {}),
    ...(context.workflowStepId
      ? { workflowStepId: context.workflowStepId }
      : {}),
    agentPath: context.agentPath,
    ...(context.agentId ? { agentId: context.agentId } : {}),
    ...(context.agentDisplayName
      ? { agentDisplayName: context.agentDisplayName }
      : {}),
    ...(context.activityScopeId
      ? { activityScopeId: context.activityScopeId }
      : {}),
  }
}

function approvalLeaseId(context: CapabilityExecutionContext): string {
  return context.authority.kind === 'mcp-lease'
    ? context.authority.leaseId
    : 'parent-capability-approval'
}

function authorityDenied(code: string): CapabilityPolicyDecision {
  return {
    kind: 'deny',
    code,
    reason: 'Capability scope authority could not be verified.',
  }
}

function combineAbortSignals(
  callerSignal: AbortSignal | undefined,
  runtimeSignal: AbortSignal,
): { readonly signal: AbortSignal; release(): void } {
  if (!callerSignal) {
    return { signal: runtimeSignal, release: () => undefined }
  }
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(callerSignal.reason)
  const abortFromRuntime = () => controller.abort(runtimeSignal.reason)
  if (callerSignal.aborted) abortFromCaller()
  else callerSignal.addEventListener('abort', abortFromCaller, { once: true })
  if (runtimeSignal.aborted) abortFromRuntime()
  else runtimeSignal.addEventListener('abort', abortFromRuntime, { once: true })
  return {
    signal: controller.signal,
    release: () => {
      callerSignal.removeEventListener('abort', abortFromCaller)
      runtimeSignal.removeEventListener('abort', abortFromRuntime)
    },
  }
}
