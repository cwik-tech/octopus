import type {
  ProcessCleanupHoldReason,
  TaskAdmissionBase,
  TaskAdmissionSource,
} from "@contracts/sessions";
import { getApiBaseUrl } from "@/lib/utils/desktop";

const API_BASE = getApiBaseUrl();

export type SchedulingQueueStatus = "ready" | "recovering" | "blocked";
export type SchedulingQueueItemState =
  | "waiting"
  | "starting"
  | "running"
  | "finishing";
/**
 * Where an item's admission came from, as the queue serves it: an admission's
 * own source, or `legacy` for a task an earlier version started without one
 * (services/task-queue.ts, schedulingQueueItem).
 */
export type SchedulingQueueItemSource = TaskAdmissionSource | "legacy";
export type SchedulingQueueExecutionKind = TaskAdmissionBase["executionKind"];

/**
 * Why a task holds its slot. The first two are its root worker; the last two
 * are processes it started, as recorded on the task.
 */
export type SchedulingQueueHoldReason =
  | "unverified_live_process"
  | "ambiguous_marker"
  | ProcessCleanupHoldReason;

export interface SchedulingQueueHold {
  reason: SchedulingQueueHoldReason;
  /** True for the root reasons: nothing new is dispatched while it stands. */
  blocksDispatch: boolean;
  /** Diagnostic detail for `unverified_live_process`: the worker's pid. */
  processId?: number;
  /** Diagnostic detail for `ambiguous_marker`: the process groups carrying the task's identity. */
  processGroupCount?: number;
  /** For the descendant reasons: when the hold was recorded. */
  since?: string;
}

export interface SchedulingQueueItem {
  sessionId: string;
  taskId: string;
  runId: string;
  workflowId: string;
  state: SchedulingQueueItemState;
  executionKind: SchedulingQueueExecutionKind;
  source: SchedulingQueueItemSource;
  requestedAt: string;
  startedAt?: string;
  hold?: SchedulingQueueHold;
}

export interface SchedulingQueueSnapshot {
  version: 1;
  status: SchedulingQueueStatus;
  maximumConcurrentTasks: number;
  slotsInUse: number;
  availableSlots: number;
  waitingCount: number;
  observedAt: string;
  items: SchedulingQueueItem[];
}

export type SchedulingQueueErrorCode =
  | "scheduling_unavailable"
  | "method_not_allowed"
  | "request_failed";

export class SchedulingQueueClientError extends Error {
  readonly status: number;
  readonly code: SchedulingQueueErrorCode;
  readonly retryable: boolean;

  constructor(
    message: string,
    status: number,
    code: SchedulingQueueErrorCode,
    retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SchedulingQueueClientError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export async function fetchSchedulingQueue(
  signal?: AbortSignal,
): Promise<SchedulingQueueSnapshot> {
  const response = await fetch(
    `${API_BASE}/scheduling/queue`,
    signal === undefined ? {} : { signal },
  );
  if (!response.ok) throw await schedulingQueueError(response);
  const payload: unknown = await response.json();
  const snapshot = parseSchedulingQueueSnapshot(payload);
  if (!snapshot) throw new Error("Invalid scheduling queue response");
  return snapshot;
}

// Every value the parser accepts, keyed by the type the queue serves. Each is
// a Record over that type, so the UI typecheck fails the moment the shared
// contract gains or loses a value the parser does not list, or the parser
// lists one the contract does not have. Sources and execution kinds come from
// the admission contract the queue copies them from.
const QUEUE_STATUSES: Record<SchedulingQueueStatus, true> = {
  ready: true,
  recovering: true,
  blocked: true,
};
const ITEM_STATES: Record<SchedulingQueueItemState, true> = {
  waiting: true,
  starting: true,
  running: true,
  finishing: true,
};
const EXECUTION_KINDS: Record<SchedulingQueueExecutionKind, true> = {
  initial: true,
  recovery: true,
  continuation: true,
};
const ITEM_SOURCES: Record<SchedulingQueueItemSource, true> = {
  apply: true,
  startup_repair: true,
  automatic_recovery: true,
  manual_resume: true,
  human_input: true,
  agent_question: true,
  model_choice: true,
  scheduled: true,
  batch: true,
  legacy: true,
};
const HOLD_REASONS: Record<SchedulingQueueHoldReason, true> = {
  unverified_live_process: true,
  ambiguous_marker: true,
  owned_processes_unverified: true,
  descendants_unverified_without_scope: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(accepted: Record<T, true>, value: unknown): T | undefined {
  if (typeof value !== "string" || !Object.hasOwn(accepted, value)) return undefined;
  return Object.keys(accepted).find((candidate): candidate is T => candidate === value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseHold(value: unknown): SchedulingQueueHold | undefined {
  if (!isRecord(value)) return undefined;
  const reason = oneOf(HOLD_REASONS, value.reason);
  if (!reason || typeof value.blocksDispatch !== "boolean") return undefined;
  if (value.processId !== undefined && !isCount(value.processId)) return undefined;
  if (value.processGroupCount !== undefined && !isCount(value.processGroupCount)) return undefined;
  if (value.since !== undefined && typeof value.since !== "string") return undefined;
  return {
    reason,
    blocksDispatch: value.blocksDispatch,
    ...(value.processId !== undefined ? { processId: value.processId } : {}),
    ...(value.processGroupCount !== undefined ? { processGroupCount: value.processGroupCount } : {}),
    ...(value.since !== undefined ? { since: value.since } : {}),
  };
}

function parseItem(value: unknown): SchedulingQueueItem | undefined {
  if (!isRecord(value)) return undefined;
  const state = oneOf(ITEM_STATES, value.state);
  const executionKind = oneOf(EXECUTION_KINDS, value.executionKind);
  const source = oneOf(ITEM_SOURCES, value.source);
  if (
    typeof value.sessionId !== "string" ||
    typeof value.taskId !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.workflowId !== "string" ||
    typeof value.requestedAt !== "string" ||
    !state ||
    !executionKind ||
    !source ||
    (value.startedAt !== undefined && typeof value.startedAt !== "string")
  ) {
    return undefined;
  }
  const hold = value.hold === undefined ? undefined : parseHold(value.hold);
  if (value.hold !== undefined && !hold) return undefined;
  return {
    sessionId: value.sessionId,
    taskId: value.taskId,
    runId: value.runId,
    workflowId: value.workflowId,
    state,
    executionKind,
    source,
    requestedAt: value.requestedAt,
    ...(value.startedAt !== undefined ? { startedAt: value.startedAt } : {}),
    ...(hold ? { hold } : {}),
  };
}

/** The snapshot the route served, or undefined when any part of it is not one. */
export function parseSchedulingQueueSnapshot(value: unknown): SchedulingQueueSnapshot | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.items)) return undefined;
  const status = oneOf(QUEUE_STATUSES, value.status);
  if (
    !status ||
    !isCount(value.maximumConcurrentTasks) ||
    !isCount(value.slotsInUse) ||
    !isCount(value.availableSlots) ||
    !isCount(value.waitingCount) ||
    typeof value.observedAt !== "string"
  ) {
    return undefined;
  }
  const items: SchedulingQueueItem[] = [];
  for (const entry of value.items) {
    const item = parseItem(entry);
    if (!item) return undefined;
    items.push(item);
  }
  return {
    version: 1,
    status,
    maximumConcurrentTasks: value.maximumConcurrentTasks,
    slotsInUse: value.slotsInUse,
    availableSlots: value.availableSlots,
    waitingCount: value.waitingCount,
    observedAt: value.observedAt,
    items,
  };
}

async function schedulingQueueError(
  response: Response,
): Promise<SchedulingQueueClientError> {
  const fallback = `${response.status} ${response.statusText || "Request failed"}`;
  try {
    const payload = (await response.json()) as {
      error?: unknown;
      code?: unknown;
      retryable?: unknown;
    };
    return new SchedulingQueueClientError(
      typeof payload.error === "string" && payload.error.trim()
        ? payload.error
        : fallback,
      response.status,
      isSchedulingQueueErrorCode(payload.code) ? payload.code : "request_failed",
      payload.retryable === true,
    );
  } catch (error) {
    return new SchedulingQueueClientError(
      fallback,
      response.status,
      "request_failed",
      false,
      { cause: error },
    );
  }
}

function isSchedulingQueueErrorCode(
  value: unknown,
): value is Exclude<SchedulingQueueErrorCode, "request_failed"> {
  return ["scheduling_unavailable", "method_not_allowed"].includes(String(value));
}
