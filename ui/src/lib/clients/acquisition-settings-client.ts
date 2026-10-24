import { getApiBaseUrl } from "@/lib/utils/desktop";

const API_BASE = getApiBaseUrl();

export type AcquisitionProviderId =
  | "exa"
  | "brave"
  | "firecrawl"
  | "browser-use";

export interface AcquisitionSettingsSnapshot {
  schemaVersion: 3;
  providerPriority: ("exa" | "brave")[];
  providers: Record<
    AcquisitionProviderId,
    {
      enabled: boolean;
      hasApiKey: boolean;
      keyHint?: string;
      status: "unknown" | "connected" | "error";
      error?: string;
      lastCheckedAt?: string;
    }
  >;
  budgets: {
    maximumSearchCalls: number;
    maximumBrowserFallbacks: number;
    maximumManagedReaderCalls: number;
    maximumModelExtractions: number;
    /** Zero keeps the paid cloud browser rung off. */
    maximumCloudBrowserCalls: number;
    /** A post-spend stop threshold in USD micros, not a hard cap. */
    maximumCloudBrowserCostMicros: number;
  };
  extractionModel: { provider: string; model: string } | null;
  source: "default" | "persisted";
  editable: boolean;
}

export interface AcquisitionSettingsUpdate {
  providerPriority: ("exa" | "brave")[];
  providers: Record<
    AcquisitionProviderId,
    { enabled: boolean; apiKey?: string }
  >;
  budgets: AcquisitionSettingsSnapshot["budgets"];
  extractionModel: AcquisitionSettingsSnapshot["extractionModel"];
}

export function fetchAcquisitionSettings(): Promise<AcquisitionSettingsSnapshot> {
  return request("/settings/research-acquisition");
}

export function saveAcquisitionSettings(
  input: AcquisitionSettingsUpdate,
): Promise<AcquisitionSettingsSnapshot> {
  return request("/settings/research-acquisition", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function validateAcquisitionProvider(
  provider: AcquisitionProviderId,
): Promise<AcquisitionSettingsSnapshot> {
  return request("/settings/research-acquisition/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider }),
  });
}

/**
 * Every response from this endpoint, validated rather than asserted.
 *
 * The snapshot crosses an HTTP boundary, so `as AcquisitionSettingsSnapshot`
 * only ever described what it was hoped to be. That mattered the moment this
 * contract grew a provider and two budgets: a stale server would return a
 * snapshot missing them and the renderer would read `undefined.enabled`.
 */
async function request(
  path: string,
  init?: RequestInit,
): Promise<AcquisitionSettingsSnapshot> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (response.ok) {
    const payload: unknown = await response.json();
    if (!isAcquisitionSettingsSnapshot(payload)) {
      throw new Error("Research acquisition settings could not be read.");
    }
    return payload;
  }
  const fallback = `${response.status} ${response.statusText || "Request failed"}`;
  let message = fallback;
  try {
    const payload: unknown = await response.json();
    const error = isRecord(payload) ? payload.error : undefined;
    if (typeof error === "string" && error.trim()) message = error;
  } catch {
    // Preserve the status fallback when the error response is not JSON.
  }
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A budget within the range the server enforces.
 *
 * The bounds are written out here rather than imported: this is a boundary
 * reading somebody else's response, and re-deriving the expectation from the
 * same source that produced it would check nothing.
 */
const BUDGET_RANGES: Readonly<
  Record<
    keyof AcquisitionSettingsSnapshot["budgets"],
    { readonly minimum: number; readonly maximum: number }
  >
> = {
  // Searching is what this tool is for; zero of them is not a configuration the
  // server will ever produce.
  maximumSearchCalls: { minimum: 1, maximum: 100 },
  maximumBrowserFallbacks: { minimum: 0, maximum: 50 },
  maximumManagedReaderCalls: { minimum: 0, maximum: 50 },
  maximumModelExtractions: { minimum: 0, maximum: 100 },
  maximumCloudBrowserCalls: { minimum: 0, maximum: 20 },
  maximumCloudBrowserCostMicros: { minimum: 0, maximum: 100_000_000 },
};

function isBudget(
  value: unknown,
  key: keyof AcquisitionSettingsSnapshot["budgets"],
): boolean {
  const range = BUDGET_RANGES[key];
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= range.minimum &&
    value <= range.maximum
  );
}

/**
 * One provider row, checked exact-key.
 *
 * These rows describe a credential, so an unexpected field on one is a payload
 * from somewhere this client should not be reading — not something to ignore.
 */
function isProviderView(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (!PROVIDER_VIEW_KEYS.includes(key)) return false;
  }
  if (
    typeof value.enabled !== "boolean" ||
    typeof value.hasApiKey !== "boolean" ||
    (value.status !== "unknown" &&
      value.status !== "connected" &&
      value.status !== "error")
  ) {
    return false;
  }
  for (const optional of ["keyHint", "error", "lastCheckedAt"]) {
    const field = value[optional];
    if (field !== undefined && typeof field !== "string") return false;
  }
  return true;
}

function isExtractionModel(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (!Object.keys(value).every((key) => key === "provider" || key === "model")) {
    return false;
  }
  // The same bounds the server enforces. A blank or absurdly long name is not a
  // selection anyone made.
  return (
    isBoundedName(value.provider, 160) && isBoundedName(value.model, 300)
  );
}

function isBoundedName(value: unknown, maximumLength: number): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength
  );
}

function isSearchPriority(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  if (new Set(value).size !== 2) return false;
  return value.every((entry) => entry === "exa" || entry === "brave");
}

/**
 * The whole declared shape, or nothing.
 *
 * A guard that returned true while leaving `schemaVersion`, the priority list
 * or the budgets unchecked would certify a type the payload had not been shown
 * to have, which is the failure this exists to prevent rather than a smaller
 * version of it.
 */
function isAcquisitionSettingsSnapshot(
  value: unknown,
): value is AcquisitionSettingsSnapshot {
  if (!isRecord(value)) return false;
  // Exact root keys: this is described as the whole snapshot, and a field the
  // renderer does not expect is a payload it should not be reading.
  for (const key of Object.keys(value)) {
    if (!SNAPSHOT_KEYS.includes(key)) return false;
  }
  if (value.schemaVersion !== SUPPORTED_SCHEMA_VERSION) return false;
  if (!isSearchPriority(value.providerPriority)) return false;
  // Held in locals: narrowing a property of an index-signature type does not
  // survive to the next statement, and reaching for an assertion to paper over
  // that would defeat the point of validating here at all.
  const providers = value.providers;
  const budgets = value.budgets;
  if (!isRecord(providers) || !isRecord(budgets)) return false;
  if (
    Object.keys(providers).length !== PROVIDER_IDS.length ||
    !PROVIDER_IDS.every((provider) => isProviderView(providers[provider]))
  ) {
    return false;
  }
  if (
    Object.keys(budgets).length !== BUDGET_KEYS.length ||
    !BUDGET_KEYS.every((budget) => isBudget(budgets[budget], budget))
  ) {
    return false;
  }
  if (!isExtractionModel(value.extractionModel)) return false;
  return (
    (value.source === "default" || value.source === "persisted") &&
    typeof value.editable === "boolean"
  );
}

const SUPPORTED_SCHEMA_VERSION = 3;

const SNAPSHOT_KEYS: readonly string[] = [
  "schemaVersion",
  "providerPriority",
  "providers",
  "budgets",
  "extractionModel",
  "source",
  "editable",
];

const PROVIDER_VIEW_KEYS: readonly string[] = [
  "enabled",
  "hasApiKey",
  "keyHint",
  "status",
  "error",
  "lastCheckedAt",
];

const PROVIDER_IDS: readonly AcquisitionProviderId[] = [
  "exa",
  "brave",
  "firecrawl",
  "browser-use",
];

const BUDGET_KEYS: readonly (keyof AcquisitionSettingsSnapshot["budgets"])[] = [
  "maximumSearchCalls",
  "maximumBrowserFallbacks",
  "maximumManagedReaderCalls",
  "maximumModelExtractions",
  "maximumCloudBrowserCalls",
  "maximumCloudBrowserCostMicros",
];
