import { getApiBaseUrl } from "@/lib/utils/desktop";

const API_BASE = getApiBaseUrl();

export type YoutubeProxyCredentialMode = "api-token" | "username-password";

export interface YoutubeSettingsSnapshot {
  settingsSchemaVersion: 2;
  proxyEnabled: boolean;
  credentialMode: YoutubeProxyCredentialMode;
  proxyHost: string;
  proxyPort: number;
  countries: string[];
  username: string;
  source: "default" | "persisted" | "environment";
  apiTokenConfigured: boolean;
  passwordConfigured: boolean;
  proxyStatus: "unverified" | "connected" | "error";
  lastCheckedAt?: string;
  error?: string;
  geminiApiKeyConfigured: boolean;
  geminiSource: "default" | "persisted" | "environment";
  geminiStatus: "unverified" | "connected" | "error";
  geminiModel: string;
  geminiLastCheckedAt?: string;
  geminiError?: string;
  geminiDailyVideoMinutesLimit: number;
  geminiConfirmationThresholdMinutes: number;
  geminiBudgetWindow: "rolling_24_hours";
  geminiPricingVerifiedAt?: string;
  deleteVideosAfterInfoExtraction: boolean;
}

export interface YoutubeSettingsUpdate {
  proxyEnabled: boolean;
  credentialMode: YoutubeProxyCredentialMode;
  proxyHost: string;
  proxyPort: number;
  countries: string[];
  username: string;
  apiToken?: string;
  password?: string;
  clearApiToken?: boolean;
  clearPassword?: boolean;
  geminiApiKey?: string;
  clearGeminiApiKey?: boolean;
  geminiModel?: string;
  geminiDailyVideoMinutesLimit?: number;
  geminiConfirmationThresholdMinutes?: number;
  deleteVideosAfterInfoExtraction?: boolean;
}

export interface YoutubeGeminiModelOption {
  id: string;
  displayName: string;
  description?: string;
}

export interface YoutubeGeminiModelsResponse {
  models: YoutubeGeminiModelOption[];
}

export function fetchYoutubeSettings(): Promise<YoutubeSettingsSnapshot> {
  return request("/settings/youtube");
}

export function saveYoutubeSettings(
  update: YoutubeSettingsUpdate,
): Promise<YoutubeSettingsSnapshot> {
  return request("/settings/youtube", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
  });
}

export function validateYoutubeProxy(): Promise<YoutubeSettingsSnapshot> {
  return request("/settings/youtube/validate", { method: "POST" });
}

export function validateYoutubeGemini(
  candidate?: { apiKey: string; model: string },
): Promise<YoutubeSettingsSnapshot | { valid: true }> {
  return request("/settings/youtube/gemini/validate", candidate ? {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(candidate),
  } : { method: "POST" });
}

export function fetchYoutubeGeminiModels(): Promise<YoutubeGeminiModelsResponse> {
  return request("/settings/youtube/gemini/models");
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  const payload = await response.json().catch(() => null) as
    | T
    | { error?: unknown }
    | null;
  if (!response.ok) {
    throw new Error(
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : "YouTube settings request failed.",
    );
  }
  return payload as T;
}
