import type { ResearchPlan, ResearchWorkerSpec } from '../../contracts/deep-research.js'
import { resolveResearchCoverageRequirements } from './deep-research-coverage.js'
import { resolveResearchMethodCards } from './deep-research-method-cards.js'

export const RESEARCH_PROMPT_TOKEN_LIMITS = Object.freeze({
  assignment: 750,
  methodCards: 600,
  domainSlice: 1_000,
  dependencyDigest: 400,
})

export class ResearchPromptBudgetError extends Error {
  constructor(
    readonly section: keyof typeof RESEARCH_PROMPT_TOKEN_LIMITS,
    readonly estimatedTokens: number,
    readonly maximumTokens: number,
    readonly workerSpecId?: string,
  ) {
    super(`Research prompt ${section} exceeds its ${maximumTokens}-token limit.`)
    this.name = 'ResearchPromptBudgetError'
  }
}

/**
 * Deliberately not `core/context-tokens.ts`, and deliberately still four.
 *
 * Everywhere else in the system a token estimate feeds a budget: it decides how
 * much to send, and being slightly wrong makes a prompt slightly shorter. Here
 * it feeds a *gate*. `assertResearchPlanPromptBudgets` throws
 * `ResearchPromptBudgetError` against the fixed section limits below, at plan
 * validation time, before any model has been chosen.
 *
 * So moving to the shared 3.5 ratio is not a refactor. It raises every
 * measurement by about 14%, and any section currently sitting between roughly
 * 656 and 750 tokens would begin failing validation on plans that validate
 * today. The four section limits would have to be recalibrated by 8/7 in the
 * same change.
 *
 * Left alone until a measured estimate-to-reported ratio exists to recalibrate
 * against. The shared ratio is part of
 * `docs/adr/2026-09-12-Unified-Context-Budget-Registry.md`.
 */
export function estimateResearchPromptTokens(value: string): number {
  if (!value) return 0
  return Math.ceil(Buffer.byteLength(value, 'utf8') / 4)
}

export function serializeResearchAssignment(
  workerSpec: ResearchWorkerSpec,
): string {
  return JSON.stringify({
    id: workerSpec.id,
    laneId: workerSpec.laneId,
    sectionId: workerSpec.sectionId,
    displayRole: workerSpec.displayRole,
    domain: workerSpec.domain,
    lens: workerSpec.lens,
    specialistStance: workerSpec.specialistStance,
    question: workerSpec.question,
    decisionUse: workerSpec.decisionUse,
    workingDefinitions: workerSpec.workingDefinitions,
    sourceRequirements: workerSpec.sourceRequirements,
    coverageRequirements: resolveResearchCoverageRequirements(workerSpec),
    prohibitedAssumptions: workerSpec.prohibitedAssumptions,
    stopRule: workerSpec.stopRule,
    limits: workerSpec.limits,
  })
}

export function assertResearchPlanPromptBudgets(plan: ResearchPlan): void {
  for (const workerSpec of plan.workerSpecs) {
    enforceResearchPromptBudget(
      'assignment',
      serializeResearchAssignment(workerSpec),
      workerSpec.id,
    )
    enforceResearchPromptBudget(
      'methodCards',
      JSON.stringify(resolveResearchMethodCards(workerSpec.methodCardIds)),
      workerSpec.id,
    )
  }
}

export function enforceResearchPromptBudget(
  section: keyof typeof RESEARCH_PROMPT_TOKEN_LIMITS,
  value: string,
  workerSpecId?: string,
): number {
  const estimatedTokens = estimateResearchPromptTokens(value)
  const maximumTokens = RESEARCH_PROMPT_TOKEN_LIMITS[section]
  if (estimatedTokens > maximumTokens) {
    throw new ResearchPromptBudgetError(
      section,
      estimatedTokens,
      maximumTokens,
      workerSpecId,
    )
  }
  return estimatedTokens
}
