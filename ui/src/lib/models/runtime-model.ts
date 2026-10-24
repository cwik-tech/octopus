import { readModelSelectionRecord } from '@contracts/agent-model-selection'
import type { ParsedMarkdownArtifact } from '@contracts/artifacts'
import { capabilityDenialUserMessage } from '@contracts/capability-policy-denial'
import type {
  EngineEventCategory,
  EngineEventEnvelope,
} from '@contracts/runtime-events'
import type {
  ExcelPreviewCell,
  ExcelPreviewCellStyle,
  ExcelPreviewSheet,
  ExcelWorkbookPreview,
} from '@contracts/excel-preview'
import type {
  McpAuditEventView,
  McpRunMcpDiagnosticsSnapshot,
  McpToolResultDiagnosticsView,
} from '@contracts/mcp'
import type {
  RunBashRiskEvent,
  RunDelegationLifecycleSnapshot,
  RunDetails,
  RunDiagnosticsSnapshot,
  RunEventsSnapshotResponse,
  RunStatus,
  RunSummary,
  RunsResponse,
  RunTranscriptSnapshot,
} from '@contracts/runs'
import type {
  RunTeamFlow,
  TeamFlowLevel,
  TeamFlowTransition,
} from '@contracts/team-flow'

export type {
  ParsedMarkdownArtifact,
  EngineEventCategory,
  EngineEventEnvelope,
  ExcelPreviewCell,
  ExcelPreviewCellStyle,
  ExcelPreviewSheet,
  ExcelWorkbookPreview,
  McpAuditEventView,
  McpRunMcpDiagnosticsSnapshot,
  McpToolResultDiagnosticsView,
  RunBashRiskEvent,
  RunDelegationLifecycleSnapshot,
  RunDetails,
  RunDiagnosticsSnapshot,
  RunEventsSnapshotResponse,
  RunStatus,
  RunSummary,
  RunsResponse,
  RunTeamFlow,
  RunTranscriptSnapshot,
  TeamFlowLevel,
  TeamFlowTransition,
}

export type RunExecutionState = 'running' | 'waiting' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'incomplete' | 'unknown'

export interface StreamConnectionState {
  status: 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error'
  error: string | null
}

export interface DerivedAgentState {
  name: string
  status: 'active' | 'done' | 'failed' | 'skipped' | 'idle'
  model: string | null
  provider: string | null
  lastEventType: string
  lastSeenAt: string
  levelId: string | null
  stageType: string | null
  runId: string | null
  team: string | null
}

export interface DerivedArtifactState {
  id: string
  path: string
  artifactType: string | null
  runId: string
  team: string | null
  timestamp: string
  title: string | null
}

export interface ExecutionGroup {
  childRunCount: number
  id: string
  jobTitle: string | null
  latestRunId: string
  rootRunId: string
  runs: RunSummary[]
  startedAt: string | null
  status: RunStatus
  team: string | null
  updatedAt: string | null
}

export interface ExecutionRunNode {
  activeAgentNames: string[]
  currentLevelId: string | null
  currentStageType: string | null
  depth: number
  executionState: RunExecutionState
  id: string
  parentRunId: string | null
  runId: string
  startedAt: string | null
  status: RunStatus
  team: string | null
  updatedAt: string | null
}

export interface TimelineArtifactRef {
  label: string
  path: string
  runId: string
}

export interface ExecutionTimelineActor {
  id: string
  name: string
  baseName: string | null
  activityScopeId: string | null
  emitterName: string | null
}

export interface ExecutionTimelineItem {
  artifactRefs: TimelineArtifactRef[]
  badges: string[]
  actor?: ExecutionTimelineActor
  depth: number
  detail: string
  errorText?: string | null
  id: string
  /**
   * `refusal` is its own kind because a refused tool call is neither of the
   * two things the timeline already had. Nothing broke, so it is not an
   * `error` and must not wear the error accent; the runtime did decline
   * something the agent asked for, so it is not an ordinary step either. The
   * row says so in one colour of its own.
   */
  kind: 'run' | 'delegation' | 'artifact' | 'completion' | 'error' | 'refusal'
  levelId: string | null
  processStep?: string | null
  runId: string
  stageType: string | null
  team: string | null
  timestamp: string
  title: string
}

export interface ExecutionProjection {
  agents: DerivedAgentState[]
  artifacts: DerivedArtifactState[]
  categoryCounts: Record<EngineEventCategory, number>
  currentLevelId: string | null
  currentStageType: string | null
  finalArtifactCandidates: DerivedArtifactState[]
  latestTimestamp: string | null
  rawEventCount: number
  runNodes: ExecutionRunNode[]
  story: ExecutionTimelineItem[]
  teamsInvolved: string[]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Timeline work spans three orders of magnitude — sub-second tool calls,
 * multi-minute agents, hour-long videos — so each tier shows the two most
 * significant units. Without the minute and hour tiers an eight-minute agent
 * reads as `486 s` and a feature-length video as `90m 0s`, which the reader
 * has to convert before it means anything.
 */
function formatDurationSeconds(value: unknown): string | null {
  const seconds = asFiniteNumber(value)
  if (seconds === null || seconds < 0) return null
  const rounded = Math.round(seconds)
  if (rounded < 60) return `${rounded}s`
  if (rounded < 3_600) return `${Math.floor(rounded / 60)}m ${rounded % 60}s`
  return `${Math.floor(rounded / 3_600)}h ${Math.floor((rounded % 3_600) / 60)}m`
}

function formatTimelineDuration(value: unknown): string | null {
  const durationMs = asFiniteNumber(value)
  if (durationMs === null || durationMs < 0) return null
  const rounded = Math.round(durationMs)
  if (rounded < 1_000) return `${rounded}ms`
  return formatDurationSeconds(rounded / 1_000)
}

function joinTimelineTitle(base: string, ...details: Array<string | null>): string {
  return [base, ...details].filter((detail): detail is string => Boolean(detail)).join(' · ')
}

function humanizeActorId(value: string): string {
  return value
    .split(/[-_]/u)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

function inferDeepResearchActorId(artifactPath: string | null): string | null {
  if (!artifactPath) return null
  return artifactPath.match(
    /^research\/(?:observations|acquisitions|extractions)\/([^/]+)\//u,
  )?.[1] ?? null
}

function eventActorSeed(payload: Record<string, unknown>): {
  id: string | null
  name: string | null
} {
  const id =
    asString(payload.agent_id) ??
    asString(payload.activity_scope_id) ??
    asString(payload.agent_name)
  const name =
    asString(payload.agent_display_name) ??
    asString(payload.agent_name)
  return { id, name }
}

function resolveTimelineActor(
  payload: Record<string, unknown>,
  actorNamesById: ReadonlyMap<string, string>,
  artifactPath: string | null = null,
): ExecutionTimelineActor | undefined {
  const seed = eventActorSeed(payload)
  const inferredId = inferDeepResearchActorId(artifactPath)
  const id = seed.id ?? inferredId
  if (!id) return undefined
  return {
    id,
    name:
      seed.name ??
      actorNamesById.get(id) ??
      humanizeActorId(id),
    baseName:
      asString(payload.agent_base_name) ??
      (asString(payload.agent_display_name)
        ? asString(payload.agent_name)
        : null),
    activityScopeId:
      asString(payload.activity_scope_id) ??
      inferredId,
    emitterName: asString(payload.emitter_name),
  }
}

function formatProviderModelPair(
  provider: unknown,
  model: unknown,
): string | null {
  const providerName = asString(provider)
  const modelName = asString(model)
  return providerName && modelName ? `${providerName} / ${modelName}` : null
}

function buildRuntimeActivityTimelineItem(params: {
  actor?: ExecutionTimelineActor | undefined
  depth: number
  event: EngineEventEnvelope
  payload: Record<string, unknown>
  runId: string
  team: string | null
}): ExecutionTimelineItem | null {
  const { actor, depth, event, payload, runId, team } = params
  const agentName = actor?.name ?? asString(payload.agent_name)
  const displayTeam = team ?? agentName
  const levelBadges = event.level_id ? [event.level_id] : []
  const eventBadges: string[] = []
  let errorText: string | null = null
  let detail = event.type
  let kind: ExecutionTimelineItem['kind'] = 'completion'
  let title: string

  switch (event.type) {
    case 'session_task.workflow_started':
      title = 'Workflow started'
      break
    case 'workflow.step.started':
      kind = 'delegation'
      title = `Step ${asString(payload.step_id) ?? event.level_id ?? 'unknown'} started`
      break
    case 'workflow.step.completed':
      title = `Step ${asString(payload.step_id) ?? event.level_id ?? 'unknown'} completed`
      break
    case 'workflow.step.failed':
      kind = 'error'
      errorText = asString(payload.error) ?? asString(payload.error_message)
      title = `Step ${asString(payload.step_id) ?? event.level_id ?? 'unknown'} failed`
      break
    case 'run.awaiting_input':
      title = 'Workflow awaiting human input'
      break
    case 'run.awaiting_model_choice': {
      kind = 'delegation'
      const failed = formatProviderModelPair(
        payload.requested_provider,
        payload.requested_model,
      )
      const proposed = formatProviderModelPair(
        payload.proposed_provider,
        payload.proposed_model,
      )
      // The durable record of the decision itself, so the run can still be
      // read after the offer is gone from the pane.
      title = joinTimelineTitle(
        `${agentName ?? 'Agent'} stopped for a model choice`,
        failed === null ? null : `${failed} could not run`,
        proposed === null ? null : `offered ${proposed}`,
      )
      break
    }
    case 'workflow.human_input.requested': {
      const recipients = Array.isArray(payload.recipients) ? payload.recipients.length : 0
      title = recipients === 1
        ? 'Human input requested from 1 participant'
        : `Human input requested from ${recipients} participants`
      break
    }
    case 'workflow.human_input.message': {
      const recipients = payload.recipients
      const recipientLabel = recipients === 'all'
        ? 'Everyone'
        : Array.isArray(recipients)
          ? recipients
            .filter((recipient): recipient is string => typeof recipient === 'string')
            .map(humanizeActorId)
            .join(', ') || 'selected participants'
          : 'selected participants'
      title = `Human feedback sent to ${recipientLabel}`
      break
    }
    case 'workflow.human_input.submitted': {
      const messageCount = asFiniteNumber(payload.message_count) ?? 0
      title = `Human feedback submitted · ${messageCount} ${messageCount === 1 ? 'message' : 'messages'}`
      break
    }
    case 'agent.start': {
      kind = 'delegation'
      const selection = readModelSelectionRecord(payload.model_selection)
      // An approved retry names both pairs: it is the only case where the run
      // used something other than what the Agent asked for, and only because a
      // person agreed to it.
      //
      // Every other use of the application default names the pair too. Most
      // runs are chains and pipelines, where this story is the only account a
      // person reads — there is no discussion roster to fall back on — so a
      // start that said nothing left the run having recorded which model did
      // the work and shown none of it. An Agent that chose its own pair made a
      // choice, and is not described as inheriting one.
      // What this dispatch was for, when it was not the Agent's own turn. The
      // same Agent reflects on the session after a level completes, on the same
      // pair, and both are `agent.start` — so without this a person reads the
      // identical line twice and cannot tell which model use did which work.
      // Present tense, because this is a *start*: the model may still be
      // thinking. "Reflected on the session" would claim finished work on a row
      // that appears the moment the dispatch goes out.
      const started = asString(payload.trigger_tool) === 'experience_reflection'
        ? `${agentName ?? 'Agent'} started a session reflection`
        : `${agentName ?? 'Agent'} started`
      // Default use leads the line. This table renders each row as a truncated
      // single line with the whole string in a tooltip, so a notice placed
      // after the agent and the verb is clipped away — the screen would show a
      // dispatch and say nothing about the model that ran it. The exact pair
      // stays in the row, readable in full on hover.
      title =
        selection?.reason === 'user-approved-retry' &&
        selection.requestedProvider &&
        selection.requestedModel
          ? `App default · ${started} on ${selection.provider} / ${selection.model} · instead of ${selection.requestedProvider} / ${selection.requestedModel}`
          : selection?.source === 'app-default'
            ? `App default · ${started} on ${selection.provider} / ${selection.model}`
            : started
      break
    }
    case 'agent.end':
      title = joinTimelineTitle(
        `${agentName ?? 'Agent'} finished`,
        formatTimelineDuration(payload.duration_ms),
        asString(payload.model),
      )
      break
    case 'agent.fail': {
      kind = 'error'
      const status = asString(payload.status)
      errorText = asString(payload.error)
        ?? asString(payload.error_message)
        ?? (status && status !== 'failed' ? status : null)
      title = `${agentName ?? 'Agent'} failed`
      break
    }
    case 'agent.skip':
      title = `${agentName ?? 'Agent'} skipped`
      break
    case 'tool.execution_logged': {
      const actor = agentName ?? team ?? 'Workflow'
      title = `${actor} used tool ${asString(payload.tool_name) ?? 'unknown'}`
      kind = 'delegation'
      break
    }
    case 'tool.execution_failed': {
      const actor = agentName ?? team ?? 'Workflow'
      const toolLabel = asString(payload.tool_name) ?? 'unknown'
      // All three refusal gates, because all three write this event type and a
      // reader cannot tell them apart. The capability policy sets
      // `blocked_by_capability_policy`; the bypass detector, which refuses
      // before any policy runs, sets `blocked_capability_bypass`; the governed
      // Pi tools, which refuse a destructive command or a path outside the run
      // folder inside the tool adapter, set `blocked_tool_safety`
      // (`team-runtime/index.ts`, `recordRefusedToolCall`). Each gate left out
      // here rendered as "failed using tool" in the error accent with its
      // reason discarded.
      if (
        payload.blocked_by_capability_policy === true ||
        payload.blocked_capability_bypass === true ||
        payload.blocked_tool_safety === true
      ) {
        // A refusal is not a failure: nothing broke, the runtime declined the
        // call. So the title says that and carries the one sentence a reader
        // can act on, because the title is the only field the process timeline
        // table renders. The policy code and the runtime's own prose stay on
        // the item, in the fields kept for diagnostics.
        kind = 'refusal'
        const policyCode = asString(payload.policy_code)
        if (policyCode) eventBadges.push(policyCode)
        detail = asString(payload.reason) ?? detail
        title = joinTimelineTitle(
          `${actor} was not allowed to use ${toolLabel}`,
          capabilityDenialUserMessage(policyCode),
        )
        break
      }
      kind = 'error'
      title = `${actor} failed using tool ${toolLabel}`
      errorText = asString(payload.error) ?? asString(payload.error_message)
      break
    }
    case 'youtube.manual.analysis_fallback': {
      const errorCode = asString(payload.error_code) ?? 'gemini_unavailable'
      eventBadges.push(errorCode)
      if (errorCode === 'gemini_key_missing') {
        kind = 'delegation'
        detail = 'Gemini is not configured; using transcript analysis'
        title = `Transcript analysis selected · ${errorCode}`
      } else {
        kind = 'error'
        errorText = errorCode
        detail = 'Fell back to transcript analysis'
        title = `Gemini analysis failed · ${errorCode}`
      }
      break
    }
    case 'youtube.manual.video_download_started':
      kind = 'delegation'
      title = 'Downloading video'
      break
    case 'youtube.manual.video_downloaded':
      title = joinTimelineTitle(
        'Video downloaded',
        formatByteLength(payload.byte_length),
        formatVideoDimensions(payload.width, payload.height),
        formatDurationSeconds(payload.duration_seconds),
      )
      break
    case 'youtube.manual.key_frames_extraction_started':
      kind = 'delegation'
      title = 'Extracting key frames'
      break
    case 'youtube.manual.key_frames_extracted': {
      const frameCount = asFiniteNumber(payload.frame_count)
      title = joinTimelineTitle(
        'Key frames extracted',
        frameCount === null ? null : `${frameCount} ${frameCount === 1 ? 'frame' : 'frames'}`,
      )
      break
    }
    case 'youtube.manual.manual_publication_started':
      kind = 'delegation'
      title = 'Publishing screenshot-rich manual'
      break
    case 'youtube.manual.manual_markdown_written':
      title = 'Markdown manual created'
      break
    case 'youtube.manual.manual_docx_written':
      title = 'Word manual created'
      break
    case 'youtube.manual.source_video_retained':
      title = 'Source video retained'
      break
    case 'youtube.manual.temporary_media_cleaned':
      title = 'Temporary video cleaned up'
      break
    case 'gate.transition':
      title = `Stage advanced: ${asString(payload.from) ?? 'start'} → ${asString(payload.to) ?? 'next'}`
      break
    default:
      return null
  }

  return {
    artifactRefs: [],
    ...(actor ? { actor } : {}),
    badges: [event.category, ...levelBadges, ...eventBadges],
    depth,
    detail,
    errorText,
    id: `${event.timestamp}:${runId}:activity:${event.type}:${agentName ?? ''}`,
    kind,
    levelId: event.level_id ?? null,
    processStep: asString(payload.step_id),
    runId,
    stageType: event.stage_type ?? null,
    team: displayTeam,
    timestamp: event.timestamp,
    title,
  }
}

/**
 * Media sizes up to the downloader's 4 GiB ceiling — a full-length video is
 * routinely past a gigabyte, and without this tier it reads as `2355.2 MB`.
 * No terabyte tier: the downloader refuses anything that large, so it could
 * never render.
 */
function formatByteLength(value: unknown): string | null {
  const bytes = asFiniteNumber(value)
  if (bytes === null || bytes < 0) return null
  if (bytes < 1_024) return `${Math.round(bytes)} B`
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KB`
  if (bytes < 1_024 ** 3) return `${(bytes / 1_024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1_024 ** 3).toFixed(1)} GB`
}

function formatVideoDimensions(width: unknown, height: unknown): string | null {
  const parsedWidth = asFiniteNumber(width)
  const parsedHeight = asFiniteNumber(height)
  return parsedWidth === null || parsedHeight === null
    ? null
    : `${parsedWidth}×${parsedHeight}`
}

/**
 * A root workflow run and every team it delegates to emit the same `run.*`
 * lifecycle events, so their rows sit next to each other reading identically.
 * Name the run in the title: the Event column truncates and the accent bar
 * alone is too subtle to tell a workflow's completion from its child's.
 */
function formatRunLifecycleTitle(team: string | null, phase: string): string {
  if (!team) return `Run ${phase}`
  if (team.startsWith('workflow:')) return `Workflow run ${phase}`
  return `${humanizeActorId(team)} run ${phase}`
}

/**
 * Runtime writers re-save the same file as work progresses — a YouTube capture
 * manifest is rewritten after every video. Each write is a real event, but the
 * timeline lists files rather than writes, and only the newest revision is the
 * one a reader can open. Keep the last row per file so one file reads as one
 * row instead of one row per save.
 */
function dropSupersededArtifactRows(
  story: ExecutionTimelineItem[],
): ExecutionTimelineItem[] {
  const latestIndexByArtifact = new Map<string, number>()
  story.forEach((item, index) => {
    if (item.kind !== 'artifact') return
    const artifactRef = item.artifactRefs[0]
    if (!artifactRef) return
    latestIndexByArtifact.set(`${artifactRef.runId}:${artifactRef.path}`, index)
  })

  return story.filter((item, index) => {
    if (item.kind !== 'artifact') return true
    const artifactRef = item.artifactRefs[0]
    if (!artifactRef) return true
    return latestIndexByArtifact.get(
      `${artifactRef.runId}:${artifactRef.path}`,
    ) === index
  })
}

function isDelegationFailureStatus(status: string | null): boolean {
  return status === 'failed' || status === 'blocked'
}

function sortByTimestampAscending<T extends { timestamp: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.timestamp.localeCompare(right.timestamp))
}

function sortByTimestampDescending<T extends { timestamp: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => right.timestamp.localeCompare(left.timestamp))
}

function normalizeRootRunId(run: RunSummary): string {
  return run.rootRunId ?? run.id
}

function normalizeParentRunId(run: RunSummary): string | null {
  return run.parentRunId ?? null
}

function normalizeArtifactPath(run: RunSummary | undefined, artifactPath: string | null): string | null {
  if (!artifactPath) return null
  if (!run) return artifactPath
  if (!artifactPath.startsWith(run.assignmentPath)) return artifactPath

  const prefix = `${run.assignmentPath}/`
  return artifactPath.startsWith(prefix)
    ? artifactPath.slice(prefix.length)
    : artifactPath.replace(run.assignmentPath, '').replace(/^\/+/, '')
}

function statusRank(status: RunStatus): number {
  if (status === 'failed') return 7
  if (status === 'blocked') return 6
  if (status === 'active') return 5
  if (status === 'incomplete') return 4
  if (status === 'cancelled') return 3
  if (status === 'unknown') return 2
  return 1
}

function deriveExecutionStatus(runs: RunSummary[]): RunStatus {
  if (runs.some((run) => run.status === 'failed')) return 'failed'
  if (runs.some((run) => run.status === 'blocked')) return 'blocked'
  if (runs.some((run) => run.status === 'active')) return 'active'
  if (runs.every((run) => run.status === 'completed')) return 'completed'
  if (runs.some((run) => run.status === 'cancelled')) return 'cancelled'
  if (runs.some((run) => run.status === 'incomplete')) return 'incomplete'
  return 'unknown'
}

function deriveRunDepth(runId: string, runsById: Map<string, RunSummary>): number {
  let depth = 0
  let cursor = runsById.get(runId)
  const visited = new Set<string>()

  while (cursor?.parentRunId) {
    if (visited.has(cursor.id)) break
    visited.add(cursor.id)
    const parent = runsById.get(cursor.parentRunId)
    if (!parent) break
    depth += 1
    cursor = parent
  }

  return depth
}

function deriveRunExecutionState(status: RunStatus, activeAgentCount: number): RunExecutionState {
  if (status === 'failed') return 'failed'
  if (status === 'blocked') return 'blocked'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'completed') return 'completed'
  if (status === 'incomplete') return 'incomplete'
  if (status === 'active') {
    return activeAgentCount > 0 ? 'running' : 'waiting'
  }
  return 'unknown'
}

export function parseMarkdownArtifact(content: string): ParsedMarkdownArtifact {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  const frontmatter = match?.[1]
  const body = match?.[2]
  if (frontmatter === undefined || body === undefined) {
    return { metadata: {}, body: content, hasFrontmatter: false }
  }

  const metadata: Record<string, string> = {}
  for (const rawLine of frontmatter.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separatorIndex = line.indexOf(':')
    if (separatorIndex === -1) continue
    const key = line.slice(0, separatorIndex).trim()
    let value = line.slice(separatorIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    metadata[key] = value
  }

  return {
    body,
    hasFrontmatter: true,
    metadata,
  }
}

export function getPreferredArtifactPaths(paths: string[]): string[] {
  const priority = ['report.md', 'minutes.md', 'brief.md']

  return [...paths].sort((left, right) => {
    const leftRank = priority.findIndex((entry) => left.endsWith(entry))
    const rightRank = priority.findIndex((entry) => right.endsWith(entry))
    const normalizedLeftRank = leftRank === -1 ? Number.MAX_SAFE_INTEGER : leftRank
    const normalizedRightRank = rightRank === -1 ? Number.MAX_SAFE_INTEGER : rightRank

    if (normalizedLeftRank !== normalizedRightRank) {
      return normalizedLeftRank - normalizedRightRank
    }

    return left.localeCompare(right)
  })
}

export function buildExecutionGroups(runs: RunSummary[]): ExecutionGroup[] {
  const grouped = new Map<string, RunSummary[]>()

  for (const run of runs) {
    const rootRunId = normalizeRootRunId(run)
    const group = grouped.get(rootRunId)
    if (group) {
      group.push(run)
    } else {
      grouped.set(rootRunId, [run])
    }
  }

  const groups = [...grouped.entries()]
    .map(([rootRunId, groupRuns]) => {
      const sortedRuns = [...groupRuns].sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
      const rootRun = groupRuns.find((run) => run.id === rootRunId) ?? groupRuns.find((run) => !run.parentRunId) ?? sortedRuns[0]
      const updatedAt = sortedRuns[0]?.updatedAt ?? null
      const startedAt = [...groupRuns]
        .map((run) => run.startedAt)
        .filter((value): value is string => Boolean(value))
        .sort()[0] ?? null

      return {
        childRunCount: Math.max(0, groupRuns.length - 1),
        id: rootRunId,
        jobTitle: rootRun?.jobTitle ?? sortedRuns[0]?.jobTitle ?? null,
        latestRunId: sortedRuns[0]?.id ?? rootRunId,
        rootRunId,
        runs: sortedRuns,
        startedAt,
        status: deriveExecutionStatus(groupRuns),
        team: rootRun?.team ?? sortedRuns[0]?.team ?? null,
        updatedAt,
      } satisfies ExecutionGroup
    })
    .sort((left, right) => {
      const leftUpdated = left.updatedAt ?? ''
      const rightUpdated = right.updatedAt ?? ''
      if (leftUpdated !== rightUpdated) return rightUpdated.localeCompare(leftUpdated)
      return statusRank(right.status) - statusRank(left.status)
    })

  let activeRootAssigned = false
  for (const group of groups) {
    if (
      group.status === 'failed' ||
      group.status === 'blocked' ||
      group.status === 'cancelled' ||
      group.status === 'completed' ||
      group.status === 'unknown'
    ) continue

    if (!activeRootAssigned) {
      group.status = 'active'
      activeRootAssigned = true
      continue
    }

    group.status = 'incomplete'
  }

  return groups
}

function deriveEventRunStatus(events: EngineEventEnvelope[]): RunStatus {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type
    if (type === 'run.completed') return 'completed'
    if (type === 'run.failed') return 'failed'
    if (type === 'run.blocked') return 'blocked'
    if (type === 'run.cancelled') return 'cancelled'
    if (type === 'run.incomplete') return 'incomplete'
  }
  return events.length > 0 ? 'active' : 'unknown'
}

/**
 * Builds the same end-to-end execution projection used by the former Admin
 * workspace from one root run stream. Root streams already include delegated
 * child events, so callers must not append separate child snapshots.
 */
export function buildExecutionProjectionFromRootEvents(
  rootRunId: string,
  events: EngineEventEnvelope[],
): ExecutionProjection {
  const runIds = new Set<string>([rootRunId])
  for (const event of events) {
    if (event.run_id) runIds.add(event.run_id)
  }

  const runs: RunSummary[] = [...runIds].map((runId) => {
    const ownEvents = events.filter(
      (event) => (event.run_id ?? rootRunId) === runId,
    )
    const startEvent = ownEvents.find(
      (event) => event.type === 'run.session_started',
    )
    const firstEvent = ownEvents[0]
    const lastEvent = ownEvents.at(-1)
    const artifactPaths = ownEvents.flatMap((event) => {
      if (event.type !== 'artifact.written') return []
      const artifactPath = asString(asRecord(event.payload).path)
      return artifactPath ? [artifactPath] : []
    })

    return {
      id: runId,
      assignmentPath:
        startEvent?.assignment_path ?? firstEvent?.assignment_path ?? '',
      team: startEvent?.team ?? firstEvent?.team ?? null,
      jobTitle: null,
      startedAt: startEvent?.timestamp ?? firstEvent?.timestamp ?? null,
      updatedAt: lastEvent?.timestamp ?? null,
      status: deriveEventRunStatus(ownEvents),
      rootRunId,
      parentRunId:
        runId === rootRunId
          ? undefined
          : startEvent?.parent_run_id ?? firstEvent?.parent_run_id,
      artifactPaths: [...new Set(artifactPaths)],
    }
  })
  const group = buildExecutionGroups(runs).find(
    (candidate) => candidate.rootRunId === rootRunId,
  )

  if (!group) return {
    agents: [],
    artifacts: [],
    categoryCounts: {
      agent: 0,
      artifact: 0,
      delegation: 0,
      gate: 0,
      run: 0,
      runtime: 0,
      stage: 0,
      tool: 0,
    },
    currentLevelId: null,
    currentStageType: null,
    finalArtifactCandidates: [],
    latestTimestamp: null,
    rawEventCount: 0,
    runNodes: [],
    story: [],
    teamsInvolved: [],
  }

  return buildExecutionProjection(group, { [rootRunId]: events })
}

export function buildExecutionProjection(group: ExecutionGroup, eventsByRunId: Record<string, EngineEventEnvelope[]>): ExecutionProjection {
  const runsById = new Map(group.runs.map((run) => [run.id, run]))
  const mergedEvents = sortByTimestampAscending(
    group.runs.flatMap((run) => (eventsByRunId[run.id] ?? []).map((event) => ({
      ...event,
      run_id: event.run_id ?? run.id,
      team: event.team ?? run.team,
    }))),
  )
  const actorNamesById = new Map<string, string>()
  for (const event of mergedEvents) {
    const seed = eventActorSeed(asRecord(event.payload))
    if (seed.id && seed.name) actorNamesById.set(seed.id, seed.name)
  }

  const categoryCounts: Record<EngineEventCategory, number> = {
    run: 0,
    stage: 0,
    agent: 0,
    tool: 0,
    gate: 0,
    artifact: 0,
    runtime: 0,
    delegation: 0,
  }

  const agents = new Map<string, DerivedAgentState>()
  const artifacts = new Map<string, DerivedArtifactState>()
  const activeAgentsByRunId = new Map<string, Set<string>>()
  const currentLevelByRunId = new Map<string, string | null>()
  const currentStageByRunId = new Map<string, string | null>()
  const teamsInvolved = new Set<string>()
  const story: ExecutionTimelineItem[] = []
  let currentLevelId: string | null = null
  let currentStageType: string | null = null
  let latestTimestamp: string | null = null

  for (const event of mergedEvents) {
    categoryCounts[event.category] += 1
    const runId = event.run_id ?? group.latestRunId
    const run = runsById.get(runId)
    const depth = deriveRunDepth(runId, runsById)
    const team = event.team ?? run?.team ?? null
    if (team) teamsInvolved.add(team)
    if (event.level_id) currentLevelId = event.level_id
    if (event.stage_type) currentStageType = event.stage_type
    if (event.level_id) currentLevelByRunId.set(runId, event.level_id)
    if (event.stage_type) currentStageByRunId.set(runId, event.stage_type)
    latestTimestamp = event.timestamp

    const payload = asRecord(event.payload)
    const artifactPath = event.type === 'artifact.written'
      ? asString(payload.path)
      : null
    const actor = resolveTimelineActor(
      payload,
      actorNamesById,
      artifactPath,
    )
    const activityItem = buildRuntimeActivityTimelineItem({
      actor,
      depth,
      event,
      payload,
      runId,
      team,
    })
    if (activityItem) story.push(activityItem)

    if (event.category === 'agent') {
      const agentName = actor?.name ?? asString(payload.agent_name)
      if (agentName) {
        const agentKey = actor?.id ?? agentName
        const previous = agents.get(agentKey)
        const activeAgents = activeAgentsByRunId.get(runId) ?? new Set<string>()
        let status: DerivedAgentState['status'] = previous?.status ?? 'idle'
        if (event.type === 'agent.start') {
          status = 'active'
          activeAgents.add(agentKey)
        }
        if (event.type === 'agent.end') {
          status = 'done'
          activeAgents.delete(agentKey)
        }
        if (event.type === 'agent.fail') {
          status = 'failed'
          activeAgents.delete(agentKey)
        }
        if (event.type === 'agent.skip') {
          status = 'skipped'
          activeAgents.delete(agentKey)
        }
        activeAgentsByRunId.set(runId, activeAgents)

        agents.set(agentKey, {
          name: agentName,
          status,
          model: asString(payload.model) ?? previous?.model ?? null,
          provider: asString(payload.provider) ?? previous?.provider ?? null,
          lastEventType: event.type,
          lastSeenAt: event.timestamp,
          levelId: event.level_id ?? previous?.levelId ?? null,
          stageType: event.stage_type ?? previous?.stageType ?? null,
          runId,
          team,
        })
      }
    }

    if (event.category === 'artifact' && event.type === 'artifact.written') {
      const artifactPath = asString(payload.path)
      if (artifactPath) {
        artifacts.set(`${runId}:${artifactPath}`, {
          id: `${event.timestamp}:${runId}:${artifactPath}`,
          path: artifactPath,
          artifactType: asString(payload.artifact_type),
          runId,
          team,
          timestamp: event.timestamp,
          title: asString(payload.title),
        })

        story.push({
          artifactRefs: [{
            label: artifactPath.split('/').at(-1) ?? artifactPath,
            path: artifactPath,
            runId,
          }],
          ...(actor ? { actor } : {}),
          badges: [event.category, ...(event.level_id ? [event.level_id] : []), ...(event.stage_type ? [event.stage_type] : [])],
          depth,
          detail: asString(payload.artifact_type) ? `${asString(payload.artifact_type)} artifact` : 'runtime artifact',
          errorText: null,
          id: `${event.timestamp}:${runId}:artifact:${artifactPath}`,
          kind: 'artifact',
          levelId: event.level_id ?? null,
          processStep: null,
          runId,
          stageType: event.stage_type ?? null,
          team,
          timestamp: event.timestamp,
          title: `${artifactPath} written`,
        })
      }
    }

    if (event.category === 'delegation') {
      const from = asString(payload.from) ?? team ?? 'dispatcher'
      const to = asString(payload.to) ?? asString(payload.to_team) ?? 'child team'
      const status = asString(payload.status) ?? event.type
      const artifactRefs: TimelineArtifactRef[] = []
      const childRunId = asString(payload.child_session_id)
      const briefArtifact = normalizeArtifactPath(run, asString(payload.brief_artifact))
      const resultArtifact = normalizeArtifactPath(run, asString(payload.result_artifact))
      const childOutputArtifact = normalizeArtifactPath(
        childRunId ? runsById.get(childRunId) : undefined,
        asString(payload.child_output_artifact),
      )

      if (briefArtifact) {
        artifactRefs.push({
          label: 'brief',
          path: briefArtifact,
          runId,
        })
      }
      if (resultArtifact) {
        artifactRefs.push({
          label: 'result',
          path: resultArtifact,
          runId,
        })
      }
      if (childOutputArtifact && childRunId && !childOutputArtifact.startsWith('[')) {
        artifactRefs.push({
          label: 'child output',
          path: childOutputArtifact,
          runId: childRunId,
        })
      }

      story.push({
        artifactRefs,
        ...(actor ? { actor } : {}),
        badges: [...(event.level_id ? [event.level_id] : [])],
        depth,
        detail: `${from} delegated work to ${to}`,
        errorText: null,
        id: `${event.timestamp}:${runId}:delegation:${status}:${to}`,
        kind: 'delegation',
        levelId: event.level_id ?? null,
        processStep: status,
        runId,
        stageType: event.stage_type ?? null,
        team,
        timestamp: event.timestamp,
        title: `Delegated to ${to}`,
      })

      const errorText = asString(payload.error)
      if (isDelegationFailureStatus(status) && errorText) {
        const childTeam = asString(payload.to_team) ?? to
        const childRunDepth = childRunId ? deriveRunDepth(childRunId, runsById) : depth + 1

        story.push({
          artifactRefs,
          ...(actor ? { actor } : {}),
          badges: ['failed', ...(event.level_id ? [event.level_id] : [])],
          depth: childRunDepth,
          detail: `${childTeam} reported a runtime failure`,
          errorText,
          id: `${event.timestamp}:${runId}:delegation-error:${childTeam}`,
          kind: 'error',
          levelId: event.level_id ?? null,
          processStep: status,
          runId: childRunId ?? runId,
          stageType: event.stage_type ?? null,
          team: childTeam,
          timestamp: event.timestamp,
          title: 'Delegation failed',
        })
      }
    }

    if (event.category === 'run' && event.type === 'run.session_started') {
      story.push({
        artifactRefs: [],
        badges: ['run', ...(event.level_id ? [event.level_id] : [])],
        depth,
        detail: team ? `${team} session started` : 'run session started',
        errorText: null,
        id: `${event.timestamp}:${runId}:run-start`,
        kind: 'run',
        levelId: event.level_id ?? null,
        processStep: null,
        runId,
        stageType: event.stage_type ?? null,
        team,
        timestamp: event.timestamp,
        title: formatRunLifecycleTitle(team, 'started'),
      })
    }

    if (
      event.type === 'run.completed' ||
      event.type === 'run.failed' ||
      event.type === 'run.blocked' ||
      event.type === 'run.cancelled'
    ) {
      const terminalLabel = event.type.slice('run.'.length)
      const isError = terminalLabel === 'failed' || terminalLabel === 'blocked'
      story.push({
        artifactRefs: [],
        badges: [terminalLabel],
        depth,
        detail: team ? `${team} run ${terminalLabel}` : event.type,
        errorText: isError ? asString(payload.error) : null,
        id: `${event.timestamp}:${runId}:${event.type}`,
        kind: isError ? 'error' : 'completion',
        levelId: event.level_id ?? null,
        processStep: null,
        runId,
        stageType: event.stage_type ?? null,
        team,
        timestamp: event.timestamp,
        title: formatRunLifecycleTitle(team, terminalLabel),
      })
    }
  }

  const runNodes: ExecutionRunNode[] = group.runs
    .map((run) => ({
      activeAgentNames: [
        ...(activeAgentsByRunId.get(run.id) ?? new Set<string>()),
      ]
        .map((agentId) => agents.get(agentId)?.name ?? agentId)
        .sort((left, right) => left.localeCompare(right)),
      currentLevelId: currentLevelByRunId.get(run.id) ?? null,
      currentStageType: currentStageByRunId.get(run.id) ?? null,
      depth: deriveRunDepth(run.id, runsById),
      executionState: deriveRunExecutionState(run.status, activeAgentsByRunId.get(run.id)?.size ?? 0),
      id: `${group.rootRunId}:${run.id}`,
      parentRunId: normalizeParentRunId(run),
      runId: run.id,
      startedAt: run.startedAt,
      status: run.status,
      team: run.team,
      updatedAt: run.updatedAt,
    }))
    .sort((left, right) => {
      if (left.depth !== right.depth) return left.depth - right.depth
      return (left.startedAt ?? '').localeCompare(right.startedAt ?? '')
    })

  const finalArtifactCandidates = sortByTimestampDescending(
    [...artifacts.values()].filter((artifact) =>
      artifact.path.endsWith('report.md')
      || artifact.path.endsWith('minutes.md')
      || artifact.path.endsWith('brief.md'),
    ),
  )

  return {
    agents: [...agents.values()].sort((left, right) => left.name.localeCompare(right.name)),
    artifacts: sortByTimestampDescending([...artifacts.values()]),
    categoryCounts,
    currentLevelId,
    currentStageType,
    finalArtifactCandidates,
    latestTimestamp,
    rawEventCount: mergedEvents.length,
    runNodes,
    story: dropSupersededArtifactRows(story),
    teamsInvolved: [...teamsInvolved].sort(),
  }
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'n/a'

  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(new Date(value))
}

export function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return 'n/a'

  const diffMs = Date.now() - new Date(value).getTime()
  const diffMinutes = Math.round(diffMs / 60000)

  if (Math.abs(diffMinutes) < 1) return 'just now'
  if (Math.abs(diffMinutes) < 60) return `${diffMinutes}m ago`

  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) return `${diffHours}h ago`

  const diffDays = Math.round(diffHours / 24)
  return `${diffDays}d ago`
}
