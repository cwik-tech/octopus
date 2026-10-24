import { workflowModelEnvironment } from '../domains/provider/workflow-model-selection.js'
import { buildSessionChatFileContext } from './session-chat-file-context.js';
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { whenDefined } from "../core/optional-properties.js";
import {
  attemptOwnedProcessScopePath,
  prepareAttemptOwnedProcessScope,
} from "../core/owned-processes/owned-process-scope.js";
import { OWNED_PROCESS_SCOPE_ENV } from "../core/owned-processes/owned-process-records.js";
import type { WorkspaceExecutionJournalRegistry } from "./workspace-execution-journal-registry.js";
import { resolveWorkflowJournalRecorder } from "./workflow-journal-recorder.js";
import { reportWorkflowJournalDivergence } from "./workflow-journal-divergence.js";

import { taskCreateRequestSchema } from "../contracts/schemas/task-requests.js";
import {
  parseServiceRequest,
  ServiceError,
} from "./service-errors.js";
import { SessionTaskRunnerLauncher } from "../domains/sessions/session-task-launcher.js";
import {
  admissionReleaseUnlessHeld,
  taskOwnedProcessesClosed,
} from "../domains/sessions/task-owned-processes.js";
import {
  isTerminalTaskStatus,
  type ChatMessage,
  type SessionTask,
  type TaskStatus,
} from "../contracts/sessions.js";
import type {
  SessionStore,
  TaskRecordCompareAndSetResult,
} from "../domains/sessions/session-store.js";
import type { RunLauncher } from "../domains/run/run-launcher.js";
import { buildChatMessage } from "./session-service.js";
import {
  terminateTaskProcess,
  type ProcessProbe,
  type ProcessSignal,
} from "../domains/sessions/task-process-supervisor.js";
import { logRuntimeEvent } from "../domains/runtime/logger.js";
import { parseWorkflowRegistry } from "../workflows/loader.js";
import {
  McpWorkflowPreflightValidationError,
  type McpWorkflowPreflightDiagnostic,
} from "../domains/mcp/mcp-workflow-preflight.js";
import {
  WorkflowMcpPreflightServiceError,
  type WorkflowMcpPreflightService,
} from "./workflow-mcp-preflight-service.js";
import { FileSystemWorkflowStateStore } from "../workflows/workflow-state-store.js";
import type { AgentTextStreamLaunchPort } from "../domains/runtime/agent-text-delta-launch.js";
import type { ResourceLibraryService } from "./resource-library-service.js";

export const TASK_BRIEF_REQUIRED_MESSAGE =
  "What would you like this work to be about? Send me the topic, goal, audience, and desired output, then use Begin workflow in chat.";

const DEFAULT_TASK_STARTUP_TIMEOUT_MS = 10_000;
const TASK_STARTUP_TIMEOUT_ENV = "TEAM_RUNTIME_TASK_STARTUP_TIMEOUT_MS";
const TASK_LAUNCH_GATE_PREFIX = ".worker-launch-ready";

/**
 * Atomically publishes a launch gate and treats a matching existing gate as
 * the same operation. The staging hard-link avoids exposing a partially
 * written identity when launch ownership is observed concurrently.
 */
export async function openTaskLaunchGate(
  gatePath: string,
  processIdentity: string,
): Promise<void> {
  const stagingPath = `${gatePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(stagingPath, processIdentity, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await fs.link(stagingPath, gatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existingIdentity = await fs
      .readFile(gatePath, "utf8")
      .then((value) => value.trim())
      .catch((readError) => {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") {
          // The worker consumed the matching gate between link and read.
          return processIdentity;
        }
        throw readError;
      });
    if (existingIdentity !== processIdentity) {
      throw new Error("Task launch gate identity does not match the worker");
    }
  } finally {
    await fs.rm(stagingPath, { force: true });
  }
}

export type SessionTaskLaunchResult =
  | {
      ok: true;
      task: SessionTask;
      warnings: readonly McpWorkflowPreflightDiagnostic[];
    }
  | { ok: false; statusCode: 500; error: string }
  | {
      ok: false;
      statusCode: 409;
      error: string;
      detail: string;
      task: SessionTask;
    }
  | {
      ok: false;
      statusCode: 502;
      error: string;
      detail: string;
      task: SessionTask;
    };

type InitialSessionTaskLaunchResult = Exclude<
  SessionTaskLaunchResult,
  { ok: false; statusCode: 409 }
>;

type CreateSessionTaskLaunchResult =
  | InitialSessionTaskLaunchResult
  | {
      ok: false;
      statusCode: 400;
      error: string;
      detail: string;
    }
  | {
      ok: false;
      statusCode: 409;
      error: string;
      detail: string;
      retryable: true;
      diagnostics: readonly McpWorkflowPreflightDiagnostic[];
    };

export function parseTaskCreateBody(payload: unknown): {
  workflowId?: string;
  teamId?: string;
  brief?: string;
  projectContext?: import("../contracts/projects.js").WorkspaceProjectContextSelection;
  /** Completed results this run carries forward. */
  contextResultIds?: string[];
} {
  const parsed = parseServiceRequest(taskCreateRequestSchema, payload);
  return {
    ...whenDefined(parsed.workflowId, (workflowId) => ({ workflowId })),
    ...whenDefined(parsed.teamId, (teamId) => ({ teamId })),
    ...whenDefined(parsed.brief, (brief) => ({ brief })),
    ...whenDefined(parsed.projectContext, (projectContext) => ({ projectContext })),
    ...whenDefined(parsed.contextResultIds, (contextResultIds) => ({
      contextResultIds,
    })),
  };
}

export async function rejectEmptyTaskBriefIfNeeded(params: {
  sessionId: string;
  sessionStore: SessionStore;
  brief?: string;
}): Promise<ChatMessage | null> {
  if ((params.brief ?? "").trim()) return null;

  const [messages, files] = await Promise.all([
    params.sessionStore.listChatMessages(params.sessionId),
    params.sessionStore.listFiles(params.sessionId),
  ]);
  const hasUserContext = messages.some(
    (message) => message.role === "user" && message.text.trim().length > 0,
  );
  if (hasUserContext || files.length > 0) return null;

  const existingPrompt = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        message.text.trim() === TASK_BRIEF_REQUIRED_MESSAGE,
    );
  if (existingPrompt) return existingPrompt;

  const assistantMessage = buildChatMessage(
    "assistant",
    TASK_BRIEF_REQUIRED_MESSAGE,
  );
  await params.sessionStore.appendChatMessage(
    params.sessionId,
    assistantMessage,
  );
  return assistantMessage;
}

export async function buildTaskBrief(params: {
  sessionId: string;
  sessionStore: SessionStore;
  workflowId: string;
  brief?: string;
}): Promise<string> {
  const sections: string[] = [
    "# Task Brief",
    "",
    `Workflow: \`${params.workflowId}\``,
    "",
  ];

  const explicitBrief = (params.brief ?? "").trim();
  if (explicitBrief) {
    sections.push("## User Brief", "", explicitBrief, "");
  } else {
    const messages = await params.sessionStore.listChatMessages(
      params.sessionId,
    );
    const chatContext = messages
      .filter(
        (message) => message.role === "user" || message.role === "assistant",
      )
      .slice(-12)
      .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
      .join("\n\n");
    sections.push(
      "## User Brief",
      "",
      chatContext || `Run workflow ${params.workflowId}.`,
      "",
    );
  }

  const fileContext = await buildUploadedFileContext(
    params.sessionId,
    params.sessionStore,
  );
  if (fileContext) {
    sections.push("## Uploaded File Context", "", fileContext, "");
  }

  return sections.join("\n").trimEnd() + "\n";
}

export async function launchSessionTask(params: {
  sessionId: string;
  sessionStore: SessionStore;
  taskLauncher?: RunLauncher;
  repoRootPath: string;
  workspacePath: string;
  workflowsRegistryPath?: string;
  runPlanId?: string;
  runPlanApplyClaimId?: string;
  workflowId: string;
  briefMarkdown: string;
  startupTimeoutMs?: number;
  resourceLibraryService?: Pick<ResourceLibraryService, "createTaskProjection">;
  mcpWorkflowPreflightService?: Pick<
    WorkflowMcpPreflightService,
    "resolve"
  >;
}): Promise<CreateSessionTaskLaunchResult> {
  const workflowYaml = await readWorkflowYamlForSnapshot({
    repoRootPath: params.repoRootPath,
    ...whenDefined(params.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
    workflowId: params.workflowId,
  });
  let mcpPreflight:
    | Awaited<ReturnType<WorkflowMcpPreflightService["resolve"]>>
    | undefined;
  if (params.mcpWorkflowPreflightService) {
    if (workflowYaml === undefined) {
      return {
        ok: false,
        statusCode: 400,
        error: "Workflow is invalid",
        detail: "Workflow source is unavailable for MCP preflight.",
      };
    }
    try {
      mcpPreflight = await params.mcpWorkflowPreflightService.resolve({
        workflowId: params.workflowId,
        workflowYaml,
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
    if (!mcpPreflight.ok) {
      return {
        ok: false,
        statusCode: 409,
        error: "Workflow tool prerequisites are not currently available",
        detail: mcpPreflight.errors.map((diagnostic) => diagnostic.message).join(" "),
        retryable: true,
        diagnostics: mcpPreflight.errors,
      };
    }
  }
  const task = await params.sessionStore.createTaskRecord(params.sessionId, {
    workflowId: params.workflowId,
    brief: params.briefMarkdown,
    ...(workflowYaml === undefined ? {} : { workflowYaml }),
    ...(mcpPreflight ? { mcpResolution: mcpPreflight.snapshot } : {}),
    ...whenDefined(params.runPlanId, (runPlanId) => ({ runPlanId })),
    ...whenDefined(params.runPlanApplyClaimId, (runPlanApplyClaimId) => ({ runPlanApplyClaimId })),
  });
  if (!task) {
    return {
      ok: false,
      statusCode: 500,
      error: "Failed to create task record",
    };
  }

  return launchTaskExecutionAttempt({
    ...params,
    task,
    executionKind: "initial",
    warnings: mcpPreflight?.warnings ?? [],
  });
}

export async function resumeSessionTask(params: {
  sessionId: string;
  taskId: string;
  sessionStore: SessionStore;
  taskLauncher?: RunLauncher;
  repoRootPath: string;
  workspacePath: string;
  workflowsRegistryPath?: string;
  startupTimeoutMs?: number;
  resourceLibraryService?: Pick<ResourceLibraryService, "createTaskProjection">;
}): Promise<SessionTaskLaunchResult> {
  const task = await params.sessionStore.getTaskRecord(
    params.sessionId,
    params.taskId,
  );
  if (!task) {
    return { ok: false, statusCode: 500, error: "Task not found" };
  }
  if (task.status !== "interrupted") {
    return {
      ok: false,
      statusCode: 409,
      error: "Task cannot be resumed",
      detail: `Task is ${task.status}, expected interrupted`,
      task,
    };
  }
  if (task.recoveryDisposition === "not_resumable") {
    return {
      ok: false,
      statusCode: 409,
      error: "Task cannot be resumed",
      detail: task.recoveryReason ?? "Durable workflow state does not permit another attempt",
      task,
    };
  }

  return launchTaskExecutionAttempt({
    ...params,
    task,
    executionKind: "recovery",
    warnings: task.mcpWarnings ?? [],
  });
}

export interface TaskRecoverySweepResult {
  inspected: number;
  resumed: string[];
  deferred: string[];
  failed: Array<{ taskId: string; error: string }>;
}

/** Re-launch only existing tasks whose durable state permits automatic retry. */
export async function recoverInterruptedSessionTasks(params: {
  sessionStore: SessionStore;
  taskLauncher?: RunLauncher;
  repoRootPath: string;
  workspacePath: string;
  workflowsRegistryPath?: string;
  maxAutomaticRecoveries?: number;
  resourceLibraryService?: Pick<ResourceLibraryService, "createTaskProjection">;
}): Promise<TaskRecoverySweepResult> {
  const result: TaskRecoverySweepResult = {
    inspected: 0,
    resumed: [],
    deferred: [],
    failed: [],
  };
  const maxAutomaticRecoveries = params.maxAutomaticRecoveries ?? 3;

  for (const session of await params.sessionStore.listSessions()) {
    const tasks = await params.sessionStore.listTaskRecords(session.id);
    for (const task of tasks) {
      if (
        task.status === "queued" &&
        !task.executionAttemptId &&
        task.pid === undefined &&
        task.processGroupId === undefined
      ) {
        result.inspected += 1;
        const launched = await launchTaskExecutionAttempt({
          sessionId: session.id,
          sessionStore: params.sessionStore,
          ...whenDefined(params.taskLauncher, (taskLauncher) => ({ taskLauncher })),
          repoRootPath: params.repoRootPath,
          workspacePath: params.workspacePath,
          ...whenDefined(params.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
          ...whenDefined(params.resourceLibraryService, (resourceLibraryService) => ({ resourceLibraryService })),
          task,
          executionKind: "initial",
          warnings: task.mcpWarnings ?? [],
        });
        if (launched.ok) result.resumed.push(task.id);
        else result.failed.push({ taskId: task.id, error: launched.error });
        continue;
      }
      if (task.status !== "interrupted") continue;
      result.inspected += 1;
      if (
        task.recoveryDisposition !== "automatic" ||
        (task.recoveryCount ?? 0) >= maxAutomaticRecoveries
      ) {
        result.deferred.push(task.id);
        continue;
      }

      const resumed = await resumeSessionTask({
        sessionId: session.id,
        taskId: task.id,
        sessionStore: params.sessionStore,
        ...whenDefined(params.taskLauncher, (taskLauncher) => ({ taskLauncher })),
        repoRootPath: params.repoRootPath,
        workspacePath: params.workspacePath,
        ...whenDefined(params.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath })),
        ...whenDefined(params.resourceLibraryService, (resourceLibraryService) => ({ resourceLibraryService })),
      });
      if (resumed.ok) {
        result.resumed.push(task.id);
      } else {
        result.failed.push({ taskId: task.id, error: resumed.error });
      }
    }
  }

  return result;
}

interface LaunchTaskExecutionAttemptParams {
  sessionId: string;
  sessionStore: SessionStore;
  taskLauncher?: RunLauncher;
  repoRootPath: string;
  workspacePath: string;
  workflowsRegistryPath?: string;
  startupTimeoutMs?: number;
  resourceLibraryService?: Pick<ResourceLibraryService, "createTaskProjection">;
  task: SessionTask;
  executionKind: "initial" | "recovery";
  warnings: readonly McpWorkflowPreflightDiagnostic[];
}

async function launchTaskExecutionAttempt(
  params: LaunchTaskExecutionAttemptParams & { executionKind: "initial" },
): Promise<InitialSessionTaskLaunchResult>;
async function launchTaskExecutionAttempt(
  params: LaunchTaskExecutionAttemptParams & { executionKind: "recovery" },
): Promise<SessionTaskLaunchResult>;
async function launchTaskExecutionAttempt(
  params: LaunchTaskExecutionAttemptParams,
): Promise<SessionTaskLaunchResult> {
  const processIdentity = randomUUID();
  const executionAttemptId = processIdentity;
  const attemptStartedAt = new Date().toISOString();
  const executionAttemptNumber = (params.task.executionAttemptNumber ?? 0) + 1;
  let attemptScope: Awaited<ReturnType<typeof prepareAttemptOwnedProcessScope>>;
  try {
    attemptScope = await prepareAttemptOwnedProcessScope({
      workspacePath: params.workspacePath,
      sessionId: params.sessionId,
      taskId: params.task.id,
      executionAttemptNumber,
    });
  } catch (error) {
    return {
      ok: false,
      statusCode: 502,
      error: "Task could not be reserved for launch",
      detail: error instanceof Error ? error.message : String(error),
      task: params.task,
    };
  }
  const identified = await params.sessionStore.compareAndSetTaskRecord(
    params.sessionId,
    params.task.id,
    params.executionKind === "initial" ? ["queued"] : ["interrupted"],
    {
      status: "queued",
      ownerInstanceId: params.sessionStore.getInstanceId(),
      processIdentity,
      executionAttemptId,
      executionAttemptNumber,
      executionKind: params.executionKind,
      ownedProcessScope: attemptScope.ownedProcessScope,
      attemptStartedAt,
      workerStartedAt: undefined,
      pid: undefined,
      processGroupId: undefined,
      completedAt: undefined,
      interruptedAt: undefined,
      error: undefined,
      ...(params.executionKind === "recovery"
        ? {
            recoveryCount: (params.task.recoveryCount ?? 0) + 1,
            lastRecoveryAt: attemptStartedAt,
          }
        : { recoveryCount: params.task.recoveryCount ?? 0 }),
    },
    params.executionKind === "initial"
      ? { expectedExecutionAttemptId: null }
      : undefined,
  );
  if (!identified?.updated) {
    const recoveryConflict = params.executionKind === "recovery";
    return {
      ok: false,
      statusCode: recoveryConflict ? 409 : 502,
      error: recoveryConflict
        ? "Task cannot be resumed"
        : "Task could not be reserved for launch",
      detail: `Task became ${identified?.task.status ?? "unavailable"} before launch`,
      task: identified?.task ?? params.task,
    };
  }
  return launchReservedTaskExecutionAttempt({
    ...params,
    task: identified.task,
  });
}

export interface LaunchReservedTaskExecutionAttemptParams {
  sessionId: string;
  sessionStore: SessionStore;
  taskLauncher?: RunLauncher;
  repoRootPath: string;
  workspacePath: string;
  workflowsRegistryPath?: string;
  startupTimeoutMs?: number;
  resourceLibraryService?: Pick<ResourceLibraryService, "createTaskProjection">;
  task: SessionTask;
  warnings: readonly McpWorkflowPreflightDiagnostic[];
  textStream?: AgentTextStreamLaunchPort;
}

export async function launchReservedTaskExecutionAttempt(
  params: LaunchReservedTaskExecutionAttemptParams,
): Promise<SessionTaskLaunchResult> {
  const task = params.task;
  const executionAttemptId = task.executionAttemptId;
  const processIdentity = task.processIdentity;
  const executionKind = task.executionKind;
  if (!executionAttemptId || !processIdentity || !executionKind) {
    return {
      ok: false,
      statusCode: 502,
      error: "Task reservation is incomplete",
      detail: "Reserved task is missing attempt or process identity",
      task,
    };
  }
  const priorRecoveryDisposition = task.recoveryDisposition;
  const priorRecoveryReason = task.recoveryReason;

  const launchGatePath = path.join(
    task.cwd,
    `${TASK_LAUNCH_GATE_PREFIX}.${executionAttemptId}`,
  );
  let spawnedTask: SessionTask | null = null;
  // The root this call launched, whether or not it was attached to the task.
  let launchedRoot: SessionTask | null = null;
  // Reserved before the spawn so the channel is readable the moment the child
  // starts. Every exit path below that does not end in a running worker has to
  // give it back: a credential minted for a run that never started is one
  // nothing will ever revoke.
  const textStreamGrant = params.textStream?.grant({
    sessionId: params.sessionId,
    runId: task.runId,
    ...whenDefined(task.targetKind, (targetKind) => ({ targetKind })),
  });
  let textStreamHandedOver = false;
  try {
    const projection = await params.resourceLibraryService?.createTaskProjection({
      scopeId: task.id,
    });
    const runtimeRepoRoot = projection?.rootPath ?? params.repoRootPath;
    const taskLauncher =
      params.taskLauncher ??
      new SessionTaskRunnerLauncher(params.repoRootPath);
    const launched = await taskLauncher.startRun({
      cwd: params.repoRootPath,
      env: {
        ...workflowModelEnvironment(task.workerModel),
        TEAM_RUNTIME_REPO_ROOT: runtimeRepoRoot,
        TEAM_RUNTIME_WORKSPACE_PATH: params.workspacePath,
        TEAM_RUNTIME_RUN_ID: task.runId,
        TEAM_RUNTIME_ASSIGNMENT_ID: task.assignmentId ?? task.runId,
        ...(task.assignmentPath
          ? { TEAM_RUNTIME_ASSIGNMENT_PATH: task.assignmentPath }
          : {}),
        ...(task.runPath ? { TEAM_RUNTIME_RUN_PATH: task.runPath } : {}),
        ...(task.inputSnapshotPath
          ? { TEAM_RUNTIME_INPUT_SNAPSHOT_PATH: task.inputSnapshotPath }
          : {}),
        ...(task.workflowSnapshotPath
          ? { TEAM_RUNTIME_WORKFLOW_SNAPSHOT_PATH: task.workflowSnapshotPath }
          : {}),
        TEAM_RUNTIME_WORKFLOW_ID: task.workflowId,
        ...(params.workflowsRegistryPath
          ? {
              TEAM_RUNTIME_WORKFLOWS_REGISTRY_PATH:
                path.resolve(params.workflowsRegistryPath),
            }
          : {}),
        TEAM_RUNTIME_TASK_ID: task.id,
        TEAM_RUNTIME_SESSION_ID: params.sessionId,
        TEAM_RUNTIME_TASK_BRIEF_PATH: path.join(task.cwd, "incoming-brief.md"),
        TEAM_RUNTIME_TASK_LAUNCH_GATE_PATH: launchGatePath,
        ...whenDefined(attemptOwnedProcessScopePath({
          workspacePath: params.workspacePath,
          sessionId: params.sessionId,
          taskId: task.id,
          executionAttemptNumber: task.executionAttemptNumber,
          ownedProcessScope: task.ownedProcessScope,
        }), (scopePath) => ({ [OWNED_PROCESS_SCOPE_ENV]: scopePath })),
        TEAM_RUNTIME_PROCESS_IDENTITY: processIdentity,
        TEAM_RUNTIME_EXECUTION_ATTEMPT_ID: executionAttemptId,
        TEAM_RUNTIME_RECOVERY: executionKind === "recovery" ? "1" : "0",
        ...(textStreamGrant?.env ?? {}),
        ...(executionKind === "continuation"
          ? {
              TEAM_RUNTIME_CONTINUATION: "1",
              TEAM_RUNTIME_CONTINUATION_ADMISSION_REQUEST_ID:
                task.admission?.requestId ?? "",
            }
          : {}),
      },
      processIdentity,
    });
    const launchedProcessTask: SessionTask = {
      ...task,
      pid: launched.pid,
      ...whenDefined(launched.processGroupId, (processGroupId) => ({ processGroupId })),
      ...whenDefined(launched.processIdentity, (presentProcessIdentity) => ({
        processIdentity: presentProcessIdentity,
      })),
    };
    launchedRoot = launchedProcessTask;
    if (
      launched.processIdentity &&
      launched.processIdentity !== processIdentity
    ) {
      await terminateTaskProcess(launchedProcessTask, {
        isProcessIdentityValid: () => true,
        allowUnverifiedIdentity: true,
      });
      throw new Error("Task launcher returned a different process identity");
    }
    const usesLaunchGate = launched.processIdentity === processIdentity;
    const running = await params.sessionStore.compareAndSetTaskRecord(
      params.sessionId,
      task.id,
      ["queued", "running"],
      {
        ...(usesLaunchGate ? {} : { status: "running" as const }),
        pid: launched.pid,
        ...whenDefined(launched.processGroupId, (processGroupId) => ({ processGroupId })),
        ...whenDefined(launched.processIdentity, (processIdentity) => ({ processIdentity })),
        ...whenDefined(launched.configuredProviderBrokerIdentity, (configuredProviderBrokerIdentity) => ({ configuredProviderBrokerIdentity })),
        ...whenDefined(task.assignmentPath, (assignmentPath) => ({ assignmentPath })),
        startedAt: new Date().toISOString(),
      },
      admissionFence(task),
    );
    spawnedTask = running?.task ?? null;
    if (!running?.updated) {
      await terminateTaskProcess(
        launchedProcessTask,
        {
          isProcessIdentityValid: () => true,
          allowUnverifiedIdentity: true,
        },
      );
      return {
        ok: false,
        statusCode: 502,
        error: "Task launch lost ownership",
        detail: `Task became ${running?.task.status ?? "unavailable"} before its process could be attached`,
        task: running?.task ?? task,
      };
    }
    if (usesLaunchGate) {
      await openTaskLaunchGate(launchGatePath, processIdentity);
    }
    const startupTimeoutMs = resolveTaskStartupTimeoutMs(
      params.startupTimeoutMs,
    );
    const persisted = await waitForTaskStartupOutcome(
      params.sessionStore,
      params.sessionId,
      task.id,
      usesLaunchGate ? startupTimeoutMs : 75,
    );
    if (
      usesLaunchGate &&
      persisted &&
      (persisted.workerStartedAt || isTerminalTaskStatus(persisted.status))
    ) {
      await fs.rm(launchGatePath, { force: true });
    }
    if (persisted?.status === "done") {
      return {
        ok: true,
        task: persisted,
        warnings: params.warnings,
      };
    }
    if (persisted && isTerminalTaskStatus(persisted.status)) {
      return {
        ok: false,
        statusCode: 502,
        error: "Task exited during launch",
        detail:
          persisted.error ??
          `Task became ${persisted.status} before launch completed`,
        task: persisted,
      };
    }
    if (persisted && usesLaunchGate && !persisted.workerStartedAt) {
      const termination = await terminateTaskProcess(launchedProcessTask, {
        // This process was launched in the current call, so its PID cannot be
        // a stale persisted reference even if it exited before `ps` observed it.
        isProcessIdentityValid: () => true,
      });
      if (termination !== "exited") {
        return {
          ok: false,
          statusCode: 502,
          error: "Task failed to start",
          detail: "Task runner did not acknowledge startup and could not be stopped",
          task: persisted,
        };
      }
      const detail =
        `Task runner did not acknowledge startup within ${startupTimeoutMs}ms`;
      const failed = await params.sessionStore.compareAndSetTaskRecord(
        params.sessionId,
        task.id,
        ["queued", "running"],
        {
          status: executionKind === "recovery" ? "interrupted" : "failed",
          // The root is confirmed gone: the slot is released once the
          // attempt's scope closes, and otherwise kept with the hold.
          ...await admissionReleaseUnlessHeld(task, params.workspacePath, "launcher"),
          error: detail,
          ...(executionKind === "recovery"
            ? {
                interruptedAt: new Date().toISOString(),
                ...whenDefined(priorRecoveryDisposition, (recoveryDisposition) => ({ recoveryDisposition })),
                ...whenDefined(priorRecoveryReason, (recoveryReason) => ({ recoveryReason })),
              }
            : { completedAt: new Date().toISOString() }),
        },
        admissionFence(task),
      );
      return {
        ok: false,
        statusCode: 502,
        error: "Task failed to start",
        detail,
        task: failed?.task ?? persisted,
      };
    }
    // The worker is attached and running: it now owns the channel, and the
    // terminal subscription is what releases it.
    textStreamHandedOver = true;
    return {
      ok: true,
      task: persisted ?? running?.task ?? task,
      warnings: params.warnings,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // The root this call launched is stopped first, attached or not. While
    // it may still run, its attempt's scope stays open and the slot stays
    // taken (ADR section 8: the launcher closes the scope once the root is
    // confirmed gone).
    const root = spawnedTask && !isTerminalTaskStatus(spawnedTask.status)
      ? spawnedTask
      : launchedRoot;
    const termination = root
      ? await terminateTaskProcess(root, { isProcessIdentityValid: () => true })
      : "exited";
    if (termination !== "exited") {
      return {
        ok: false,
        statusCode: 502,
        error: "Failed to launch task",
        detail: `${detail}; its task runner could not be stopped`,
        task: spawnedTask ?? task,
      };
    }
    const updated = await params.sessionStore.compareAndSetTaskRecord(
      params.sessionId,
      task.id,
      ["queued", "running"],
      {
        status: executionKind === "recovery" ? "interrupted" : "failed",
        // The slot is released once the attempt's scope closes, and
        // otherwise kept with the hold (ADR section 8, launch failures).
        ...await admissionReleaseUnlessHeld(task, params.workspacePath, "launcher"),
        error: detail,
        ...(executionKind === "recovery"
          ? {
              interruptedAt: new Date().toISOString(),
              ...whenDefined(priorRecoveryDisposition, (recoveryDisposition) => ({ recoveryDisposition })),
              ...whenDefined(priorRecoveryReason, (recoveryReason) => ({ recoveryReason })),
            }
          : { completedAt: new Date().toISOString() }),
      },
      admissionFence(task),
    );
    return {
      ok: false,
      statusCode: 502,
      error: "Failed to launch task",
      detail,
      task: updated?.task ?? task,
    };
  } finally {
    // One place, so no exit path can be missed. A launch that ended in
    // anything but a running worker gives the grant back: otherwise a token
    // stays valid for a run that is not there, and nothing later revokes it.
    if (textStreamGrant && !textStreamHandedOver) {
      params.textStream?.rollback(textStreamGrant.channelId);
    }
  }
}

function admissionFence(task: SessionTask) {
  return {
    ...whenDefined(task.executionAttemptId, (expectedExecutionAttemptId) => ({
      expectedExecutionAttemptId,
    })),
    ...(task.admission
      ? {
          expectedAdmissionRequestId: task.admission.requestId,
          expectedAdmissionPhase: task.admission.phase,
          ...(task.admission.phase === "granted"
            ? {
                expectedAdmissionGrantId: task.admission.grantId,
                expectedAdmissionOwnerEpoch: task.admission.ownerEpoch,
              }
            : {}),
        }
      : {}),
  };
}

async function readWorkflowYamlForSnapshot(params: {
  repoRootPath: string;
  workflowsRegistryPath?: string;
  workflowId: string;
}): Promise<string | undefined> {
  const registryPath = params.workflowsRegistryPath?.trim()
    ? path.resolve(params.workflowsRegistryPath)
    : path.join(params.repoRootPath, "workflows", "registry.yaml");
  const registry = parseWorkflowRegistry(registryPath);
  if (registry.errors.length > 0) return undefined;
  const workflow = registry.entries.find(
    (entry) => entry.name === params.workflowId,
  );
  if (!workflow) return undefined;
  return fs.readFile(workflow.template_path, "utf8").catch(() => undefined);
}

function resolveTaskStartupTimeoutMs(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const configured = Number(process.env[TASK_STARTUP_TIMEOUT_ENV]);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_TASK_STARTUP_TIMEOUT_MS;
}

/** The statuses a cancellation may still move to `cancelled`. */
const CANCELLABLE_TASK_STATUSES: readonly TaskStatus[] = [
  "queued",
  "running",
  "awaiting_input",
  "awaiting_model_choice",
  "interrupted",
];

/** Fenced writes a cancellation tries before reporting that the task kept changing. */
const CANCEL_FENCE_ATTEMPTS = 3;

export async function cancelSessionTask(params: {
  sessionId: string;
  taskId: string;
  sessionStore: SessionStore;
  /**
   * The workspace's journal registry. Cancellation is an authoritative
   * workflow transition, so for an enrolled assignment it must be journaled
   * rather than written straight into the projection (ADR §9).
   */
  executionJournalRegistry?: WorkspaceExecutionJournalRegistry;
  killProcess?: ProcessSignal;
  isProcessAlive?: ProcessProbe;
  isProcessIdentityValid?: (task: SessionTask) => boolean;
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
}): Promise<SessionTask | null> {
  let existing = await params.sessionStore.getTaskRecord(
    params.sessionId,
    params.taskId,
  );
  let cancelled: TaskRecordCompareAndSetResult | null = null;
  for (let attempt = 1; ; attempt += 1) {
    if (!existing) return null;
    if (isTerminalTaskStatus(existing.status)) {
      if (existing.status === "cancelled") {
        await stopCancelledTaskProcess(existing, params);
        await params.sessionStore.reconcileTaskRecords(params.sessionId);
        return (
          (await params.sessionStore.getTaskRecord(
            params.sessionId,
            params.taskId,
          )) ?? existing
        );
      }
      throw new ServiceError(
        "conflict",
        `Task is already ${existing.status} and cannot be cancelled`,
      );
    }

    // Fence the active attempt before signalling it. A worker that completes
    // during termination can no longer win a terminal-state race. An earlier
    // version's interrupted task holds no slot and is never resumed, so it
    // ends as an ordinary finished task: its hold and any pending request go
    // with the cancellation.
    cancelled = await params.sessionStore.compareAndSetTaskRecord(
      params.sessionId,
      params.taskId,
      CANCELLABLE_TASK_STATUSES,
      {
        status: "cancelled",
        completedAt: new Date().toISOString(),
        error: "Cancelled by user",
        ...(earlierVersionInterrupted(existing)
          ? { processCleanupHold: undefined, admission: undefined }
          : {}),
      },
      admissionFence(existing),
    );
    if (
      !cancelled ||
      cancelled.updated ||
      cancelled.task.status === "cancelled" ||
      !CANCELLABLE_TASK_STATUSES.includes(cancelled.task.status)
    ) {
      break;
    }
    // Still cancellable, so the fence failed: the task was admitted, or its
    // attempt changed, between the read and the write. Read it again and
    // cancel the attempt it has now, a bounded number of times.
    if (attempt >= CANCEL_FENCE_ATTEMPTS) {
      throw new ServiceError(
        "conflict",
        "Task could not be cancelled: its admission changed during cancellation",
      );
    }
    existing = await params.sessionStore.getTaskRecord(
      params.sessionId,
      params.taskId,
    );
  }
  if (cancelled && !cancelled.updated && cancelled.task.status !== "cancelled") {
    throw new ServiceError(
      "conflict",
      `Task became ${cancelled.task.status} before cancellation completed`,
    );
  }
  if (!cancelled?.updated) return cancelled?.task ?? null;

  if (cancelled.task.assignmentPath) {
    try {
      // An assignment the registry resolves records the cancellation on its
      // canonical journal before the projection is rewritten. One it does not
      // resolve — no registry in this process, or not enrolled while the mode
      // forbids new enrollment — keeps the snapshot-first authority unchanged.
      const workflowStore = new FileSystemWorkflowStateStore(
        cancelled.task.assignmentPath,
        await resolveWorkflowJournalRecorder({
          registry: params.executionJournalRegistry,
          task: cancelled.task,
          requestId: `cancel-${cancelled.task.id}`,
          processIdentity: cancelled.task.executionAttemptId ?? cancelled.task.id,
        }),
      );
      await workflowStore.cancelFromAuthoritativeTask({
        taskId: cancelled.task.id,
        summary: "Cancelled by user",
        ...whenDefined(cancelled.task.completedAt, (completedAt) => ({ completedAt })),
      });
    } catch (error: unknown) {
      // The task CAS is the cancellation authority, so the failure is not
      // raised to the caller — but it is not discarded either. The durable
      // record and the task record now disagree, and only a report makes that
      // visible (ADR §7, §9).
      await reportWorkflowJournalDivergence({
        assignmentPath: cancelled.task.assignmentPath,
        taskId: cancelled.task.id,
        site: "task-cancellation",
        error,
      });
    }
  }

  await stopCancelledTaskProcess(existing, params);
  // With the root's group confirmed gone, recovery closes the attempt's
  // scope. While a descendant cannot be verified gone, the task keeps its
  // admission and the hold, and cleanup remains pending
  // (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md,
  // section 8).
  await params.sessionStore.reconcileTaskRecords(params.sessionId);
  const afterCleanup = await params.sessionStore.getTaskRecord(
    params.sessionId,
    params.taskId,
  );
  // The slot is released only once the attempt's scope is verified closed,
  // not merely because no hold was recorded: a root recovery could not
  // verify gone leaves neither a closed scope nor a hold. A legacy-active
  // task holds a slot with no admission, and the queue keeps it.
  const heldSlot =
    cancelled.task.admission !== undefined || heldLegacyActiveSlot(existing);
  if (
    afterCleanup?.processCleanupHold !== undefined ||
    (heldSlot &&
      !(afterCleanup && (await taskScopeVerifiedClosed(params.sessionStore, afterCleanup))))
  ) {
    throw new ServiceError(
      "internal",
      "Task was cancelled and fenced, but its descendants could not be verified gone; process cleanup remains pending",
    );
  }
  const released = cancelled.task.admission
    ? await params.sessionStore.compareAndSetTaskRecord(
        params.sessionId,
        params.taskId,
        ["cancelled"],
        {
          admission: undefined,
          pid: undefined,
          processGroupId: undefined,
        },
        admissionFence(cancelled.task),
      )
    : null;
  await params.sessionStore.reconcileTaskRecords(params.sessionId);
  if (cancelled?.updated && cancelled.task.assignmentPath) {
    logRuntimeEvent(cancelled.task.assignmentPath, {
      timestamp: cancelled.task.completedAt ?? new Date().toISOString(),
      event: "run.cancelled",
      session_id: cancelled.task.runId,
      root_session_id: cancelled.task.runId,
      assignment_path: cancelled.task.assignmentPath,
      team: `workflow:${cancelled.task.workflowId}`,
      error: cancelled.task.error,
    });
  }
  return released?.task ?? cancelled?.task ?? null;
}

/**
 * Whether the task is one an earlier version had already moved to
 * interrupted: an attempt with no ownership scope, holding no slot. It can
 * never be resumed, and cancelling it removes its hold, so it becomes an
 * ordinary finished task (the owner's decision of 2026-09-29; ADR section 7).
 * POSIX only: Windows records no scope, and keeps its behavior.
 */
function earlierVersionInterrupted(task: SessionTask): boolean {
  return (
    process.platform !== "win32" &&
    task.status === "interrupted" &&
    task.ownedProcessScope !== 1 &&
    Boolean(task.executionAttemptId) &&
    task.admission?.phase !== "granted"
  );
}

/**
 * Whether the task is one the queue counts legacy-active: an attempt an
 * earlier version launched, queued or running with no admission. It holds a
 * slot until its descendants are verified gone (ADR section 7).
 */
function heldLegacyActiveSlot(task: SessionTask): boolean {
  return (
    task.admission === undefined &&
    (task.status === "queued" || task.status === "running") &&
    Boolean(task.executionAttemptId)
  );
}

/**
 * Whether the task's current attempt's scope is verified closed, read only.
 * The scope sits in the task's own folder, which the store names; a folder
 * that is not where a scope would be never counts as closed.
 */
async function taskScopeVerifiedClosed(
  store: SessionStore,
  task: SessionTask,
): Promise<boolean> {
  const taskDir = path.resolve(store.taskDir(task.sessionId, task.id));
  const workspacePath = path.resolve(taskDir, "..", "..", "..", "..");
  if (path.join(workspacePath, "sessions", task.sessionId, "tasks", task.id) !== taskDir) {
    return false;
  }
  return taskOwnedProcessesClosed(task, workspacePath);
}

async function stopCancelledTaskProcess(
  task: SessionTask,
  params: {
    sessionStore: SessionStore;
    killProcess?: ProcessSignal;
    isProcessAlive?: ProcessProbe;
    isProcessIdentityValid?: (task: SessionTask) => boolean;
    gracefulTimeoutMs?: number;
    forceTimeoutMs?: number;
  },
): Promise<void> {
  const termination = await terminateTaskProcess(task, {
    ...whenDefined(params.killProcess, (signalProcess) => ({ signalProcess })),
    ...whenDefined(params.isProcessAlive, (isProcessAlive) => ({ isProcessAlive })),
    ...whenDefined(params.isProcessIdentityValid, (isProcessIdentityValid) => ({ isProcessIdentityValid })),
    allowUnverifiedIdentity: params.sessionStore.ownsTaskProcess(task),
    ...whenDefined(params.gracefulTimeoutMs, (gracefulTimeoutMs) => ({ gracefulTimeoutMs })),
    ...whenDefined(params.forceTimeoutMs, (forceTimeoutMs) => ({ forceTimeoutMs })),
  });
  if (termination === "still_running") {
    throw new ServiceError(
      "internal",
      "Task was cancelled and fenced, but its process did not exit after SIGTERM and SIGKILL",
    );
  }
  if (termination === "identity_mismatch") {
    throw new ServiceError(
      "internal",
      "Task was cancelled and fenced, but its live process identity could not be verified; process cleanup remains pending",
    );
  }
}

async function waitForTaskStartupOutcome(
  sessionStore: SessionStore,
  sessionId: string,
  taskId: string,
  timeoutMs: number,
): Promise<SessionTask | null> {
  const deadline = Date.now() + timeoutMs;
  let acknowledgedAt: number | null = null;
  let task = await sessionStore.getTaskRecord(sessionId, taskId);
  while (
    task &&
    task.status !== "interrupted" &&
    !isTerminalTaskStatus(task.status)
  ) {
    if (task.workerStartedAt) acknowledgedAt ??= Date.now();
    const acknowledgementSettled =
      acknowledgedAt != null && Date.now() - acknowledgedAt >= 100;
    if (acknowledgementSettled || Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    task = await sessionStore.getTaskRecord(sessionId, taskId);
  }
  return task;
}

async function buildUploadedFileContext(
  sessionId: string,
  sessionStore: SessionStore,
): Promise<string> {
  const files = await sessionStore.listFiles(sessionId);
  if (files.length === 0) return "";

  return buildSessionChatFileContext({ sessionId, sessionStore, files });
}
