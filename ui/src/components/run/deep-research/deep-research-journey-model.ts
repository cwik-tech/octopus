import type { RunPlanSelectionSource } from '@/lib/models/session-model'

import type { DeepResearchJourneyPhase } from '@contracts/deep-research-journey'

export type { DeepResearchJourneyPhase } from '@contracts/deep-research-journey'

export type DeepResearchJourneyStageId = DeepResearchJourneyPhase

export type DeepResearchJourneyStageState = 'completed' | 'current' | 'locked' | 'blocked'

/**
 * Structural subset of the runtime-owned journey snapshot needed by the UI.
 * The UI projects this value; it does not advance or persist workflow state.
 */
export interface DeepResearchJourneySnapshotInput {
  correctionWave?: 0 | 1 | 2 | undefined
  phase: DeepResearchJourneyPhase
  researchStatus?: 'blocked' | string | undefined
}

export interface DeepResearchJourneyStage {
  id: DeepResearchJourneyStageId
  label: string
  liveLabel?: string | undefined
  reachable: boolean
  state: DeepResearchJourneyStageState
  stepNumber: number
}

export interface DeepResearchJourneyModel {
  liveStageId: DeepResearchJourneyStageId
  reachedStageCount: number
  stages: DeepResearchJourneyStage[]
  totalStageCount: number
}

export interface DeepResearchJourneyView {
  canReturnToLive: boolean
  isFollowingLive: boolean
  liveStageId: DeepResearchJourneyStageId
  selectedStageId: DeepResearchJourneyStageId
}

export interface DeepResearchWorkspaceSelectionInput {
  latestTaskIsDeepResearch: boolean
  selectedWorkflowId?: string | null | undefined
  /** Who put that Workflow on the plan; only a user's pick opens the journey. */
  selectionSource?: RunPlanSelectionSource | undefined
}

interface JourneyStageDefinition {
  id: DeepResearchJourneyStageId
  label: string
}

const STANDARD_STAGE_DEFINITIONS: readonly JourneyStageDefinition[] = [
  { id: 'planning', label: 'Discuss & Plan' },
  { id: 'research', label: 'Research' },
  { id: 'editorial', label: 'Editorial Review' },
  { id: 'delivery', label: 'Final Documentation' },
]

const ESCALATED_STAGE_DEFINITIONS: readonly JourneyStageDefinition[] = [
  { id: 'planning', label: 'Discuss & Plan' },
  { id: 'research', label: 'Research' },
  { id: 'escalation', label: 'Attention Required' },
  { id: 'editorial', label: 'Editorial Review' },
  { id: 'delivery', label: 'Final Documentation' },
]

/**
 * The user's own workflow selection is authoritative. Task history restores the
 * workspace only when there is no current selection to contradict it.
 *
 * A Coordinator recommendation does not open the Deep Research journey: the
 * workspace is a commitment to a way of working, and proposing one is not the
 * same as choosing it.
 */
export function shouldRenderDeepResearchWorkspace(
  input: DeepResearchWorkspaceSelectionInput,
): boolean {
  if (input.selectedWorkflowId && input.selectionSource === 'user') {
    return input.selectedWorkflowId === 'deep-research-report'
  }
  if (input.selectionSource === 'user') return false
  return input.latestTaskIsDeepResearch
}

/**
 * Builds a read-only navigation projection from the runtime snapshot. A
 * correction wave remains in Research because its authoritative phase does.
 */
export function buildDeepResearchJourneyModel(
  snapshot: DeepResearchJourneySnapshotInput,
): DeepResearchJourneyModel {
  const definitions =
    snapshot.phase === 'escalation'
      ? ESCALATED_STAGE_DEFINITIONS
      : STANDARD_STAGE_DEFINITIONS
  const currentIndex = definitions.findIndex(({ id }) => id === snapshot.phase)
  const stages = definitions.map(({ id, label }, index) => {
    const state: DeepResearchJourneyStageState =
      id === 'research' && snapshot.researchStatus === 'blocked'
        ? 'blocked'
        :
      index < currentIndex
        ? 'completed'
        : index === currentIndex
          ? 'current'
          : 'locked'

    return {
      id,
      label,
      liveLabel: id === 'escalation' ? 'Action Required' : undefined,
      reachable: state !== 'locked',
      state,
      stepNumber: index + 1,
    }
  })

  return {
    liveStageId: snapshot.phase,
    reachedStageCount: currentIndex + 1,
    stages,
    totalStageCount: stages.length,
  }
}

/**
 * Resolves local browsing without mutating workflow progress. Missing, hidden,
 * and locked selections follow the authoritative live stage.
 */
export function resolveDeepResearchJourneyView(
  model: DeepResearchJourneyModel,
  requestedStageId?: DeepResearchJourneyStageId | null,
): DeepResearchJourneyView {
  const requestedStage = model.stages.find(
    ({ id }) => id === requestedStageId,
  )
  const selectedStageId = requestedStage?.reachable
    ? requestedStage.id
    : model.liveStageId
  const isFollowingLive = selectedStageId === model.liveStageId

  return {
    canReturnToLive: !isFollowingLive,
    isFollowingLive,
    liveStageId: model.liveStageId,
    selectedStageId,
  }
}
