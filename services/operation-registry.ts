import { whenDefined } from "../core/optional-properties.js"
import type { RunLauncher } from "../domains/run/run-launcher.js";
import type { SessionStore } from "../domains/sessions/session-store.js";
import type { TaskQueue } from "./task-queue.js";
import type { OperationId } from "./operation-catalog.js";
import {
  applyRunPlanService,
  cancelRunTaskService,
  createRunPlanService,
  parseRunApplyBody,
  parseRunCancelBody,
  parseRunMessageBody,
  parseRunPlanBody,
  parseRunStatusBody,
  readRunTaskStatusService,
  runOrchestratorMessageService,
} from "./run-orchestrator-service.js";

export interface OperationContext {
  repoRootPath?: string;
  workflowsRegistryPath?: string;
  workspacePath?: string;
  sessionStore?: SessionStore;
  taskQueue?: Pick<
    TaskQueue,
    "adoptDurableAdmission" | "enqueueInitial" | "wake" | "isReady"
  >;
  taskLauncher?: RunLauncher;
  signal?: AbortSignal;
}

export type OperationHandler = (
  input: unknown,
  context: OperationContext,
) => Promise<unknown>;

export const operationHandlers: Partial<Record<OperationId, OperationHandler>> = {
  async "runOrchestrator.plan"(input, context) {
    const body = parseRunPlanBody(input);
    return {
      plan: await createRunPlanService({
        ...whenDefined(body.sessionId, (definedValue) => ({ sessionId: definedValue })),
        ...whenDefined(context.sessionStore, (definedValue) => ({ sessionStore: definedValue })),
        ...whenDefined(context.repoRootPath, (definedValue) => ({ repoRootPath: definedValue })),
        ...whenDefined(context.workflowsRegistryPath, (definedValue) => ({ workflowsRegistryPath: definedValue })),
        goal: body.goal,
        ...whenDefined(body.workflowId, (definedValue) => ({ workflowId: definedValue })),
      }),
    };
  },
  async "runOrchestrator.apply"(input, context) {
    const body = parseRunApplyBody(input);
    return applyRunPlanService({
      sessionId: body.sessionId,
      ...whenDefined(context.sessionStore, (definedValue) => ({ sessionStore: definedValue })),
      ...whenDefined(context.taskQueue, (definedValue) => ({ taskQueue: definedValue })),
      ...whenDefined(context.taskLauncher, (definedValue) => ({ taskLauncher: definedValue })),
      ...whenDefined(context.repoRootPath, (definedValue) => ({ repoRootPath: definedValue })),
      ...whenDefined(context.workspacePath, (definedValue) => ({ workspacePath: definedValue })),
      ...whenDefined(context.workflowsRegistryPath, (definedValue) => ({ workflowsRegistryPath: definedValue })),
      plan: body.plan,
      ...whenDefined(body.workflowId, (definedValue) => ({ workflowId: definedValue })),
      ...whenDefined(body.brief, (definedValue) => ({ brief: definedValue })),
    });
  },
  async "runOrchestrator.message"(input, context) {
    const body = parseRunMessageBody(input);
    return runOrchestratorMessageService({
      sessionId: body.sessionId,
      ...whenDefined(context.sessionStore, (definedValue) => ({ sessionStore: definedValue })),
      ...whenDefined(context.taskQueue, (definedValue) => ({ taskQueue: definedValue })),
      ...whenDefined(context.taskLauncher, (definedValue) => ({ taskLauncher: definedValue })),
      ...whenDefined(context.repoRootPath, (definedValue) => ({ repoRootPath: definedValue })),
      ...whenDefined(context.workspacePath, (definedValue) => ({ workspacePath: definedValue })),
      ...whenDefined(context.workflowsRegistryPath, (definedValue) => ({ workflowsRegistryPath: definedValue })),
      text: body.text,
      ...whenDefined(body.provider, (definedValue) => ({ provider: definedValue })),
      ...whenDefined(body.model, (definedValue) => ({ model: definedValue })),
    });
  },
  async "runOrchestrator.status"(input, context) {
    const body = parseRunStatusBody(input);
    return readRunTaskStatusService({
      sessionId: body.sessionId,
      taskId: body.taskId,
      ...whenDefined(context.sessionStore, (definedValue) => ({ sessionStore: definedValue })),
    });
  },
  async "runOrchestrator.cancel"(input, context) {
    const body = parseRunCancelBody(input);
    return cancelRunTaskService({
      sessionId: body.sessionId,
      taskId: body.taskId,
      ...whenDefined(context.sessionStore, (definedValue) => ({ sessionStore: definedValue })),
      ...whenDefined(context.taskQueue, (definedValue) => ({ taskQueue: definedValue })),
    });
  },
};

export async function executeOperation(
  id: OperationId,
  input: unknown,
  context: OperationContext,
): Promise<unknown> {
  const handler = operationHandlers[id];
  if (!handler) {
    throw new Error(`Operation is not executable: ${id}`);
  }
  return handler(input, context);
}

export function hasOperationHandler(id: OperationId): boolean {
  return Boolean(operationHandlers[id]);
}
