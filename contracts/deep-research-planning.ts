import type { ResearchPlan } from './deep-research.js'
import { isThinkingLevel, type ThinkingLevel } from './thinking-levels.js'

export type DeepResearchPlanningRevisionOrigin =
  | 'initial'
  | 'user_amendment'

export interface DeepResearchPlanningRevision {
  schemaVersion: 1
  planningRevisionId: string
  revisionNumber: number
  origin: DeepResearchPlanningRevisionOrigin
  requiresSolReview: boolean
  sourcePlanId?: string
  sourceProposalHash?: string
  sourceProposalSnapshot?: ResearchPlan
  amendmentMessageIds: string[]
  latestAttemptId?: string
  createdAt: string
}

export type DeepResearchPlanFindingSeverity = 'warning' | 'blocking'

export interface DeepResearchPlanFinding {
  code: string
  severity: DeepResearchPlanFindingSeverity
  field: string
  summary: string
  diagnostic?: string
}

export type DeepResearchPlanningAttemptStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'superseded'

export type DeepResearchPlanningPhase =
  | 'accepted'
  | 'drafting'
  | 'validating_draft'
  | 'reviewing'
  | 'validating_final'
  | 'persisting'
  | 'ready'

export type DeepResearchPlanningRoute =
  | 'terra_only'
  | 'sol_amendment_review'
  | 'sol_validation_fallback'
  | 'sol_timeout_fallback'

export type DeepResearchPlanningErrorCategory =
  | 'cancelled'
  | 'configuration'
  | 'final_validation'
  | 'persistence'
  | 'provider'
  | 'superseded'
  | 'timeout'
  | 'unknown'

export interface DeepResearchPlanningStageTiming {
  startedAt: string
  completedAt?: string
  durationMs?: number
  provider?: string
  model?: string
  thinking?: ThinkingLevel
}

export interface DeepResearchPlanningAttemptSnapshot {
  schemaVersion: 3
  attemptId: string
  planningRevisionId: string
  expectedPlanId: string
  revision: number
  retryCount: number
  status: DeepResearchPlanningAttemptStatus
  phase: DeepResearchPlanningPhase
  route: DeepResearchPlanningRoute
  createdAt: string
  updatedAt: string
  cancellationRequestedAt?: string
  completedAt?: string
  stages: Partial<Record<
    'queue' | 'terra' | 'draft_validation' | 'sol' | 'final_validation' | 'persistence',
    DeepResearchPlanningStageTiming
  >>
  candidates: Partial<Record<
    'terra' | 'sol',
    {
      characters: number
      sha256: string
      truncated: boolean
    }
  >>
  findings: DeepResearchPlanFinding[]
  sourceProposalHash?: string
  finalProposalHash?: string
  finalRunPlanId?: string
  totalDurationMs?: number
  complexityClass?: 'simple' | 'standard' | 'complex'
  reviewOutcome?: 'not_run' | 'affirmed' | 'changed' | 'replaced'
  retryable?: boolean
  errorCategory?: DeepResearchPlanningErrorCategory
  error?: string
}

export interface DeepResearchPlanningEvent {
  sequence: number
  type: 'planning.status'
  timestamp: string
  snapshot: DeepResearchPlanningAttemptSnapshot
}

export interface DeepResearchPlanDiff {
  scope: string[]
  sections: string[]
  tasks: string[]
  workers: string[]
  dependencies: string[]
  budgets: string[]
  sources: string[]
}

const ATTEMPT_STATUSES = new Set<string>([
  'queued',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'superseded',
])
const ATTEMPT_PHASES = new Set<string>([
  'accepted',
  'drafting',
  'validating_draft',
  'reviewing',
  'validating_final',
  'persisting',
  'ready',
])
const ATTEMPT_ROUTES = new Set<string>([
  'terra_only',
  'sol_amendment_review',
  'sol_validation_fallback',
  'sol_timeout_fallback',
])
const ATTEMPT_ERROR_CATEGORIES = new Set<string>([
  'cancelled',
  'configuration',
  'final_validation',
  'persistence',
  'provider',
  'superseded',
  'timeout',
  'unknown',
])
const ATTEMPT_STAGE_NAMES = new Set<string>([
  'queue',
  'terra',
  'draft_validation',
  'sol',
  'final_validation',
  'persistence',
])
const CANDIDATE_NAMES = new Set<string>(['terra', 'sol'])

export function isDeepResearchPlanningRevision(
  value: unknown,
): value is DeepResearchPlanningRevision {
  if (!isRecord(value)) return false
  return (
    value.schemaVersion === 1 &&
    isString(value.planningRevisionId) &&
    Number.isSafeInteger(value.revisionNumber) &&
    Number(value.revisionNumber) > 0 &&
    (value.origin === 'initial' || value.origin === 'user_amendment') &&
    typeof value.requiresSolReview === 'boolean' &&
    isStringArray(value.amendmentMessageIds) &&
    isString(value.createdAt) &&
    isOptionalString(value.sourcePlanId) &&
    isOptionalString(value.sourceProposalHash) &&
    isOptionalString(value.latestAttemptId) &&
    (
      value.sourceProposalSnapshot === undefined ||
      (isRecord(value.sourceProposalSnapshot) &&
        value.sourceProposalSnapshot.schemaVersion === 1)
    )
  )
}

export function isDeepResearchPlanningAttemptSnapshot(
  value: unknown,
): value is DeepResearchPlanningAttemptSnapshot {
  if (!isRecord(value)) return false
  return (
    value.schemaVersion === 3 &&
    isString(value.attemptId) &&
    isString(value.planningRevisionId) &&
    isString(value.expectedPlanId) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    Number.isSafeInteger(value.retryCount) &&
    Number(value.retryCount) >= 0 &&
    typeof value.status === 'string' &&
    ATTEMPT_STATUSES.has(value.status) &&
    typeof value.phase === 'string' &&
    ATTEMPT_PHASES.has(value.phase) &&
    typeof value.route === 'string' &&
    ATTEMPT_ROUTES.has(value.route) &&
    isString(value.createdAt) &&
    isString(value.updatedAt) &&
    isOptionalString(value.cancellationRequestedAt) &&
    isStageTimings(value.stages) &&
    isCandidates(value.candidates) &&
    Array.isArray(value.findings) &&
    value.findings.every(isFinding) &&
    isOptionalString(value.completedAt) &&
    isOptionalString(value.sourceProposalHash) &&
    isOptionalString(value.finalProposalHash) &&
    isOptionalString(value.finalRunPlanId) &&
    (
      value.totalDurationMs === undefined ||
      (
        typeof value.totalDurationMs === 'number' &&
        Number.isFinite(value.totalDurationMs) &&
        value.totalDurationMs >= 0
      )
    ) &&
    (
      value.complexityClass === undefined ||
      value.complexityClass === 'simple' ||
      value.complexityClass === 'standard' ||
      value.complexityClass === 'complex'
    ) &&
    (
      value.reviewOutcome === undefined ||
      value.reviewOutcome === 'not_run' ||
      value.reviewOutcome === 'affirmed' ||
      value.reviewOutcome === 'changed' ||
      value.reviewOutcome === 'replaced'
    ) &&
    (
      value.errorCategory === undefined ||
      (
        typeof value.errorCategory === 'string' &&
        ATTEMPT_ERROR_CATEGORIES.has(value.errorCategory)
      )
    ) &&
    isOptionalString(value.error) &&
    (value.retryable === undefined || typeof value.retryable === 'boolean')
  )
}

export function isDeepResearchPlanningEvent(
  value: unknown,
): value is DeepResearchPlanningEvent {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.sequence) &&
    Number(value.sequence) >= 0 &&
    value.type === 'planning.status' &&
    isString(value.timestamp) &&
    isDeepResearchPlanningAttemptSnapshot(value.snapshot)
  )
}

export function isTerminalDeepResearchPlanningStatus(
  status: DeepResearchPlanningAttemptStatus,
): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'superseded'
  )
}

export function diffResearchPlans(
  source: ResearchPlan,
  current: ResearchPlan,
): DeepResearchPlanDiff {
  const scope = [
    ...diffStringSet(
      source.request.includedScope,
      current.request.includedScope,
      'Included scope',
    ),
    ...diffStringSet(
      source.request.excludedScope,
      current.request.excludedScope,
      'Excluded scope',
    ),
    ...diffStringSet(
      source.request.jurisdictions,
      current.request.jurisdictions,
      'Jurisdictions',
    ),
  ]
  if (source.request.question !== current.request.question) {
    scope.unshift('Research question changed')
  }
  if (source.request.objective !== current.request.objective) {
    scope.push('Research objective changed')
  }

  const sections = diffStringSet(
    source.sections.map((section) => section.title),
    current.sections.map((section) => section.title),
    'Sections',
  )
  if (
    source.sections.map((section) => section.title).join('\0') !==
      current.sections.map((section) => section.title).join('\0') &&
    sections.length === 0
  ) {
    sections.push('Section order changed')
  }

  const tasks = diffStringSet(
    source.tasks.map((task) => task.title),
    current.tasks.map((task) => task.title),
    'Tasks',
  )
  if (
    source.tasks.map((task) => task.title).join('\0') !==
      current.tasks.map((task) => task.title).join('\0') &&
    tasks.length === 0
  ) {
    tasks.push('Task order changed')
  }

  const dependencies: string[] = []
  const sourceDependencyCount = dependencyCount(source)
  const currentDependencyCount = dependencyCount(current)
  if (sourceDependencyCount !== currentDependencyCount) {
    dependencies.push(
      `Dependencies: ${sourceDependencyCount} → ${currentDependencyCount}`,
    )
  }

  const budgets: string[] = []
  addNumberChange(
    budgets,
    'Duration limit',
    source.maxDurationMinutes,
    current.maxDurationMinutes,
    'minutes',
  )
  addNumberChange(
    budgets,
    'Researcher limit',
    source.maxResearcherAgents,
    current.maxResearcherAgents,
  )
  addNumberChange(
    budgets,
    'Expected peak workers',
    source.expectedPeakWorkers,
    current.expectedPeakWorkers,
  )
  addNumberChange(
    budgets,
    'Cost cap',
    source.executionPolicy?.maxCostUsd,
    current.executionPolicy?.maxCostUsd,
    'USD',
  )

  return {
    scope,
    sections,
    tasks,
    workers:
      source.workerSpecs.length === current.workerSpecs.length
        ? []
        : [
            `Worker assignments: ${source.workerSpecs.length} → ${current.workerSpecs.length}`,
          ],
    dependencies,
    budgets,
    sources: [
      ...diffStringSet(
        source.request.sourceRequirements,
        current.request.sourceRequirements,
        'Global source requirements',
      ),
      ...diffStringSet(
        workerSourceRequirements(source),
        workerSourceRequirements(current),
        'Worker source requirements',
      ),
    ],
  }
}

function diffStringSet(
  before: readonly string[],
  after: readonly string[],
  label: string,
): string[] {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  const added = after.filter((value) => !beforeSet.has(value))
  const removed = before.filter((value) => !afterSet.has(value))
  return [
    ...(added.length ? [`${label} added: ${added.join(', ')}`] : []),
    ...(removed.length ? [`${label} removed: ${removed.join(', ')}`] : []),
  ]
}

function dependencyCount(plan: ResearchPlan): number {
  return plan.tasks.reduce((total, task) => total + task.dependsOn.length, 0)
}

function workerSourceRequirements(plan: ResearchPlan): string[] {
  return plan.workerSpecs.flatMap((worker) => [
    ...worker.sourceRequirements.preferredTypes.map(
      (type) => `preferred:${type}`,
    ),
    ...worker.sourceRequirements.requiredAuthorityTypes.map(
      (type) => `authority:${type}`,
    ),
  ])
}

function addNumberChange(
  target: string[],
  label: string,
  before: number | undefined,
  after: number | undefined,
  unit?: string,
): void {
  if (before === after) return
  const suffix = unit ? ` ${unit}` : ''
  target.push(`${label}: ${before ?? 'none'} → ${after ?? 'none'}${suffix}`)
}

function isFinding(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.code) &&
    (value.severity === 'warning' || value.severity === 'blocking') &&
    isString(value.field) &&
    isString(value.summary) &&
    isOptionalString(value.diagnostic)
  )
}

function isStageTimings(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Object.entries(value).every(([stage, timing]) =>
    ATTEMPT_STAGE_NAMES.has(stage) &&
    isRecord(timing) &&
    isString(timing.startedAt) &&
    isOptionalString(timing.completedAt) &&
    (
      timing.durationMs === undefined ||
      (
        typeof timing.durationMs === 'number' &&
        Number.isFinite(timing.durationMs) &&
        timing.durationMs >= 0
      )
    ) &&
    isOptionalString(timing.provider) &&
    isOptionalString(timing.model) &&
    (timing.thinking === undefined || isThinkingLevel(timing.thinking)),
  )
}

function isCandidates(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Object.entries(value).every(([stage, candidate]) =>
    CANDIDATE_NAMES.has(stage) &&
    isRecord(candidate) &&
    Number.isSafeInteger(candidate.characters) &&
    Number(candidate.characters) >= 0 &&
    isString(candidate.sha256) &&
    /^[a-f0-9]{64}$/u.test(candidate.sha256) &&
    typeof candidate.truncated === 'boolean',
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value)
}
