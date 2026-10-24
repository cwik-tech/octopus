import type {
  CapabilityAuthorityPort,
  CapabilityDispatcherPorts,
  CapabilityPolicyPort,
} from '../contracts/capability-dispatch.js'
import { CapabilityDispatcher } from '../core/capability-dispatcher.js'
import { CapabilityInvocationBindings } from '../core/capability-invocation-bindings.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../core/capability-execution-scheduler.js'
import { AssignmentCapabilityEvidenceWriter } from '../domains/runtime/capability-evidence-writer.js'
import {
  TeamRuntimeCapabilityBudgetPort,
  type TeamRuntimeCapabilityBudgetPortOptions,
} from './capability-budget-port.js'

export interface TeamRuntimeCapabilityDispatcherInput {
  readonly assignmentPath: string
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly authority: CapabilityAuthorityPort
  readonly policy: CapabilityPolicyPort
  readonly budget: TeamRuntimeCapabilityBudgetPortOptions
  readonly clock: { readonly now: () => number }
  readonly ids: { readonly nextAttemptId: () => string }
  /**
   * Always supplied. Disabled mode is expressed by the registry resolver
   * returning no port for an unenrolled assignment, never by constructing
   * an unjournaled dispatcher here.
   */
  readonly durable: NonNullable<CapabilityDispatcherPorts['durable']>
}

export interface TeamRuntimeCapabilityDispatcherPorts {
  readonly dispatcher: CapabilityDispatcher
  readonly evidenceWriter: AssignmentCapabilityEvidenceWriter
  readonly budgetPort: TeamRuntimeCapabilityBudgetPort
}

export function createTeamRuntimeCapabilityDispatcher(
  input: TeamRuntimeCapabilityDispatcherInput,
): TeamRuntimeCapabilityDispatcherPorts {
  const evidenceWriter = new AssignmentCapabilityEvidenceWriter({
    assignmentPath: input.assignmentPath,
    sessionId: input.sessionId,
    runId: input.runId,
    assignmentId: input.assignmentId,
  })
  const budgetPort = new TeamRuntimeCapabilityBudgetPort(input.budget)
  const dispatcher = new CapabilityDispatcher({
    bindings: new CapabilityInvocationBindings({
      maxActivePerScope: 8,
      maxRetainedPerScope: 256,
    }),
    authority: input.authority,
    policy: input.policy,
    budget: budgetPort,
    approval: {
      request: async () => {
        throw new Error('Team Runtime capability approval is unavailable.')
      },
    },
    evidence: evidenceWriter,
    scheduler: new PerAuthorityCapabilityExecutionScheduler(),
    clock: input.clock,
    ids: input.ids,
    durable: input.durable,
  })
  return { dispatcher, evidenceWriter, budgetPort }
}
