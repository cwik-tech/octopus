import { getApiBaseUrl } from "@/lib/utils/desktop";
import type {
  Schedule,
  ScheduleInput,
  SchedulePatch,
} from "@contracts/schedules";

export type {
  Schedule,
  ScheduleActiveFire,
  ScheduleInput,
  ScheduleKind,
  ScheduleLastStatus,
  ScheduleModelOverride,
  ScheduleOverlapPolicy,
  SchedulePatch,
  ScheduleProjectContextSelection,
  ScheduleRuntime,
} from "@contracts/schedules";

const API_BASE = getApiBaseUrl();

export type SchedulesClientErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "method_not_allowed"
  | "schedule_unavailable"
  | "persistence_failed"
  | "request_failed";

export class SchedulesClientError extends Error {
  readonly status: number;
  readonly code: SchedulesClientErrorCode;
  readonly retryable: boolean;

  constructor(
    message: string,
    status: number,
    code: SchedulesClientErrorCode,
    retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SchedulesClientError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export async function listSchedules(signal?: AbortSignal): Promise<Schedule[]> {
  const response = await fetch(`${API_BASE}/schedules`, signal ? { signal } : {});
  await expectOk(response);
  const payload = (await response.json()) as { schedules: Schedule[] };
  return payload.schedules;
}

export async function createSchedule(input: ScheduleInput): Promise<Schedule> {
  const response = await fetch(`${API_BASE}/schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await expectOk(response);
  return (await response.json()) as Schedule;
}

export async function updateSchedule(
  id: string,
  patch: SchedulePatch,
): Promise<Schedule> {
  const response = await fetch(`${API_BASE}/schedules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  await expectOk(response);
  return (await response.json()) as Schedule;
}

export async function deleteSchedule(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/schedules/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await expectOk(response);
}

export async function runScheduleNow(
  id: string,
): Promise<{ sessionId: string; taskId: string }> {
  const response = await fetch(
    `${API_BASE}/schedules/${encodeURIComponent(id)}/run-now`,
    { method: "POST" },
  );
  await expectOk(response);
  return (await response.json()) as { sessionId: string; taskId: string };
}

async function expectOk(response: Response): Promise<void> {
  if (response.ok) return;
  const fallback = `${response.status} ${response.statusText || "Request failed"}`;
  try {
    const payload = (await response.json()) as {
      error?: unknown;
      code?: unknown;
      retryable?: unknown;
    };
    throw new SchedulesClientError(
      typeof payload.error === "string" && payload.error.trim()
        ? payload.error
        : fallback,
      response.status,
      isSchedulesClientErrorCode(payload.code) ? payload.code : "request_failed",
      payload.retryable === true,
    );
  } catch (error) {
    if (error instanceof SchedulesClientError) throw error;
    throw new SchedulesClientError(
      fallback,
      response.status,
      "request_failed",
      false,
      { cause: error },
    );
  }
}

function isSchedulesClientErrorCode(
  value: unknown,
): value is Exclude<SchedulesClientErrorCode, "request_failed"> {
  return [
    "invalid_request",
    "not_found",
    "conflict",
    "method_not_allowed",
    "schedule_unavailable",
    "persistence_failed",
  ].includes(String(value));
}
