/**
 * Team Runtime — Agent Runner
 *
 * Routes agent dispatch to the appropriate provider (Pi, Codex, Gemini, …).
 * The actual subprocess logic lives in providers/<name>.ts.
 *
 * Also includes runTeam() for spawning entire teams as subprocesses
 * (team-of-teams composition).
 */

import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import { whenDefined } from '../../core/optional-properties.js'
import { agentQuestionInterruptionSchema, type AgentQuestionInterruption } from '../../contracts/agent-questions.js'
import { agentQuestionDispatchId } from '../../core/agent-question-policy.js'
import {
  toModelSelectionRecord,
  type ModelSelection,
} from '../../contracts/agent-model-selection.js'
import {
  buildPiInvocation,
  RUNTIME_EXTENSION_ENTRY_ENV,
} from '../../core/pi-runtime.js'
import {
  ownedProcessHostEnvironment,
  ownedProcessHostInvocation,
  prepareOwnedProcess,
  type PreparedOwnedProcess,
} from '../../core/owned-processes/owned-process-spawn.js'
import { closeOwnedProcessSubtree } from '../../core/owned-processes/owned-process-closer.js'
import type {
  AgentRunOptions,
  AgentRunResult,
  HumanInputRoutingContext,
  TeamRunOptions,
  TeamRunResult,
  TeamRuntimeOverrides,
  SpawnLimits,
  AgentRunFailure,
  RosterEntrySlim,
  LoadedAgent,
  AgentMetrics,
  RuntimeState,
} from '../../core/types.js'
import {
  AGENT_STATE,
  DEFAULT_MAX_SPAWN_DEPTH,
  DELEGATED_SIGKILL_GRACE_PERIOD_MS,
  DELEGATED_TERMINATION_CONFIRM_MS,
} from '../../core/constants.js'
import { resolveAuthorizedAgentModelChoice } from '../../contracts/model-choice.js'
import { getRuntimeApprovedModelChoice } from '../provider/approved-model-choice.js'
import { getRuntimeDefaultModelState } from '../provider/default-model-selection.js'
import { TimeoutError } from '../../core/timeout-manager.js'
import { roundUsd, type BudgetPolicy } from '../../core/budget-ledger.js'
import { getProvider } from '../../providers/index.js'
import { executeProvider } from '../../providers/protocol.js'
import type { ProviderProtocolEvent } from '../../contracts/provider.js'
import { DelegatedSettlement, HeldSubtreeError } from './delegated-settlement.js'
import type { DelegatedTerminationOutcome } from './delegated-settlement.js'
import { ProviderError } from '../provider/provider-error.js'
import {
  SubTeamFailedError,
  type SubTeamFailureStatus,
} from './sub-team-failure.js'
import { calculateUsageCost } from '../../providers/cost.js'
import {
  McpWorkerTurnClientError,
  providerErrorFromWorkerFailure,
  runMcpWorkerTurn,
} from '../mcp/mcp-worker-turn-client.js'
import {
  MCP_WORKER_ACTIVITY_SCOPE_ID_ENV,
  MCP_WORKER_AGENT_DISPLAY_NAME_ENV,
} from '../mcp/mcp-worker-turn.js'
import { mcpProviderSupportReason } from '../mcp/mcp-provider-support.js'
import {
  buildArtifactMetadata,
  parseMarkdownArtifact,
  writeMarkdownArtifact,
} from '../runtime/artifacts.js'
import { logAgentRun } from '../runtime/logger.js'
import { retainCompatibleProviderOptions } from '../../providers/provider-option-support.js'
import {
  buildChildAssignmentLocation,
  buildRuntimeAssignmentEnvironment,
  getRunAttemptTemporaryPath,
  ensureRunPrivateRuntimeDirectory,
  getRunRuntimePaths,
  resolveAssignmentPath,
  resolveRuntimeAssignmentLocation,
} from '../runtime/runtime-paths.js'
import { hasCheckpoint } from '../runtime/checkpoint.js'
import { RUN_PRIVATE_RUNTIME_DIRECTORY_NAME } from '../../core/run-assignment-location.js'
import {
  writeRunAssignmentLocator,
  type SessionRunAssignmentLocation,
} from '../run/run-location.js'
import {
  isPathInside,
  resolveRelativePathInside,
} from '../../core/path-safety.js'
import { writeFileAtomicSync } from '../../core/file-mutation.js'
import { forwardAgentTextStreamEnvironment } from '../runtime/agent-text-delta-launch.js'
import { getProcessRunTextStream } from '../runtime/agent-text-run-stream.js'
import { AGENT_TEXT_STREAM_CHANNEL_ENV } from '../runtime/agent-text-delta-tokens.js'
import {
  RUNTIME_PROCESS_IDENTITY_ENV,
  RUNTIME_TASK_ID_ENV,
} from '../../contracts/runtime-capability-authority.js'
import {
  prepareDelegatedRuntimeAssignmentAuthority,
  withoutRootTaskLaunchSecrets,
  type DelegatedRuntimeAssignmentAuthority,
} from '../run/runtime-assignment-authority.js'
import {
  isolatePiAgentDirectory,
  resolveFilesystemOwnershipPolicy,
  type IsolatedPiAgentDirectory,
} from '../run/pi-agent-isolation.js'
import { readChildReviewExhaustion } from '../../core/review-exhaustion-evidence.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Track providers that have already emitted a missing-pricing warning. */
const warnedProviders = new Set<string>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}
const ZERO_MARGINAL_COST_PROVIDERS = new Set([
  'claude',
  'codex',
  'gemini',
  'kimi-cli',
  'lm-studio',
  'qwen',
])

function resolveOwnedAssignmentRelativePath(params: {
  assignmentPath: string
  relativePath: string
  label: string
}): string {
  const segments = params.relativePath.split('/')
  if (
    segments[0]?.toLowerCase() ===
    RUN_PRIVATE_RUNTIME_DIRECTORY_NAME.toLowerCase()
  ) {
    throw new Error(
      `${params.label} must not use the reserved private runtime path: ${params.relativePath}`,
    )
  }

  const candidatePath = resolveRelativePathInside(
    params.assignmentPath,
    params.relativePath,
  )
  if (!candidatePath) {
    throw new Error(
      `${params.label} must stay inside the child assignment: ${params.relativePath}`,
    )
  }

  const assignmentStat = fs.lstatSync(params.assignmentPath)
  if (assignmentStat.isSymbolicLink() || !assignmentStat.isDirectory()) {
    throw new Error(`${params.label} requires an owned assignment directory`)
  }
  const realAssignmentPath = fs.realpathSync(params.assignmentPath)
  let currentPath = params.assignmentPath

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (segment === undefined) throw new Error(`Missing assignment path segment at index ${index}`)
    currentPath = path.join(currentPath, segment)
    let currentStat: fs.Stats
    try {
      currentStat = fs.lstatSync(currentPath)
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) break
      throw error
    }

    if (currentStat.isSymbolicLink()) {
      throw new Error(
        `${params.label} contains a symbolic-link component inside the assignment: ${params.relativePath}`,
      )
    }
    if (index < segments.length - 1 && !currentStat.isDirectory()) {
      throw new Error(
        `${params.label} contains a non-directory parent component: ${params.relativePath}`,
      )
    }

    const realCurrentPath = fs.realpathSync(currentPath)
    if (!isPathInside(realAssignmentPath, realCurrentPath)) {
      throw new Error(
        `${params.label} resolves outside the child assignment: ${params.relativePath}`,
      )
    }
  }

  return candidatePath
}

function resolveTeamArtifactPath(params: {
  assignmentPath: string
  outputArtifact: string
}): string | null {
  try {
    const candidatePath = resolveOwnedAssignmentRelativePath({
      assignmentPath: params.assignmentPath,
      relativePath: params.outputArtifact,
      label: 'Child output artifact',
    })
    if (!fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isFile()) {
      return null
    }
    return candidatePath
  } catch {
    return null
  }
}

/**
 * A review that ended without approval, or `null` when that is not what happened.
 *
 * Read before the stage checkpoint, which is always written and can only say
 * that the stage stopped. A review loop that ran out of iterations is a
 * complete explanation: how many rounds it took, what the reviewer last said,
 * and — because nothing is waiting for a reply — that a new run is the way on.
 *
 * Only an ending counts: a review that used up its rounds and then published
 * the latest draft under `approve_latest` is a finished review, and whatever
 * blocked afterwards is the answer instead.
 */
function summarizeChildReviewExhaustion(
  assignmentPath: string,
  expectedArtifact: string,
): string | null {
  const exhaustion = readChildReviewExhaustion(assignmentPath)
  if (!exhaustion) return null
  const { iteration, maxIterations, lastVerdict } = exhaustion
  const feedbackPath = path.join(
    assignmentPath,
    `review-feedback-v${typeof iteration === 'number' ? iteration : String(iteration ?? '')}.md`,
  )
  const feedbackPreview = fs.existsSync(feedbackPath)
    ? fs.readFileSync(feedbackPath, 'utf8')
      .split('---\n')
      .pop()
      ?.trim()
      ?.split('\n')
      .slice(0, 6)
      .join('\n')
    : ''

  return (
    `Child stage blocked after ${String(iteration ?? '?')}/${String(maxIterations ?? '?')} review iterations without producing \`${expectedArtifact}\`.` +
    (lastVerdict ? ` Last verdict: ${String(lastVerdict).toUpperCase()}.` : '') +
    ` Nothing is waiting for a reply — start a new run to try again.` +
    (feedbackPreview ? `\n\nLatest reviewer feedback:\n${feedbackPreview}` : '')
  )
}

function summarizeMissingChildOutput(
  assignmentPath: string,
  expectedArtifact: string,
): string {
  // A child that never finished starting explains everything downstream of it,
  // so startup failures are classified before anything the run itself produced.
  const startupFailureSummary = summarizeChildStartupFailure(assignmentPath, expectedArtifact)
  if (startupFailureSummary) return startupFailureSummary

  const providerFailureSummary = summarizeChildProviderFailure(assignmentPath, expectedArtifact)
  if (providerFailureSummary) return providerFailureSummary

  // An agent that exhausted its retries and halted is a more specific answer
  // than the stage outcome below, which can only say that the stage stopped.
  // The provider-events summary above misses this case entirely for a Team
  // agent: its provider call runs in the orchestrator, not in this process, so
  // nothing was ever written to the log that summary reads.
  const haltSummary = summarizeChildAgentHalt(assignmentPath, expectedArtifact)
  if (haltSummary) return haltSummary

  // A review that ran out of iterations explains the blocked stage below, and
  // the checkpoint is written in this case too — so reading it only when no
  // checkpoint exists meant a real run never saw this at all.
  const reviewExhaustionSummary = summarizeChildReviewExhaustion(
    assignmentPath,
    expectedArtifact,
  )
  if (reviewExhaustionSummary) return reviewExhaustionSummary

  const stageOutcome = resolveChildCheckpointOutcome(assignmentPath)
  if (stageOutcome) {
    return (
      `Child stage \`${stageOutcome.levelId}\` ${stageOutcome.status} before producing ` +
      `\`${expectedArtifact}\`. The runtime did execute its stage tools; inspect the stage artifacts and task statuses for the underlying blocker.`
    )
  }

  const hostFailureSummary = summarizeChildHostFailure(assignmentPath, expectedArtifact)
  if (hostFailureSummary) return hostFailureSummary

  const chainArtifacts = fs.existsSync(assignmentPath)
    ? fs.readdirSync(assignmentPath)
      .filter((name) => /^chain-step-\d+-.+\.md$/.test(name))
      .sort()
    : []

  for (let i = chainArtifacts.length - 1; i >= 0; i--) {
    const artifact = chainArtifacts[i]
    if (artifact === undefined) continue
    const artifactPath = path.join(assignmentPath, artifact)
    const content = fs.readFileSync(artifactPath, 'utf8')
    if (!/(^|\n)\*\*Status:\*\*\s*BLOCKED\b/m.test(content) && !/(^|\n)Status:\s*BLOCKED\b/m.test(content)) {
      continue
    }
    const excerpt = content
      .split('\n')
      .slice(0, 24)
      .join('\n')
      .trim()
    return (
      `Child chain blocked before producing \`${expectedArtifact}\`.\n\n` +
      `${excerpt}`
    )
  }

  const minutesPath = path.join(assignmentPath, 'minutes.md')
  if (fs.existsSync(minutesPath)) {
    const summaryLine = fs.readFileSync(minutesPath, 'utf8')
      .split('\n')
      .find((line) => /Iteration \d+\/\d+.*verdict:/i.test(line))
    if (summaryLine) {
      return `Child session ended without \`${expectedArtifact}\`. ${summaryLine.trim()}`
    }
  }

  return ''
}

function summarizeChildProviderFailure(assignmentPath: string, expectedArtifact: string): string {
  const providerEventsPath = path.join(assignmentPath, 'logs', 'provider-events.jsonl')
  if (!fs.existsSync(providerEventsPath)) return ''

  const events = fs.readFileSync(providerEventsPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  for (let i = events.length - 1; i >= 0; i--) {
    try {
      const rawEvent = events[i]
      if (rawEvent === undefined) continue
      const event = parseJsonRecord(rawEvent)
      if (!event) continue
      if (event.status !== 'failed' || event.event !== 'request.fail') continue
      const provider = typeof event.provider === 'string' ? event.provider : 'unknown'
      const model = typeof event.model === 'string' ? event.model : 'unknown'
      const agentName = typeof event.agent_name === 'string' ? event.agent_name : 'unknown'
      const detail = typeof event.detail === 'string' ? event.detail : 'Provider request failed.'
      const raw = isRecord(event.raw) ? event.raw : undefined
      const httpStatus = typeof raw?.http_status === 'number'
        ? raw.http_status
        : undefined
      return (
        `Child provider failure while producing \`${expectedArtifact}\`.\n\n` +
        `Provider: ${provider}\n` +
        `Model: ${model}\n` +
        `Agent: ${agentName}\n` +
        (httpStatus ? `HTTP status: ${httpStatus}\n` : '') +
        `Reason: ${detail}`
      )
    } catch {
      continue
    }
  }

  return ''
}

/**
 * What the child's own failure log says about the agent that gave up.
 *
 * Read for the `halt` record specifically: the retry entries before it repeat
 * the same message once per attempt, and the halt is the one that ended the
 * stage. Reported ahead of the stage outcome because "agent X halted after 3
 * attempts: <reason>" answers the question the stage outcome can only restate.
 */
function summarizeChildAgentHalt(
  assignmentPath: string,
  expectedArtifact: string,
): string {
  const errorLogPath = path.join(assignmentPath, 'agent-errors.jsonl')
  if (!fs.existsSync(errorLogPath)) return ''

  const entries = fs.readFileSync(errorLogPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const raw = entries[index]
    if (raw === undefined) continue
    const entry = parseJsonRecord(raw)
    if (!entry || entry.error_type !== 'halt') continue
    const agentName = typeof entry.agent_name === 'string' ? entry.agent_name : 'unknown'
    const message = typeof entry.error_message === 'string' ? entry.error_message.trim() : ''
    if (!message) return ''
    const attempts = typeof entry.max_attempts === 'number' && entry.max_attempts > 1
      ? ` after ${entry.max_attempts} attempts`
      : ''
    return (
      `Child agent \`${agentName}\` halted${attempts} before producing ` +
      `\`${expectedArtifact}\`.\n\nReason: ${message}`
    )
  }

  return ''
}

function readChildEvents(
  assignmentPath: string,
  fileName: 'host-events.jsonl' | 'runtime-events.jsonl',
): Array<Readonly<Record<string, unknown>>> {
  const eventsPath = path.join(assignmentPath, 'logs', fileName)
  if (!fs.existsSync(eventsPath)) return []
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseJsonRecord)
    .filter(isRecord)
}

function formatEventError(event: Readonly<Record<string, unknown>>): string {
  if (typeof event.error === 'string' && event.error.trim()) return event.error.trim()
  if (Array.isArray(event.errors)) {
    const errors = event.errors.filter((entry): entry is string => typeof entry === 'string')
    if (errors.length > 0) return errors.join('\n')
  }
  return 'no error detail recorded'
}

/**
 * Why the child never reached the point of producing its artifact.
 *
 * A delegated child is *instructed* to end its turn without calling tools while
 * runtime autostart owns the stage, so `host.agent_end.no_tool_call` on its own
 * identifies nothing. Reporting it as "usually a host-provider problem" sent one
 * investigation to the Codex CLI for a runtime that had simply declined to start
 * the stage. Each branch below names a fact the child actually recorded; the
 * order is most-specific-cause-first, and the idle turn is last because it is
 * the weakest signal, not the strongest.
 */
function summarizeChildStartupFailure(
  assignmentPath: string,
  expectedArtifact: string,
): string {
  const runtimeEvents = readChildEvents(assignmentPath, 'runtime-events.jsonl')
  const hostEvents = readChildEvents(assignmentPath, 'host-events.jsonl')

  const configError = [...runtimeEvents].reverse()
    .find((event) => event.event === 'runtime.config_error')
  if (configError) {
    return (
      `Child could not start before producing \`${expectedArtifact}\`.\n\n` +
      `Configuration errors:\n${formatEventError(configError)}`
    )
  }

  const startFailure = [...runtimeEvents].reverse()
    .find((event) => event.event === 'runtime.host_start_failed')
  if (startFailure) {
    return (
      `Child host crashed during startup before producing \`${expectedArtifact}\`.\n\n` +
      `${formatEventError(startFailure)}`
    )
  }

  const blockedModel = [...hostEvents].reverse()
    .find((event) => event.event === 'host.model_selection.blocked')
  if (blockedModel) {
    const desired = `${String(blockedModel.desired_provider ?? 'unknown')}:${String(blockedModel.desired_model ?? 'unknown')}`
    const available = typeof blockedModel.available_preview === 'string' && blockedModel.available_preview
      ? blockedModel.available_preview
      : '(none)'
    return (
      `Child could not select its host model before producing \`${expectedArtifact}\`.\n\n` +
      `Requested host model: ${desired}\n` +
      `Available in the child's registry: ${available}`
    )
  }

  const autostartEnd = [...runtimeEvents].reverse()
    .find((event) => event.event === 'runtime.stage_autostart.end')
  if (autostartEnd && autostartEnd.is_error === true) {
    return (
      `Child runtime started the stage and it failed before producing \`${expectedArtifact}\`.\n\n` +
      `Stage tool: ${String(autostartEnd.tool_name ?? 'unknown')}\n` +
      `${formatEventError(autostartEnd)}`
    )
  }

  // A skip only explains the run when nothing started the stage afterwards.
  if (!childRuntimeAutostartExecuted(assignmentPath)) {
    const skipped = [...runtimeEvents].reverse()
      .find((event) => event.event === 'runtime.stage_autostart.skipped')
    if (skipped) {
      const missing = Array.isArray(skipped.missing_tools)
        ? skipped.missing_tools.filter((entry): entry is string => typeof entry === 'string')
        : []
      const registered = Array.isArray(skipped.registered_tools)
        ? skipped.registered_tools.filter((entry): entry is string => typeof entry === 'string')
        : []
      return (
        `Child runtime did not start the stage before producing \`${expectedArtifact}\`.\n\n` +
        `Reason: ${String(skipped.reason ?? 'unknown')}\n` +
        (missing.length > 0 ? `Missing stage tools: ${missing.join(', ')}\n` : '') +
        (registered.length > 0 ? `Registered tools: ${registered.join(', ')}\n` : '') +
        `The host model was not at fault: while a delegated autostart is expected to own ` +
        `the stage, the host is told not to call tools.`
      )
    }
  }

  return ''
}

function summarizeChildHostFailure(
  assignmentPath: string,
  expectedArtifact: string,
): string {
  if (childRuntimeAutostartExecuted(assignmentPath)) return ''
  const events = readChildEvents(assignmentPath, 'host-events.jsonl')
  if (events.length === 0) return ''

  const idleTurns = events.filter((event) => event.event === 'host.agent_end.no_tool_call')
  if (idleTurns.length === 0) return ''

  const latestIdle = idleTurns[idleTurns.length - 1]
  if (!latestIdle) return ''
  const resolvedModelEvent = [...events].reverse().find((event) => event.event === 'host.model_selection.resolved')
  const hostProvider = typeof resolvedModelEvent?.resolved_host_provider === 'string'
    ? resolvedModelEvent.resolved_host_provider
    : (typeof latestIdle.host_provider === 'string' ? latestIdle.host_provider : 'unknown')
  const hostModel = typeof resolvedModelEvent?.resolved_host_model === 'string'
    ? resolvedModelEvent.resolved_host_model
    : (typeof latestIdle.host_model === 'string' ? latestIdle.host_model : 'unknown')
  const turnDurationMs = typeof latestIdle.turn_duration_ms === 'number'
    ? latestIdle.turn_duration_ms
    : Number(latestIdle.turn_duration_ms ?? NaN)
  const repeated = idleTurns.length > 1
    ? ` This happened ${idleTurns.length} times in the same child session.`
    : ''

  return (
    `Child host coordinator produced no stage tool calls before \`${expectedArtifact}\`.\n\n` +
    `Host provider: ${hostProvider}\n` +
    `Host model: ${hostModel}\n` +
    `Failure mode: coordinator exited without calling any stage tools` +
    (Number.isFinite(turnDurationMs) ? ` after ${turnDurationMs}ms.` : '.') +
    `${repeated}\n\n` +
    `The child recorded no configuration error, no host-start failure, and no ` +
    `skipped or failed stage autostart, so the host model itself is the ` +
    `remaining candidate. Check the child's host-events and provider logs before ` +
    `assuming a credentials or quota problem.`
  )
}

function childExitedIdleWithoutTools(assignmentPath: string): boolean {
  if (childRuntimeAutostartExecuted(assignmentPath)) return false
  const hostEventsPath = path.join(assignmentPath, 'logs', 'host-events.jsonl')
  if (!fs.existsSync(hostEventsPath)) return false

  const events = fs.readFileSync(hostEventsPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  for (let i = events.length - 1; i >= 0; i--) {
    try {
      const rawEvent = events[i]
      if (rawEvent === undefined) continue
      const event = parseJsonRecord(rawEvent)
      if (!event) continue
      if (event.event === 'host.agent_end.no_tool_call') return true
      if (event.event === 'host.agent_end') {
        const toolCalls = typeof event.tool_calls_in_turn === 'number'
          ? event.tool_calls_in_turn
          : Number(event.tool_calls_in_turn ?? NaN)
        return Number.isFinite(toolCalls) && toolCalls === 0
      }
    } catch {
      continue
    }
  }

  return false
}

function childRuntimeAutostartExecuted(assignmentPath: string): boolean {
  const runtimeEventsPath = path.join(assignmentPath, 'logs', 'runtime-events.jsonl')
  if (!fs.existsSync(runtimeEventsPath)) return false

  const hostEventsPath = path.join(assignmentPath, 'logs', 'host-events.jsonl')
  let latestHostSessionStartedAt = Number.NEGATIVE_INFINITY
  if (fs.existsSync(hostEventsPath)) {
    for (const line of fs.readFileSync(hostEventsPath, 'utf8').split('\n')) {
      try {
        const event = parseJsonRecord(line)
        if (!event) continue
        if (event.event !== 'host.session_start' || typeof event.timestamp !== 'string') continue
        const timestamp = Date.parse(event.timestamp)
        if (Number.isFinite(timestamp)) {
          latestHostSessionStartedAt = Math.max(latestHostSessionStartedAt, timestamp)
        }
      } catch {
        continue
      }
    }
  }

  return fs.readFileSync(runtimeEventsPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => {
      try {
        const event = parseJsonRecord(line)
        if (!event) return false
        if (event.event !== 'runtime.stage_autostart.end') return false
        // A failed autostart is not an executed one. Treating it as executed
        // suppressed every downstream diagnosis, so a stage tool that threw
        // left the parent with nothing to report at all.
        if (event.is_error === true) return false
        if (latestHostSessionStartedAt === Number.NEGATIVE_INFINITY) return true
        if (typeof event.timestamp !== 'string') return false
        const timestamp = Date.parse(event.timestamp)
        return Number.isFinite(timestamp) && timestamp >= latestHostSessionStartedAt
      } catch {
        return false
      }
    })
}

function resolveChildCheckpointOutcome(assignmentPath: string): {
  readonly levelId: string
  readonly status: 'blocked' | 'failed'
} | null {
  const checkpointPath = getRunRuntimePaths(assignmentPath).checkpointPath
  if (!fs.existsSync(checkpointPath)) return null

  try {
    const checkpoint = parseJsonRecord(fs.readFileSync(checkpointPath, 'utf8'))
    if (!checkpoint) return null
    const levelStates = checkpoint.levelStates
    const currentLevelIndex = Number(checkpoint.currentLevelIndex)
    if (!Number.isSafeInteger(currentLevelIndex) || currentLevelIndex < 0) return null
    const current: unknown = Array.isArray(levelStates)
      ? levelStates[currentLevelIndex]
      : undefined
    if (!isRecord(current)) return null
    const record = current
    const stageStatus = record.stageStatus
    if (stageStatus !== 'blocked' && stageStatus !== 'failed') return null
    return {
      levelId: typeof record.levelId === 'string' && record.levelId.trim()
        ? record.levelId
        : `level-${currentLevelIndex + 1}`,
      status: stageStatus,
    }
  } catch {
    return null
  }
}

/**
 * Report a run's failure without losing a cleanup failure that came with it.
 *
 * `AggregateError` keeps both as `errors`, so neither has to be chosen over the
 * other, while the message still leads with what the caller was waiting on.
 */
function withCleanupFailure(primary: Error, cleanupFailure: Error | null): Error {
  if (!cleanupFailure) return primary
  return new AggregateError(
    [primary, cleanupFailure],
    `${primary.message} The run also failed to remove its private Pi agent directory: ${cleanupFailure.message}`,
  )
}

function readChildQuestionInterruption(assignmentPath: string, startedAt: number): AgentQuestionInterruption | undefined {
  const eventsPath = path.join(assignmentPath, 'logs', 'runtime-events.jsonl')
  if (!fs.existsSync(eventsPath)) return undefined
  let interruption: AgentQuestionInterruption | undefined
  for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) {
    const event = parseJsonRecord(line)
    if (event?.event !== 'run.awaiting_agent_input' || typeof event.timestamp !== 'string') continue
    // A durable step that resumes runs `runTeam` again against the same child
    // assignment (`workflows/runner.ts:2251`), and recovery clears only the
    // temporary path, so this log still holds the previous invocation's pause.
    // That is what the recency check rejects. `Date.parse` answers NaN for a
    // timestamp it cannot read, and NaN loses every comparison, so `< startedAt`
    // alone kept exactly the lines it was written to drop.
    const recordedAt = Date.parse(event.timestamp)
    if (!Number.isFinite(recordedAt) || recordedAt < startedAt) continue
    const parsed = agentQuestionInterruptionSchema.safeParse(event.interruption)
    if (parsed.success) interruption = parsed.data
  }
  return interruption
}

function resolveChildRuntimeTerminalStatus(
  assignmentPath: string,
): NonNullable<TeamRunResult['status']> | null {
  const runtimeEventsPath = path.join(assignmentPath, 'logs', 'runtime-events.jsonl')
  if (!fs.existsSync(runtimeEventsPath)) return null

  let terminalStatus: NonNullable<TeamRunResult['status']> | null = null
  for (const line of fs.readFileSync(runtimeEventsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const event = parseJsonRecord(line)
      if (!event) continue
      const eventName = typeof event.event === 'string'
        ? event.event
        : typeof event.type === 'string'
          ? event.type
          : ''
      if (eventName === 'run.completed') terminalStatus = 'completed'
      else if (eventName === 'run.failed') terminalStatus = 'failed'
      else if (
        eventName === 'run.blocked' ||
        eventName === 'run.cancelled' ||
        eventName === 'run.incomplete'
      ) {
        terminalStatus = 'blocked'
      }
    } catch {
      continue
    }
  }
  return terminalStatus
}

export function buildDelegatedRecoveryPrompt(
  inputArtifact: string,
  outputArtifact: string,
  originalPrompt: string,
): string {
  return (
    `${originalPrompt}\n\n` +
    `Recovery attempt: the previous delegated child run ended without calling any tools and did not produce ` +
    `\`${outputArtifact}\`.\n` +
    `Do not end this turn idle.\n` +
    `Use the delegated input artifact \`${inputArtifact}\` as the source of truth and start the active stage now.\n` +
    `If the stage is discussion, do not wait for user approval in this delegated session: select the roster yourself, ` +
    `call \`set_roster\`, call \`create_brief\`, then call \`converse\`.\n` +
    `If the stage is routing, do not ask follow-up questions or wait for approval: ` +
    `treat the delegated brief as sufficient, choose the best available specialist team, and call \`spawn_team\` now.\n` +
    `If the stage is chain, call \`handoff\` immediately to start the agent sequence. ` +
    `If the previous attempt was blocked due to missing inputs, treat all unresolved gaps as non-blocking and proceed with available analysis as the source of truth.\n` +
    `If you still cannot proceed, surface the blocker explicitly in the stage output instead of stopping silently.`
  )
}

type TeamAttemptResult = TeamRunResult & {
  artifactExists: boolean
}

function resolveTeamRunStatus(params: {
  artifactPath: string | null
  assignmentPath: string
  succeeded: boolean
}): NonNullable<TeamRunResult['status']> {
  if (params.artifactPath && fs.existsSync(params.artifactPath)) {
    const parsed = parseMarkdownArtifact(fs.readFileSync(params.artifactPath, 'utf8'))
    const artifactStatus = String(parsed.metadata.status ?? '').toLowerCase()
    if (artifactStatus === 'approved_with_warnings' || artifactStatus === 'completed_with_warnings') {
      return 'completed_with_warnings'
    }
    if (artifactStatus === 'blocked' || artifactStatus === 'needs_input') return 'blocked'
    if (artifactStatus === 'failed' || artifactStatus === 'error') return 'failed'
  }

  const runtimeTerminalStatus = resolveChildRuntimeTerminalStatus(params.assignmentPath)
  if (runtimeTerminalStatus) return runtimeTerminalStatus

  const checkpointOutcome = resolveChildCheckpointOutcome(params.assignmentPath)
  if (checkpointOutcome) return checkpointOutcome.status

  const reviewEventsPath = path.join(params.assignmentPath, 'logs', 'review-events.jsonl')
  if (
    fs.existsSync(reviewEventsPath) &&
    /"step":"loop\.max-iterations-reached"/.test(fs.readFileSync(reviewEventsPath, 'utf8'))
  ) {
    return 'blocked'
  }

  return params.succeeded ? 'completed' : 'failed'
}

async function runTeamAttempt(params: {
  teamPath: string
  teamName: string
  workspacePath: string
  workspacePathOverride?: string
  assignmentPath: string
  childSessionId: string
  inputArtifact: string
  outputArtifact: string
  requestedResultType?: string
  runtimeOverrides?: TeamRuntimeOverrides
  humanInputRoutingFile?: string
  spawnDepth: number
  signal?: AbortSignal
  budgetUsd?: number
  budgetPolicy?: BudgetPolicy
  rootSessionId?: string
  parentSessionId?: string
  workflowId?: string
  workflowStepId?: string
  timeoutMinutes?: number
  delegatedPrompt: string
  startedAt: number
  bootEntry?: TeamRunOptions['bootEntry']
  assignmentLocation?: SessionRunAssignmentLocation
  delegatedAuthority?: DelegatedRuntimeAssignmentAuthority
  recoveryMode?: boolean
  idempotencyKey?: string
  executionMode?: TeamRunOptions['executionMode']
}): Promise<TeamAttemptResult> {
  const {
    teamPath,
    teamName,
    workspacePath,
    workspacePathOverride,
    assignmentPath,
    childSessionId,
    inputArtifact,
    outputArtifact,
    requestedResultType,
    runtimeOverrides,
    humanInputRoutingFile,
    spawnDepth,
    signal,
    budgetUsd,
    budgetPolicy,
    rootSessionId,
    parentSessionId,
    workflowId,
    workflowStepId,
    timeoutMinutes,
    delegatedPrompt,
    startedAt,
    bootEntry,
    assignmentLocation,
    delegatedAuthority,
    recoveryMode,
    idempotencyKey,
    executionMode,
  } = params

  const extensionPath = path.join(teamPath, 'index.ts')
  const fallbackPath = process.env[RUNTIME_EXTENSION_ENTRY_ENV]
    ? path.resolve(process.env[RUNTIME_EXTENSION_ENTRY_ENV])
    : path.resolve(__dirname, '..', '..', 'team-runtime', 'index.ts')
  const entryPoint = fs.existsSync(extensionPath) ? extensionPath : fallbackPath
  resolveOwnedAssignmentRelativePath({
    assignmentPath,
    relativePath: inputArtifact,
    label: 'Child input artifact',
  })
  resolveOwnedAssignmentRelativePath({
    assignmentPath,
    relativePath: outputArtifact,
    label: 'Child output artifact',
  })
  // `.runtime` must exist privately before a recursive mkdir creates it as
  // an intermediate at the umask mode: the journal refuses a non-private
  // runtime directory, and whichever writer arrives first would otherwise
  // decide the run's private permissions.
  ensureRunPrivateRuntimeDirectory(assignmentPath)
  const attemptTemporaryPath = getRunAttemptTemporaryPath(
    assignmentPath,
    randomUUID(),
  )
  // Private from the moment it exists: it holds this attempt's copy of the
  // user's Pi credentials, and `recursive` only applies a mode to directories
  // it actually creates, so the mode is stated again for the case where it did
  // not. Only where the platform can represent it — Windows cannot, and
  // asserting `0700` there would fail on a perfectly good directory.
  const { enforcesPermissionBits } = resolveFilesystemOwnershipPolicy(process.platform)
  fs.mkdirSync(
    attemptTemporaryPath,
    enforcesPermissionBits ? { recursive: true, mode: 0o700 } : { recursive: true },
  )
  if (enforcesPermissionBits) fs.chmodSync(attemptTemporaryPath, 0o700)

  const args = ['-e', entryPoint, '-p', '--no-session', '--mode', 'json', delegatedPrompt]

  // Everything the attempt reserves, released exactly once from wherever the
  // attempt ends: a preparation failure, a spawn that never started, or a
  // settled run. The isolated directory goes first so its link-preserving
  // removal runs before the recursive delete of the directory containing it.
  let isolatedPiAgentDirectory: IsolatedPiAgentDirectory | undefined
  let attemptResourcesReleased = false
  const releaseAttemptResources = (): void => {
    if (attemptResourcesReleased) return
    attemptResourcesReleased = true
    isolatedPiAgentDirectory?.dispose()
    fs.rmSync(attemptTemporaryPath, { recursive: true, force: true })
  }

  let invocation: ReturnType<typeof buildPiInvocation>
  try {
    // The host switches models on every coordinator handover, and Pi persists
    // each switch as the user's default in `<agentDir>/settings.json`. The
    // child gets its own agent directory so those writes stay inside the run.
    //
    // It lives inside this attempt's temporary directory, under the run's
    // private `.runtime` tree, which is excluded from the run's public
    // artifacts — the credentials copied into it are never published. Being
    // outside the temporary root also makes it parent-owned: the child is given
    // no deletion token for it.
    isolatedPiAgentDirectory = isolatePiAgentDirectory({
      containingDirectoryPath: attemptTemporaryPath,
    })
    invocation = buildPiInvocation(args)
  } catch (error) {
    // Nothing has been spawned, so nothing will arrive later to clean up.
    releaseAttemptResources()
    throw error
  }
  const isolatedAgentEnvironment = isolatedPiAgentDirectory.environment
  // Under an ownership scope the child is recorded before it exists and
  // started through its host, so a closer can always find and stop it.
  let owned: PreparedOwnedProcess | undefined
  try {
    owned = await prepareOwnedProcess({
      environment: process.env,
      kind: 'team',
      childRunId: childSessionId,
      spawnerRunId: rootSessionId ?? null,
      spawnerAssignmentId: parentSessionId ?? null,
    })
  } catch (error) {
    releaseAttemptResources()
    throw error
  }
  const spawnCommand = owned
    ? ownedProcessHostInvocation({
        ownedProcessId: owned.ownedProcessId,
        command: invocation.command,
        args: invocation.args,
      })
    : { command: invocation.command, args: invocation.args }

  const ownedChild = owned
  return new Promise((resolve, reject) => {
    // Wrapped so a synchronous spawn failure still releases the copied
    // credentials, without widening the child's inferred stdio types.
    const proc = (() => {
      try {
        return spawn(spawnCommand.command, [...spawnCommand.args], {
          cwd: assignmentPath,
          shell: false,
          // New process group on POSIX so termination can signal the whole group
          // (provider grandchildren) instead of only the direct child.
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...withoutRootTaskLaunchSecrets(invocation.env),
            ...(assignmentLocation
              ? buildRuntimeAssignmentEnvironment(assignmentLocation)
              : {}),
            ...(delegatedAuthority
              ? {
                  [RUNTIME_TASK_ID_ENV]: delegatedAuthority.taskId,
                  [RUNTIME_PROCESS_IDENTITY_ENV]:
                    delegatedAuthority.processIdentity,
                }
              : {}),
            TEAM_SPAWN_DEPTH: String(spawnDepth + 1),
            TEAM_BUDGET_CAP: budgetUsd !== undefined ? String(budgetUsd) : '',
            TEAM_BUDGET_POLICY: budgetPolicy ?? '',
            TEAM_ROOT_SESSION_ID: process.env.TEAM_ROOT_SESSION_ID || rootSessionId || '',
            TEAM_PARENT_SESSION_ID: parentSessionId || '',
            ...(workflowId ? { TEAM_RUNTIME_WORKFLOW_ID: workflowId } : {}),
            ...(workflowStepId
              ? { TEAM_RUNTIME_WORKFLOW_STEP_ID: workflowStepId }
              : {}),
            TEAM_SESSION_ID: childSessionId,
            TEAM_CONFIG_PATH: path.join(teamPath, 'team.yaml'),
            TEAM_BOOT_ENTRY_JSON: bootEntry ? JSON.stringify(bootEntry) : '',
            TEAM_CONFIG_OVERRIDES_JSON: runtimeOverrides ? JSON.stringify(runtimeOverrides) : '',
            TEAM_HUMAN_INPUT_ROUTING_FILE: humanInputRoutingFile ?? '',
            TEAM_WORKSPACE_PATH: workspacePathOverride ?? workspacePath,
            TEAM_INPUT_ARTIFACT: inputArtifact,
            TEAM_OUTPUT_ARTIFACT: outputArtifact,
            TEAM_DELEGATED_AUTOSTART: '1',
            TEAM_CHAT_MODE: executionMode === 'team-chat' ? '1' : '0',
            TEAM_RUNTIME_START_SERVICES: '0',
            TEAM_RUNTIME_RECOVERY: recoveryMode ? '1' : '0',
            TEAM_RUNTIME_IDEMPOTENCY_KEY: idempotencyKey ?? '',
            // The engines that produce participant text run in this process, so
            // the display-stream values have to make this hop. Named explicitly:
            // this environment is built rather than inherited, and these three
            // are deliberately absent from the provider-CLI allowlist below it.
            ...forwardAgentTextStreamEnvironment(process.env),
            TMPDIR: attemptTemporaryPath,
            TMP: attemptTemporaryPath,
            TEMP: attemptTemporaryPath,
            // Last, so it overrides whatever the parent was using. Pi resolves its
            // agent directory from this variable, so this is the entry that keeps a
            // handover out of the user's own settings file.
            ...isolatedAgentEnvironment,
            ...(owned ? ownedProcessHostEnvironment(owned) : {}),
          },
        })
      } catch (error) {
        // A spawn that never started still copied the credentials.
        releaseAttemptResources()
        throw error
      }
    })()

    /** What the run decided, before it is allowed to say so. */
    type SettleDecision =
      | { readonly kind: 'resolve'; readonly value: TeamAttemptResult }
      | { readonly kind: 'reject'; readonly error: Error }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    let terminationRequested = false
    /** Whether forcing the group to terminate has come back, confirmed or not. */
    let terminationOutcomeKnown = false
    let settled = false
    /** The three facts this run turns on, and the only thing that judges them. */
    const settlement = new DelegatedSettlement({ closesSubtree: ownedChild !== undefined })
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let totalCost = 0
    let costTracked = false
    let buffer = ''
    let stderrBuffer = ''

    const appendStderr = (text: string): void => {
      stderrBuffer += text
      if (stderrBuffer.length > 8000) stderrBuffer = stderrBuffer.slice(-8000)
    }
    const collectCost = (line: string): void => {
      if (!line.trim()) return
      // Child stdout can include non-protocol diagnostics; those parse to null.
      const event = parseJsonRecord(line)
      if (event?.type !== 'message_end' || !isRecord(event.message)) return
      const usage = event.message.usage
      const cost = isRecord(usage) ? usage.cost : undefined
      const total = isRecord(cost) ? cost.total : undefined
      if (typeof total === 'number' && Number.isFinite(total)) {
        totalCost = roundUsd(totalCost + total)
        costTracked = true
      }
    }
    const appendStdout = (text: string): void => {
      buffer += text
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) collectCost(line)
    }

    const signalChild = (sig: NodeJS.Signals): void => {
      const pid = proc.pid
      if (pid !== undefined && process.platform !== 'win32') {
        try {
          // Signal the child's whole process group so grandchildren cannot
          // hold stdout/stderr open and block 'close' after the child dies.
          process.kill(-pid, sig)
          return
        } catch { /* Group already gone (ESRCH) — fall back to the child only. */ }
      }
      if (proc.exitCode !== null || proc.killed) return
      try { proc.kill(sig) } catch { /* Process already exited. */ }
    }

    const groupIsGone = (): boolean => {
      const pid = proc.pid
      if (pid === undefined || process.platform === 'win32') {
        return proc.exitCode !== null || proc.signalCode !== null
      }
      try {
        process.kill(-pid, 0)
        return false
      } catch (error) {
        // ESRCH is the only "actually gone" answer; EPERM means still there.
        return (error as NodeJS.ErrnoException).code === 'ESRCH'
      }
    }

    const delay = (ms: number): Promise<void> =>
      new Promise((settle) => {
        // Referenced on purpose. An unref'd timer is dropped the moment the
        // loop empties, which is how the original escalation was lost.
        setTimeout(settle, ms)
      })

    const waitForGroupExit = async (windowMs: number): Promise<boolean> => {
      const deadline = Date.now() + windowMs
      while (Date.now() < deadline) {
        if (groupIsGone()) return true
        await delay(20)
      }
      return groupIsGone()
    }

    /**
     * The single force-cleanup operation: TERM -> bounded grace -> SIGKILL ->
     * bounded confirmation. One timer source, one promise.
     *
     * It returns a typed outcome and never rejects, so no caller needs an empty
     * catch to keep the rejection handled. The outcome is recorded on the
     * settlement, which fails the cancellation when the group could not be
     * confirmed dead and keeps the run's resources — reporting success over a
     * live orphan is the bug this exists to prevent.
     */
    const forceTerminateGroup = async (): Promise<DelegatedTerminationOutcome> => {
      signalChild('SIGTERM')
      if (await waitForGroupExit(DELEGATED_SIGKILL_GRACE_PERIOD_MS)) {
        return { terminated: true }
      }

      signalChild('SIGKILL')
      if (await waitForGroupExit(DELEGATED_TERMINATION_CONFIRM_MS)) {
        return { terminated: true }
      }

      return {
        terminated: false,
        reason:
          `Delegated process group ${proc.pid ?? 'unknown'} was still alive ` +
          `${DELEGATED_SIGKILL_GRACE_PERIOD_MS + DELEGATED_TERMINATION_CONFIRM_MS}ms ` +
          'after SIGTERM and SIGKILL.',
      }
    }

    const abortChild = (): void => {
      if (terminationRequested) return
      terminationRequested = true
      settlement.recordTerminationRequested()
      // The termination result is a fact in its own right, not something only a
      // close can reveal. A survivor can hold the child's stdout open, so a run
      // that reconciled on `close` alone would hang on exactly the group it
      // failed to kill. Nothing else reads this promise, so it is consumed here
      // rather than parked in a variable for some later step to remember.
      // The subtree close starts here, not at the close, while termination is
      // in flight: see `finish`.
      void forceTerminateGroup().then(
        (outcome) => {
          terminationOutcomeKnown = true
          settlement.recordTermination(outcome)
          closeChildSubtree()
          reconcile()
        },
        (error: unknown) => {
          terminationOutcomeKnown = true
          settlement.recordTermination({
            terminated: false,
            reason: error instanceof Error ? error.message : String(error),
          })
          closeChildSubtree()
          reconcile()
        },
      )
    }
    const cleanup = (): void => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (signal) signal.removeEventListener('abort', abortChild)
    }
    /**
     * Once the child has exited, for any reason, its subtree is closed: its
     * nested Teams and file-parser runs live in their own groups
     * (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md,
     * section 8). Started once; its result is the settlement's fourth fact.
     */
    let subtreeCloseStarted = false
    const closeChildSubtree = (): void => {
      if (!ownedChild || subtreeCloseStarted) return
      subtreeCloseStarted = true
      void closeOwnedProcessSubtree(ownedChild.scopePath, ownedChild.ownedProcessId, 'spawner').then(
        (closed) => {
          settlement.recordSubtreeClosure(
            closed.kind === 'closed'
              ? { closed: true }
              : {
                  closed: false,
                  reason: closed.unverifiable
                    .map((member) => `${member.ownedProcessId}: ${member.reason}`)
                    .join('; '),
                },
          )
          reconcile()
        },
        (error: unknown) => {
          settlement.recordSubtreeClosure({
            closed: false,
            reason: error instanceof Error ? error.message : String(error),
          })
          reconcile()
        },
      )
    }
    const finish = (
      code: number | null,
      exitSignal: NodeJS.Signals | null,
      spawnError?: Error,
    ): void => {
      settlement.recordChildClose({
        code,
        signal: exitSignal,
        ...whenDefined(spawnError, (error) => ({ spawnError: error })),
      })
      // The child's host is reaped by now, so its group id may be reused, and
      // whatever still runs in that group is unverified. A later abort or
      // timeout must not signal it: from here the subtree close, which verifies
      // every target before signalling, is the only thing that signals.
      cleanup()
      // While the group is being terminated, a close says only that the host
      // and its target have exited; the rest of the group may still be
      // handling SIGTERM, and the subtree close would find it alive with no
      // host and hold it. The close starts once termination has come back.
      if (!terminationRequested || terminationOutcomeKnown) closeChildSubtree()
      reconcile()
    }

    /**
     * Act on whatever the settlement can now decide, at most once.
     *
     * Called from both facts — the child closing and the group's termination
     * coming back — because either can be the one that completes the picture.
     */
    const reconcile = (): void => {
      if (settled) return
      const decision = settlement.decide()
      if (decision.kind === 'wait') return
      settled = true
      cleanup()

      if (decision.kind === 'abandon') {
        // Nothing is released. The group may still be using the private agent
        // directory, and the message says so rather than leaving whoever finds
        // it to guess.
        reject(decision.cause === 'held_subtree' ? new HeldSubtreeError(decision.message) : new Error(decision.message))
        return
      }

      // Describing the outcome reads the run's own files and can throw. This
      // runs from a close listener, where a throw would escape into the emitter
      // and leave the run promise unresolved, so a failure here becomes the
      // outcome instead of escaping it.
      let outcome: SettleDecision
      try {
        outcome = describeOutcome(
          decision.close.code,
          decision.close.signal,
          decision.close.spawnError,
        )
      } catch (error) {
        outcome = {
          kind: 'reject',
          error: error instanceof Error ? error : new Error(String(error)),
        }
      }
      settleReportedOutcome(outcome)
    }

    /**
     * Release once, then say what happened.
     *
     * Only reached on a decision to report, which is only made when nothing in
     * the group can still be using the run's resources — either the run was
     * never cancelled, or its termination was confirmed. Whether it is safe to
     * clean up is decided in `DelegatedSettlement`; this does the cleaning up.
     */
    const settleReportedOutcome = (decision: SettleDecision): void => {
      let cleanupFailure: Error | null = null
      try {
        releaseAttemptResources()
      } catch (error) {
        cleanupFailure = error instanceof Error ? error : new Error(String(error))
      }

      // A run that could not release its copy of the user's credentials has not
      // finished cleanly. When something else failed too, both are reported:
      // the first is what the caller asked about, and the second says the
      // copied credentials may still be on disk — which nobody should have to
      // discover later from a directory nobody removed.
      if (decision.kind === 'reject') {
        reject(withCleanupFailure(decision.error, cleanupFailure))
        return
      }
      if (cleanupFailure) {
        reject(cleanupFailure)
        return
      }
      resolve(decision.value)
    }

    const describeOutcome = (
      code: number | null,
      exitSignal: NodeJS.Signals | null,
      spawnError?: Error,
    ): SettleDecision => {
      appendStdout(stdoutDecoder.end())
      collectCost(buffer)
      buffer = ''
      appendStderr(stderrDecoder.end())

      const artifactPath = resolveTeamArtifactPath({
        assignmentPath,
        outputArtifact,
      })
      const artifactExists = Boolean(artifactPath && fs.existsSync(artifactPath))
      const interruption = readChildQuestionInterruption(assignmentPath, startedAt)
      const runtimeTerminalStatus = resolveChildRuntimeTerminalStatus(assignmentPath)
      const completedTeamChat = executionMode === 'team-chat' && runtimeTerminalStatus === 'completed'
      const artifactSucceeded = !spawnError && code === 0 && artifactExists
      let outputText = '[No output artifact produced]'
      if (spawnError) {
        outputText = `[Child team process could not start: ${spawnError.message}]`
      } else if (artifactExists && artifactPath) {
        outputText = fs.readFileSync(artifactPath, 'utf-8')
      } else if (code !== 0) {
        const stderrSummary = stderrBuffer.trim() || '[no stderr captured]'
        outputText =
          `[Child team process failed: exit ${code}${exitSignal ? `, signal ${exitSignal}` : ''}]\n\n` +
          stderrSummary
      } else if (completedTeamChat) {
        outputText = '[Team chat response completed]'
      } else if (!artifactExists) {
        const diagnostics = summarizeMissingChildOutput(assignmentPath, outputArtifact)
        const stderrSummary = stderrBuffer.trim()
        // Both, not either. A startup crash leaves its only trace on stderr, and
        // discarding it whenever any diagnostic existed is how the cause of a
        // failed run became unreadable.
        outputText =
          `[Child team process completed without producing the expected output artifact: ${outputArtifact}]` +
          (diagnostics ? `\n\n${diagnostics}` : '') +
          (stderrSummary ? `\n\nChild stderr:\n${stderrSummary}` : '')
      }

      const status = spawnError
        ? 'failed'
        : resolveTeamRunStatus({
            artifactPath,
            assignmentPath,
            succeeded: artifactSucceeded,
          })
      const succeeded = status === 'completed' || status === 'completed_with_warnings'

      return {
        kind: 'resolve',
        value: {
          ...(interruption ? { interruption } : {}),
          text: interruption?.kind === 'blocked' ? `Agent continuation blocked: ${interruption.code}.` : outputText,
          cost: totalCost,
          durationMs: Date.now() - startedAt,
          artifactPath: artifactPath ?? '',
          assignmentPath,
          childSessionId,
          ...whenDefined(requestedResultType, (presentRequestedResultType) => ({
            requestedResultType: presentRequestedResultType,
          })),
          costTracked,
          ...(interruption?.kind === 'blocked' ? { status: 'blocked' as const } : interruption ? {} : { status }),
          succeeded,
          exitCode: code,
          exitSignal,
          artifactExists,
        },
      }
    }

    if (signal) {
      if (signal.aborted) abortChild()
      else signal.addEventListener('abort', abortChild, { once: true })
    }

    if (timeoutMinutes && Number.isFinite(timeoutMinutes) && timeoutMinutes > 0) {
      timeoutHandle = setTimeout(() => {
        abortChild()
      }, timeoutMinutes * 60 * 1000)
    }

    proc.stdout.on('data', (chunk: Buffer) => {
      appendStdout(stdoutDecoder.write(chunk))
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      appendStderr(stderrDecoder.write(chunk))
    })

    proc.once('error', (error) => finish(null, null, error))
    proc.once('close', (code, exitSignal) => finish(code, exitSignal))
  })
}

/**
 * Run a single agent via the appropriate provider.
 *
 * Resolves the provider name from options (default: 'anthropic'), looks it up in
 * the registry, and delegates execution. Timeout handling lives here so
 * all providers benefit from it uniformly.
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const providerName = options.provider ?? 'anthropic'
  const startedAt = Date.now()

  // Build combined AbortSignal (timeout + caller signal)
  let timeoutController: AbortController | null = null
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  let combinedSignal: AbortSignal | undefined = options.signal

  if (options.timeoutMinutes) {
    const controller = new AbortController()
    timeoutController = controller
    const timeoutMs = options.timeoutMinutes * 60 * 1000
    timeoutHandle = setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    if (options.signal) {
      combinedSignal = AbortSignal.any([options.signal, controller.signal])
    } else {
      combinedSignal = controller.signal
    }
  }

  try {
    const workerTurn = await runMcpWorkerTurn({
      options,
      provider: providerName,
      ...whenDefined(combinedSignal, (signal) => ({ signal })),
      ...whenDefined(options.workerEnvironment, (environment) => ({ environment })),
    })
    if (workerTurn && (workerTurn.kind === 'completed' || workerTurn.kind === 'awaiting_input' || workerTurn.kind === 'blocked')) {
      const actualProvider = workerTurn.kind === 'completed' ? workerTurn.provider ?? providerName : providerName
      const usageCost = calculateUsageCost({
        provider: actualProvider,
        model: workerTurn.model,
        inputTokens: workerTurn.usage.inputTokens,
        outputTokens: workerTurn.usage.outputTokens,
        ...whenDefined(actualProvider === providerName ? options.providerConfig : undefined, (providerConfig) => ({ providerConfig })),
      })
      const zeroMarginalCost = ZERO_MARGINAL_COST_PROVIDERS.has(actualProvider)
      // This transport carries no token stream: the parent runs the whole
      // tool-using turn and answers once. Reporting that one answer is the
      // most this path can honestly offer, and the alternative — saying
      // nothing — is what left tool-enabled Team agents with no bubble at all.
      // The bubble therefore appears rather than grows, which is the stated
      // limit of the MCP worker path.
      if (options.onProtocolEvent && workerTurn.kind === 'completed' && workerTurn.text) {
        try {
          options.onProtocolEvent({
            kind: 'text',
            provider: actualProvider,
            text: workerTurn.text,
            model: workerTurn.model,
          })
        } catch {
          // Display-only: an observer that throws must not fail the turn.
        }
      }
      return {
        provider: actualProvider,
        text: workerTurn.kind === 'completed' ? workerTurn.text : '',
        ...(workerTurn.kind === 'completed' ? {} : { interruption: workerTurn.interruption }),
        // The parent decided which of this Agent's settings its lane applies.
        // Carried out so the dispatch that owns the durable record can say so.
        ...(workerTurn.droppedProviderOptions?.length
          ? { droppedProviderOptions: [...workerTurn.droppedProviderOptions] }
          : {}),
        cost: usageCost.cost,
        durationMs: Date.now() - startedAt,
        inputTokens: workerTurn.usage.inputTokens,
        outputTokens: workerTurn.usage.outputTokens,
        contextTokens: workerTurn.usage.totalTokens,
        model: workerTurn.model,
        costTracked: usageCost.tracked || zeroMarginalCost,
        costSource: zeroMarginalCost && !usageCost.tracked
          ? 'zero_cost'
          : usageCost.source,
      }
    }
    const requiresBrowser = options.tools?.includes('browser') === true
    const requiresYoutube = options.tools?.includes('youtube_extract') === true
    const requiresGenerateWord = options.tools?.includes('generate_word') === true
    const requiresGenerateExcel = options.tools?.includes('generate_excel') === true
    const requiresParentTool =
      requiresBrowser || requiresYoutube || requiresGenerateWord || requiresGenerateExcel
    if (workerTurn && requiresParentTool) {
      const providerSupport = workerTurn.providerSupport
      const providerUnsupported = workerTurn.kind === 'provider-unsupported'
      throw new ProviderError({
        provider: providerName,
        message: providerUnsupported
          ? mcpProviderSupportReason(providerSupport) ??
            (requiresYoutube
              ? 'The selected provider and model cannot use the managed YouTube extractor.'
              : requiresGenerateWord
                ? 'The selected provider and model cannot use Generate Word.'
              : requiresGenerateExcel
                ? 'The selected provider and model cannot use Generate Excel.'
              : 'The selected provider and model cannot use the managed Browser.')
          : requiresYoutube
            ? 'The managed YouTube extractor is unavailable for this agent.'
            : requiresGenerateWord
              ? 'Generate Word is unavailable for this agent.'
            : requiresGenerateExcel
              ? 'Generate Excel is unavailable for this agent.'
            : 'The managed Browser tool is unavailable for this agent.',
        kind: 'configuration',
        code: providerUnsupported
          ? providerSupport.reasonCode ?? 'mcp_provider_unsupported'
          : requiresYoutube
            ? 'mcp_youtube_tool_unavailable'
            : requiresGenerateWord
              ? 'mcp_generate_word_tool_unavailable'
            : requiresGenerateExcel
              ? 'mcp_generate_excel_tool_unavailable'
            : 'mcp_browser_tool_unavailable',
        retryable: false,
      })
    }

    const provider = getProvider(providerName)
    const result = await executeProvider(provider, {
      systemPrompt: options.systemPrompt,
      userMessage: options.userMessage,
      model: options.model,
      thinking: options.thinking,
      ...whenDefined(options.tools, (tools) => ({ tools })),
      ...whenDefined(options.cwd, (cwd) => ({ cwd })),
      ...whenDefined(combinedSignal, (signal) => ({ signal })),
      ...whenDefined(options.outputPath, (outputPath) => ({ outputPath })),
      ...whenDefined(options.outputSchema, (outputSchema) => ({ outputSchema })),
      ...whenDefined(options.sessionId, (sessionId) => ({ sessionId })),
      ...whenDefined(options.rootSessionId, (rootSessionId) => ({ rootSessionId })),
      ...whenDefined(options.agentName, (agentName) => ({ agentName })),
      ...whenDefined(options.providerConfig, (providerConfig) => ({ providerConfig })),
      ...whenDefined(options.onProtocolEvent, (onProtocolEvent) => ({
        // Display-only. Wrapped so a throwing observer cannot fail the turn:
        // observability never changes execution outcomes.
        onProtocolEvent: (event: ProviderProtocolEvent) => {
          try {
            onProtocolEvent(event)
          } catch {
            // Intentionally swallowed.
          }
        },
      })),
    })
    const zeroMarginalCost = ZERO_MARGINAL_COST_PROVIDERS.has(providerName)
    const costTracked = result.costTracked ?? (zeroMarginalCost || result.cost > 0)
    const costSource = result.costSource ?? (
      zeroMarginalCost
        ? 'zero_cost'
        : costTracked
          ? 'reported'
          : 'untracked'
    )
    if (!costTracked && !warnedProviders.has(providerName)) {
      warnedProviders.add(providerName)
      console.warn(
        `[team-runtime] Warning: provider '${providerName}' has no usage pricing. ` +
        `Configure input_cost_per_million_usd and output_cost_per_million_usd ` +
        `before enabling a hard USD budget.`,
      )
    }

    return {
      text: result.text,
      cost: result.cost,
      durationMs: result.durationMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      contextTokens: result.contextTokens,
      model: result.model,
      costTracked,
      costSource,
    }
  } catch (err) {
    // If the timeout fired, convert to TimeoutError
    if (timeoutController?.signal.aborted && !(options.signal?.aborted)) {
      const timeoutMinutes = options.timeoutMinutes
      if (timeoutMinutes === undefined) throw err
      const timeoutMs = timeoutMinutes * 60 * 1000
      throw new TimeoutError(options.agentName ?? 'unknown', timeoutMs, timeoutMs)
    }
    // The worker bridge reports a provider-level identity for a truncated or
    // stalled turn. Rebuilding the typed failure here is what lets failure
    // policy classify it; an untyped bridge error defaults to retryable and
    // would retry a truncation against the same ceiling.
    if (err instanceof McpWorkerTurnClientError) {
      const providerFailure = providerErrorFromWorkerFailure(err, providerName)
      if (providerFailure) throw providerFailure
    }
    throw err
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

/**
 * Run an entire team as a subprocess.
 *
 * Writes a brief into the target team's workspace, spawns `pi -e team-runtime.ts`
 * in the team's directory, waits for completion, and reads the output artifact.
 *
 * Used for team-of-teams composition (Phase 5).
 */
/**
 * Write a delegated child's human-input routing file and return its path.
 *
 * Extracted so the one place that seeds a fresh child assignment's private
 * runtime directory is nameable and testable; `runTeam` spawns a real agent, so
 * it is not a boundary a test can drive for this.
 */
export function writeChildHumanInputRoutingFile(
  assignmentPath: string,
  routing: HumanInputRoutingContext,
): string {
  // Create the private runtime directory through its owner first.
  // `writeFileAtomicSync` would otherwise create it as a side effect with no
  // mode, leaving it world-readable and permanently unenrollable.
  const routingFile = path.join(
    ensureRunPrivateRuntimeDirectory(assignmentPath),
    'human-input-routing.json',
  )
  writeFileAtomicSync(routingFile, JSON.stringify(routing))
  return routingFile
}

export async function runTeam(options: TeamRunOptions): Promise<TeamRunResult> {
  const startedAt = Date.now()

  // Guard rail: check spawn depth
  const maxDepth = DEFAULT_MAX_SPAWN_DEPTH
  if (options.spawnDepth >= maxDepth) {
    return {
      text: `[Error: Maximum team spawn depth (${maxDepth}) exceeded. Cannot spawn nested team.]`,
      cost: 0,
      durationMs: Date.now() - startedAt,
      artifactPath: '',
      assignmentPath: '',
      childSessionId: '',
      costTracked: true,
      status: 'failed',
      succeeded: false,
      exitCode: null,
      exitSignal: null,
    }
  }

  const teamPath = options.teamPath
  const teamName = path.basename(teamPath)
  const inputArtifact = options.inputArtifact ?? 'incoming-brief.md'
  const outputArtifact = options.outputArtifact ?? 'output/memo.md'
  const workspacePath = options.workspacePath
  const safeTeamName = teamName.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'team'
  const childSessionId = options.childSessionId ?? `child-${safeTeamName}-${randomUUID()}`
  const parentAssignmentLocation = options.parentAssignmentLocation
    ?? resolveRuntimeAssignmentLocation(workspacePath)
  const assignmentLocation = buildChildAssignmentLocation(
    workspacePath,
    parentAssignmentLocation,
    childSessionId,
  )
  const assignmentPath = assignmentLocation?.assignmentPath
    ?? resolveAssignmentPath(workspacePath, childSessionId)

  if (options.recoveryMode) {
    fs.rmSync(getRunRuntimePaths(assignmentPath).temporaryPath, {
      recursive: true,
      force: true,
    })
  }

  // Write brief into the child assignment so all delegated state stays session-scoped.
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(assignmentPath, { recursive: true })
  if (assignmentLocation) {
    await writeRunAssignmentLocator(workspacePath, assignmentLocation)
  }
  const delegatedAuthority =
    await prepareDelegatedRuntimeAssignmentAuthority({
      workspacePath,
      parentLocation: parentAssignmentLocation,
      childLocation: assignmentLocation,
      environment: process.env,
    })
  const humanInputRoutingFile = options.humanInputRouting
    ? writeChildHumanInputRoutingFile(assignmentPath, options.humanInputRouting)
    : undefined
  const inputArtifactPath = resolveOwnedAssignmentRelativePath({
    assignmentPath,
    relativePath: inputArtifact,
    label: 'Child input artifact',
  })
  const outputArtifactPath = resolveOwnedAssignmentRelativePath({
    assignmentPath,
    relativePath: outputArtifact,
    label: 'Child output artifact',
  })
  const mountPlans = (options.mount ?? []).map((mount) => ({
    from: mount.from,
    to: mount.to,
    destinationPath: resolveOwnedAssignmentRelativePath({
      assignmentPath,
      relativePath: mount.to,
      label: 'Child mount destination',
    }),
  }))
  // A recovery without a checkpoint restarts the child from nothing, so any
  // output left behind is stale and must not be mistaken for this attempt's
  // work. A recovery that has a checkpoint resumes instead: the stage that
  // wrote this file may already be recorded as complete, and deleting it would
  // leave the completion gate looking for an artifact the run will never
  // produce again.
  if (
    options.recoveryMode &&
    !hasCheckpoint(assignmentPath) &&
    fs.existsSync(outputArtifactPath)
  ) {
    const staleOutput = fs.lstatSync(outputArtifactPath)
    if (staleOutput.isDirectory() && !staleOutput.isSymbolicLink()) {
      throw new Error('Child output artifact path cannot be a directory during recovery')
    }
    fs.rmSync(outputArtifactPath, { force: true })
  }
  resolveOwnedAssignmentRelativePath({
    assignmentPath,
    relativePath: inputArtifact,
    label: 'Child input artifact',
  })
  fs.mkdirSync(path.dirname(inputArtifactPath), { recursive: true })
  resolveOwnedAssignmentRelativePath({
    assignmentPath,
    relativePath: inputArtifact,
    label: 'Child input artifact',
  })
  if (path.extname(inputArtifactPath).toLowerCase() === '.md') {
    writeMarkdownArtifact(
      inputArtifactPath,
      options.brief,
      buildArtifactMetadata({
        filePath: inputArtifactPath,
        rootDir: assignmentPath,
        artifactType: 'brief',
        createdAt: new Date(startedAt).toISOString(),
        sessionId: childSessionId,
        ...whenDefined(options.rootSessionId, (rootSessionId) => ({ rootSessionId })),
        ...whenDefined(options.parentSessionId, (parentSessionId) => ({ parentSessionId })),
        status: 'delegated',
      }),
    )
  } else {
    fs.writeFileSync(inputArtifactPath, options.brief)
  }

  // Copy mount artifacts if specified
  if (mountPlans.length > 0) {
    for (const mount of mountPlans) {
      const srcPath = mount.from
      const destPath = mount.destinationPath
      if (fs.existsSync(srcPath)) {
        resolveOwnedAssignmentRelativePath({
          assignmentPath,
          relativePath: mount.to,
          label: 'Child mount destination',
        })
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        resolveOwnedAssignmentRelativePath({
          assignmentPath,
          relativePath: mount.to,
          label: 'Child mount destination',
        })
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }

  // Keep delegated child runs deterministic: the brief is passed through the
  // assignment artifact boundary, not as a free-form host prompt. The kickoff
  // prompt should start coordinator-led child stages, while coordinator-less
  // runtime-owned stages still self-suppress via buildDelegatedAutostartNoopPrompt().
  const delegatedPrompt = options.kickoffPrompt ?? (
    `Delegated child runtime autostart is enabled for this session. ` +
    `Continue the team workflow from the active level using the delegated input artifact ` +
    `\`${inputArtifact}\` as the source of truth. ` +
    `Start the active stage immediately and produce the configured output artifact ` +
    `\`${outputArtifact}\`.`
  )
  let result = await runTeamAttempt({
    teamPath,
    teamName,
    workspacePath,
    ...whenDefined(options.workspacePathOverride, (workspacePathOverride) => ({ workspacePathOverride })),
    assignmentPath,
    childSessionId,
    inputArtifact,
    outputArtifact,
    ...whenDefined(options.requestedResultType, (requestedResultType) => ({ requestedResultType })),
    ...whenDefined(options.runtimeOverrides, (runtimeOverrides) => ({ runtimeOverrides })),
    ...whenDefined(humanInputRoutingFile, (presentHumanInputRoutingFile) => ({ humanInputRoutingFile: presentHumanInputRoutingFile })),
    spawnDepth: options.spawnDepth,
    ...whenDefined(options.signal, (signal) => ({ signal })),
    ...whenDefined(options.budgetUsd, (budgetUsd) => ({ budgetUsd })),
    ...whenDefined(options.budgetPolicy, (budgetPolicy) => ({ budgetPolicy })),
    ...whenDefined(options.rootSessionId, (rootSessionId) => ({ rootSessionId })),
    ...whenDefined(options.parentSessionId, (parentSessionId) => ({ parentSessionId })),
    ...whenDefined(options.workflowId, (workflowId) => ({ workflowId })),
    ...whenDefined(options.workflowStepId, (workflowStepId) => ({ workflowStepId })),
    ...whenDefined(options.timeoutMinutes, (timeoutMinutes) => ({ timeoutMinutes })),
    delegatedPrompt,
    startedAt,
    ...whenDefined(options.bootEntry, (bootEntry) => ({ bootEntry })),
    ...whenDefined(assignmentLocation, (presentAssignmentLocation) => ({ assignmentLocation: presentAssignmentLocation })),
    ...whenDefined(delegatedAuthority, (definedValue) => ({ delegatedAuthority: definedValue })),
    ...whenDefined(options.recoveryMode, (recoveryMode) => ({ recoveryMode })),
    ...whenDefined(options.idempotencyKey, (idempotencyKey) => ({ idempotencyKey })),
    ...whenDefined(options.executionMode, (executionMode) => ({ executionMode })),
  })
  let incurredCost = result.cost
  let incurredCostTracked = result.costTracked

  if (
    !result.interruption &&
    !result.artifactExists &&
    result.exitCode === 0 &&
    childExitedIdleWithoutTools(assignmentPath) &&
    canAttemptTeamRecovery({
      budgetUsd: options.budgetUsd,
      budgetPolicy: options.budgetPolicy,
      incurredCost,
      costTracked: incurredCostTracked,
    })
  ) {
    const recoveryResult = await runTeamAttempt({
      teamPath,
      teamName,
      workspacePath,
      ...whenDefined(options.workspacePathOverride, (workspacePathOverride) => ({ workspacePathOverride })),
      assignmentPath,
      childSessionId,
      inputArtifact,
      outputArtifact,
      ...whenDefined(options.requestedResultType, (requestedResultType) => ({ requestedResultType })),
      ...whenDefined(options.runtimeOverrides, (runtimeOverrides) => ({ runtimeOverrides })),
      ...whenDefined(humanInputRoutingFile, (presentHumanInputRoutingFile) => ({ humanInputRoutingFile: presentHumanInputRoutingFile })),
      spawnDepth: options.spawnDepth,
      ...whenDefined(options.signal, (signal) => ({ signal })),
      ...whenDefined(options.budgetUsd === undefined ? undefined : Math.max(0, options.budgetUsd - incurredCost), (budgetUsd) => ({ budgetUsd })),
      ...whenDefined(options.budgetPolicy, (budgetPolicy) => ({ budgetPolicy })),
      ...whenDefined(options.rootSessionId, (rootSessionId) => ({ rootSessionId })),
      ...whenDefined(options.parentSessionId, (parentSessionId) => ({ parentSessionId })),
      ...whenDefined(options.workflowId, (workflowId) => ({ workflowId })),
      ...whenDefined(options.workflowStepId, (workflowStepId) => ({ workflowStepId })),
      ...whenDefined(options.timeoutMinutes, (timeoutMinutes) => ({ timeoutMinutes })),
      delegatedPrompt: buildDelegatedRecoveryPrompt(inputArtifact, outputArtifact, delegatedPrompt),
      startedAt,
      ...whenDefined(options.bootEntry, (bootEntry) => ({ bootEntry })),
      ...whenDefined(assignmentLocation, (presentAssignmentLocation) => ({ assignmentLocation: presentAssignmentLocation })),
      ...whenDefined(delegatedAuthority, (definedValue) => ({ delegatedAuthority: definedValue })),
      recoveryMode: true,
      ...whenDefined(options.idempotencyKey, (idempotencyKey) => ({ idempotencyKey })),
      ...whenDefined(options.executionMode, (executionMode) => ({ executionMode })),
    })
    incurredCost += recoveryResult.cost
    incurredCostTracked = mergeCostTracking(
      incurredCostTracked,
      recoveryResult.costTracked,
    )
    result = recoveryResult
  }

  return {
    text: result.text,
    ...(result.interruption ? { interruption: result.interruption } : {}),
    cost: incurredCost,
    durationMs: Date.now() - startedAt,
    artifactPath: result.artifactPath,
    assignmentPath: result.assignmentPath,
    childSessionId: result.childSessionId,
    ...whenDefined(result.requestedResultType, (requestedResultType) => ({ requestedResultType })),
    ...whenDefined(incurredCostTracked, (costTracked) => ({ costTracked })),
    ...whenDefined(result.status, (status) => ({ status })),
    succeeded: result.succeeded,
    exitCode: result.exitCode,
    ...whenDefined(result.exitSignal, (exitSignal) => ({ exitSignal })),
  }
}

function canAttemptTeamRecovery(params: {
  budgetUsd: number | undefined
  budgetPolicy: BudgetPolicy | undefined
  incurredCost: number
  costTracked: boolean | undefined
}): boolean {
  if (params.budgetPolicy !== 'halt') return true
  if (params.costTracked !== true) return false
  return params.budgetUsd === undefined || params.incurredCost < params.budgetUsd
}

function mergeCostTracking(
  first: boolean | undefined,
  second: boolean | undefined,
): boolean | undefined {
  if (first === false || second === false) return false
  if (first === true && second === true) return true
  return undefined
}

// ─── Dispatch Helper ─────────────────────────────────────────────────────────

export interface DispatchOptions {
  /** The loaded agent to dispatch to. */
  agent: LoadedAgent
  /** The roster entry (determines team vs agent dispatch). */
  rosterEntry: RosterEntrySlim | undefined
  /** Fully substituted system prompt (agent dispatch only). */
  finalPrompt: string
  /** The user message / task content. */
  userMessage: string
  /** Runtime state (used to add cost + read spawnDepth). */
  state: RuntimeState
  /** Working directory for agent dispatch. */
  workspacePath: string
  /** Assignment-local output/log directory. */
  outputPath: string
  /**
   * Pre-resolved workspace path for team dispatch.
   * Callers must pass `resolveChildWorkspacePath(rosterEntry.team_path)` when
   * the roster entry might be a team so Agent Execution consumes resolved
   * workspace metadata rather than parsing team configuration.
   */
  teamWorkspacePath?: string
  /** Agent metrics to update (active/done/error + cost/rounds). */
  metrics: AgentMetrics | undefined
  signal?: AbortSignal
  onDashboardUpdate?: () => void
  /** B2: Per-dispatch subprocess timeout in minutes. */
  timeoutMinutes?: number
  /** B4: Remaining budget in USD to pass to child teams. */
  budgetUsd?: number
  /** B4: Budget policy to propagate to child teams. */
  budgetPolicy?: BudgetPolicy
  /** Tool/engine that triggered this dispatch. */
  triggerTool?: string
  /** Current team name for lineage. */
  teamName?: string
  /** Current level id for lineage. */
  levelId?: string
  /** Current stage type for lineage. */
  stageType?: string
  /** Logical sender for lineage. */
  fromName?: string
  /** Optional runtime-owned lane used to isolate one research worker turn. */
  activityScopeId?: string
  /** Approved user-facing identity for the runtime-owned worker lane. */
  agentDisplayName?: string
  /** Deep Research evidence acquisition policy for the parent worker turn. */
  governedWebEvidenceMode?: import('../../core/types.js').GovernedWebEvidenceMode
  /**
   * One logical step's call, stable across every attempt it makes — including
   * a fallback that dispatches a different agent.
   */
  logicalInvocationId?: string
  /** 1-based attempt number within that logical invocation. */
  attempt?: number
  /**
   * JSON Schema constraining the provider's final response, for a stage whose
   * output is a machine contract rather than prose. Agent dispatch only: a
   * sub-team is driven by its own configuration, not by the parent's schema.
   */
  outputSchema?: Readonly<Record<string, unknown>>
}

export function applyCostTrackingPolicy(params: {
  provider: string
  costTracked: boolean | undefined
  budgetPolicy: BudgetPolicy | undefined
  text: string
}): string {
  if (!params.budgetPolicy || params.costTracked) return params.text
  const message =
    `Provider '${params.provider}' returned token usage without a configured USD price. ` +
    `Set input_cost_per_million_usd and output_cost_per_million_usd in provider_config ` +
    `or TEAM_PROVIDER_PRICING_JSON.`
  if (params.budgetPolicy === 'halt') {
    throw new ProviderError({
      provider: params.provider,
      message,
      retryable: false,
    })
  }
  return `${params.text}\n\n⚠️ Budget tracking warning: ${message}`
}

/**
 * Dispatch to an agent or sub-team, update metrics, and return the result.
 *
 * Extracted from the identical "is team? → runTeam, else → runAgent, update metrics"
 * block that appeared in all 5 engine execute() functions (code-review C3).
 *
 * Note: callers must pre-resolve `teamWorkspacePath` using
 * `resolveChildWorkspacePath` from `parsers/team-config.js` when the roster
 * entry might be a team. This keeps configuration parsing at the parser
 * boundary while Agent Execution receives resolved workspace metadata.
 */
export async function dispatchToAgentOrTeam(
  options: DispatchOptions,
): Promise<{
  text: string
  cost: number
  interruption?: import('../../contracts/agent-questions.js').AgentQuestionInterruption
  model?: string
  costTracked?: boolean
  /** The attempt that produced this text, so a durable record can name it. */
  dispatchId?: string
  /**
   * Who actually produced this text.
   *
   * A fallback runs a different agent under the same call, so the configured
   * agent is not always the speaker. Returned here rather than parsed back out
   * of the dispatch id, which is an identifier and not a name.
   */
  agentName?: string
}> {
  const {
    agent,
    rosterEntry,
    finalPrompt,
    userMessage,
    state,
    workspacePath,
    outputPath,
    teamWorkspacePath,
    metrics,
    signal,
    onDashboardUpdate,
  } = options
  const dispatchStartedAt = Date.now()
  // One bubble per concrete attempt. The agent name is part of it because a
  // fallback attempt runs a different agent under the same logical call, so
  // "same agent, next attempt" is not a correct identity.
  // Delegated children intentionally lack the root execution-attempt secret.
  // Mint a display-only attempt ID here; the logical invocation stays stable.
  const dispatchId = agentQuestionDispatchId(`${options.logicalInvocationId ?? state.sessionId}#${options.attempt ?? 1}#${agent.name}`,
    process.env.PIPELINE_MCP_WORKER_TURN_URL ? randomUUID() : undefined)
  const textStream = getProcessRunTextStream()
  const textSink = textStream.sinkFor(dispatchId)
  const agentType = rosterEntry?.type === 'team' ? 'team' : 'agent'
  // A user-approved retry is resolved here rather than when the agent was
  // loaded, because the permission covers one *invocation* and only a dispatch
  // knows which one it is running. Resolved before anything else so the
  // provider call, the start event and the durable record all name one pair.
  const authorization = getRuntimeApprovedModelChoice()
  const authorized = resolveAuthorizedAgentModelChoice({
    agentName: agent.name,
    ...whenDefined(options.logicalInvocationId, (logicalInvocationId) => ({
      logicalInvocationId,
    })),
    agentChoice: agent.selection
      ? agent.selection.source === 'agent'
        ? {
            mode: 'explicit' as const,
            provider: agent.selection.provider,
            model: agent.selection.model,
          }
        : { mode: 'app-default' as const }
      : undefined,
    ...whenDefined(authorization, (present) => ({ authorization: present })),
    appDefault: getRuntimeDefaultModelState(),
  })
  // A refusal leaves the agent exactly as it was: the retry simply does not
  // apply, and the attempt runs on its own pair as it would have anyway.
  // A refusal is not permission to run the original pair. An approval the
  // resolver will not honour — a default that moved since it was given — has to
  // stop the attempt, not quietly fall back to the model that already failed.
  if (!authorized.ok && authorization?.agentName === agent.name) {
    throw new Error(
      `Agent '${agent.name}' cannot run its approved retry: ${authorized.error.message}`,
    )
  }
  // §4.3: an approved switch re-evaluates the agent's settings against the pair
  // that will actually run. Each one survives only where the approved provider
  // reads it and would use the value as intended; the rest are dropped and
  // named, because a setting that quietly stopped applying is indistinguishable
  // from a provider that ignored it.
  const reevaluatedOptions =
    authorized.ok && authorized.selection.reason === 'user-approved-retry'
      ? retainCompatibleProviderOptions(
          {
            provider: authorized.selection.provider,
            route: 'direct',
            thinking: agent.thinking,
          },
          agent.providerConfig,
        )
      : undefined
  const dispatchedAgent: LoadedAgent =
    authorized.ok && authorized.selection.reason === 'user-approved-retry'
      ? (() => {
          const { providerConfig: _discarded, ...withoutOptions } = agent
          return {
            ...withoutOptions,
            ...whenDefined(reevaluatedOptions?.kept, (providerConfig) => ({
              providerConfig,
            })),
            provider: authorized.selection.provider,
            model: authorized.selection.model,
            selection: authorized.selection,
          }
        })()
      : agent
  const lineageFrom = options.fromName ?? options.teamName ?? 'runtime'
  const lineageTo = agent.name
  const actorFields = options.activityScopeId
    ? {
        agent_id: options.activityScopeId,
        activity_scope_id: options.activityScopeId,
        ...(options.agentDisplayName
          ? { agent_display_name: options.agentDisplayName }
          : {}),
      }
    : {}

  logAgentRun(outputPath, {
    timestamp: new Date(dispatchStartedAt).toISOString(),
    event: 'start',
    session_id: state.sessionId,
    ...whenDefined(state.rootSessionId, (root_session_id) => ({ root_session_id })),
    assignment_path: outputPath,
    team: options.teamName ?? '',
    ...whenDefined(options.levelId, (level_id) => ({ level_id })),
    ...whenDefined(options.stageType, (stage_type) => ({ stage_type })),
    ...whenDefined(options.triggerTool, (trigger_tool) => ({ trigger_tool })),
    agent_name: agent.name,
    ...actorFields,
    agent_type: agentType,
    from: lineageFrom,
    to: lineageTo,
    ...whenDefined(rosterEntry?.type === 'team' ? rosterEntry.input_artifact : undefined, (input_artifact) => ({ input_artifact })),
    ...whenDefined(rosterEntry?.type === 'team' ? rosterEntry.output_artifact : undefined, (output_artifact) => ({ output_artifact })),
    status: 'active',
    model: dispatchedAgent.model,
    provider: dispatchedAgent.provider,
    // Named on the record rather than left to inference: an approved switch can
    // legitimately stop a setting applying, and only the run can say so.
    ...(reevaluatedOptions?.dropped.length
      ? { dropped_provider_options: [...reevaluatedOptions.dropped] }
      : {}),
    // Written before the provider is called, so a run can disclose default use
    // while the agent is still working rather than after its first token.
    //
    // A nested Team is the exception. Its wrapper resolves a pair only so it
    // has something to name; what actually runs is decided inside the child, by
    // the child's own registry entry and its own coordinator, and the child
    // records that itself. Only a host pair the entry declared for itself is
    // this dispatch's own selection — an inherited one would put a model in
    // history that no request here ever used.
    ...whenDefined(dispatchedSelection(dispatchedAgent, rosterEntry), (selection) => ({
      model_selection: toModelSelectionRecord(selection, 'agent'),
    })),
    dispatch_id: dispatchId,
    ...whenDefined(options.logicalInvocationId, (logical_invocation_id) => ({
      logical_invocation_id,
    })),
    // Not a credential: reading the channel still needs the session that owns
    // it. Recorded so the UI can find the stream from the run it is watching.
    ...whenDefined(process.env[AGENT_TEXT_STREAM_CHANNEL_ENV], (text_channel_id) => ({ text_channel_id })),
  })

  // Mark agent as active
  if (metrics) {
    metrics.state = AGENT_STATE.ACTIVE
    metrics.activeStartedAt = Date.now()
    if (onDashboardUpdate) onDashboardUpdate()
  }

  let resultText: string
  let resultCost: number
  let resultModel: string | undefined
  let resultCostTracked: boolean | undefined

  try {
    if (rosterEntry?.type === 'team' && rosterEntry.team_path) {
      // Warn if a provider override was set on a team-type roster entry — it is ignored
      // because runTeam() always uses Pi to spawn the child team process.
      if (agent.provider && agent.provider !== 'pi') {
        console.warn(
          `[team-runtime] Warning: Provider '${agent.provider}' is set on team-type agent '${agent.name}' ` +
          `but sub-team dispatch always uses Pi. The provider setting will be ignored.`,
        )
      }

      const resolvedWorkspace = teamWorkspacePath ?? workspacePath
      const nestedQuestionAssignment = options.logicalInvocationId && process.env.PIPELINE_MCP_WORKER_TURN_URL
        ? `child-question-${createHash('sha256').update(JSON.stringify([state.sessionId, options.logicalInvocationId, agent.name])).digest('hex').slice(0, 32)}`
        : undefined
      const teamResult = await runTeam({
        teamPath: rosterEntry.team_path,
        workspacePath: resolvedWorkspace,
        brief: userMessage,
        bootEntry: {
          name: agent.name,
          type: 'team',
          ...whenDefined(rosterEntry.role, (description) => ({ description })),
          team_path: rosterEntry.team_path,
          ...whenDefined(rosterEntry.input_artifact, (input_artifact) => ({ input_artifact })),
          ...whenDefined(rosterEntry.output_artifact, (output_artifact) => ({ output_artifact })),
          ...whenDefined(rosterEntry.host_model, (host_model) => ({ host_model })),
          ...whenDefined(rosterEntry.host_provider, (host_provider) => ({ host_provider })),
          ...whenDefined(rosterEntry.mount, (mount) => ({ mount })),
        },
        ...whenDefined(rosterEntry.input_artifact, (inputArtifact) => ({ inputArtifact })),
        ...whenDefined(rosterEntry.output_artifact, (outputArtifact) => ({ outputArtifact })),
        ...whenDefined(rosterEntry.output_artifact, (requestedResultType) => ({ requestedResultType })),
        spawnDepth: state.spawnDepth,
        ...whenDefined(signal, (presentSignal) => ({ signal: presentSignal })),
        ...whenDefined(options.budgetUsd, (budgetUsd) => ({ budgetUsd })),
        ...whenDefined(options.budgetPolicy, (budgetPolicy) => ({ budgetPolicy })),
        ...whenDefined(options.timeoutMinutes, (timeoutMinutes) => ({ timeoutMinutes })),
        ...whenDefined(state.rootSessionId, (rootSessionId) => ({ rootSessionId })),
        parentSessionId: state.sessionId,
        ...(nestedQuestionAssignment ? { childSessionId: nestedQuestionAssignment, recoveryMode: process.env.TEAM_RUNTIME_RECOVERY === '1' } : {}),
      })
      if (teamResult.interruption) {
        state.totalCost = roundUsd(state.totalCost + teamResult.cost)
        textSink?.close(teamResult.interruption.kind === 'awaiting_input' ? 'awaiting_input' : 'error')
        await textSink?.flush()
        if (metrics) { metrics.state = AGENT_STATE.IDLE; delete metrics.activeStartedAt; onDashboardUpdate?.() }
        logAgentRun(outputPath, {
          timestamp: new Date().toISOString(), event: 'end', session_id: state.sessionId,
          assignment_path: outputPath, team: options.teamName ?? '', agent_name: agent.name,
          agent_type: agentType, from: lineageFrom, to: lineageTo, status: teamResult.interruption.kind,
          dispatch_id: dispatchId, child_session_id: teamResult.childSessionId,
          duration_ms: Date.now() - dispatchStartedAt, model: dispatchedAgent.model, provider: dispatchedAgent.provider,
        })
        return { text: '', cost: teamResult.cost, interruption: teamResult.interruption, dispatchId, agentName: agent.name }
      }
      resultText = applyCostTrackingPolicy({
        provider: 'pi',
        costTracked: teamResult.costTracked,
        budgetPolicy: options.budgetPolicy,
        text: teamResult.text,
      })
      resultCost = teamResult.cost
      resultCostTracked = teamResult.costTracked
      // The child's status is the parent's result. `succeeded` is already
      // computed by runTeam; reading only `.text` returned a crashed team's
      // prose as if it were a finished deliverable.
      //
      // One normalized status drives both the thrown error and the end event,
      // so they can never disagree: only `blocked` is blocked, and any other
      // unsuccessful outcome — including a missing status — is `failed`.
      const childFailureStatus: SubTeamFailureStatus | undefined =
        teamResult.succeeded === false
          ? (teamResult.status === 'blocked' ? 'blocked' : 'failed')
          : undefined
      const childFailure = childFailureStatus
        ? new SubTeamFailedError(
          agent.name,
          childFailureStatus,
          // runTeam assembles a real explanation — a stderr trace, a blocker
          // reason. Discarding it would leave the parent with a status and no
          // way to act on it.
          `Delegated team '${agent.name}' ended with status '${childFailureStatus}'.` +
            (teamResult.text.trim()
              ? ` Child reported: ${teamResult.text.trim().slice(0, 500)}`
              : ''),
        )
        : undefined
      logAgentRun(outputPath, {
        timestamp: new Date().toISOString(),
        event: 'end',
        session_id: state.sessionId,
        ...whenDefined(state.rootSessionId, (root_session_id) => ({ root_session_id })),
        assignment_path: outputPath,
        team: options.teamName ?? '',
        ...whenDefined(options.levelId, (level_id) => ({ level_id })),
        ...whenDefined(options.stageType, (stage_type) => ({ stage_type })),
        ...whenDefined(options.triggerTool, (trigger_tool) => ({ trigger_tool })),
        agent_name: agent.name,
        ...actorFields,
        agent_type: agentType,
        from: lineageFrom,
        to: lineageTo,
        ...whenDefined(rosterEntry.input_artifact, (input_artifact) => ({ input_artifact })),
        ...whenDefined(teamResult.artifactPath || rosterEntry.output_artifact, (output_artifact) => ({ output_artifact })),
        status: childFailureStatus ?? teamResult.status ?? 'completed',
        duration_ms: Date.now() - dispatchStartedAt,
        model: dispatchedAgent.model,
        provider: dispatchedAgent.provider,
        child_session_id: teamResult.childSessionId,
      })

      if (childFailure) {
        // Account the cost the child already incurred, then surface the
        // failure. Metrics are deliberately left alone: the common catch marks
        // this dispatch as errored, and a transient DONE here would be an
        // externally observable lie.
        state.totalCost = roundUsd(state.totalCost + resultCost)
        throw childFailure
      }
    } else {
      const agentResult = await runAgent({
        systemPrompt: finalPrompt,
        userMessage,
        model: dispatchedAgent.model,
        thinking: agent.thinking,
        ...whenDefined(agent.tools, (tools) => ({ tools })),
        cwd: workspacePath,
        ...whenDefined(signal, (presentSignal) => ({ signal: presentSignal })),
        outputPath,
        sessionId: state.sessionId,
        ...whenDefined(state.rootSessionId, (rootSessionId) => ({ rootSessionId })),
        agentName: agent.name,
        ...((options.stageType === 'chain' || options.stageType === 'discussion' || options.stageType === 'review' || options.stageType === 'broadcast' || options.stageType === 'pipeline') && options.logicalInvocationId && options.teamName && options.levelId && !options.outputSchema
          ? { questionContext: {
              logicalInvocationId: options.logicalInvocationId, dispatchId,
              teamId: options.teamName, stageId: options.levelId,
              ...(options.timeoutMinutes ? { timeoutMs: Math.ceil(options.timeoutMinutes * 60_000) } : {}),
            } }
          : {}),
        ...whenDefined(
          options.governedWebEvidenceMode,
          (governedWebEvidenceMode) => ({ governedWebEvidenceMode }),
        ),
        ...(options.activityScopeId || options.agentDisplayName
          ? { workerEnvironment: {
              ...process.env,
              ...(options.activityScopeId
                ? {
                    [MCP_WORKER_ACTIVITY_SCOPE_ID_ENV]:
                      options.activityScopeId,
                  }
                : {}),
              ...(options.agentDisplayName
                ? {
                    [MCP_WORKER_AGENT_DISPLAY_NAME_ENV]:
                      options.agentDisplayName,
                  }
                : {}),
            } }
          : {}),
        ...whenDefined(options.timeoutMinutes, (timeoutMinutes) => ({ timeoutMinutes })),
        ...whenDefined(options.outputSchema, (outputSchema) => ({ outputSchema })),
        provider: dispatchedAgent.provider,
        ...whenDefined(dispatchedAgent.providerConfig, (providerConfig) => ({
          providerConfig,
        })),
        ...whenDefined(textSink, (sink) => ({
          onProtocolEvent: (event: ProviderProtocolEvent) =>
            sink.onProtocolEvent(event),
        })),
      })
      if (agentResult.interruption) {
        state.totalCost = roundUsd(state.totalCost + agentResult.cost)
        textSink?.close(agentResult.interruption.kind === 'awaiting_input' ? 'awaiting_input' : 'error')
        await textSink?.flush()
        if (metrics) {
          metrics.state = AGENT_STATE.IDLE
          metrics.totalCost = roundUsd(metrics.totalCost + agentResult.cost)
          delete metrics.activeStartedAt
          onDashboardUpdate?.()
        }
        logAgentRun(outputPath, {
          timestamp: new Date().toISOString(), event: 'end', session_id: state.sessionId,
          assignment_path: outputPath, team: options.teamName ?? '', agent_name: agent.name,
          agent_type: agentType, from: lineageFrom, to: lineageTo,
          status: agentResult.interruption.kind, dispatch_id: dispatchId,
          duration_ms: Date.now() - dispatchStartedAt,
          model: agentResult.model, provider: agentResult.provider ?? dispatchedAgent.provider,
        })
        return { text: '', cost: agentResult.cost, interruption: agentResult.interruption, dispatchId, agentName: agent.name }
      }
      // Acceptance first, then the terminal. `applyCostTrackingPolicy` can
      // reject an answer outright under a halting budget policy, and a
      // `completed` published before that check cannot be taken back: the
      // sink closes once, so the catch below would find the bubble already
      // closed and the user would be told an answer succeeded that the run
      // then refused.
      resultText = applyCostTrackingPolicy({
        provider: agentResult.provider ?? dispatchedAgent.provider,
        costTracked: agentResult.costTracked,
        budgetPolicy: options.budgetPolicy,
        text: agentResult.text,
      })
      textSink?.close('completed')
      // Deliver before recording. `agent.end` is written straight to the
      // assignment journal and is not batched, so without this barrier the
      // renderer can learn the attempt finished while its text is still in
      // flight — and a bubble that has already been replaced by the step's
      // outcome never shows text that arrives afterwards. Bounded, and its
      // failure is not the turn's: a display concern cannot change an outcome.
      await textSink?.flush()
      resultCost = agentResult.cost
      resultModel = agentResult.model
      resultCostTracked = agentResult.costTracked

      if (metrics) {
        metrics.rounds++
        metrics.totalCost = roundUsd(metrics.totalCost + agentResult.cost)
        metrics.contextTokens = agentResult.contextTokens
        metrics.model = agentResult.model
      }
      logAgentRun(outputPath, {
        timestamp: new Date().toISOString(),
        event: 'end',
        session_id: state.sessionId,
        ...whenDefined(state.rootSessionId, (root_session_id) => ({ root_session_id })),
        assignment_path: outputPath,
        team: options.teamName ?? '',
        ...whenDefined(options.levelId, (level_id) => ({ level_id })),
        ...whenDefined(options.stageType, (stage_type) => ({ stage_type })),
        ...whenDefined(options.triggerTool, (trigger_tool) => ({ trigger_tool })),
        agent_name: agent.name,
        ...actorFields,
        agent_type: agentType,
        from: lineageFrom,
        to: lineageTo,
        status: 'completed',
        duration_ms: Date.now() - dispatchStartedAt,
        model: agentResult.model,
        provider: agentResult.provider ?? dispatchedAgent.provider,
        // Named on the record. An approved switch drops settings before the
        // turn starts and the route may apply none of what survived; both are
        // facts about this attempt, and neither can be read off the reply.
        //
        // Either side alone is enough. Guarding on the route's drops left a
        // switch-only case writing nothing here — and the end event does not
        // spread the start record, so what the switch dropped was on the
        // attempt's start and missing from the account of how it finished.
        ...(reevaluatedOptions?.dropped.length ||
        agentResult.droppedProviderOptions?.length
          ? {
              dropped_provider_options: [
                ...new Set([
                  ...(reevaluatedOptions?.dropped ?? []),
                  ...(agentResult.droppedProviderOptions ?? []),
                ]),
              ].sort(),
            }
          : {}),
        dispatch_id: dispatchId,
      })
    }

    state.totalCost = roundUsd(state.totalCost + resultCost)

    if (metrics) {
      metrics.state = AGENT_STATE.DONE
      delete metrics.activeStartedAt
      if (onDashboardUpdate) onDashboardUpdate()
    }

    return {
      text: resultText,
      cost: resultCost,
      ...whenDefined(resultModel, (model) => ({ model })),
      ...whenDefined(resultCostTracked, (costTracked) => ({ costTracked })),
      dispatchId,
      agentName: agent.name,
    }
  } catch (err) {
    // Close the bubble rather than leaving a reader waiting on a reply that is
    // never coming. Idempotent, so a dispatch that already closed is unchanged.
    textSink?.close('error')
    // Same barrier as the success path: whatever the attempt did manage to say
    // has to arrive before the record that ends it.
    await textSink?.flush()
    logAgentRun(outputPath, {
      timestamp: new Date().toISOString(),
      event: 'fail',
      session_id: state.sessionId,
      ...whenDefined(state.rootSessionId, (root_session_id) => ({ root_session_id })),
      assignment_path: outputPath,
      team: options.teamName ?? '',
      ...whenDefined(options.levelId, (level_id) => ({ level_id })),
      ...whenDefined(options.stageType, (stage_type) => ({ stage_type })),
      ...whenDefined(options.triggerTool, (trigger_tool) => ({ trigger_tool })),
      agent_name: agent.name,
      ...actorFields,
      agent_type: agentType,
      from: lineageFrom,
      to: lineageTo,
      ...whenDefined(rosterEntry?.type === 'team' ? rosterEntry.input_artifact : undefined, (input_artifact) => ({ input_artifact })),
      ...whenDefined(rosterEntry?.type === 'team' ? rosterEntry.output_artifact : undefined, (output_artifact) => ({ output_artifact })),
      status: err instanceof Error ? err.message : String(err),
      // Recorded whenever the failure was classified, so a reader that cannot
      // show `status` still learns what went wrong.
      ...whenDefined(
        err instanceof ProviderError ? err.kind : undefined,
        (provider_failure_kind) => ({ provider_failure_kind }),
      ),
      duration_ms: Date.now() - dispatchStartedAt,
      model: dispatchedAgent.model,
      provider: dispatchedAgent.provider,
      // The same attempt the `start` event named, so a run where one agent
      // speaks twice can tell its two failures apart, and the run panel can
      // end this attempt's bubble on its own failure, with its reason,
      // instead of leaving it open until the whole run ends.
      dispatch_id: dispatchId,
      ...whenDefined(options.logicalInvocationId, (logical_invocation_id) => ({
        logical_invocation_id,
      })),
      failure: classifyDispatchFailure(err),
    })
    if (metrics) {
      metrics.state = AGENT_STATE.ERROR
      delete metrics.activeStartedAt
      if (onDashboardUpdate) onDashboardUpdate()
    }
    throw err
  }
}

/**
 * The selection this dispatch itself will run on, or none.
 *
 * A `team` entry runs a child process that resolves its own host model, so the
 * wrapper only owns a selection when the entry declared the host pair. An
 * app-default reading there is a placeholder the child never sees.
 */
function dispatchedSelection(
  agent: LoadedAgent,
  rosterEntry: RosterEntrySlim | undefined,
): ModelSelection | undefined {
  const selection = agent.selection ?? undefined
  if (!selection) return undefined
  if (rosterEntry?.type !== 'team') return selection
  return selection.source === 'agent' ? selection : undefined
}

/**
 * A dispatch's failure, as codes a reader can act on.
 *
 * `status` keeps the sentence a person reads. This is the part a policy can
 * use: whether the failure is about the *model* at all, and how far the
 * attempt got before it stopped. An error this build cannot recognize is
 * recorded as reaching the request, which is the answer that assumes the least
 * — an unrecognized failure never proves that nothing ran.
 */
/**
 * Exported because an agent-only workflow step calls the provider directly and
 * has to record the same evidence this dispatcher records. Two classifiers
 * would let the two paths disagree about whether a retry may be offered.
 */
export function classifyDispatchFailure(error: unknown): AgentRunFailure {
  if (error instanceof ProviderError) {
    return {
      // Always the request, never a pre-dispatch phase. This code runs only
      // after the adapter was called, and an error *category* is not observed
      // progress: a CLI can authenticate late, or run for a while and report a
      // credential failure at exit. Claiming `provider-resolution` here would
      // assert that nothing ran, on no evidence at all.
      phase: 'provider-request',
      serviceCode: 'provider_failed',
      ...whenDefined(error.kind, (providerKind) => ({ providerKind })),
      ...whenDefined(error.code, (providerCode) => ({ providerCode })),
      ...whenDefined(error.statusCode, (httpStatus) => ({ httpStatus })),
      retryable: error.retryable,
      // The adapter's own claim, and the only thing that can prove no
      // effect was possible. Absent stays absent: unknown refuses a retry.
      ...(error.dispatched === false ? { dispatched: false } : {}),
    }
  }
  if (error instanceof TimeoutError) {
    return {
      phase: 'provider-request',
      serviceCode: 'timeout',
      retryable: true,
    }
  }
  return {
    phase: 'provider-request',
    serviceCode: 'dispatch_failed',
    retryable: false,
    // Where a worker turn the parent gave no category for failed. Only the
    // closed stage and its code or status: the error's message and cause
    // name the worker URL, and neither is kept.
    ...(error instanceof McpWorkerTurnClientError && error.failureDetail
      ? { workerTurn: { ...error.failureDetail } }
      : {}),
  }
}
