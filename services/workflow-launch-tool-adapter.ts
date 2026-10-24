import type { WorkflowModelSelection } from '../contracts/workflow-model-selection.js'
import { z } from 'zod/v4'

import { serialCapabilityEffect } from '../contracts/capability-effect.js'
import type { WorkspaceProjectContextSelection } from '../contracts/projects.js'
import type { RunPlan } from '../contracts/run-plan.js'
import type { SessionTask, SessionTaskSourceTurn } from '../contracts/sessions.js'
import { whenDefined } from '../core/optional-properties.js'
import type { BuiltinAgentToolAdapter } from '../domains/mcp/builtin-agent-tool-adapter.js'
import type { SessionStore } from '../domains/sessions/session-store.js'
import type { WorkspaceProjectService } from '../domains/projects/workspace-project-service.js'
import type { WorkspaceProjectContextStore } from '../domains/projects/project-context-store.js'
import {
  applyRunPlanService,
  assertWorkflowLaunchable,
  createRunPlanService,
  listWorkflowEntriesForPlanning,
  type RunPlanTaskQueue,
} from './run-orchestrator-service.js'
import { ServiceError } from './service-errors.js'
import { TaskQueueError } from './task-queue.js'
import type { WorkflowMcpPreflightService } from './workflow-mcp-preflight-service.js'

const workflowLaunchRequestSchema = z.object({
  workflowId: z.string().trim().min(1).max(200),
})

export const WORKFLOW_LAUNCH_ACTIVATION_PROMPT = [
  'Workflow launch activation:',
  '- Call start_workflow only when the user\'s latest message is an unambiguous confirmation (for example "go for it", "start", or "yes, run it") of a Workflow already proposed in this conversation, passing the exact registered workflow id.',
  '- Never call it on a first request, a question, a conditional, or when the user added new requirements.',
  '- The tool verifies that this conversation actually proposed that Workflow — a persisted plan selecting it, or your own earlier proposal naming its exact id — and refuses otherwise. The user naming a workflow is a request, not a proposal.',
  '- Report that the Workflow started only after the tool confirms it. If the tool refuses, relay why instead and ask for what is missing.',
].join('\n')

/** What a confirmed launch produced, handed to the turn that owns the tool. */
export interface WorkflowLaunchOutcome {
  readonly task: SessionTask
  readonly plan: RunPlan
}

type LaunchResult =
  | { readonly ok: true; readonly task: SessionTask; readonly plan: RunPlan }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly requiredInputs?: readonly string[] }

/**
 * The launch collaborators the adapter acts through. `launch` takes the same
 * shape, so the factory's options pass straight down.
 */
interface WorkflowLaunchOptions {
  sessionId: string
  sessionStore: SessionStore
  repoRootPath: string
  workspacePath?: string
  workflowsRegistryPath?: string
  taskQueue?: RunPlanTaskQueue
  mcpWorkflowPreflightService?: Pick<WorkflowMcpPreflightService, 'resolve'>
  /** The turn's project selection, sealed into the admitted task. */
  projectContext?: WorkspaceProjectContextSelection
  workspaceProjectService?: Pick<WorkspaceProjectService, 'getProjectRecord' | 'getSession'>
  workspaceProjectContextStore?: WorkspaceProjectContextStore
  /** Results this turn carries forward, folded into the task brief. */
  continuationContext?: string
  /** The user's latest message; the launch instruction, and the plan's goal. */
  goal: string
  sourceTurn?: SessionTaskSourceTurn
  workerModel?: WorkflowModelSelection
  onLaunched?: (outcome: WorkflowLaunchOutcome) => void
}

/**
 * The front door's chat-confirmed Workflow launch.
 *
 * Modeled on the dialogue adapter: one turn-scoped builtin, mutating, with the
 * durable store as the admission authority. A repeated call in the same turn
 * shares the first call's in-flight result, and a later turn finds the plan
 * already applied — `applyRunPlanService` resolves the existing task either
 * way, so a double call can never start the work twice.
 */
export function createWorkflowLaunchToolAdapter(options: WorkflowLaunchOptions): BuiltinAgentToolAdapter {
  let inFlight: { workflowId: string; result: Promise<LaunchResult> } | undefined
  return {
    name: 'start_workflow',
    tool: {
      serverId: 'workflow-launch',
      serverName: 'Workflow launch',
      toolName: 'start_workflow',
      namespacedName: 'start_workflow',
      description:
        'Start a Workflow you already proposed, after the user clearly confirms in chat. ' +
        'Pass the exact registered workflow id. The tool refuses when the workflow is unknown, ' +
        'when the plan still needs details, or when nothing was proposed — relay the reason.',
      inputSchema: z.toJSONSchema(workflowLaunchRequestSchema, { io: 'input' }),
      annotations: { readOnlyHint: false, destructiveHint: false },
      risk: 'mutating',
      effect: serialCapabilityEffect('mutating'),
      requiresApproval: false,
    },
    isEnabledForAgent: () => true,
    async execute(input) {
      input.signal?.throwIfAborted()
      const parsed = workflowLaunchRequestSchema.safeParse(input.input)
      if (!parsed.success) {
        return refusal('bad_request', parsed.error.issues[0]?.message ?? 'Invalid workflow launch request')
      }
      const workflowId = parsed.data.workflowId
      // One launch per turn. A repeated call for the same Workflow observes the
      // first call's outcome; a second, different Workflow would have to
      // replace the plan the first one just launched from.
      if (inFlight) {
        if (inFlight.workflowId !== workflowId) {
          return refusal(
            'workflow_launch_active',
            `This turn is already launching ${inFlight.workflowId}; one Workflow starts per confirmation.`,
          )
        }
        return report(await inFlight.result)
      }
      const result = launch(options, workflowId)
      inFlight = { workflowId, result }
      const settled = await result
      // A refusal decides nothing durably; a corrected call must be allowed.
      if (!settled.ok) inFlight = undefined
      return report(settled)
    },
  }

  function report(result: LaunchResult) {
    if (!result.ok) {
      return refusal(result.code, result.message, result.requiredInputs)
    }
    options.onLaunched?.({ task: result.task, plan: result.plan })
    const output = {
      code: 'started' as const,
      message: `Workflow ${result.task.workflowId} started.`,
      task: result.task,
      plan: result.plan,
    }
    return { output, content: JSON.stringify(output), isError: false }
  }
}

async function launch(
  options: Omit<WorkflowLaunchOptions, 'onLaunched'>,
  workflowId: string,
): Promise<LaunchResult> {
  try {
    const known = listWorkflowEntriesForPlanning({
      repoRootPath: options.repoRootPath,
      ...whenDefined(options.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
    }).map((workflow) => workflow.id)
    if (!known.includes(workflowId)) {
      return {
        ok: false,
        code: 'bad_request',
        message: `Unknown workflow: ${workflowId}. Registered workflows: ${known.join(', ') || '(none)'}.`,
      }
    }
    assertWorkflowLaunchable({
      repoRootPath: options.repoRootPath,
      ...whenDefined(options.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
      workflowId,
    })

    // The structural half of the confirmation rule. Whether a message *is* a
    // confirmation is the model's call; that a proposal exists at all is
    // durable evidence this tool checks: either the persisted plan already
    // selects this Workflow (a Coordinator planning turn's proposal), or an
    // assistant message names its exact id (the front door's proposals name
    // it by rule). A user naming the id is a request, not a proposal.
    const persisted = await options.sessionStore.getRunPlan(options.sessionId)
    if (persisted?.selectedWorkflow && persisted.selectedWorkflow.id !== workflowId) {
      return {
        ok: false,
        code: 'conflict',
        message: `The selected workflow is now ${persisted.selectedWorkflow.id}. Confirm that selection before starting; the older proposal was not applied.`,
      }
    }
    const proposedByPlan = persisted?.selectedWorkflow?.id === workflowId
    const proposedInChat = proposedByPlan ||
      (await options.sessionStore.listChatMessages(options.sessionId)).some(
        (message) => message.role === 'assistant' && message.text.includes(workflowId),
      )
    if (!proposedInChat) {
      return {
        ok: false,
        code: 'no_proposal',
        message: `The conversation contains no proposal of ${workflowId}. Propose it to the user first, naming the exact workflow id, and call start_workflow only after they confirm.`,
      }
    }

    // The same sequence the Begin workflow route follows: reuse the persisted
    // plan when it already selects this Workflow, otherwise build one from the
    // conversation. The user's message is the launch instruction, so a plan
    // built here is the user's own selection.
    const reusable =
      persisted &&
      persisted.selectedWorkflow?.id === workflowId &&
      (persisted.status === 'ready' ||
        persisted.status === 'applying' ||
        persisted.status === 'queued' ||
        persisted.status === 'running')
    const plan = reusable
      ? persisted
      : await createRunPlanService({
          sessionId: options.sessionId,
          sessionStore: options.sessionStore,
          repoRootPath: options.repoRootPath,
          ...whenDefined(options.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
          goal: options.goal,
          workflowId,
          selectionSource: 'user',
          expectedPlanId: persisted?.id ?? null,
        })

    // A plan that still needs input must not launch. The refusal carries what
    // is missing so the agent can ask for it instead of claiming a start.
    if (plan.status === 'needs_input' || plan.status === 'draft') {
      return {
        ok: false,
        code: 'needs_input',
        message: `The plan for ${workflowId} is not ready: it still needs ${plan.requiredInputs.join(', ') || 'more input'}. Ask the user for these details instead of starting.`,
        requiredInputs: plan.requiredInputs,
      }
    }

    const applied = await applyRunPlanService({
      sessionId: options.sessionId,
      sessionStore: options.sessionStore,
      ...whenDefined(options.taskQueue, (taskQueue) => ({ taskQueue })),
      repoRootPath: options.repoRootPath,
      ...whenDefined(options.workspacePath, (workspacePath) => ({ workspacePath })),
      ...whenDefined(options.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
      ...whenDefined(options.mcpWorkflowPreflightService, (mcpWorkflowPreflightService) => ({
        mcpWorkflowPreflightService,
      })),
      plan,
      workflowId,
      ...whenDefined(options.workerModel, (workerModel) => ({ workerModel })),
      ...whenDefined(options.sourceTurn, (sourceTurn) => ({ sourceTurn })),
      ...whenDefined(options.projectContext, (projectContext) => ({ projectContext })),
      ...whenDefined(options.workspaceProjectService, (workspaceProjectService) => ({
        workspaceProjectService,
      })),
      ...whenDefined(options.workspaceProjectContextStore, (workspaceProjectContextStore) => ({
        workspaceProjectContextStore,
      })),
      ...whenDefined(options.continuationContext, (continuationContext) => ({ continuationContext })),
    })
    if (applied.ok) {
      return { ok: true, task: applied.task, plan: applied.plan }
    }
    if (applied.status === 'needs_input') {
      return {
        ok: false,
        code: 'needs_input',
        message: `The plan for ${workflowId} is not ready: ${applied.assistant.text}`,
        requiredInputs: applied.plan.requiredInputs,
      }
    }
    return {
      ok: false,
      code: applied.status,
      message: `${applied.error}${'detail' in applied && applied.detail ? `: ${applied.detail}` : ''}`,
    }
  } catch (error) {
    if (error instanceof ServiceError) {
      const detail = typeof error.details === 'string' ? `: ${error.details}` : ''
      return { ok: false, code: error.code, message: `${error.message}${detail}` }
    }
    // Admission recovering is a refusal, not a fault: the agent relays it and
    // the user can confirm again once the queue is ready.
    if (error instanceof TaskQueueError) {
      return { ok: false, code: error.code, message: error.message }
    }
    throw error
  }
}

function refusal(code: string, message: string, requiredInputs?: readonly string[]) {
  const output = { code, error: message, ...(requiredInputs?.length ? { requiredInputs: [...requiredInputs] } : {}) }
  return { output, content: JSON.stringify(output), isError: true }
}
