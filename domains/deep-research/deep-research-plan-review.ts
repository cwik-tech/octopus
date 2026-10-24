import { randomUUID } from 'node:crypto'

import type { ResearchPlan } from '../../contracts/deep-research.js'
import type {
  DeepResearchPlanFinding,
  DeepResearchPlanningRevision,
  DeepResearchPlanningRoute,
} from '../../contracts/deep-research-planning.js'
import {
  hashUnapprovedResearchPlan,
} from './deep-research-approval.js'
import { hashResearchValue } from './deep-research-worker-policy.js'

export { diffResearchPlans } from '../../contracts/deep-research-planning.js'

export function createInitialDeepResearchPlanningRevision(
  createdAt = new Date().toISOString(),
): DeepResearchPlanningRevision {
  return {
    schemaVersion: 1,
    planningRevisionId: `planning-revision-${randomUUID()}`,
    revisionNumber: 1,
    origin: 'initial',
    requiresSolReview: false,
    amendmentMessageIds: [],
    createdAt,
  }
}

export function createAmendedDeepResearchPlanningRevision(params: {
  previous: DeepResearchPlanningRevision | undefined
  previousPlan: ResearchPlan | undefined
  previousProposalHash: string | undefined
  messageId: string
  createdAt?: string
}): DeepResearchPlanningRevision {
  const sourceSnapshot = verifiedSourceSnapshot(
    params.previousPlan,
    params.previousProposalHash,
  ) ?? params.previous?.sourceProposalSnapshot
  const sourceProposalHash = sourceSnapshot
    ? params.previousProposalHash ?? params.previous?.sourceProposalHash
    : undefined
  return {
    schemaVersion: 1,
    planningRevisionId: `planning-revision-${randomUUID()}`,
    revisionNumber: (params.previous?.revisionNumber ?? 0) + 1,
    origin: 'user_amendment',
    requiresSolReview: true,
    ...(sourceSnapshot && sourceProposalHash
      ? {
          sourcePlanId:
            params.previous?.sourcePlanId ?? sourceSnapshot.planId,
          sourceProposalHash,
          sourceProposalSnapshot: sourceSnapshot,
        }
      : {}),
    amendmentMessageIds: [
      ...(params.previous?.amendmentMessageIds ?? []),
      params.messageId,
    ],
    createdAt: params.createdAt ?? new Date().toISOString(),
  }
}

export function classifyDeepResearchPlanningRoute(params: {
  revision: DeepResearchPlanningRevision
  draftFailure?: 'blocking_findings' | 'timeout' | 'unusable_output'
}): DeepResearchPlanningRoute {
  if (params.revision.requiresSolReview) return 'sol_amendment_review'
  if (params.draftFailure === 'timeout') return 'sol_timeout_fallback'
  if (
    params.draftFailure === 'blocking_findings' ||
    params.draftFailure === 'unusable_output'
  ) {
    return 'sol_validation_fallback'
  }
  return 'terra_only'
}

export function hasBlockingResearchPlanFindings(
  findings: readonly DeepResearchPlanFinding[],
): boolean {
  return findings.some((finding) => finding.severity === 'blocking')
}

export function hashResearchPlanReviewContent(plan: ResearchPlan): string {
  const {
    planId: _planId,
    approvedAt: _approvedAt,
    approvalHash: _approvalHash,
    ...reviewContent
  } = plan
  return hashResearchValue(reviewContent)
}

function verifiedSourceSnapshot(
  plan: ResearchPlan | undefined,
  proposalHash: string | undefined,
): ResearchPlan | undefined {
  if (!plan || !proposalHash) return undefined
  try {
    return hashUnapprovedResearchPlan(plan) === proposalHash
      ? structuredClone(plan)
      : undefined
  } catch {
    return undefined
  }
}
