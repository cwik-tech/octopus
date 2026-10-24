import {
  clearRuntimeApprovedModelChoice,
  getRuntimeApprovedModelChoice,
  setRuntimeApprovedModelChoice,
} from '../domains/provider/approved-model-choice.js'
import { getRuntimeDefaultModelState } from '../domains/provider/default-model-selection.js'
import {
  toModelSelectionRecord,
  unusableProviderOptions,
} from '../contracts/agent-model-selection.js'
import { resolveAuthorizedAgentModelChoice } from '../contracts/model-choice.js'
import type { ModelChoiceOffer } from '../contracts/model-choice.js'
import { whenDefined } from '../core/optional-properties.js'
import type { AgentQuestionInteraction } from '../contracts/agent-questions.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RegistryEntry, TeamRegistryEntry, TeamRuntimeOverrides } from '../core/types.js'
import { classifyDispatchFailure, runAgent, runTeam } from '../domains/agent-execution/agent-runner.js'
import { HeldSubtreeError } from '../domains/agent-execution/delegated-settlement.js'
import { loadAgent } from '../parsers/load-agent.js'
import { parseMarkdownArtifact, stripArtifactFrontmatter } from '../domains/runtime/artifacts.js'
import { throwIfSignalAborted, writeFileAtomic } from '../core/file-mutation.js'
import { resolveChildTeamContract } from '../domains/delegation/delegation-contracts.js'
import { buildStageEntryFollowUp } from '../domains/stage/stage-entry.js'
import { applyTeamRuntimeOverrides } from '../core/team-runtime-overrides.js'
import {
  resolveWorkflowArtifactPath,
  resolveWorkflowArtifactText,
  resolveWorkflowStepBrief,
} from './handoff.js'
import {
  buildDurableWorkflowTerminalOutcome,
  summarizeWorkflowResult,
} from './results.js'
import type {
  HumanInputInteraction,
  HumanInputRecipient,
  WorkflowExecutionResult,
  WorkflowExecutionStepResult,
  WorkflowRegistryEntry,
  WorkflowRunOutcome,
  WorkflowStep,
  WorkflowTemplate,
} from './types.js'
import { parseWorkflowTemplate } from './loader.js'
import { validateWorkflowTemplate } from './validation.js'
import {
  artifactMediaType,
  BUILTIN_TRANSFORM_EXECUTOR,
  workflowOutputArtifacts,
  workflowStepResultArtifacts,
} from './artifact-contracts.js'
import { generateWordBuffer } from '../domains/word-generation/generate-word.js'
import { generateExcelBuffer } from '../domains/excel-generation/generate-excel.js'
import {
  fillExcelTemplate,
  loadExcelTemplate,
  parseExcelTemplateData,
  resolveDefaultExcelTemplatesRoot,
} from '../domains/excel-generation/excel-templates.js'
import {
  buildResearchPublicationAudit,
  canonicalizeResearchCitations,
} from './research-provenance.js'
import { resolveAdaptiveResearchBudget } from '../domains/deep-research/deep-research-adaptive-policy.js'
import { logAgentRun, logRuntimeEvent } from '../domains/runtime/logger.js'
import type { HumanInputRoutingContext } from '../contracts/human-input.js'
import { MAX_HUMAN_INPUT_SOURCE_PROMPT_BYTES } from '../contracts/human-input.js'
import {
  buildSessionRunAssignmentLocation,
  writeRunAssignmentLocator,
  type RunAssignmentLocation,
} from '../domains/run/run-location.js'
import { roundUsd } from '../core/budget-ledger.js'
import {
  buildChildAssignmentLocation,
  buildRuntimeAssignmentEnvironment,
  resolveAssignmentPath,
  resolveOwnedRunRelativePath,
  resolveRuntimeAssignmentLocation,
} from '../domains/runtime/runtime-paths.js'
import {
  prepareDelegatedRuntimeAssignmentAuthority,
  withoutRootTaskLaunchSecrets,
} from '../domains/run/runtime-assignment-authority.js'
import {
  RUNTIME_PROCESS_IDENTITY_ENV,
  RUNTIME_TASK_ID_ENV,
} from '../contracts/runtime-capability-authority.js'
import type { ExecutionJournal } from '../core/execution-journal.js'
import { createJournalBackedWorkflowRecorder } from './workflow-journal.js'
import { retainCompatibleProviderOptions } from '../providers/provider-option-support.js'
import {
  FileSystemWorkflowStateStore,
  createWorkflowArtifactReference,
  hashWorkflowContent,
  readVerifiedWorkflowArtifactPreview,
  readWorkflowCompletionReceipt,
  verifyWorkflowArtifactReference,
  writeWorkflowCompletionReceipt,
  type WorkflowExecutionSnapshot,
} from './workflow-state-store.js'
import type {
  DurableWorkflowState,
  DurableWorkflowStepState,
  DurableWorkflowTerminalOutcome,
  WorkflowCompletionReceipt,
  WorkflowStepStateSeed,
} from './types.js'

const WORKFLOW_RUNTIME_VERSION = 'workflow-runtime-v1'
const MARKDOWN_TO_DOCX_TRANSFORM_VERSION = 'markdown-to-docx-v2'
const TEST_CRASH_AFTER_RECEIPT_STEP_ENV = 'TEAM_RUNTIME_TEST_CRASH_AFTER_RECEIPT_STEP'
const TEST_CRASH_AFTER_RECEIPT_MARKER_ENV = 'TEAM_RUNTIME_TEST_CRASH_AFTER_RECEIPT_MARKER'

/**
 * Deterministic failpoint for process-recovery integration tests. Production
 * and development runtimes ignore these variables, even if they leak into the
 * environment.
 */
function crashAfterReceiptForTest(stepId: string): void {
  if (process.env.NODE_ENV !== 'test') return
  if (process.env[TEST_CRASH_AFTER_RECEIPT_STEP_ENV] !== stepId) return

  const markerPath = process.env[TEST_CRASH_AFTER_RECEIPT_MARKER_ENV]?.trim()
  if (markerPath) {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true })
    const temporaryPath = `${markerPath}.${process.pid}.tmp`
    const descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
    try {
      fs.writeFileSync(descriptor, `${process.pid}\n`)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    fs.renameSync(temporaryPath, markerPath)
  }

  process.kill(process.pid, 'SIGKILL')
}

function requireTeamEntry(entry: RegistryEntry | undefined, workflowId: string, stepId: string): TeamRegistryEntry {
  if (!entry) throw new Error(`Workflow '${workflowId}' step '${stepId}' references unknown team.`)
  if (entry.type !== 'team') throw new Error(`Workflow '${workflowId}' step '${stepId}' must reference a team registry entry.`)
  return entry
}

/** Only transform and human-input steps resolve without a team entry, and neither dispatches one. */
function throwMissingDispatchTeamEntry(workflowId: string, stepId: string): never {
  throw new Error(`Workflow '${workflowId}' step '${stepId}' has no team entry to dispatch.`)
}

function resolveStepRuntimeOverrides(step: WorkflowStep): TeamRuntimeOverrides | undefined {
  if (!step.stage_type) return step.runtime_overrides
  return {
    ...step.runtime_overrides,
    stage_type: step.stage_type,
  }
}

function inferStatusFromChildResult(params: {
  result: Awaited<ReturnType<typeof runTeam>>
}): WorkflowExecutionStepResult['status'] {
  if (params.result.status) return params.result.status

  // Compatibility fallback for injected runners that predate structured status.
  const artifactCandidates = [params.result.artifactPath, params.result.assignmentPath ? path.join(params.result.assignmentPath, 'final-draft.md') : '']
    .filter(Boolean)
  for (const artifactPath of artifactCandidates) {
    if (!artifactPath || !fs.existsSync(artifactPath)) continue
    const parsed = parseMarkdownArtifact(fs.readFileSync(artifactPath, 'utf8'))
    if (parsed.metadata.status === 'approved_with_warnings') return 'completed_with_warnings'
  }
  return params.result.succeeded ? 'completed' : 'failed'
}

function resolveExpectedArtifact(
  assignmentPath: string,
  artifactRef: string,
): { artifactPath?: string; error?: string } {
  if (!assignmentPath) {
    return { error: `child runner returned no assignment path for '${artifactRef}'` }
  }

  const root = path.resolve(assignmentPath)
  const artifactPath = path.resolve(root, artifactRef)
  const relative = path.relative(root, artifactPath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { error: `artifact '${artifactRef}' escapes the child assignment directory` }
  }
  if (!fs.existsSync(artifactPath)) {
    return { error: `expected artifact '${artifactRef}' was not produced` }
  }
  const artifactStat = fs.lstatSync(artifactPath)
  if (artifactStat.isSymbolicLink() || !artifactStat.isFile()) {
    return { error: `expected artifact '${artifactRef}' must be a regular file` }
  }

  const rootRealPath = fs.realpathSync(root)
  const artifactRealPath = fs.realpathSync(artifactPath)
  const realRelative = path.relative(rootRealPath, artifactRealPath)
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    return { error: `artifact '${artifactRef}' resolves outside the child assignment directory` }
  }
  return { artifactPath }
}

interface WorkflowArtifactContract {
  relativePath: string
  artifactPath?: string
  error?: string
}

/**
 * Resolve one declared glob into artifact contracts. A declared glob states an
 * expectation exactly like a named `result_artifact`, so matching nothing is a
 * contract failure rather than an empty list — otherwise the step reports
 * success having produced none of what it promised, and the workflow delivers
 * its report alone.
 */
function resolveGlobArtifactContracts(
  assignmentPath: string,
  artifactGlob: string,
): WorkflowArtifactContract[] {
  const matches = resolveExpectedArtifactsMatchingGlob(assignmentPath, artifactGlob)
  return matches.length > 0
    ? matches
    : [{
        relativePath: artifactGlob,
        error: `expected artifacts matching '${artifactGlob}' were not produced`,
      }]
}

/**
 * Whether an assignment-relative path is one this glob would have matched.
 * `*` spans exactly one path segment — the same shape the resolver walks — so
 * a recorded artifact can be re-selected without touching the filesystem.
 */
function artifactPathMatchesGlob(relativePath: string, artifactGlob: string): boolean {
  const pathSegments = relativePath.replaceAll('\\', '/').split('/')
  const globSegments = artifactGlob.replaceAll('\\', '/').split('/')
  if (pathSegments.length !== globSegments.length) return false
  return globSegments.every(
    (segment, index) => segment === '*' || segment === pathSegments[index],
  )
}

function resolveExpectedArtifactsMatchingGlob(
  assignmentPath: string,
  artifactGlob: string,
): Array<{ relativePath: string; artifactPath: string }> {
  const root = path.resolve(assignmentPath)
  const segments = artifactGlob.replaceAll('\\', '/').split('/')
  const matches: Array<{ relativePath: string; artifactPath: string }> = []
  const visit = (directory: string, index: number) => {
    const segment = segments[index]
    if (!segment) return
    if (index === segments.length - 1) {
      if (segment === '*') {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (!entry.isFile() || entry.isSymbolicLink()) continue
          const artifactPath = path.join(directory, entry.name)
          const relativePath = path.relative(root, artifactPath).split(path.sep).join('/')
          const resolved = resolveExpectedArtifact(root, relativePath)
          if (resolved.artifactPath) matches.push({ relativePath, artifactPath: resolved.artifactPath })
        }
        return
      }
      const artifactPath = path.join(directory, segment)
      const relativePath = path.relative(root, artifactPath)
        .split(path.sep)
        .join('/')
      const resolved = resolveExpectedArtifact(root, relativePath)
      if (resolved.artifactPath) {
        matches.push({ relativePath, artifactPath: resolved.artifactPath })
      }
      return
    }
    const nextDirectories = segment === '*'
      ? fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => entry.name)
      : [segment]
    for (const next of nextDirectories) {
      const nextPath = path.join(directory, next)
      try {
        // Deliberately re-checked rather than trusting the Dirent above: the
        // directory listing describes the tree as it was read, and this is the
        // window in which a directory could be replaced by a symlink pointing
        // outside the assignment. The literal-segment branch has no Dirent at
        // all, so this is its only check.
        if (!fs.statSync(nextPath).isDirectory() || fs.lstatSync(nextPath).isSymbolicLink()) continue
        visit(nextPath, index + 1)
      } catch {
        continue
      }
    }
  }
  try {
    visit(root, 0)
  } catch {
    return []
  }
  return matches.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

function buildEscalation(
  template: WorkflowTemplate,
  stepId: string,
  status: 'blocked' | 'failed',
): WorkflowExecutionResult['escalation'] {
  const policy = status === 'blocked' ? template.on_blocked : template.on_failed
  return policy === 'escalate_to_user'
    ? { target: 'user', stepId, reason: status }
    : undefined
}

function workflowEscalation(
  template: WorkflowTemplate,
  stepId: string,
  status: 'blocked' | 'failed',
): Pick<WorkflowExecutionResult, 'escalation'> {
  const escalation = buildEscalation(template, stepId, status)
  return escalation ? { escalation } : {}
}

export interface WorkflowRunnerOptions {
  workflowEntry: WorkflowRegistryEntry
  teamRegistry: Map<string, RegistryEntry>
  brief: string
  workspacePath: string
  spawnDepth: number
  signal?: AbortSignal
  budgetUsd?: number
  budgetPolicy?: 'halt' | 'warn'
  rootSessionId?: string
  parentSessionId?: string
  assignmentLocation?: RunAssignmentLocation
  taskId?: string
  productSessionId?: string
  executionAttemptId?: string
  /** Session tasks require durable recovery; nested tool workflows are explicit attempt-local work. */
  persistenceMode?: 'required' | 'ephemeral'
  recoveryMode?: boolean
  continuationMode?: boolean
  continuationAdmissionRequestId?: string
  /** Preserve workflow semantics unless the owning task is a direct Team chat. */
  executionMode?: 'team-chat'
  runTeamImpl?: typeof runTeam
  runAgentImpl?: typeof runAgent
  /**
   * Durable execution-journal authority for this assignment (Phase 8 ADR §9).
   *
   * Injected rather than constructed here: the registry lives in the services
   * layer, which `workflows/` may not import. When supplied and the assignment
   * enrolls, workflow transitions are journaled before `workflow-state.json`
   * is published and that file becomes a rebuildable projection. When absent
   * — or when the assignment is not enrolled — the snapshot-first legacy
   * authority is unchanged, because a running execution is never switched
   * between authorities.
   */
  journalRegistry?: WorkflowJournalRegistry
  /**
   * Decides whether a failed step earned a model-choice offer.
   *
   * Injected for the same reason as the journal registry: the evidence lives
   * in a layer `workflows/` may not import. Absent means a failed step ends
   * the run exactly as it did before.
   */
  modelChoiceEvaluator?: WorkflowModelChoiceEvaluator
}

/**
 * The slice of the execution-journal registry the runner needs. Declared here
 * so the dependency points inward; `services/` supplies the implementation.
 */
export interface WorkflowJournalRegistry {
  resolveJournalHandle(input: {
    readonly context: {
      readonly contractVersion: 1
      readonly requestId: string
      readonly sessionId: string
      readonly runId: string
      readonly assignmentId: string
      readonly agentPath: string
      readonly authority: {
        readonly kind: 'runtime-assignment'
        readonly processIdentity: string
      }
    }
    readonly signal: AbortSignal
    readonly deadlineMs: number
  }): Promise<ExecutionJournal | undefined>
}

function resolveRootWorkflowAssignmentPath(
  options: WorkflowRunnerOptions,
  rootRunId: string,
): string {
  if (options.assignmentLocation) {
    if (
      options.assignmentLocation.runId !== rootRunId &&
      options.assignmentLocation.assignmentId !== rootRunId
    ) {
      throw new Error('Workflow root run ID does not match its assignment scope.')
    }
    return options.assignmentLocation.assignmentPath
  }
  return resolveAssignmentPath(options.workspacePath, rootRunId)
}

function resolveWorkflowChildAssignmentPath(
  options: WorkflowRunnerOptions,
  childRunId: string,
): string {
  if (options.assignmentLocation?.layout === 'session') {
    const childLocation = buildSessionRunAssignmentLocation(
      options.workspacePath,
      {
        sessionId: options.assignmentLocation.sessionId,
        runId: options.assignmentLocation.runId,
        assignmentId: childRunId,
      },
    )
    if (!childLocation) {
      throw new Error(`Invalid workflow child run ID: ${childRunId}`)
    }
    return childLocation.assignmentPath
  }
  return resolveAssignmentPath(options.workspacePath, childRunId)
}

function agentStageInstruction(step: WorkflowStep): string {
  switch (step.stage_type) {
    case 'routing':
      return 'Classify the request, choose the best next action, and explain the routing decision.'
    case 'discussion':
      return 'Deliberate from multiple relevant perspectives before synthesizing one recommendation.'
    case 'pipeline':
      return 'Execute the task as a structured pipeline with explicit checks and a complete final deliverable.'
    case 'chain':
      return 'Complete this link in the workflow chain so the result is ready for the next handoff.'
    case 'broadcast':
      return 'Produce an independent contribution that can be combined with parallel workflow results.'
    case 'review':
      return 'Critically review the supplied work, correct material problems, and return the improved result.'
  }
  return 'Complete the delegated task and return a result ready for the next workflow step.'
}

async function runWorkflowAgentStep(params: {
  options: WorkflowRunnerOptions
  template: WorkflowTemplate
  step: WorkflowStep
  teamEntry: TeamRegistryEntry
  brief: string
  inputArtifact: string
  childSessionId?: string
  /**
   * 1-based attempt number within this step's logical invocation.
   *
   * A resumed step reuses its child run id, so the run id cannot tell two
   * attempts apart. Consent stays scoped to the invocation; the durable record
   * has to distinguish the attempts, or an approved retry overwrites the
   * failure it was granted for.
   */
  attempt?: number
  recoveryMode: boolean
}): Promise<Awaited<ReturnType<typeof runTeam>>> {
  const contract = resolveChildTeamContract(params.teamEntry)
  const rosterEntry = contract.teamConfig.agents.find(
    (candidate) => candidate.type === 'agent' && candidate.name === params.step.agent,
  )
  if (!rosterEntry) {
    throw new Error(
      `Workflow '${params.template.id}' step '${params.step.id}' cannot load agent '${params.step.agent}'.`,
    )
  }
  const agent = loadAgent(rosterEntry, contract.teamConfig, 0)
  if (!agent) {
    throw new Error(
      `Workflow '${params.template.id}' step '${params.step.id}' cannot load agent file for '${params.step.agent}'.`,
    )
  }

  const safeAgentName = agent.name.replace(/[^a-zA-Z0-9_-]+/g, '-') || 'agent'
  const childSessionId =
    params.childSessionId ?? `child-${safeAgentName}-${randomUUID()}`
  const parentLocation =
    params.options.assignmentLocation ??
    resolveRuntimeAssignmentLocation(params.options.workspacePath)
  const assignmentLocation = buildChildAssignmentLocation(
    params.options.workspacePath,
    parentLocation,
    childSessionId,
  )
  const assignmentPath =
    assignmentLocation?.assignmentPath ??
    resolveAssignmentPath(params.options.workspacePath, childSessionId)
  fs.mkdirSync(params.options.workspacePath, { recursive: true })
  fs.mkdirSync(assignmentPath, { recursive: true })
  if (assignmentLocation) {
    await writeRunAssignmentLocator(params.options.workspacePath, assignmentLocation)
  }
  const delegatedAuthority =
    await prepareDelegatedRuntimeAssignmentAuthority({
      workspacePath: params.options.workspacePath,
      parentLocation,
      childLocation: assignmentLocation,
      environment: process.env,
    })

  const inputPath = resolveOwnedRunRelativePath({
    assignmentPath,
    relativePath: params.inputArtifact,
    label: 'Workflow agent input artifact',
  })
  const outputPath = resolveOwnedRunRelativePath({
    assignmentPath,
    relativePath: params.step.result_artifact,
    label: 'Workflow agent result artifact',
  })
  if (params.recoveryMode && fs.existsSync(outputPath)) {
    fs.rmSync(outputPath, { force: true })
  }
  fs.mkdirSync(path.dirname(inputPath), { recursive: true })
  fs.writeFileSync(inputPath, params.brief)

  const runAgentImpl = params.options.runAgentImpl ?? runAgent
  const workerEnvironment = assignmentLocation
    ? {
        ...withoutRootTaskLaunchSecrets(process.env),
        ...buildRuntimeAssignmentEnvironment(assignmentLocation),
        ...(delegatedAuthority
          ? {
              [RUNTIME_TASK_ID_ENV]: delegatedAuthority.taskId,
              [RUNTIME_PROCESS_IDENTITY_ENV]:
                delegatedAuthority.processIdentity,
            }
          : {}),
        TEAM_RUNTIME_WORKFLOW_ID: params.template.id,
        TEAM_RUNTIME_WORKFLOW_STEP_ID: params.step.id,
      }
    : process.env
  // An agent-only step calls the provider directly rather than through the
  // dispatcher, so it has to resolve an approved retry itself. Without this a
  // step of this shape would ignore a permission the user gave and run the
  // pair that already failed.
  // The loader already decided how this Agent's pair was chosen, and said why
  // when it could not decide at all. Reconstructing the choice from the flat
  // provider/model it left behind would label every Agent an explicit chooser
  // — including one that named no model and inherited the application default
  // — and would dispatch an empty pair as though it were a selection.
  // Options the loader refused make the Agent unusable, here as much as at Team
  // startup. This step loads its own Agent, so it asks the same question: a
  // dispatch with its settings silently dropped is indistinguishable from a
  // provider that ignores them, and a credential in an Agent file goes
  // unreported. Unusable either way, so it is checked before the selection.
  const refusedOptions = unusableProviderOptions(agent.selectionDiagnostics)
  if (refusedOptions) {
    throw new Error(
      `Workflow agent '${agent.name}' has unusable provider options. ` +
      refusedOptions.message,
    )
  }
  if (!agent.selection) {
    throw new Error(
      `Workflow agent '${agent.name}' has no model selected. ` +
      (agent.selectionError?.message ?? 'No application default model is selected.'),
    )
  }
  const authorized = resolveAuthorizedAgentModelChoice({
    agentName: agent.name,
    logicalInvocationId: params.step.id,
    agentChoice:
      agent.selection.source === 'agent'
        ? {
            mode: 'explicit' as const,
            provider: agent.selection.provider,
            model: agent.selection.model,
          }
        : { mode: 'app-default' as const },
    ...whenDefined(getRuntimeApprovedModelChoice(), (authorization) => ({
      authorization,
    })),
    appDefault: getRuntimeDefaultModelState(),
  })
  if (!authorized.ok) {
    throw new Error(
      `Workflow agent '${agent.name}' cannot run its approved retry: ${authorized.error.message}`,
    )
  }
  const approvedRetry = authorized.selection.reason === 'user-approved-retry'
  // This step calls the provider directly instead of starting a child runtime,
  // so nothing else writes its run log. Without these records an eligible
  // failure — the adapter refusing before it sent anything — is invisible to
  // the evaluator, and a step of this shape could never offer the user a
  // choice however sound the approval machinery downstream is. The identity
  // matches what the approval is later scoped to: one logical invocation per
  // step, one attempt per execution of it.
  const logicalInvocationId = params.step.id
  const dispatchId = `${logicalInvocationId}#${params.attempt ?? 1}#${agent.name}`
  const dispatchStartedAt = Date.now()
  // §4.3: on an approved switch the agent's settings are re-evaluated against
  // the pair that will run. Without a switch they travel unchanged.
  const reevaluatedOptions = approvedRetry
    ? retainCompatibleProviderOptions(
        {
          provider: authorized.selection.provider,
          route: 'direct',
          thinking: agent.thinking,
        },
        agent.providerConfig,
      )
    : { kept: agent.providerConfig, dropped: [] as readonly string[] }
  const dispatchRecord = {
    session_id: childSessionId,
    ...whenDefined(params.options.rootSessionId, (root_session_id) => ({ root_session_id })),
    assignment_path: assignmentPath,
    team: params.teamEntry.name,
    ...whenDefined(params.step.stage_type, (stage_type) => ({ stage_type })),
    agent_name: agent.name,
    agent_type: 'agent' as const,
    model: authorized.selection.model,
    provider: authorized.selection.provider,
    dispatch_id: dispatchId,
    logical_invocation_id: logicalInvocationId,
    // Named on the record, because an approved switch can legitimately stop a
    // setting applying and only the run can say which.
    ...(reevaluatedOptions.dropped.length
      ? { dropped_provider_options: [...reevaluatedOptions.dropped] }
      : {}),
  }
  logAgentRun(assignmentPath, {
    ...dispatchRecord,
    timestamp: new Date(dispatchStartedAt).toISOString(),
    event: 'start',
    status: 'active',
    // Written before the provider is called, so the pair this attempt ran on
    // is on record even when the attempt never returns.
    model_selection: toModelSelectionRecord(authorized.selection, 'agent'),
  })
  let result: Awaited<ReturnType<typeof runAgentImpl>>
  try {
    result = await runAgentImpl({
    systemPrompt: agent.systemPrompt,
    userMessage: [
      agentStageInstruction(params.step),
      `Treat the following delegated brief as the source of truth and return only the content for ${params.step.result_artifact}.`,
      '',
      params.brief,
    ].join('\n'),
    model: authorized.selection.model,
    thinking: agent.thinking,
    provider: authorized.selection.provider,
    cwd: assignmentPath,
    outputPath: assignmentPath,
    sessionId: childSessionId,
    agentName: agent.name,
    workerEnvironment,
    ...(agent.tools ? { tools: agent.tools } : {}),
    // §4.3: on an approved switch the agent's settings are re-evaluated against
    // the pair that will run, keeping the ones that provider applies and
    // dropping the rest. Without a switch they travel unchanged.
    ...whenDefined(reevaluatedOptions.kept, (providerConfig) => ({
      providerConfig,
    })),
      ...(params.options.signal ? { signal: params.options.signal } : {}),
      ...(params.options.rootSessionId ? { rootSessionId: params.options.rootSessionId } : {}),
    })
  } catch (error) {
    logAgentRun(assignmentPath, {
      ...dispatchRecord,
      timestamp: new Date().toISOString(),
      event: 'fail',
      status: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - dispatchStartedAt,
      // The adapter's own account of how far it got. Classified by the same
      // function the dispatcher uses, so the two paths cannot disagree about
      // whether nothing was sent.
      failure: classifyDispatchFailure(error),
    })
    throw error
  }
  logAgentRun(assignmentPath, {
    ...dispatchRecord,
    timestamp: new Date().toISOString(),
    event: 'end',
    status: 'completed',
    duration_ms: Date.now() - dispatchStartedAt,
    // Both accounts of what stopped applying, as one set. An approved switch
    // drops settings before the turn starts — already on the dispatch record
    // this spreads — and the route the turn took may then have applied none of
    // what survived. Deduplicated and ordered so one attempt reports one set
    // whatever produced it, which is what the Team dispatcher does
    // (`domains/agent-execution/agent-runner.ts:2235-2244`).
    ...(reevaluatedOptions.dropped.length || result.droppedProviderOptions?.length
      ? {
          dropped_provider_options: [
            ...new Set([
              ...reevaluatedOptions.dropped,
              ...(result.droppedProviderOptions ?? []),
            ]),
          ].sort(),
        }
      : {}),
  })
  if (!result.text.trim()) {
    throw new Error(
      `Workflow agent '${agent.name}' returned no result for step '${params.step.id}'.`,
    )
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, result.text)

  return {
    text: result.text,
    cost: result.cost,
    durationMs: result.durationMs,
    artifactPath: outputPath,
    assignmentPath,
    childSessionId,
    requestedResultType:
      params.step.requested_result_type ?? `artifact:${params.step.result_artifact}`,
    ...(result.costTracked === undefined ? {} : { costTracked: result.costTracked }),
    status: 'completed',
    succeeded: true,
    exitCode: 0,
    exitSignal: null,
  }
}

async function runWorkflowTransformStep(params: {
  options: WorkflowRunnerOptions
  template: WorkflowTemplate
  step: WorkflowStep
  brief: string
  provenanceMarkdown?: string
  provenanceEvidenceGraph?: unknown
  inputArtifact: string
  childSessionId?: string
}): Promise<Awaited<ReturnType<typeof runTeam>>> {
  if (
    params.step.transform !== 'markdown_to_docx' &&
    params.step.transform !== 'generate_word' &&
    params.step.transform !== 'generate_excel'
  ) {
    throw new Error(
      `Workflow '${params.template.id}' step '${params.step.id}' uses an unsupported transform.`,
    )
  }
  const startedAt = Date.now()
  const childSessionId =
    params.childSessionId ?? `child-transform-${randomUUID()}`
  const parentLocation =
    params.options.assignmentLocation ??
    resolveRuntimeAssignmentLocation(params.options.workspacePath)
  const assignmentLocation = buildChildAssignmentLocation(
    params.options.workspacePath,
    parentLocation,
    childSessionId,
  )
  const assignmentPath =
    assignmentLocation?.assignmentPath ??
    resolveAssignmentPath(params.options.workspacePath, childSessionId)
  fs.mkdirSync(params.options.workspacePath, { recursive: true })
  fs.mkdirSync(assignmentPath, { recursive: true })
  if (assignmentLocation) {
    await writeRunAssignmentLocator(params.options.workspacePath, assignmentLocation)
  }

  throwIfSignalAborted(params.options.signal)
  const inputPath = resolveOwnedRunRelativePath({
    assignmentPath,
    relativePath: params.inputArtifact,
    label: 'Workflow transform input artifact',
  })
  const editorialMarkdown = stripArtifactFrontmatter(params.brief).trim()
  if (!editorialMarkdown) {
    throw new Error(
      `Workflow transform '${params.step.id}' received an empty Markdown document.`,
    )
  }
  // Citation canonicalization is limited to document transforms that carry both
  // provenance artifacts. Excel input is JSON and must reach JSON.parse intact.
  const canonicalizes =
    (params.step.transform === 'markdown_to_docx' ||
      params.step.transform === 'generate_word') &&
    params.provenanceMarkdown !== undefined &&
    params.provenanceEvidenceGraph !== undefined
  // A present but malformed graph throws here, before any artifact is written;
  // it must never silently downgrade to the legacy no-graph path.
  const canonicalization = canonicalizes
    ? canonicalizeResearchCitations({
      markdown: editorialMarkdown,
      evidenceGraph: params.provenanceEvidenceGraph,
    })
    : undefined
  const cleanMarkdown = canonicalization?.markdown ?? editorialMarkdown
  // Canonical Markdown already ends with exactly one newline, and its
  // outputSha256 covers precisely those bytes; legacy editorial text arrives
  // trimmed, so it gains its newline here. Either way the shipped artifact
  // bytes are `shippedMarkdown`.
  const shippedMarkdown = cleanMarkdown.endsWith('\n')
    ? cleanMarkdown
    : `${cleanMarkdown}\n`
  const publicationAudit = params.provenanceMarkdown !== undefined
    ? buildResearchPublicationAudit({
      sourceMarkdown: params.provenanceMarkdown,
      publicationMarkdown: cleanMarkdown,
      evidenceGraph: params.provenanceEvidenceGraph,
      ...(canonicalization
        ? { canonicalization: canonicalization.summary }
        : {}),
    })
    : undefined
  if (
    publicationAudit &&
    params.step.provenance_handoff?.audit_artifact
  ) {
    const auditPath = resolveOwnedRunRelativePath({
      assignmentPath,
      relativePath: params.step.provenance_handoff.audit_artifact,
      label: 'Workflow publication audit artifact',
    })
    await writeFileAtomic(
      auditPath,
      `${JSON.stringify(publicationAudit, null, 2)}\n`,
    )
  }
  if (publicationAudit?.decision === 'REVISE') {
    throw new Error(
      `Post-editorial provenance check failed: ${publicationAudit.violations
        .map((entry) => entry.message)
        .join('; ')}.`,
    )
  }
  await writeFileAtomic(inputPath, shippedMarkdown)

  const resultArtifacts = workflowStepResultArtifacts(params.step)
  let docxBuffer: Buffer | undefined
  let xlsxBuffer: Buffer | undefined
  if (params.step.transform === 'generate_excel') {
    if (params.step.excel?.template) {
      const template = loadExcelTemplate(
        resolveDefaultExcelTemplatesRoot(),
        params.step.excel.template,
      )
      const filled = await fillExcelTemplate(
        template,
        parseExcelTemplateData(JSON.parse(cleanMarkdown)),
        params.options.signal,
      )
      xlsxBuffer = filled.buffer
    } else {
      const generated = await generateExcelBuffer(cleanMarkdown, {
        profile: params.step.excel?.profile ?? 'business-workbook',
        ...(params.options.signal ? { signal: params.options.signal } : {}),
      })
      xlsxBuffer = generated.buffer
    }
  } else {
    const generated = await generateWordBuffer(cleanMarkdown, {
      profile:
        params.step.word?.profile ??
        (params.step.transform === 'markdown_to_docx'
          ? 'research-report'
          : 'business-report'),
      sourceDirectory: path.dirname(inputPath),
      ...(params.step.word?.table_of_contents === undefined
        ? {}
        : { tableOfContents: params.step.word.table_of_contents }),
      ...(params.step.word?.render_mermaid === undefined
        ? {}
        : { renderMermaid: params.step.word.render_mermaid }),
      ...(params.step.word?.mermaid_failure
        ? { mermaidFailure: params.step.word.mermaid_failure }
        : {}),
      ...(params.options.signal ? { signal: params.options.signal } : {}),
    })
    docxBuffer = generated.buffer
  }
  for (const relativePath of resultArtifacts) {
    throwIfSignalAborted(params.options.signal)
    const outputPath = resolveOwnedRunRelativePath({
      assignmentPath,
      relativePath,
      label: 'Workflow transform result artifact',
    })
    const extension = path.extname(relativePath).toLowerCase()
    if (extension === '.md') {
      await writeFileAtomic(outputPath, shippedMarkdown)
    } else if (
      extension === '.json' &&
      publicationAudit &&
      params.step.provenance_handoff?.audit_artifact === relativePath
    ) {
      await writeFileAtomic(
        outputPath,
        `${JSON.stringify(publicationAudit, null, 2)}\n`,
      )
    } else if (extension === '.docx' && docxBuffer) {
      await writeFileAtomic(outputPath, docxBuffer)
    } else if (extension === '.xlsx' && xlsxBuffer) {
      await writeFileAtomic(outputPath, xlsxBuffer)
    } else {
      throw new Error(
        `Workflow transform '${params.step.id}' cannot produce '${relativePath}'.`,
      )
    }
  }

  const primaryPath = resolveOwnedRunRelativePath({
    assignmentPath,
    relativePath: params.step.result_artifact,
    label: 'Workflow transform primary result artifact',
  })
  return {
    text: cleanMarkdown,
    cost: 0,
    durationMs: Date.now() - startedAt,
    artifactPath: primaryPath,
    assignmentPath,
    childSessionId,
    requestedResultType:
      params.step.requested_result_type ?? `artifact:${params.step.result_artifact}`,
    costTracked: true,
    status: 'completed',
    succeeded: true,
    exitCode: 0,
    exitSignal: null,
  }
}

function getWorkflowLogOutputDir(options: WorkflowRunnerOptions): string | null {
  if (options.assignmentLocation) return options.assignmentLocation.assignmentPath
  if (!options.rootSessionId) return null
  return resolveAssignmentPath(options.workspacePath, options.rootSessionId)
}

function logWorkflowStepEvent(
  options: WorkflowRunnerOptions,
  event: string,
  payload: Record<string, unknown>,
): void {
  const outputDir = getWorkflowLogOutputDir(options)
  if (!outputDir) return
  logRuntimeEvent(outputDir, {
    timestamp: new Date().toISOString(),
    event,
    session_id: options.rootSessionId,
    root_session_id: options.rootSessionId,
    parent_session_id: options.parentSessionId,
    level_id: typeof payload.step_id === 'string' ? payload.step_id : undefined,
    stage_type: 'pipeline',
    ...payload,
  })
}

function toStepArtifactRef(assignmentPath: string | undefined, artifactPath: string | undefined): string | undefined {
  if (!assignmentPath || !artifactPath) return artifactPath
  const relative = path.relative(assignmentPath, artifactPath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return artifactPath
  return relative
}

interface DurableWorkflowContext {
  store: FileSystemWorkflowStateStore
  snapshot: WorkflowExecutionSnapshot
  assignmentPath: string
}

/**
 * Decides whether a failed step earned a model-choice offer.
 *
 * A port, not an implementation: reading the failure's own evidence means
 * reading the execution journal, which lives in the services layer. Absent
 * means no offer is ever made, which is exactly how this behaved before.
 */
export interface WorkflowModelChoiceEvaluator {
  evaluate(input: {
    readonly stepId: string
    readonly childRunId: string
    readonly childAssignmentPath: string
    readonly taskId: string
    readonly sessionId: string
    readonly expectedRevision: string
  }): Promise<ModelChoiceOffer | undefined>
}

/**
 * The one place a failed step is asked whether the user may be offered a retry.
 *
 * Both shapes of failure reach it. A step can fail by throwing, and a step can
 * fail by *returning*: `runTeam` resolves with `succeeded: false` rather than
 * throwing when a child team ends badly, which is the ordinary shape for a
 * team step. A decision made in only one of the two is a decision most
 * failures never get, however sound the approval machinery downstream is.
 *
 * It runs before the step's completion receipt is written, and that ordering
 * carries the whole guarantee that an offer can be acted on. A resumed step
 * whose child assignment already holds a failed receipt commits that receipt
 * and returns terminal without dispatching, so an offer made after the write
 * is one the user could approve and nothing could ever run.
 *
 * Throws to suspend the run. Returning normally means no offer was earned and
 * the caller carries on to its ordinary terminal handling: whether a failure
 * is eligible at all stays the evaluator's decision, on the step's own durable
 * evidence, and nothing here widens it.
 */
async function offerModelChoiceBeforeTerminal(params: {
  options: WorkflowRunnerOptions
  durable: DurableWorkflowContext
  durableStep: DurableWorkflowStepState
  executionAttemptId: string
  stepId: string
  childAssignmentPath: string
}): Promise<void> {
  // A step the recovery policy will never re-dispatch cannot be offered a
  // retry. Approval resumes the run, and a resumed `never_retry` step with no
  // completion receipt is forced to `blocked` without dispatching, so the
  // offer would be shown, approved, and then refused by the policy that was
  // always going to refuse it. Asked before the evaluator, because there is no
  // question to put to the user at all.
  if (params.durableStep.recoveryPolicy === 'never_retry') return

  // Read fresh: this step has moved since the run was initialized, and an
  // offer bound to a stale revision is one no approval could match.
  const current = await params.durable.store.requireSnapshot()
  const offer = await params.options.modelChoiceEvaluator?.evaluate({
    stepId: params.stepId,
    childRunId: params.durableStep.childRunId,
    childAssignmentPath: params.childAssignmentPath,
    taskId: params.durable.snapshot.manifest.taskId,
    sessionId: params.durable.snapshot.manifest.sessionId,
    expectedRevision: String(current.state.revision),
  })
  if (!offer) return

  const waiting = await params.durable.store.update({
    expectedRevision: current.state.revision,
    executionAttemptId: params.executionAttemptId,
    mutate(draft) {
      const target = draft.steps.find(
        (candidate) => candidate.stepId === params.stepId,
      )
      if (!target) return
      target.status = 'awaiting_model_choice'
      target.modelChoice = offer
      draft.status = 'awaiting_model_choice'
      draft.currentStepId = params.stepId
    },
  })
  throw new WorkflowAwaitingModelChoiceError(
    offer,
    params.stepId,
    waiting.revision,
  )
}

class WorkflowAwaitingModelChoiceError extends Error {
  constructor(
    readonly offer: ModelChoiceOffer,
    readonly stepId: string,
    readonly workflowRevision: number,
  ) {
    super(`Workflow is awaiting a model choice for '${stepId}'.`)
    this.name = 'WorkflowAwaitingModelChoiceError'
  }
}

class WorkflowAwaitingHumanInputError extends Error {
  constructor(
    readonly interaction: HumanInputInteraction,
    readonly workflowRevision: number,
  ) {
    super(`Workflow is awaiting human input for '${interaction.stepId}'.`)
    this.name = 'WorkflowAwaitingHumanInputError'
  }
}

class WorkflowAwaitingAgentInputError extends Error {
  constructor(readonly interaction: AgentQuestionInteraction, readonly workflowRevision: number) {
    super('Workflow is waiting for an agent question answer.')
    this.name = 'WorkflowAwaitingAgentInputError'
  }
}

function humanInputInteractionId(
  taskId: string,
  workflowId: string,
  stepId: string,
): string {
  return `workflow_hitl_${hashWorkflowContent(`${taskId}:${workflowId}:${stepId}`).slice(0, 32)}`
}

function resolveHumanInputRecipients(params: {
  template: WorkflowTemplate
  stepIndex: number
  teamRegistry: ReadonlyMap<string, RegistryEntry>
}): HumanInputRecipient[] {
  const successor = params.template.steps[params.stepIndex + 1]
  if (!successor) return []
  if (successor.type === 'agent' && successor.agent) {
    return [{
      id: successor.agent,
      mentionToken: successor.agent,
      displayName: successor.agent,
    }]
  }
  if (successor.type !== 'team' || !successor.team) return []

  const teamEntry = requireTeamEntry(
    params.teamRegistry.get(successor.team),
    params.template.id,
    successor.id,
  )
  const childContract = resolveChildTeamContract(teamEntry)
  const overrideErrors = applyTeamRuntimeOverrides(
    childContract.teamConfig,
    resolveStepRuntimeOverrides(successor),
  )
  if (overrideErrors.length > 0) {
    throw new Error(
      `Workflow '${params.template.id}' step '${successor.id}' has invalid runtime overrides: ${overrideErrors.join('; ')}`,
    )
  }
  const entryLevelId = childContract.teamConfig.workflow?.entry_level ??
    childContract.teamConfig.levels[0]?.id
  const entryLevel = childContract.teamConfig.levels.find(
    (level) => level.id === entryLevelId,
  )
  if (!entryLevel || entryLevel.stage.type !== 'discussion') return []

  const roster = new Map(
    childContract.teamConfig.agents
      .filter((agent) => agent.type === 'agent')
      .map((agent) => [agent.name, agent]),
  )
  return entryLevel.stage.participants.flatMap((participant) => {
    if (!roster.has(participant)) return []
    return [{
      id: participant,
      mentionToken: participant,
      displayName: participant,
    }]
  })
}

function feedbackEnvelope(interaction: HumanInputInteraction): Record<string, unknown> {
  const submission = interaction.submission
  if (!submission) throw new Error(`Human-input interaction '${interaction.interactionId}' has no submission.`)
  return {
    schemaVersion: 1,
    interactionId: interaction.interactionId,
    submissionId: submission.submissionId,
    workflowId: interaction.workflowId,
    stepId: interaction.stepId,
    sourceArtifact: interaction.sourceArtifact,
    sourceArtifactSha256: interaction.sourceArtifact.sha256,
    submittedAt: submission.submittedAt,
    mode: submission.mode,
    eligibleRecipients: interaction.eligibleRecipients,
    messages: submission.messages,
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function durableIdentifiers(options: WorkflowRunnerOptions): {
  taskId: string
  sessionId: string
  rootRunId: string
  executionAttemptId: string
} | null {
  if (options.persistenceMode === 'ephemeral') return null
  const hasDurabilityIdentifier = Boolean(
    options.taskId || options.productSessionId || options.executionAttemptId,
  )
  if (
    !options.taskId ||
    !options.productSessionId ||
    !options.rootSessionId ||
    !options.executionAttemptId
  ) {
    if (options.persistenceMode === 'required' || hasDurabilityIdentifier) {
      throw new Error(
        'Durable workflow execution requires taskId, productSessionId, rootSessionId, and executionAttemptId.',
      )
    }
    return null
  }
  return {
    taskId: options.taskId,
    sessionId: options.productSessionId,
    rootRunId: options.rootSessionId,
    executionAttemptId: options.executionAttemptId,
  }
}

function teamDefinitionHash(teamEntry: TeamRegistryEntry): string {
  return hashWorkflowContent(fs.readFileSync(path.join(teamEntry.team_path, 'team.yaml')))
}

function agentDefinitionHash(
  step: WorkflowStep,
  teamEntry: TeamRegistryEntry,
): string | undefined {
  if (step.type !== 'agent') return undefined
  const contract = resolveChildTeamContract(teamEntry)
  const rosterEntry = contract.teamConfig.agents.find(
    (candidate) => candidate.type === 'agent' && candidate.name === step.agent,
  )
  return rosterEntry?.agent_file
    ? hashWorkflowContent(fs.readFileSync(rosterEntry.agent_file))
    : undefined
}

/**
 * The assignment's journal, or undefined when the runner has no registry or
 * the assignment has not enrolled. A registry that throws means the authority
 * is enrolled but unavailable, which must not silently fall back to the legacy
 * path (ADR §7), so the failure propagates.
 */
async function resolveWorkflowJournal(
  options: WorkflowRunnerOptions,
  identifiers: { readonly rootRunId: string; readonly executionAttemptId: string },
): Promise<ExecutionJournal | undefined> {
  const registry = options.journalRegistry
  if (!registry) return undefined
  const location = options.assignmentLocation
  if (!location || location.layout !== 'session') return undefined
  return registry.resolveJournalHandle({
    context: {
      contractVersion: 1,
      requestId: `workflow-${identifiers.rootRunId}`,
      sessionId: location.sessionId,
      runId: location.runId,
      assignmentId: identifiers.rootRunId,
      agentPath: 'workflows/runner',
      authority: {
        kind: 'runtime-assignment',
        processIdentity: identifiers.executionAttemptId,
      },
    },
    signal: options.signal ?? new AbortController().signal,
    deadlineMs: Date.now() + WORKFLOW_JOURNAL_RESOLVE_BUDGET_MS,
  })
}

/** Bounds journal resolution at workflow start; see `resolveWorkflowJournal`. */
const WORKFLOW_JOURNAL_RESOLVE_BUDGET_MS = 30_000

async function initializeDurableWorkflow(params: {
  options: WorkflowRunnerOptions
  template: WorkflowTemplate
}): Promise<DurableWorkflowContext | null> {
  const identifiers = durableIdentifiers(params.options)
  if (!identifiers) return null

  const assignmentPath = resolveRootWorkflowAssignmentPath(
    params.options,
    identifiers.rootRunId,
  )
  // Phase 8 ADR §9: when this assignment is journal-enrolled, transitions are
  // appended before the snapshot is published and `workflow-state.json`
  // becomes a projection. An unenrolled assignment — or a runner with no
  // registry — keeps the snapshot-first authority byte for byte, because a
  // running execution is never switched between authorities.
  const journal = await resolveWorkflowJournal(params.options, identifiers)
  const store = new FileSystemWorkflowStateStore(
    assignmentPath,
    journal ? { journal: createJournalBackedWorkflowRecorder(journal) } : {},
  )
  const hashes: Record<string, string> = {}
  const seeds: WorkflowStepStateSeed[] = params.template.steps.map((step, stepIndex) => {
    const teamName = step.team
    const teamEntry = step.type === 'transform' || step.type === 'human-in-the-loop'
      ? undefined
      : requireTeamEntry(
          teamName ? params.options.teamRegistry.get(teamName) : undefined,
          params.template.id,
          step.id,
        )
    const teamHash = teamEntry
      ? teamDefinitionHash(teamEntry)
      : hashWorkflowContent(
          step.type === 'human-in-the-loop'
            ? 'human-in-the-loop-v1'
            : MARKDOWN_TO_DOCX_TRANSFORM_VERSION,
        )
    // Transform steps used their builtin executor as a manifest key before
    // HITL introduced team-less steps. Only the latter must omit a hash.
    if (step.team) hashes[step.team] ??= teamHash
    const recoveryPolicy = step.recovery_policy ?? (
      step.type === 'transform' ? 'idempotent' :
        step.type === 'human-in-the-loop' ? 'never_retry' : 'manual'
    )
    return {
      stepId: step.id,
      stepIndex,
      stepType: step.type,
      definitionHash: hashWorkflowContent(canonicalJson({
        step,
        teamHash,
        agentHash: teamEntry ? agentDefinitionHash(step, teamEntry) : undefined,
      })),
      recoveryPolicy,
      inputArtifact: step.handoff?.to_artifact || step.input_artifact || teamEntry?.input_artifact || 'incoming-brief.md',
      resultArtifact: step.result_artifact || teamEntry?.output_artifact || '',
      // Preserve the immutable shape accepted by workflow-runtime-v1 for
      // legacy single-artifact steps. Multi-artifact transforms opt into the
      // expanded seed explicitly so existing durable runs can still recover.
      ...(teamName ? { team: teamName } : {}),
      ...(step.result_artifacts?.length
        ? { resultArtifacts: workflowStepResultArtifacts(step) }
        : {}),
      ...(step.result_artifact_globs?.length || step.optional_result_artifact_globs?.length
        ? { resultArtifactGlobs: [
            ...(step.result_artifact_globs ?? []),
            ...(step.optional_result_artifact_globs ?? []),
          ] }
        : {}),
      requestedResultType: params.options.executionMode === 'team-chat'
        ? 'chat:messages'
        : step.requested_result_type ?? `artifact:${step.result_artifact}`,
      ...(recoveryPolicy === 'idempotent'
        ? { idempotencyKey: hashWorkflowContent(`${identifiers.taskId}:${step.id}`) }
        : {}),
    }
  })
  const manifest = {
    taskId: identifiers.taskId,
    sessionId: identifiers.sessionId,
    rootRunId: identifiers.rootRunId,
    workflowId: params.template.id,
    workflowDefinitionHash: hashWorkflowContent(
      fs.readFileSync(params.options.workflowEntry.template_path),
    ),
    briefHash: hashWorkflowContent(params.options.brief),
    teamDefinitionHashes: hashes,
    runtimeVersion: WORKFLOW_RUNTIME_VERSION,
  }

  let existing = await store.load()
  if (!existing) {
    existing = await store.initialize({
      manifest,
      executionAttemptId: identifiers.executionAttemptId,
      steps: seeds,
    })
    return { store, snapshot: existing, assignmentPath }
  }

  // Re-run initialization against the persisted owner to validate every
  // immutable definition before an attempted recovery can claim the journal.
  existing = await store.initialize({
    manifest,
    executionAttemptId: existing.state.ownerExecutionAttemptId,
    steps: seeds,
  })
  if (
    existing.state.ownerExecutionAttemptId !== identifiers.executionAttemptId &&
    !['completed', 'completed_with_warnings', 'blocked', 'failed', 'cancelled'].includes(existing.state.status)
  ) {
    if (params.options.continuationMode) {
      const agentQuestion = existing.state.agentQuestions?.interactions.find((candidate) => candidate.status === 'submitted')
      const interaction = existing.state.steps
        .map((step) => step.humanInput)
        .find((candidate) => candidate?.status === 'submitted')
      // A model-choice approval is the other thing a continuation can be
      // admitted for. It produces no human input, so a continuation that only
      // knew about human input stopped here without ever dispatching the step
      // the user had just authorized.
      // The step this admission is for, not merely the first that ever held an
      // approval. A predecessor that was approved and then completed still
      // carries its approval and its admission; claiming that one would
      // overwrite a settled record and leave the step actually waiting untouched.
      const approvedStep = interaction
        ? undefined
        : existing.state.steps.find(
            (step) =>
              step.approvedModelChoice &&
              step.modelChoiceContinuationAdmissionRequestId === undefined &&
              step.status !== 'completed' &&
              step.status !== 'completed_with_warnings' &&
              step.status !== 'failed' &&
              step.status !== 'cancelled',
          )
      if (!interaction && !approvedStep && !agentQuestion) {
        throw new Error(
          `Workflow '${params.template.id}' has no submitted human input to continue.`,
        )
      }
      if (!params.options.continuationAdmissionRequestId) {
        // Each case names what it was continuing. "Work to continue" would tell
        // an operator less than either sentence does, and the human-input
        // wording is already what its own callers report.
        throw new Error(
          interaction
            ? `Workflow '${params.template.id}' has submitted human input but continuation admission ID is missing.`
            : `Workflow '${params.template.id}' has an approved model choice but continuation admission ID is missing.`,
        )
      }
      const state = agentQuestion?.status === 'submitted'
        ? await store.claimAgentQuestionContinuation({
            interactionId: agentQuestion.interactionId, submissionId: agentQuestion.submission.submissionId,
            expectedOwnerExecutionAttemptId: existing.state.ownerExecutionAttemptId,
            nextExecutionAttemptId: identifiers.executionAttemptId,
            continuationAdmissionRequestId: params.options.continuationAdmissionRequestId,
          })
        : interaction
        ? await store.claimHumanInputContinuation({
            expectedRevision: existing.state.revision,
            interactionId: interaction.interactionId,
            expectedOwnerExecutionAttemptId: existing.state.ownerExecutionAttemptId,
            nextExecutionAttemptId: identifiers.executionAttemptId,
            continuationAdmissionRequestId: params.options.continuationAdmissionRequestId,
          })
        : approvedStep
        ? await store.claimModelChoiceContinuation({
            expectedRevision: existing.state.revision,
            stepId: approvedStep.stepId,
            expectedOwnerExecutionAttemptId: existing.state.ownerExecutionAttemptId,
            nextExecutionAttemptId: identifiers.executionAttemptId,
            continuationAdmissionRequestId: params.options.continuationAdmissionRequestId,
          })
        : undefined
      if (!state) {
        throw new Error(
          `Workflow '${params.template.id}' has no approved model-choice step to continue.`,
        )
      }
      existing = { manifest: existing.manifest, state }
    } else if (!params.options.recoveryMode) {
      throw new Error(
        `Workflow '${params.template.id}' is owned by another execution attempt.`,
      )
    } else {
      const state = await store.claimExecutionAttempt({
        expectedRevision: existing.state.revision,
        expectedOwnerExecutionAttemptId: existing.state.ownerExecutionAttemptId,
        nextExecutionAttemptId: identifiers.executionAttemptId,
      })
      existing = { manifest: existing.manifest, state }
    }
  }
  return { store, snapshot: existing, assignmentPath }
}

function publicStepStatus(
  status: DurableWorkflowStepState['status'],
): WorkflowExecutionStepResult['status'] {
  if (status === 'completed' || status === 'completed_with_warnings' || status === 'blocked') {
    return status
  }
  return 'failed'
}

async function durableStepResult(
  options: WorkflowRunnerOptions,
  step: DurableWorkflowStepState,
): Promise<WorkflowExecutionStepResult> {
  const assignmentPath = resolveWorkflowChildAssignmentPath(
    options,
    step.childRunId,
  )
  const references = step.artifacts ?? (step.artifact ? [step.artifact] : [])
  const artifacts = await Promise.all(references.map(async (artifact) => ({
    relativePath: artifact.relativePath,
    artifactPath: await verifyWorkflowArtifactReference(assignmentPath, artifact),
  })))
  const artifactPath = artifacts.find(
    (artifact) => artifact.relativePath === step.resultArtifact,
  )?.artifactPath
  return {
    stepId: step.stepId,
    status: publicStepStatus(step.status),
    requestedResultType: step.requestedResultType,
    assignmentPath,
    childSessionId: step.childRunId,
    summary: step.summary ?? step.error ?? '[No result returned]',
    cost: step.costUsd,
    ...(step.team ? { team: step.team } : {}),
    ...(artifactPath ? { artifactPath } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(step.costTracked === undefined ? {} : { costTracked: step.costTracked }),
  }
}

function durableWorkflowResult(params: {
  template: WorkflowTemplate
  state: DurableWorkflowState
  stepResults: WorkflowExecutionStepResult[]
}): WorkflowExecutionResult {
  const outcome = params.state.terminalOutcome
  if (!outcome) {
    throw new Error(
      `Terminal workflow '${params.template.id}' has no durable terminal outcome.`,
    )
  }
  const status = outcome.status === 'completed' || outcome.status === 'completed_with_warnings' || outcome.status === 'blocked'
    ? outcome.status
    : 'failed'
  const outputStep = params.stepResults.find(
    (step) => step.stepId === outcome.outputStepId,
  )
  const artifacts = outcome.artifacts?.map((published) => {
    const ownerStep = params.stepResults.find(
      (step) => step.stepId === published.stepId,
    )
    const artifactPath = ownerStep?.artifacts?.find(
      (artifact) => artifact.relativePath === published.artifact.relativePath,
    )?.artifactPath
    if (!artifactPath) {
      throw new Error(
        `Durable workflow '${params.template.id}' cannot resolve published artifact '${published.artifact.relativePath}'.`,
      )
    }
    return {
      stepId: published.stepId,
      relativePath: published.artifact.relativePath,
      artifactPath,
      role: published.role,
      ...(published.mediaType ? { mediaType: published.mediaType } : {}),
      ...(published.label ? { label: published.label } : {}),
    }
  })
  const primaryArtifact = outcome.primaryArtifact
    ? artifacts?.find((artifact) => artifact.role === 'primary')?.artifactPath ?? outputStep?.artifactPath
    : undefined
  const result: WorkflowExecutionResult = {
    workflowId: params.template.id,
    status,
    requestedResultType: outcome.requestedResultType,
    totalCost: params.state.totalCostUsd,
    steps: params.stepResults,
    summary: outcome.summary,
    ...(primaryArtifact
      ? { primaryArtifact }
      : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(status === 'blocked' || status === 'failed'
      ? workflowEscalation(params.template, outcome.outputStepId, status)
      : {}),
  }
  return result
}

function withWorkflowSummary(
  result: WorkflowExecutionResult,
): WorkflowExecutionResult {
  result.summary = summarizeWorkflowResult(result)
  return result
}

function buildTerminalOutcome(params: {
  result: WorkflowExecutionResult
  outputStepId: string
  primaryArtifact?: DurableWorkflowTerminalOutcome['primaryArtifact']
  artifacts?: DurableWorkflowTerminalOutcome['artifacts']
}): DurableWorkflowTerminalOutcome {
  return buildDurableWorkflowTerminalOutcome({
    workflowId: params.result.workflowId,
    status: params.result.status,
    summary: params.result.summary,
    requestedResultType:
      params.result.requestedResultType ?? 'artifact:unknown',
    outputStepId: params.outputStepId,
    ...(params.primaryArtifact ? { primaryArtifact: params.primaryArtifact } : {}),
    ...(params.artifacts && params.artifacts.length > 0
      ? { artifacts: params.artifacts }
      : {}),
    ...(params.result.primaryArtifact ? { primaryArtifactPath: params.result.primaryArtifact } : {}),
  })
}

function workflowFailureStep(params: {
  step: DurableWorkflowStepState
  options: WorkflowRunnerOptions
  status?: 'blocked' | 'failed'
  summary: string
}): WorkflowExecutionStepResult {
  return {
    stepId: params.step.stepId,
    status: params.status ?? 'failed',
    requestedResultType: params.step.requestedResultType,
    assignmentPath: resolveWorkflowChildAssignmentPath(
      params.options,
      params.step.childRunId,
    ),
    childSessionId: params.step.childRunId,
    summary: params.summary,
    cost: params.step.costUsd,
    ...(params.step.team ? { team: params.step.team } : {}),
    ...(params.step.costTracked === undefined ? {} : { costTracked: params.step.costTracked }),
  }
}

/** The durable record initialization seeded for the template step at this index. */
function requireDurableStep(
  state: DurableWorkflowState,
  stepIndex: number,
  stepId: string,
): DurableWorkflowStepState {
  const step = state.steps[stepIndex]
  if (!step) {
    throw new Error(`Workflow durable state has no record for step '${stepId}' at index ${stepIndex}.`)
  }
  return step
}

async function updateDurableState(
  context: DurableWorkflowContext,
  executionAttemptId: string,
  mutate: (state: DurableWorkflowState) => void,
): Promise<DurableWorkflowState> {
  const state = await context.store.update({
    expectedRevision: context.snapshot.state.revision,
    executionAttemptId,
    mutate,
  })
  context.snapshot = { ...context.snapshot, state }
  return state
}

async function commitReceiptToDurableState(params: {
  context: DurableWorkflowContext
  executionAttemptId: string
  receipt: WorkflowCompletionReceipt
  terminalOutcome?: DurableWorkflowTerminalOutcome
  onCommittedStep?: (
    state: DurableWorkflowState,
    step: DurableWorkflowStepState,
  ) => void
}): Promise<DurableWorkflowState> {
  return updateDurableState(params.context, params.executionAttemptId, (state) => {
    const step = state.steps.find((candidate) => candidate.stepId === params.receipt.stepId)
    if (!step) throw new Error(`Unknown durable workflow step '${params.receipt.stepId}'.`)
    step.status = params.receipt.status
    if (params.receipt.artifact) step.artifact = params.receipt.artifact
    else delete step.artifact
    if (params.receipt.artifacts) step.artifacts = params.receipt.artifacts
    else delete step.artifacts
    if (params.receipt.summary) step.summary = params.receipt.summary
    else delete step.summary
    if (params.receipt.status === 'failed' || params.receipt.status === 'blocked') {
      step.error = params.receipt.summary
    } else {
      delete step.error
    }
    step.costUsd = roundUsd(params.receipt.costUsd)
    if (params.receipt.costTracked === undefined) delete step.costTracked
    else step.costTracked = params.receipt.costTracked
    step.completedAt = params.receipt.completedAt
    state.totalCostUsd = roundUsd(state.steps.reduce((total, candidate) => total + candidate.costUsd, 0))
    delete state.currentStepId
    if (params.receipt.status === 'failed' || params.receipt.status === 'blocked') {
      state.status = params.receipt.status
      if (params.terminalOutcome) state.terminalOutcome = params.terminalOutcome
      else delete state.terminalOutcome
    } else {
      state.status = 'running'
    }
    params.onCommittedStep?.(state, step)
  })
}

async function commitTerminalOutcome(params: {
  context: DurableWorkflowContext
  executionAttemptId: string
  outcome: DurableWorkflowTerminalOutcome
}): Promise<DurableWorkflowState> {
  return updateDurableState(
    params.context,
    params.executionAttemptId,
    (state) => {
      state.status = params.outcome.status
      state.terminalOutcome = params.outcome
      delete state.currentStepId
    },
  )
}

async function pauseForHumanInput(params: {
  context: DurableWorkflowContext
  options: WorkflowRunnerOptions
  template: WorkflowTemplate
  step: WorkflowStep
  stepIndex: number
  executionAttemptId: string
}): Promise<never> {
  const { context, options, template, step, stepIndex, executionAttemptId } = params
  const persistedStep = context.snapshot.state.steps[stepIndex]
  if (!persistedStep || persistedStep.stepType !== 'human-in-the-loop') {
    throw new Error(`Workflow '${template.id}' has no durable human-input step '${step.id}'.`)
  }
  const interactionId = humanInputInteractionId(
    context.snapshot.manifest.taskId,
    template.id,
    step.id,
  )
  if (persistedStep.humanInput?.interactionId === interactionId) {
    throw new WorkflowAwaitingHumanInputError(
      persistedStep.humanInput,
      context.snapshot.state.revision,
    )
  }
  const handoff = step.handoff
  if (!handoff) {
    throw new Error(`Human-input step '${step.id}' requires a preceding artifact handoff.`)
  }
  const sourceStep = context.snapshot.state.steps.find(
    (candidate) => candidate.stepId === handoff.from_step,
  )
  const sourceArtifact = (sourceStep?.artifacts ?? (sourceStep?.artifact ? [sourceStep.artifact] : []))
    .find((artifact) => artifact.relativePath === handoff.from_artifact)
  if (!sourceArtifact) {
    throw new Error(
      `Human-input step '${step.id}' cannot find durable source artifact ` +
        `'${handoff.from_artifact}' from '${handoff.from_step}'.`,
    )
  }
  await verifyWorkflowArtifactReference(
    resolveWorkflowChildAssignmentPath(options, sourceArtifact.childRunId),
    sourceArtifact,
  )
  const successorStep = template.steps[stepIndex + 1]
  if (!successorStep) {
    throw new Error(`Human-input step '${step.id}' has no successor step to receive its feedback.`)
  }
  const state = await context.store.requestHumanInput({
    expectedRevision: context.snapshot.state.revision,
    executionAttemptId,
    stepId: step.id,
    interactionId,
    sourceArtifact,
    successorStepId: successorStep.id,
    eligibleRecipients: resolveHumanInputRecipients({
      template,
      stepIndex,
      teamRegistry: options.teamRegistry,
    }),
    ...(step.prompt !== undefined ? { prompt: step.prompt } : {}),
  })
  context.snapshot = { ...context.snapshot, state }
  const interaction = state.steps[stepIndex]?.humanInput
  if (!interaction) throw new Error(`Human-input step '${step.id}' did not persist an interaction.`)
  throw new WorkflowAwaitingHumanInputError(interaction, state.revision)
}

async function consumeSubmittedHumanInput(params: {
  context: DurableWorkflowContext
  options: WorkflowRunnerOptions
  template: WorkflowTemplate
  step: WorkflowStep
  stepIndex: number
  executionAttemptId: string
}): Promise<WorkflowExecutionStepResult> {
  const { context, options, template, step, stepIndex, executionAttemptId } = params
  const persistedStep = context.snapshot.state.steps[stepIndex]
  const interaction = persistedStep?.humanInput
  if (!persistedStep || !interaction?.submission || interaction.status !== 'submitted') {
    throw new Error(`Human-input step '${step.id}' is not ready to consume feedback.`)
  }
  await verifyWorkflowArtifactReference(
    resolveWorkflowChildAssignmentPath(options, interaction.sourceArtifact.childRunId),
    interaction.sourceArtifact,
  )
  const assignmentPath = resolveWorkflowChildAssignmentPath(options, persistedStep.childRunId)
  fs.mkdirSync(assignmentPath, { recursive: true })
  const feedbackPath = resolveOwnedRunRelativePath({
    assignmentPath,
    relativePath: persistedStep.resultArtifact,
    label: 'Human-input feedback artifact',
  })
  await writeFileAtomic(feedbackPath, `${JSON.stringify(feedbackEnvelope(interaction), null, 2)}\n`)
  const feedbackArtifact = await createWorkflowArtifactReference({
    childAssignmentPath: assignmentPath,
    childRunId: persistedStep.childRunId,
    relativePath: persistedStep.resultArtifact,
  })
  const receipt = await writeWorkflowCompletionReceipt(assignmentPath, {
    taskId: context.snapshot.manifest.taskId,
    rootRunId: context.snapshot.manifest.rootRunId,
    workflowId: template.id,
    stepId: step.id,
    childRunId: persistedStep.childRunId,
    executionAttemptId,
    status: 'completed',
    artifact: feedbackArtifact,
    artifacts: [feedbackArtifact],
    summary: interaction.submission.mode === 'continue_without_feedback'
      ? 'Continued without human feedback.'
      : 'Human feedback submitted.',
    costUsd: 0,
    costTracked: true,
    completedAt: new Date().toISOString(),
  })
  await commitReceiptToDurableState({
    context,
    executionAttemptId,
    receipt,
    onCommittedStep: (_state, durableStep) => {
      const humanInput = durableStep.humanInput
      if (!humanInput) {
        throw new Error(`Human-input step '${step.id}' lost its interaction before feedback was consumed.`)
      }
      humanInput.status = 'consumed'
      humanInput.feedbackArtifact = feedbackArtifact
    },
  })
  return durableStepResult(options, requireDurableStep(context.snapshot.state, stepIndex, step.id))
}

async function resolveWorkflowStepBriefWithHumanSource(params: {
  step: WorkflowStep
  initialBrief: string
  priorResults: WorkflowExecutionStepResult[]
  durable?: DurableWorkflowContext
  options: WorkflowRunnerOptions
}): Promise<{ brief: string; humanInputRouting?: HumanInputRoutingContext }> {
  const feedbackBrief = resolveWorkflowStepBrief({
    step: params.step,
    initialBrief: params.initialBrief,
    priorResults: params.priorResults,
  })
  const handoff = params.step.handoff
  if (!handoff || !params.durable) return { brief: feedbackBrief }
  const humanStep = params.durable.snapshot.state.steps.find(
    (candidate) => candidate.stepId === handoff.from_step,
  )
  const sourceArtifact = humanStep?.humanInput?.sourceArtifact
  if (!sourceArtifact || humanStep?.humanInput?.status !== 'consumed') {
    return { brief: feedbackBrief }
  }
  const sourcePreview = await readVerifiedWorkflowArtifactPreview(
    resolveWorkflowChildAssignmentPath(params.options, sourceArtifact.childRunId),
    sourceArtifact,
    MAX_HUMAN_INPUT_SOURCE_PROMPT_BYTES,
  )
  const sourceContents = sourcePreview.text.trim()
  const reviewedSource = sourcePreview.truncated
    ? [
        sourceContents,
        '',
        `[Reviewed source preview truncated to ${MAX_HUMAN_INPUT_SOURCE_PROMPT_BYTES.toLocaleString()} bytes.]`,
      ].join('\n')
    : sourceContents
  return {
    brief: [
      '## Reviewed Source',
      '',
      reviewedSource,
      '',
      '## Human Feedback',
      '',
      feedbackBrief,
    ].join('\n'),
    ...(humanStep.humanInput.submission
      ? {
          humanInputRouting: {
            interactionId: humanStep.humanInput.interactionId,
            source: sourceContents,
            messages: humanStep.humanInput.submission.messages.map((message) => ({
              id: message.id,
              text: message.text,
              recipients: message.recipients === 'all'
                ? 'all'
                : [...message.recipients],
            })),
          },
        }
      : {}),
  }
}

/** Execute a workflow while exposing its durable suspensions. */
export async function runWorkflowOutcome(
  options: WorkflowRunnerOptions,
): Promise<WorkflowRunOutcome> {
  try {
    return { kind: 'terminal', result: await runWorkflow(options) }
  } catch (error) {
    if (error instanceof WorkflowAwaitingAgentInputError) {
      return { kind: 'awaiting_agent_input', interaction: error.interaction, workflowRevision: error.workflowRevision }
    }
    if (error instanceof WorkflowAwaitingHumanInputError) {
      return {
        kind: 'awaiting_input',
        interaction: error.interaction,
        workflowRevision: error.workflowRevision,
      }
    }
    if (error instanceof WorkflowAwaitingModelChoiceError) {
      return {
        kind: 'awaiting_model_choice',
        offer: error.offer,
        stepId: error.stepId,
        workflowRevision: error.workflowRevision,
      }
    }
    throw error
  }
}

export async function runWorkflow(options: WorkflowRunnerOptions): Promise<WorkflowExecutionResult> {
  const parsed = parseWorkflowTemplate(options.workflowEntry.template_path)
  if (!parsed.template) {
    throw new Error(parsed.errors.join('; '))
  }

  const template: WorkflowTemplate = parsed.template
  const validationErrors = validateWorkflowTemplate(template, options.teamRegistry)
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join('; '))
  }

  const runTeamImpl = options.runTeamImpl ?? runTeam
  const stepResults: WorkflowExecutionStepResult[] = []
  const durable = await initializeDurableWorkflow({ options, template })
  const executionAttemptId = durableIdentifiers(options)?.executionAttemptId
  // Durable state exists only when durableIdentifiers found an execution
  // attempt, so every durable write below has one.
  const requireExecutionAttemptId = (): string => {
    if (!executionAttemptId) {
      throw new Error(`Workflow '${template.id}' has durable state but no execution attempt ID.`)
    }
    return executionAttemptId
  }
  let totalCost = durable?.snapshot.state.totalCostUsd ?? 0

  if (
    durable &&
    ['completed', 'completed_with_warnings', 'blocked', 'failed', 'cancelled'].includes(durable.snapshot.state.status)
  ) {
    for (const step of durable.snapshot.state.steps) {
      if (!['completed', 'completed_with_warnings', 'blocked', 'failed', 'cancelled'].includes(step.status)) continue
      stepResults.push(await durableStepResult(options, step))
    }
    return durableWorkflowResult({ template, state: durable.snapshot.state, stepResults })
  }

  for (const [stepIndex, step] of template.steps.entries()) {
    let durableStep = durable?.snapshot.state.steps[stepIndex]
    if (durable && durableStep && ['completed', 'completed_with_warnings', 'blocked', 'failed', 'cancelled'].includes(durableStep.status)) {
      stepResults.push(await durableStepResult(options, durableStep))
      totalCost = durable.snapshot.state.totalCostUsd
      if (durableStep.status === 'failed' || durableStep.status === 'blocked' || durableStep.status === 'cancelled') {
        return durableWorkflowResult({ template, state: durable.snapshot.state, stepResults })
      }
      continue
    }

    if (step.type === 'human-in-the-loop') {
      if (!durable || !executionAttemptId || !durableStep) {
        throw new Error('Human-in-the-loop workflow steps require durable task execution.')
      }
      if (durableStep.humanInput?.status === 'submitted') {
        stepResults.push(await consumeSubmittedHumanInput({
          context: durable,
          options,
          template,
          step,
          stepIndex,
          executionAttemptId,
        }))
        totalCost = durable.snapshot.state.totalCostUsd
        continue
      }
      await pauseForHumanInput({
        context: durable,
        options,
        template,
        step,
        stepIndex,
        executionAttemptId,
      })
    }

    const remainingBudget = options.budgetUsd === undefined
      ? undefined
      : Math.max(0, options.budgetUsd - totalCost)
    if (
      options.budgetPolicy === 'halt' &&
      options.budgetUsd !== undefined &&
      remainingBudget !== undefined &&
      remainingBudget <= 0
    ) {
      const message =
        `Workflow '${template.id}' cannot start step '${step.id}': ` +
        `budget $${options.budgetUsd.toFixed(2)} is exhausted.`
      if (durable) {
        const persistedStep = requireDurableStep(durable.snapshot.state, stepIndex, step.id)
        const workflowResult = withWorkflowSummary({
          workflowId: template.id,
          status: 'failed',
          requestedResultType: persistedStep.requestedResultType,
          totalCost,
          steps: [
            ...stepResults,
            workflowFailureStep({
              step: persistedStep,
              options,
              summary: message,
            }),
          ],
          summary: message,
          ...workflowEscalation(template, step.id, 'failed'),
        })
        await commitTerminalOutcome({
          context: durable,
          executionAttemptId: requireExecutionAttemptId(),
          outcome: buildTerminalOutcome({
            result: workflowResult,
            outputStepId: step.id,
          }),
        })
      }
      throw new Error(message)
    }

    const teamEntry = step.type === 'transform' || step.type === 'human-in-the-loop'
      ? undefined
      : requireTeamEntry(
          step.team === undefined ? undefined : options.teamRegistry.get(step.team),
          template.id,
          step.id,
        )
    const childContract = teamEntry ? resolveChildTeamContract(teamEntry) : undefined
    const runtimeOverrides = resolveStepRuntimeOverrides(step)
    const inputArtifact = step.handoff?.to_artifact || step.input_artifact || teamEntry?.input_artifact || 'incoming-brief.md'
    const resolvedBrief = await resolveWorkflowStepBriefWithHumanSource({
      step,
      initialBrief: options.brief,
      priorResults: stepResults,
      options,
      ...(durable ? { durable } : {}),
    })
    const brief = resolvedBrief.brief
    const provenanceMarkdown = step.provenance_handoff
      ? resolveWorkflowArtifactText({
          consumerStepId: step.id,
          source: step.provenance_handoff,
          priorResults: stepResults,
          purpose: 'provenance handoff',
        })
      : undefined
    const provenanceEvidenceGraphText =
      step.provenance_handoff?.evidence_graph_artifact
        ? resolveWorkflowArtifactText({
            consumerStepId: step.id,
            source: {
              from_step: step.provenance_handoff.from_step,
              from_artifact:
                step.provenance_handoff.evidence_graph_artifact,
            },
            priorResults: stepResults,
            purpose: 'provenance handoff',
          })
        : undefined
    let provenanceEvidenceGraph: unknown
    if (provenanceEvidenceGraphText !== undefined) {
      try {
        provenanceEvidenceGraph = JSON.parse(provenanceEvidenceGraphText)
      } catch {
        throw new Error(
          `Workflow provenance handoff failed for step '${step.id}': evidence graph is not valid JSON.`,
        )
      }
    }
    const contextMounts = step.context_handoffs?.map((source) => ({
      from: resolveWorkflowArtifactPath({
        consumerStepId: step.id,
        source,
        priorResults: stepResults,
        purpose: 'context handoff',
      }),
      to: source.to_artifact,
    }))
    const childWorkspacePath = options.workspacePath
    const selectedLevel = step.stage_type && childContract
      ? childContract.teamConfig.levels.find(
          (level) => level.stage.type === step.stage_type,
        )
      : undefined
    const entryLevelId = selectedLevel?.id ?? childContract?.teamConfig.workflow?.entry_level ?? childContract?.teamConfig.levels[0]?.id
    const entryLevel = childContract?.teamConfig.levels.find((level) => level.id === entryLevelId)
    const stepBudget = template.id === 'deep-research-report' && step.id === 'research'
      ? resolveAdaptiveResearchBudget({
          brief,
          ...(remainingBudget === undefined ? {} : { parentRemainingBudgetUsd: remainingBudget }),
        })
      : remainingBudget

    const durablePreviousStatus = durableStep?.status
    const resumingAgentQuestion = durable?.snapshot.state.agentQuestions?.interactions.some((interaction) =>
      interaction.stepId === step.id && interaction.status === 'resuming' &&
      interaction.continuation.executionAttemptId === executionAttemptId,
    ) ?? false
    if (durable && durableStep && durableStep.status !== 'pending' && !resumingAgentQuestion) {
      const childAssignmentPath = resolveWorkflowChildAssignmentPath(
        options,
        durableStep.childRunId,
      )
      const receipt = await readWorkflowCompletionReceipt(childAssignmentPath, {
        taskId: durable.snapshot.manifest.taskId,
        rootRunId: durable.snapshot.manifest.rootRunId,
        workflowId: template.id,
        stepId: step.id,
        childRunId: durableStep.childRunId,
      })
      if (receipt) {
        if (durableStep.status !== 'running') {
          if (durableStep.status === 'indeterminate') {
            await updateDurableState(durable, requireExecutionAttemptId(), (state) => {
              requireDurableStep(state, stepIndex, step.id).status = 'launching'
              state.status = 'running'
              state.currentStepId = step.id
            })
          }
          await updateDurableState(durable, requireExecutionAttemptId(), (state) => {
            requireDurableStep(state, stepIndex, step.id).status = 'running'
            state.status = 'running'
            state.currentStepId = step.id
          })
        }
        const terminalResult = receipt.status === 'failed' || receipt.status === 'blocked'
          ? withWorkflowSummary({
              workflowId: template.id,
              status: receipt.status,
              requestedResultType: durableStep.requestedResultType,
              totalCost: roundUsd(totalCost + receipt.costUsd),
              steps: [
                ...stepResults,
                workflowFailureStep({
                  step: {
                    ...durableStep,
                    costUsd: receipt.costUsd,
                    ...(receipt.costTracked === undefined ? {} : { costTracked: receipt.costTracked }),
                  },
                  options,
                  status: receipt.status,
                  summary: receipt.summary,
                }),
              ],
              summary: receipt.summary,
              ...workflowEscalation(template, step.id, receipt.status),
            })
          : undefined
        await commitReceiptToDurableState({
          context: durable,
          executionAttemptId: requireExecutionAttemptId(),
          receipt,
          ...(terminalResult
            ? { terminalOutcome: buildTerminalOutcome({
                result: terminalResult,
                outputStepId: step.id,
              }) }
            : {}),
        })
        durableStep = requireDurableStep(durable.snapshot.state, stepIndex, step.id)
        stepResults.push(await durableStepResult(options, durableStep))
        totalCost = durable.snapshot.state.totalCostUsd
        if (receipt.status === 'failed' || receipt.status === 'blocked') {
          return durableWorkflowResult({ template, state: durable.snapshot.state, stepResults })
        }
        continue
      }

      if (durableStep.recoveryPolicy === 'never_retry') {
        const reason = `Workflow step '${step.id}' was interrupted without a completion receipt and is marked never retry.`
        const blockedStep = workflowFailureStep({
          step: durableStep,
          options,
          status: 'blocked',
          summary: reason,
        })
        const workflowResult = withWorkflowSummary({
          workflowId: template.id,
          status: 'blocked',
          requestedResultType: durableStep.requestedResultType,
          totalCost,
          steps: [...stepResults, blockedStep],
          summary: reason,
          ...workflowEscalation(template, step.id, 'blocked'),
        })
        await updateDurableState(durable, requireExecutionAttemptId(), (state) => {
          const persisted = requireDurableStep(state, stepIndex, step.id)
          persisted.status = 'blocked'
          persisted.summary = reason
          persisted.error = reason
          persisted.completedAt = new Date().toISOString()
          state.status = 'blocked'
          state.terminalOutcome = buildTerminalOutcome({
            result: workflowResult,
            outputStepId: step.id,
          })
          delete state.currentStepId
        })
        stepResults.push(await durableStepResult(options, requireDurableStep(durable.snapshot.state, stepIndex, step.id)))
        return durableWorkflowResult({ template, state: durable.snapshot.state, stepResults })
      }
    }

    if (durable && durableStep && !resumingAgentQuestion) {
      await updateDurableState(durable, requireExecutionAttemptId(), (state) => {
        const persisted = requireDurableStep(state, stepIndex, step.id)
        persisted.status = 'launching'
        persisted.attemptCount += 1
        persisted.startedAt = new Date().toISOString()
        delete persisted.completedAt
        delete persisted.error
        state.status = 'running'
        state.currentStepId = persisted.stepId
      })
      await updateDurableState(durable, requireExecutionAttemptId(), (state) => {
        requireDurableStep(state, stepIndex, step.id).status = 'running'
      })
      durableStep = durable.snapshot.state.steps[stepIndex]
    }

    logWorkflowStepEvent(options, 'workflow.step.started', {
      workflow_id: template.id,
      step_id: step.id,
      step_index: stepIndex,
      team: step.team,
      target_type: step.type,
      agent: step.agent,
      stage_type: step.stage_type,
      input_artifact: inputArtifact,
      output_artifact: step.result_artifact || teamEntry?.output_artifact || '',
      output_artifacts: workflowStepResultArtifacts(step),
    })
    // The approval the user gave, in force for this dispatch and no other.
    //
    // Published rather than merged: nothing writes it into the team config or
    // the roster, so it cannot become a configuration layer. The child process
    // reads it from the environment this sets, and the `finally` below takes
    // it away again so it can never leak into a later step.
    const stepAuthorization = durableStep?.approvedModelChoice
    if (stepAuthorization) setRuntimeApprovedModelChoice(stepAuthorization)
    let result: Awaited<ReturnType<typeof runTeam>>
    try {
      result = step.type === 'transform'
        ? await runWorkflowTransformStep({
            options,
            template,
            step,
            brief,
            inputArtifact,
            ...(provenanceMarkdown ? { provenanceMarkdown } : {}),
            ...(provenanceEvidenceGraph === undefined ? {} : { provenanceEvidenceGraph }),
            ...(durableStep ? { childSessionId: durableStep.childRunId } : {}),
          })
        : !teamEntry
        ? throwMissingDispatchTeamEntry(template.id, step.id)
        : step.type === 'agent'
        ? await runWorkflowAgentStep({
            options,
            template,
            step,
            teamEntry,
            brief,
            inputArtifact,
            ...(durableStep ? { childSessionId: durableStep.childRunId } : {}),
            ...whenDefined(durableStep?.attemptCount, (attempt) => ({ attempt })),
            recoveryMode:
              durablePreviousStatus !== undefined && durablePreviousStatus !== 'pending',
          })
        : await runTeamImpl({
            teamPath: teamEntry.team_path,
            workspacePath: childWorkspacePath,
            workspacePathOverride: options.workspacePath,
            brief,
            bootEntry: teamEntry,
            inputArtifact,
            outputArtifact: step.result_artifact || teamEntry.output_artifact || '',
            requestedResultType: options.executionMode === 'team-chat'
              ? 'chat:messages'
              : step.requested_result_type ?? `artifact:${step.result_artifact}`,
            workflowId: template.id,
            workflowStepId: step.id,
            spawnDepth: options.spawnDepth,
            recoveryMode: durablePreviousStatus !== undefined && durablePreviousStatus !== 'pending',
            ...(resolvedBrief.humanInputRouting ? { humanInputRouting: resolvedBrief.humanInputRouting } : {}),
            ...(entryLevel ? { kickoffPrompt: buildStageEntryFollowUp(entryLevel, inputArtifact, brief) } : {}),
            ...(contextMounts?.length ? { mount: contextMounts } : {}),
            ...(runtimeOverrides ? { runtimeOverrides } : {}),
            ...(durableStep ? { childSessionId: durableStep.childRunId } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(stepBudget === undefined ? {} : { budgetUsd: stepBudget }),
            ...(options.budgetPolicy ? { budgetPolicy: options.budgetPolicy } : {}),
            ...(options.rootSessionId ? { rootSessionId: options.rootSessionId } : {}),
            ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
            ...(options.assignmentLocation ? { parentAssignmentLocation: options.assignmentLocation } : {}),
            ...(durableStep?.idempotencyKey ? { idempotencyKey: durableStep.idempotencyKey } : {}),
            ...(options.executionMode ? { executionMode: options.executionMode } : {}),
          })
    } catch (error) {
      if (durable && durableStep) {
        const summary = error instanceof Error ? error.message : String(error)
        const childAssignmentPath = resolveWorkflowChildAssignmentPath(
          options,
          durableStep.childRunId,
        )
        // A step whose Team subtree could not be verified gone fails (the
        // owner's T5 decision): a retry offered now would run beside
        // processes that may still be running.
        if (!(error instanceof HeldSubtreeError)) {
          await offerModelChoiceBeforeTerminal({
            options,
            durable,
            durableStep,
            executionAttemptId: requireExecutionAttemptId(),
            stepId: step.id,
            childAssignmentPath,
          })
        }
        const receipt = await writeWorkflowCompletionReceipt(childAssignmentPath, {
          taskId: durable.snapshot.manifest.taskId,
          rootRunId: durable.snapshot.manifest.rootRunId,
          workflowId: template.id,
          stepId: step.id,
          childRunId: durableStep.childRunId,
          executionAttemptId: requireExecutionAttemptId(),
          status: 'failed',
          summary,
          costUsd: 0,
        })
        crashAfterReceiptForTest(step.id)
        const workflowResult = withWorkflowSummary({
          workflowId: template.id,
          status: 'failed',
          requestedResultType: durableStep.requestedResultType,
          totalCost,
          steps: [
            ...stepResults,
            workflowFailureStep({
              step: durableStep,
              options,
              summary,
            }),
          ],
          summary,
          ...workflowEscalation(template, step.id, 'failed'),
        })
        await commitReceiptToDurableState({
          context: durable,
          executionAttemptId: requireExecutionAttemptId(),
          receipt,
          terminalOutcome: buildTerminalOutcome({
            result: workflowResult,
            outputStepId: step.id,
          }),
        })
      }
      throw error
    } finally {
      // Taken away however this dispatch ended. An authorization that outlived
      // its step would silently cover a later one the user never saw.
      if (stepAuthorization) clearRuntimeApprovedModelChoice()
    }

    if (result.interruption?.kind === 'awaiting_input' && durable && durableStep && executionAttemptId) {
      const interactionId = result.interruption.interactionId
      const snapshot = await durable.store.load()
      const interaction = snapshot?.state.agentQuestions?.interactions.find((candidate) =>
        candidate.interactionId === interactionId && candidate.stepId === step.id &&
        (candidate.invocation.workflowChildRunId ?? candidate.invocation.childRunId) === result.childSessionId && (candidate.status === 'pending' || candidate.status === 'submitted'),
      )
      if (!snapshot || !interaction) throw new Error('Child wait has no canonical agent question.')
      const waiting = await durable.store.pauseAgentQuestion({ interactionId, executionAttemptId })
      throw new WorkflowAwaitingAgentInputError(interaction, waiting.revision)
    }
    if ((resumingAgentQuestion || result.interruption?.kind === 'blocked') && durable && durableStep) {
      // The worker accepts the resumed response in the same journal while the
      // child is running. Use that revision for the receipt, retaining both
      // the execution fence and the completed interaction instead of retrying
      // a stale whole-state write.
      const snapshot = await durable.store.load()
      const resumedStep = snapshot?.state.steps.find((candidate) => candidate.stepId === step.id)
      if (!snapshot || snapshot.state.ownerExecutionAttemptId !== executionAttemptId ||
          snapshot.state.status !== 'running' || resumedStep?.status !== 'running' ||
          resumedStep.childRunId !== durableStep.childRunId) {
        throw new Error('Agent-question completion no longer owns the running workflow step.')
      }
      durable.snapshot = snapshot
      durableStep = resumedStep
    }
    totalCost = roundUsd(totalCost + result.cost)
    const parsedResult = parseMarkdownArtifact(result.text)
    let summary = parsedResult.body.trim() || result.text.trim() || '[No result returned]'
    // The child's own verdict, kept apart from the checks below that can
    // overrule it. Only a failure the child itself reported can earn an offer:
    // the runner's own rejections describe a result that arrived from an
    // unexpected place or cost more than the run may spend, and a different
    // model is not an answer to either.
    const childReportedStatus = inferStatusFromChildResult({ result })
    let status = childReportedStatus
    let artifactPath = result.artifactPath || undefined
    let artifacts: WorkflowExecutionStepResult['artifacts']
    const childIdentityMismatch =
      durableStep !== undefined &&
      (
        result.childSessionId !== durableStep.childRunId ||
        path.resolve(result.assignmentPath) !== path.resolve(
          resolveWorkflowChildAssignmentPath(options, durableStep.childRunId),
        )
      )
    if (childIdentityMismatch) {
      status = 'failed'
      summary = `Workflow child identity contract failed for step '${step.id}'.`
      artifactPath = undefined
    } else if (
      (status === 'completed' || status === 'completed_with_warnings') &&
      options.budgetPolicy === 'halt' &&
      result.costTracked !== true
    ) {
      status = 'failed'
      summary =
        `Workflow budget enforcement stopped after step '${step.id}': ` +
        'the child run did not report a tracked USD cost.'
    } else if (
      (status === 'completed' || status === 'completed_with_warnings') &&
      options.budgetPolicy === 'halt' &&
      options.budgetUsd !== undefined &&
      totalCost >= options.budgetUsd
    ) {
      status = 'failed'
      summary =
        `Workflow budget limit reached after step '${step.id}': ` +
        `$${totalCost.toFixed(2)} >= $${options.budgetUsd.toFixed(2)}. ` +
        'No further workflow steps were started.'
    }
    if (status === 'completed' || status === 'completed_with_warnings') {
      const artifactContracts: WorkflowArtifactContract[] = options.executionMode === 'team-chat'
        ? []
        : [
        ...workflowStepResultArtifacts(step).map((relativePath) => ({
        relativePath,
        ...resolveExpectedArtifact(result.assignmentPath, relativePath),
        })),
        ...(step.result_artifact_globs ?? []).flatMap((artifactGlob) =>
          resolveGlobArtifactContracts(result.assignmentPath, artifactGlob),
        ),
        ...(step.optional_result_artifact_globs ?? []).flatMap((artifactGlob) =>
          resolveExpectedArtifactsMatchingGlob(result.assignmentPath, artifactGlob),
        ),
      ]
      const failedContract = artifactContracts.find(
        (contract): contract is { relativePath: string; artifactPath?: string; error: string } =>
          'error' in contract && typeof contract.error === 'string',
      )
      if (failedContract?.error) {
        status = 'failed'
        summary = `Workflow artifact contract failed for step '${step.id}': ${failedContract.error}.`
        artifactPath = undefined
      } else {
        artifacts = artifactContracts.map((contract) => {
          if (!contract.artifactPath) {
            throw new Error(
              `Workflow artifact contract for step '${step.id}' resolved no path for '${contract.relativePath}'.`,
            )
          }
          return { relativePath: contract.relativePath, artifactPath: contract.artifactPath }
        })
        artifactPath = artifacts.find(
          (artifact) => artifact.relativePath === step.result_artifact,
        )?.artifactPath
      }
    }

    const currentStepResult: WorkflowExecutionStepResult = {
      stepId: step.id,
      status,
      requestedResultType:
        options.executionMode === 'team-chat'
          ? 'chat:messages'
          : durableStep?.requestedResultType ??
            result.requestedResultType ??
            step.requested_result_type ??
            `artifact:${step.result_artifact}`,
      assignmentPath: result.assignmentPath,
      childSessionId: result.childSessionId,
      summary,
      cost: result.cost,
      ...(step.team ? { team: step.team } : {}),
      ...(artifactPath ? { artifactPath } : {}),
      ...(artifacts ? { artifacts } : {}),
      ...(result.costTracked === undefined ? {} : { costTracked: result.costTracked }),
    }

    if (durable && durableStep) {
      const childAssignmentPath = resolveWorkflowChildAssignmentPath(
        options,
        durableStep.childRunId,
      )
      // The same pre-terminal decision the thrown path makes, for the shape of
      // failure a child team actually produces. An identity mismatch is
      // excluded because that result did not come from this step's own child,
      // so its run log is not this step's evidence to act on.
      if (
        !childIdentityMismatch &&
        (childReportedStatus === 'failed' || childReportedStatus === 'blocked')
      ) {
        await offerModelChoiceBeforeTerminal({
          options,
          durable,
          durableStep,
          executionAttemptId: requireExecutionAttemptId(),
          stepId: step.id,
          childAssignmentPath,
        })
      }
      const artifactReferences = status === 'completed' || status === 'completed_with_warnings'
        ? await Promise.all((artifacts ?? []).map((artifact) =>
            createWorkflowArtifactReference({
              childAssignmentPath,
              childRunId: durableStep.childRunId,
              relativePath: artifact.relativePath,
            }),
          ))
        : undefined
      const artifact = artifactReferences?.[0]
      const receipt = await writeWorkflowCompletionReceipt(childAssignmentPath, {
        taskId: durable.snapshot.manifest.taskId,
        rootRunId: durable.snapshot.manifest.rootRunId,
        workflowId: template.id,
        stepId: step.id,
        childRunId: durableStep.childRunId,
        executionAttemptId: requireExecutionAttemptId(),
        status,
        requestedResultType: currentStepResult.requestedResultType,
        summary,
        costUsd: result.cost,
        ...(artifact ? { artifact } : {}),
        ...(artifactReferences && artifactReferences.length > 0
          ? { artifacts: artifactReferences }
          : {}),
        ...(result.costTracked === undefined ? {} : { costTracked: result.costTracked }),
      })
      crashAfterReceiptForTest(step.id)
      const terminalResult = status === 'failed' || status === 'blocked'
        ? withWorkflowSummary({
            workflowId: template.id,
            status,
            ...(artifactPath ? { primaryArtifact: artifactPath } : {}),
            requestedResultType: currentStepResult.requestedResultType,
            totalCost,
            steps: [...stepResults, currentStepResult],
            summary,
            ...workflowEscalation(template, step.id, status),
          })
        : undefined
      await commitReceiptToDurableState({
        context: durable,
        executionAttemptId: requireExecutionAttemptId(),
        receipt,
        ...(terminalResult
          ? { terminalOutcome: buildTerminalOutcome({
              result: terminalResult,
              outputStepId: step.id,
            }) }
          : {}),
      })
      totalCost = durable.snapshot.state.totalCostUsd
    }

    stepResults.push(currentStepResult)

    logWorkflowStepEvent(
      options,
      status === 'failed' || status === 'blocked'
        ? 'workflow.step.failed'
        : 'workflow.step.completed',
      {
        workflow_id: template.id,
        step_id: step.id,
        step_index: stepIndex,
        team: step.team,
        target_type: step.type,
        agent: step.agent,
        stage_type: step.stage_type,
        status,
        child_run_id: result.childSessionId,
        child_assignment_path: result.assignmentPath,
        input_artifact: inputArtifact,
        output_artifact: toStepArtifactRef(result.assignmentPath, artifactPath) || step.result_artifact || teamEntry?.output_artifact || '',
        output_artifacts: artifacts?.map((artifact) => artifact.relativePath),
        requested_result_type: result.requestedResultType ?? step.requested_result_type ?? `artifact:${step.result_artifact}`,
        cost: result.cost,
      },
    )

    if (status === 'failed' || status === 'blocked') {
      const workflowResult: WorkflowExecutionResult = {
        workflowId: template.id,
        status,
        ...(artifactPath ? { primaryArtifact: artifactPath } : {}),
        requestedResultType: result.requestedResultType ?? step.requested_result_type ?? `artifact:${step.result_artifact}`,
        totalCost,
        steps: stepResults,
        summary,
        ...workflowEscalation(template, step.id, status),
      }
      workflowResult.summary = summarizeWorkflowResult(workflowResult)
      return workflowResult
    }
  }

  const outputDefinitions = options.executionMode === 'team-chat'
    ? []
    : workflowOutputArtifacts(template).filter((output) => output.role !== 'primary' || !template.output.primary_artifact_globs?.length)
  const publishedArtifacts: NonNullable<WorkflowExecutionResult['artifacts']> = []
  let outputFailure: { step: WorkflowExecutionStepResult; error: string } | undefined
  for (const output of outputDefinitions) {
    const sourceStep = stepResults.find((step) => step.stepId === output.from_step)
    if (!sourceStep) {
      throw new Error(
        `Workflow '${template.id}' completed without output step '${output.from_step}'.`,
      )
    }
    const outputContract = resolveExpectedArtifact(
      sourceStep.assignmentPath,
      output.artifact,
    )
    if (outputContract.error) {
      outputFailure = { step: sourceStep, error: outputContract.error }
      break
    }
    if (!outputContract.artifactPath) {
      throw new Error(
        `Workflow '${template.id}' output '${output.artifact}' resolved no path.`,
      )
    }
    const mediaType = output.media_type ?? artifactMediaType(output.artifact)
    publishedArtifacts.push({
      stepId: output.from_step,
      relativePath: output.artifact,
      artifactPath: outputContract.artifactPath,
      role: output.role,
      ...(mediaType ? { mediaType } : {}),
      ...(output.label ? { label: output.label } : {}),
    })
  }
  const globOutputDefinitions = options.executionMode === 'team-chat'
    ? []
    : [
        ...(template.output.primary_artifact_globs ?? []).map((output) => ({ ...output, role: 'primary' as const })),
        ...(template.output.secondary_artifact_globs ?? []).map((output) => ({ ...output, role: 'secondary' as const })),
      ]
  for (const output of globOutputDefinitions) {
    const fromStep = output.from_step ?? template.output.from_step
    const sourceStep = stepResults.find((step) => step.stepId === fromStep)
    if (!sourceStep) {
      throw new Error(
        `Workflow '${template.id}' completed without output step '${fromStep}'.`,
      )
    }
    // Select from what the step recorded at completion rather than re-walking
    // the directory. The step already resolved, hashed, and sealed these paths;
    // a second scan could disagree with that durable record and fail the
    // publish after every expensive stage has already succeeded.
    for (const artifact of sourceStep.artifacts ?? []) {
      if (!artifactPathMatchesGlob(artifact.relativePath, output.glob)) continue
      const mediaType = output.media_type ?? artifactMediaType(artifact.relativePath)
      publishedArtifacts.push({
        stepId: fromStep,
        relativePath: artifact.relativePath,
        artifactPath: artifact.artifactPath,
        role: output.role,
        ...(mediaType ? { mediaType } : {}),
        ...(output.label ? { label: output.label } : {}),
      })
    }
  }

  const terminalStep = stepResults.find((step) => step.stepId === template.output.from_step) ?? stepResults[stepResults.length - 1]
  if (!terminalStep) {
    throw new Error(`Workflow '${template.id}' completed without a terminal step result.`)
  }
  if (options.executionMode !== 'team-chat' && template.output.primary_artifact_globs?.length && !publishedArtifacts.some((artifact) => artifact.role === 'primary')) {
    outputFailure = { step: terminalStep, error: 'No requested primary document was produced' }
  }
  if (outputFailure) {
    outputFailure.step.status = 'failed'
    outputFailure.step.summary = `Workflow output contract failed: ${outputFailure.error}.`
    const workflowResult = withWorkflowSummary({
      workflowId: template.id,
      status: 'failed',
      requestedResultType: `artifact:${template.output.artifact}`,
      totalCost,
      steps: stepResults,
      summary: '',
      ...workflowEscalation(template, outputFailure.step.stepId, 'failed'),
    })
    if (durable) {
      await commitTerminalOutcome({
        context: durable,
        executionAttemptId: requireExecutionAttemptId(),
        outcome: buildTerminalOutcome({
          result: workflowResult,
          outputStepId: outputFailure.step.stepId,
        }),
      })
    }
    return workflowResult
  }
  const finalStatus = stepResults.some((step) => step.status === 'completed_with_warnings')
    ? 'completed_with_warnings'
    : 'completed'
  const primaryArtifact = publishedArtifacts.find((artifact) => artifact.role === 'primary')?.artifactPath
  const workflowResult = withWorkflowSummary({
    workflowId: template.id,
    status: finalStatus,
    artifacts: publishedArtifacts,
    requestedResultType: options.executionMode === 'team-chat'
      ? 'chat:messages'
      : `artifact:${template.output.artifact}`,
    totalCost,
    steps: stepResults,
    summary: '',
    ...(primaryArtifact ? { primaryArtifact } : {}),
  })
  if (durable) {
    const publishedReferences: NonNullable<DurableWorkflowTerminalOutcome['artifacts']> = publishedArtifacts.map(
      (output) => {
        const outputStep = durable.snapshot.state.steps.find(
          (step) => step.stepId === output.stepId,
        )
        const artifact = outputStep?.artifacts?.find(
          (candidate) => candidate.relativePath === output.relativePath,
        ) ?? (outputStep?.artifact?.relativePath === output.relativePath
          ? outputStep.artifact
          : undefined)
        if (!artifact) {
          throw new Error(
            `Workflow '${template.id}' cannot publish durable artifact '${output.relativePath}'.`,
          )
        }
        return {
          stepId: output.stepId,
          role: output.role,
          artifact,
          ...(output.mediaType ? { mediaType: output.mediaType } : {}),
          ...(output.label ? { label: output.label } : {}),
        }
      },
    )
    const primaryReference = publishedReferences.find(
      (published) => published.role === 'primary',
    )?.artifact
    await commitTerminalOutcome({
      context: durable,
      executionAttemptId: requireExecutionAttemptId(),
      outcome: buildTerminalOutcome({
        result: workflowResult,
        outputStepId: template.output.from_step,
        ...whenDefined(primaryReference, (primaryArtifact) => ({ primaryArtifact })),
        artifacts: publishedReferences,
      }),
    })
  }
  return workflowResult
}
