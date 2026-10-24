import type { ModelSelectionRecord } from "@contracts/agent-model-selection"
import type { FC } from 'react'

import { DefaultRenderer } from './default'
import { DiscussionRenderer } from './discussion'
import { PipelineRenderer } from './pipeline'
import type { EngineEventEnvelope } from '@/lib/models/runtime-model'
import type { ProviderErrorKind } from '@contracts/provider'

// ── RunEvent types ─────────────────────────────────────────────────────────
// Defined locally; mirrors domains/sessions/run-event-types.ts (created by T1).
// ui/tsconfig.app.json only includes src/ — cannot import from outside that
// boundary. These types reflect actual engine event type strings emitted by
// the /runs/:id/events SSE endpoint. The trailing (string & {}) allows
// unknown future event types to pass type-checking while preserving autocomplete.

export type RunEventType =
  // Run lifecycle
  | 'run.session_started'
  | 'run.completed'
  | 'run.failed'
  | 'run.blocked'
  | 'run.cancelled'
  | 'run.incomplete'
  // Workflow / session task events
  | 'session_task.workflow_started'
  | 'workflow.step.started'
  | 'workflow.step.completed'
  | 'workflow.step.failed'
  /** The run stopped and released its worker to ask which model may be used. */
  | 'run.awaiting_model_choice'
  | 'discussion.message'
  /** One accepted Team contribution, whatever engine produced it. */
  | 'team.message'
  // Agent lifecycle
  | 'agent.start'
  | 'agent.end'
  | 'agent.fail'
  | 'agent.skip'
  // Host (agentic loop) lifecycle
  | 'host.agent_start'
  | 'host.agent_end'
  // Provider / model call lifecycle
  | 'provider.request.start'
  | 'provider.request.end'
  // Tool execution
  | 'tool.execution_logged'
  | 'tool.execution_failed'
  | 'research.acquisition.completed'
  // Gate / level / stage transitions (stage:start equivalent)
  | 'gate.transition'
  // Artifact events
  | 'artifact.written'
  | 'artifact.delivery_selected'
  // Open-ended catch-all for unknown future types
  | (string & {})

/** The reasons a blocked run can state. */
export const RUN_BLOCKED_CAUSES = ['review_exhausted'] as const

export type RunBlockedCause = (typeof RUN_BLOCKED_CAUSES)[number]

export function isRunBlockedCause(value: unknown): value is RunBlockedCause {
  return RUN_BLOCKED_CAUSES.some((candidate) => candidate === value)
}

export interface RunEvent {
  id: string
  type: RunEventType
  ts: number
  runId?: string | undefined
  stageType?: 'discussion' | 'pipeline' | string | undefined
  stageName?: string | undefined
  agentId?: string | undefined
  agentName?: string | undefined
  agentActivity?: 'selecting-team-members' | undefined
  participants?: string[] | undefined
  /**
   * The concrete attempt that emitted this event.
   *
   * One live bubble belongs to one dispatch, so this is what binds streamed
   * text to a speaker and lets a retry supersede the attempt before it.
   */
  dispatchId?: string | undefined
  /**
   * The delegation this event belongs to, when it is one.
   *
   * Kept so a delegation's own facts — such as which model named its job — can
   * be attributed to the delegation rather than to whichever participant
   * happened to be speaking.
   */
  delegationId?: string | undefined
  /**
   * Which of the application's own background helpers this event is about.
   *
   * Kept for the same reason, and so a notice can say what the work was rather
   * than only that the application default was used for something.
   */
  helper?: string | undefined
  /**
   * The logical step this attempt belongs to.
   *
   * Stable across a retry and across a fallback to a different agent, which is
   * what lets a later attempt replace the bubble of the one before it.
   */
  logicalInvocationId?: string | undefined
  /**
   * The run's display-only text channel.
   *
   * Not a credential: reading it still requires the session that owns it. It
   * is here so the UI can find the stream from the run it is already watching.
   */
  textChannelId?: string | undefined
  model?: string | undefined
  provider?: string | undefined
  /**
   * How this attempt's pair was decided, as the run recorded it.
   *
   * Absent for runs recorded before provenance existed; a reader shows that as
   * unrecorded rather than reconstructing it from today's settings.
   */
  modelSelection?: ModelSelectionRecord | undefined
  /**
   * Which host turn this event belongs to.
   *
   * The runtime's own turn counter, held for the life of one outer turn. It is
   * what tells two events about one host turn from two turns — without it a
   * replayed history looks like more work than actually happened.
   */
  coordinatorRunId?: number | undefined
  /**
   * Which host process the turn belongs to.
   *
   * `coordinatorRunId` restarts at 0 in every host process, and a recovered run
   * keeps its session id — so the turn before a crash and the first turn after
   * it arrive as the same run's turn 1. Only this tells them apart.
   */
  hostInstanceId?: string | undefined
  content?: string | undefined
  /**
   * Stable identity of a durable Team message.
   *
   * The same message reaches the UI more than once — a snapshot and then the
   * live stream — so the projection needs something other than delivery order
   * to recognise the second copy.
   */
  messageId?: string | undefined
  round?: number | undefined
  messageType?:
    | 'framing'
    | 'position'
    | 'probe'
    | 'synthesis'
    | 'error'
    | (string & {})
    | undefined
  stepIndex?: number | undefined
  artifactIn?: string | undefined
  artifactOut?: string | undefined
  /**
   * Run id of the child run a workflow step delegated to. Present on
   * `workflow.step.completed` events (mapped from payload.child_run_id).
   * Pipeline step artifacts (input/output) live in this child run's directory,
   * not the parent run — the badge must fetch from here to avoid a 404.
   */
  childRunId?: string | undefined
  artifactPath?: string | undefined
  artifactRunId?: string | undefined
  artifactRole?: 'input' | 'intermediate' | 'final' | 'wrapper' | string | undefined
  /** Runtime artifact metadata from `artifact.written`. */
  artifactType?: string | undefined
  /** Completion/approval status from `artifact.written`, when supplied. */
  artifactStatus?: string | undefined
  /** Human-readable artifact title from `artifact.written`, when supplied. */
  artifactTitle?: string | undefined
  acquisitionActivityId?: string | undefined
  acquisitionSourceKey?: string | undefined
  acquisitionIssueKind?:
    | 'none'
    | 'blocked'
    | 'rate-limited'
    | 'limited'
    | 'failed'
    | 'recovered'
    | 'ignored'
    | undefined
  acquisitionUsable?: boolean | undefined
  /**
   * Search capability absence under a discovery-requiring plan
   * (`research.search_capability.blocked`). An operator action, deliberately
   * separate from per-source acquisition issues.
   */
  searchCapabilityBlocked?: boolean | undefined
  searchCapabilityRemediation?: string | undefined
  searchCapabilityProviderPriority?: readonly string[] | undefined
  /** Why every discovery attempt produced nothing, by recorded code. */
  searchCapabilityFailureCodes?: readonly string[] | undefined
  /** One sentence naming what actually failed, as the runtime recorded it. */
  searchCapabilityCause?: string | undefined
  errorMessage?: string | undefined
  /**
   * Why the provider refused, when a failed agent run said so.
   *
   * `errorMessage` carries whatever the runtime threw, which can include a
   * child's stderr and absolute paths, so chat deliberately never shows it.
   * This is the closed union chat can safely turn into a sentence.
   */
  providerFailureKind?: ProviderErrorKind | undefined
  /**
   * Why a run is blocked, when the runtime could name it.
   *
   * A closed set, never a message. The raw error can carry a child's stderr,
   * an absolute path or a token, so what the user reads is written here from
   * this value rather than echoed from the run.
   */
  blockedCause?: RunBlockedCause | undefined
  executionAttemptId?: string | undefined
  /** Original runtime event retained for execution-wide timeline projection. */
  sourceEnvelope?: EngineEventEnvelope | undefined
}

export interface ArtifactPreviewTarget {
  artifactPath: string
  runId: string
}

// ── Stage Renderer contract (Contract B in plan.md) ────────────────────────

export interface StageRendererProps {
  events: RunEvent[]
  stageType: string
  metadata?: Record<string, unknown>
  onOpenArtifact?: (target: ArtifactPreviewTarget) => void
  runId?: string
}

export type StageRendererComponent = FC<StageRendererProps>

// ── Registry ───────────────────────────────────────────────────────────────

const registry: Record<string, StageRendererComponent> = {
  default: DefaultRenderer,
  discussion: DiscussionRenderer,
  pipeline: PipelineRenderer,
}

/**
 * Returns the renderer component for the given stage type.
 * Falls back to DefaultRenderer for any unrecognised stageType.
 */
export function getRenderer(stageType: string): StageRendererComponent {
  return registry[stageType] ?? DefaultRenderer
}
