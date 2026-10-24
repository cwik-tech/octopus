import { describe, expect, it } from 'vitest'

import {
  buildDeepResearchJourneyModel,
  resolveDeepResearchJourneyView,
  shouldRenderDeepResearchWorkspace,
  type DeepResearchJourneyPhase,
  type DeepResearchJourneyStageState,
} from '../deep-research-journey-model'

describe('shouldRenderDeepResearchWorkspace', () => {
  it.each([
    {
      expected: true,
      input: {
        latestTaskIsDeepResearch: false,
        selectedWorkflowId: 'deep-research-report',
        selectionSource: 'user' as const,
      },
      scenario: 'the user selected Deep Research',
    },
    {
      expected: true,
      input: {
        latestTaskIsDeepResearch: true,
        selectedWorkflowId: null,
        selectionSource: undefined,
      },
      scenario: 'there is no selection and the latest task is Deep Research',
    },
    {
      expected: false,
      input: {
        latestTaskIsDeepResearch: true,
        selectedWorkflowId: 'clarify-debate-write',
        selectionSource: 'user' as const,
      },
      scenario: 'a newer explicit workflow selection overrides history',
    },
    {
      expected: false,
      input: {
        latestTaskIsDeepResearch: false,
        selectedWorkflowId: 'deep-research-report',
        selectionSource: 'coordinator' as const,
      },
      scenario: 'the Coordinator only recommended Deep Research',
    },
    {
      expected: false,
      input: {
        latestTaskIsDeepResearch: false,
        selectedWorkflowId: null,
        selectionSource: undefined,
      },
      scenario: 'nothing is selected and no Deep Research task exists',
    },
  ])('returns $expected when $scenario', ({ expected, input }) => {
    expect(shouldRenderDeepResearchWorkspace(input)).toBe(expected)
  })
})

describe('buildDeepResearchJourneyModel', () => {
  it.each<[DeepResearchJourneyPhase, DeepResearchJourneyStageState[]]>([
    ['planning', ['current', 'locked', 'locked', 'locked']],
    ['research', ['completed', 'current', 'locked', 'locked']],
    ['editorial', ['completed', 'completed', 'current', 'locked']],
    ['delivery', ['completed', 'completed', 'completed', 'current']],
  ])(
    'projects the %s phase without showing an escalation stage',
    (phase, expectedStates) => {
      const model = buildDeepResearchJourneyModel({ phase })

      expect(model.liveStageId).toBe(phase)
      expect(model.stages.map(({ id }) => id)).toEqual([
        'planning',
        'research',
        'editorial',
        'delivery',
      ])
      expect(model.stages.map(({ state }) => state)).toEqual(expectedStates)
      expect(model.reachedStageCount).toBe(
        expectedStates.filter((state) => state !== 'locked').length,
      )
      expect(model.totalStageCount).toBe(4)
    },
  )

  it('shows Attention Required only for an authoritative escalation phase', () => {
    const model = buildDeepResearchJourneyModel({ phase: 'escalation' })

    expect(model.stages).toEqual([
      expect.objectContaining({
        id: 'planning',
        reachable: true,
        state: 'completed',
        stepNumber: 1,
      }),
      expect.objectContaining({
        id: 'research',
        reachable: true,
        state: 'completed',
        stepNumber: 2,
      }),
      expect.objectContaining({
        id: 'escalation',
        label: 'Attention Required',
        liveLabel: 'Action Required',
        reachable: true,
        state: 'current',
        stepNumber: 3,
      }),
      expect.objectContaining({
        id: 'editorial',
        reachable: false,
        state: 'locked',
        stepNumber: 4,
      }),
      expect.objectContaining({
        id: 'delivery',
        reachable: false,
        state: 'locked',
        stepNumber: 5,
      }),
    ])
    expect(model.reachedStageCount).toBe(3)
    expect(model.totalStageCount).toBe(5)
  })

  it('keeps Research visibly blocked when Attention Required follows an execution failure', () => {
    const model = buildDeepResearchJourneyModel({
      phase: 'escalation',
      researchStatus: 'blocked',
    })

    expect(model.stages.find(({ id }) => id === 'research')).toEqual(
      expect.objectContaining({ state: 'blocked', reachable: true }),
    )
    expect(model.reachedStageCount).toBe(3)
  })

  it('keeps correction work in the Research stage', () => {
    const model = buildDeepResearchJourneyModel({
      phase: 'research',
      correctionWave: 2,
    })

    expect(model.liveStageId).toBe('research')
    expect(model.stages.find(({ state }) => state === 'current')?.id).toBe(
      'research',
    )
    expect(model.stages.some(({ id }) => id === 'escalation')).toBe(false)
  })
})

describe('resolveDeepResearchJourneyView', () => {
  const model = buildDeepResearchJourneyModel({ phase: 'editorial' })

  it('follows the live stage by default', () => {
    expect(resolveDeepResearchJourneyView(model)).toEqual({
      canReturnToLive: false,
      isFollowingLive: true,
      liveStageId: 'editorial',
      selectedStageId: 'editorial',
    })
  })

  it('allows a reached stage to remain selected while live work continues', () => {
    expect(resolveDeepResearchJourneyView(model, 'planning')).toEqual({
      canReturnToLive: true,
      isFollowingLive: false,
      liveStageId: 'editorial',
      selectedStageId: 'planning',
    })
  })

  it('does not allow navigation to a future locked stage', () => {
    expect(resolveDeepResearchJourneyView(model, 'delivery')).toEqual({
      canReturnToLive: false,
      isFollowingLive: true,
      liveStageId: 'editorial',
      selectedStageId: 'editorial',
    })
  })

  it('drops a stale conditional escalation selection when it is no longer visible', () => {
    expect(resolveDeepResearchJourneyView(model, 'escalation')).toEqual({
      canReturnToLive: false,
      isFollowingLive: true,
      liveStageId: 'editorial',
      selectedStageId: 'editorial',
    })
  })
})
