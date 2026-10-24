import { getApiBaseUrl } from "@/lib/utils/desktop";

const API_BASE = getApiBaseUrl();

export type ResearchActivityState =
  | "requested"
  | "awaiting-approval"
  | "running"
  | "completed"
  | "denied"
  | "failed"
  | "cancelled";

/**
 * What a step contributed to the research.
 *
 * `search` discovers candidates, `page` reads one, and `supporting` works on a
 * page already read. Only a `page` may be presented as a site the researcher
 * actually visited, which is what keeps search results out of the list of
 * pages the answer was built from.
 */
export type ResearchActivityKind = "search" | "page" | "supporting";

/** Which tool recorded the step. Presentation must not depend on this. */
export type ResearchActivitySource = "browser" | "research-web";

export interface ResearchActivityAttachment {
  id: string;
  kind: "screenshot" | "download";
  name: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ResearchActivity {
  activityId: string;
  source: ResearchActivitySource;
  sessionId: string;
  runId: string;
  assignmentId: string;
  activityScopeId?: string;
  agentPath: string;
  toolCallId: string;
  providerCallOrdinal?: number;
  action: string;
  kind: ResearchActivityKind;
  state: ResearchActivityState;
  createdAt: string;
  updatedAt: string;
  url?: string;
  title?: string;
  searchProviders?: string[];
  resultCount?: number;
  attachment?: ResearchActivityAttachment;
  error?: { code: string; message: string };
}

export async function listResearchActivity(
  sessionId: string,
  signal?: AbortSignal,
): Promise<ResearchActivity[]> {
  const response = await fetch(
    `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/research-activity`,
    signal ? { signal } : undefined,
  );
  if (!response.ok) throw new Error("Research activity could not be loaded.");
  return parseResearchActivities(await response.json());
}

/**
 * Where the app serves a binary the managed browser produced.
 *
 * The projection unifies the read model, not the storage: screenshots and
 * downloads are still written and owned by the browser tool, so they are still
 * fetched from its route.
 */
export function researchAttachmentUrl(sessionId: string, activityId: string): string {
  return `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/browser-activity/${encodeURIComponent(activityId)}/attachment`;
}

/**
 * Where the app serves the site icon for one origin this session visited.
 *
 * Fetched rather than linked: the renderer's CSP allows images only from
 * 'self', data: and blob:, and this API lives on a different origin.
 */
export function researchFaviconUrl(sessionId: string, origin: string): string {
  return `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/research-activity/favicon?origin=${encodeURIComponent(origin)}`;
}

/**
 * Whether a research step has reached a state it can no longer leave.
 *
 * Shared because polling, grouping, and presentation all have to agree on when
 * a step is over; three private copies of this rule would be free to drift.
 */
export function isTerminalResearchActivityState(
  state: ResearchActivityState,
): boolean {
  return state === "completed" || state === "denied" || state === "failed" ||
    state === "cancelled";
}

function parseResearchActivities(value: unknown): ResearchActivity[] {
  if (!isRecord(value)) return [];
  const activities = value.activities;
  if (!Array.isArray(activities)) return [];
  const parsed: ResearchActivity[] = [];
  for (const activity of activities) {
    const next = parseResearchActivity(activity);
    if (next) parsed.push(next);
  }
  return parsed;
}

function parseResearchActivity(value: unknown): ResearchActivity | null {
  if (!isRecord(value)) return null;
  const activityId = requiredString(value.activityId);
  const source = researchActivitySource(value.source);
  const sessionId = requiredString(value.sessionId);
  const runId = requiredString(value.runId);
  const assignmentId = requiredString(value.assignmentId);
  const activityScopeId = optionalString(value.activityScopeId);
  const agentPath = requiredString(value.agentPath);
  const toolCallId = requiredString(value.toolCallId);
  const providerCallOrdinal = optionalOrdinal(value.providerCallOrdinal);
  const action = requiredString(value.action);
  const kind = researchActivityKind(value.kind);
  const state = researchActivityState(value.state);
  const createdAt = requiredString(value.createdAt);
  const updatedAt = requiredString(value.updatedAt);
  const url = optionalString(value.url);
  const title = optionalString(value.title);
  const searchProviders = optionalStringList(value.searchProviders);
  const resultCount = optionalOrdinal(value.resultCount);
  const attachment = parseAttachment(value.attachment);
  const error = parseActivityError(value.error);
  if (
    !activityId ||
    !source ||
    !sessionId ||
    !runId ||
    !assignmentId ||
    activityScopeId === null ||
    !agentPath ||
    !toolCallId ||
    providerCallOrdinal === null ||
    !action ||
    !kind ||
    !state ||
    !createdAt ||
    !updatedAt ||
    url === null ||
    title === null ||
    searchProviders === null ||
    resultCount === null ||
    attachment === null ||
    error === null
  ) {
    return null;
  }
  return {
    activityId,
    source,
    sessionId,
    runId,
    assignmentId,
    ...(activityScopeId !== undefined ? { activityScopeId } : {}),
    agentPath,
    toolCallId,
    ...(providerCallOrdinal !== undefined ? { providerCallOrdinal } : {}),
    action,
    kind,
    state,
    createdAt,
    updatedAt,
    ...(url !== undefined ? { url } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(searchProviders !== undefined ? { searchProviders } : {}),
    ...(resultCount !== undefined ? { resultCount } : {}),
    ...(attachment !== undefined ? { attachment } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function parseAttachment(
  value: unknown,
): ResearchActivityAttachment | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const id = requiredString(value.id);
  const kind = value.kind === "screenshot" || value.kind === "download"
    ? value.kind
    : null;
  const name = requiredString(value.name);
  const relativePath = requiredString(value.relativePath);
  const mimeType = requiredString(value.mimeType);
  if (
    !id ||
    !kind ||
    !name ||
    !relativePath ||
    !mimeType ||
    typeof value.sizeBytes !== "number" ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0
  ) {
    return null;
  }
  return { id, kind, name, relativePath, mimeType, sizeBytes: value.sizeBytes };
}

function parseActivityError(
  value: unknown,
): ResearchActivity["error"] | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const code = requiredString(value.code);
  const message = requiredString(value.message);
  return code && message ? { code, message } : null;
}

function researchActivitySource(
  value: unknown,
): ResearchActivitySource | null {
  return value === "browser" || value === "research-web" ? value : null;
}

function researchActivityKind(value: unknown): ResearchActivityKind | null {
  return value === "search" || value === "page" || value === "supporting"
    ? value
    : null;
}

function researchActivityState(value: unknown): ResearchActivityState | null {
  switch (value) {
    case "requested":
    case "awaiting-approval":
    case "running":
    case "completed":
    case "denied":
    case "failed":
    case "cancelled":
      return value;
    default:
      return null;
  }
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalString(value: unknown): string | undefined | null {
  return value === undefined ? undefined : requiredString(value);
}

function optionalStringList(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === "string" && entry.length > 0)
    ? value
    : null;
}

function optionalOrdinal(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
