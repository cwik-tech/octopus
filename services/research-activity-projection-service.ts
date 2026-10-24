import {
  isVisitedResearchPage,
  mergeResearchActivity,
  projectBrowserActivity,
  projectResearchWebActivity,
  type BrowserActivityRecord,
  type ResearchActivityView,
  type ResearchWebActivityRecord,
} from "../domains/acquisition/research-activity-projection.js";

/** A journal this projection reads and never writes. */
export interface ResearchActivitySourcePort<TRecord> {
  listSession(sessionId: string): Promise<readonly TRecord[]>;
}

export interface ResearchActivityProjectionOptions {
  readonly browser?: ResearchActivitySourcePort<BrowserActivityRecord>;
  readonly researchWeb?: ResearchActivitySourcePort<ResearchWebActivityRecord>;
}

/**
 * The one read model the renderer polls for a session's research steps.
 *
 * Deliberately a projection rather than a shared journal: each tool keeps its
 * own execution, persistence and recovery rules, and only the shape the UI
 * needs is unified. An absent source is an empty list, not an error, so a
 * deployment without one of the tools still answers.
 */
export class ResearchActivityProjectionService {
  constructor(
    private readonly options: ResearchActivityProjectionOptions = {},
  ) {}

  async listSession(
    sessionId: string,
  ): Promise<readonly ResearchActivityView[]> {
    const [browser, researchWeb] = await Promise.all([
      this.options.browser?.listSession(sessionId) ?? [],
      this.options.researchWeb?.listSession(sessionId) ?? [],
    ]);
    return mergeResearchActivity(
      researchWeb.map(projectResearchWebActivity),
      browser.map(projectBrowserActivity),
    );
  }

  /**
   * The origins the app may fetch a site icon for.
   *
   * Drawn from both journals, because a page acquired through `research_web`
   * over direct HTTP or the managed browser is just as much a page this
   * session visited as one opened through the browser tool.
   */
  async listVisitedUrls(sessionId: string): Promise<readonly string[]> {
    const activities = await this.listSession(sessionId);
    return activities
      .filter(isVisitedResearchPage)
      .map((activity) => activity.url)
      .filter((url): url is string => typeof url === "string");
  }
}

/**
 * Whether a registered tool service can be read as a research-activity journal.
 *
 * The service name it was looked up under is the discriminator — the registry
 * asserts those are unique — so all this has to establish is that the value
 * really exposes the read method the projection calls.
 */
export function isResearchActivitySource<TRecord>(
  value: unknown,
): value is ResearchActivitySourcePort<TRecord> {
  if (typeof value !== "object" || value === null) return false;
  if (!("listSession" in value)) return false;
  return typeof value.listSession === "function";
}
