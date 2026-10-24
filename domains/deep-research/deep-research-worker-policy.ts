import * as crypto from 'node:crypto'

import {
  DEEP_RESEARCH_AGENT_PATH,
  DEEP_RESEARCH_BASE_AGENT,
  DEEP_RESEARCH_SCHEMA_VERSION,
  type ResearchTask,
  type ResearchWorkerSpec,
} from '../../contracts/deep-research.js'
import {
  DeepResearchValidationError,
  parseResearchWorkerSpec,
} from './deep-research-validation.js'

export const DEEP_RESEARCH_WORKER_CAPABILITY = Object.freeze({
  baseAgent: DEEP_RESEARCH_BASE_AGENT,
  agentPath: DEEP_RESEARCH_AGENT_PATH,
})

export type ResearchWorkerSpecInput = Omit<
  ResearchWorkerSpec,
  'schemaVersion' | 'baseAgent'
>

export interface AuthorizedResearchAssignment {
  readonly capability: typeof DEEP_RESEARCH_WORKER_CAPABILITY
  readonly task: ResearchTask
  readonly workerSpec: ResearchWorkerSpec
  readonly workerSpecHash: string
}

/** Stamp the only authorized capability identity; callers cannot supply one. */
export function createResearchWorkerSpec(
  input: ResearchWorkerSpecInput,
): ResearchWorkerSpec {
  return parseResearchWorkerSpec({
    ...input,
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    baseAgent: DEEP_RESEARCH_BASE_AGENT,
  })
}

/** Validate untrusted planner output and reject all unknown privilege fields. */
export function authorizeResearchWorkerSpec(
  value: unknown,
): ResearchWorkerSpec {
  return parseResearchWorkerSpec(value)
}

export function authorizeResearchAssignment(params: {
  readonly task: ResearchTask
  readonly workerSpec: unknown
}): AuthorizedResearchAssignment {
  const workerSpec = authorizeResearchWorkerSpec(params.workerSpec)
  if (
    workerSpec.id !== params.task.workerSpecId ||
    workerSpec.sectionId !== params.task.sectionId
  ) {
    throw new DeepResearchValidationError(
      'invalid_reference',
      'workerSpec.id',
      'Worker specification does not own the requested research task.',
    )
  }
  if (workerSpec.question !== params.task.question) {
    throw new DeepResearchValidationError(
      'security_violation',
      'workerSpec.question',
      'Worker specification question must match the approved task question.',
    )
  }
  return {
    capability: DEEP_RESEARCH_WORKER_CAPABILITY,
    task: params.task,
    workerSpec,
    workerSpecHash: hashResearchValue(workerSpec),
  }
}

export function hashResearchValue(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalizeResearchValue(value)))
    .digest('hex')
}

export function canonicalizeResearchValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeResearchValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeResearchValue(entry)]),
  )
}
