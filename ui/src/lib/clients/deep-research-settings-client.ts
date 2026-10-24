import { getApiBaseUrl } from "@/lib/utils/desktop";

const API_BASE = getApiBaseUrl();

export type DeepResearchSettingsSource = "default" | "persisted";

export interface DeepResearchSettingsSnapshot {
  schemaVersion: 3;
  maxDurationMinutes: number;
  maxResearcherAgents: number;
  constraints: {
    maxDurationMinutes: {
      minimum: number;
      maximum: number;
    };
    maxResearcherAgents: {
      minimum: number;
      maximum: number;
    };
  };
  source: DeepResearchSettingsSource;
  editable: boolean;
}

export interface DeepResearchSettingsValues {
  maxDurationMinutes: number;
  maxResearcherAgents: number;
}

export type DeepResearchSettingsErrorCode =
  | "invalid_request"
  | "method_not_allowed"
  | "deep_research_settings_unavailable"
  | "settings_persistence_failed"
  | "request_failed";

export class DeepResearchSettingsClientError extends Error {
  readonly status: number;
  readonly code: DeepResearchSettingsErrorCode;
  readonly retryable: boolean;

  constructor(
    message: string,
    status: number,
    code: DeepResearchSettingsErrorCode,
    retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DeepResearchSettingsClientError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function fetchDeepResearchSettings(): Promise<DeepResearchSettingsSnapshot> {
  return request("/settings/deep-research");
}

export function saveDeepResearchSettings(
  values: DeepResearchSettingsValues,
): Promise<DeepResearchSettingsSnapshot> {
  return request("/settings/deep-research", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(values),
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) throw await deepResearchSettingsError(response);
  return (await response.json()) as T;
}

async function deepResearchSettingsError(
  response: Response,
): Promise<DeepResearchSettingsClientError> {
  const fallback = `${response.status} ${response.statusText || "Request failed"}`;
  try {
    const payload = (await response.json()) as {
      error?: unknown;
      code?: unknown;
      retryable?: unknown;
    };
    return new DeepResearchSettingsClientError(
      typeof payload.error === "string" && payload.error.trim()
        ? payload.error
        : fallback,
      response.status,
      isDeepResearchSettingsErrorCode(payload.code)
        ? payload.code
        : "request_failed",
      payload.retryable === true,
    );
  } catch (error) {
    return new DeepResearchSettingsClientError(
      fallback,
      response.status,
      "request_failed",
      false,
      { cause: error },
    );
  }
}

function isDeepResearchSettingsErrorCode(
  value: unknown,
): value is Exclude<DeepResearchSettingsErrorCode, "request_failed"> {
  return [
    "invalid_request",
    "method_not_allowed",
    "deep_research_settings_unavailable",
    "settings_persistence_failed",
  ].includes(String(value));
}
