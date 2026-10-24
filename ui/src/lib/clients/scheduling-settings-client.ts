import { getApiBaseUrl } from "@/lib/utils/desktop";

const API_BASE = getApiBaseUrl();

export type SchedulingSettingsSource =
  | "default"
  | "persisted"
  | "environment";

export interface SchedulingSettingsSnapshot {
  maximumConcurrentTasks: number;
  constraints: {
    minimum: number;
    maximum: number;
  };
  source: SchedulingSettingsSource;
  editable: boolean;
}

export type SchedulingSettingsErrorCode =
  | "invalid_request"
  | "managed_by_environment"
  | "task_admission_recovering"
  | "scheduling_unavailable"
  | "settings_persistence_failed"
  | "method_not_allowed"
  | "request_failed";

export class SchedulingSettingsClientError extends Error {
  readonly status: number;
  readonly code: SchedulingSettingsErrorCode;
  readonly retryable: boolean;

  constructor(
    message: string,
    status: number,
    code: SchedulingSettingsErrorCode,
    retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SchedulingSettingsClientError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function fetchSchedulingSettings(): Promise<SchedulingSettingsSnapshot> {
  return request("/settings/scheduling");
}

export function saveSchedulingSettings(
  maximumConcurrentTasks: number,
): Promise<SchedulingSettingsSnapshot> {
  return request("/settings/scheduling", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ maximumConcurrentTasks }),
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) throw await schedulingSettingsError(response);
  return (await response.json()) as T;
}

async function schedulingSettingsError(
  response: Response,
): Promise<SchedulingSettingsClientError> {
  const fallback = `${response.status} ${response.statusText || "Request failed"}`;
  try {
    const payload = (await response.json()) as {
      error?: unknown;
      code?: unknown;
      retryable?: unknown;
    };
    return new SchedulingSettingsClientError(
      typeof payload.error === "string" && payload.error.trim()
        ? payload.error
        : fallback,
      response.status,
      isSchedulingSettingsErrorCode(payload.code)
        ? payload.code
        : "request_failed",
      payload.retryable === true,
    );
  } catch (error) {
    return new SchedulingSettingsClientError(
      fallback,
      response.status,
      "request_failed",
      false,
      { cause: error },
    );
  }
}

function isSchedulingSettingsErrorCode(
  value: unknown,
): value is Exclude<SchedulingSettingsErrorCode, "request_failed"> {
  return [
    "invalid_request",
    "managed_by_environment",
    "task_admission_recovering",
    "scheduling_unavailable",
    "settings_persistence_failed",
    "method_not_allowed",
  ].includes(String(value));
}
