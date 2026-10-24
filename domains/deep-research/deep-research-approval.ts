import type { ResearchPlan } from '../../contracts/deep-research.js'
import {
  DeepResearchValidationError,
  parseResearchPlan,
} from './deep-research-validation.js'
import {
  assertResearchPlanPromptBudgets,
  ResearchPromptBudgetError,
} from './deep-research-prompt-budget.js'
import { hashResearchValue } from './deep-research-worker-policy.js'

export function hashUnapprovedResearchPlan(value: unknown): string {
  const plan = parseResearchPlan(value)
  return hashResearchValue(withoutApproval(plan))
}

export function approveResearchPlan(
  value: unknown,
  approvedAt = new Date().toISOString(),
): ResearchPlan {
  const plan = parseResearchPlan(value)
  try {
    assertResearchPlanPromptBudgets(plan)
  } catch (error) {
    if (error instanceof ResearchPromptBudgetError) {
      const remediation = error.section === 'methodCards'
        ? 'Select fewer applicable method cards before approval.'
        : 'Shorten duplicated assignment guidance before approval.'
      throw new DeepResearchValidationError(
        'invalid_value',
        `plan.workerSpecs.${error.workerSpecId ?? 'unknown'}${error.section === 'methodCards' ? '.methodCardIds' : ''}`,
        `${error.message} ${remediation}`,
      )
    }
    throw error
  }
  const approvalHash = hashResearchValue(withoutApproval(plan))
  return parseResearchPlan({
    ...withoutApproval(plan),
    approvedAt,
    approvalHash,
  })
}

export function isResearchPlanApprovalValid(value: unknown): boolean {
  let plan: ResearchPlan
  try {
    plan = parseResearchPlan(value)
  } catch {
    return false
  }
  return Boolean(
    plan.approvedAt &&
    plan.approvalHash &&
    plan.approvalHash === hashResearchValue(withoutApproval(plan)),
  )
}

export function assertResearchPlanApproved(value: unknown): ResearchPlan {
  const plan = parseResearchPlan(value)
  if (!isResearchPlanApprovalValid(plan)) {
    throw new DeepResearchValidationError(
      'security_violation',
      'plan.approvalHash',
      'Research plan is unapproved or changed after approval.',
    )
  }
  return plan
}

function withoutApproval(
  plan: ResearchPlan,
): Omit<ResearchPlan, 'approvedAt' | 'approvalHash'> {
  const { approvedAt: _approvedAt, approvalHash: _approvalHash, ...unapproved } = plan
  return unapproved
}
