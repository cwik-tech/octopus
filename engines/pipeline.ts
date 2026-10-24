/**
 * Team Runtime — Pipeline Engine
 *
 * Task-based execution with dependencies, serial/parallel dispatch,
 * sprint gates, and quality checks. Extracted and generalized from
 * agent-team's pipeline execution logic.
 *
 * Tool registered: `dispatch`
 */

import { AgentQuestionInterruptionError } from '../core/agent-question-interruption.js'
import { whenDefined } from '../core/optional-properties.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Type } from 'typebox'
import { Text } from '@earendil-works/pi-tui'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  PipelineStageConfig,
  BaseEngineContext,
  PipelineState,
} from '../core/types.js'
import {
  adoptBudgetDispatchAdmission,
  type BudgetDispatchAdmission,
} from '../core/budget-ledger.js'
import { STAGE_TYPE, STAGE_LIFECYCLE_STATUS } from '../core/constants.js'
import {
  dispatchWithFailurePolicy,
  resolveFailurePolicy,
  HaltError,
} from '../domains/agent-execution/failure-policy.js'
import { resolveChildWorkspacePath } from '../parsers/team-config.js'
import { checkConstraints, formatCost, formatElapsed } from '../core/constraints.js'
import { combineAbortSignals } from '../core/timeout-manager.js'
import { substituteTemplateVars } from '../domains/runtime/template.js'
import { logAgentDispatch } from '../domains/runtime/logger.js'
import {
  buildArtifactMetadata,
  stripArtifactFrontmatter,
  writeMarkdownArtifact,
} from '../domains/runtime/artifacts.js'
import { publishAcceptedTeamChatMessage } from '../domains/runtime/team-chat-messages.js'
import { buildStageDispatchInvocationId } from '../core/stage-dispatch-identity.js'
import { canTransitionStageStatus, transitionStageStatus } from '../domains/stage/stage-lifecycle.js'
import { writeFileAtomicSync } from '../core/file-mutation.js'
import {
  DEEP_RESEARCH_SHUTDOWN_RESERVE_MS,
  finalizeDeepResearchEvidenceWave,
  describeDeepResearchDispatchRefusal,
  planDeepResearchDispatchBudget,
  resolveOptionalDeepResearchDeadline,
  resolveDeepResearchDeadline,
  resolveDeepResearchExecutionLimits,
  resolveDeepResearchTaskOverlay,
  validateDeepResearchLevelTimeout,
  type DeepResearchDeadline,
  type DeepResearchTaskOverlay,
} from '../domains/deep-research/deep-research-pipeline-adapter.js'
import {
  resolveRelativePathInside,
} from '../core/path-safety.js'
import {
  buildSectionWriterMessage,
  parseSectionDraftResult,
  resolveSectionDraftAssignment,
  validateSectionDraftAgainstDossier,
  type SectionDraftAssignment,
} from '../domains/deep-research/deep-research-section-drafting.js'
import { resolveOwnedRunRelativePath } from '../domains/runtime/runtime-paths.js'
import {
  createDeepResearchWorkerAttemptObservers,
  type DeepResearchWorkerAttemptSummary,
} from '../domains/deep-research/deep-research-attempt-observers.js'
import { writeDeepResearchWorkerEvidenceSummary } from '../domains/deep-research/deep-research-worker-summary.js'
import {
  buildDeepResearchBlockerLanes,
  countDeepResearchLaneObservations,
  describeDeepResearchSearchCapabilityBlocker,
  evaluateDeepResearchSearchCapability,
  readDeepResearchAcquisitionDiagnostics,
  renderDeepResearchBlocker,
  type DeepResearchBlockerDeadline,
  type DeepResearchSearchCapabilityBlocker,
} from '../domains/deep-research/deep-research-blocker-report.js'
import { publishSearchCapabilityBlockedEvent } from '../domains/acquisition/acquisition-events.js'
import {
  describeDeepResearchDiscoveryFailure,
  describeDeepResearchDiscoveryRemediation,
} from '../domains/deep-research/deep-research-discovery-signal.js'
import { assertResearchPlanApproved } from '../domains/deep-research/deep-research-approval.js'
import type { ResearchPlan } from '../contracts/deep-research.js'
import {
  parsePlan,
  getReadyTasks,
  areAllSprintsComplete,
  areAllSprintsSuccessful,
  updateTaskStatus,
  autoSkipDependents,
  recoverInterruptedPipelineTasks,
  checkDependencies,
  isSprintComplete,
  type PlanTask,
  type PlanState,
  type TaskStatus,
} from '../parsers/plan-parser.js'

interface PipelineContext extends BaseEngineContext<PipelineStageConfig> {
  onStateCheckpoint?: () => void
}

/** Read the approved plan for blocker attribution; never fail the blocker for it. */
function readApprovedResearchPlanForBlocker(
  assignmentPath: string,
  planArtifact: string,
): ResearchPlan | undefined {
  try {
    const artifactPath = resolveOwnedRunRelativePath({
      assignmentPath,
      relativePath: planArtifact,
      label: 'Deep Research plan',
    })
    return assertResearchPlanApproved(
      JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as unknown,
    )
  } catch {
    return undefined
  }
}

/**
 * Detect search capability absence for this run: the approved plan requires
 * discovery and *no* path found a source — no search returned results and
 * neither the managed browser nor the Browser Use cloud browser rendered a
 * search-results page.
 * Never fires for plans satisfiable from supplied URLs, for source-level
 * failures, or while any discovery path was working.
 */
function evaluateSearchCapabilityForRun(
  ctx: PipelineContext,
  config: PipelineStageConfig,
): DeepResearchSearchCapabilityBlocker | undefined {
  if (!config.config.plan_artifact) return undefined
  const approvedPlan = readApprovedResearchPlanForBlocker(
    ctx.outputPath,
    config.config.plan_artifact,
  )
  if (!approvedPlan) return undefined
  return evaluateDeepResearchSearchCapability({
    approvedPlan,
    acquisition: readDeepResearchAcquisitionDiagnostics({
      workspacePath: ctx.workspacePath,
      assignmentPath: ctx.outputPath,
    }),
  })
}

/**
 * Publish the search-capability blocker, if one applies, and describe it.
 *
 * Capability absence is a property of the *run*, not of how one lane happened
 * to end: a lane that was skipped by failure policy or halted was starved of
 * discovery for exactly the same reason as one that completed empty-handed.
 * Publishing from a single place keeps the event, the operator sentence and
 * the terminal report from drifting apart across the three exit paths.
 *
 * Returns the operator-facing sentence, or `undefined` when capability is fine.
 */
function reportSearchCapabilityBlocker(
  ctx: PipelineContext,
  config: PipelineStageConfig,
): string | undefined {
  const blocker = evaluateSearchCapabilityForRun(ctx, config)
  if (!blocker) return undefined
  publishSearchCapabilityBlockedEvent({
    assignmentPath: ctx.outputPath,
    sessionId: ctx.state.sessionId,
    ...whenDefined(ctx.state.rootSessionId, (definedValue) => ({
      rootSessionId: definedValue,
    })),
    laneIds: blocker.laneIds,
    providerPriority: blocker.providerPriority,
    failureCodes: [...new Set(blocker.failureCodes.map((entry) => entry.code))]
      .sort(),
    cause: describeDeepResearchDiscoveryFailure(blocker.failureCodes),
    remediation: describeDeepResearchDiscoveryRemediation(blocker.failureCodes),
  })
  return describeDeepResearchSearchCapabilityBlocker(blocker)
}

/**
 * Whether a lane whose evidence packet the runtime already validated must be
 * rewritten as failed.
 *
 * A validated packet is the lane's contract, durably persisted moments before
 * this runs. Discarding it is only correct when the run genuinely had no way
 * to find sources, because then the packet can only have come from guessed
 * URLs. `reportSearchCapabilityBlocker` returns nothing once any discovery
 * path — an Exa or Brave search, or a search-results page the managed or cloud
 * browser rendered — actually found a source, so an accepted lane survives a
 * failing search action.
 */
function capabilityFailureForAcceptedLane(
  ctx: PipelineContext,
  config: PipelineStageConfig,
  hasResearchOverlay: boolean,
): string | undefined {
  if (!hasResearchOverlay) return undefined
  return reportSearchCapabilityBlocker(ctx, config)
}

/** Report the approved time budget and what remained when the run went terminal. */
function resolveBlockerDeadline(
  ctx: PipelineContext,
  maxDurationMinutes: number,
): DeepResearchBlockerDeadline {
  const deadlineArtifact = ctx.config.config.deadline_artifact
  if (deadlineArtifact) {
    try {
      const deadline = resolveDeepResearchDeadline({
        assignmentPath: ctx.outputPath,
        deadlineArtifact,
        ...(ctx.config.config.plan_artifact
          ? { planArtifact: ctx.config.config.plan_artifact }
          : {}),
      })
      return {
        maxDurationMinutes,
        startedAt: deadline.startedAt,
        deadlineAt: deadline.deadlineAt,
        remainingMs: deadline.remainingMs,
      }
    } catch {
      // An unreadable deadline artifact still leaves the approved budget worth
      // reporting; it must not suppress the blocker.
    }
  }
  return { maxDurationMinutes }
}

/** Read the correction wave a task's evidence artifact belongs to. */
function researchEvidenceWave(resultFile: string): number {
  return Number(resultFile.match(/wave-(\d+)/)?.[1] ?? 0)
}

/**
 * Publish one rejected lane summary for a terminal research worker. Every
 * terminal path shares this so a skipped lane is as legible as a halted one,
 * and diagnostics never displace the caller's failure handling.
 */
function writeRejectedResearchLaneSummary(input: {
  readonly assignmentPath: string
  readonly sessionId: string
  readonly levelId: string
  readonly taskId: string
  readonly overlay: DeepResearchTaskOverlay
  readonly wave: number
  readonly summary: DeepResearchWorkerAttemptSummary
  readonly fallbackMessage: string
  readonly fallbackCategory: string
}): void {
  if (input.summary.attempts === 0) return
  try {
    writeDeepResearchWorkerEvidenceSummary({
      assignmentPath: input.assignmentPath,
      sessionId: input.sessionId,
      levelId: input.levelId,
      taskId: input.taskId,
      laneId: input.overlay.laneId,
      displayRole: input.overlay.displayRole,
      wave: input.wave,
      rejected: {
        attempts: input.summary.attempts,
        validator: input.summary.lastValidator ?? {
          name: 'DispatchFailure',
          message: input.fallbackMessage,
          category: input.fallbackCategory,
        },
        responseText: input.summary.lastResponseText,
      },
    })
  } catch {
    // The lane summary is diagnostics; it must not displace the terminal
    // failure handling the caller is in the middle of.
  }
}

function normalizePipelineParams(input: unknown): { task_id?: string; message?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (typeof input === 'string' && input.trim()) {
      return { task_id: 'auto', message: input }
    }
    return {}
  }

  const raw = input as Record<string, unknown>
  return {
    ...whenDefined(typeof raw.task_id === 'string' ? raw.task_id : undefined, (task_id) => ({ task_id })),
    ...whenDefined(typeof raw.message === 'string'
      ? raw.message
      : typeof raw.content === 'string'
        ? raw.content
        : undefined, (message) => ({ message })),
  }
}

function getPipelineState(ctx: PipelineContext): PipelineState | null {
  const es = ctx.state.levelStates.get(ctx.levelId)?.engineState
  if (es?.type === STAGE_TYPE.PIPELINE) return es
  return null
}

function initPipelineState(ctx: PipelineContext, planPath: string): PipelineState {
  const pipelineState: PipelineState = {
    type: STAGE_TYPE.PIPELINE,
    planPath,
    completedSprintIds: [],
    activeTaskIds: [],
  }
  const levelState = ctx.state.levelStates.get(ctx.levelId)
  if (levelState) levelState.engineState = pipelineState
  return pipelineState
}

function updatePipelineStageStatus(
  ctx: PipelineContext,
  next: typeof STAGE_LIFECYCLE_STATUS[keyof typeof STAGE_LIFECYCLE_STATUS],
): void {
  const levelState = ctx.state.levelStates.get(ctx.levelId)
  if (!levelState || !levelState.stageStatus || levelState.stageStatus === next) return
  if (!canTransitionStageStatus(levelState.stageStatus, next)) return
  transitionStageStatus(levelState, next)
}

function syncPipelineState(ctx: PipelineContext, pipelineState: PipelineState, planPath: string): void {
  const plan = parsePlan(planPath)
  if (!plan) return
  pipelineState.planPath = planPath
  pipelineState.activeTaskIds = [...plan.tasks.values()]
    .filter((task) => task.status === 'in_progress')
    .map((task) => task.id)
  pipelineState.completedSprintIds = plan.sprints
    .filter((sprint) => isSprintComplete(plan, sprint.id))
    .map((sprint) => sprint.id)
}

function buildPipelineResult(text: string) {
  return {
    details: undefined,
    content: [{ type: 'text' as const, text }],
  }
}

function persistDeepResearchTerminalBlocker(
  ctx: PipelineContext,
  plan: PlanState,
): string | undefined {
  if (
    !ctx.config.config.plan_artifact ||
    !areAllSprintsComplete(plan) ||
    areAllSprintsSuccessful(plan)
  ) {
    return undefined
  }

  const unsuccessfulTasks = [...plan.tasks.values()]
    .filter((task) => task.status !== 'completed' && task.status !== 'validated')
  const approvedPlan = readApprovedResearchPlanForBlocker(
    ctx.outputPath,
    ctx.config.config.plan_artifact,
  )
  const lanes = buildDeepResearchBlockerLanes({
    assignmentPath: ctx.outputPath,
    ...(approvedPlan ? { approvedPlan } : {}),
    tasks: unsuccessfulTasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      resultFile: task.resultFile,
    })),
  })
  const observationsByLane: Record<string, number> = {}
  for (const lane of lanes) {
    if (!lane.laneId) continue
    observationsByLane[lane.laneId] = countDeepResearchLaneObservations(
      ctx.outputPath,
      lane.laneId,
    )
  }
  const acquisition = readDeepResearchAcquisitionDiagnostics({
    workspacePath: ctx.workspacePath,
    assignmentPath: ctx.outputPath,
  })
  const searchCapability = evaluateSearchCapabilityForRun(ctx, ctx.config)
  const blocker = renderDeepResearchBlocker({
    lanes,
    observationsByLane,
    ...(acquisition ? { acquisition } : {}),
    ...(searchCapability ? { searchCapability } : {}),
    ...(approvedPlan
      ? {
          deadline: resolveBlockerDeadline(
            ctx,
            approvedPlan.maxDurationMinutes,
          ),
        }
      : {}),
  })

  const publishBlocker = (
    relativePath: string,
    artifactType: 'result' | 'report',
    role: string,
  ): void => {
    const artifactPath = resolveOwnedRunRelativePath({
      assignmentPath: ctx.outputPath,
      relativePath,
      label: 'Deep Research terminal blocker',
    })
    writeMarkdownArtifact(
      artifactPath,
      blocker,
      buildArtifactMetadata({
        filePath: artifactPath,
        rootDir: ctx.outputPath,
        artifactType,
        artifactRole: 'final',
        sessionId: ctx.state.sessionId,
        ...whenDefined(ctx.state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
        ...whenDefined(ctx.state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
        level: ctx.levelId,
        stageType: 'pipeline',
        status: 'blocked',
        role,
      }),
    )
  }

  try {
    // Order matters. The escalation copy destroys nothing, so it goes first:
    // preserving the report throws on paths an operator can have left unusable
    // (a symlinked package, a file where the archive directory belongs), and a
    // run that ended failed still owes them the blocker. The report is
    // published over only once its copy is out, so a preserve that throws
    // costs the archive and the second copy of the blocker, nothing more.
    publishBlocker('research/quality/escalation.md', 'result', 'research-escalation')
    preserveResearchReportBeforeTerminalBlocker(ctx, plan)
    publishBlocker('research-package.md', 'report', 'workflow-blocker')
  } catch (error) {
    return `Deep Research blocker persistence failed: ${error instanceof Error ? error.message : String(error)}`
  }

  return undefined
}

function persistDeepResearchFinalizationBlocker(
  ctx: PipelineContext,
  cause: string,
): string | undefined {
  const blocker = [
    '# Deep Research Blocked',
    '',
    '**Status:** BLOCKED',
    '',
    '## Finalization Failure',
    '',
    'Evidence collection completed, but the runtime could not validate and finalize the research package.',
    '',
    ...cause.split('\n').map((line) => `> ${line}`),
    '',
    'No verified research report was published. Correct the finalization failure before retrying.',
  ].join('\n')

  try {
    const artifactPath = resolveOwnedRunRelativePath({
      assignmentPath: ctx.outputPath,
      relativePath: 'research-package.md',
      label: 'Deep Research finalization blocker',
    })
    // A correction wave removes the previous report only as the last act of
    // finalization, so a failure part way through leaves the report the wave
    // before it verified still published. Writing this blocker over it would
    // destroy the only verified report the run has, and nothing here needs
    // publishing over a surviving one: the failure already reaches the
    // operator through the stage response. The terminal blocker is the other
    // case — that run's tasks really did end unsuccessfully, so it archives
    // the report and publishes over it once the copy is out. A deliberate skip
    // is not a persistence failure, so nothing is returned.
    if (holdsUnblockedResearchReport(artifactPath)) return undefined
    writeMarkdownArtifact(
      artifactPath,
      blocker,
      buildArtifactMetadata({
        filePath: artifactPath,
        rootDir: ctx.outputPath,
        artifactType: 'report',
        artifactRole: 'final',
        sessionId: ctx.state.sessionId,
        ...whenDefined(ctx.state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
        ...whenDefined(ctx.state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
        level: ctx.levelId,
        stageType: 'pipeline',
        status: 'blocked',
        role: 'workflow-blocker',
      }),
    )
  } catch (error) {
    return `Deep Research finalization blocker persistence failed: ${error instanceof Error ? error.message : String(error)}`
  }

  return undefined
}

/**
 * Whether the published research package holds a report that does not declare
 * itself blocked. This is the status test engines/chain.ts applies before it
 * archives a report (`resolveBlockedChainStepReason`), and nothing more: it
 * says the package is not a blocker, not that its contents were verified.
 *
 * An empty or frontmatter-only package holds no report at all. Reading one as
 * a report would let it stand in for the blocker a caller is about to publish,
 * and the run would end with no blocked artifact anywhere.
 *
 * `resolveOwnedRunRelativePath` has already refused a symlinked path by the
 * time this runs, so only a directory can still stand where the report
 * belongs.
 */
function holdsUnblockedResearchReport(reportPath: string): boolean {
  if (!fs.existsSync(reportPath)) return false
  if (!fs.lstatSync(reportPath).isFile()) return false
  const reportBody = stripArtifactFrontmatter(fs.readFileSync(reportPath, 'utf8')).trim()
  if (!reportBody) return false
  return !/(^|\n)\*\*Status:\*\*\s*BLOCKED\b/m.test(reportBody) &&
    !/(^|\n)Status:\s*BLOCKED\b/m.test(reportBody)
}

/**
 * Archive the published research report before a terminal blocker replaces it.
 *
 * A run whose tasks ended failed, blocked, or skipped is blocked, and must say
 * so where operators read it: a stale successful report with no blocked signal
 * next to it is worse than a report that moved. So the report is copied out
 * first, exactly as `preserveResearchReportBeforeBlocker` in engines/chain.ts
 * does — same `research/reports/report-wave-<n>.md` shape, and an archive
 * already written for that wave is left where it is, so the first report
 * preserved for a wave is the one that survives.
 *
 * That slot names the wave that PUBLISHED the report: it is how
 * `prepare-correction-wave.mjs` fills it, how chain.ts labels its own copy from
 * `verdict.correctionWave`, and how services/deep-research-journey-service.ts
 * titles it for operators. So it sits one below the wave being executed — a
 * correction wave removes the published report only as the last act of a
 * successful finalization, so while its tasks run, `research-package.md` still
 * holds what the wave before it published. The executed wave comes from the
 * evidence artifacts the plan declares, which is where every other
 * correction-wave read in this engine takes it from.
 *
 * The correction gate archived that same report into that slot before the wave
 * started, so on a correction wave this finds it filled and leaves it. It runs
 * anyway: the archive is what makes publishing over the report safe, this is
 * the last point that knows the overwrite is coming, and on wave 0 — no gate,
 * no earlier report — anything standing in `research-package.md` came from
 * outside this run and has no archive at all.
 */
function preserveResearchReportBeforeTerminalBlocker(
  ctx: PipelineContext,
  plan: PlanState,
): void {
  const reportPath = resolveOwnedRunRelativePath({
    assignmentPath: ctx.outputPath,
    relativePath: 'research-package.md',
    label: 'Deep Research synthesized report',
  })
  if (!holdsUnblockedResearchReport(reportPath)) return

  const executedWave = Math.max(
    0,
    ...[...plan.tasks.values()].map((task) => researchEvidenceWave(task.resultFile)),
  )
  const wave = Math.max(0, executedWave - 1)
  const archivePath = resolveOwnedRunRelativePath({
    assignmentPath: ctx.outputPath,
    relativePath: `research/reports/report-wave-${wave}.md`,
    label: 'Deep Research synthesized report archive',
  })
  if (fs.existsSync(archivePath)) return
  writeFileAtomicSync(archivePath, fs.readFileSync(reportPath, 'utf8'))
}

interface BoundedParallelDrainOptions {
  ctx: PipelineContext
  planPath: string
  pipelineState: PipelineState
  message?: string
  signal?: AbortSignal
  budgetAdmission?: BudgetDispatchAdmission
}

async function drainBoundedParallelTasks(
  options: BoundedParallelDrainOptions,
) {
  const {
    ctx,
    planPath,
    pipelineState,
    message,
    signal,
    budgetAdmission,
  } = options
  let maxConcurrency = ctx.config.config.max_concurrency ?? 4
  let admissionNotice: string | undefined
  if (ctx.config.config.plan_artifact) {
    try {
      const approvedLimits = resolveDeepResearchExecutionLimits({
        assignmentPath: ctx.outputPath,
        planArtifact: ctx.config.config.plan_artifact,
      })
      maxConcurrency = Math.min(maxConcurrency, approvedLimits.maxConcurrency)
      // A declared timeout at or above the plan budget can never fire, so it
      // reads as a safety control while providing none. The generic stage
      // parser has no plan context, so admission is the first place both
      // values are known.
      //
      // This is reported, not enforced: level constraints are authored for
      // long-form plans and are wrong only when read as absolute, so refusing
      // the run would block every short plan against a correct team file. The
      // reserve-aware dispatch clamp is the actual enforcement; this makes the
      // shortened timeout visible instead of implicit.
      admissionNotice = validateDeepResearchLevelTimeout({
        declaredAgentTimeoutMinutes: ctx.config.config.constraints?.agent_timeout_minutes,
        planMaxDurationMinutes: approvedLimits.maxDurationMinutes,
        levelId: ctx.levelId,
      })
    } catch (error) {
      updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
      return buildPipelineResult(
        `Deep Research execution blocked: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  } else if (ctx.config.config.deadline_artifact) {
    // A stage can consume the run budget without declaring a plan overlay —
    // `draft-sections` is the shipped example. It still runs inside the same
    // deadline, so it needs the same diagnostic and the same clamp; without
    // this it dispatched a fan-out with neither.
    try {
      const deadline = resolveOptionalDeepResearchDeadline({
        assignmentPath: ctx.outputPath,
        deadlineArtifact: ctx.config.config.deadline_artifact,
      })
      admissionNotice = deadline
        ? validateDeepResearchLevelTimeout({
            declaredAgentTimeoutMinutes: ctx.config.config.constraints?.agent_timeout_minutes,
            planMaxDurationMinutes: deadline.maxDurationMinutes,
            levelId: ctx.levelId,
          })
        : undefined
    } catch (error) {
      updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
      return buildPipelineResult(
        `Deep Research execution blocked: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const responses: string[] = admissionNotice
    ? [`**Level timeout clamped:** ${admissionNotice}`]
    : []
  let reportedMissingDeadline = false
  const singleTaskTool = createPipelineTool({
    ...ctx,
    recoveryMode: false,
    ...(budgetAdmission
      ? { adoptCapabilityBudget: () => budgetAdmission }
      : {}),
  })

  /**
   * Shutdown must propagate — never report an aborted wave as a stage result
   * (mirrors engines/broadcast.ts, engines/chain.ts and engines/review.ts).
   *
   * Without this the drain records a cancelled run as tasks that blocked on
   * their own merits, which is a different fact. What that costs downstream —
   * whether such a run ends terminally failed and cannot resume — is not
   * established here and is deliberately not claimed.
   */
  const throwIfAborted = (reason?: unknown): void => {
    if (!signal?.aborted && !ctx.shutdownSignal?.aborted) return
    if (reason !== undefined) throw reason
    throw signal?.reason ?? ctx.shutdownSignal?.reason ??
      new Error('Bounded parallel execution was aborted.')
  }

  while (true) {
    throwIfAborted()
    const plan = parsePlan(planPath)
    if (!plan) {
      updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
      // The clamp notice was produced at admission, before the plan was read.
      // Returning without it discards a diagnostic the operator has already
      // earned, on the one path where they most need the whole picture.
      responses.push(`**Cannot read plan file:** ${planPath}. Create a plan.md first.`)
      return buildPipelineResult(responses.join('\n'))
    }

    const ready = getReadyTasks(plan)
    if (ready.length === 0) {
      syncPipelineState(ctx, pipelineState, planPath)
      if (areAllSprintsComplete(plan)) {
        if (!areAllSprintsSuccessful(plan)) {
          updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.FAILED)
          const persistenceError = persistDeepResearchTerminalBlocker(ctx, plan)
          responses.push('**Pipeline failed:** one or more tasks ended failed, blocked, or skipped.')
          if (persistenceError) responses.push(`**${persistenceError}**`)
          break
        }
        if (ctx.config.config.plan_artifact) {
          try {
            finalizeDeepResearchEvidenceWave({
              assignmentPath: ctx.outputPath,
              planArtifact: ctx.config.config.plan_artifact,
              executablePlan: plan,
            })
          } catch (error) {
            updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
            const cause = error instanceof Error ? error.message : String(error)
            const persistenceError = persistDeepResearchFinalizationBlocker(ctx, cause)
            responses.push(`**Research evidence finalization blocked:** ${cause}`)
            if (persistenceError) responses.push(`**${persistenceError}**`)
            break
          }
        }
        updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.COMPLETED)
        responses.push('**Pipeline complete:** all tasks are terminal.')
      } else {
        updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
        responses.push('**Pipeline paused:** no further tasks are ready to dispatch.')
      }
      break
    }

    const waitingIds = pipelineState.questionTaskIds ?? []
    const wave = (waitingIds.length > 0 ? ready.filter((task) => waitingIds.includes(task.id)) : ready).slice(0, maxConcurrency)
    if (wave.length === 0) throw new Error('Pending question tasks are no longer ready to resume.')
    const settled = await Promise.allSettled(
      wave.map((task) => singleTaskTool.execute(
        `bounded-${task.id}`,
        { task_id: task.id, ...(message ? { message } : {}) },
        signal as never,
        undefined as never,
        undefined as never,
      )),
    )

    const interruption = settled.find((result) => result.status === 'rejected' && result.reason instanceof AgentQuestionInterruptionError)
    if (interruption?.status === 'rejected') {
      syncPipelineState(ctx, pipelineState, planPath)
      ctx.onStateCheckpoint?.()
      throw interruption.reason
    }
    let mustStop = false
    for (const [index, result] of settled.entries()) {
      const task = wave[index]
      if (!task) throw new Error(`Missing bounded pipeline task at index ${index}`)
      if (result.status === 'rejected') {
        throwIfAborted(result.reason)
        mustStop = true
        responses.push(
          `**${task.id} blocked:** ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        )
        continue
      }
      const text = (result.value.content?.[0] as { text?: string } | undefined)?.text ?? ''
      responses.push(text)
      if (
        text.includes('persistence failure') ||
        text.includes(' HALTED:') ||
        text.includes(`**${task.id} failed:`) ||
        text.includes(`**${task.id} blocked:`)
      ) {
        mustStop = true
      }
    }

    syncPipelineState(ctx, pipelineState, planPath)
    if (mustStop) {
      const terminalPlan = parsePlan(planPath)
      const terminalFailure = Boolean(
        terminalPlan &&
        areAllSprintsComplete(terminalPlan) &&
        !areAllSprintsSuccessful(terminalPlan),
      )
      if (terminalPlan && terminalFailure) {
        const persistenceError = persistDeepResearchTerminalBlocker(ctx, terminalPlan)
        if (persistenceError) responses.push(`**${persistenceError}**`)
      }
      updatePipelineStageStatus(
        ctx,
        terminalFailure ? STAGE_LIFECYCLE_STATUS.FAILED : STAGE_LIFECYCLE_STATUS.BLOCKED,
      )
      break
    }
  }

  return buildPipelineResult(
    responses.filter(Boolean).join('\n\n') + buildConstraintNote(ctx.config, ctx.state),
  )
}

/**
 * Create the `dispatch` tool for a pipeline stage.
 */
export function createPipelineTool(ctx: PipelineContext): ToolDefinition {
  let recoveryPrepared = !ctx.recoveryMode
  return {
    name: 'dispatch',
    label: 'Pipeline Dispatch',
    description:
      `Dispatch a task to an agent. Provide the task ID (e.g., T1) to dispatch. ` +
      `The agent receives the task description from plan.md and executes it. ` +
      `Use task_id: 'auto' to automatically dispatch the next ready task. ` +
      `Use task_id: 'status' to see current plan status.`,
    promptSnippet:
      `Use \`dispatch\` to send tasks to agents. Use task_id: 'auto' for automatic dispatch, ` +
      `or a specific task ID like 'T1'. Use 'status' to check progress.`,
    promptGuidelines: [
      "If an agent's result surfaces questions that require user input (unclear requirements, missing context, strategic decisions), present them to the user and wait before dispatching more tasks.",
      "Check task dependencies before dispatching — blocked tasks will fail.",
      "Use 'auto' mode to let the runtime pick and drain the next ready tasks.",
      "After dispatching, the agent works autonomously. Monitor via 'status'.",
      "Sprint gates are checked automatically after each task completion.",
    ],
    parameters: Type.Object({
      task_id: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
    }, {
      additionalProperties: true,
      description:
        'Optional pipeline parameters as an object. Supports { task_id, message } and accepts content as an alias for message. ' +
        'When omitted, the runtime defaults to task_id: "auto" and drains ready tasks deterministically.',
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _extensionCtx) {
      const budgetAdmission = adoptBudgetDispatchAdmission({
        ledger: ctx.budgetLedger,
        adopt: ctx.adoptCapabilityBudget,
        toolCallId: _toolCallId,
      })
      const { config, state, workspacePath, outputPath } = ctx
      const safeParams = normalizePipelineParams(params)

      const planPath = resolvePlanPath(
        config,
        workspacePath,
        outputPath,
        ctx.levelId,
      )
      const pipelineState = getPipelineState(ctx) ?? initPipelineState(ctx, planPath)
      if (!recoveryPrepared) {
        try {
          prepareInterruptedPipelineRecovery(planPath, outputPath)
          recoveryPrepared = true
        } catch (error) {
          updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
          return buildPipelineResult(
            `Pipeline recovery halted: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      syncPipelineState(ctx, pipelineState, planPath)

      if (safeParams.task_id === 'status') {
        return buildPipelineResult(getPlanStatus(planPath, state))
      }

      const plan = parsePlan(planPath)
      if (!plan) {
        updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
        return buildPipelineResult(`Cannot read plan file: ${planPath}. Create a plan.md first.`)
      }

      const requestedTaskId = safeParams.task_id ?? 'auto'
      if (
        requestedTaskId === 'auto' &&
        config.config.execution_mode === 'bounded_parallel'
      ) {
        return drainBoundedParallelTasks({
          ctx,
          planPath,
          pipelineState,
          ...whenDefined(safeParams.message, (definedValue) => ({ message: definedValue })),
          ...whenDefined(_signal, (definedValue) => ({ signal: definedValue })),
          ...(budgetAdmission ? { budgetAdmission } : {}),
        })
      }
      const responses: string[] = []
      const runUntilBlocked = requestedTaskId === 'auto'
      let firstIteration = true
      let reportedMissingDeadline = false

      while (true) {
        const currentPlan = parsePlan(planPath)
        if (!currentPlan) {
          updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
          return buildPipelineResult(`Cannot read plan file: ${planPath}. Create a plan.md first.`)
        }

        const task = resolveTask(currentPlan, firstIteration ? requestedTaskId : 'auto')
        if ('error' in task) {
          syncPipelineState(ctx, pipelineState, planPath)
          const terminalFailure = areAllSprintsComplete(currentPlan) && !areAllSprintsSuccessful(currentPlan)
          if (task.error.includes('All tasks complete') && config.config.plan_artifact) {
            try {
              finalizeDeepResearchEvidenceWave({
                assignmentPath: outputPath,
                planArtifact: config.config.plan_artifact,
                executablePlan: currentPlan,
              })
            } catch (error) {
              updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
              const cause = error instanceof Error ? error.message : String(error)
              const persistenceError = persistDeepResearchFinalizationBlocker(ctx, cause)
              // A single result text is returned as it stands, so its own bold
              // span closes and the persistence failure can be emphasised
              // inside it. A response joined with its siblings cannot: bold
              // does not span the blank line between them, and the reader gets
              // literal asterisks. The two sibling call sites push two
              // responses for the same reason.
              if (responses.length === 0) {
                const finalizationError = `Research evidence finalization blocked: ${cause}`
                return buildPipelineResult(
                  persistenceError
                    ? `${finalizationError}\n\n**${persistenceError}**`
                    : finalizationError,
                )
              }
              responses.push(`**Research evidence finalization blocked:** ${cause}`)
              if (persistenceError) responses.push(`**${persistenceError}**`)
              break
            }
          }
          if (responses.length === 0) {
            if (task.error.includes('All tasks complete')) {
              updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.COMPLETED)
            } else if (terminalFailure) {
              updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.FAILED)
              const persistenceError = persistDeepResearchTerminalBlocker(ctx, currentPlan)
              return buildPipelineResult(
                persistenceError ? `${task.error}\n\n**${persistenceError}**` : task.error,
              )
            } else if (task.error.includes('No tasks ready')) {
              updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
            } else {
              updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
            }
            return buildPipelineResult(task.error)
          }

          if (task.error.includes('All tasks complete')) {
            updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.COMPLETED)
            responses.push('**Pipeline complete:** all tasks are terminal.')
          } else if (terminalFailure) {
            updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.FAILED)
            responses.push('**Pipeline failed:** one or more tasks ended failed, blocked, or skipped.')
          } else if (task.error.includes('No tasks ready')) {
            updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
            responses.push('**Pipeline paused:** no further tasks are ready to dispatch.')
          }
          break
        }

        try {
          resolveOwnedRunRelativePath({
            assignmentPath: outputPath,
            relativePath: task.resultFile,
            label: `Pipeline task '${task.id}' result`,
          })
        } catch (error) {
          updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
          responses.push(
            `**${task.id} blocked:** ${error instanceof Error ? error.message : String(error)}`,
          )
          break
        }

        updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER)
        const agent = ctx.agents.get(task.agent)
        if (!agent) {
          if (!updateTaskStatus(planPath, task.id, 'failed', 'pending')) {
            updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
            responses.push(taskStatusPersistenceFailure(task.id, 'failed'))
            break
          }
          let skippedDeps: string[]
          try {
            skippedDeps = autoSkipDependents(planPath, task.id)
          } catch (error) {
            updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
            responses.push(
              `**${task.id} failed:** Agent '${task.agent}' not found. ${error instanceof Error ? error.message : String(error)} Pipeline halted.`,
            )
            break
          }
          updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.FAILED)
          const depNote = skippedDeps.length > 0
            ? ` Auto-skipping dependents: ${skippedDeps.join(', ')}.`
            : ''
          responses.push(`**${task.id} failed:** Agent '${task.agent}' not found.${depNote}`)
          break
        }

        let researchOverlay: DeepResearchTaskOverlay | undefined
        let effectiveAgentTimeoutMinutes = config.config.constraints?.agent_timeout_minutes
        let retryDeadlineMs: number | undefined
        if (config.config.plan_artifact) {
          try {
            researchOverlay = resolveDeepResearchTaskOverlay({
              assignmentPath: outputPath,
              planArtifact: config.config.plan_artifact,
              executablePlan: currentPlan,
              task,
            })
          } catch (error) {
            if (!updateTaskStatus(planPath, task.id, 'blocked', 'pending')) {
              updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
              responses.push(taskStatusPersistenceFailure(task.id, 'blocked'))
              break
            }
            let skippedDependents: string[] = []
            try {
              skippedDependents = autoSkipDependents(planPath, task.id)
            } catch (skipError) {
              updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
              responses.push(
                `**${task.id} blocked:** ${error instanceof Error ? error.message : String(error)} ` +
                `${skipError instanceof Error ? skipError.message : String(skipError)}`,
              )
              break
            }
            const blockedPlan = parsePlan(planPath)
            const terminalFailure = Boolean(
              blockedPlan &&
              areAllSprintsComplete(blockedPlan) &&
              !areAllSprintsSuccessful(blockedPlan),
            )
            if (blockedPlan && terminalFailure) {
              const persistenceError = persistDeepResearchTerminalBlocker(ctx, blockedPlan)
              if (persistenceError) responses.push(`**${persistenceError}**`)
            }
            updatePipelineStageStatus(
              ctx,
              terminalFailure
                ? STAGE_LIFECYCLE_STATUS.FAILED
                : STAGE_LIFECYCLE_STATUS.BLOCKED,
            )
            responses.push(
              `**${task.id} blocked:** ${error instanceof Error ? error.message : String(error)}` +
              (skippedDependents.length > 0
                ? ` Dependents marked skipped: ${skippedDependents.join(', ')}.`
                : ''),
            )
            break
          }
          const resolvedDeadline = config.config.deadline_artifact
            ? resolveDeepResearchDeadline({
                assignmentPath: outputPath,
                deadlineArtifact: config.config.deadline_artifact,
                planArtifact: config.config.plan_artifact,
              })
            : undefined
          const remainingPlanMs = resolvedDeadline?.remainingMs ??
            researchOverlay.planDeadlineMs - Math.max(0, Date.now() - state.startTime)
          retryDeadlineMs = resolvedDeadline
            ? Date.parse(resolvedDeadline.deadlineAt)
            : Date.now() + remainingPlanMs
          const dispatchBudget = planDeepResearchDispatchBudget({
            declaredTimeoutMinutes: effectiveAgentTimeoutMinutes,
            remainingMs: remainingPlanMs,
            workerDeadlineMs: researchOverlay.workerDeadlineMs,
            minimumDispatchMs: researchOverlay.minimumDispatchMs,
          })
          if (dispatchBudget.refusalReason) {
            if (!updateTaskStatus(planPath, task.id, 'failed', 'pending')) {
              updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
              responses.push(taskStatusPersistenceFailure(task.id, 'failed'))
              break
            }
            const skippedDeps = autoSkipDependents(planPath, task.id)
            updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.FAILED)
            responses.push(
              `**${task.id} failed:** ` +
              describeDeepResearchDispatchRefusal(dispatchBudget) +
              (skippedDeps.length > 0 ? ` Dependents marked skipped: ${skippedDeps.join(', ')}.` : ''),
            )
            break
          }
          effectiveAgentTimeoutMinutes = dispatchBudget.effectiveTimeoutMinutes
        } else if (config.config.deadline_artifact) {
          let deadline: DeepResearchDeadline | undefined
          try {
            deadline = resolveOptionalDeepResearchDeadline({
              assignmentPath: outputPath,
              deadlineArtifact: config.config.deadline_artifact,
            })
          } catch (error) {
            updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
            responses.push(
              `**${task.id} blocked:** Deep Research deadline validation failed: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            )
            break
          }
          if (!deadline) {
            // No budget artifact: the stage runs as it did before clamping
            // existed. Reported once so a silently unclamped fan-out is
            // visible rather than implicit.
            if (!reportedMissingDeadline) {
              reportedMissingDeadline = true
              responses.push(
                `**Deep Research budget unavailable:** \`${config.config.deadline_artifact}\` ` +
                `does not exist, so tasks on level '${ctx.levelId}' dispatch without a ` +
                `deadline clamp or shutdown reserve.`,
              )
            }
          } else {
          retryDeadlineMs = Date.parse(deadline.deadlineAt)
          const dispatchBudget = planDeepResearchDispatchBudget({
            declaredTimeoutMinutes: effectiveAgentTimeoutMinutes,
            remainingMs: deadline.remainingMs,
          })
          if (dispatchBudget.refusalReason) {
            if (!updateTaskStatus(planPath, task.id, 'failed', 'pending')) {
              updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
              responses.push(taskStatusPersistenceFailure(task.id, 'failed'))
              break
            }
            const skippedDeps = autoSkipDependents(planPath, task.id)
            updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.FAILED)
            responses.push(
              `**${task.id} failed:** ` +
              describeDeepResearchDispatchRefusal(dispatchBudget) +
              (skippedDeps.length > 0
                ? ` Dependents marked skipped: ${skippedDeps.join(', ')}.`
                : ''),
            )
            break
          }
          effectiveAgentTimeoutMinutes = dispatchBudget.effectiveTimeoutMinutes
          }
        }

        if (!updateTaskStatus(planPath, task.id, 'in_progress', 'pending')) {
          syncPipelineState(ctx, pipelineState, planPath)
          updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
          responses.push(taskStatusPersistenceFailure(task.id, 'in_progress'))
          break
        }
        saveBriefIfFirst(outputPath, planPath, task)
        logAgentDispatch(outputPath, task.agent, task.id, task.title)
        syncPipelineState(ctx, pipelineState, planPath)
        ctx.onStateCheckpoint?.()

        const taskOutputPath = resolveTaskOutputPath(config, outputPath, task)
        const baseUserMessage = buildTaskMessage(
          planPath,
          task,
          safeParams.message,
          ctx.inputFilesContent,
          workspacePath,
          taskOutputPath,
        )
        const basePrompt = buildAgentPrompt(
          ctx.teamRootPath,
          agent,
          state,
          workspacePath,
          taskOutputPath,
          baseUserMessage,
        )
        // A section writer is given evidence, not a path: an isolated provider
        // has no filesystem tool, and a run that leaves it one gets a refusal
        // back and stores it as a draft. In a configured drafting stage every
        // task is a section draft, so a task whose evidence cannot be resolved,
        // or whose request cannot be admitted, fails here rather than reaching
        // a provider or the generic persistence path.
        //
        // Admission measures the whole rendered request, because the dossier
        // payload is only part of what a writer receives: the task message, any
        // attached input files, and the agent's own instructions ride along.
        const draftingConfig = config.config.section_dossier_drafting
        let sectionAssignment: SectionDraftAssignment | undefined
        let sectionMessage: string | undefined
        if (draftingConfig) {
          try {
            sectionAssignment = resolveSectionDraftAssignment({
              assignmentPath: outputPath,
              planArtifact: draftingConfig.plan_artifact,
              dossierIndexArtifact: draftingConfig.dossier_index_artifact,
              resultFile: task.resultFile,
            })
            sectionMessage = buildSectionWriterMessage({
              dossier: sectionAssignment.dossier,
              budget: {
                contextWindowTokens: draftingConfig.context_window_tokens,
                outputReserveTokens: draftingConfig.output_reserve_tokens,
              },
              renderRequest: (candidate) => ({
                systemPrompt: basePrompt,
                userMessage: `${baseUserMessage}\n\n${candidate}`,
                ...whenDefined(agent.tools, (tools) => ({ toolDescriptors: tools })),
              }),
            }).text
          } catch (error) {
            if (!updateTaskStatus(planPath, task.id, 'failed', 'in_progress')) {
              updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
              responses.push(taskStatusPersistenceFailure(task.id, 'failed'))
              break
            }
            let skippedDeps: string[]
            try {
              skippedDeps = autoSkipDependents(planPath, task.id)
            } catch (skipError) {
              updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
              responses.push(
                `**${task.id} failed:** Section evidence could not be materialized: ` +
                `${error instanceof Error ? error.message : String(error)} ` +
                `${skipError instanceof Error ? skipError.message : String(skipError)} Pipeline halted.`,
              )
              break
            }
            syncPipelineState(ctx, pipelineState, planPath)
            updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.FAILED)
            responses.push(
              `**${task.id} failed:** Section evidence could not be materialized: ` +
              `${error instanceof Error ? error.message : String(error)}` +
              (skippedDeps.length > 0
                ? ` Dependents marked skipped: ${skippedDeps.join(', ')}.`
                : ''),
            )
            break
          }
        }
        const userMessage = researchOverlay
          ? `${baseUserMessage}\n\n# Approved Research Assignment\n\n${researchOverlay.user}`
          : sectionMessage
            ? `${baseUserMessage}\n\n${sectionMessage}`
            : baseUserMessage
        const finalPrompt = researchOverlay
          ? `${basePrompt}\n\n# Runtime-Controlled Research Policy\n\n${researchOverlay.system}`
          : basePrompt

        const metrics = ctx.agentMetrics.get(task.agent)
        const rosterEntry = ctx.rosterEntries.get(task.agent)
        const teamWorkspacePath = rosterEntry?.type === 'team' && rosterEntry.team_path
          ? resolveChildWorkspacePath(rosterEntry.team_path)
          : undefined

        const agentPolicy = rosterEntry?.on_failure
        const resolvedPolicy = resolveFailurePolicy(
          task.agent,
          STAGE_TYPE.PIPELINE,
          ctx.stageFailureOverride,
          agentPolicy,
        )
        const fallbackName = resolvedPolicy.fallbackAgent
        const fallbackAgent = fallbackName ? ctx.agents.get(fallbackName) : undefined
        const fallbackRosterEntry = fallbackName ? ctx.rosterEntries.get(fallbackName) : undefined
        const fallbackFinalPrompt = fallbackAgent
          ? buildAgentPrompt(ctx.teamRootPath, fallbackAgent, state, workspacePath, outputPath, baseUserMessage)
          : undefined

        const researchObservers = researchOverlay
          ? createDeepResearchWorkerAttemptObservers({
              assignmentPath: outputPath,
              laneId: researchOverlay.laneId,
              taskId: task.id,
              sectionId: researchOverlay.sectionId,
              workerSpecHash: researchOverlay.assignmentHash,
            })
          : undefined
        try {
          const result = await dispatchWithFailurePolicy({
            agent,
            rosterEntry,
            finalPrompt,
            userMessage,
            state,
            workspacePath,
            outputPath: taskOutputPath,
            ...whenDefined(teamWorkspacePath, (definedValue) => ({ teamWorkspacePath: definedValue })),
            metrics,
            ...whenDefined(ctx.shutdownSignal ? combineAbortSignals(_signal, ctx.shutdownSignal) : _signal, (definedValue) => ({ signal: definedValue })),
            ...whenDefined(ctx.onDashboardUpdate, (definedValue) => ({ onDashboardUpdate: definedValue })),
            triggerTool: 'dispatch',
            logicalInvocationId: buildStageDispatchInvocationId({
              sessionId: state.sessionId,
              levelId: ctx.levelId,
              visitCount: state.levelStates.get(ctx.levelId)?.visitCount ?? 0,
              stageType: STAGE_TYPE.PIPELINE,
              slot: `task:${task.id}`,
              target: task.agent,
            }),
            ...whenDefined(ctx.teamName, (definedValue) => ({ teamName: definedValue })),
            fromName: ctx.config.coordinator ?? 'coordinator',
            ...(researchOverlay
              ? {
                  activityScopeId: researchOverlay.laneId,
                  agentDisplayName: researchOverlay.displayRole,
                  governedWebEvidenceMode:
                    researchOverlay.governedWebEvidenceMode,
                }
              : {}),
            policy: resolvedPolicy,
            ...whenDefined(fallbackAgent, (definedValue) => ({ fallbackAgent: definedValue })),
            ...whenDefined(fallbackRosterEntry, (definedValue) => ({ fallbackRosterEntry: definedValue })),
            ...whenDefined(fallbackFinalPrompt, (definedValue) => ({ fallbackFinalPrompt: definedValue })),
            levelId: ctx.levelId,
            stageType: STAGE_TYPE.PIPELINE,
            sessionId: state.sessionId,
            ...whenDefined(state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
            errorLogPath: taskOutputPath,
            onFailureRecorded: (agentName, error) => {
              const m = ctx.agentMetrics.get(agentName)
              if (m) { m.failureCount++; m.lastError = error }
            },
            ...(researchObservers
              ? {
                  validateResult: researchObservers.validateResult,
                  onAttemptRecord: researchObservers.onAttemptRecord,
                  onAttemptFailure: researchObservers.onAttemptFailure,
                }
              : {}),
            ...whenDefined(ctx.budgetLedger, (definedValue) => ({ budgetLedger: definedValue })),
            totalCost: state.totalCost,
            ...(budgetAdmission ? { budgetAdmission } : {}),
            ...whenDefined(effectiveAgentTimeoutMinutes, (definedValue) => ({ timeoutMinutes: definedValue })),
            ...whenDefined(retryDeadlineMs, (definedValue) => ({ retryDeadlineMs: definedValue })),
          })

          if (result.interruption) {
            if (!updateTaskStatus(planPath, task.id, 'pending', 'in_progress')) {
              throw new Error(taskStatusPersistenceFailure(task.id, 'pending'))
            }
            pipelineState.questionTaskIds = [...new Set([...(pipelineState.questionTaskIds ?? []), task.id])]
            syncPipelineState(ctx, pipelineState, planPath)
            ctx.onStateCheckpoint?.()
            throw new AgentQuestionInterruptionError(result.interruption)
          }
          pipelineState.questionTaskIds = pipelineState.questionTaskIds?.filter((id) => id !== task.id) ?? []

          if (result.skipped) {
            if (researchOverlay && researchObservers) {
              writeRejectedResearchLaneSummary({
                assignmentPath: outputPath,
                sessionId: state.sessionId,
                levelId: ctx.levelId,
                taskId: task.id,
                overlay: researchOverlay,
                wave: researchEvidenceWave(task.resultFile),
                summary: researchObservers.attemptSummary(),
                fallbackMessage: `Agent '${task.agent}' was skipped by its failure policy.`,
                fallbackCategory: 'dispatch_skipped',
              })
            }
            if (!updateTaskStatus(planPath, task.id, 'skipped', 'in_progress')) {
              updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
              responses.push(taskStatusPersistenceFailure(task.id, 'skipped'))
              break
            }
            let skippedDeps: string[]
            try {
              skippedDeps = autoSkipDependents(planPath, task.id)
            } catch (error) {
              updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
              responses.push(
                `**${task.id} skipped:** ${error instanceof Error ? error.message : String(error)} Pipeline halted.`,
              )
              break
            }
            const depNote = skippedDeps.length > 0
              ? ` Auto-skipping dependents: ${skippedDeps.join(', ')}.`
              : ''
            responses.push(`**${task.id} skipped:** Agent ${task.agent} failed per failure policy.${depNote}`)
            if (researchOverlay) {
              const capabilityNote = reportSearchCapabilityBlocker(ctx, config)
              if (capabilityNote) responses.push(`**${capabilityNote}**`)
            }
          } else {
            if (researchOverlay || config.config.persist_result) {
              try {
                const resultPath = resolveOwnedRunRelativePath({
                  assignmentPath: outputPath,
                  relativePath: task.resultFile,
                  label: `Pipeline task '${task.id}' result`,
                })
                if (!researchOverlay) {
                  // A writing stage persists a validated section, never the
                  // raw response: a refusal, a status report, or a draft
                  // citing evidence this section never had must not become a
                  // completed artifact the synthesizer later trusts.
                  const validatedText = sectionAssignment
                    ? validateSectionDraftAgainstDossier({
                        result: parseSectionDraftResult({
                          sectionId: sectionAssignment.dossier.sectionId,
                          text: result.text,
                        }),
                        dossier: sectionAssignment.dossier,
                      }).markdown
                    : result.text
                  writeFileAtomicSync(
                    resultPath,
                    `${validatedText.trimEnd()}\n`,
                  )
                } else {
                  const evidencePacket = researchObservers?.validatedPacket()
                  if (!evidencePacket) {
                    throw new Error('Validated research evidence was unavailable after dispatch.')
                  }
                  writeFileAtomicSync(resultPath, `${JSON.stringify(evidencePacket, null, 2)}\n`)
                  if (researchOverlay) {
                    // Diagnostics must never fail a task whose evidence is
                    // already durably persisted above.
                    try {
                      writeDeepResearchWorkerEvidenceSummary({
                        assignmentPath: outputPath,
                        sessionId: state.sessionId,
                        levelId: ctx.levelId,
                        taskId: task.id,
                        laneId: researchOverlay.laneId,
                        displayRole: researchOverlay.displayRole,
                        wave: researchEvidenceWave(task.resultFile),
                        packet: evidencePacket,
                      })
                    } catch {
                      // The lane summary is observability; the validated packet
                      // is the contract and it is already written.
                    }
                  }
                }
              } catch (error) {
                if (researchOverlay && researchObservers) {
                  writeRejectedResearchLaneSummary({
                    assignmentPath: outputPath,
                    sessionId: state.sessionId,
                    levelId: ctx.levelId,
                    taskId: task.id,
                    overlay: researchOverlay,
                    wave: researchEvidenceWave(task.resultFile),
                    summary: researchObservers.attemptSummary(),
                    fallbackMessage: error instanceof Error ? error.message : String(error),
                    fallbackCategory: 'evidence_persistence_failed',
                  })
                }
                if (!updateTaskStatus(planPath, task.id, 'failed', 'in_progress')) {
                  updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
                  responses.push(taskStatusPersistenceFailure(task.id, 'failed'))
                  break
                }
                let skippedDeps: string[]
                try {
                  skippedDeps = autoSkipDependents(planPath, task.id)
                } catch (skipError) {
                  updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
                  responses.push(
                    `**${task.id} failed:** Invalid research evidence. ${skipError instanceof Error ? skipError.message : String(skipError)} Pipeline halted.`,
                  )
                  break
                }
                updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.FAILED)
                const depNote = skippedDeps.length > 0
                  ? ` Dependents marked skipped: ${skippedDeps.join(', ')}.`
                  : ''
                responses.push(
                  `**${task.id} failed:** Result persistence failed: ${error instanceof Error ? error.message : String(error)}${depNote}`,
                )
                syncPipelineState(ctx, pipelineState, planPath)
                break
              }
            }
            const searchCapabilityBlocker = capabilityFailureForAcceptedLane(
              ctx,
              config,
              researchOverlay !== undefined,
            )
            if (searchCapabilityBlocker) {
              if (!updateTaskStatus(planPath, task.id, 'failed', 'in_progress')) {
                updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
                responses.push(taskStatusPersistenceFailure(task.id, 'failed'))
                break
              }
              let skippedCapabilityDeps: string[]
              try {
                skippedCapabilityDeps = autoSkipDependents(planPath, task.id)
              } catch (error) {
                updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
                responses.push(
                  `**${task.id} failed:** Search capability absent. ${error instanceof Error ? error.message : String(error)} Pipeline halted.`,
                )
                break
              }
              syncPipelineState(ctx, pipelineState, planPath)
              updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.FAILED)
              responses.push(
                `**${task.id} failed:** ${searchCapabilityBlocker}` +
                (skippedCapabilityDeps.length > 0
                  ? ` Dependents marked skipped: ${skippedCapabilityDeps.join(', ')}.`
                  : ''),
              )
              break
            }
            if (!updateTaskStatus(planPath, task.id, 'completed', 'in_progress')) {
              updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
              responses.push(taskStatusPersistenceFailure(task.id, 'completed'))
              break
            }
            updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.RUNNING)
            const dispatchLabel = researchOverlay
              ? `${researchOverlay.displayRole} via ${task.agent}`
              : task.agent
            const dispatchResult = researchOverlay
              ? `Evidence packet validated and saved to ${task.resultFile}.`
              : result.text
            // Past validation, persistence, the capability blocker, and the
            // status write, so the task's result is accepted. The published
            // text is the same one the stage presents; a research lane's
            // evidence packet stays in its own file rather than in chat.
            publishAcceptedTeamChatMessage(ctx, {
              agentName: result.agentName ?? task.agent,
              ...whenDefined(result.dispatchId, (dispatchId) => ({ dispatchId })),
              stageType: STAGE_TYPE.PIPELINE,
              text: dispatchResult,
            })
            responses.push(`**${task.id} dispatched to ${dispatchLabel}:**\n\n${dispatchResult}${buildSprintNote(planPath, task)}`)
          }
          syncPipelineState(ctx, pipelineState, planPath)
          ctx.onStateCheckpoint?.()
        } catch (err) {
          if (err instanceof AgentQuestionInterruptionError) throw err;
          if (err instanceof HaltError) {
            if (researchOverlay && researchObservers) {
              writeRejectedResearchLaneSummary({
                assignmentPath: outputPath,
                sessionId: state.sessionId,
                levelId: ctx.levelId,
                taskId: task.id,
                overlay: researchOverlay,
                wave: researchEvidenceWave(task.resultFile),
                summary: researchObservers.attemptSummary(),
                fallbackMessage: err.message,
                fallbackCategory: 'dispatch_failed',
              })
            }
            if (!updateTaskStatus(planPath, task.id, 'failed', 'in_progress')) {
              updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
              responses.push(taskStatusPersistenceFailure(task.id, 'failed'))
              break
            }
            let skippedDeps: string[]
            try {
              skippedDeps = autoSkipDependents(planPath, task.id)
            } catch (error) {
              updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
              responses.push(
                `**${task.id} HALTED:** ${err.message}. ${error instanceof Error ? error.message : String(error)} Pipeline halted.`,
              )
              break
            }
            syncPipelineState(ctx, pipelineState, planPath)
            updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.FAILED)
            if (ctx.onDashboardUpdate) ctx.onDashboardUpdate()
            const depNote = skippedDeps.length > 0
              ? ` Dependents marked skipped: ${skippedDeps.join(', ')}.`
              : ''
            responses.push(`**${task.id} HALTED:** ${err.message}. Pipeline stopped.${depNote}`)
            if (researchOverlay) {
              const capabilityNote = reportSearchCapabilityBlocker(ctx, config)
              if (capabilityNote) responses.push(`**${capabilityNote}**`)
            }
            break
          }
          // A non-Halt exception leaves the loop entirely, so this is the last
          // point at which the lane's attempts can be attributed to it. The
          // summary is written before the rethrow rather than lost with it.
          //
          // An abort is the exception: the lane did not fail on its own output,
          // the run was stopped. Recording a rejected lane here would put that
          // mischaracterisation into the evidence an operator later reads
          // (mirrors the shutdown guards in engines/broadcast.ts and
          // engines/chain.ts).
          const aborted = _signal?.aborted || ctx.shutdownSignal?.aborted
          if (!aborted && researchOverlay && researchObservers) {
            writeRejectedResearchLaneSummary({
              assignmentPath: outputPath,
              sessionId: state.sessionId,
              levelId: ctx.levelId,
              taskId: task.id,
              overlay: researchOverlay,
              wave: researchEvidenceWave(task.resultFile),
              summary: researchObservers.attemptSummary(),
              fallbackMessage: err instanceof Error ? err.message : String(err),
              fallbackCategory: 'dispatch_failed',
            })
          }
          throw err
        }

        firstIteration = false
        if (!runUntilBlocked) break
      }

      const terminalPlan = parsePlan(planPath)
      if (config.config.plan_artifact) {
        if (terminalPlan && areAllSprintsSuccessful(terminalPlan)) {
          try {
            finalizeDeepResearchEvidenceWave({
              assignmentPath: outputPath,
              planArtifact: config.config.plan_artifact,
              executablePlan: terminalPlan,
            })
          } catch (error) {
            updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
            const cause = error instanceof Error ? error.message : String(error)
            const persistenceError = persistDeepResearchFinalizationBlocker(ctx, cause)
            responses.push(`**Research evidence finalization blocked:** ${cause}`)
            if (persistenceError) responses.push(`**${persistenceError}**`)
          }
        } else if (terminalPlan && areAllSprintsComplete(terminalPlan)) {
          updatePipelineStageStatus(ctx, STAGE_LIFECYCLE_STATUS.FAILED)
          const persistenceError = persistDeepResearchTerminalBlocker(ctx, terminalPlan)
          if (persistenceError) responses.push(`**${persistenceError}**`)
        }
      }
      const constraintNote = buildConstraintNote(config, state)
      return buildPipelineResult(responses.join('\n\n') + constraintNote)
    },

    renderCall(args, theme) {
      const taskId = (args as Record<string, unknown>).task_id ?? '?'
      return new Text(`${theme.fg('accent', 'dispatch')} \u2192 ${taskId}`)
    },

    renderResult(result, _options, theme) {
      const text = (result.content?.[0] as { text?: string })?.text ?? ''
      const isError = text.includes('failed:') || text.includes('blocked')
      const status = isError ? theme.fg('error', 'failed') : theme.fg('success', 'completed')
      return new Text(`Task ${status}`)
    },
  }
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Snapshot the configured plan into run-owned private state before mutation.
 * The configured path remains a read-only input; task status updates never
 * touch a shared workspace plan.
 */
function resolvePlanPath(
  config: PipelineStageConfig,
  workspacePath: string,
  outputPath: string,
  levelId: string,
): string {
  const relativeRuntimePlan = `.runtime/pipeline/${levelId}/plan.md`
  const runtimePlanPath = resolveRelativePathInside(
    outputPath,
    relativeRuntimePlan,
  )
  if (!runtimePlanPath) {
    throw new Error(`Pipeline level '${levelId}' cannot own a runtime plan path`)
  }
  if (fs.existsSync(runtimePlanPath)) return runtimePlanPath

  const sourcePlanPath = config.config.plan_file
    ? (path.isAbsolute(config.config.plan_file)
      ? config.config.plan_file
      : config.config.plan_artifact
        || config.config.run_owned_plan
        ? resolveRunOwnedPlanPath(outputPath, config.config.plan_file)
        : path.join(workspacePath, config.config.plan_file))
    : path.join(workspacePath, '.pi-tasks', 'plan.md')

  if (fs.existsSync(sourcePlanPath) && fs.statSync(sourcePlanPath).isFile()) {
    writeFileAtomicSync(runtimePlanPath, fs.readFileSync(sourcePlanPath))
  }
  return runtimePlanPath
}

function resolveRunOwnedPlanPath(
  outputPath: string,
  relativePlanPath: string,
): string {
  const planPath = resolveRelativePathInside(outputPath, relativePlanPath)
  if (!planPath) {
    throw new Error(
      `Run-owned pipeline plan must stay inside the assignment: ${relativePlanPath}`,
    )
  }
  return planPath
}

/** Resolve which task to dispatch, returning either the task or an error string. */
function resolveTask(
  plan: PlanState,
  taskId: string,
): PlanTask | { error: string } {
  if (taskId === 'auto') {
    const ready = getReadyTasks(plan)
    if (ready.length === 0) {
      const allDone = areAllSprintsComplete(plan)
      if (allDone && areAllSprintsSuccessful(plan)) {
        return { error: 'All tasks complete. Pipeline finished.' }
      }
      if (allDone) {
        return { error: 'Pipeline ended with failed, blocked, or skipped tasks.' }
      }
      return { error: 'No tasks ready to dispatch. Waiting for dependencies to complete.' }
    }
    const firstReadyTask = ready[0]
    if (!firstReadyTask) {
      return { error: 'No tasks ready to dispatch. Waiting for dependencies to complete.' }
    }
    return firstReadyTask
  }

  const task = plan.tasks.get(taskId)
  if (!task) return { error: `Task ${taskId} not found in plan.` }
  if (task.status !== 'pending') {
    return {
      error: `Task ${taskId} is ${task.status} and cannot be dispatched again.`,
    }
  }

  const deps = checkDependencies(plan, taskId)
  if (!deps.satisfied) {
    const blockers = deps.blocking.map((b) => `${b.id} (${b.status})`).join(', ')
    return { error: `Task ${taskId} blocked by: ${blockers}` }
  }

  return task
}

function taskStatusPersistenceFailure(
  taskId: string,
  status: TaskStatus,
): string {
  return `**${taskId} persistence failure:** Could not durably persist status '${status}'. Pipeline halted to prevent duplicate execution.`
}

function prepareInterruptedPipelineRecovery(
  planPath: string,
  outputPath: string,
): string[] {
  const plan = parsePlan(planPath)
  if (!plan) {
    throw new Error(`Cannot read pipeline plan during recovery: ${planPath}`)
  }
  for (const task of plan.tasks.values()) {
    if (task.status !== 'in_progress' || !task.resultFile) continue
    const resultPath = resolveOwnedRunRelativePath({
      assignmentPath: outputPath,
      relativePath: task.resultFile,
      label: `Interrupted task '${task.id}' result`,
    })
    if (!fs.existsSync(resultPath)) continue
    const resultStat = fs.lstatSync(resultPath)
    if (resultStat.isDirectory() && !resultStat.isSymbolicLink()) {
      throw new Error(
        `Interrupted task '${task.id}' result path is a directory.`,
      )
    }
    fs.rmSync(resultPath, { force: true })
  }
  return recoverInterruptedPipelineTasks(planPath)
}

/** Save a brief.md on first dispatch if one doesn't exist. */
function saveBriefIfFirst(outputPath: string, planPath: string, task: PlanTask): void {
  const briefPath = path.join(outputPath, 'brief.md')
  if (!fs.existsSync(briefPath)) {
    const body = `# Pipeline Brief\n\nPlan: ${planPath}\n\nFirst task dispatched: ${task.id} — ${task.title}`
    writeMarkdownArtifact(
      briefPath,
      body,
      buildArtifactMetadata({
        filePath: briefPath,
        rootDir: outputPath,
        artifactType: 'brief',
        status: 'active',
        taskId: task.id,
        sprintId: task.sprintId,
        title: task.title,
      }),
    )
  }
}

/** Build the user message for an agent task dispatch. */
function buildTaskMessage(
  planPath: string,
  task: PlanTask,
  extraMessage: string | undefined,
  inputFilesContent: string,
  workspacePath: string,
  assignmentPath: string,
): string {
  const planContent = fs.readFileSync(planPath, 'utf-8')
  const taskSectionMatch = planContent.match(
    new RegExp(`#### ${task.id}:[\\s\\S]*?(?=####|### |$)`)
  )
  const taskSection = taskSectionMatch ? taskSectionMatch[0].trim() : task.title

  const inputFilesSection = inputFilesContent
    ? `\n## Input Files\n\n${inputFilesContent}\n`
    : ''

  return (
    `# Task Assignment: ${task.id}\n\n` +
    `${taskSection}\n\n` +
    (extraMessage ? `## Additional Instructions\n\n${extraMessage}\n\n` : '') +
    inputFilesSection +
    `## Workspace\n\nWork in: ${workspacePath}\n` +
    `Assignment output directory: ${assignmentPath}\n` +
    (task.resultFile ? `Expected output: ${task.resultFile}\n` : '') +
    `\nComplete the task and report your results.`
  )
}

function resolveTaskOutputPath(
  config: PipelineStageConfig,
  outputPath: string,
  task: PlanTask,
): string {
  if (config.config.assignment_scope !== 'task') return outputPath
  const resultPath = resolveOwnedRunRelativePath({
    assignmentPath: outputPath,
    relativePath: task.resultFile,
    label: `Pipeline task '${task.id}' result`,
  })
  const taskOutputPath = path.dirname(resultPath)
  fs.mkdirSync(taskOutputPath, { recursive: true })
  return taskOutputPath
}

/** Build the substituted system prompt for an agent. */
function buildAgentPrompt(
  teamRootPath: string,
  agent: { systemPrompt: string; agentDir: string; experienceEnabled: boolean },
  state: PipelineContext['state'],
  workspacePath: string,
  outputPath: string,
  taskContent: string,
): string {
  return substituteTemplateVars(agent.systemPrompt, {
    SESSION_ID: state.sessionId,
    WORKSPACE_PATH: workspacePath,
    ASSIGNMENT_PATH: outputPath,
    OUTPUT_PATH: outputPath,
    EXPERIENCE_PATH: agent.experienceEnabled ? path.join(agent.agentDir, 'experience') : '',
    TEAM_ROOT_PATH: teamRootPath,
    TEMPLATES_PATH: path.join(teamRootPath, 'templates'),
    PROFILES_PATH: path.join(teamRootPath, 'profiles'),
    STYLE_GUIDE_PATH: path.join(teamRootPath, 'style-guide.md'),
    CLIENT_NAME: '',
    PROJECT_NAME: '',
    // Without this the literal `{{TASK_CONTENT}}` reaches the model, because
    // `substituteTemplateVars` leaves absent keys untouched. The caller passes
    // the assembled task message for this dispatch, which is the same content
    // engines/review.ts passes for a revision iteration.
    TASK_CONTENT: taskContent,
  })
}

/** Check sprint completion and return a note string. */
function buildSprintNote(planPath: string, task: PlanTask): string {
  const updatedPlan = parsePlan(planPath)
  if (!updatedPlan || !task.sprintId) return ''

  if (!isSprintComplete(updatedPlan, task.sprintId)) return ''

  let note = `\n\n**Sprint ${task.sprintId} complete.**`
  if (areAllSprintsSuccessful(updatedPlan)) {
    note += ' **All sprints complete — pipeline finished.**'
  }
  return note
}

/** Format constraint status note for the result message. */
function buildConstraintNote(config: PipelineStageConfig, state: PipelineContext['state']): string {
  if (!config.config.constraints) return ''

  const cs = checkConstraints(config.config.constraints, state.startTime, state.totalCost, state.endTime)
  let note = `\n\n---\n**Constraints:** ${formatElapsed(state.startTime, state.endTime)} elapsed, ${formatCost(state.totalCost)} spent`
  if (cs.timeWarning) note += ' \u26a0\ufe0f Time nearly up'
  if (cs.budgetWarning) note += ' \u26a0\ufe0f Budget nearly exhausted'
  return note
}

// ─── Public Engine API ───────────────────────────────────────────────────────

/**
 * Check if the pipeline is successfully complete.
 */
export function isPipelineComplete(planPath: string): boolean {
  const plan = parsePlan(planPath)
  if (!plan) return false
  return areAllSprintsSuccessful(plan)
}

/**
 * Get a formatted plan status summary.
 */
function getPlanStatus(planPath: string, state: PipelineContext['state']): string {
  const plan = parsePlan(planPath)
  if (!plan) return `No plan found at ${planPath}`

  const lines: string[] = [`# Plan Status: ${plan.title}`, `**Status:** ${plan.status}`, '']

  for (const sprint of plan.sprints) {
    const complete = isSprintComplete(plan, sprint.id)
    const icon = complete ? '\u2713' : '\u25cb'
    lines.push(`### ${icon} ${sprint.id}: ${sprint.name}`)

    for (const taskId of sprint.taskIds) {
      const task = plan.tasks.get(taskId)
      if (!task) continue
      const statusIcon = {
        pending: '\u25cb',
        in_progress: '\u25c9',
        completed: '\u2713',
        validated: '\u2713\u2713',
        failed: '\u2717',
        blocked: '\u26d4',
        skipped: '\u23e9',
      }[task.status] || '?'
      lines.push(`  ${statusIcon} ${task.id}: ${task.title} [${task.agent}] — ${task.status}`)
    }
    lines.push('')
  }

  lines.push(`**Total cost:** ${formatCost(state.totalCost)}`)
  lines.push(`**Elapsed:** ${formatElapsed(state.startTime, state.endTime)}`)

  return lines.join('\n')
}
