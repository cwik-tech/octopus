import type { DeepResearchSettingsValues } from './deep-research-settings.js'

type JsonRecord = Record<string, unknown>

/**
 * Canonicalize fields owned by the runtime before strict plan validation.
 * The model still owns research meaning; the runtime owns executable identity,
 * trusted worker identity, mirrored references, and configured limits.
 */
export function normalizeGeneratedResearchPlan(params: {
  readonly value: unknown
  readonly sessionId: string
  readonly settings: DeepResearchSettingsValues
}): unknown {
  if (!isRecord(params.value) || !isRecord(params.value.request)) {
    return params.value
  }

  const plan = withoutKeys(params.value, ['approvedAt', 'approvalHash'])
  const request = params.value.request
  const maxDurationMinutes = normalizedLimit(
    [plan.maxDurationMinutes, request.maxDurationMinutes],
    params.settings.maxDurationMinutes,
    5,
  )
  const maxResearcherAgents = normalizedLimit(
    [plan.maxResearcherAgents, request.maxResearcherAgents],
    params.settings.maxResearcherAgents,
    1,
  )
  const tasks = normalizeTasks(plan.tasks)
  const sections = normalizeSections(plan.sections, tasks)
  const workerSpecs = normalizeWorkerSpecs(
    plan.workerSpecs,
    tasks,
    maxDurationMinutes,
  )
  const requestId = `request-${params.sessionId}`
  const executionPolicy = normalizeExecutionPolicy({
    value: plan.executionPolicy,
    taskCount: Array.isArray(tasks) ? tasks.length : 0,
    sectionCount: Array.isArray(sections) ? sections.length : 0,
    maxDurationMinutes,
    maxResearcherAgents,
  })

  return {
    ...plan,
    planId: `proposal-${params.sessionId}`,
    requestId,
    request: {
      ...request,
      requestId,
      desiredSections: sectionTitles(sections, request.desiredSections),
      authenticatedDomains: [],
      maxDurationMinutes,
      maxResearcherAgents,
      outputFormats: ['markdown', 'docx'],
    },
    sections,
    tasks,
    workerSpecs,
    maxDurationMinutes,
    maxResearcherAgents,
    expectedPeakWorkers: normalizedExpectedPeakWorkers(
      plan.expectedPeakWorkers,
      maxResearcherAgents,
      workerSpecs,
    ),
    authenticatedDomains: [],
    executionPolicy,
  }
}

function normalizeExecutionPolicy(params: {
  value: unknown
  taskCount: number
  sectionCount: number
  maxDurationMinutes: number
  maxResearcherAgents: number
}): JsonRecord {
  const policy = isRecord(params.value) ? params.value : {}
  const evidenceTargets = isRecord(policy.evidenceTargets)
    ? policy.evidenceTargets
    : {}
  const stopping = isRecord(policy.stopping) ? policy.stopping : {}
  const synthesis = isRecord(policy.synthesis) ? policy.synthesis : {}
  const derivedComplexity = params.taskCount <= 2 &&
      params.sectionCount <= 2 &&
      params.maxDurationMinutes <= 20
    ? 'simple'
    : params.taskCount >= 5 ||
        params.sectionCount >= 4 ||
        params.maxDurationMinutes >= 60
      ? 'complex'
      : 'standard'
  const complexity = oneOf(
    policy.complexity,
    ['simple', 'standard', 'complex'] as const,
    derivedComplexity,
  )
  const searchBreadth = oneOf(
    policy.searchBreadth,
    ['focused', 'balanced', 'broad'] as const,
    complexity === 'simple'
      ? 'focused'
      : complexity === 'complex'
        ? 'broad'
        : 'balanced',
  )
  const crossVerifyConsequentialClaims =
    typeof evidenceTargets.crossVerifyConsequentialClaims === 'boolean'
      ? evidenceTargets.crossVerifyConsequentialClaims
      : complexity !== 'simple'
  const mode = oneOf(
    synthesis.mode,
    ['single_pass', 'section_dossiers'] as const,
    complexity === 'complex' && params.sectionCount > 1
      ? 'section_dossiers'
      : 'single_pass',
  )

  return {
    schemaVersion: 1,
    complexity,
    complexityRationale: boundedPolicyText(
      policy.complexityRationale,
      `Runtime classified ${params.taskCount} evidence lanes across ` +
        `${params.sectionCount} report sections within a ` +
        `${params.maxDurationMinutes}-minute approved window.`,
    ),
    searchBreadth,
    maxCostUsd: boundedNumber(
      policy.maxCostUsd,
      0.5,
      40,
      Math.min(40, Math.max(2, params.maxDurationMinutes * 0.4)),
      2,
    ),
    evidenceTargets: {
      minimumSupportedClaims: boundedInteger(
        evidenceTargets.minimumSupportedClaims,
        1,
        100,
        Math.max(1, params.taskCount, params.sectionCount * 2),
      ),
      minimumIndependentSourcesPerConsequentialClaim: boundedInteger(
        evidenceTargets.minimumIndependentSourcesPerConsequentialClaim,
        1,
        5,
        crossVerifyConsequentialClaims ? 2 : 1,
      ),
      crossVerifyConsequentialClaims,
    },
    stopping: {
      minimumExpectedInformationGain: boundedInteger(
        stopping.minimumExpectedInformationGain,
        0,
        100,
        complexity === 'simple' ? 55 : complexity === 'complex' ? 30 : 40,
      ),
      maximumCorrectionWaves: boundedInteger(
        stopping.maximumCorrectionWaves,
        0,
        2,
        complexity === 'simple' ? 1 : 2,
      ),
    },
    synthesis: {
      mode,
      maximumParallelSections: boundedInteger(
        synthesis.maximumParallelSections,
        1,
        8,
        Math.max(
          1,
          Math.min(
            params.sectionCount || 1,
            params.maxResearcherAgents,
            complexity === 'complex' ? 4 : 2,
          ),
        ),
      ),
    },
  }
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  fallback: T[number],
): T[number] {
  return typeof value === 'string' && values.includes(value as T[number])
    ? value as T[number]
    : fallback
}

function boundedPolicyText(value: unknown, fallback: string): string {
  const normalized = typeof value === 'string'
    ? value.replace(/\s+/gu, ' ').trim()
    : ''
  return (normalized || fallback).slice(0, 500)
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const candidate = typeof value === 'number' && Number.isInteger(value)
    ? value
    : fallback
  return Math.max(minimum, Math.min(maximum, candidate))
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
  decimals: number,
): number {
  const candidate = typeof value === 'number' && Number.isFinite(value)
    ? value
    : fallback
  const bounded = Math.max(minimum, Math.min(maximum, candidate))
  const multiplier = 10 ** decimals
  return Math.round(bounded * multiplier) / multiplier
}

function normalizeTasks(value: unknown): unknown {
  if (!Array.isArray(value) || !value.every(isRecord)) return value
  const taskIdMap = uniqueStringIdMap(value, (index) => `T${index + 1}`)
  return value.map((task) => ({
    ...task,
    id: taskIdMap?.get(String(task.id)) ?? task.id,
    dependsOn: Array.isArray(task.dependsOn)
      ? task.dependsOn.map((dependency) =>
        typeof dependency === 'string'
          ? taskIdMap?.get(dependency) ?? dependency
          : dependency,
      )
      : task.dependsOn,
    correctionWave: 0,
  }))
}

function normalizeSections(value: unknown, tasks: unknown): unknown {
  if (!Array.isArray(value) || !value.every(isRecord)) return value
  const normalizedTasks = Array.isArray(tasks) && tasks.every(isRecord)
    ? tasks
    : []
  return value.map((section) => ({
    ...section,
    taskIds: normalizedTasks
      .filter((task) => task.sectionId === section.id)
      .map((task) => task.id),
  }))
}

function normalizeWorkerSpecs(
  value: unknown,
  tasks: unknown,
  maxDurationMinutes: number,
): unknown {
  if (!Array.isArray(value) || !value.every(isRecord)) return value
  const normalizedTasks = Array.isArray(tasks) && tasks.every(isRecord)
    ? tasks
    : []
  return value.map((workerSpec) => {
    const task = normalizedTasks.find(
      (candidate) => candidate.workerSpecId === workerSpec.id,
    )
    return {
      ...workerSpec,
      baseAgent: 'web-researcher',
      ...(task
        ? { sectionId: task.sectionId, question: task.question }
        : {}),
      stopRule: normalizeWorkerStopRule(workerSpec.stopRule),
      limits: {
        ...(isRecord(workerSpec.limits) ? workerSpec.limits : {}),
        deadlineMs: normalizedDeadline(
          isRecord(workerSpec.limits)
            ? workerSpec.limits.deadlineMs
            : undefined,
          maxDurationMinutes,
        ),
      },
    }
  })
}

/**
 * A reviewer sometimes expresses an official-source-only lane as requiring
 * zero independent sources. The executable contract requires at least one
 * publisher-control group. Raising exactly zero to one strengthens the
 * evidence requirement without inventing scope; every other malformed value
 * remains untouched for strict validation to reject.
 */
function normalizeWorkerStopRule(value: unknown): unknown {
  if (!isRecord(value) || value.minimumIndependentSources !== 0) return value
  return {
    ...value,
    minimumIndependentSources: 1,
  }
}

function normalizedLimit(
  candidates: readonly unknown[],
  configuredMaximum: number,
  minimum: number,
): number {
  const valid = candidates.filter(
    (candidate): candidate is number =>
      typeof candidate === 'number' &&
      Number.isInteger(candidate) &&
      candidate >= minimum,
  )
  return Math.min(configuredMaximum, ...valid)
}

function normalizedDeadline(value: unknown, maxDurationMinutes: number): number {
  const configuredDeadline = maxDurationMinutes * 60_000
  return Number.isInteger(value) && Number(value) >= 1_000
    ? Math.min(Number(value), configuredDeadline)
    : configuredDeadline
}

function normalizedExpectedPeakWorkers(
  value: unknown,
  maximum: number,
  workerSpecs: unknown,
): number {
  const workerCount = Array.isArray(workerSpecs) ? workerSpecs.length : maximum
  const requested = Number.isInteger(value) && Number(value) >= 1
    ? Number(value)
    : maximum
  return Math.max(1, Math.min(requested, maximum, workerCount || 1))
}

function sectionTitles(sections: unknown, fallback: unknown): unknown {
  if (!Array.isArray(sections) || !sections.every(isRecord)) return fallback
  const titles = sections.map((section) => section.title)
  return titles.every((title) => typeof title === 'string' && title.trim())
    ? titles
    : fallback
}

function uniqueStringIdMap(
  values: readonly JsonRecord[],
  replacement: (index: number) => string,
): Map<string, string> | null {
  const ids = values.map((value) => value.id)
  if (
    !ids.every((id): id is string => typeof id === 'string' && id.length > 0) ||
    new Set(ids).size !== ids.length
  ) {
    return null
  }
  return new Map(ids.map((id, index) => [id, replacement(index)]))
}

function withoutKeys(
  value: JsonRecord,
  keys: readonly string[],
): JsonRecord {
  const result = { ...value }
  for (const key of keys) delete result[key]
  return result
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
