import * as fs from 'node:fs/promises'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import * as path from 'node:path'

import {
  parsePlan,
  validatePlanFormat,
  type PlanState,
  type TaskStatus as PlanTaskStatus,
} from '../parsers/plan-parser.js'
import {
  FileSystemWorkflowStateStore,
  type WorkflowExecutionSnapshot,
} from '../workflows/workflow-state-store.js'
import {
  DEEP_RESEARCH_JOURNEY_VERSION,
  DEEP_RESEARCH_WORKFLOW_ID,
  type DeepResearchJourneyArtifact,
  type DeepResearchJourneyArtifactKind,
  type DeepResearchJourneyEscalation,
  type DeepResearchJourneyPhase,
  type DeepResearchJourneyResearch,
  type DeepResearchJourneyResearchStatus,
  type DeepResearchJourneySnapshot,
  type DeepResearchJourneyWorker,
  type DeepResearchJourneyWorkerStatus,
  type DeepResearchJourneyWorkflow,
} from '../contracts/deep-research-journey.js'
import type { QualityVerdict, ResearchPlan } from '../contracts/deep-research.js'
import type { RunPlan } from '../contracts/run-plan.js'
import type { SessionTask } from '../contracts/sessions.js'
import type { DurableWorkflowStepStatus } from '../contracts/workflows.js'
import { assertResearchPlanApproved } from '../domains/deep-research/deep-research-approval.js'
import { parseQualityVerdict } from '../domains/deep-research/deep-research-validation.js'
import { parseDeepResearchEvidenceResult } from '../domains/deep-research/deep-research-pipeline-adapter.js'
import { hashResearchValue } from '../domains/deep-research/deep-research-worker-policy.js'
import { buildSessionRunAssignmentLocation } from '../domains/run/run-location.js'
import {
  getRunRuntimePaths,
  resolveOwnedRunRelativePath,
} from '../domains/runtime/runtime-paths.js'

export * from '../contracts/deep-research-journey.js'

export interface BuildDeepResearchJourneySnapshotInput {
  readonly workspacePath: string
  readonly task: SessionTask
  readonly runPlan: RunPlan | null
}

interface ProjectionContext {
  integrity: 'complete' | 'partial'
}

interface OwnedFileResult {
  readonly state: 'missing' | 'available' | 'invalid'
  readonly text?: string
}

interface ResearchArtifactsState {
  readonly hasSynthesis: boolean
  readonly hasQualityPacket: boolean
  readonly hasResearchReport: boolean
  readonly hasSectionDraftPlan: boolean
  readonly completedEvidenceWaves: ReadonlyMap<string, 0 | 1 | 2>
}

interface CorrectionProjection {
  readonly wave: 1 | 2
  readonly sourceVerdict: QualityVerdict
}

interface ExecutablePlanProjection {
  readonly plan: PlanState | null
  readonly runtimeUpdatedAt?: string
}

interface PrivateRuntimePlanFile {
  readonly state: 'missing' | 'available' | 'invalid'
  readonly filePath?: string
  readonly updatedAt?: string
}

interface CanonicalRootLocation {
  readonly assignmentPath: string
  readonly runPath: string
}

const MAX_JSON_ARTIFACT_BYTES = 2 * 1024 * 1024
const ESCALATION_PATH = 'research/quality/escalation.md' as const

export async function buildDeepResearchJourneySnapshot(
  input: BuildDeepResearchJourneySnapshotInput,
): Promise<DeepResearchJourneySnapshot> {
  if (input.task.workflowId !== DEEP_RESEARCH_WORKFLOW_ID) {
    throw new Error('Deep Research journey requires a Deep Research task.')
  }

  const context: ProjectionContext = { integrity: 'complete' }
  const rootLocation = canonicalRootLocation(input, context)
  const taskRunPlan = await resolveTaskRunPlan(
    input.task,
    input.runPlan,
    rootLocation?.runPath ?? null,
    context,
  )
  const plan = validatedApprovedPlan(input.task, taskRunPlan, context)
  const workflowSnapshot = rootLocation
    ? await loadWorkflowSnapshot(rootLocation.assignmentPath, input.task, context)
    : null
  const workflow = projectWorkflow(workflowSnapshot)
  const researchStep = workflowSnapshot?.state.steps.find((step) => step.stepId === 'research')
  const researchAssignmentPath = researchStep
    ? canonicalChildAssignmentPath(input, researchStep.childRunId, context)
    : null

  let executablePlan: PlanState | null = null
  let executablePlanUpdatedAt: string | undefined
  let currentQualityVerdict: QualityVerdict | null = null
  let correctionProjection: CorrectionProjection | null = null
  let researchArtifactsState: ResearchArtifactsState = {
    hasSynthesis: false,
    hasQualityPacket: false,
    hasResearchReport: false,
    hasSectionDraftPlan: false,
    completedEvidenceWaves: new Map(),
  }
  let approvedArtifactMatches = false

  if (researchAssignmentPath && plan) {
    const artifactPlan = await readJsonArtifact(
      researchAssignmentPath,
      'research/approved-plan.json',
      context,
    )
    if (artifactPlan !== null) {
      try {
        const approvedArtifactPlan = assertResearchPlanApproved(artifactPlan)
        approvedArtifactMatches =
          approvedArtifactPlan.planId === plan.planId &&
          approvedArtifactPlan.approvalHash === plan.approvalHash
        if (!approvedArtifactMatches) context.integrity = 'partial'
      } catch {
        context.integrity = 'partial'
      }
    }

    const executablePlanProjection = await readExecutablePlan(
      researchAssignmentPath,
      plan,
      context,
    )
    executablePlan = executablePlanProjection.plan
    executablePlanUpdatedAt = executablePlanProjection.runtimeUpdatedAt
    researchArtifactsState = await inspectResearchArtifacts(
      researchAssignmentPath,
      plan,
      context,
    )
    if (approvedArtifactMatches) {
      currentQualityVerdict = await readQualityVerdict(
        researchAssignmentPath,
        plan,
        context,
      )
      correctionProjection = await readCorrectionProjection(
        researchAssignmentPath,
        plan,
        context,
      )
    }
  }

  const qualityVerdict = currentQualityVerdict ?? correctionProjection?.sourceVerdict ?? null

  const artifacts = await collectArtifacts({
    input,
    context,
    workflowSnapshot,
    researchAssignmentPath,
    plan,
  })
  const escalation = await projectEscalation({
    input,
    context,
    workflowSnapshot,
    researchAssignmentPath,
    qualityVerdict: currentQualityVerdict,
  })
  const correctionWave = deriveCorrectionWave(
    executablePlan,
    currentQualityVerdict,
    correctionProjection?.wave,
  )
  const researchBlock = deriveResearchBlock({
    researchStep,
    qualityVerdict: currentQualityVerdict,
    executablePlan,
  })
  const research = plan
    ? {
        status: deriveResearchStatus({
          escalated: escalation !== null,
          researchStepStatus: researchStep?.status,
          qualityVerdict: currentQualityVerdict,
          executablePlan,
          artifacts: researchArtifactsState,
        }),
        correctionWave,
        workers: projectWorkers(
          plan,
          executablePlan,
          researchArtifactsState.completedEvidenceWaves,
        ),
        block: researchBlock,
      } satisfies DeepResearchJourneyResearch
    : null
  const visibleArtifacts = escalation
    ? artifacts
    : artifacts.filter((artifact) => artifact.kind !== 'escalation')

  return {
    version: DEEP_RESEARCH_JOURNEY_VERSION,
    sessionId: input.task.sessionId,
    taskId: input.task.id,
    workflowId: DEEP_RESEARCH_WORKFLOW_ID,
    taskStatus: input.task.status,
    phase: derivePhase({
      plan,
      workflowSnapshot,
      escalation,
    }),
    updatedAt: latestTimestamp([
      input.task.updatedAt,
      input.task.completedAt,
      workflowSnapshot?.state.updatedAt,
      taskRunPlan?.updatedAt,
      taskRunPlan?.createdAt,
      qualityVerdict?.reviewedAt,
      executablePlanUpdatedAt,
      input.task.createdAt,
    ]),
    integrity: context.integrity,
    workflow,
    plan,
    research,
    quality: qualityVerdict
      ? {
          decision: qualityVerdict.decision,
          ...(qualityVerdict.correctionRoute === undefined
            ? {}
            : { correctionRoute: qualityVerdict.correctionRoute }),
          correctionWave: qualityVerdict.correctionWave,
          reviewedAt: qualityVerdict.reviewedAt,
          findings: qualityVerdict.findings,
          correctionRequests: qualityVerdict.correctionRequests,
        }
      : null,
    escalation,
    artifacts: visibleArtifacts,
  }
}

function validatedApprovedPlan(
  task: SessionTask,
  runPlan: RunPlan | null,
  context: ProjectionContext,
): ResearchPlan | null {
  if (
    !runPlan ||
    runPlan.id !== task.runPlanId ||
    runPlan.selectedWorkflow?.id !== DEEP_RESEARCH_WORKFLOW_ID ||
    !runPlan.researchPlan
  ) {
    return null
  }
  try {
    return assertResearchPlanApproved(runPlan.researchPlan)
  } catch {
    context.integrity = 'partial'
    return null
  }
}

function canonicalRootLocation(
  input: BuildDeepResearchJourneySnapshotInput,
  context: ProjectionContext,
): CanonicalRootLocation | null {
  const assignmentId = input.task.assignmentId ?? input.task.runId
  const location = buildSessionRunAssignmentLocation(input.workspacePath, {
    sessionId: input.task.sessionId,
    runId: input.task.runId,
    assignmentId,
  })
  if (!location || assignmentId !== input.task.runId) {
    context.integrity = 'partial'
    return null
  }
  if (
    (input.task.assignmentPath &&
      path.resolve(input.task.assignmentPath) !== path.resolve(location.assignmentPath)) ||
    (input.task.runPath &&
      path.resolve(input.task.runPath) !== path.resolve(location.runPath))
  ) {
    context.integrity = 'partial'
    return null
  }
  if (
    ownedDirectoryState(location.runPath, input.workspacePath) !== 'available' ||
    ownedDirectoryState(location.assignmentPath, input.workspacePath) !== 'available'
  ) {
    context.integrity = 'partial'
    return null
  }
  return {
    assignmentPath: location.assignmentPath,
    runPath: location.runPath,
  }
}

async function resolveTaskRunPlan(
  task: SessionTask,
  currentRunPlan: RunPlan | null,
  runPath: string | null,
  context: ProjectionContext,
): Promise<RunPlan | null> {
  if (runPlanMatchesTask(currentRunPlan, task)) return currentRunPlan
  if (!runPath) return null
  const snapshotPath = path.join(runPath, 'run-plan.json')
  try {
    const stat = await fs.lstat(snapshotPath)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > MAX_JSON_ARTIFACT_BYTES
    ) {
      context.integrity = 'partial'
      return null
    }
    const value = JSON.parse(await fs.readFile(snapshotPath, 'utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      context.integrity = 'partial'
      return null
    }
    const runPlan = value as RunPlan
    if (!runPlanMatchesTask(runPlan, task)) {
      context.integrity = 'partial'
      return null
    }
    return runPlan
  } catch {
    context.integrity = 'partial'
    return null
  }
}

function runPlanMatchesTask(
  runPlan: RunPlan | null,
  task: SessionTask,
): runPlan is RunPlan {
  return Boolean(
    runPlan &&
      typeof runPlan.id === 'string' &&
      runPlan.id === task.runPlanId &&
      runPlan.selectedWorkflow?.id === DEEP_RESEARCH_WORKFLOW_ID,
  )
}

function canonicalChildAssignmentPath(
  input: BuildDeepResearchJourneySnapshotInput,
  childRunId: string,
  context: ProjectionContext,
): string | null {
  const location = buildSessionRunAssignmentLocation(input.workspacePath, {
    sessionId: input.task.sessionId,
    runId: input.task.runId,
    assignmentId: childRunId,
  })
  if (!location) {
    context.integrity = 'partial'
    return null
  }
  const directoryState = ownedDirectoryState(
    location.assignmentPath,
    input.workspacePath,
  )
  if (directoryState === 'missing') return null
  if (directoryState === 'invalid') {
    context.integrity = 'partial'
    return null
  }
  return location.assignmentPath
}

function ownedDirectoryState(
  directoryPath: string,
  workspacePath: string,
): 'available' | 'missing' | 'invalid' {
  try {
    const stat = lstatSync(directoryPath)
    const relativePath = path.relative(
      path.resolve(workspacePath),
      path.resolve(directoryPath),
    )
    if (
      !relativePath ||
      relativePath === '..' ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      return 'invalid'
    }
    const expectedRealPath = path.resolve(
      realpathSync(workspacePath),
      relativePath,
    )
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      realpathSync(directoryPath) === expectedRealPath
    )
      ? 'available'
      : 'invalid'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'missing'
      : 'invalid'
  }
}

async function loadWorkflowSnapshot(
  rootAssignmentPath: string,
  task: SessionTask,
  context: ProjectionContext,
): Promise<WorkflowExecutionSnapshot | null> {
  try {
    const snapshot = await new FileSystemWorkflowStateStore(rootAssignmentPath).load()
    if (!snapshot) return null
    if (
      snapshot.manifest.taskId !== task.id ||
      snapshot.manifest.sessionId !== task.sessionId ||
      snapshot.manifest.rootRunId !== task.runId ||
      snapshot.manifest.workflowId !== DEEP_RESEARCH_WORKFLOW_ID
    ) {
      context.integrity = 'partial'
      return null
    }
    return snapshot
  } catch {
    context.integrity = 'partial'
    return null
  }
}

function projectWorkflow(
  snapshot: WorkflowExecutionSnapshot | null,
): DeepResearchJourneyWorkflow {
  if (!snapshot) {
    return {
      status: 'not_started',
      revision: null,
      currentStepId: null,
      steps: [],
    }
  }
  const steps = snapshot.state.steps.flatMap((step) =>
    isJourneyStepId(step.stepId)
      ? [{ id: step.stepId, status: step.status, runId: step.childRunId }]
      : [],
  )
  return {
    status: snapshot.state.status,
    revision: snapshot.state.revision,
    currentStepId: isJourneyStepId(snapshot.state.currentStepId)
      ? snapshot.state.currentStepId
      : null,
    steps,
  }
}

async function readExecutablePlan(
  assignmentPath: string,
  approvedPlan: ResearchPlan,
  context: ProjectionContext,
): Promise<ExecutablePlanProjection> {
  const file = await readOwnedFile(
    assignmentPath,
    'research/plan.md',
    MAX_JSON_ARTIFACT_BYTES,
  )
  if (file.state === 'missing') return { plan: null }
  if (file.state === 'invalid') {
    context.integrity = 'partial'
    return { plan: null }
  }

  let sourcePlan: PlanState | null
  let planPath: string
  try {
    planPath = resolveOwnedRunRelativePath({
      assignmentPath,
      relativePath: 'research/plan.md',
      label: 'Deep Research executable plan',
    })
    sourcePlan = parsePlan(planPath)
  } catch {
    context.integrity = 'partial'
    return { plan: null }
  }
  if (
    !sourcePlan ||
    !executablePlanHasCanonicalStatuses(planPath) ||
    !executablePlanMatchesApprovedPlan(sourcePlan, approvedPlan)
  ) {
    context.integrity = 'partial'
    return { plan: null }
  }

  const runtimeFile = await inspectPrivateRuntimePlan(assignmentPath)
  if (runtimeFile.state === 'missing') return { plan: sourcePlan }
  if (
    runtimeFile.state === 'invalid' ||
    !runtimeFile.filePath ||
    !runtimeFile.updatedAt
  ) {
    context.integrity = 'partial'
    return { plan: sourcePlan }
  }

  const runtimePlan = parsePlan(runtimeFile.filePath)
  if (
    !runtimePlan ||
    !executablePlanHasCanonicalStatuses(runtimeFile.filePath) ||
    !executablePlanMatchesApprovedPlan(runtimePlan, approvedPlan) ||
    !plansShareExecutionIdentity(sourcePlan, runtimePlan)
  ) {
    context.integrity = 'partial'
    return { plan: sourcePlan }
  }

  return {
    plan: runtimePlan,
    runtimeUpdatedAt: runtimeFile.updatedAt,
  }
}

function executablePlanHasCanonicalStatuses(filePath: string): boolean {
  const validation = validatePlanFormat(filePath)
  if (!validation.valid) return false
  try {
    const content = readFileSync(filePath, 'utf8')
    if (/^\|\s*T\d+\s*\|\s*(?:pending|in_progress|completed|validated|failed|blocked|skipped)\s*\|/m.test(content)) {
      return false
    }
    const planStatuses = [...content.matchAll(/^\*\*Status:\*\*\s*(\S+)\s*$/gm)]
    const planStatus = planStatuses[0]?.[1]
    if (
      planStatuses.length !== 1 ||
      planStatus === undefined ||
      !['draft', 'executing', 'completed', 'failed'].includes(planStatus)
    ) {
      return false
    }

    const taskStatusCounts = new Map<string, number>()
    let currentTaskId: string | null = null
    for (const line of content.split('\n')) {
      const taskMatch = line.match(/^#### (T\d+):\s*.+/)
      if (taskMatch) {
        const taskId = taskMatch[1]
        if (taskId === undefined || taskStatusCounts.has(taskId)) return false
        taskStatusCounts.set(taskId, 0)
        currentTaskId = taskId
        continue
      }
      if (/^#{2,4}\s/.test(line)) currentTaskId = null
      if (currentTaskId && /^- \*\*Status:\*\*\s*\S+\s*$/.test(line)) {
        const statusCount = taskStatusCounts.get(currentTaskId)
        if (statusCount === undefined) return false
        taskStatusCounts.set(currentTaskId, statusCount + 1)
      }
    }
    return taskStatusCounts.size > 0 &&
      [...taskStatusCounts.values()].every((count) => count === 1)
  } catch {
    return false
  }
}

function executablePlanMatchesApprovedPlan(
  executablePlan: PlanState,
  approvedPlan: ResearchPlan,
): boolean {
  const approvedTasks = new Map(approvedPlan.tasks.map((task) => [task.id, task]))
  const workerSpecs = new Map(approvedPlan.workerSpecs.map((spec) => [spec.id, spec]))
  return [...executablePlan.tasks.values()].every((task) => {
    const approvedTask = approvedTasks.get(task.id)
    const workerSpec = approvedTask
      ? workerSpecs.get(approvedTask.workerSpecId)
      : undefined
    return Boolean(
      approvedTask &&
      workerSpec &&
      task.title === approvedTask.title &&
      task.agent === workerSpec.baseAgent &&
      new RegExp(`^research/evidence/wave-[012]/${escapeRegExp(task.id)}\\.json$`).test(task.resultFile),
    )
  })
}

async function inspectPrivateRuntimePlan(
  assignmentPath: string,
): Promise<PrivateRuntimePlanFile> {
  let privateRuntimePath: string
  try {
    privateRuntimePath = getRunRuntimePaths(assignmentPath).privateRuntimePath
  } catch {
    return { state: 'invalid' }
  }

  const segments = ['pipeline', 'collect-evidence', 'plan.md'] as const
  const filePath = path.join(privateRuntimePath, ...segments)
  let currentPath = privateRuntimePath
  try {
    const realAssignmentPath = await fs.realpath(assignmentPath)
    const pathsToInspect = [
      privateRuntimePath,
      ...segments.map((segment) => {
        currentPath = path.join(currentPath, segment)
        return currentPath
      }),
    ]

    for (const [index, candidatePath] of pathsToInspect.entries()) {
      const stat = await fs.lstat(candidatePath)
      const isPlanFile = index === pathsToInspect.length - 1
      if (
        stat.isSymbolicLink() ||
        (isPlanFile
          ? !stat.isFile() || stat.size > MAX_JSON_ARTIFACT_BYTES
          : !stat.isDirectory())
      ) {
        return { state: 'invalid' }
      }

      const realCandidatePath = await fs.realpath(candidatePath)
      const relativePath = path.relative(realAssignmentPath, realCandidatePath)
      if (
        !relativePath ||
        relativePath === '..' ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        return { state: 'invalid' }
      }

      if (isPlanFile) {
        return {
          state: 'available',
          filePath,
          updatedAt: stat.mtime.toISOString(),
        }
      }
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'missing' }
      : { state: 'invalid' }
  }

  return { state: 'invalid' }
}

function plansShareExecutionIdentity(
  sourcePlan: PlanState,
  runtimePlan: PlanState,
): boolean {
  if (
    sourcePlan.title !== runtimePlan.title ||
    sourcePlan.tasks.size !== runtimePlan.tasks.size ||
    sourcePlan.sprints.length !== runtimePlan.sprints.length
  ) {
    return false
  }

  for (const sourceTask of sourcePlan.tasks.values()) {
    const runtimeTask = runtimePlan.tasks.get(sourceTask.id)
    if (
      !runtimeTask ||
      sourceTask.title !== runtimeTask.title ||
      sourceTask.agent !== runtimeTask.agent ||
      sourceTask.validate !== runtimeTask.validate ||
      sourceTask.gate !== runtimeTask.gate ||
      sourceTask.resultFile !== runtimeTask.resultFile ||
      sourceTask.sprintId !== runtimeTask.sprintId ||
      !sameOrderedValues(sourceTask.dependsOn, runtimeTask.dependsOn)
    ) {
      return false
    }
  }

  return sourcePlan.sprints.every((sourceSprint, index) => {
    const runtimeSprint = runtimePlan.sprints[index]
    return Boolean(
      runtimeSprint &&
      sourceSprint.id === runtimeSprint.id &&
      sourceSprint.name === runtimeSprint.name &&
      sourceSprint.gateTaskId === runtimeSprint.gateTaskId &&
      sameOrderedValues(sourceSprint.taskIds, runtimeSprint.taskIds),
    )
  })
}

function sameOrderedValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index])
}

async function readQualityVerdict(
  assignmentPath: string,
  plan: ResearchPlan,
  context: ProjectionContext,
): Promise<QualityVerdict | null> {
  const value = await readJsonArtifact(
    assignmentPath,
    'research/quality/current-verdict.json',
    context,
  )
  if (value === null) return null
  try {
    const verdict = parseQualityVerdict(value)
    if (!verdictReferencesPlan(verdict, plan)) {
      context.integrity = 'partial'
      return null
    }
    return verdict
  } catch {
    context.integrity = 'partial'
    return null
  }
}

async function readCorrectionProjection(
  assignmentPath: string,
  plan: ResearchPlan,
  context: ProjectionContext,
): Promise<CorrectionProjection | null> {
  const value = await readJsonArtifact(
    assignmentPath,
    'research/corrections/current.json',
    context,
  )
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    context.integrity = 'partial'
    return null
  }
  const correction = value as Record<string, unknown>
  const wave = correction.wave
  const sourceVerdictPath = correction.sourceVerdictPath
  const sourceVerdictHash = correction.sourceVerdictHash
  if (
    correction.schemaVersion !== 1 ||
    (wave !== 1 && wave !== 2) ||
    correction.approvedPlanHash !== plan.approvalHash ||
    sourceVerdictPath !== `research/quality/verdict-wave-${wave - 1}.json` ||
    typeof sourceVerdictHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sourceVerdictHash)
  ) {
    context.integrity = 'partial'
    return null
  }
  const sourceValue = await readJsonArtifact(
    assignmentPath,
    sourceVerdictPath,
    context,
  )
  if (sourceValue === null) {
    context.integrity = 'partial'
    return null
  }
  try {
    const sourceVerdict = parseQualityVerdict(sourceValue)
    if (
      sourceVerdict.decision !== 'REVISE' ||
      sourceVerdict.correctionWave !== wave - 1 ||
      hashResearchValue(sourceVerdict) !== sourceVerdictHash ||
      !verdictReferencesPlan(sourceVerdict, plan)
    ) {
      context.integrity = 'partial'
      return null
    }
    return { wave, sourceVerdict }
  } catch {
    context.integrity = 'partial'
    return null
  }
}

function verdictReferencesPlan(
  verdict: QualityVerdict,
  plan: ResearchPlan,
): boolean {
  const taskIds = new Set(plan.tasks.map((task) => task.id))
  const sectionIds = new Set(plan.sections.map((section) => section.id))
  return [...verdict.findings, ...verdict.correctionRequests].every((item) =>
    item.taskIds.every((id) => taskIds.has(id)) &&
    item.sectionIds.every((id) => sectionIds.has(id)),
  )
}

async function inspectResearchArtifacts(
  assignmentPath: string,
  plan: ResearchPlan,
  context: ProjectionContext,
): Promise<ResearchArtifactsState> {
  const [
    synthesis,
    qualityPacket,
    researchReport,
    sectionDraftPlan,
    completedEvidenceWaves,
  ] = await Promise.all([
    inspectOwnedFile(assignmentPath, 'research/synthesis/current.json'),
    inspectOwnedFile(assignmentPath, 'research/quality/current-packet.json'),
    inspectOwnedFile(assignmentPath, 'research-package.md'),
    inspectOwnedFile(assignmentPath, 'research/section-plan.md'),
    readCompletedEvidenceWaves(assignmentPath, plan, context),
  ])
  if (
    synthesis.state === 'invalid' ||
    qualityPacket.state === 'invalid' ||
    researchReport.state === 'invalid' ||
    sectionDraftPlan.state === 'invalid'
  ) {
    context.integrity = 'partial'
  }
  return {
    hasSynthesis: synthesis.state === 'available',
    hasQualityPacket: qualityPacket.state === 'available',
    hasResearchReport: researchReport.state === 'available',
    hasSectionDraftPlan: sectionDraftPlan.state === 'available',
    completedEvidenceWaves,
  }
}

async function readCompletedEvidenceWaves(
  assignmentPath: string,
  plan: ResearchPlan,
  context: ProjectionContext,
): Promise<ReadonlyMap<string, 0 | 1 | 2>> {
  const value = await readJsonArtifact(
    assignmentPath,
    'research/evidence/current-manifest.json',
    context,
  )
  if (value === null) return new Map()
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    context.integrity = 'partial'
    return new Map()
  }
  const manifest = value as Record<string, unknown>
  if (
    manifest.schemaVersion !== 1 ||
    ![0, 1, 2].includes(manifest.correctionWave as number) ||
    !manifest.latestByTask ||
    typeof manifest.latestByTask !== 'object' ||
    Array.isArray(manifest.latestByTask)
  ) {
    context.integrity = 'partial'
    return new Map()
  }

  const approvedTaskIds = new Set(plan.tasks.map((task) => task.id))
  const approvedTasks = new Map(plan.tasks.map((task) => [task.id, task]))
  const workerSpecs = new Map(plan.workerSpecs.map((spec) => [spec.id, spec]))
  const manifestWave = manifest.correctionWave as 0 | 1 | 2
  const waves = new Map<string, 0 | 1 | 2>()
  for (const [taskId, relativePath] of Object.entries(
    manifest.latestByTask as Record<string, unknown>,
  )) {
    if (!approvedTaskIds.has(taskId) || typeof relativePath !== 'string') {
      context.integrity = 'partial'
      return new Map()
    }
    const waveMatch = relativePath.match(
      new RegExp(`^research/evidence/wave-([012])/${escapeRegExp(taskId)}\\.json$`),
    )
    if (!waveMatch) {
      context.integrity = 'partial'
      return new Map()
    }
    const evidenceWave = Number(waveMatch[1]) as 0 | 1 | 2
    if (evidenceWave > manifestWave) {
      context.integrity = 'partial'
      return new Map()
    }
    const packet = await readJsonArtifact(assignmentPath, relativePath, context)
    try {
      const approvedTask = approvedTasks.get(taskId)
      const workerSpec = approvedTask
        ? workerSpecs.get(approvedTask.workerSpecId)
        : undefined
      if (!approvedTask || !workerSpec || packet === null) {
        throw new Error('Evidence packet identity mismatch.')
      }
      const validatedPacket = parseDeepResearchEvidenceResult({
        text: JSON.stringify(packet),
        taskId,
        sectionId: approvedTask.sectionId,
        assignmentId: workerSpec.laneId,
        workerSpecHash: hashResearchValue(workerSpec),
        assignmentPath,
      })
      if (validatedPacket.question !== approvedTask.question) {
        throw new Error('Evidence packet question mismatch.')
      }
    } catch {
      context.integrity = 'partial'
      return new Map()
    }
    waves.set(taskId, evidenceWave)
  }
  return waves
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function deriveCorrectionWave(
  executablePlan: PlanState | null,
  verdict: QualityVerdict | null,
  activeCorrectionWave?: 1 | 2,
): 0 | 1 | 2 {
  let wave: 0 | 1 | 2 = Math.max(
    verdict?.correctionWave ?? 0,
    activeCorrectionWave ?? 0,
  ) as 0 | 1 | 2
  for (const task of executablePlan?.tasks.values() ?? []) {
    const match = task.resultFile.match(/^research\/evidence\/wave-([012])\//)
    if (match) wave = Math.max(wave, Number(match[1])) as 0 | 1 | 2
  }
  return wave
}

function projectWorkers(
  plan: ResearchPlan,
  executablePlan: PlanState | null,
  completedEvidenceWaves: ReadonlyMap<string, 0 | 1 | 2>,
): DeepResearchJourneyWorker[] {
  const workerSpecs = new Map(plan.workerSpecs.map((spec) => [spec.id, spec]))
  return plan.tasks.map((task) => {
    const workerSpec = workerSpecs.get(task.workerSpecId)
    if (!workerSpec) {
      throw new Error(
        `Research task '${task.id}' references unknown worker spec '${task.workerSpecId}'.`,
      )
    }
    const executableTask = executablePlan?.tasks.get(task.id)
    const waveMatch = executableTask?.resultFile.match(
      /^research\/evidence\/wave-([012])\//,
    )
    const retainedWave = completedEvidenceWaves.get(task.id)
    return {
      taskId: task.id,
      displayRole: workerSpec.displayRole,
      status: executableTask
        ? projectWorkerStatus(executableTask.status)
        : retainedWave === undefined
          ? 'pending'
          : 'completed',
      attempt: executableTask
        ? Number(waveMatch?.[1] ?? 0) + 1
        : Number(retainedWave ?? 0) + 1,
    }
  })
}

function projectWorkerStatus(
  status: PlanTaskStatus | undefined,
): DeepResearchJourneyWorkerStatus {
  switch (status) {
    case 'in_progress':
      return 'running'
    case 'completed':
    case 'validated':
      return 'completed'
    case 'failed':
    case 'blocked':
    case 'skipped':
      return status
    case 'pending':
    default:
      return 'pending'
  }
}

function deriveResearchStatus(input: {
  readonly escalated: boolean
  readonly researchStepStatus: DurableWorkflowStepStatus | undefined
  readonly qualityVerdict: QualityVerdict | null
  readonly executablePlan: PlanState | null
  readonly artifacts: ResearchArtifactsState
}): DeepResearchJourneyResearchStatus {
  if (input.escalated) return 'blocked'
  if (!input.researchStepStatus || input.researchStepStatus === 'pending') {
    return 'not_started'
  }
  if (
    input.researchStepStatus === 'blocked' ||
    input.researchStepStatus === 'failed' ||
    input.researchStepStatus === 'cancelled' ||
    hasFailedExecutableResearch(input.executablePlan)
  ) {
    return 'blocked'
  }
  if (input.qualityVerdict?.decision === 'APPROVE') return 'approved'
  if (input.qualityVerdict?.decision === 'REVISE') return 'correcting'
  if (input.qualityVerdict || input.artifacts.hasResearchReport) return 'reviewing'
  if (input.artifacts.hasSectionDraftPlan) return 'drafting'
  if (input.artifacts.hasSynthesis) return 'synthesizing'
  if (input.artifacts.hasQualityPacket) return 'synthesizing'
  if (input.executablePlan?.status === 'failed') return 'reviewing'
  return 'collecting'
}

function deriveResearchBlock(input: {
  readonly researchStep: WorkflowExecutionSnapshot['state']['steps'][number] | undefined
  readonly qualityVerdict: QualityVerdict | null
  readonly executablePlan: PlanState | null
}): DeepResearchJourneyResearch['block'] {
  const executionStopped =
    input.researchStep?.status === 'blocked' ||
    input.researchStep?.status === 'failed' ||
    input.researchStep?.status === 'cancelled' ||
    hasFailedExecutableResearch(input.executablePlan)
  if (executionStopped && input.qualityVerdict?.decision !== 'ESCALATE') {
    return {
      kind: 'execution',
      message:
        input.researchStep?.error ||
        input.researchStep?.summary ||
        'Research execution stopped before the next synthesis and quality audit completed.',
    }
  }
  if (input.qualityVerdict?.decision === 'ESCALATE') {
    return {
      kind: 'quality',
      message:
        'The evidence critic found a material research issue that remains unresolved after the bounded correction policy.',
    }
  }
  return null
}

function hasFailedExecutableResearch(plan: PlanState | null): boolean {
  return [...(plan?.tasks.values() ?? [])].some((task) =>
    task.status === 'failed' ||
    task.status === 'blocked' ||
    task.status === 'skipped',
  )
}

async function projectEscalation(input: {
  readonly input: BuildDeepResearchJourneySnapshotInput
  readonly context: ProjectionContext
  readonly workflowSnapshot: WorkflowExecutionSnapshot | null
  readonly researchAssignmentPath: string | null
  readonly qualityVerdict: QualityVerdict | null
}): Promise<DeepResearchJourneyEscalation | null> {
  const researchStep = input.workflowSnapshot?.state.steps.find(
    (step) => step.stepId === 'research',
  )
  if (!input.researchAssignmentPath || !researchStep) return null

  const hasBlockedWorkflow =
    input.workflowSnapshot?.state.status === 'blocked' &&
    researchStep.status === 'blocked'
  const hasBlockedProjection =
    input.input.task.status === 'blocked' || hasBlockedWorkflow
  const hasTerminalResearchBlock =
    input.input.task.status === 'blocked' && hasBlockedWorkflow
  const hasExplicitEscalation =
    input.qualityVerdict?.decision === 'ESCALATE' && hasBlockedProjection
  if (!hasExplicitEscalation && !hasTerminalResearchBlock) return null

  const escalationFile = await inspectOwnedFile(
    input.researchAssignmentPath,
    ESCALATION_PATH,
  )
  if (escalationFile.state === 'invalid') input.context.integrity = 'partial'
  if (escalationFile.state !== 'available') return null
  return {
    runId: researchStep.childRunId,
    relativePath: ESCALATION_PATH,
  }
}

function derivePhase(input: {
  readonly plan: ResearchPlan | null
  readonly workflowSnapshot: WorkflowExecutionSnapshot | null
  readonly escalation: DeepResearchJourneyEscalation | null
}): DeepResearchJourneyPhase {
  if (!input.plan) return 'planning'
  if (input.escalation) return 'escalation'
  const state = input.workflowSnapshot?.state
  if (!state) return 'research'
  if (state.status === 'completed' || state.status === 'completed_with_warnings') {
    return 'delivery'
  }

  const relevantStep =
    state.steps.find((step) => step.stepId === state.currentStepId) ??
    state.steps.find((step) =>
      ['launching', 'running', 'interrupted', 'indeterminate'].includes(step.status),
    ) ??
    state.steps.find((step) =>
      ['blocked', 'failed', 'cancelled'].includes(step.status),
    ) ??
    state.steps.find((step) => step.status === 'pending')

  if (relevantStep?.stepId === 'editorial') return 'editorial'
  if (relevantStep?.stepId === 'publish') return 'delivery'
  return 'research'
}

async function collectArtifacts(params: {
  readonly input: BuildDeepResearchJourneySnapshotInput
  readonly context: ProjectionContext
  readonly workflowSnapshot: WorkflowExecutionSnapshot | null
  readonly researchAssignmentPath: string | null
  readonly plan: ResearchPlan | null
}): Promise<DeepResearchJourneyArtifact[]> {
  const artifacts: DeepResearchJourneyArtifact[] = []
  const researchStep = params.workflowSnapshot?.state.steps.find(
    (step) => step.stepId === 'research',
  )
  if (researchStep && params.researchAssignmentPath) {
    const fixedResearchArtifacts: ReadonlyArray<{
      kind: DeepResearchJourneyArtifactKind
      label: string
      relativePath: string
      mediaType: string
    }> = [
      { kind: 'plan', label: 'Approved research plan', relativePath: 'research/approved-plan.json', mediaType: 'application/json' },
      { kind: 'plan', label: 'Executable research tasks', relativePath: 'research/plan.md', mediaType: 'text/markdown' },
      { kind: 'evidence', label: 'Current evidence manifest', relativePath: 'research/evidence/current-manifest.json', mediaType: 'application/json' },
      { kind: 'evidence_graph', label: 'Claim and evidence graph', relativePath: 'research/evidence-graph/current.json', mediaType: 'application/json' },
      { kind: 'section_dossier', label: 'Section dossier index', relativePath: 'research/sections/current-index.json', mediaType: 'application/json' },
      { kind: 'section_dossier', label: 'Section drafting plan', relativePath: 'research/section-plan.md', mediaType: 'text/markdown' },
      { kind: 'adaptive_decision', label: 'Adaptive correction decision', relativePath: 'research/adaptive/current-decision.json', mediaType: 'application/json' },
      { kind: 'amendment', label: 'Current approved amendment', relativePath: 'research/amendments/current.json', mediaType: 'application/json' },
      { kind: 'synthesis', label: 'Current synthesis packet', relativePath: 'research/synthesis/current.json', mediaType: 'application/json' },
      { kind: 'quality', label: 'Current quality packet', relativePath: 'research/quality/current-packet.json', mediaType: 'application/json' },
      { kind: 'quality', label: 'Current quality verdict', relativePath: 'research/quality/current-verdict.json', mediaType: 'application/json' },
      { kind: 'research_report', label: 'Research package', relativePath: 'research-package.md', mediaType: 'text/markdown' },
      { kind: 'escalation', label: 'Escalation brief', relativePath: ESCALATION_PATH, mediaType: 'text/markdown' },
    ]
    for (const artifact of fixedResearchArtifacts) {
      await addArtifactIfAvailable({
        assignmentPath: params.researchAssignmentPath,
        runId: researchStep.childRunId,
        artifact,
        artifacts,
        context: params.context,
      })
    }
    for (let wave = 0; wave <= 2; wave += 1) {
      await addArtifactIfAvailable({
        assignmentPath: params.researchAssignmentPath,
        runId: researchStep.childRunId,
        artifact: {
          kind: 'research_report',
          label: `Synthesized research draft (wave ${wave})`,
          relativePath: `research/reports/report-wave-${wave}.md`,
          mediaType: 'text/markdown',
        },
        artifacts,
        context: params.context,
      })
      await addArtifactIfAvailable({
        assignmentPath: params.researchAssignmentPath,
        runId: researchStep.childRunId,
        artifact: {
          kind: 'evidence_graph',
          label: `Claim and evidence graph (wave ${wave})`,
          relativePath: `research/evidence-graph/graph-wave-${wave}.json`,
          mediaType: 'application/json',
        },
        artifacts,
        context: params.context,
      })
      await addArtifactIfAvailable({
        assignmentPath: params.researchAssignmentPath,
        runId: researchStep.childRunId,
        artifact: {
          kind: 'adaptive_decision',
          label: `Adaptive decision (wave ${wave})`,
          relativePath: `research/adaptive/decision-wave-${wave}.json`,
          mediaType: 'application/json',
        },
        artifacts,
        context: params.context,
      })
      for (const task of params.plan?.tasks ?? []) {
        await addArtifactIfAvailable({
          assignmentPath: params.researchAssignmentPath,
          runId: researchStep.childRunId,
          artifact: {
            kind: 'evidence',
            label: `${task.title} evidence (wave ${wave})`,
            relativePath: `research/evidence/wave-${wave}/${task.id}.json`,
            mediaType: 'application/json',
          },
          artifacts,
          context: params.context,
        })
      }
      for (const section of params.plan?.sections ?? []) {
        await addArtifactIfAvailable({
          assignmentPath: params.researchAssignmentPath,
          runId: researchStep.childRunId,
          artifact: {
            kind: 'section_dossier',
            label: `${section.title} dossier (wave ${wave})`,
            relativePath:
              `research/sections/${section.id}/dossier-wave-${wave}.json`,
            mediaType: 'application/json',
          },
          artifacts,
          context: params.context,
        })
        await addArtifactIfAvailable({
          assignmentPath: params.researchAssignmentPath,
          runId: researchStep.childRunId,
          artifact: {
            kind: 'section_dossier',
            label: `${section.title} draft (wave ${wave})`,
            relativePath:
              `research/sections/${section.id}/draft-wave-${wave}.md`,
            mediaType: 'text/markdown',
          },
          artifacts,
          context: params.context,
        })
      }
      if (wave > 0) {
        await addArtifactIfAvailable({
          assignmentPath: params.researchAssignmentPath,
          runId: researchStep.childRunId,
          artifact: {
            kind: 'amendment',
            label: `Approved amendment (wave ${wave})`,
            relativePath: `research/amendments/amendment-wave-${wave}.json`,
            mediaType: 'application/json',
          },
          artifacts,
          context: params.context,
        })
      }
    }
  }

  const downstreamArtifacts: ReadonlyArray<{
    stepId: 'editorial' | 'publish'
    artifacts: ReadonlyArray<{
      kind: DeepResearchJourneyArtifactKind
      label: string
      relativePath: string
      mediaType: string
    }>
  }> = [
    {
      stepId: 'editorial',
      artifacts: [
        { kind: 'editorial_draft', label: 'Editorial draft', relativePath: 'final-draft.md', mediaType: 'text/markdown' },
        { kind: 'publication_audit', label: 'Editorial publication audit', relativePath: 'publication-audit.json', mediaType: 'application/json' },
      ],
    },
    {
      stepId: 'publish',
      artifacts: [
        { kind: 'final_markdown', label: 'Final report', relativePath: 'final-report.md', mediaType: 'text/markdown' },
        { kind: 'final_docx', label: 'Final Word document', relativePath: 'final-report.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
        { kind: 'publication_audit', label: 'Final publication audit', relativePath: 'publication-audit.json', mediaType: 'application/json' },
      ],
    },
  ]
  for (const downstream of downstreamArtifacts) {
    const step = params.workflowSnapshot?.state.steps.find(
      (candidate) => candidate.stepId === downstream.stepId,
    )
    if (!step) continue
    const assignmentPath = canonicalChildAssignmentPath(
      params.input,
      step.childRunId,
      params.context,
    )
    if (!assignmentPath) continue
    for (const artifact of downstream.artifacts) {
      await addArtifactIfAvailable({
        assignmentPath,
        runId: step.childRunId,
        artifact,
        artifacts,
        context: params.context,
      })
    }
  }

  return artifacts.sort((left, right) =>
    `${left.kind}\0${left.relativePath}`.localeCompare(
      `${right.kind}\0${right.relativePath}`,
    ),
  )
}

async function addArtifactIfAvailable(params: {
  readonly assignmentPath: string
  readonly runId: string
  readonly artifact: Omit<DeepResearchJourneyArtifact, 'runId'>
  readonly artifacts: DeepResearchJourneyArtifact[]
  readonly context: ProjectionContext
}): Promise<void> {
  const file = await inspectOwnedFile(
    params.assignmentPath,
    params.artifact.relativePath,
  )
  if (file.state === 'invalid') params.context.integrity = 'partial'
  if (file.state !== 'available') return
  params.artifacts.push({ ...params.artifact, runId: params.runId })
}

async function readJsonArtifact(
  assignmentPath: string,
  relativePath: string,
  context: ProjectionContext,
): Promise<unknown | null> {
  const file = await readOwnedFile(
    assignmentPath,
    relativePath,
    MAX_JSON_ARTIFACT_BYTES,
  )
  if (file.state === 'missing') return null
  if (file.state === 'invalid' || file.text === undefined) {
    context.integrity = 'partial'
    return null
  }
  try {
    return JSON.parse(file.text) as unknown
  } catch {
    context.integrity = 'partial'
    return null
  }
}

async function readOwnedFile(
  assignmentPath: string,
  relativePath: string,
  maximumBytes: number,
): Promise<OwnedFileResult> {
  let filePath: string
  try {
    filePath = resolveOwnedRunRelativePath({
      assignmentPath,
      relativePath,
      label: 'Deep Research journey artifact',
    })
  } catch {
    return { state: 'invalid' }
  }
  try {
    const stat = await fs.lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
      return { state: 'invalid' }
    }
    return { state: 'available', text: await fs.readFile(filePath, 'utf8') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'missing' }
    }
    return { state: 'invalid' }
  }
}

async function inspectOwnedFile(
  assignmentPath: string,
  relativePath: string,
): Promise<OwnedFileResult> {
  let filePath: string
  try {
    filePath = resolveOwnedRunRelativePath({
      assignmentPath,
      relativePath,
      label: 'Deep Research journey artifact',
    })
  } catch {
    return { state: 'invalid' }
  }
  try {
    const stat = await fs.lstat(filePath)
    return stat.isFile() && !stat.isSymbolicLink()
      ? { state: 'available' }
      : { state: 'invalid' }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'missing' }
      : { state: 'invalid' }
  }
}

function isJourneyStepId(
  value: string | undefined,
): value is 'research' | 'editorial' | 'publish' {
  return value === 'research' || value === 'editorial' || value === 'publish'
}

function latestTimestamp(values: readonly (string | undefined)[]): string {
  const [latest] = values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))
  if (latest === undefined) {
    throw new Error('Deep research journey has no recorded timestamp.')
  }
  return latest
}
