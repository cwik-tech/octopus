import type { WorkflowModelSelection } from '../contracts/workflow-model-selection.js'
import type { ConversationTurnOrigin } from "../domains/conversations/conversation-turn-journal.js";
import {
  readFrontDoorPersona,
  readFrontDoorPlanningRules,
} from "../domains/sessions/front-door-persona.js";
import {
  createRunPlan,
  markRunPlanFailed,
  markRunPlanNeedsInput,
  markRunPlanRunning,
  pushRunPlanEvent,
} from "../domains/run-orchestrator/orchestrator.js";
import type { BriefReadinessPolicy } from "../domains/run-orchestrator/orchestrator.js";
import type { AgentTextStreamHub } from "../domains/runtime/agent-text-stream-hub.js";
import { whenDefined } from "../core/optional-properties.js";
import type { FileParserLauncher } from '../core/file-parser-launcher.js';
import type { DocumentSource } from '../contracts/document-reference.js';
import { captureProjectDocuments } from './document-context-service.js';
import { runPlanWorkflowSelectionRequestSchema } from "../contracts/schemas/run-plan-requests.js";
import type {
  RunApplyResult,
  RunPlan,
  RunPlanEvent,
  RunPlanSelectionSource,
} from "../contracts/run-plan.js";
import type { RunLauncher } from "../domains/run/run-launcher.js";
import type { SessionStore } from "../domains/sessions/session-store.js";
import type {
  SessionTask,
  SessionTaskSourceTurn,
} from "../contracts/sessions.js";
import { TaskQueueError, type TaskQueue } from "./task-queue.js";
import { resolveConversationTurnJournalRecorder } from "./conversation-turn-journal-recorder.js";
import type { WorkspaceConversationJournalRegistry } from "./workspace-conversation-journal-registry.js";
import {
  buildChatMessage,
  parseSessionMessageBody,
  runSessionMessageTurn,
} from "./session-service.js";
import {
  TASK_BRIEF_REQUIRED_MESSAGE,
  buildTaskBrief,
  cancelSessionTask,
  rejectEmptyTaskBriefIfNeeded,
} from "./task-service.js";
import {
  parseServiceRequest,
  ServiceError,
} from "./service-errors.js";
import { createDeliveryArtifactReader } from "./delivery-context.js";
import { parseTeamRegistry } from "../parsers/team-registry.js";
import {
  parseWorkflowRegistry,
  parseWorkflowTemplate,
  parseWorkflowTemplateYaml,
} from "../workflows/loader.js";
import { validateWorkflowTemplate } from "../workflows/validation.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  listWorkflowEntries,
  loadWorkflowSummaries,
} from "./workflow-service.js";
import {
  WorkflowMcpPreflightServiceError,
  type WorkflowMcpPreflightService,
} from "./workflow-mcp-preflight-service.js";
import {
  McpWorkflowPreflightValidationError,
  type McpWorkflowPreflightDiagnostic,
  type McpWorkflowResolutionSnapshot,
} from "../domains/mcp/mcp-workflow-preflight.js";
import { assertResearchPlanApproved, hashUnapprovedResearchPlan } from "../domains/deep-research/deep-research-approval.js";
import {
  isDeepResearchIntakeComplete,
  isDeepResearchRunPlan,
} from "../domains/run-orchestrator/deep-research.js";
import type { ResearchPlan } from "../contracts/deep-research.js";
import { SCHEDULER_GENERATED_TAG } from "../domains/scheduling/schedule-types.js";
import type { WorkspaceProjectContextSelection } from "../contracts/projects.js";
import type { SessionMessageTarget } from "../domains/sessions/session-dispatch.js";
import type { WorkspaceProjectContextStore } from "../domains/projects/project-context-store.js";
import type { WorkspaceProjectService } from "../domains/projects/workspace-project-service.js";
import { buildWorkspaceProjectChatContext } from "./project-context-service.js";

export type RunPlanTaskQueue = Pick<
  TaskQueue,
  "adoptDurableAdmission" | "enqueueInitial" | "wake" | "isReady"
>;

export function appendApprovedResearchPlanToBrief(
  briefMarkdown: string,
  approvedResearchPlan: ResearchPlan,
): string {
  return `${briefMarkdown}\n\n## Approved Deep Research Plan\n\n<!-- pipeline-runtime:approved-deep-research-plan:v1 -->\n${JSON.stringify(approvedResearchPlan, null, 2)}\n`;
}

export function parseRunPlanBody(payload: unknown): {
  sessionId?: string;
  goal: string;
  workflowId?: string;
} {
  const record = requireObject(payload);
  const sessionId = optionalString(record.sessionId, "sessionId");
  const workflowId = optionalString(record.workflowId, "workflowId");
  return {
    ...whenDefined(sessionId, (presentSessionId) => ({ sessionId: presentSessionId })),
    goal: optionalString(record.goal, "goal") ?? "",
    ...whenDefined(workflowId, (presentWorkflowId) => ({ workflowId: presentWorkflowId })),
  };
}

export function parseRunApplyBody(payload: unknown): {
  sessionId: string;
  plan: RunPlan;
  workflowId?: string;
  brief?: string;
} {
  const record = requireObject(payload);
  const plan = record.plan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new ServiceError("bad_request", "Field plan is required");
  }
  const workflowId = optionalString(record.workflowId, "workflowId");
  const brief = optionalString(record.brief, "brief");
  return {
    sessionId: requiredString(record.sessionId, "sessionId"),
    plan: plan as RunPlan,
    ...whenDefined(workflowId, (presentWorkflowId) => ({ workflowId: presentWorkflowId })),
    ...whenDefined(brief, (presentBrief) => ({ brief: presentBrief })),
  };
}

export function parseRunStatusBody(payload: unknown): {
  sessionId: string;
  taskId: string;
} {
  const record = requireObject(payload);
  return {
    sessionId: requiredString(record.sessionId, "sessionId"),
    taskId: requiredString(record.taskId, "taskId"),
  };
}

export function parseRunCancelBody(payload: unknown): {
  sessionId: string;
  taskId: string;
} {
  return parseRunStatusBody(payload);
}

export function parseRunPlanWorkflowSelectionBody(payload: unknown): {
  workflowId: string;
  expectedPlanId: string;
} {
  return parseServiceRequest(runPlanWorkflowSelectionRequestSchema, payload);
}

export async function createRunPlanService(params: {
  sessionId?: string;
  sessionStore?: SessionStore;
  repoRootPath?: string;
  workflowsRegistryPath?: string;
  goal: string;
  workflowId?: string;
  /** Who chose the workflow, when this call is making the choice. */
  selectionSource?: RunPlanSelectionSource;
  briefReadinessPolicy?: BriefReadinessPolicy;
  /** When provided, persist only against this observed plan (null means absent). */
  expectedPlanId?: string | null;
  /** Internal callers may explicitly select hidden runtime workflows. */
  includeInternalWorkflows?: boolean;
}): Promise<RunPlan> {
  const [history, files] =
    params.sessionId && params.sessionStore
      ? await Promise.all([
          params.sessionStore.listChatMessages(params.sessionId),
          params.sessionStore.listFiles(params.sessionId),
        ])
      : [[], []];
  if (params.workflowId && params.repoRootPath) {
    assertWorkflowLaunchable({
      repoRootPath: params.repoRootPath,
      ...whenDefined(params.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
      workflowId: params.workflowId,
    });
  }
  const workflows = listWorkflowEntriesForPlanning({
    ...whenDefined(params.repoRootPath, (repoRootPath) => ({ repoRootPath })),
    ...whenDefined(params.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
    ...whenDefined(params.includeInternalWorkflows, (includeInternalWorkflows) => ({ includeInternalWorkflows })),
  });

  const plan = createRunPlan({
    goal: params.goal,
    briefReadinessPolicy: params.briefReadinessPolicy ?? "detailed",
    ...whenDefined(params.workflowId, (workflowId) => ({ workflowId })),
    ...whenDefined(params.selectionSource, (selectionSource) => ({
      selectionSource,
    })),
    workflows,
    history,
    files,
  });

  if (params.sessionId && params.sessionStore) {
    const saved = params.expectedPlanId === undefined
      ? await params.sessionStore.saveRunPlan(params.sessionId, plan)
      : (await params.sessionStore.reviseRunPlan(
          params.sessionId, params.expectedPlanId, plan,
        ))?.revised === true;
    if (!saved) {
      throw new ServiceError(
        "conflict",
        "Run plan changed before the new plan could be persisted",
      );
    }
  }

  return plan;
}

/**
 * Select a Workflow onto the session's plan, under compare-and-set.
 *
 * One service for both entry points — the dedicated selection endpoint and an
 * explicit Workflow target on a message — so there is one answer to "what does
 * this overwrite".
 *
 * `expectedPlanId` is a required assertion, never an optional hint. `null`
 * means "there is no plan yet" and is how a first selection is expressed; a
 * string means "revise exactly this plan". Either way a mismatch is a conflict.
 * There is deliberately no third option that lets the server pick a base plan
 * on the caller's behalf: that is the silent rebase this contract prevents.
 */
export async function selectSessionWorkflowService(params: {
  sessionId: string;
  sessionStore?: SessionStore;
  repoRootPath?: string;
  workflowsRegistryPath?: string;
  workflowId: string;
  expectedPlanId: string | null;
  /** Who chose it. Only `"user"` carries launch authority downstream. */
  selectionSource: RunPlanSelectionSource;
}): Promise<RunPlan> {
  const sessionStore = requireSessionStore(params.sessionStore);
  const currentPlan = await sessionStore.getRunPlan(params.sessionId);
  if (params.expectedPlanId === null) {
    if (currentPlan) {
      throw new ServiceError(
        "conflict",
        "Run plan changed; refresh before selecting",
      );
    }
  } else if (!currentPlan) {
    throw new ServiceError("not_found", "Run plan not found");
  } else if (currentPlan.id !== params.expectedPlanId) {
    throw new ServiceError(
      "conflict",
      "Run plan changed; refresh before selecting",
    );
  }
  if (!params.repoRootPath) {
    throw new ServiceError(
      "not_configured",
      "Workflow selection requires repoRootPath to be configured",
    );
  }
  assertWorkflowLaunchable({
    repoRootPath: params.repoRootPath,
    ...whenDefined(params.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
    workflowId: params.workflowId,
  });
  const workflows = listWorkflowEntriesForPlanning({
    repoRootPath: params.repoRootPath,
    ...whenDefined(params.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
  });
  if (!workflows.some((workflow) => workflow.id === params.workflowId)) {
    throw new ServiceError("bad_request", `Unknown workflow: ${params.workflowId}`);
  }
  const [history, files] = await Promise.all([
    sessionStore.listChatMessages(params.sessionId),
    sessionStore.listFiles(params.sessionId),
  ]);
  const nextPlan = createRunPlan({
    goal: currentPlan?.goal ?? "",
    workflowId: params.workflowId,
    selectionSource: params.selectionSource,
    workflows,
    history,
    files,
  });
  const revision = await sessionStore.reviseRunPlan(
    params.sessionId,
    params.expectedPlanId,
    nextPlan,
  );
  if (!revision) throw new ServiceError("not_found", "Run plan not found");
  if (!revision.revised) {
    throw new ServiceError("conflict", "Run plan changed; refresh before selecting");
  }
  return revision.plan;
}

/**
 * The dedicated selection endpoint's entry point.
 *
 * Kept as a named wrapper because its callers always revise an existing plan
 * and always express a user choice; the shared service carries the general rule.
 */
export async function selectRunPlanWorkflowService(params: {
  sessionId: string;
  sessionStore?: SessionStore;
  repoRootPath?: string;
  workflowsRegistryPath?: string;
  workflowId: string;
  expectedPlanId: string;
}): Promise<RunPlan> {
  return selectSessionWorkflowService({ ...params, selectionSource: "user" });
}

export async function applyRunPlanService(params: {
  sessionId: string;
  sessionStore?: SessionStore;
  taskQueue?: RunPlanTaskQueue;
  /** Retained temporarily for callers while queue ownership moves into startApiServer. */
  taskLauncher?: RunLauncher;
  repoRootPath?: string;
  workspacePath?: string;
  workflowsRegistryPath?: string;
  plan: RunPlan;
  workflowId?: string;
  brief?: string;
  /**
   * Results this launch carries forward, already resolved.
   *
   * Folded into the built task brief rather than into the raw brief, because a
   * launch of an already-ready plan supplies no raw brief at all: the effective
   * one is `plan.brief`, and appending only to a request field would drop the
   * carried results for every ordinary Begin workflow.
   */
  continuationContext?: string;
  targetKind?: SessionTask["targetKind"];
  teamId?: string;
  /** The conversational turn this launch belongs to, when it has one. */
  sourceTurn?: SessionTaskSourceTurn;
  workerModel?: WorkflowModelSelection;
  projectContext?: WorkspaceProjectContextSelection;
  workspaceProjectService?: Pick<
    WorkspaceProjectService,
    "getProjectRecord" | "getSession"
  >;
  workspaceProjectContextStore?: WorkspaceProjectContextStore;
  /** Task admission source; durable automation passes its source. Defaults to "apply". */
  admissionSource?: "apply" | "scheduled" | "batch";
  /** Sealed task-local YAML for a Scheduler-generated single-agent workflow. */
  scheduledWorkflowYaml?: string;
  mcpWorkflowPreflightService?: Pick<
    WorkflowMcpPreflightService,
    "resolve"
  >;
}): Promise<RunApplyResult> {
  const sessionStore = requireSessionStore(params.sessionStore);
  if (
    params.scheduledWorkflowYaml !== undefined &&
    params.admissionSource !== "scheduled"
  ) {
    throw new ServiceError(
      "bad_request",
      "Scheduled workflow YAML is supported only for scheduled admission",
    );
  }
  const persistedPlan = await sessionStore.getRunPlan(params.sessionId);
  if (!persistedPlan) {
    throw new ServiceError(
      "conflict",
      "Run plan is not persisted for this session",
    );
  }
  if (persistedPlan.id !== params.plan.id) {
    throw new ServiceError(
      "conflict",
      "Run plan is stale; refresh the session before applying",
    );
  }
  let approvedResearchPlanForBrief: ResearchPlan | undefined;
  if (isDeepResearchRunPlan(persistedPlan)) {
    if (!isDeepResearchIntakeComplete(persistedPlan)) {
      throw new ServiceError(
        "conflict",
        "Deep Research intake must be confirmed before launch",
      );
    }
    if (!persistedPlan.researchPlan || !persistedPlan.researchPlanProposalHash) {
      throw new ServiceError(
        "conflict",
        "Deep Research requires an approved research plan before launch",
      );
    }
    try {
      const approvedResearchPlan = assertResearchPlanApproved(
        persistedPlan.researchPlan,
      );
      if (
        hashUnapprovedResearchPlan(approvedResearchPlan) !==
        persistedPlan.researchPlanProposalHash
      ) {
        throw new Error("proposal hash mismatch");
      }
      approvedResearchPlanForBrief = approvedResearchPlan;
    } catch {
      throw new ServiceError(
        "conflict",
        "Deep Research plan is unapproved or changed; review and approve it again",
      );
    }
  }
  const workflows = listWorkflowEntries(params.workflowsRegistryPath, {
    includeInternal: true,
  });
  if (
    params.workflowId &&
    !workflows.some((workflow) => workflow.id === params.workflowId)
  ) {
    throw new ServiceError(
      "bad_request",
      `Unknown workflow: ${params.workflowId}`,
    );
  }
  if (
    params.workflowId &&
    params.workflowId !== persistedPlan.selectedWorkflow?.id
  ) {
    throw new ServiceError(
      "conflict",
      "Workflow override does not match the persisted run plan",
    );
  }
  let plan = persistedPlan;
  if (plan.status === "applying") {
    plan =
      (await sessionStore.recoverRunPlanApply(params.sessionId, plan.id)) ??
      plan;
  }
  const workflowId = plan.selectedWorkflow?.id;
  if (!workflowId) {
    throw new ServiceError("bad_request", "Run plan does not select a workflow");
  }
  if (!workflows.some((workflow) => workflow.id === workflowId)) {
    throw new ServiceError("bad_request", `Unknown workflow: ${workflowId}`);
  }
  if (!params.repoRootPath || !params.workspacePath) {
    throw new ServiceError(
      "not_configured",
      "Run apply requires configured repoRootPath and workspacePath",
    );
  }

  const events: RunPlanEvent[] = [];
  const existingApply = await resolveExistingApply({
    sessionId: params.sessionId,
    sessionStore,
    ...whenDefined(params.taskQueue, (taskQueue) => ({ taskQueue })),
    plan,
    events,
  });
  if (existingApply) return existingApply;

  if (plan.status !== "ready") {
    plan = markRunPlanNeedsInput(plan);
    await sessionStore.saveRunPlan(params.sessionId, plan);
    pushRunPlanEvent(events, {
      actionId: "collect-input",
      type: "input_required",
      message: `Run plan still needs: ${plan.requiredInputs.join(", ") || "more input"}.`,
    });
    const assistant = buildChatMessage(
      "assistant",
      plan.requiredInputs.includes("task brief")
        ? TASK_BRIEF_REQUIRED_MESSAGE
        : plan.requiredInputs.includes("specific task details")
        ? "Before I start, I need a more specific brief: topic/domain, audience, desired outcome, and any constraints or source material."
        : "Before I start, I need the missing run details.",
    );
    await sessionStore.appendChatMessage(params.sessionId, assistant);
    return {
      ok: false,
      status: "needs_input",
      plan,
      assistant,
      events,
    };
  }

  if (params.projectContext) {
    if (!params.workspaceProjectService || !params.workspaceProjectContextStore) {
      throw new ServiceError("bad_request", "Project context is unavailable");
    }
    try {
      await buildWorkspaceProjectChatContext({
        sessionId: params.sessionId,
        selection: params.projectContext,
        projectService: params.workspaceProjectService,
        contextStore: params.workspaceProjectContextStore,
      });
    } catch (error) {
      throw new ServiceError(
        "bad_request",
        error instanceof Error ? error.message : "Invalid project context selection",
      );
    }
    const revision = await sessionStore.reviseRunPlan(params.sessionId, plan.id, {
      ...plan,
      projectContext: params.projectContext,
    });
    if (!revision?.revised) {
      throw new ServiceError(
        "conflict",
        "Run plan changed before project context could be applied",
      );
    }
    plan = revision.plan;
  }

  const validationErrors = validateWorkflowForLaunch({
    repoRootPath: params.repoRootPath,
    ...whenDefined(params.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
    workflowId,
  });
  if (validationErrors.length > 0) {
    plan = markRunPlanFailed(plan);
    await sessionStore.saveRunPlan(params.sessionId, plan);
    pushRunPlanEvent(events, {
      actionId: "launch-workflow",
      type: "workflow_launch_failed",
      message: "Workflow is invalid.",
    });
    return {
      ok: false,
      status: "failed",
      statusCode: 400,
      error: "Workflow is invalid",
      detail: validationErrors.join("; "),
      plan,
      events,
    };
  }

  const requiredBriefPrompt = await rejectEmptyTaskBriefIfNeeded({
    sessionId: params.sessionId,
    sessionStore,
    ...whenDefined(params.brief ?? plan.brief, (brief) => ({ brief })),
  });
  if (requiredBriefPrompt) {
    plan = markRunPlanNeedsInput(plan);
    await sessionStore.saveRunPlan(params.sessionId, plan);
    pushRunPlanEvent(events, {
      actionId: "collect-input",
      type: "input_required",
      message: "Task brief is required before launch.",
    });
    return {
      ok: false,
      status: "needs_input",
      plan,
      assistant: requiredBriefPrompt,
      events,
    };
  }

  // Build the brief before taking the launch claim so the claim only covers
  // the short, side-effecting task creation and worker startup window.
  const baseBriefMarkdown = await buildTaskBrief({
    sessionId: params.sessionId,
    sessionStore,
    workflowId,
    ...whenDefined(params.brief ?? plan.brief, (brief) => ({ brief })),
  });
  const researchPlanBriefMarkdown = approvedResearchPlanForBrief
    ? appendApprovedResearchPlanToBrief(
        baseBriefMarkdown,
        approvedResearchPlanForBrief,
      )
    : baseBriefMarkdown;
  const briefMarkdown = params.continuationContext
    ? `${researchPlanBriefMarkdown}\n\n## Carried Results\n\n${params.continuationContext}\n`
    : researchPlanBriefMarkdown;

  const prepared = await prepareInitialTask({
    repoRootPath: params.repoRootPath,
    ...whenDefined(params.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
    workflowId,
    ...whenDefined(params.workerModel, (workerModel) => ({ workerModel })),
    ...whenDefined(params.scheduledWorkflowYaml, (scheduledWorkflowYaml) => ({ scheduledWorkflowYaml })),
    ...whenDefined(params.mcpWorkflowPreflightService, (mcpWorkflowPreflightService) => ({ mcpWorkflowPreflightService })),
  });
  if (!prepared.ok) {
    if (prepared.statusCode === 409) {
      pushRunPlanEvent(events, {
        actionId: "launch-workflow",
        type: "workflow_launch_conflict",
        message: prepared.error,
      });
      return {
        ok: false,
        status: "conflict",
        statusCode: 409,
        error: prepared.error,
        detail: prepared.detail,
        retryable: true,
        diagnostics: prepared.diagnostics,
        plan,
        events,
      };
    }

    plan = markRunPlanFailed(plan);
    await sessionStore.saveRunPlan(params.sessionId, plan);
    pushRunPlanEvent(events, {
      actionId: "launch-workflow",
      type: "workflow_launch_failed",
      message: prepared.error,
    });
    return {
      ok: false,
      status: "failed",
      statusCode: prepared.statusCode,
      error: prepared.error,
      ...whenDefined(prepared.detail, (detail) => ({ detail })),
      plan,
      events,
    };
  }

  const taskQueue = requireReadyTaskQueue(params.taskQueue);

  const readyPlan = plan;
  const claim = await sessionStore.claimRunPlanForApply(
    params.sessionId,
    plan.id,
  );
  if (!claim) {
    throw new ServiceError("conflict", "Run plan no longer exists");
  }
  if (!claim.claimed) {
    const concurrentApply = await resolveExistingApply({
      sessionId: params.sessionId,
      sessionStore,
      taskQueue,
      plan: claim.plan,
      events,
    });
    if (concurrentApply) return concurrentApply;
    throw new ServiceError("conflict", "Run plan is already being applied");
  }
  plan = claim.plan;
  const applyClaimId = plan.applyClaimId;
  if (!applyClaimId) {
    throw new ServiceError("conflict", "Run plan launch claim is missing");
  }
  pushRunPlanEvent(events, {
    actionId: "launch-workflow",
    type: "workflow_launch_started",
    message: `Accepting workflow ${workflowId} for execution.`,
  });

  let task: Awaited<ReturnType<RunPlanTaskQueue["enqueueInitial"]>>;
  try {
    task = await taskQueue.enqueueInitial({
      sessionId: params.sessionId,
      admissionSource: params.admissionSource ?? "apply",
      task: {
        workflowId,
        ...whenDefined(params.workerModel, (workerModel) => ({ workerModel })),
        ...whenDefined(params.targetKind, (definedValue) => ({ targetKind: definedValue })),
        ...whenDefined(params.teamId, (definedValue) => ({ teamId: definedValue })),
        // Committed with the task record itself, before this request answers,
        // so a retry can find it even if the response never arrives.
        ...whenDefined(params.sourceTurn, (definedValue) => ({ sourceTurn: definedValue })),
        brief: briefMarkdown,
        workflowYaml: prepared.workflowYaml,
        ...(prepared.mcpResolution
          ? { mcpResolution: prepared.mcpResolution }
          : {}),
        runPlanId: plan.id,
        runPlanApplyClaimId: applyClaimId,
        ...(plan.projectContext ? { projectContext: plan.projectContext } : {}),
      },
    });
  } catch (error) {
    await releaseApplyClaimIfNoLinkedTask({
      sessionId: params.sessionId,
      sessionStore,
      claimedPlan: plan,
      readyPlan,
    });
    throw error;
  }

  const queuedPlan = await sessionStore.getRunPlan(params.sessionId);
  if (
    !queuedPlan ||
    queuedPlan.id !== plan.id ||
    (
      queuedPlan.status !== "queued" &&
      queuedPlan.status !== "running" &&
      queuedPlan.status !== "completed" &&
      queuedPlan.status !== "failed" &&
      queuedPlan.status !== "blocked" &&
      queuedPlan.status !== "cancelled"
    ) ||
    queuedPlan.taskId !== task.id ||
    task.admission?.phase !== "pending"
  ) {
    throw new ServiceError(
      "conflict",
      "Run plan admission changed before queue acceptance completed",
    );
  }
  plan = queuedPlan;
  pushRunPlanEvent(events, {
    actionId: "launch-workflow",
    type: "workflow_queued",
    message: `Queued workflow ${workflowId} for execution.`,
  });
  return {
    ok: true,
    plan,
    task,
    events,
    warnings: prepared.warnings,
  };
}

type PreparedInitialTask =
  | {
      ok: true;
      workflowYaml: string;
      mcpResolution?: McpWorkflowResolutionSnapshot;
      warnings: readonly McpWorkflowPreflightDiagnostic[];
    }
  | {
      ok: false;
      statusCode: 400 | 500;
      error: string;
      detail?: string;
    }
  | {
      ok: false;
      statusCode: 409;
      error: string;
      detail: string;
      diagnostics: readonly McpWorkflowPreflightDiagnostic[];
    };

async function prepareInitialTask(params: {
  repoRootPath: string;
  workflowsRegistryPath?: string;
  workflowId: string;
  scheduledWorkflowYaml?: string;
  workerModel?: WorkflowModelSelection;
  mcpWorkflowPreflightService?: Pick<WorkflowMcpPreflightService, "resolve">;
}): Promise<PreparedInitialTask> {
  const registryPath = params.workflowsRegistryPath?.trim()
    ? path.resolve(params.workflowsRegistryPath)
    : path.join(params.repoRootPath, "workflows", "registry.yaml");
  let workflowYaml: string;
  try {
    const registry = parseWorkflowRegistry(registryPath);
    if (registry.errors.length > 0) {
      return {
        ok: false,
        statusCode: 400,
        error: "Workflow is invalid",
        detail: registry.errors.join("; "),
      };
    }
    const workflow = registry.entries.find(
      (entry) => entry.name === params.workflowId,
    );
    if (!workflow) {
      return {
        ok: false,
        statusCode: 400,
        error: "Workflow is invalid",
        detail: `Unknown workflow: ${params.workflowId}`,
      };
    }
    if (params.scheduledWorkflowYaml !== undefined) {
      if (!(workflow.tags ?? []).includes(SCHEDULER_GENERATED_TAG)) {
        return {
          ok: false,
          statusCode: 400,
          error: "Workflow is invalid",
          detail: "Task-local workflow YAML is restricted to Scheduler-generated workflows.",
        };
      }
      workflowYaml = params.scheduledWorkflowYaml;
      const parsed = parseWorkflowTemplateYaml(
        workflowYaml,
        `<scheduled:${params.workflowId}>`,
      );
      if (!parsed.template) {
        return {
          ok: false,
          statusCode: 400,
          error: "Workflow is invalid",
          detail: parsed.errors.join("; "),
        };
      }
      if (parsed.template.id !== params.workflowId) {
        return {
          ok: false,
          statusCode: 400,
          error: "Workflow is invalid",
          detail: "Task-local workflow identity does not match the selected workflow.",
        };
      }
      const teamRegistry = parseTeamRegistry(
        path.join(params.repoRootPath, "teams.yaml"),
      );
      const validationErrors = teamRegistry.errors.length > 0
        ? teamRegistry.errors
        : validateWorkflowTemplate(
            parsed.template,
            new Map(teamRegistry.entries.map((entry) => [entry.name, entry])),
          );
      if (validationErrors.length > 0) {
        return {
          ok: false,
          statusCode: 400,
          error: "Workflow is invalid",
          detail: validationErrors.join("; "),
        };
      }
    } else {
      workflowYaml = await fs.readFile(workflow.template_path, "utf8");
    }
  } catch (error) {
    return {
      ok: false,
      statusCode: 400,
      error: "Workflow is invalid",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (!params.mcpWorkflowPreflightService) {
    return { ok: true, workflowYaml, warnings: [] };
  }

  let preflight: Awaited<ReturnType<WorkflowMcpPreflightService["resolve"]>>;
  try {
    preflight = await params.mcpWorkflowPreflightService.resolve({
      workflowId: params.workflowId,
      workflowYaml,
      ...whenDefined(params.workerModel, (workerModel) => ({ workerModel })),
    });
  } catch (error) {
    if (
      error instanceof WorkflowMcpPreflightServiceError ||
      error instanceof McpWorkflowPreflightValidationError
    ) {
      return {
        ok: false,
        statusCode: 400,
        error: "Workflow MCP preflight is invalid",
        detail: error.message,
      };
    }
    return {
      ok: false,
      statusCode: 500,
      error: "Workflow MCP preflight could not be completed",
    };
  }
  if (!preflight.ok) {
    return {
      ok: false,
      statusCode: 409,
      error: "Workflow tool prerequisites are not currently available",
      detail: preflight.errors.map((diagnostic) => diagnostic.message).join(" "),
      diagnostics: preflight.errors,
    };
  }
  return {
    ok: true,
    workflowYaml,
    mcpResolution: preflight.snapshot,
    warnings: preflight.warnings,
  };
}

async function releaseApplyClaimIfNoLinkedTask(params: {
  sessionId: string;
  sessionStore: SessionStore;
  claimedPlan: RunPlan;
  readyPlan: RunPlan;
}): Promise<void> {
  const applyClaimId = params.claimedPlan.applyClaimId;
  if (!applyClaimId) return;
  const current = await params.sessionStore.getRunPlan(params.sessionId);
  if (
    !current ||
    current.id !== params.claimedPlan.id ||
    current.status !== "applying" ||
    current.applyClaimId !== applyClaimId
  ) {
    return;
  }
  const tasks = await params.sessionStore.listTaskRecords(params.sessionId);
  if (
    tasks.some(
      (task) =>
        task.id === current.taskId || task.runPlanId === params.claimedPlan.id,
    )
  ) {
    return;
  }
  await params.sessionStore.finalizeRunPlanApply(
    params.sessionId,
    params.claimedPlan.id,
    applyClaimId,
    params.readyPlan,
  );
}

async function resolveExistingApply(params: {
  sessionId: string;
  sessionStore: SessionStore;
  taskQueue?: RunPlanTaskQueue;
  plan: RunPlan;
  events: RunPlanEvent[];
}): Promise<RunApplyResult | null> {
  if (
    params.plan.status !== "applying" &&
    params.plan.status !== "queued" &&
    params.plan.status !== "running"
  ) {
    if (
      params.plan.status === "completed" ||
      params.plan.status === "failed" ||
      params.plan.status === "blocked" ||
      params.plan.status === "cancelled"
    ) {
      throw new ServiceError(
        "conflict",
        `Run plan is already ${params.plan.status}`,
      );
    }
    return null;
  }

  if (params.taskQueue && !params.taskQueue.isReady()) {
    throw new TaskQueueError(
      "task_admission_recovering",
      "Task admission is still recovering",
    );
  }

  if (!params.plan.taskId) {
    if (params.plan.status === "applying") {
      throw new ServiceError("conflict", "Run plan is already being applied");
    }
    throw new ServiceError("conflict", "Active plan has no task record");
  }

  let task = await params.sessionStore.getTaskRecord(
    params.sessionId,
    params.plan.taskId,
  );
  if (!task) {
    throw new ServiceError("conflict", "Run plan task no longer exists");
  }
  if (task.admission) {
    task = await requireReadyTaskQueue(
      params.taskQueue,
    ).adoptDurableAdmission({
      sessionId: params.sessionId,
      taskId: task.id,
    });
  }
  // Ordinary reconciliation refreshes terminal legacy tasks but deliberately
  // leaves pending/granted admissions under TaskQueue authority.
  await params.sessionStore.reconcileTaskRecords(params.sessionId);
  task =
    (await params.sessionStore.getTaskRecord(params.sessionId, task.id)) ?? task;

  if (
    task.status === "failed" ||
    task.status === "blocked" ||
    task.status === "cancelled"
  ) {
    await params.sessionStore.reconcileTaskRecords(params.sessionId);
    const latestPlan =
      (await params.sessionStore.getRunPlan(params.sessionId)) ?? params.plan;
    pushRunPlanEvent(params.events, {
      actionId: "launch-workflow",
      type: "workflow_launch_failed",
      message:
        task.error ??
        `Workflow ${task.workflowId} became ${task.status} during launch.`,
    });
    return {
      ok: false,
      status: "failed",
      statusCode: 502,
      error: "Task failed during launch",
      detail: task.error ?? `Task became ${task.status} during launch`,
      task,
      plan: latestPlan,
      events: params.events,
    };
  }

  let latestPlan =
    (await params.sessionStore.getRunPlan(params.sessionId)) ?? params.plan;
  if (
    (task.status === "running" || task.status === "interrupted") &&
    latestPlan.status === "applying"
  ) {
    const runningPlan = markRunPlanRunning(latestPlan, task.id);
    const claimId = latestPlan.applyClaimId;
    latestPlan = claimId
      ? (await params.sessionStore.finalizeRunPlanApply(
          params.sessionId,
          latestPlan.id,
          claimId,
          runningPlan,
        )) ?? latestPlan
      : latestPlan;
  }
  pushRunPlanEvent(params.events, {
    actionId: "launch-workflow",
    type: "workflow_already_launched",
    message: `Workflow ${task.workflowId} is already ${task.status}.`,
  });
  return {
    ok: true,
    plan: latestPlan,
    task,
    events: params.events,
    warnings: task.mcpWarnings ?? [],
  };
}

function requireReadyTaskQueue(
  taskQueue: RunPlanTaskQueue | undefined,
): RunPlanTaskQueue {
  if (!taskQueue) {
    throw new ServiceError(
      "not_configured",
      "Task admission queue is not configured",
    );
  }
  if (!taskQueue.isReady()) {
    throw new TaskQueueError(
      "task_admission_recovering",
      "Task admission is still recovering",
    );
  }
  return taskQueue;
}

export function validateWorkflowForLaunch(params: {
  repoRootPath: string;
  workflowsRegistryPath?: string;
  workflowId: string;
}): string[] {
  if (!params.workflowsRegistryPath) {
    return ["Workflow registry is not configured."];
  }

  const workflowRegistry = parseWorkflowRegistry(params.workflowsRegistryPath);
  if (workflowRegistry.errors.length > 0) return workflowRegistry.errors;
  const workflowEntry = workflowRegistry.entries.find(
    (entry) => entry.name === params.workflowId,
  );
  if (!workflowEntry) return [`Unknown workflow: ${params.workflowId}`];

  const parsedTemplate = parseWorkflowTemplate(workflowEntry.template_path);
  if (!parsedTemplate.template) return parsedTemplate.errors;

  const teamRegistry = parseTeamRegistry(path.join(params.repoRootPath, "teams.yaml"));
  if (teamRegistry.errors.length > 0) return teamRegistry.errors;

  return validateWorkflowTemplate(
    parsedTemplate.template,
    new Map(teamRegistry.entries.map((entry) => [entry.name, entry])),
  );
}

export function assertWorkflowLaunchable(params: {
  repoRootPath: string;
  workflowsRegistryPath?: string;
  workflowId: string;
}): void {
  const errors = validateWorkflowForLaunch(params);
  if (errors.length === 0) return;
  throw new ServiceError("bad_request", "Workflow is invalid", {
    detail: errors.join("; "),
  });
}

/**
 * The Workflows a turn may legitimately name.
 *
 * Exported because the front door proposes from the same set the Coordinator
 * plans against. Two lists would drift, and a front door that named a workflow
 * `Begin workflow` refuses is worse than one that named nothing.
 */
export function listWorkflowEntriesForPlanning(params: {
  repoRootPath?: string;
  workflowsRegistryPath?: string;
  includeInternalWorkflows?: boolean;
}) {
  const entries = listWorkflowEntries(params.workflowsRegistryPath, {
    ...whenDefined(params.includeInternalWorkflows, (includeInternal) => ({ includeInternal })),
  });
  const repoRootPath = params.repoRootPath;
  if (!repoRootPath) return entries;
  return entries.filter(
    (entry) =>
      validateWorkflowForLaunch({
        repoRootPath,
        ...whenDefined(params.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
        workflowId: entry.id,
      }).length === 0,
  );
}

export async function runOrchestratorMessageService(params: {
  fileParserLauncher?: FileParserLauncher;
  sessionId: string;
  sessionStore?: SessionStore;
  taskQueue?: RunPlanTaskQueue;
  taskLauncher?: RunLauncher;
  repoRootPath?: string;
  workspacePath?: string;
  workflowsRegistryPath?: string;
  text: string;
  /** Results this turn carries forward, already resolved by the dispatcher. */
  continuationContext?: string;
  /** The ids behind it, which are part of this turn's identity. */
  contextResultIds?: readonly string[];
  provider?: string;
  model?: string;
  projectContext?: WorkspaceProjectContextSelection;
  /** The explicit Workflow target this turn carried, when it had one. */
  target?: SessionMessageTarget;
  workspaceProjectService?: Pick<
    WorkspaceProjectService,
    "getProjectRecord" | "getSession"
  >;
  workspaceProjectContextStore?: WorkspaceProjectContextStore;
  mcpWorkflowPreflightService?: Pick<
    WorkflowMcpPreflightService,
    "resolve"
  >;
  /** This turn's durable identity; minted at the route when absent. */
  turnId?: string;
  /** Who named `turnId`: the caller, or this server on its behalf. */
  turnOrigin?: ConversationTurnOrigin;
  /** The client's own channel id, when it opened a preview stream. */
  streamChannelId?: string;
  textStreamHub?: AgentTextStreamHub;
  /**
   * Conversation journaling for this workspace, when it is enrolled.
   *
   * Passed rather than constructed here so the process keeps one registry and
   * one set of leases; a per-request registry would let two handles exist for
   * one activity.
   */
  conversationJournalRegistry?: WorkspaceConversationJournalRegistry;
  /** Aborted when the client goes away; makes cancellation distinguishable. */
  signal?: AbortSignal;
}) {
  const sessionStore = requireSessionStore(params.sessionStore);
  const session = await sessionStore.getSession(params.sessionId);
  if (!session) {
    throw new ServiceError("not_found", "Session not found");
  }
  let referenceContext: string | undefined;
  let referenceDocuments: DocumentSource[] = [];
  if (params.projectContext) {
    if (!params.workspaceProjectService || !params.workspaceProjectContextStore) {
      throw new ServiceError("bad_request", "Project context is unavailable");
    }
    try {
      referenceContext = await buildWorkspaceProjectChatContext({
        sessionId: params.sessionId,
        selection: params.projectContext,
        projectService: params.workspaceProjectService,
        contextStore: params.workspaceProjectContextStore,
      });
      referenceDocuments = await captureProjectDocuments({ selection: params.projectContext, store: params.workspaceProjectContextStore, ...whenDefined(params.fileParserLauncher, (parserLauncher) => ({ parserLauncher })), ...whenDefined(params.signal, (signal) => ({ signal })) });
      referenceContext = await buildWorkspaceProjectChatContext({ sessionId: params.sessionId, selection: params.projectContext, projectService: params.workspaceProjectService, contextStore: params.workspaceProjectContextStore, admittedDocuments: referenceDocuments });
    } catch (error) {
      throw new ServiceError(
        "bad_request",
        error instanceof Error ? error.message : "Invalid project context selection",
      );
    }
  }
  const workflowEntries = listWorkflowEntriesForPlanning({
    ...whenDefined(params.repoRootPath, (repoRootPath) => ({ repoRootPath })),
    ...whenDefined(params.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
  });
  const launchableWorkflowIds = new Set(
    workflowEntries.map((workflow) => workflow.id),
  );
  // Resolved before the turn so a journal that is enrolled but unreachable
  // fails the request rather than publishing without evidence.
  const conversationRecorder =
    params.conversationJournalRegistry && params.turnId !== undefined
      ? await resolveConversationTurnJournalRecorder({
          registry: params.conversationJournalRegistry,
          owner: {
            kind: "run-session",
            conversationId: params.sessionId,
            sessionId: params.sessionId,
          },
          turnId: params.turnId,
          ...whenDefined(params.workspacePath, (workspacePath) => ({ workspacePath })),
        })
      : undefined;

  try {
    // `return await`, not `return`: a bare return in a try/finally hands back
    // the promise before the finally runs, so the lease would be released —
    // and the journal closed — while the turn was still writing to it.
    return await runSessionMessageTurn({
      referenceDocuments,
      ...whenDefined(params.fileParserLauncher, (fileParserLauncher) => ({ fileParserLauncher })),
      sessionId: params.sessionId,
      session,
      sessionStore,
      text: params.text,
      workflows: loadWorkflowSummaries(params.workflowsRegistryPath).filter(
        (workflow) => launchableWorkflowIds.has(workflow.id),
      ),
      workflowEntries,
      ...whenDefined(params.continuationContext, (continuationContext) => ({
        continuationContext,
      })),
      ...(params.contextResultIds && params.contextResultIds.length > 0
        ? { contextResultIds: params.contextResultIds }
        : {}),
      frontDoorInstalled: readFrontDoorPersona(params.repoRootPath) !== undefined,
      // Planning is a mode of the General Agent, so the rules come from its
      // persona rather than from a constant the user cannot open.
      ...whenDefined(
        readFrontDoorPlanningRules(params.repoRootPath),
        (planningRules) => ({ planningRules }),
      ),
      ...whenDefined(params.provider, (provider) => ({ provider })),
      ...whenDefined(params.model, (model) => ({ model })),
      ...whenDefined(params.projectContext, (projectContext) => ({
        projectContext,
      })),
      ...whenDefined(params.target, (target) => ({ target })),
      ...whenDefined(referenceContext, (presentReferenceContext) => ({
        referenceContext: presentReferenceContext,
      })),
      ...whenDefined(
        params.workspacePath
          ? createDeliveryArtifactReader(params.workspacePath)
          : undefined,
        (readDeliveryArtifact) => ({ readDeliveryArtifact }),
      ),
      ...whenDefined(params.turnId, (turnId) => ({ turnId })),
      ...whenDefined(params.turnOrigin, (turnOrigin) => ({ turnOrigin })),
      ...whenDefined(params.streamChannelId, (streamChannelId) => ({
        streamChannelId,
      })),
      ...whenDefined(params.textStreamHub, (textStreamHub) => ({ textStreamHub })),
      ...whenDefined(conversationRecorder, (recorder) => ({
        conversationRecorder: recorder,
      })),
      // The chat-confirmed launch. Injected rather than called directly:
      // session-service is this module's dependency, not the other way round.
      applyPlan: ({ plan, sourceTurn, workerModel }) =>
        applyChatConfirmedPlan({
          sessionId: params.sessionId,
          sessionStore,
          ...whenDefined(params.taskQueue, (taskQueue) => ({ taskQueue })),
          ...whenDefined(params.taskLauncher, (taskLauncher) => ({ taskLauncher })),
          ...whenDefined(params.repoRootPath, (repoRootPath) => ({ repoRootPath })),
          ...whenDefined(params.workspacePath, (workspacePath) => ({ workspacePath })),
          ...whenDefined(params.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
          plan,
          ...whenDefined(sourceTurn, (definedValue) => ({ sourceTurn: definedValue })),
          ...whenDefined(workerModel, (workerModel) => ({ workerModel })),
          ...whenDefined(params.continuationContext, (continuationContext) => ({ continuationContext })),
          ...whenDefined(params.projectContext, (projectContext) => ({ projectContext })),
          ...whenDefined(params.workspaceProjectService, (service) => ({ workspaceProjectService: service })),
          ...whenDefined(params.workspaceProjectContextStore, (store) => ({ workspaceProjectContextStore: store })),
          ...whenDefined(params.mcpWorkflowPreflightService, (service) => ({ mcpWorkflowPreflightService: service })),
        }),
      ...whenDefined(params.signal, (signal) => ({ signal })),
    });
  } catch (error) {
    // Resolving the journal created the activity, and the turn may fail before
    // it ever reaches its start barrier — a transcript that cannot be read is
    // enough. The activity left behind holds no events, so it reads as empty
    // rather than as a turn: the cost is that it stays discoverable to every
    // sweep and report, and it keeps the admission slot it reserved, which
    // nothing will ever release because no turn is using it.
    //
    // Evidence, not error handling. `abandon` scans first and gives back only
    // what is provably empty, so a journal that recorded anything at all —
    // including a `started` whose outcome nobody can prove — is kept.
    await conversationRecorder?.abandon().catch(() => undefined);
    throw error;
  } finally {
    // The lease is this request's, not the turn's: an operator read or a
    // reconciliation may hold the same activity, and only the last holder
    // closes it. Releasing twice is idempotent, so an abandoned turn passing
    // through here is not a problem.
    await conversationRecorder?.release();
  }
}

/**
 * The chat-confirmed launch behind `runSessionMessageTurn`'s `applyPlan`.
 *
 * A refusal is an answer, not a thrown error: the turn must be able to say
 * why nothing started. Faults that are not launch refusals (a store that
 * vanished mid-turn) still throw.
 */
async function applyChatConfirmedPlan(params: {
  sessionId: string;
  sessionStore: SessionStore;
  taskQueue?: RunPlanTaskQueue;
  taskLauncher?: RunLauncher;
  repoRootPath?: string;
  workspacePath?: string;
  workflowsRegistryPath?: string;
  plan: RunPlan;
  sourceTurn?: SessionTaskSourceTurn;
  workerModel?: WorkflowModelSelection;
  continuationContext?: string;
  projectContext?: WorkspaceProjectContextSelection;
  workspaceProjectService?: Pick<
    WorkspaceProjectService,
    "getProjectRecord" | "getSession"
  >;
  workspaceProjectContextStore?: WorkspaceProjectContextStore;
  mcpWorkflowPreflightService?: Pick<
    WorkflowMcpPreflightService,
    "resolve"
  >;
}): Promise<
  | { ok: true; plan: RunPlan; task: SessionTask }
  | { ok: false; reason: string }
> {
  try {
    const result = await applyRunPlanService({
      sessionId: params.sessionId,
      sessionStore: params.sessionStore,
      ...whenDefined(params.taskQueue, (taskQueue) => ({ taskQueue })),
      ...whenDefined(params.taskLauncher, (taskLauncher) => ({ taskLauncher })),
      ...whenDefined(params.repoRootPath, (repoRootPath) => ({ repoRootPath })),
      ...whenDefined(params.workspacePath, (workspacePath) => ({ workspacePath })),
      ...whenDefined(params.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
      plan: params.plan,
      ...whenDefined(params.workerModel, (workerModel) => ({ workerModel })),
      ...whenDefined(params.plan.selectedWorkflow?.id, (workflowId) => ({ workflowId })),
      ...whenDefined(params.sourceTurn, (sourceTurn) => ({ sourceTurn })),
      ...whenDefined(params.continuationContext, (continuationContext) => ({ continuationContext })),
      ...whenDefined(params.projectContext, (projectContext) => ({ projectContext })),
      ...whenDefined(params.workspaceProjectService, (service) => ({ workspaceProjectService: service })),
      ...whenDefined(params.workspaceProjectContextStore, (store) => ({ workspaceProjectContextStore: store })),
      ...whenDefined(params.mcpWorkflowPreflightService, (service) => ({ mcpWorkflowPreflightService: service })),
    });
    if (result.ok) return { ok: true, plan: result.plan, task: result.task };
    if (result.status === "needs_input") {
      return { ok: false, reason: result.assistant.text };
    }
    return {
      ok: false,
      reason: `${result.error}${"detail" in result && result.detail ? `: ${result.detail}` : ""}`,
    };
  } catch (error) {
    if (error instanceof ServiceError || error instanceof TaskQueueError) {
      return { ok: false, reason: error.message };
    }
    throw error;
  }
}

export async function readRunTaskStatusService(params: {
  sessionId: string;
  taskId: string;
  sessionStore?: SessionStore;
}) {
  const sessionStore = requireSessionStore(params.sessionStore);
  await sessionStore.reconcileTaskRecords(params.sessionId);
  const task = await sessionStore.getTaskRecord(
    params.sessionId,
    params.taskId,
  );
  if (!task) throw new ServiceError("not_found", "Task not found");
  return { task };
}

export async function cancelRunTaskService(params: {
  sessionId: string;
  taskId: string;
  sessionStore?: SessionStore;
  taskQueue?: Pick<TaskQueue, "wake">;
}): Promise<{ task: unknown }> {
  const sessionStore = requireSessionStore(params.sessionStore);
  await sessionStore.reconcileTaskRecords(params.sessionId);
  const task = await cancelSessionTask({
    sessionId: params.sessionId,
    taskId: params.taskId,
    sessionStore,
  });
  if (!task) throw new ServiceError("not_found", "Task not found");
  params.taskQueue?.wake();
  return { task };
}

export function parseRunMessageBody(payload: unknown): {
  sessionId: string;
  text: string;
  provider?: string;
  model?: string;
} {
  const record = requireObject(payload);
  return {
    sessionId: requiredString(record.sessionId, "sessionId"),
    ...parseSessionMessageBody(record),
  };
}

function requireSessionStore(sessionStore: SessionStore | undefined): SessionStore {
  if (!sessionStore) {
    throw new ServiceError("not_configured", "Sessions are not configured");
  }
  return sessionStore;
}

function requireObject(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ServiceError("bad_request", "Request body must be a JSON object");
  }
  return payload as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ServiceError("bad_request", `Field ${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ServiceError("bad_request", `Field ${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
