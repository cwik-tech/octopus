/**
 * Team Runtime — RuntimeContext
 *
 * Collects all mutable closure variables from team-runtime/index.ts into a single typed
 * object. Modules that need access to runtime state receive a RuntimeContext
 * instead of 8-10 individual parameters.
 *
 * Error handling policy (4 layers — do NOT unify):
 *   - Config parsing: returns { config, errors, warnings } result objects
 *   - Agent execution: always resolves — errors surface in the .text field
 *   - Engine tools: throw for precondition violations; catch agent errors
 *   - Event handlers: .catch() with console.error — must never throw
 */

import { whenDefined } from '../../core/optional-properties.js'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type {
  TeamConfig,
  LoadedAgent,
  AgentMetrics,
  RuntimeState,
  LevelState,
  RosterEntrySlim,
  RateLimiterInterface,
  RegistryEntry,
  TeamRegistryEntry,
  DelegationStatusSnapshot,
} from '../../core/types.js'
import type { ModelSelectionRecord } from '../../contracts/agent-model-selection.js'
import type { BudgetLedger } from '../../core/budget-ledger.js'
import type { HostRunLifetime } from './host-run-lifetime.js'
import type { WorkflowRegistryEntry } from '../../contracts/workflows.js'
import type { RunAssignmentLocation } from '../../core/run-assignment-location.js'
import type { HumanInputRoutingContext } from '../../contracts/human-input.js'
import { LEVEL_STATUS, STAGE_LIFECYCLE_STATUS } from '../../core/constants.js'

function parseSpawnDepth(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isLevelStatus(value: unknown): value is LevelState['status'] {
  return typeof value === 'string' && Object.values(LEVEL_STATUS).some((status) => status === value)
}

function isStageStatus(value: unknown): value is LevelState['stageStatus'] {
  return typeof value === 'string' && Object.values(STAGE_LIFECYCLE_STATUS).some((status) => status === value)
}

export interface PersistedLevelStateSnapshot {
  status?: LevelState['status']
  stageStatus?: LevelState['stageStatus']
  loopbackCount?: number
  visitCount?: number
}

export interface PersistedRuntimeStateSnapshot {
  sessionId?: string
  tenantId?: string
  currentLevelIndex?: number
  totalCost?: number
  startTime?: number
  timerStarted?: boolean
  endTime?: number | null
  rootSessionId?: string
  parentSessionId?: string
  levelStates?: Record<string, PersistedLevelStateSnapshot>
}

/**
 * Who the host turn that is currently running belongs to.
 *
 * Pi's outer turn runs from the first `agent_start` until `agent_settled`, and
 * its automatic retries and queued continuations emit their own
 * `agent_start`/`agent_end` pairs *inside* that span — `_emitAgentSettled` sits
 * in the `finally` of `_runAgentPrompt`, after the retry loop
 * (`@earendil-works/pi-coding-agent/dist/core/agent-session.js:743-756`).
 *
 * A level can advance while that turn is still running, and the moment it does,
 * `currentLevelIndex` stops describing the turn in flight. Anything that reads
 * it to say who a turn belonged to reports the level that is about to run
 * instead of the one that ran. The snapshot is taken once, when the outer turn
 * opens, and held unchanged until it settles, so the turn's own records keep
 * naming the coordinator and pair that produced them.
 */
export interface OuterTurnOwner {
  /**
   * The coordinator's name, or null for a level that declares none.
   *
   * A name and the few fields below, not the roster entry itself. The roster
   * object is shared and mutable; holding a reference to it would mean a record
   * written later could describe something that changed after the turn began,
   * which is the opposite of what a snapshot is for.
   */
  readonly coordinatorName: string | null
  /** The coordinator's own configured pair, as records disclose it. */
  readonly coordinatorProvider: string | null
  readonly coordinatorModel: string | null
  /**
   * How the host's pair was decided for this turn, resolved when it opened.
   *
   * The projection records disclose, not the roster's own selection: it is what
   * every host lifecycle record carries, and resolving it once means a later
   * record cannot describe a decision made for a different level.
   */
  readonly hostModelSelection: ModelSelectionRecord | undefined
  readonly levelIndex: number
  readonly levelId: string | null
  readonly stageType: string | null
  /** The host pair the turn actually started on. */
  readonly hostProvider: string | null
  readonly hostModel: string | null
  readonly coordinatorRunId: number
  readonly startedAt: number
}

export interface RuntimeToolInvoker {
  invoke(input: {
    readonly toolCallId: string
    readonly input: unknown
    readonly signal?: AbortSignal
    readonly extensionContext: ExtensionContext
  }): Promise<unknown>
}

// ─── RuntimeContext ─────────────────────────────────────────────────────────

export interface RuntimeContext {
  // ── Config (immutable after boot) ──────────────────────────────────────
  teamConfig: TeamConfig | null
  teamRoot: string
  inputFilesContent: string
  humanInputRouting?: HumanInputRoutingContext
  agents: Map<string, LoadedAgent>
  /** Slim projection of each roster entry. Engines receive this to avoid
   *  importing the full AgentRosterEntry type from parsers. */
  rosterEntries: Map<string, RosterEntrySlim>
  teamRegistry: Map<string, RegistryEntry>
  workflowRegistry: Map<string, WorkflowRegistryEntry>
  bootEntry: TeamRegistryEntry | null
  /** Explicit product-session assignment. Absent for legacy direct CLI runs. */
  assignmentLocation?: RunAssignmentLocation

  // ── Mutable runtime state ───────────────────────────────────────────────
  state: RuntimeState
  agentMetrics: Map<string, AgentMetrics>
  coordinatorRunId: number
  levelAdvancedCoordinatorRunId: number | null
  activeSpawnCount: number
  setupMode: boolean
  configErrors: string[]

  // ── UI state ────────────────────────────────────────────────────────────
  lastCtx: ExtensionContext | null
  refreshTimer: ReturnType<typeof setInterval> | null
  activeDelegations: Map<string, DelegationStatusSnapshot>
  blockedToolCallIds: Set<string>
  usedLevelToolsThisCoordinatorTurn: Set<string>
  toolFailureFollowUpRunIds: Set<number>
  coordinatorToolCallsThisRun: number
  /**
   * The turn Pi is running right now, or null between turns.
   *
   * Set at the first `agent_start` and left alone until `agent_settled`, so a
   * mid-turn level advance cannot re-point it. Its presence is also what says
   * a host turn is in flight, which is the one fact the follow-up dispatcher
   * needs: nothing may be sent to the host while it owns the loop.
   */
  outerTurnOwner: OuterTurnOwner | null
  pendingStageEntryLevelId: string | null
  currentRegisteredTools: string[]
  currentToolInvokers: Map<string, RuntimeToolInvoker>
  /**
   * Whether runtime autostart actually took ownership of the active stage.
   *
   * `TEAM_DELEGATED_AUTOSTART=1` says a delegated run was *intended*; this says
   * the runtime is *executing* the stage. The host prompt must key off this
   * fact: a delegated child whose autostart never started the stage has to fall
   * back to its coordinator, or it ends idle with no artifact and no recovery
   * path — the host was told to reply NOOP for a stage nobody ran.
   */
  delegatedAutostartOwnsStage: boolean
  pendingFollowUps: Array<{
    id: string
    message: string
    kind: 'stage_entry' | 'runtime_notice'
    levelId?: string
    stageType?: string
    notBefore: number
    attempts: number
    createdAt: string
  }>
  pendingFollowUpTimer: ReturnType<typeof setTimeout> | null

  /**
   * Who decides this host process may stop.
   *
   * Present only for a launched host that was given the run prompt to hold
   * open. The extension-callback tests drive handlers directly and own no
   * process, so they have none — and nothing here may depend on having one.
   */
  hostRunLifetime?: HostRunLifetime

  /**
   * Write the run's durable snapshot.
   *
   * The follow-up queue has to record a dispatch admission before it sends, and
   * it cannot reach the extension's own `persistState` without this. Present
   * for a runtime that owns a checkpoint; the extension-callback tests own no
   * process and have none, and nothing here may depend on having one.
   */
  persistRuntimeState?: () => void

  /**
   * Test-only fault-injection point, read once at the extension boundary.
   *
   * Passed rather than re-read so `TEAM_RUNTIME_FAULT_INJECT` keeps exactly one
   * read site and its named values stay auditable in one place
   * (`tests/unit/delegated-autostart-recovery.test.ts`).
   */
  faultInjection?: string

  // ── Pi API reference ────────────────────────────────────────────────────
  pi: ExtensionAPI

  // ── Rate limiter ─────────────────────────────────────────────────────────
  /** Optional concurrency limiter — initialized from team.yaml rate_limiting config. */
  rateLimiter?: RateLimiterInterface

  // ── Engine tools ────────────────────────────────────────────────────────
  /** Set of engine tool names; the timer starts on the first call to any. */
  ENGINE_TOOLS: Set<string>

  // ── Shutdown & budget ───────────────────────────────────────────────────
  /** B2: Master abort controller for graceful shutdown. */
  shutdownController: AbortController
  /** B4: Budget enforcement ledger — undefined means no budget cap / advisory only. */
  budgetLedger?: BudgetLedger
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a RuntimeContext with sensible defaults for all fields.
 * Call once at extension boot, then mutate fields in place.
 */
export function createRuntimeContext(pi: ExtensionAPI): RuntimeContext {
  return {
    // Config — populated by boot()
    teamConfig: null,
    teamRoot: '',
    inputFilesContent: '',
    agents: new Map(),
    rosterEntries: new Map(),
    teamRegistry: new Map(),
    workflowRegistry: new Map(),
    bootEntry: null,

    // Runtime state
    state: {
      sessionId: '',
      tenantId: process.env.TEAM_TENANT_ID || 'local',
      currentLevelIndex: 0,
      levelStates: new Map(),
      totalCost: 0,
      startTime: 0,
      timerStarted: false,
      endTime: null,
      spawnDepth: parseSpawnDepth(process.env.TEAM_SPAWN_DEPTH),
    },
    agentMetrics: new Map(),
    coordinatorRunId: 0,
    levelAdvancedCoordinatorRunId: null,
    activeSpawnCount: 0,
    setupMode: false,
    configErrors: [],

    // UI state
    lastCtx: null,
    refreshTimer: null,
    activeDelegations: new Map(),
    blockedToolCallIds: new Set(),
    usedLevelToolsThisCoordinatorTurn: new Set(),
    toolFailureFollowUpRunIds: new Set(),
    coordinatorToolCallsThisRun: 0,
    outerTurnOwner: null,
    pendingStageEntryLevelId: null,
    currentRegisteredTools: [],
    currentToolInvokers: new Map(),
    delegatedAutostartOwnsStage: false,
    pendingFollowUps: [],
    pendingFollowUpTimer: null,

    // Pi API
    pi,

    // Rate limiter — initialized in boot() when rate_limiting config is present

    // Engine tools — the timer starts on the first call to any of these
    ENGINE_TOOLS: new Set([
      'converse',
      'broadcast',
      'handoff',
      'dispatch',
      'submit_for_review',
      'spawn_team',
      'spawn_workflow',
    ]),

    // Shutdown controller — abort to propagate kill signal to all active subprocesses
    shutdownController: new AbortController(),
    // Budget ledger — initialized in boot() when enforcement is configured
  }
}

export function buildPersistedRuntimeState(state: RuntimeState): PersistedRuntimeStateSnapshot {
  return {
    sessionId: state.sessionId,
    ...whenDefined(state.tenantId, (tenantId) => ({ tenantId })),
    currentLevelIndex: state.currentLevelIndex,
    totalCost: state.totalCost,
    startTime: state.startTime,
    timerStarted: state.timerStarted,
    endTime: state.endTime,
    ...whenDefined(state.rootSessionId, (rootSessionId) => ({ rootSessionId })),
    ...whenDefined(state.parentSessionId, (parentSessionId) => ({ parentSessionId })),
    levelStates: Object.fromEntries(
      [...state.levelStates.entries()].map(([levelId, levelState]) => [levelId, {
        status: levelState.status,
        stageStatus: levelState.stageStatus,
        loopbackCount: levelState.loopbackCount,
        visitCount: levelState.visitCount ?? 0,
      }]),
    ),
  }
}

export interface RestorePersistedRuntimeStateOptions {
  /**
   * A disk checkpoint was accepted for this run, and owns every field it
   * carries.
   *
   * Startup has two restore sources and used to apply this one over the other
   * unconditionally, with no comparison of which described the later moment.
   * That was survivable while both said the same thing; it stopped being
   * survivable once the checkpoint began carrying the host's entry admission,
   * which this snapshot has no field for — a session entry that moved the level
   * index would leave the admission naming a level the run is no longer on.
   *
   * So the checkpoint wins for everything it holds. `tenantId` is the one field
   * it does not hold, and stays restorable from here.
   */
  readonly authoritativeSnapshotAccepted?: boolean
}

export function restorePersistedRuntimeState(
  state: RuntimeState,
  value: unknown,
  options: RestorePersistedRuntimeStateOptions = {},
): void {
  if (!isRecord(value)) return
  if (typeof value.tenantId === 'string') state.tenantId = value.tenantId
  if (options.authoritativeSnapshotAccepted) return
  if (typeof value.sessionId === 'string') state.sessionId = value.sessionId
  if (typeof value.currentLevelIndex === 'number') state.currentLevelIndex = value.currentLevelIndex
  if (typeof value.totalCost === 'number') state.totalCost = value.totalCost
  if (typeof value.startTime === 'number') state.startTime = value.startTime
  if (typeof value.timerStarted === 'boolean') state.timerStarted = value.timerStarted
  if (value.endTime === null || typeof value.endTime === 'number') state.endTime = value.endTime
  if (typeof value.rootSessionId === 'string') state.rootSessionId = value.rootSessionId
  if (typeof value.parentSessionId === 'string') state.parentSessionId = value.parentSessionId

  if (!isRecord(value.levelStates)) return

  for (const [levelId, restoredLevelState] of Object.entries(value.levelStates)) {
    const levelState = state.levelStates.get(levelId)
    if (!levelState || !isRecord(restoredLevelState)) continue
    if (isLevelStatus(restoredLevelState.status)) levelState.status = restoredLevelState.status
    if (isStageStatus(restoredLevelState.stageStatus)) levelState.stageStatus = restoredLevelState.stageStatus
    if (typeof restoredLevelState.visitCount === 'number') {
      levelState.visitCount = restoredLevelState.visitCount
    }
    if (typeof restoredLevelState.loopbackCount === 'number') {
      levelState.loopbackCount = restoredLevelState.loopbackCount
    }
  }
}
