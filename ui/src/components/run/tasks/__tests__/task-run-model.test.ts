import { describe, expect, it } from 'vitest'

import { describeSearchCapabilityStatus, toRunEvent, toTaskRunEntry } from '../task-run-model'
import type { EngineEventEnvelope } from '@/lib/models/runtime-model'

function envelope(
  type: string,
  payload: Record<string, unknown>,
): EngineEventEnvelope {
  return {
    schema_version: 1,
    timestamp: '2026-07-21T12:00:00.000Z',
    tenant_id: 'local',
    category: 'agent',
    type,
    run_id: 'child-run',
    root_run_id: 'root-run',
    team: 'review-team',
    level_id: 'review',
    stage_type: 'discussion',
    payload,
  }
}

describe('toRunEvent workflow chat fields', () => {
  it('maps agent speech and preserves the source envelope for diagnostics', () => {
    const source = envelope('discussion.message', {
      agent_id: 'critic-id',
      agent_name: 'Critic',
      message_type: 'position',
      round: 2,
      text: 'The market assumptions need stronger evidence.',
    })
    const event = toRunEvent('event-1', source)

    expect(event).toMatchObject({
      id: 'event-1',
      runId: 'child-run',
      agentId: 'critic-id',
      agentName: 'Critic',
      content: 'The market assumptions need stronger evidence.',
      messageType: 'position',
      round: 2,
    })
    expect(event.sourceEnvelope).toBe(source)
  })

  it('carries a recognized provider failure kind off a failed agent run', () => {
    expect(toRunEvent('failure', envelope('agent.fail', {
      agent_name: 'Youtube Extractor',
      provider_failure_kind: 'usage_limit',
      status: 'Parent worker turn failed.',
    })).providerFailureKind).toBe('usage_limit')
  })

  it('ignores a provider failure kind this build does not define', () => {
    expect(toRunEvent('failure', envelope('agent.fail', {
      agent_name: 'Youtube Extractor',
      provider_failure_kind: 'quota_exhausted_visit_example_com',
    })).providerFailureKind).toBeUndefined()
  })

  it('ignores a provider failure kind on an event that is not an agent failure', () => {
    // Reading it from any payload would let an unrelated event with a matching
    // string claim a diagnosis the runtime never made.
    expect(toRunEvent('start', envelope('agent.start', {
      agent_name: 'Youtube Extractor',
      provider_failure_kind: 'usage_limit',
    })).providerFailureKind).toBeUndefined()
  })

  it('carries a recognized blocked cause off a blocked run', () => {
    expect(toRunEvent('blocked', envelope('run.blocked', {
      blocked_cause: 'review_exhausted',
      error: 'Child stage blocked. Assignment: /Users/example/private/run',
    })).blockedCause).toBe('review_exhausted')
  })

  it('ignores a blocked cause this build does not define', () => {
    expect(toRunEvent('blocked', envelope('run.blocked', {
      blocked_cause: 'reviewer_went_to_lunch',
    })).blockedCause).toBeUndefined()
  })

  it('ignores a blocked cause on an event that is not a blocked run', () => {
    // Reading it from any payload would let an unrelated event claim a
    // diagnosis the runtime never made, and the chat writes user-facing words
    // from this value.
    expect(toRunEvent('failure', envelope('run.failed', {
      blocked_cause: 'review_exhausted',
    })).blockedCause).toBeUndefined()
  })

  it('uses agent failure status as the error when no explicit error exists', () => {
    expect(toRunEvent('failure', envelope('agent.fail', {
      agent_name: 'Critic',
      status: 'Provider unavailable',
    })).errorMessage).toBe('Provider unavailable')
  })

  it('prefers the exact runtime display role over the base agent name', () => {
    const event = toRunEvent('research-agent', envelope('agent.start', {
      agent_id: 'flavor-uniqueness',
      agent_name: 'web-researcher',
      agent_display_name: 'Flavor Uniqueness Analyst',
      model: 'gpt-5.4',
      provider: 'openai',
    }))

    expect(event.agentId).toBe('flavor-uniqueness')
    expect(event.agentName).toBe('Flavor Uniqueness Analyst')
    expect(event.model).toBe('gpt-5.4')
    expect(event.provider).toBe('openai')
  })

  it('identifies coordinator selection activity from the runtime boundary', () => {
    const event = toRunEvent('coordinator', envelope('agent.start', {
      agent_name: 'deal-evaluator',
      trigger_tool: 'coordinator',
    }))

    expect(event.agentActivity).toBe('selecting-team-members')
  })

  it('maps durable acquisition issue summaries without exposing source URLs', () => {
    const event = toRunEvent('acquisition', envelope(
      'research.acquisition.completed',
      {
        activity_id: 'activity-1',
        source_key: 'opaque-source-key',
        issue_kind: 'recovered',
        usable: true,
      },
    ))

    expect(event).toMatchObject({
      acquisitionActivityId: 'activity-1',
      acquisitionSourceKey: 'opaque-source-key',
      acquisitionIssueKind: 'recovered',
      acquisitionUsable: true,
    })
  })

  it('maps the search capability blocker as an operator action, not a source issue', () => {
    const event = toRunEvent('capability', envelope(
      'research.search_capability.blocked',
      {
        capability: 'search',
        lane_ids: ['lane-1'],
        provider_priority: ['exa', 'brave'],
        remediation: 'Add an Exa or Brave Search API key in acquisition settings.',
      },
    ))

    expect(event.searchCapabilityBlocked).toBe(true)
    expect(event.searchCapabilityRemediation).toBe(
      'Add an Exa or Brave Search API key in acquisition settings.',
    )
    expect(event.searchCapabilityProviderPriority).toEqual(['exa', 'brave'])
  })

  it('carries the recorded discovery failure codes', () => {
    const event = toRunEvent('capability', envelope(
      'research.search_capability.blocked',
      {
        capability: 'search',
        lane_ids: ['lane-1'],
        provider_priority: ['exa', 'brave'],
        failure_codes: ['internal'],
        cause: 'Every recorded search failed (`internal` \u00d75).',
        remediation: 'Clear the recorded discovery failure.',
      },
    ))

    expect(event.searchCapabilityFailureCodes).toEqual(['internal'])
    expect(event.searchCapabilityCause).toBe(
      'Every recorded search failed (`internal` \u00d75).',
    )
  })

  it('ignores failure codes that are not a list of strings', () => {
    const event = toRunEvent('capability', envelope(
      'research.search_capability.blocked',
      {
        capability: 'search',
        lane_ids: ['lane-1'],
        provider_priority: [],
        failure_codes: [{ code: 'internal' }],
        cause: 42,
      },
    ))

    expect(event.searchCapabilityFailureCodes).toBeUndefined()
    expect(event.searchCapabilityCause).toBeUndefined()
  })
})

describe('describeSearchCapabilityStatus', () => {
  it('names a missing credential only when that is the recorded cause', () => {
    expect(describeSearchCapabilityStatus(['not_configured']))
      .toBe('API key missing')
  })

  it.each([
    ['internal'],
    ['no_results'],
    ['access_challenge'],
    ['budget_exhausted'],
  ])('reports %s as a discovery failure rather than a missing key', (code) => {
    expect(describeSearchCapabilityStatus([code])).toBe('No discovery path')
  })

  it('does not claim a missing key when one cause among several is unrelated', () => {
    expect(describeSearchCapabilityStatus(['internal', 'not_configured']))
      .toBe('No discovery path')
  })

  it('falls back to the neutral status when no cause was recorded', () => {
    expect(describeSearchCapabilityStatus(undefined)).toBe('No discovery path')
  })
})

describe('toTaskRunEntry model-choice mode', () => {
  const waitingTask = {
    id: 'task-1',
    sessionId: 'session-1',
    runId: 'run-1',
    workflowId: 'wf-1',
    brief: 'Draft.',
    status: 'awaiting_model_choice' as const,
    createdAt: '2026-09-06T10:00:00.000Z',
    updatedAt: '2026-09-06T10:00:01.000Z',
    cwd: '/tmp/task-1',
    runPath: '/tmp/run-1',
    assignmentPath: '/tmp/assignment-1',
    inputSnapshotPath: '/tmp/input-1',
  }

  it('gives a task awaiting a model choice its own mode', () => {
    // Without its own mode this falls through to `running`, and the pane shows
    // a progress view for a run that is not running and is waiting to be asked
    // a question.
    expect(toTaskRunEntry(waitingTask, []).mode).toBe('awaiting_model_choice')
  })
})
