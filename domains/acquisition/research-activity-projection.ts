/**
 * One read model for research steps, whatever tool produced them.
 *
 * `research_web` and the managed `browser` keep separate execution and
 * persistence owners; they are unified here, at the read boundary, so the
 * renderer never has to branch on which tool did the work. The inputs are
 * described structurally rather than imported from the services, so this stays
 * a pure mapping with no knowledge of how either journal is stored.
 */

export type ResearchActivityState =
  | "requested"
  | "awaiting-approval"
  | "running"
  | "completed"
  | "denied"
  | "failed"
  | "cancelled";

/**
 * What a step contributes to the research.
 *
 * `search` discovers candidates, `page` reads one, and `supporting` is work
 * done against a page already read. Only a `page` can be presented as a site
 * the researcher actually visited.
 */
export type ResearchActivityKind = "search" | "page" | "supporting";

export type ResearchActivitySource = "browser" | "research-web";

export interface ResearchActivityAttachment {
  readonly id: string;
  readonly kind: "screenshot" | "download";
  readonly name: string;
  readonly relativePath: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export interface ResearchActivityError {
  readonly code: string;
  readonly message: string;
}

export interface ResearchActivityView {
  readonly activityId: string;
  readonly source: ResearchActivitySource;
  readonly sessionId: string;
  readonly runId: string;
  readonly assignmentId: string;
  readonly activityScopeId?: string;
  readonly agentPath: string;
  readonly toolCallId: string;
  readonly providerCallOrdinal?: number;
  readonly action: string;
  readonly kind: ResearchActivityKind;
  readonly state: ResearchActivityState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url?: string;
  readonly title?: string;
  readonly searchProviders?: readonly string[];
  readonly resultCount?: number;
  readonly attachment?: ResearchActivityAttachment;
  readonly error?: ResearchActivityError;
}

export interface BrowserActivityRecord {
  readonly activityId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly assignmentId: string;
  readonly activityScopeId?: string;
  readonly agentPath: string;
  readonly toolCallId: string;
  readonly providerCallOrdinal?: number;
  readonly action: string;
  readonly state: ResearchActivityState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url?: string;
  readonly title?: string;
  readonly attachment?: ResearchActivityAttachment;
  readonly error?: ResearchActivityError;
}

export interface ResearchWebActivityRecord {
  readonly activityId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly assignmentId: string;
  readonly activityScopeId: string;
  readonly agentPath: string;
  readonly toolCallId: string;
  readonly providerCallOrdinal?: number;
  readonly action: string;
  readonly state: "running" | "completed" | "failed" | "cancelled";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly requestedUrl?: string;
  readonly canonicalUrl?: string;
  readonly title?: string;
  readonly resultCount?: number;
  readonly searchProviders?: readonly string[];
  readonly error?: ResearchActivityError;
}

/** Managed-browser actions that land the researcher on a page. */
const BROWSER_PAGE_ACTIONS = new Set(["open", "navigate", "go_back", "observe"]);

export function projectBrowserActivity(
  record: BrowserActivityRecord,
): ResearchActivityView {
  return {
    activityId: record.activityId,
    source: "browser",
    sessionId: record.sessionId,
    runId: record.runId,
    assignmentId: record.assignmentId,
    ...(record.activityScopeId === undefined
      ? {}
      : { activityScopeId: record.activityScopeId }),
    agentPath: record.agentPath,
    toolCallId: record.toolCallId,
    ...(record.providerCallOrdinal === undefined
      ? {}
      : { providerCallOrdinal: record.providerCallOrdinal }),
    action: record.action,
    kind: BROWSER_PAGE_ACTIONS.has(record.action) ? "page" : "supporting",
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.url === undefined ? {} : { url: record.url }),
    ...(record.title === undefined ? {} : { title: record.title }),
    ...(record.attachment === undefined
      ? {}
      : { attachment: record.attachment }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

export function projectResearchWebActivity(
  record: ResearchWebActivityRecord,
): ResearchActivityView {
  // A search is discovery, not a visit; only `acquire` reads a page. Extraction
  // and content reads work on a source already acquired, so they stay visible
  // as steps without being counted as newly opened sites.
  const kind: ResearchActivityKind = record.action === "search"
    ? "search"
    : record.action === "acquire"
      ? "page"
      : "supporting";
  // While the read is in flight the requested URL is all there is; once it
  // succeeds the canonical URL is the one the researcher actually observed.
  const url = record.canonicalUrl ?? record.requestedUrl;
  return {
    activityId: record.activityId,
    source: "research-web",
    sessionId: record.sessionId,
    runId: record.runId,
    assignmentId: record.assignmentId,
    activityScopeId: record.activityScopeId,
    agentPath: record.agentPath,
    toolCallId: record.toolCallId,
    ...(record.providerCallOrdinal === undefined
      ? {}
      : { providerCallOrdinal: record.providerCallOrdinal }),
    action: record.action,
    kind,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(kind === "search" || url === undefined ? {} : { url }),
    ...(record.title === undefined ? {} : { title: record.title }),
    ...(record.searchProviders === undefined
      ? {}
      : { searchProviders: record.searchProviders }),
    ...(record.resultCount === undefined
      ? {}
      : { resultCount: record.resultCount }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

/**
 * Interleave two already-ordered journals without reordering either.
 *
 * Each journal is authoritative about its own sequence — `research_web` keeps
 * the provider's tool-call order, which is not creation order under parallel
 * dispatch — so a global re-sort would destroy information neither list can
 * recover. A stable merge on `createdAt` places them relative to each other
 * and leaves each list's internal order alone.
 */
export function mergeResearchActivity(
  first: readonly ResearchActivityView[],
  second: readonly ResearchActivityView[],
): readonly ResearchActivityView[] {
  const merged: ResearchActivityView[] = [];
  let left = 0;
  let right = 0;
  for (;;) {
    const next = first[left];
    const other = second[right];
    if (next === undefined || other === undefined) break;
    if (next.createdAt <= other.createdAt) {
      merged.push(next);
      left += 1;
    } else {
      merged.push(other);
      right += 1;
    }
  }
  merged.push(...first.slice(left), ...second.slice(right));
  return merged;
}

/**
 * Whether this step read a page the app may request a site icon for.
 *
 * Only a completed page with no error qualifies: a denied, failed or cancelled
 * step can still carry a URL, and authorizing it would let the app fetch an
 * icon for a site the researcher never actually reached.
 */
export function isVisitedResearchPage(activity: ResearchActivityView): boolean {
  return activity.kind === "page" &&
    activity.state === "completed" &&
    !activity.error &&
    Boolean(activity.url);
}
