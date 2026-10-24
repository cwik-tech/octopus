import { capabilityDenialUserMessage } from '@contracts/capability-policy-denial'

import { ProcessTimelineTable } from '@/components/process-timeline-table'
import type { ExecutionTimelineItem } from '@/lib/models/runtime-model'

import type { RunEvent, RunEventType, StageRendererProps } from './index'

// ── Mapping helpers ────────────────────────────────────────────────────────

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function eventPayload(event: RunEvent): Record<string, unknown> {
  const payload = event.sourceEnvelope?.payload
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : {}
}

/**
 * Whether the runtime declined this tool call rather than the call breaking.
 *
 * All three gates, because all three write `tool.execution_failed` and the type
 * alone cannot tell them apart: the capability policy sets
 * `blocked_by_capability_policy`, the bypass detector sets
 * `blocked_capability_bypass`, and the governed Pi tools set
 * `blocked_tool_safety`. `ui/src/lib/models/runtime-model.ts` asks the same
 * question of the same payload for the live execution timeline; a gate left out
 * of either reads as a run that broke, in the error red, with its reason
 * discarded.
 */
function isRefusedToolCall(event: RunEvent): boolean {
  if (event.type !== 'tool.execution_failed') return false
  const payload = eventPayload(event)
  return (
    payload.blocked_by_capability_policy === true ||
    payload.blocked_capability_bypass === true ||
    payload.blocked_tool_safety === true
  )
}

function mapKind(event: RunEvent): ExecutionTimelineItem['kind'] {
  // A refusal is not a failure: nothing broke, the runtime said no and the run
  // carried on. Asked before the type switch, because the type it arrives as is
  // the one every failure shares.
  if (isRefusedToolCall(event)) return 'refusal'
  return mapKindFromType(event.type)
}

function mapKindFromType(type: RunEventType): ExecutionTimelineItem['kind'] {
  switch (type) {
    case 'gate.transition':
      return 'run'
    case 'run.failed':
    case 'run.blocked':
    case 'agent.fail':
    case 'tool.execution_failed':
      return 'error'
    case 'agent.start':
    case 'tool.execution_logged':
      return 'delegation'
    case 'artifact.written':
    case 'artifact.delivery_selected':
      return 'artifact'
    default:
      // run.completed | run.session_started | agent.end | provider.* | etc.
      return 'completion'
  }
}

/**
 * The refusal sentence, which is all a reader gets: the table renders the title
 * and nothing else. The policy code and the runtime's own wording stay out of
 * it — one identifies a setting and the other is written for a log, and neither
 * is what a person can act on.
 */
function getRefusalTitle(event: RunEvent): string {
  const payload = eventPayload(event)
  const actor = event.agentName ?? asString(payload.agent_name) ?? 'Workflow'
  const toolLabel = asString(payload.tool_name) ?? 'unknown'
  return [
    `${actor} was not allowed to use ${toolLabel}`,
    capabilityDenialUserMessage(payload.policy_code),
  ].join(' \u00b7 ')
}

function getTitle(event: RunEvent): string {
  if (isRefusedToolCall(event)) return getRefusalTitle(event)
  switch (event.type) {
    case 'run.session_started':
      return 'Session started'
    case 'session_task.workflow_started':
      return 'Workflow started'
    case 'workflow.step.started':
      return event.stageName ? `Step started: ${event.stageName}` : 'Step started'
    case 'workflow.step.completed':
      return event.stageName ? `Step complete: ${event.stageName}` : 'Step complete'
    case 'workflow.step.failed':
      return event.stageName ? `Step failed: ${event.stageName}` : 'Step failed'
    case 'discussion.message':
      return event.agentName ? `${event.agentName}` : 'Discussion message'
    case 'gate.transition':
      return `Stage: ${event.stageName ?? event.stageType ?? 'Transition'}`
    case 'agent.start':
      return event.agentName ? `${event.agentName} starting` : 'Agent starting'
    case 'agent.end':
      return event.agentName ? `${event.agentName} done` : 'Agent done'
    case 'agent.fail':
      return event.agentName ? `${event.agentName} failed` : 'Agent failed'
    case 'agent.skip':
      return event.agentName ? `${event.agentName} skipped` : 'Agent skipped'
    case 'tool.execution_logged':
      return event.content ?? 'Tool executed'
    case 'tool.execution_failed':
      return event.content ?? 'Tool failed'
    case 'artifact.written':
      return event.artifactPath ? `Artifact: ${event.artifactPath}` : 'Artifact written'
    case 'artifact.delivery_selected':
      return event.artifactPath ? `Delivery: ${event.artifactPath}` : 'Delivery selected'
    case 'run.completed':
      return 'Task complete'
    case 'run.failed':
      return event.errorMessage ? `Task failed: ${event.errorMessage}` : 'Task failed'
    case 'run.blocked':
      return event.errorMessage ? `Task blocked: ${event.errorMessage}` : 'Task blocked'
    case 'run.cancelled':
      return 'Task cancelled'
    default:
      return event.content ?? event.type
  }
}

function getDetail(event: RunEvent): string {
  switch (event.type) {
    case 'agent.start':
    case 'agent.end':
    case 'tool.execution_logged':
      return event.content ?? ''
    default:
      return ''
  }
}

function toTimelineItem(event: RunEvent): ExecutionTimelineItem {
  return {
    id: event.id,
    kind: mapKind(event),
    // Use agentId (or agentName) as the 'team' field so the accent colour
    // varies per agent — each unique string gets a deterministic hue.
    team: event.agentId ?? event.agentName ?? null,
    timestamp: new Date(event.ts).toISOString(),
    title: getTitle(event),
    detail: getDetail(event),
    errorText: event.errorMessage ?? null,
    stageType: event.stageType ?? null,
    processStep: event.stageName ?? null,
    levelId: null,
    depth: 0,
    // RunEvent doesn't carry a runId — use an empty string as a no-op value.
    runId: '',
    badges: [
      ...(event.artifactIn ? [`In: ${event.artifactIn}`] : []),
      ...(event.artifactOut ? [`Out: ${event.artifactOut}`] : []),
    ],
    artifactRefs: event.artifactPath
      ? [{ label: event.artifactRole === 'final' ? 'Final' : 'Output', path: event.artifactPath, runId: event.artifactRunId ?? event.runId ?? '' }]
      : [],
  }
}

// ── DefaultRenderer ────────────────────────────────────────────────────────

/**
 * Generic event-list renderer used for unknown stage types.
 * Maps RunEvent[] → ExecutionTimelineItem[] and renders via
 * ProcessTimelineTable. Shows a placeholder when the events array is empty.
 */
export function DefaultRenderer({ events, onOpenArtifact, runId }: StageRendererProps) {
  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
        No events yet
      </div>
    )
  }

  const items = events.map(toTimelineItem)

  return (
    <ProcessTimelineTable
      items={items}
      anchorByIndex={(index) => `stage-event-${index}`}
      isArtifactSelected={() => false}
      onArtifactSelect={(target) => {
        const targetRunId = target.runId || runId
        if (!targetRunId) return
        onOpenArtifact?.({
          artifactPath: target.path,
          runId: targetRunId,
        })
      }}
    />
  )
}
