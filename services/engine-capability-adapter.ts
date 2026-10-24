import * as fs from 'node:fs'

import { serialCapabilityEffect } from '../contracts/capability-effect.js'
import type {
  CapabilityPolicyDecision,
  CapabilityPreparedExecution,
} from '../contracts/capability-dispatch.js'
import type { DelegationResultStatus } from '../core/types.js'
import { getAssignmentLogPath } from '../domains/runtime/logger.js'

export const STANDARD_ENGINE_TOOL_NAMES = [
  'set_roster',
  'create_brief',
  'converse',
  'dispatch',
  'handoff',
  'broadcast',
  'submit_for_review',
] as const

export const DELEGATION_ENGINE_TOOL_NAMES = [
  'spawn_team',
  'spawn_workflow',
] as const

export type StandardEngineToolName =
  (typeof STANDARD_ENGINE_TOOL_NAMES)[number]
export type DelegationEngineToolName =
  (typeof DELEGATION_ENGINE_TOOL_NAMES)[number]
export type GovernedEngineToolName =
  | StandardEngineToolName
  | DelegationEngineToolName

export const ENGINE_TOOL_CAPABILITY_IDS = {
  set_roster: 'team-runtime.engine.set_roster',
  create_brief: 'team-runtime.engine.create_brief',
  converse: 'team-runtime.engine.converse',
  dispatch: 'team-runtime.engine.dispatch',
  handoff: 'team-runtime.engine.handoff',
  broadcast: 'team-runtime.engine.broadcast',
  submit_for_review: 'team-runtime.engine.submit_for_review',
  spawn_team: 'team-runtime.engine.spawn_team',
  spawn_workflow: 'team-runtime.engine.spawn_workflow',
} as const satisfies Readonly<Record<GovernedEngineToolName, string>>

export type DelegationCapabilityOutcome =
  | {
      readonly kind: 'delegation-execution'
      readonly outcome: 'child-not-started'
      readonly childStarted: false
      readonly delegationId?: string
      readonly childSessionId?: string
      readonly lastKnownStatus?: DelegationResultStatus
    }
  | {
      readonly kind: 'delegation-execution'
      readonly outcome: 'caller-cancelled'
      readonly childStarted: false
      readonly delegationId?: string
      readonly childSessionId?: string
      readonly lastKnownStatus?: DelegationResultStatus
    }
  | {
      readonly kind: 'delegation-execution'
      readonly outcome: 'child-terminal'
      readonly childStarted: true
      readonly delegationId: string
      readonly childSessionId?: string
      readonly terminalStatus: DelegationTerminalStatus
    }
  | {
      readonly kind: 'delegation-execution'
      readonly outcome: 'child-state-uncertain'
      readonly childStarted: true
      readonly delegationId?: string
      readonly childSessionId?: string
      readonly lastKnownStatus?: DelegationResultStatus
    }

export interface EngineToolAdapterFactoryOptions {
  readonly toolName: StandardEngineToolName
  /** Returns the owning Team Runtime ledger's cumulative accepted cost. */
  readTotalCostUsd?(): number | undefined
}

export interface DelegationToolAdapterFactoryOptions {
  readonly toolName: DelegationEngineToolName
  readonly assignmentPath: string
  /** Returns the owning Team Runtime ledger's cumulative accepted cost. */
  readTotalCostUsd?(): number | undefined
}

const DELEGATION_LIFECYCLE_LOG_FILENAME = 'delegation-lifecycle.jsonl'
const STARTED_DELEGATION_STATUSES = new Set<DelegationResultStatus>([
  'running',
  'waiting_on_stage',
  'waiting_on_child',
  'completed',
  'completed_with_warnings',
  'blocked',
  'failed',
  'timed_out',
])
const TERMINAL_DELEGATION_STATUSES = new Set<DelegationTerminalStatus>([
  'completed',
  'completed_with_warnings',
  'blocked',
  'failed',
  'timed_out',
])
const ACCEPTED_DELEGATION_STATUSES = new Set<DelegationTerminalStatus>([
  'completed',
  'completed_with_warnings',
])

type DelegationTerminalStatus = Extract<
  DelegationResultStatus,
  'completed' | 'completed_with_warnings' | 'blocked' | 'failed' | 'timed_out'
>

interface DelegationLifecycleObservation {
  readonly delegationId: string
  readonly status: DelegationResultStatus
  readonly childSessionId?: string
}

/** Lower-layer structural seam implemented by the Team Runtime wrapper. */
export interface EngineCapabilityAdapterFactoryInput {
  readonly signal: AbortSignal
  readonly argumentNames: readonly string[]
  executeRaw(signal: AbortSignal): Promise<unknown>
}

export interface EngineCapabilityAdapterFactory {
  readonly capabilityId: string
  createPreparedExecution(
    input: EngineCapabilityAdapterFactoryInput,
  ): Promise<CapabilityPreparedExecution>
}

export function createEngineToolAdapterFactory(
  options: EngineToolAdapterFactoryOptions,
): EngineCapabilityAdapterFactory {
  return {
    capabilityId: ENGINE_TOOL_CAPABILITY_IDS[options.toolName],
    createPreparedExecution: async (input) =>
      createStandardPreparedExecution(input, options),
  }
}

export function createDelegationToolAdapterFactory(
  options: DelegationToolAdapterFactoryOptions,
): EngineCapabilityAdapterFactory {
  return {
    capabilityId: ENGINE_TOOL_CAPABILITY_IDS[options.toolName],
    createPreparedExecution: async (input) =>
      createDelegationPreparedExecution(input, options),
  }
}

function createStandardPreparedExecution(
  input: EngineCapabilityAdapterFactoryInput,
  options: EngineToolAdapterFactoryOptions,
): CapabilityPreparedExecution {
  let costBefore: number | undefined
  return {
    effect: serialCapabilityEffect('mutating'),
    risk: 'team-runtime-state-change',
    argumentNames: input.argumentNames,
    policyDecision: { kind: 'allow' },
    authorize: allowCapability,
    execute: ({ signal }) => {
      costBefore = readValidCost(options.readTotalCostUsd)
      return input.executeRaw(signal)
    },
    acceptResult: async ({ value }) => ({
      value,
      ...acceptedCost(costBefore, options.readTotalCostUsd),
    }),
  }
}

function createDelegationPreparedExecution(
  input: EngineCapabilityAdapterFactoryInput,
  options: DelegationToolAdapterFactoryOptions,
): CapabilityPreparedExecution {
  let costBefore: number | undefined
  let baselineIds: ReadonlySet<string> | undefined
  let executionSignal = input.signal
  let observedOutcome: DelegationCapabilityOutcome | undefined
  let acceptedOutcome: DelegationCapabilityOutcome | undefined

  const observeOutcome = (): DelegationCapabilityOutcome => {
    const outcome = classifyDelegationOutcome({
      observations: readDelegationLifecycle(options.assignmentPath).filter(
        (record) => !baselineIds?.has(record.delegationId),
      ),
      signal: executionSignal,
    })
    observedOutcome = outcome
    return outcome
  }

  return {
    effect: serialCapabilityEffect('mutating'),
    risk: 'delegated-execution',
    argumentNames: input.argumentNames,
    policyDecision: { kind: 'allow' },
    authorize: allowCapability,
    execute: async ({ signal }) => {
      costBefore = readValidCost(options.readTotalCostUsd)
      baselineIds = new Set(
        readDelegationLifecycle(options.assignmentPath).map((record) =>
          record.delegationId
        ),
      )
      executionSignal = signal
      try {
        return await input.executeRaw(signal)
      } finally {
        observeOutcome()
      }
    },
    beginCompletion: async () => {
      const outcome = observeOutcome()
      acceptedOutcome = outcome
      if (outcome.outcome !== 'child-terminal') {
        throw new Error(
          `Delegation cannot be completed from ${outcome.outcome}.`,
        )
      }
      return { release: () => undefined }
    },
    acceptResult: async ({ value }) => {
      const outcome = acceptedOutcome ?? observeOutcome()
      if (
        outcome.outcome !== 'child-terminal' ||
        !ACCEPTED_DELEGATION_STATUSES.has(outcome.terminalStatus)
      ) {
        throw new Error('Delegation did not reach an accepted terminal state.')
      }
      return {
        value,
        ...acceptedCost(costBefore, options.readTotalCostUsd),
      }
    },
    projectLifecycle: async (transition) => {
      if (
        transition.kind !== 'terminal' ||
        transition.result.status === 'completed'
      ) {
        return undefined
      }
      return { detail: observedOutcome ?? observeOutcome() }
    },
  }
}

function classifyDelegationOutcome(input: {
  readonly observations: readonly DelegationLifecycleObservation[]
  readonly signal: AbortSignal
}): DelegationCapabilityOutcome {
  const delegationIds = Array.from(
    new Set(input.observations.map((record) => record.delegationId)),
  )
  if (delegationIds.length === 0) {
    return input.signal.aborted
      ? {
          kind: 'delegation-execution',
          outcome: 'caller-cancelled',
          childStarted: false,
        }
      : {
          kind: 'delegation-execution',
          outcome: 'child-not-started',
          childStarted: false,
        }
  }

  if (delegationIds.length > 1) {
    const anyStarted = input.observations.some((record) =>
      STARTED_DELEGATION_STATUSES.has(record.status)
    )
    if (anyStarted) {
      return {
        kind: 'delegation-execution',
        outcome: 'child-state-uncertain',
        childStarted: true,
      }
    }
    return input.signal.aborted
      ? {
          kind: 'delegation-execution',
          outcome: 'caller-cancelled',
          childStarted: false,
        }
      : {
          kind: 'delegation-execution',
          outcome: 'child-not-started',
          childStarted: false,
        }
  }

  const delegationId = delegationIds[0]
  if (!delegationId) {
    return {
      kind: 'delegation-execution',
      outcome: 'child-not-started',
      childStarted: false,
    }
  }
  const records = input.observations.filter((record) =>
    record.delegationId === delegationId
  )
  const latest = records.at(-1)
  const childStarted = records.some((record) =>
    STARTED_DELEGATION_STATUSES.has(record.status)
  )
  const identity = latest?.childSessionId
    ? { delegationId, childSessionId: latest.childSessionId }
    : { delegationId }

  if (
    latest &&
    isTerminalDelegationStatus(latest.status) &&
    !(input.signal.aborted && latest.status === 'failed')
  ) {
    return {
      kind: 'delegation-execution',
      outcome: 'child-terminal',
      childStarted: true,
      ...identity,
      terminalStatus: latest.status,
    }
  }
  if (input.signal.aborted && !childStarted) {
    return {
      kind: 'delegation-execution',
      outcome: 'caller-cancelled',
      childStarted: false,
      ...identity,
      ...(latest ? { lastKnownStatus: latest.status } : {}),
    }
  }
  if (childStarted) {
    return {
      kind: 'delegation-execution',
      outcome: 'child-state-uncertain',
      childStarted: true,
      ...identity,
      ...(latest ? { lastKnownStatus: latest.status } : {}),
    }
  }
  return {
    kind: 'delegation-execution',
    outcome: 'child-not-started',
    childStarted: false,
    ...identity,
    ...(latest ? { lastKnownStatus: latest.status } : {}),
  }
}

function readDelegationLifecycle(
  assignmentPath: string,
): DelegationLifecycleObservation[] {
  const lifecyclePath = getAssignmentLogPath(
    assignmentPath,
    DELEGATION_LIFECYCLE_LOG_FILENAME,
  )
  let body: string
  try {
    body = fs.readFileSync(lifecyclePath, 'utf8')
  } catch (error) {
    if (isFileNotFound(error)) return []
    throw error
  }
  const records: DelegationLifecycleObservation[] = []
  for (const line of body.split('\n')) {
    if (line.trim().length === 0) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    const record = readLifecycleObservation(value)
    if (record) records.push(record)
  }
  return records
}

function readLifecycleObservation(
  value: unknown,
): DelegationLifecycleObservation | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.delegationId !== 'string' ||
    !isDelegationStatus(value.status)
  ) {
    return undefined
  }
  return {
    delegationId: value.delegationId,
    status: value.status,
    ...(typeof value.childSessionId === 'string'
      ? { childSessionId: value.childSessionId }
      : {}),
  }
}

function acceptedCost(
  costBefore: number | undefined,
  readTotalCostUsd: (() => number | undefined) | undefined,
): { readonly actualCostUsd?: number } {
  if (costBefore === undefined) return {}
  const costAfter = readValidCost(readTotalCostUsd)
  if (costAfter === undefined || costAfter < costBefore) return {}
  return {
    actualCostUsd: Math.round((costAfter - costBefore) * 1_000_000_000) /
      1_000_000_000,
  }
}

function readValidCost(
  reader: (() => number | undefined) | undefined,
): number | undefined {
  if (!reader) return undefined
  const value = reader()
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

async function allowCapability(): Promise<CapabilityPolicyDecision> {
  return { kind: 'allow' }
}

function isTerminalDelegationStatus(
  value: DelegationResultStatus,
): value is DelegationTerminalStatus {
  switch (value) {
    case 'completed':
    case 'completed_with_warnings':
    case 'blocked':
    case 'failed':
    case 'timed_out':
      return true
    default:
      return false
  }
}

function isDelegationStatus(value: unknown): value is DelegationResultStatus {
  if (typeof value !== 'string') return false
  switch (value) {
    case 'queued':
    case 'validating_contract':
    case 'accepted':
    case 'running':
    case 'waiting_on_stage':
    case 'waiting_on_child':
    case 'completed':
    case 'completed_with_warnings':
    case 'blocked':
    case 'failed':
    case 'timed_out':
      return true
    default:
      return false
  }
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
