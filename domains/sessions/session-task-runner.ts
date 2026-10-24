import { whenDefined } from '../../core/optional-properties.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initProviders } from '../../providers/index.js'
import {
  writeMarkdownArtifact,
  buildArtifactMetadata,
  withArtifactFrontmatter,
} from '../runtime/artifacts.js'
import { writeFileAtomicSync } from '../../core/file-mutation.js'
import { logProcessWarning, logRuntimeEvent, logSessionStart } from '../runtime/logger.js'
import { parseTeamRegistry } from '../../parsers/team-registry.js'
import { parseWorkflowRegistry } from '../../workflows/loader.js'
import { createWorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import { startWorkspaceExecutionJournal } from '../../services/execution-journal-tenant-pin.js'
import { runWorkflowOutcome } from '../../workflows/runner.js'
import { createWorkflowModelChoiceEvaluator } from '../../services/workflow-model-choice-evaluator.js'
import { buildWorkflowResultWrapperBody } from '../../workflows/results.js'
import {
  FileSystemSessionStore,
  type TaskRecordCompareAndSetOptions,
} from './session-store.js'
import type { SessionTask } from './session-types.js'
import { admissionReleaseUnlessHeld } from './task-owned-processes.js'
import { resolveExistingPathInside } from '../../core/path-safety.js'
import {
  getRunRuntimePaths,
  resolveAssignmentPath,
  resolveRuntimeAssignmentLocation,
} from '../runtime/runtime-paths.js'
import { createTaskTerminationController } from './task-process-supervisor.js'
import { childReviewRanOutOfRounds } from '../../core/review-exhaustion-evidence.js'

const DEFAULT_LAUNCH_GATE_TIMEOUT_MS = 30_000

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function readBrief(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8')
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function taskAttemptFence(
  task: SessionTask,
  executionAttemptId: string,
): TaskRecordCompareAndSetOptions {
  const admission = task.admission
  return {
    expectedExecutionAttemptId: executionAttemptId,
    ...(admission
      ? {
          expectedAdmissionRequestId: admission.requestId,
          expectedAdmissionPhase: admission.phase,
          ...(admission.phase === 'granted'
            ? {
                expectedAdmissionGrantId: admission.grantId,
                expectedAdmissionOwnerEpoch: admission.ownerEpoch,
              }
            : {}),
        }
      : {}),
  }
}

function triggerTerminalPublicationTestFailpoint(): void {
  const markerPath = process.env.TEAM_RUNTIME_TEST_CRASH_AFTER_WORKFLOW_TERMINAL_MARKER?.trim()
  if (process.env.NODE_ENV !== 'test' || !markerPath) return
  fs.mkdirSync(path.dirname(markerPath), { recursive: true })
  fs.writeFileSync(markerPath, String(process.pid), { flag: 'wx', mode: 0o600 })
  process.kill(process.pid, 'SIGKILL')
}

async function waitForLaunchGate(): Promise<void> {
  const gatePath = process.env.TEAM_RUNTIME_TASK_LAUNCH_GATE_PATH?.trim()
  if (!gatePath) return
  const expectedIdentity = requiredEnv('TEAM_RUNTIME_PROCESS_IDENTITY')
  const timeoutMs = positiveIntegerEnv(
    'TEAM_RUNTIME_TASK_LAUNCH_GATE_TIMEOUT_MS',
    DEFAULT_LAUNCH_GATE_TIMEOUT_MS,
  )
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const identity = (await fs.promises.readFile(gatePath, 'utf8')).trim()
      if (identity !== expectedIdentity) {
        throw new Error('Task launch gate identity does not match the worker')
      }
      await fs.promises.unlink(gatePath).catch(() => undefined)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }

  throw new Error(`Task launch gate was not opened within ${timeoutMs}ms`)
}

function loadRegistries(
  repoRoot: string,
  workflowRegistryPath: string,
  workflowId: string,
  workflowSnapshotPath: string | undefined,
) {
  const teamRegistryResult = parseTeamRegistry(path.join(repoRoot, 'teams.yaml'))
  if (teamRegistryResult.errors.length > 0) {
    throw new Error(teamRegistryResult.errors.join('; '))
  }

  const workflowRegistryResult = parseWorkflowRegistry(workflowRegistryPath)
  if (workflowRegistryResult.errors.length > 0 && !workflowSnapshotPath) {
    throw new Error(workflowRegistryResult.errors.join('; '))
  }

  const workflowRegistry = new Map(
    workflowRegistryResult.entries.map((entry) => [entry.name, entry]),
  )
  if (workflowSnapshotPath) {
    const existing = workflowRegistry.get(workflowId)
    workflowRegistry.set(workflowId, {
      ...existing,
      name: workflowId,
      template_path: workflowSnapshotPath,
    })
  }

  return {
    teamRegistry: new Map(teamRegistryResult.entries.map((entry) => [entry.name, entry])),
    workflowRegistry,
  }
}

function resolveWorkflowSnapshotPath(
  runPath: string | undefined,
  configuredPath: string | undefined,
): string | undefined {
  const value = configuredPath?.trim()
  if (!value) return undefined
  if (!runPath) {
    throw new Error('Workflow snapshot requires an explicit run path')
  }
  const resolved = path.resolve(value)
  const contained = resolveExistingPathInside(runPath, resolved)
  const stat = fs.lstatSync(resolved)
  if (
    !contained ||
    !stat.isFile() ||
    stat.isSymbolicLink()
  ) {
    throw new Error('Workflow snapshot must be a regular file inside the run')
  }
  return contained
}

async function runSessionTask(signal: AbortSignal): Promise<void> {
  // This file is a standalone process entry point. Provider registration in
  // the API or Electron process is not shared with this detached worker.
  initProviders()

  const repoRoot = process.env.TEAM_RUNTIME_REPO_ROOT
    ? path.resolve(process.env.TEAM_RUNTIME_REPO_ROOT)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const workspacePath = requiredEnv('TEAM_RUNTIME_WORKSPACE_PATH')
  // The same startup boundary the composition root uses. Resolved here, before
  // any other work, so a worker launched with a tenant this workspace is not
  // pinned to — or with an unrecognised flag — fails before it can seal a
  // manifest to the wrong identity.
  const executionJournalOptions = await startWorkspaceExecutionJournal({
    workspacePath,
  })
  for (const deprecation of executionJournalOptions.deprecations) {
    logProcessWarning('execution-journal', deprecation)
  }
  const productSessionId = requiredEnv('TEAM_RUNTIME_SESSION_ID')
  const taskId = requiredEnv('TEAM_RUNTIME_TASK_ID')
  const runId = requiredEnv('TEAM_RUNTIME_RUN_ID')
  const workflowId = requiredEnv('TEAM_RUNTIME_WORKFLOW_ID')
  const executionAttemptId = requiredEnv('TEAM_RUNTIME_EXECUTION_ATTEMPT_ID')
  const processIdentity = requiredEnv('TEAM_RUNTIME_PROCESS_IDENTITY')
  if (executionAttemptId !== processIdentity) {
    throw new Error('Execution attempt ID must match the worker process identity')
  }
  const workflowRegistryPath = process.env.TEAM_RUNTIME_WORKFLOWS_REGISTRY_PATH?.trim()
    ? path.resolve(process.env.TEAM_RUNTIME_WORKFLOWS_REGISTRY_PATH)
    : path.join(repoRoot, 'workflows', 'registry.yaml')
  const briefPath = requiredEnv('TEAM_RUNTIME_TASK_BRIEF_PATH')
  const assignmentLocation = process.env.TEAM_RUNTIME_ASSIGNMENT_ID?.trim()
    ? resolveRuntimeAssignmentLocation(workspacePath)
    : undefined
  const assignmentPath = assignmentLocation?.assignmentPath ??
    resolveAssignmentPath(workspacePath, runId)
  const workflowSnapshotPath = resolveWorkflowSnapshotPath(
    assignmentLocation?.runPath,
    process.env.TEAM_RUNTIME_WORKFLOW_SNAPSHOT_PATH,
  )
  const sessionStore = new FileSystemSessionStore(workspacePath)

  await waitForLaunchGate()
  const startupDelayMs = positiveIntegerEnv(
    'TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS',
    0,
  )
  if (startupDelayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, startupDelayMs))
  }

  const reservedTask = await sessionStore.getTaskRecord(productSessionId, taskId)
  if (
    !reservedTask ||
    reservedTask.executionAttemptId !== executionAttemptId ||
    reservedTask.processIdentity !== processIdentity ||
    (reservedTask.admission !== undefined && reservedTask.admission.phase !== 'granted') ||
    (reservedTask.admission?.phase === 'granted' &&
      reservedTask.admission.executionAttemptId !== executionAttemptId)
  ) {
    return
  }
  const attemptFence = taskAttemptFence(reservedTask, executionAttemptId)

  const started = await sessionStore.compareAndSetTaskRecord(
    productSessionId,
    taskId,
    ['queued', 'running'],
    {
      status: 'running',
      assignmentPath,
      runId,
      startedAt: new Date().toISOString(),
      workerStartedAt: new Date().toISOString(),
      recoveryDisposition: undefined,
      recoveryReason: undefined,
    },
    attemptFence,
  )
  if (!started?.updated) return

  /**
   * The admission fields of this root's final status write. The slot is
   * released only once this attempt's descendants are verified gone; while a
   * member cannot be verified the admission stays and the hold is recorded
   * (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md, section 8).
   * It closes the scope of the attempt this worker was launched for, never the
   * task's current one: a newer attempt may have taken the task over, and the
   * fenced write below refuses this worker's status, not its cleanup.
   */
  const releaseUnlessHeld = () => admissionReleaseUnlessHeld(reservedTask, workspacePath, 'root')

  const resultPath = path.join(assignmentPath, `workflow-${workflowId}-result.md`)
  const runtimePaths = getRunRuntimePaths(assignmentPath)
  const resultCandidatePath = path.join(
    runtimePaths.privateRuntimePath,
    'task-results',
    `${executionAttemptId}.md`,
  )
  let pendingResult: {
    body: string
    status: 'completed' | 'completed_with_warnings' | 'blocked' | 'failed'
    artifactRole: 'final' | 'wrapper'
  } | null = null
  const persistPendingResultCandidate = (): void => {
    if (!pendingResult) return
    writeFileAtomicSync(
      resultCandidatePath,
      withArtifactFrontmatter(buildArtifactMetadata({
        // Candidate bytes describe the eventual public artifact. The private
        // staging path must never leak into metadata or artifact events.
        filePath: resultPath,
        rootDir: assignmentPath,
        artifactType: 'result',
        artifactRole: pendingResult.artifactRole,
        sessionId: runId,
        rootSessionId: runId,
        team: `workflow:${workflowId}`,
        status: pendingResult.status,
        title: `Workflow result from ${workflowId}`,
      }), pendingResult.body),
    )
  }

  try {
    fs.mkdirSync(assignmentPath, { recursive: true })
    logSessionStart(assignmentPath, runId, `workflow:${workflowId}`, ['session-task-runner'], runId)
    const brief = readBrief(briefPath)
    const jobRequestPath = path.join(assignmentPath, 'job-request.md')
    writeMarkdownArtifact(
      jobRequestPath,
      [
        '# Job Request',
        '',
        '## Title',
        '',
        `Run ${workflowId}`,
        '',
        '## Intake Summary',
        '',
        brief,
      ].join('\n'),
      buildArtifactMetadata({
        filePath: jobRequestPath,
        rootDir: assignmentPath,
        artifactType: 'brief',
        artifactRole: 'input',
        sessionId: runId,
        rootSessionId: runId,
        team: `workflow:${workflowId}`,
        status: 'queued',
        title: `Run ${workflowId}`,
      }),
    )
    logRuntimeEvent(assignmentPath, {
      timestamp: new Date().toISOString(),
      event: 'session_task.workflow_started',
      session_id: runId,
      root_session_id: runId,
      assignment_path: assignmentPath,
      team: `workflow:${workflowId}`,
      workflow_id: workflowId,
      product_session_id: productSessionId,
      task_id: taskId,
      execution_attempt_id: executionAttemptId,
    })
    if (started.task.runPlanId) {
      await sessionStore.markRunPlanRunningIfQueued(
        productSessionId,
        started.task.runPlanId,
        taskId,
        executionAttemptId,
      )
    }
    if (process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN === '1') {
      pendingResult = {
        body: `# Workflow Result\n\nDry-run task runner completed for ${workflowId}.\n`,
        status: 'completed',
        artifactRole: 'final',
      }
    } else {
      const { teamRegistry, workflowRegistry } = loadRegistries(
        repoRoot,
        workflowRegistryPath,
        workflowId,
        workflowSnapshotPath,
      )
      const workflowEntry = workflowRegistry.get(workflowId)
      if (!workflowEntry) {
        throw new Error(`Unknown workflow: ${workflowId}`)
      }

      // Phase 8 cutover (ADR §9): the worker process resolves this
      // assignment's journal so workflow transitions and capability dispatches
      // share one journal behind one lock. The registry is constructed here
      // rather than in the runner because `workflows/` may not import
      // `services/`, and it decides enrollment from the same flag the
      // dispatcher uses.
      // Always constructed, in every mode: enrollment is decided per
      // assignment inside the registry, and an absent registry is what used to
      // return an enrolled workflow to the legacy authority (ADR §16).
      const journalRegistry = createWorkspaceExecutionJournalRegistry(
        workspacePath,
        executionJournalOptions,
      )
      try {
        const outcome = await runWorkflowOutcome({
          workflowEntry,
          teamRegistry,
          brief,
          workspacePath,
          spawnDepth: 0,
          journalRegistry,
          // What decides whether a failed step earned a model-choice offer.
          // Reads the step's own durable evidence; without it a failed step
          // ends the run exactly as it did before.
          modelChoiceEvaluator: createWorkflowModelChoiceEvaluator(),
          rootSessionId: runId,
          parentSessionId: runId,
          ...whenDefined(assignmentLocation, (definedValue) => ({ assignmentLocation: definedValue })),
          taskId,
          productSessionId,
          executionAttemptId,
          persistenceMode: 'required',
          recoveryMode: process.env.TEAM_RUNTIME_RECOVERY === '1',
          continuationMode: process.env.TEAM_RUNTIME_CONTINUATION === '1',
          ...(reservedTask.targetKind === 'team-chat'
            ? { executionMode: 'team-chat' as const }
            : {}),
          ...whenDefined(process.env.TEAM_RUNTIME_CONTINUATION_ADMISSION_REQUEST_ID, (definedValue) => ({ continuationAdmissionRequestId: definedValue })),
          signal,
        })
        if (outcome.kind === 'awaiting_input' || outcome.kind === 'awaiting_agent_input') {
          const waitingAt = new Date().toISOString()
          const waiting = await sessionStore.compareAndSetTaskRecord(
            productSessionId,
            taskId,
            ['queued', 'running'],
            {
              status: 'awaiting_input',
              ...await releaseUnlessHeld(),
              error: undefined,
            },
            attemptFence,
          )
          if (waiting?.updated) {
            logRuntimeEvent(assignmentPath, {
              timestamp: waitingAt,
              event: 'run.awaiting_input',
              session_id: runId,
              root_session_id: runId,
              assignment_path: assignmentPath,
              team: `workflow:${workflowId}`,
              workflow_id: workflowId,
              task_id: taskId,
              interaction_id: outcome.interaction.interactionId,
              step_id: outcome.interaction.stepId,
              ...(outcome.kind === 'awaiting_input' ? { source_artifact: outcome.interaction.sourceArtifact } : {}),
            })
            logRuntimeEvent(assignmentPath, {
              timestamp: waitingAt,
              event: outcome.kind === 'awaiting_agent_input' ? 'workflow.agent_question.requested' : 'workflow.human_input.requested',
              session_id: runId,
              root_session_id: runId,
              assignment_path: assignmentPath,
              team: `workflow:${workflowId}`,
              workflow_id: workflowId,
              task_id: taskId,
              interaction_id: outcome.interaction.interactionId,
              step_id: outcome.interaction.stepId,
              ...(outcome.kind === 'awaiting_input' ? { recipients: outcome.interaction.eligibleRecipients } : {}),
            })
          }
          return
        }
        if (outcome.kind === 'awaiting_model_choice') {
          // A wait, not a failure. Committed predecessor work stays committed
          // and the worker slot is released, so nothing holds capacity while a
          // person is not there to decide.
          const waitingAt = new Date().toISOString()
          const waiting = await sessionStore.compareAndSetTaskRecord(
            productSessionId,
            taskId,
            ['queued', 'running'],
            {
              status: 'awaiting_model_choice',
              ...await releaseUnlessHeld(),
              error: undefined,
            },
            attemptFence,
          )
          if (waiting?.updated) {
            logRuntimeEvent(assignmentPath, {
              timestamp: waitingAt,
              event: 'run.awaiting_model_choice',
              session_id: runId,
              root_session_id: runId,
              assignment_path: assignmentPath,
              team: `workflow:${workflowId}`,
              workflow_id: workflowId,
              task_id: taskId,
              step_id: outcome.stepId,
              offer_id: outcome.offer.offerId,
              agent_name: outcome.offer.agentName,
              // The pair the user will be shown, recorded so the run can say
              // what it waits on without re-deriving it from settings that may
              // have moved since.
              requested_provider: outcome.offer.failedChoice.provider,
              requested_model: outcome.offer.failedChoice.model,
              proposed_provider: outcome.offer.proposedDefault.provider,
              proposed_model: outcome.offer.proposedDefault.model,
            })
          }
          return
        }

        const result = outcome.result
        // Test-only crash point: the terminal workflow journal exists, while no
        // root candidate or task terminal CAS has happened yet.
        triggerTerminalPublicationTestFailpoint()

        pendingResult = {
          body: buildWorkflowResultWrapperBody(result),
          status: result.status,
          artifactRole: 'wrapper',
        }

        if (result.status === 'blocked') {
          const completedAt = new Date().toISOString()
          persistPendingResultCandidate()
          const blocked = await sessionStore.compareAndSetTaskRecord(
            productSessionId,
            taskId,
            ['queued', 'running'],
            {
              status: 'blocked',
              ...await releaseUnlessHeld(),
              completedAt,
              error: result.summary,
            },
            attemptFence,
          )
          if (blocked?.updated) {
            // A named cause, read from the child's own review log rather than
            // from the summary. The chat writes its own sentence from this
            // name; the summary itself is never shown, because it can carry a
            // child's stderr, an absolute path or a token.
            const blockedCause = result.steps.some(
              (step) =>
                step.status === 'blocked' &&
                childReviewRanOutOfRounds(step.assignmentPath),
            )
              ? 'review_exhausted'
              : undefined
            logRuntimeEvent(assignmentPath, {
              timestamp: completedAt,
              event: 'run.blocked',
              session_id: runId,
              root_session_id: runId,
              assignment_path: assignmentPath,
              team: `workflow:${workflowId}`,
              error: result.summary,
              ...(blockedCause ? { blocked_cause: blockedCause } : {}),
            })
            process.exitCode = 2
          }
          return
        }

        if (result.status === 'failed') {
          throw new Error(result.summary)
        }
      } finally {
        // Every exit from this branch — normal completion, an early
        // return, or a throw — releases the journal handles and the
        // per-scope locks this registry opened. Without it they were
        // released only by process exit, which on a `process.exit(1)`
        // path drops work still queued for the durability barrier.
        await journalRegistry.close()
      }
    }

    const completedAt = new Date().toISOString()
    persistPendingResultCandidate()
    const completed = await sessionStore.compareAndSetTaskRecord(
      productSessionId,
      taskId,
      ['queued', 'running'],
      {
        status: 'done',
        ...await releaseUnlessHeld(),
        completedAt,
      },
      attemptFence,
    )
    if (completed?.updated) {
      logRuntimeEvent(assignmentPath, {
        timestamp: completedAt,
        event: 'run.completed',
        session_id: runId,
        root_session_id: runId,
        assignment_path: assignmentPath,
        team: `workflow:${workflowId}`,
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const completedAt = new Date().toISOString()
    if (pendingResult) {
      pendingResult.status = 'failed'
      persistPendingResultCandidate()
    }
    const failed = await sessionStore.compareAndSetTaskRecord(
      productSessionId,
      taskId,
      ['queued', 'running'],
      {
        status: 'failed',
        ...await releaseUnlessHeld(),
        completedAt,
        error: message,
      },
      attemptFence,
    )
    if (failed?.updated) {
      logRuntimeEvent(assignmentPath, {
        timestamp: completedAt,
        event: 'run.failed',
        session_id: runId,
        root_session_id: runId,
        assignment_path: assignmentPath,
        team: `workflow:${workflowId}`,
        error: message,
      })
      process.exitCode = 1
    }
  }
}

async function main(): Promise<void> {
  const termination = createTaskTerminationController()
  try {
    await runSessionTask(termination.signal)
  } finally {
    termination.dispose()
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
