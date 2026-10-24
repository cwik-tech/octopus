import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { whenDefined } from "../core/optional-properties.js";

import {
  BrowserManager,
  BrowserRuntimeError,
  type BrowserAcquiredEvidence,
  type BrowserExecutionScope,
  type BrowserProxyEndpoint,
} from "../domains/browser/browser-manager.js";
import type { AcquisitionBudgets } from "../domains/acquisition/acquisition-settings.js";
import type { CloudAcquisitionResult } from "../domains/browser/cloud-browser-acquirer.js";
import { buildSessionRunAssignmentLocation } from "../domains/run/run-location.js";
import {
  isSafePathSegment,
  resolveRelativePathInside,
} from "../core/path-safety.js";
import type {
  McpBrokerRequestContext,
  McpJsonObject,
} from "../contracts/mcp.js";
import { hostAuditedParallelReadEffect } from "../contracts/capability-effect.js";
import type { McpNamespacedTool } from "../domains/mcp/mcp-runtime.js";
import { DirectHttpAcquirer } from "../domains/acquisition/direct-http-acquirer.js";
import type {
  AcquisitionProxySession,
  WebshareProxyPort,
} from "../domains/acquisition/acquisition-proxy.js";
import type {
  AcquisitionBrowserRuntime,
  AcquisitionChallengeType,
  AcquisitionMethod,
} from "../domains/acquisition/acquisition-types.js";
import { WEBSHARE_PROXY_RUNTIME } from "../domains/proxy/webshare-proxy.js";
import type { BrowserAgentPolicy } from "../domains/browser/browser-policy.js";
import {
  canonicalizeSourceUrl,
  normalizeSearchDomain,
} from "../domains/acquisition/acquisition-url.js";
import { MAX_RESEARCH_ACTIVITY_PER_SESSION } from "../domains/acquisition/acquisition-types.js";
import {
  BrowserSearchChallengeError,
  BrowserSearchProvider,
  DEFAULT_BROWSER_SEARCH_ENDPOINT,
  type BrowserSearchRenderer,
} from "../domains/acquisition/acquisition-browser-search.js";
import { readAcquisitionAgentPolicy } from "../domains/acquisition/acquisition-policy.js";
import { NativeDocumentParser } from "../domains/acquisition/native-document-parser.js";
import {
  AcquisitionSearchCoordinator,
  type ManagedReaderProvider,
} from "../domains/acquisition/acquisition-providers.js";
import {
  RESEARCH_WEB_SERVER_ID,
  RESEARCH_WEB_TOOL_NAME,
  researchWebToolInputSchema,
  type AcquisitionAttempt,
  type AcquisitionAttemptOutcome,
  type ExtractedFieldStatus,
  type ResearchWebAction,
  type ResearchWebErrorCode,
  type ResearchWebToolInput,
  type ResearchWebToolOutput,
  type SourceExtractionView,
  type SourceObservationReceiptView,
} from "../domains/acquisition/acquisition-types.js";
import {
  SourceObservationStore,
  type ObservationIdentity,
} from "../domains/acquisition/source-observation-store.js";
import {
  evaluateAcquisitionQuality,
  type AcquisitionQualityReport,
} from "../domains/acquisition/acquisition-quality.js";
import {
  buildSourceRepresentations,
  markdownRepresentation,
  type SourceRepresentationDraft,
} from "../domains/acquisition/source-representations.js";
import { publishResearchAcquisitionCompletedEvent } from "../domains/acquisition/acquisition-events.js";
import {
  validateExtractionSchema,
  validateRequiredFields,
} from "../domains/acquisition/source-extraction.js";
import type { FileParserLauncher } from "../core/file-parser-launcher.js";
import type { AcquisitionSettingsService } from "./acquisition-settings-service.js";
import {
  SourceExtractionService,
  type SourceExtractionExecution,
} from "./source-extraction-service.js";

const MAX_ACTIVITY_PER_SESSION = MAX_RESEARCH_ACTIVITY_PER_SESSION;
const CLOUD_BROWSER_SEARCH_ENDPOINTS = [
  DEFAULT_BROWSER_SEARCH_ENDPOINT,
  "https://search.brave.com/search",
] as const;
/**
 * What a lane reports when nothing reached the web.
 *
 * Two routes arrive here and the sentence is true of both. The search is never
 * admitted, because no enabled search provider has an API key, no managed
 * browser is wired and the paid rung has no call budget. Or it is admitted on a
 * rung its call budget funds, which then produces nothing, because Browser Use
 * is not enabled or not keyed, was defunded between the two settings reads, or
 * the caller withdrew. Naming which of those happened would assert a state
 * change that a plain misconfiguration never made — a non-zero call budget is
 * not an enabled provider, and nothing couples the two settings — so the
 * sentence says only what both routes know.
 */
const NO_DISCOVERY_PATH_MESSAGE =
  "No research discovery path is available: no enabled search provider has " +
  "an API key and neither the managed browser nor Browser Use is available.";

/**
 * Where the paid rung reports a fault no attempt record can hold.
 *
 * Resolving the cloud provider fails before a session client exists, so what a
 * `cloud-browser` attempt must carry — the session's cost and what became of it
 * — does not exist yet. The reason travels here instead: the search names it in
 * its own failure when the rung was the lane's only path, and `execute`
 * journals it on the activity in every case.
 */
interface CloudRungSettingsFault {
  reason?: string;
}

export interface ResearchWebActivityView {
  readonly activityId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly assignmentId: string;
  readonly activityScopeId: string;
  readonly agentPath: string;
  readonly toolCallId: string;
  /** Provider tool-call order for the turn, when the provider exposed it. */
  readonly providerCallOrdinal?: number;
  readonly action: ResearchWebAction;
  /**
   * `running` is written before the call reaches the network, so a turn is
   * visible while it is still researching rather than only once it is over.
   */
  readonly state: "running" | "completed" | "failed" | "cancelled";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly requestedUrl?: string;
  readonly canonicalUrl?: string;
  readonly title?: string;
  readonly resultCount?: number;
  /**
   * The providers a completed search actually drew results from, as opposed to
   * `searchProviderPriority`, which records what the operator had configured.
   */
  readonly searchProviders?: readonly string[];
  /**
   * Provider priority journalled on a `not_configured` search so capability
   * diagnostics can name the operator's configured priority after the fact.
   */
  readonly searchProviderPriority?: readonly string[];
  /**
   * Why the paid Browser Use rung could not be created on this call.
   *
   * Journalled beside the failure the lane actually reported, because the fault
   * is the operator's to fix whether or not it is what blocked discovery. It
   * cannot be an entry in `attempts`: a rung that was never built opened no
   * session, and a `cloud-browser` attempt without that session's record is not
   * a shape the domain accepts.
   */
  readonly cloudBrowserSettingsFault?: string;
  readonly attempts: readonly AcquisitionAttempt[];
  readonly observationReceipt?: SourceObservationReceiptView;
  readonly extraction?: {
    readonly extractionId: string;
    readonly resultRelativePath: string;
    readonly receiptRelativePath: string;
    readonly complete: boolean;
    readonly requirementsMet: boolean;
    readonly fieldCount: number;
    readonly statusCounts: Readonly<Record<ExtractedFieldStatus, number>>;
    readonly methodsAttempted: SourceExtractionView["methodsAttempted"];
    readonly warningCount: number;
  };
  readonly extractionTelemetry?: {
    readonly usedModel: boolean;
    readonly provider?: string;
    readonly model?: string;
    readonly durationMs: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cost: number;
    readonly costTracked: boolean;
    readonly repairCount: number;
  };
  readonly error?: {
    readonly code: ResearchWebErrorCode;
    readonly message: string;
  };
}

export interface ResearchWebToolServiceOptions {
  readonly workspacePath: string;
  readonly repoRootPath: string;
  readonly settings: AcquisitionSettingsService;
  /**
   * The managed browser, narrowed to the one operation acquisition uses.
   *
   * `BrowserManager` satisfies it. Naming the operation rather than the class
   * is what lets a second browser backend — and a test — stand in without
   * dragging a whole Chrome along.
   */
  readonly browserManager?: BrowserEvidenceAcquirer;
  /**
   * The paid last rung.
   *
   * Absent means it never runs. Present still means it never runs until the
   * cloud call budget is raised above its default of zero.
   */
  readonly cloudAcquirer?: CloudEvidenceAcquirer;
  /**
   * Renderer used for managed-browser search fallback. Defaults to
   * `browserManager`; declared separately so discovery can be exercised
   * without launching Chrome and so an embedder can point search at a
   * different rendering surface.
   */
  readonly browserSearchRenderer?: BrowserSearchRenderer;
  readonly directAcquirer?: DirectHttpAcquirer;
  /**
   * Supplies the Webshare session used for the proxied retry rung.
   *
   * Absent means the retry never runs and acquisition keeps its current
   * shape. See `docs/adr/2026-08-28-Proxied-Direct-Acquisition-Retry.md`.
   */
  readonly webshareProxy?: WebshareProxyPort;
  readonly fileParserLauncher?: FileParserLauncher;
  readonly observationStore?: SourceObservationStore;
  readonly extractionService?: SourceExtractionService;
  readonly allowHttpLocalhost?: boolean;
  readonly now?: () => Date;
}

/** The single browser operation research acquisition performs. */
export interface BrowserEvidenceAcquirer {
  acquireEvidence(
    scope: BrowserExecutionScope,
    url: string,
    signal?: AbortSignal,
  ): Promise<BrowserAcquiredEvidence>;
}

/** The single cloud operation research acquisition performs. */
export interface CloudEvidenceAcquirer {
  acquire(
    url: string,
    policy: BrowserAgentPolicy,
    signal?: AbortSignal,
  ): Promise<CloudAcquisitionResult>;
}

interface ActivityAppendReservation {
  cancel(): void;
  /** Journals the call as running, holding its place in entry order. */
  begin(activity: ResearchWebActivityView): Promise<void>;
  /** Replaces that same row with its terminal record. */
  commit(activity: ResearchWebActivityView): Promise<void>;
}

export class ResearchWebToolService {
  readonly tool: McpNamespacedTool = {
    serverId: RESEARCH_WEB_SERVER_ID,
    serverName: "Research Web Acquisition",
    toolName: RESEARCH_WEB_TOOL_NAME,
    namespacedName: RESEARCH_WEB_TOOL_NAME,
    description: [
      "Search independent web indexes and acquire source evidence through a policy-safe fallback",
      "controller. Search results are discovery only. Acquire creates a verified source observation",
      "receipt using direct HTTP, managed Chrome, or an optional managed reader. Extract applies",
      "a schema to a stored observation. Use read_content and search_content for long observations.",
      "Send sourceValue=replaceable for exploratory discovery, index, and browse reads so acquire",
      "stays on direct HTTP and spends no browser or cloud budget; reserve important and",
      "unique-primary for a named claim that still lacks a required field and has no adequate",
      "substitute source, and stop escalating once that field is supported.",
    ].join(" "),
    inputSchema: researchWebToolInputSchema(),
    annotations: { openWorldHint: true, readOnlyHint: true },
    risk: "read-only",
    // Host-audited parallel read (docs/adr/2026-08-16-Research-Web-Parallel-Execution.md).
    // Budget counters are atomic — searches and managedReaders resolve
    // their settings awaits before the synchronous check-and-increment blocks,
    // and browsers and modelExtractions were already synchronous.
    // BrowserManager.contextForScope joins in-flight per-scope context
    // creation so concurrent browser fallbacks share one BrowserContext with
    // no leak. Per-call state is isolated: the search coordinator is
    // instantiated per call, DirectHttpAcquirer is immutable config, and
    // browser content writes use exclusive-create UUID paths.
    // Accepted benign races: concurrent same-URL acquisitions may duplicate
    // work with unique output paths and last-write-wins cache entries, and a
    // terminal host may receive one extra attempt; both are bounded
    // by the tool pool. Future-flip warning: the browser download action
    // shares a per-assignment downloads directory with a before/after diff
    // and is NOT same-key safe — do not extend parallel eligibility to it
    // without fixing that first.
    effect: hostAuditedParallelReadEffect(),
    requiresApproval: false,
  };

  private readonly directAcquirer: DirectHttpAcquirer;
  private readonly observationStore: SourceObservationStore;
  private readonly documentParser?: NativeDocumentParser;
  private readonly extractionService: SourceExtractionService;
  private readonly now: () => Date;
  private readonly activities = new Map<string, ResearchWebActivityView[]>();
  private readonly assignmentCounters = new Map<
    string,
    {
      searches: number;
      browsers: number;
      managedReaders: number;
      modelExtractions: number;
      cloudBrowsers: number;
      /** Provider-reported spend so far, browser plus proxy. */
      cloudCostMicros: number;
      /** True once any cloud call came back without a confirmed bill. */
      cloudMeterUnknown: boolean;
    }
  >();
  /**
   * Serializes the cloud spend decision per assignment lane.
   *
   * Acquisition runs host-audited parallel work, so a plain check-then-call
   * lets several calls pass the same stale total and overshoot the threshold by
   * however many happened to be in flight. Holding the decision and the call on
   * one chain per lane is what makes the documented one-call overshoot true.
   */
  private readonly cloudSpendChains = new Map<string, Promise<unknown>>();
  private readonly observationCache = new Map<string, ResearchWebToolOutput>();
  /** Per-lane suppressed hosts, each remembering the denial that caused it. */
  private readonly terminalHosts = new Map<
    string,
    Map<string, ResearchWebErrorCode>
  >();
  /** Entry-order gate: one call's running row lands before the next one's. */
  private readonly activityBeginQueues = new Map<string, Promise<void>>();
  /** Serializes the read-modify-write of one session's activity journal. */
  private readonly activityPersistQueues = new Map<string, Promise<void>>();

  constructor(private readonly options: ResearchWebToolServiceOptions) {
    this.directAcquirer =
      options.directAcquirer ??
      new DirectHttpAcquirer({
        ...whenDefined(options.allowHttpLocalhost, (allowHttpLocalhost) => ({
          allowHttpLocalhost,
        })),
      });
    this.observationStore =
      options.observationStore ?? new SourceObservationStore();
    this.extractionService =
      options.extractionService ??
      new SourceExtractionService({
        observationStore: this.observationStore,
        ...whenDefined(options.now, (now) => ({ now })),
      });
    if (options.fileParserLauncher) {
      this.documentParser = new NativeDocumentParser(options.fileParserLauncher);
    }
    this.now = options.now ?? (() => new Date());
  }

  isEnabledForAgent(agentPath: string): boolean {
    return readAcquisitionAgentPolicy(this.options.repoRootPath, agentPath)
      .enabled;
  }

  async listSession(
    sessionId: string,
  ): Promise<readonly ResearchWebActivityView[]> {
    if (!isSafePathSegment(sessionId)) return [];
    if (!this.activities.has(sessionId)) {
      const file = this.activityPath(sessionId);
      try {
        const parsed = file
          ? (JSON.parse(await fs.readFile(file, "utf8")) as unknown)
          : [];
        this.activities.set(
          sessionId,
          Array.isArray(parsed)
            ? parsed
                .filter((entry): entry is ResearchWebActivityView =>
                  isActivity(entry, sessionId),
                )
                .slice(-MAX_ACTIVITY_PER_SESSION)
            : [],
        );
      } catch {
        this.activities.set(sessionId, []);
      }
    }
    return [...(this.activities.get(sessionId) ?? [])];
  }

  async execute(
    context: McpBrokerRequestContext & { readonly activityScopeId?: string },
    toolCallId: string,
    rawInput: McpJsonObject,
    signal?: AbortSignal,
  ): Promise<ResearchWebToolOutput> {
    let input: ResearchWebToolInput;
    try {
      input = parseResearchWebToolInput(rawInput);
    } catch (error) {
      return failure(
        safeAction(rawInput.action),
        "invalid_request",
        error instanceof Error
          ? error.message
          : "Research web input is invalid.",
      );
    }
    if (
      !context.activityScopeId ||
      !isSafePathSegment(context.activityScopeId) ||
      !this.isEnabledForAgent(context.agentPath)
    ) {
      return failure(
        input.action,
        "domain_denied",
        "This agent is not permitted to use research web acquisition.",
      );
    }
    const location = buildSessionRunAssignmentLocation(
      this.options.workspacePath,
      context,
    );
    if (!location) {
      return failure(
        input.action,
        "invalid_request",
        "Research assignment scope is unavailable.",
      );
    }
    const activityReservation = this.reserveActivityAppend(context.sessionId);
    const assignmentPath = await canonicalContainedDirectory(
      this.options.workspacePath,
      location.relativeAssignmentPath,
    );
    if (!assignmentPath) {
      activityReservation.cancel();
      return failure(
        input.action,
        "invalid_request",
        "Research assignment scope is unavailable.",
      );
    }
    const scopedContext: McpBrokerRequestContext & {
      readonly activityScopeId: string;
    } = {
      ...context,
      activityScopeId: context.activityScopeId,
    };
    const activityId = randomUUID();
    const createdAt = this.now().toISOString();
    // Published before the call reaches the network, so the turn is visible
    // while it is still working. The terminal record replaces this same row.
    await activityReservation.begin({
      activityId,
      sessionId: context.sessionId,
      runId: context.runId,
      assignmentId: context.assignmentId,
      activityScopeId: context.activityScopeId,
      agentPath: context.agentPath,
      toolCallId,
      ...(context.providerCallOrdinal === undefined
        ? {}
        : { providerCallOrdinal: context.providerCallOrdinal }),
      action: input.action,
      state: "running",
      createdAt,
      updatedAt: createdAt,
      ...(input.url ? { requestedUrl: input.url } : {}),
      attempts: [],
    });
    let output: ResearchWebToolOutput;
    let extractionExecution: SourceExtractionExecution | undefined;
    const settingsFault: CloudRungSettingsFault = {};
    try {
      if (input.action === "search") {
        output = await this.search(
          scopedContext,
          assignmentPath,
          input,
          settingsFault,
          signal,
        );
      } else if (input.action === "extract") {
        extractionExecution = await this.extract(
          scopedContext,
          assignmentPath,
          activityId,
          input,
          signal,
        );
        output = {
          ok: true,
          action: "extract",
          extraction: extractionExecution.view,
        };
      } else if (input.action === "read_content") {
        output = await this.readContent(scopedContext, assignmentPath, input);
      } else if (input.action === "search_content") {
        output = await this.searchContent(scopedContext, assignmentPath, input);
      } else {
        output = await this.acquire(
          scopedContext,
          assignmentPath,
          activityId,
          input,
          signal,
        );
      }
    } catch (error) {
      output = normalizeFailure(input.action, error, signal);
    }
    const searchProviderPriority = await this.journalSearchProviderPriority(
      input,
      output,
    );
    const updatedAt = this.now().toISOString();
    await activityReservation.commit({
      activityId,
      sessionId: context.sessionId,
      runId: context.runId,
      assignmentId: context.assignmentId,
      activityScopeId: context.activityScopeId,
      agentPath: context.agentPath,
      toolCallId,
      ...(context.providerCallOrdinal === undefined
        ? {}
        : { providerCallOrdinal: context.providerCallOrdinal }),
      action: input.action,
      state: output.ok
        ? "completed"
        : output.error?.code === "cancelled"
          ? "cancelled"
          : "failed",
      createdAt,
      updatedAt,
      ...(output.requestedUrl ? { requestedUrl: output.requestedUrl } : {}),
      ...(output.canonicalUrl ? { canonicalUrl: output.canonicalUrl } : {}),
      ...(output.title ? { title: output.title } : {}),
      ...(output.results ? { resultCount: output.results.length } : {}),
      ...whenDefined(searchProvidersOf(output), (searchProviders) => ({
        searchProviders,
      })),
      ...(searchProviderPriority
        ? { searchProviderPriority }
        : {}),
      ...(settingsFault.reason
        ? { cloudBrowserSettingsFault: settingsFault.reason }
        : {}),
      attempts: output.attempts ?? [],
      ...(output.observationReceipt
        ? { observationReceipt: output.observationReceipt }
        : {}),
      ...(output.extraction
        ? { extraction: summarizeExtraction(output.extraction) }
        : {}),
      ...(extractionExecution
        ? {
            extractionTelemetry: {
              usedModel: extractionExecution.usedModel,
              ...(extractionExecution.provider
                ? { provider: extractionExecution.provider }
                : {}),
              ...(extractionExecution.model
                ? { model: extractionExecution.model }
                : {}),
              durationMs: extractionExecution.durationMs,
              inputTokens: extractionExecution.inputTokens,
              outputTokens: extractionExecution.outputTokens,
              cost: extractionExecution.cost,
              costTracked: extractionExecution.costTracked,
              repairCount: extractionExecution.repairCount,
            },
          }
        : {}),
      ...(output.error ? { error: output.error } : {}),
    });
    if (input.action === "acquire" && input.url) {
      publishResearchAcquisitionCompletedEvent({
        assignmentPath,
        context: scopedContext,
        activityId,
        toolCallId,
        sourceUrl: input.url,
        output,
        occurredAt: updatedAt,
      });
    }
    return output;
  }

  async releaseAssignment(scope: {
    readonly sessionId: string;
    readonly runId: string;
    readonly assignmentId: string;
    readonly activityScopeId?: string;
  }): Promise<void> {
    const key = assignmentKey(scope);
    this.assignmentCounters.delete(key);
    this.terminalHosts.delete(key);
    // Released with everything else the lane owns. Left behind, one promise per
    // assignment accumulates for the life of the process.
    this.cloudSpendChains.delete(key);
    for (const cacheKey of this.observationCache.keys()) {
      if (cacheKey.startsWith(`${key}\0`))
        this.observationCache.delete(cacheKey);
    }
  }

  private async journalSearchProviderPriority(
    input: ResearchWebToolInput,
    output: ResearchWebToolOutput,
  ): Promise<readonly string[] | undefined> {
    if (
      input.action !== "search" ||
      output.ok ||
      output.error?.code !== "not_configured"
    ) {
      return undefined;
    }
    const snapshot = await this.options.settings.snapshot();
    return snapshot.providerPriority;
  }

  private async search(
    context: McpBrokerRequestContext & { readonly activityScopeId: string },
    assignmentPath: string,
    input: ResearchWebToolInput,
    settingsFault: CloudRungSettingsFault,
    signal?: AbortSignal,
  ): Promise<ResearchWebToolOutput> {
    const budget = await this.options.settings.budgets();
    const providers = await this.options.settings.searchProviders();
    const counters = this.counters(context);
    // Configured API providers are preferred because they return ranked,
    // filterable results without rendering a search page. The managed browser
    // keeps discovery available when no provider is configured and when every
    // configured provider fails or returns no usable result. Browser Use is
    // the explicitly enabled paid last rung when that local render fails.
    const browserSearch = this.browserSearchProvider(context, assignmentPath);
    // Whether the paid rung could still run is decided from the budget and the
    // lane's own counters. Resolve availability before the search budget's
    // synchronous check and increment; nothing between those may suspend. Two
    // concurrent searches that both clear a budget of one each buy a session; only
    // synchronous code keeps that claim atomic
    // (docs/adr/2026-08-16-Research-Web-Parallel-Execution.md).
    const cloudRungFunded = !this.outOfCloudBudget(budget, counters);
    const cloudRungConfigured = providers.length === 0 && !browserSearch && cloudRungFunded
      ? await this.cloudBrowserConfigured()
      : true;
    if (counters.searches >= budget.maximumSearchCalls) {
      return failure(
        input.action,
        "budget_exhausted",
        "The search-call budget for this research lane is exhausted.",
      );
    }
    if (providers.length === 0 && !browserSearch && (!cloudRungFunded || !cloudRungConfigured)) {
      // The budget counts calls that exercised a discovery path. This one had
      // none to exercise, so it spends nothing: a later repaired configuration
      // must still find the lane's search budget intact. A configured paid rung
      // whose own budget is spent is named as such, because `not_configured`
      // sends the operator to buy a search API key for a lane that has one.
      return this.outOfCloudBudget(budget, counters)
        ? failure(
            input.action,
            "budget_exhausted",
            `${this.cloudRungClosedReason(budget, counters)}, and no free ` +
              "discovery path is configured.",
          )
        : failure(input.action, "not_configured", NO_DISCOVERY_PATH_MESSAGE);
    }
    counters.searches += 1;
    let providerFailure: unknown;
    if (providers.length > 0) {
      try {
        const results = await new AcquisitionSearchCoordinator(providers).search(
          input,
          signal,
        );
        if (results.length > 0) {
          return { ok: true, action: "search", results };
        }
        if (!browserSearch) {
          const cloud = await this.searchWithCloudBrowser({
            context,
            assignmentPath,
            input,
            settingsFault,
            ...whenDefined(signal, (presentSignal) => ({ signal: presentSignal })),
          });
          return (
            cloud ?? { ok: true, action: "search", results }
          );
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        providerFailure = error;
      }
    }
    if (!browserSearch) {
      const cloud = await this.searchWithCloudBrowser({
        context,
        assignmentPath,
        input,
        settingsFault,
        ...whenDefined(signal, (presentSignal) => ({ signal: presentSignal })),
      });
      if (cloud) return cloud;
      if (providerFailure) throw providerFailure;
      if (settingsFault.reason) {
        // The paid rung was this lane's only path and handed back why it could
        // not be built — today an unreadable or malformed cloud setting, the one
        // fault the rung returns from without an output of its own. No search
        // API key fixes that, so reporting `not_configured` would send the
        // operator to buy a credential for a lane that already has one. The
        // call keeps the search slot it took, because it did reach the rung:
        // a lane whose settings stay broken spends its budget and stops,
        // instead of retrying the same fault for as long as it is asked to.
        return failure(
          input.action,
          "internal",
          "Browser Use was this research lane's only discovery path and could " +
            `not be created: ${settingsFault.reason}`,
        );
      }
      // The rung was funded by its call budget when this call was admitted and
      // produced nothing when it ran. It reported no fault, and the ordinary
      // cause is a Browser Use that was never enabled or never keyed rather
      // than a rung that stopped working mid-run, so the lane says only that no
      // path was available.
      return failure(input.action, "not_configured", NO_DISCOVERY_PATH_MESSAGE);
    }
    try {
      const results = await browserSearch.search(
        {
          query: input.query?.trim() ?? "",
          maximumResults: Math.max(1, Math.min(input.maximumResults ?? 10, 20)),
          includeDomains: input.includeDomains ?? [],
          excludeDomains: input.excludeDomains ?? [],
        },
        signal,
      );
      return { ok: true, action: "search", results };
    } catch (error) {
      const cloud = await this.searchWithCloudBrowser({
        context,
        assignmentPath,
        input,
        settingsFault,
        ...whenDefined(signal, (presentSignal) => ({ signal: presentSignal })),
      });
      if (cloud) return cloud;
      // A bot challenge is not an empty web. Reporting it as a successful
      // search with the engine's own links starves the lane of evidence while
      // every diagnostic says discovery worked.
      if (error instanceof BrowserSearchChallengeError) {
        return failure(input.action, "access_challenge", error.message);
      }
      throw error;
    }
  }

  private async cloudBrowserConfigured(): Promise<boolean> {
    if (this.options.cloudAcquirer) return true;
    const provider = (await this.options.settings.snapshot()).providers["browser-use"];
    return provider.enabled && provider.hasApiKey;
  }

  /**
   * Whether this lane has spent its paid cloud budget — true once it may
   * create no further session.
   *
   * Reads only an already-resolved budget and the lane's own counters, so both
   * ladders can consult it without suspending. The search path needs that: the
   * call it admits has to be counted in the same synchronous step it was
   * admitted in, or two concurrent searches both clear a budget of one.
   */
  private outOfCloudBudget(
    budget: AcquisitionBudgets,
    counters: {
      readonly cloudBrowsers: number;
      readonly cloudCostMicros: number;
      readonly cloudMeterUnknown: boolean;
    },
  ): boolean {
    return (
      (budget.maximumCloudBrowserCalls > 0 &&
        counters.cloudBrowsers >= budget.maximumCloudBrowserCalls) ||
      (budget.maximumCloudBrowserCostMicros > 0 &&
        counters.cloudCostMicros >= budget.maximumCloudBrowserCostMicros) ||
      // An unknown bill is not a zero bill. Once one call comes back without
      // a confirmed meter, this lane stops creating more.
      counters.cloudMeterUnknown
    );
  }

  /**
   * Which of the three verdicts closed the paid rung, as a sentence.
   *
   * They are different faults with different fixes — a spent call budget, a
   * spent cost budget, and a session whose bill never came back — and naming
   * the wrong one sends the operator to raise a limit that never moved. Read in
   * the order `outOfCloudBudget` decides them, so the sentence names the first
   * counter that closed the rung. Only meaningful where that verdict is already
   * true; the last branch is what remains once the two budgets are ruled out.
   */
  private cloudRungClosedReason(
    budget: AcquisitionBudgets,
    counters: {
      readonly cloudBrowsers: number;
      readonly cloudCostMicros: number;
      readonly cloudMeterUnknown: boolean;
    },
  ): string {
    if (budget.maximumCloudBrowserCalls > 0 && counters.cloudBrowsers >= budget.maximumCloudBrowserCalls) {
      return "The Browser Use call budget for this research lane is exhausted";
    }
    if (budget.maximumCloudBrowserCostMicros > 0 && counters.cloudCostMicros >= budget.maximumCloudBrowserCostMicros) {
      return "The Browser Use cost budget for this research lane is exhausted";
    }
    return (
      "A Browser Use session for this research lane returned without a " +
      "confirmed bill, so no further session may be created"
    );
  }

  /**
   * Render one search-results page through the paid browser rung.
   *
   * The same per-lane call and cost counters used by source acquisition guard
   * this path. The provider is resolved only after the free search paths fail,
   * so enabling Browser Use does not spend on a search an API or local Chrome
   * already completed.
   */
  private async searchWithCloudBrowser(params: {
    readonly context: McpBrokerRequestContext & {
      readonly activityScopeId: string;
    };
    readonly assignmentPath: string;
    readonly input: ResearchWebToolInput;
    /** Where a rung that could not be built at all reports why. */
    readonly settingsFault: CloudRungSettingsFault;
    readonly signal?: AbortSignal;
  }): Promise<ResearchWebToolOutput | undefined> {
    if (params.signal?.aborted) return undefined;
    const budget = await this.options.settings.budgets();
    const counters = this.counters(params.context);
    const key = assignmentKey(params.context);
    // What this rung actually tried, carried on whichever output it returns. A
    // rung that was never built made no attempt and reports through
    // `settingsFault` instead.
    const attempts: AcquisitionAttempt[] = [];
    const previous = this.cloudSpendChains.get(key) ?? Promise.resolve();
    const chained = previous.then(async () => {
      // Eligibility first, and only then the provider, exactly as the read path
      // resolves them. Resolving it up front meant a malformed setting could
      // break a search that was never going to spend anything, and the lane
      // reported the settings fault instead of what actually blocked discovery.
      if (this.outOfCloudBudget(budget, counters)) return undefined;
      // Injected for tests; resolved from settings in production, so turning the
      // provider off or removing its key takes effect without a restart.
      let acquirer: CloudEvidenceAcquirer | undefined;
      try {
        acquirer =
          this.options.cloudAcquirer ?? (await this.options.settings.cloudBrowser());
      } catch (error) {
        // A rung that cannot be built is an unusable rung, not the reason the
        // lane came here. Letting the settings fault escape rewrote a bot
        // challenge as a retryable `internal` error naming a proxy variable.
        // It is still an operator's to fix, so the reason is handed back for
        // the journal and the caller goes on to report the wall it met.
        params.settingsFault.reason = cloudSettingsFaultReason(error);
        return undefined;
      }
      if (!acquirer) return undefined;
      let lastOutput: ResearchWebToolOutput | undefined;
      for (const endpoint of CLOUD_BROWSER_SEARCH_ENDPOINTS) {
        // Re-read before each endpoint so the second answers to what the first
        // spent.
        if (this.outOfCloudBudget(budget, counters)) break;
        // Incremented before any I/O, so a second caller sees it immediately.
        counters.cloudBrowsers += 1;
        const output = await this.executeCloudBrowserSearch({
          ...params,
          acquirer,
          counters,
          endpoint,
        });
        attempts.push(...(output.attempts ?? []));
        lastOutput = { ...output, attempts: [...attempts] };
        if (output.ok && (output.results?.length ?? 0) > 0) return lastOutput;
        if (!output.ok && output.error?.code === "cancelled") return lastOutput;
      }
      return lastOutput;
    });
    this.cloudSpendChains.set(key, chained.catch(() => undefined));
    return chained;
  }

  private async executeCloudBrowserSearch(params: {
    readonly acquirer: CloudEvidenceAcquirer;
    readonly context: McpBrokerRequestContext & {
      readonly activityScopeId: string;
    };
    readonly assignmentPath: string;
    readonly input: ResearchWebToolInput;
    readonly endpoint: string;
    readonly counters: {
      cloudCostMicros: number;
      cloudMeterUnknown: boolean;
    };
    readonly signal?: AbortSignal;
  }): Promise<ResearchWebToolOutput> {
    const started = this.now();
    const policy = readAcquisitionAgentPolicy(
      this.options.repoRootPath,
      params.context.agentPath,
    );
    let cloudResult: CloudAcquisitionResult | undefined;
    const renderer: BrowserSearchRenderer = {
      acquireEvidence: async (_scope, url, signal) => {
        cloudResult = await params.acquirer.acquire(url, policy, signal);
        this.recordCloudUsage(params.counters, cloudResult);
        if (!cloudResult.evidence) {
          throw new Error(
            cloudResult.failure?.message ??
              "Browser Use did not render search results.",
          );
        }
        return {
          renderedHtml: cloudResult.evidence.renderedHtml,
          finalUrl: cloudResult.evidence.finalUrl,
        };
      },
    };
    try {
      const results = await new BrowserSearchProvider(renderer, {
        ...params.context,
        assignmentPath: params.assignmentPath,
        policy,
      }, params.endpoint).search(
        {
          query: params.input.query?.trim() ?? "",
          maximumResults: Math.max(
            1,
            Math.min(params.input.maximumResults ?? 10, 20),
          ),
          includeDomains: params.input.includeDomains ?? [],
          excludeDomains: params.input.excludeDomains ?? [],
        },
        params.signal,
      );
      const attempt = cloudSearchAttempt(
        cloudResult,
        started,
        this.now(),
        results.length > 0 ? "usable" : "insufficient",
        results.length > 0
          ? undefined
          : "Browser Use rendered the search page but it contained no results.",
      );
      return {
        ok: true,
        action: "search",
        results: results.map((result) => ({
          ...result,
          provider: "browser-use",
        })),
        ...(attempt ? { attempts: [attempt] } : {}),
      };
    } catch (error) {
      const cancelled =
        params.signal?.aborted === true ||
        cloudResult?.failure?.code === "cancelled";
      const challenged = error instanceof BrowserSearchChallengeError;
      const attempt = cloudSearchAttempt(
        cloudResult,
        started,
        this.now(),
        cancelled ? "cancelled" : challenged ? "challenge" : "failed",
        error instanceof Error ? error.message : String(error),
      );
      return failure(
        "search",
        cancelled ? "cancelled" : challenged ? "access_challenge" : "internal",
        cancelled
          ? "Research web acquisition was cancelled."
          : error instanceof Error
            ? error.message
            : "Browser Use search failed.",
        !cancelled && !challenged,
        attempt ? [attempt] : undefined,
      );
    }
  }

  /** The managed-browser discovery path, if a renderer is wired. */
  private browserSearchProvider(
    context: McpBrokerRequestContext & { readonly activityScopeId: string },
    assignmentPath: string,
  ): BrowserSearchProvider | undefined {
    const renderer =
      this.options.browserSearchRenderer ?? this.options.browserManager;
    if (!renderer) return undefined;
    return new BrowserSearchProvider(renderer, {
      sessionId: context.sessionId,
      runId: context.runId,
      assignmentId: context.assignmentId,
      activityScopeId: context.activityScopeId,
      assignmentPath,
      policy: readAcquisitionAgentPolicy(
        this.options.repoRootPath,
        context.agentPath,
      ),
    });
  }

  private async acquire(
    context: McpBrokerRequestContext & { readonly activityScopeId: string },
    assignmentPath: string,
    activityId: string,
    input: ResearchWebToolInput,
    signal?: AbortSignal,
  ): Promise<ResearchWebToolOutput> {
    if (!input.url)
      return failure(
        input.action,
        "invalid_request",
        "Source URL is required.",
      );
    const key = assignmentKey(context);
    const cacheKey = `${key}\0${cacheUrl(input.url)}`;
    const cached = this.observationCache.get(cacheKey);
    if (cached) return cached;
    const host = safeHost(input.url);
    const suppressed = host ? this.terminalHosts.get(key)?.get(host) : undefined;
    if (suppressed) {
      return failure(
        input.action,
        suppressed,
        "This host is blocked for the current research lane after a terminal acquisition failure.",
      );
    }
    const policy = readAcquisitionAgentPolicy(
      this.options.repoRootPath,
      context.agentPath,
    );
    const attempts: AcquisitionAttempt[] = [];
    /** One acquisition, one proxied managed-browser retry. */
    let browserProxyRetryUsed = false;
    const directStarted = this.now();
    const direct = await this.directAcquirer.acquire({
      url: input.url,
      policy,
      ...whenDefined(signal, (presentSignal) => ({ signal: presentSignal })),
    });
    attempts.push(
      directAttempt("direct-http", directStarted, this.now(), direct),
    );
    if (direct.ok) {
      if (direct.kind === "document") {
        return this.acquireDocument({
          context,
          assignmentPath,
          activityId,
          direct,
          attempts,
          cacheKey,
          ...whenDefined(signal, (presentSignal) => ({ signal: presentSignal })),
        });
      }
      return this.persistSuccess(
        context,
        assignmentPath,
        activityId,
        "direct-http",
        direct,
        attempts,
        cacheKey,
      );
    }
    if (direct.terminal) {
      // The Webshare trigger. Everything this capability adds hangs off it, so
      // an untriggered call keeps the exact path it had before the proxy
      // existed. See docs/adr/2026-08-28-Proxied-Direct-Acquisition-Retry.md.
      const triggered = outcomeEarnsProxyRetry(direct.outcome)
        ? await this.openWebshareSession(signal)
        : undefined;
      if (!triggered) {
        // Exit 3. With no proxy configured this returned outright, which meant
        // a direct refusal in the ordinary installation never reached any tail.
        const recovered = await this.tryCloudRung({
          context,
          assignmentPath,
          activityId,
          url: input.url,
          attempts,
          policy,
          cacheKey,
          ...whenDefined(signal, (presentSignal) => ({ signal: presentSignal })),
        });
        if (recovered) return recovered;
        if (host && outcomeSuppressesHost(direct.outcome)) {
          this.blockHost(key, host, direct.code);
        }
        return failure(
          input.action,
          direct.code,
          direct.message,
          direct.retryable,
          attempts,
          direct.requestedUrl,
          direct.finalUrl,
        );
      }
      try {
        return await this.acquireThroughProxiedLadder({
          context,
          assignmentPath,
          activityId,
          input,
          url: input.url,
          direct,
          triggered,
          attempts,
          policy,
          cacheKey,
          key,
          host,
          ...whenDefined(signal, (presentSignal) => ({ signal: presentSignal })),
        });
      } finally {
        await triggered.session?.close().catch(() => undefined);
      }
    }

    const budget = await this.options.settings.budgets();
    const counters = this.counters(context);
    /** Set when an enabled cloud escalation must wait for a free reader rung. */
    let browserRefusalDeferred = false;
    if (
      (input.allowBrowserFallback === true ||
        (input.allowBrowserFallback !== false &&
          input.sourceValue !== "replaceable")) &&
      this.options.browserManager &&
      counters.browsers < budget.maximumBrowserFallbacks
    ) {
      counters.browsers += 1;
      let browser = await this.acquireWithBrowser({
        context,
        assignmentPath,
        activityId,
        url: input.url,
        attempts,
        policy,
        ...whenDefined(signal, (presentSignal) => ({ signal: presentSignal })),
      });
      // One proxied retry, and only for an outcome that means this host refused
      // this egress. With no port configured `openWebshareSession` returns
      // before any I/O, so an untriggered call keeps the path it has today.
      let retriedThroughProxy = false;
      if (
        !browser.output &&
        !signal?.aborted &&
        browserProxyRetryApplies({
          outcome: attempts.at(-1)?.outcome,
          alreadyRetried: browserProxyRetryUsed,
          browserAttemptsUsed: counters.browsers,
          maximumBrowserFallbacks: budget.maximumBrowserFallbacks,
        })
      ) {
        const triggered = await this.openWebshareSession(signal);
        if (triggered) {
          try {
            const retried = await this.retryBrowserThroughProxy({
              context,
              assignmentPath,
              activityId,
              url: input.url,
              attempts,
              policy,
              counters,
              triggered,
              ...whenDefined(signal, (presentSignal) => ({
                signal: presentSignal,
              })),
            });
            if (retried) {
              browserProxyRetryUsed = true;
              retriedThroughProxy = true;
              browser = retried;
            }
          } finally {
            await triggered.session?.close().catch(() => undefined);
          }
        }
      }
      if (browser.output) {
        if (browser.output.ok)
          this.observationCache.set(cacheKey, browser.output);
        return browser.output;
      }
      const lastBrowserOutcome = attempts.at(-1)?.outcome;
      if (lastBrowserOutcome === "cancelled") {
        // A withdrawn caller ends the call rather than walking on to the reader.
        return failure(
          input.action,
          browser.code,
          browser.message,
          false,
          attempts,
          direct.requestedUrl,
          direct.finalUrl,
        );
      }
      if (browser.terminal) {
        // Exit 4. A terminal browser refusal returned before the reader and
        // before any tail.
        //
        // The paid rung is deliberately *not* offered here when a managed
        // reader is still available: cloud is the last rung, and jumping a free
        // one to reach it would spend money the ladder had not yet earned the
        // right to spend. Falling through lets the reader run and the shared
        // tail below make the cloud decision once.
        if (
          !this.outOfCloudBudget(budget, counters) &&
          (await this.cloudBrowserConfigured()) &&
          (await this.managedReaderAvailable(input, counters, budget))
        ) {
          browserRefusalDeferred = true;
        } else {
          const recoveredAfterBrowser = await this.tryCloudRung({
            context,
            assignmentPath,
            activityId,
            url: input.url,
            attempts,
            policy,
            cacheKey,
            ...whenDefined(signal, (presentSignal) => ({ signal: presentSignal })),
          });
          if (recoveredAfterBrowser) return recoveredAfterBrowser;
        }
      }
      if (browser.terminal && !browserRefusalDeferred) {
        // The ban follows the last rung actually attempted. With no retry that
        // is the browser rung, and today's unconditional ban stands unchanged;
        // with one it is the proxied rung, so a missing page or a proxy that
        // would not connect leaves the host reachable.
        if (retriedThroughProxy)
          this.blockHostWhenScoped({ host, key }, lastBrowserOutcome);
        // A challenge is the one terminal browser outcome that no longer bans
        // the host. Every other one keeps the treatment it had.
        else if (host && lastBrowserOutcome !== "challenge") {
          this.blockHost(key, host, browser.code);
        }
        return failure(
          input.action,
          browser.code,
          browser.message,
          false,
          attempts,
          direct.requestedUrl,
          direct.finalUrl,
        );
      }
    }

    if (input.allowManagedReaderFallback === true) {
      const managedReader = await this.options.settings.managedReader();
      if (
        managedReader &&
        counters.managedReaders < budget.maximumManagedReaderCalls
      ) {
        counters.managedReaders += 1;
        const reader = await this.acquireWithManagedReader({
          context,
          assignmentPath,
          activityId,
          url: input.url,
          attempts,
          provider: managedReader,
          cacheKey,
          ...whenDefined(signal, (presentSignal) => ({ signal: presentSignal })),
        });
        // Exit 1. The reader used to end the call whatever it returned, which
        // left no room for a rung after it. A reader that succeeded still wins.
        if (reader.ok) return reader;
        const recoveredAfterReader = await this.tryCloudRung({
          context,
          assignmentPath,
          activityId,
          url: input.url,
          attempts,
          policy,
          cacheKey,
          ...whenDefined(signal, (presentSignal) => ({ signal: presentSignal })),
        });
        return recoveredAfterReader ?? reader;
      }
    }
    // Nothing above produced evidence. A source that was refused earlier still
    // earns the last rung even though the rung before it merely came up short.
    const recoveredAtTail = await this.tryCloudRung({
      context,
      assignmentPath,
      activityId,
      url: input.url,
      attempts,
      policy,
      cacheKey,
      ...whenDefined(signal, (presentSignal) => ({ signal: presentSignal })),
    });
    if (recoveredAtTail) return recoveredAtTail;
    return failure(
      input.action,
      "empty_content",
      "The source did not produce usable evidence. Use another authoritative source.",
      false,
      attempts,
      direct.requestedUrl,
      direct.finalUrl,
    );
  }

  /**
   * Opens one Webshare session, or reports that opening was attempted and failed.
   *
   * `undefined` means the trigger does not fire: no port was supplied, or the
   * port reported the proxy off. Both are decisions, not failures, so the
   * caller keeps its original path. A thrown error is a configured proxy that
   * cannot be used, which fires the trigger so the failure stays visible.
   */
  private async openWebshareSession(
    signal?: AbortSignal,
  ): Promise<WebshareTrigger | undefined> {
    const port = this.options.webshareProxy;
    if (!port) return undefined;
    try {
      const session = await port.open(signal);
      return session ? { session } : undefined;
    } catch (error) {
      // A caller abort is not a proxy fault. Reshaping it into an open failure
      // would let a cancelled call walk on into the browser and reader rungs.
      if (isCancellation(error, signal)) return { cancelled: true };
      return { openFailure: redactedProxyFailure(error) };
    }
  }

  /**
   * The ladder reached only through the Webshare trigger.
   *
   * It differs from the ordinary path in exactly three ways: it retries the
   * denied read once through the proxy, a terminal browser result no longer
   * ends the call while a managed reader is still allowed, and the lane ban is
   * applied once, from the outcome of the last rung actually attempted.
   */
  private async acquireThroughProxiedLadder(params: {
    readonly context: McpBrokerRequestContext & {
      readonly activityScopeId: string;
    };
    readonly assignmentPath: string;
    readonly activityId: string;
    readonly input: ResearchWebToolInput;
    readonly url: string;
    readonly direct: Extract<
      Awaited<ReturnType<DirectHttpAcquirer["acquire"]>>,
      { readonly ok: false }
    >;
    readonly triggered: WebshareTrigger;
    readonly attempts: AcquisitionAttempt[];
    readonly policy: BrowserAgentPolicy;
    readonly cacheKey: string;
    readonly key: string;
    readonly host: string | null;
    readonly signal?: AbortSignal;
  }): Promise<ResearchWebToolOutput> {
    const { attempts, input, direct } = params;
    /** One acquisition, one proxied managed-browser retry. */
    let browserProxyRetryUsed = false;
    /** Every exit from this ladder returns through the same shape. */
    const exit = (
      code: ResearchWebErrorCode,
      message: string,
    ): ResearchWebToolOutput =>
      failure(
        input.action,
        code,
        message,
        false,
        attempts,
        direct.requestedUrl,
        direct.finalUrl,
      );
    let finalOutcome: AcquisitionAttemptOutcome = direct.outcome;
    let finalCode: ResearchWebErrorCode = direct.code;
    let finalMessage = direct.message;

    if (params.triggered.cancelled) {
      attempts.push({
        method: "direct-http-proxied",
        outcome: "cancelled",
        startedAt: this.now().toISOString(),
        durationMs: 0,
        reason: CANCELLED_ACQUISITION_MESSAGE,
      });
      return exit("cancelled", CANCELLED_ACQUISITION_MESSAGE);
    }

    const openFailure = params.triggered.openFailure;
    if (openFailure) {
      attempts.push({
        method: "direct-http-proxied",
        outcome: "failed",
        startedAt: this.now().toISOString(),
        durationMs: 0,
        reason: openFailure,
      });
      // The open attempt is the last rung reached, so it owns the returned
      // failure and the lane-ban decision rather than the direct denial.
      finalOutcome = "failed";
      finalCode = "internal";
      finalMessage = openFailure;
    } else if (params.triggered.session) {
      const started = this.now();
      const proxied = await this.directAcquirer.acquire({
        url: params.url,
        policy: params.policy,
        transport: params.triggered.session,
        ...whenDefined(params.signal, (presentSignal) => ({
          signal: presentSignal,
        })),
      });
      attempts.push(
        directAttempt("direct-http-proxied", started, this.now(), proxied),
      );
      if (proxied.ok) {
        if (proxied.kind === "document") {
          return this.acquireDocument({
            context: params.context,
            assignmentPath: params.assignmentPath,
            activityId: params.activityId,
            direct: proxied,
            attempts,
            cacheKey: params.cacheKey,
            ...whenDefined(params.signal, (presentSignal) => ({
              signal: presentSignal,
            })),
          });
        }
        return this.persistSuccess(
          params.context,
          params.assignmentPath,
          params.activityId,
          "direct-http-proxied",
          proxied,
          attempts,
          params.cacheKey,
        );
      }
      if (proxied.outcome === "cancelled") {
        return exit(proxied.code, proxied.message);
      }
      finalOutcome = proxied.outcome;
      finalCode = proxied.code;
      finalMessage = proxied.message;
    }

    const budget = await this.options.settings.budgets();
    const counters = this.counters(params.context);
    if (
      browserFallbackRequested(input) &&
      this.options.browserManager &&
      counters.browsers < budget.maximumBrowserFallbacks
    ) {
      counters.browsers += 1;
      let browser = await this.acquireWithBrowser({
        context: params.context,
        assignmentPath: params.assignmentPath,
        activityId: params.activityId,
        url: params.url,
        attempts,
        policy: params.policy,
        ...whenDefined(params.signal, (presentSignal) => ({
          signal: presentSignal,
        })),
      });
      // The same one retry as the legacy path, reusing the session this ladder
      // already holds. Only the session is passed on: an open failure was
      // recorded above and must not be recorded a second time here.
      if (
        !browser.output &&
        !params.signal?.aborted &&
        browserProxyRetryApplies({
          outcome: attempts.at(-1)?.outcome,
          alreadyRetried: browserProxyRetryUsed,
          browserAttemptsUsed: counters.browsers,
          maximumBrowserFallbacks: budget.maximumBrowserFallbacks,
        })
      ) {
        const retried = await this.retryBrowserThroughProxy({
          context: params.context,
          assignmentPath: params.assignmentPath,
          activityId: params.activityId,
          url: params.url,
          attempts,
          policy: params.policy,
          counters,
          triggered: {
            ...whenDefined(params.triggered.session, (session) => ({ session })),
          },
          ...whenDefined(params.signal, (presentSignal) => ({
            signal: presentSignal,
          })),
        });
        if (retried) {
          browserProxyRetryUsed = true;
          browser = retried;
        }
      }
      if (browser.output) {
        if (browser.output.ok)
          this.observationCache.set(params.cacheKey, browser.output);
        return browser.output;
      }
      // A terminal browser result is a candidate failure here, not an exit.
      finalOutcome = attempts.at(-1)?.outcome ?? finalOutcome;
      finalCode = browser.code;
      finalMessage = browser.message;
      // Cancellation is the exception: a withdrawn caller ends the call, so it
      // must not be carried forward into the reader rung.
      if (finalOutcome === "cancelled") {
        return exit(finalCode, finalMessage);
      }
    }

    if (input.allowManagedReaderFallback === true) {
      const managedReader = await this.options.settings.managedReader();
      if (
        managedReader &&
        counters.managedReaders < budget.maximumManagedReaderCalls
      ) {
        counters.managedReaders += 1;
        const reader = await this.acquireWithManagedReader({
          context: params.context,
          assignmentPath: params.assignmentPath,
          activityId: params.activityId,
          url: params.url,
          attempts,
          provider: managedReader,
          cacheKey: params.cacheKey,
          ...whenDefined(params.signal, (presentSignal) => ({
            signal: presentSignal,
          })),
        });
        if (reader.ok) return reader;
        // Captured *before* the cloud rung runs. The rung appends its own
        // attempt, so reading `attempts.at(-1)` afterwards would consult the
        // provider's failure and quietly drop a reader `access-denied` that had
        // already earned the lane ban.
        const readerOutcome = attempts.at(-1)?.outcome;
        // Exit 2. The proxied reader also ended the call, and it owns the lane
        // ban. The cloud rung is offered before that ban is decided, so a
        // recovered source is not banned on the way out.
        const recoveredAfterProxiedReader = await this.tryCloudRung({
          context: params.context,
          assignmentPath: params.assignmentPath,
          activityId: params.activityId,
          url: params.url,
          attempts,
          policy: params.policy,
          cacheKey: params.cacheKey,
          ...whenDefined(params.signal, (presentSignal) => ({
            signal: presentSignal,
          })),
        });
        if (recoveredAfterProxiedReader) return recoveredAfterProxiedReader;
        // The reader was the last free rung, so its outcome is the one the lane
        // ban follows. Its own result is still what the caller receives.
        this.blockHostWhenScoped(params, readerOutcome);
        return reader;
      }
    }

    // One exit for every other path, including a Webshare session that could
    // not be opened. It returned before the rung existed, which left the
    // proxied ladder's own tail unable to escalate at all.
    const recoveredAtProxiedTail = await this.tryCloudRung({
      context: params.context,
      assignmentPath: params.assignmentPath,
      activityId: params.activityId,
      url: params.url,
      attempts,
      policy: params.policy,
      cacheKey: params.cacheKey,
      ...whenDefined(params.signal, (presentSignal) => ({ signal: presentSignal })),
    });
    if (recoveredAtProxiedTail) return recoveredAtProxiedTail;
    // The ban follows the last rung actually attempted, so a browser 404 after
    // a proxied denial no longer removes a host still reachable at other URLs.
    this.blockHostWhenScoped(params, finalOutcome);
    return exit(finalCode, finalMessage);
  }

  /**
   * Whether a managed reader would still run for this call.
   *
   * Asked before offering the paid rung, so cloud stays the last rung rather
   * than one a terminal browser refusal could jump a free rung to reach.
   */
  private async managedReaderAvailable(
    input: ResearchWebToolInput,
    counters: { managedReaders: number },
    budget: AcquisitionBudgets,
  ): Promise<boolean> {
    if (input.allowManagedReaderFallback !== true) return false;
    if (counters.managedReaders >= budget.maximumManagedReaderCalls) return false;
    return Boolean(await this.options.settings.managedReader());
  }

  /** The single lane-ban rule for the enhanced ladder. */
  private blockHostWhenScoped(
    params: { readonly host: string | null; readonly key: string },
    outcome: AcquisitionAttemptOutcome | undefined,
  ): void {
    if (params.host && outcome && outcomeSuppressesHost(outcome)) {
      this.blockHost(params.key, params.host, laneBanCode(outcome));
    }
  }

  private async acquireDocument(params: {
    readonly context: McpBrokerRequestContext & {
      readonly activityScopeId: string;
    };
    readonly assignmentPath: string;
    readonly activityId: string;
    readonly direct: Extract<
      Awaited<ReturnType<DirectHttpAcquirer["acquire"]>>,
      { readonly ok: true; readonly kind: "document" }
    >;
    readonly attempts: AcquisitionAttempt[];
    readonly cacheKey: string;
    readonly signal?: AbortSignal;
  }): Promise<ResearchWebToolOutput> {
    const started = this.now();
    if (!this.documentParser) {
      params.attempts.push({
        method: "document-parser",
        outcome: "unsupported",
        startedAt: started.toISOString(),
        durationMs: 0,
        reason: "The native document parser is unavailable.",
      });
      return failure(
        "acquire",
        "unsupported_content",
        "The source requires a native document parser that is unavailable.",
        false,
        params.attempts,
        params.direct.requestedUrl,
        params.direct.finalUrl,
      );
    }
    try {
      const text = await this.documentParser.parse({
        bytes: params.direct.bytes,
        fileName: params.direct.fileName,
        ...whenDefined(params.signal, (signal) => ({ signal })),
      });
      const quality = evaluateAcquisitionQuality({
        url: params.direct.finalUrl,
        text,
        httpStatus: params.direct.httpStatus,
        mediaType: "text/markdown",
      });
      params.attempts.push({
        method: "document-parser",
        outcome: quality.usable ? "usable" : quality.outcome,
        startedAt: started.toISOString(),
        durationMs: Math.max(0, this.now().getTime() - started.getTime()),
        contentBytes: Buffer.byteLength(text, "utf8"),
        ...(!quality.usable ? { reason: quality.reason } : {}),
      });
      if (!quality.usable) {
        return failure(
          "acquire",
          quality.code,
          quality.reason,
          false,
          params.attempts,
          params.direct.requestedUrl,
          params.direct.finalUrl,
        );
      }
      return this.persistSuccess(
        params.context,
        params.assignmentPath,
        params.activityId,
        "document-parser",
        {
          requestedUrl: params.direct.requestedUrl,
          finalUrl: params.direct.finalUrl,
          canonicalUrl: params.direct.canonicalUrl,
          mediaType: params.direct.mediaType,
          text,
          rawSource: {
            bytes: params.direct.bytes,
            fileExtension: path.extname(params.direct.fileName),
            mediaType: params.direct.mediaType,
          },
          representations: markdownRepresentation(
            text,
            params.direct.mediaType,
          ),
          qualityReport: quality.report,
        },
        params.attempts,
        params.cacheKey,
      );
    } catch (error) {
      const cancelled = params.signal?.aborted === true;
      params.attempts.push({
        method: "document-parser",
        outcome: cancelled ? "cancelled" : "failed",
        startedAt: started.toISOString(),
        durationMs: Math.max(0, this.now().getTime() - started.getTime()),
        reason: error instanceof Error ? error.message : String(error),
      });
      return failure(
        "acquire",
        cancelled ? "cancelled" : "unsupported_content",
        cancelled
          ? "Web acquisition was cancelled."
          : "The native document parser could not produce usable evidence.",
        false,
        params.attempts,
        params.direct.requestedUrl,
        params.direct.finalUrl,
      );
    }
  }

  /**
   * The last rung, and the only paid one.
   *
   * Reached from **four** places, because the ladder has four early exits and
   * three of them return before any tail: the ordinary reader, the proxied
   * reader, a terminal direct refusal with no proxy configured, and a terminal
   * managed-browser refusal. A rung wired only to the tails would be invisible
   * in the no-Webshare configuration, which is the one a blocked source is
   * usually met in.
   *
   * Returns `undefined` when it did not run or produced nothing, and the caller
   * then does exactly what it did before this rung existed.
   */
  private async tryCloudRung(params: {
    readonly context: McpBrokerRequestContext & {
      readonly activityScopeId: string;
    };
    readonly assignmentPath: string;
    readonly activityId: string;
    readonly url: string;
    readonly attempts: AcquisitionAttempt[];
    readonly policy: ReturnType<typeof readAcquisitionAgentPolicy>;
    readonly cacheKey: string;
    readonly signal?: AbortSignal;
  }): Promise<ResearchWebToolOutput | undefined> {
    // Eligibility first, and only then the provider.
    //
    // Resolving it up front meant every ordinary acquisition paid to validate
    // the provider's environment and load a browser driver — and a malformed
    // setting could break a free path that was never going to spend anything.
    //
    // Escalation follows any refusal recorded during this acquisition, not the
    // last outcome. A reader that answers `insufficient` after a browser was
    // refused does not undo the refusal that earned the escalation.
    if (!params.attempts.some((attempt) => outcomeEarnsProxyRetry(attempt.outcome))) {
      return undefined;
    }
    if (params.signal?.aborted) return undefined;

    const budget = await this.options.settings.budgets();
    const counters = this.counters(params.context);
    const key = assignmentKey(params.context);

    // The decision and the call share one chain per lane, so a concurrent
    // acquisition cannot read the same stale total and spend past it.
    const previous = this.cloudSpendChains.get(key) ?? Promise.resolve();
    const chained = previous.then(async () => {
      if (this.outOfCloudBudget(budget, counters)) return undefined;
      // Injected for tests; resolved from settings in production, so turning the
      // provider off or removing its key takes effect without a restart.
      const acquirer =
        this.options.cloudAcquirer ?? (await this.options.settings.cloudBrowser());
      if (!acquirer) return undefined;
      // Incremented before any I/O, so a second caller sees it immediately.
      counters.cloudBrowsers += 1;
      return this.acquireWithCloud({ ...params, counters, acquirer });
    });
    this.cloudSpendChains.set(
      key,
      chained.catch(() => undefined),
    );
    return chained;
  }

  private async acquireWithCloud(params: {
    readonly acquirer: CloudEvidenceAcquirer;
    readonly context: McpBrokerRequestContext & {
      readonly activityScopeId: string;
    };
    readonly assignmentPath: string;
    readonly activityId: string;
    readonly url: string;
    readonly attempts: AcquisitionAttempt[];
    readonly policy: ReturnType<typeof readAcquisitionAgentPolicy>;
    readonly cacheKey: string;
    readonly counters: { cloudCostMicros: number; cloudMeterUnknown: boolean };
    readonly signal?: AbortSignal;
  }): Promise<ResearchWebToolOutput | undefined> {
    const started = this.now();
    const result = await params.acquirer.acquire(
      params.url,
      params.policy,
      params.signal,
    );
    this.recordCloudUsage(params.counters, result);

    const representations = result.evidence
      ? buildSourceRepresentations(
          result.evidence.renderedHtml,
          "text/html",
          result.evidence.finalUrl,
        )
      : undefined;
    const quality = result.evidence && representations
      ? evaluateAcquisitionQuality({
          ...whenDefined(result.evidence.title, (title) => ({ title })),
          url: result.evidence.finalUrl,
          text: representations.markdown || result.evidence.text,
          ...whenDefined(result.evidence.httpStatus, (httpStatus) => ({
            httpStatus,
          })),
          mediaType: "text/html",
          structuredRepresentationCount: representations.structured.filter(
            (representation) => representation.kind !== "metadata",
          ).length,
          clientRenderedShell: representations.clientRenderedShell,
        })
      : undefined;

    params.attempts.push({
      method: "cloud-browser",
      outcome: quality
        ? quality.usable
          ? "usable"
          : quality.outcome
        : result.failure?.code === "cancelled"
          ? "cancelled"
          : "failed",
      startedAt: started.toISOString(),
      durationMs: Math.max(0, this.now().getTime() - started.getTime()),
      ...(result.evidence?.httpStatus !== undefined
        ? { httpStatus: result.evidence.httpStatus }
        : {}),
      ...(result.evidence
        ? { contentBytes: Buffer.byteLength(result.evidence.text, "utf8") }
        : {}),
      ...(quality && !quality.usable ? { reason: quality.reason } : {}),
      ...(!quality && result.failure ? { reason: result.failure.message } : {}),
      ...(quality && !quality.usable
        ? whenDefined(quality.challengeType, (challengeType) => ({
            challengeType,
          }))
        : {}),
      cloudBrowserRuntime: result.runtime,
    });

    if (!result.evidence || !representations || !quality?.usable) return undefined;

    return this.persistSuccess(
      params.context,
      params.assignmentPath,
      params.activityId,
      "cloud-browser",
      {
        requestedUrl: result.evidence.requestedUrl,
        finalUrl: result.evidence.finalUrl,
        canonicalUrl: result.evidence.finalUrl,
        ...whenDefined(result.evidence.title, (title) => ({ title })),
        mediaType: "text/html",
        text: representations.markdown || result.evidence.text,
        rawSource: {
          bytes: Buffer.from(result.evidence.renderedHtml, "utf8"),
          fileExtension: ".html",
          mediaType: "text/html",
          ...(result.evidence.renderedHtmlTruncated ? { truncated: true } : {}),
        },
        representations,
      },
      params.attempts,
      params.cacheKey,
    );
  }

  private recordCloudUsage(
    counters: { cloudCostMicros: number; cloudMeterUnknown: boolean },
    result: CloudAcquisitionResult,
  ): void {
    counters.cloudCostMicros +=
      result.runtime.browserCostMicros + result.runtime.proxyCostMicros;
    if (result.runtime.meterSource !== "stop-confirmed" || !result.cleanup.stopped) {
      counters.cloudMeterUnknown = true;
    }
  }

  private async acquireWithBrowser(params: {
    readonly context: McpBrokerRequestContext & {
      readonly activityScopeId: string;
    };
    readonly assignmentPath: string;
    readonly activityId: string;
    readonly url: string;
    readonly attempts: AcquisitionAttempt[];
    readonly policy: ReturnType<typeof readAcquisitionAgentPolicy>;
    readonly signal?: AbortSignal;
    /** The rung this read is recorded as. Defaults to the ordinary one. */
    readonly method?: Extract<
      AcquisitionMethod,
      "managed-browser" | "managed-browser-proxied"
    >;
    /**
     * Present only on the proxied retry.
     *
     * Parent-process-only: it travels on the scope for this one call and is
     * never stored on the service, so the session that owns it can close it in
     * the caller's `finally`.
     */
    readonly proxy?: BrowserProxyEndpoint;
  }): Promise<BrowserRungResult> {
    const started = this.now();
    const method = params.method ?? "managed-browser";
    try {
      const browserManager = this.options.browserManager;
      if (!browserManager) {
        return {
          terminal: false,
          code: "not_configured",
          message: "Managed browser acquisition is unavailable.",
        };
      }
      const acquired = await browserManager.acquireEvidence(
        {
          ...params.context,
          assignmentPath: params.assignmentPath,
          policy: params.policy,
          ...whenDefined(params.proxy, (proxy) => ({ proxy })),
        },
        params.url,
        params.signal,
      );
      const representations = buildSourceRepresentations(
        acquired.renderedHtml,
        "text/html",
        acquired.finalUrl,
      );
      const quality = evaluateAcquisitionQuality({
        ...whenDefined(acquired.title, (title) => ({ title })),
        url: acquired.finalUrl,
        text: representations.markdown || acquired.text,
        ...whenDefined(acquired.httpStatus, (httpStatus) => ({ httpStatus })),
        mediaType: "text/html",
        structuredRepresentationCount: representations.structured.filter(
          (representation) => representation.kind !== "metadata",
        ).length,
        clientRenderedShell: representations.clientRenderedShell,
      });
      params.attempts.push({
        method,
        outcome: quality.usable ? "usable" : quality.outcome,
        startedAt: started.toISOString(),
        durationMs: Math.max(0, this.now().getTime() - started.getTime()),
        ...(acquired.httpStatus !== undefined
          ? { httpStatus: acquired.httpStatus }
          : {}),
        contentBytes: Buffer.byteLength(acquired.text, "utf8"),
        ...(!quality.usable ? { reason: quality.reason } : {}),
        ...(!quality.usable
          ? whenDefined(quality.challengeType, (challengeType) => ({
              challengeType,
            }))
          : {}),
        ...whenDefined(acquired.browserRuntime, (browserRuntime) => ({
          browserRuntime,
        })),
        ...(params.proxy ? { proxyRuntime: WEBSHARE_PROXY_RUNTIME } : {}),
      });
      if (!quality.usable) {
        return {
          terminal: quality.terminal,
          code: quality.code,
          message: quality.reason,
        };
      }
      const output = await this.persistSuccess(
        params.context,
        params.assignmentPath,
        params.activityId,
        method,
        {
          requestedUrl: acquired.requestedUrl,
          finalUrl: acquired.finalUrl,
          canonicalUrl: acquired.finalUrl,
          ...whenDefined(acquired.title, (title) => ({ title })),
          mediaType: "text/html",
          text: representations.markdown || acquired.text,
          rawSource: {
            bytes: Buffer.from(acquired.renderedHtml, "utf8"),
            fileExtension: ".html",
            mediaType: "text/html",
            ...(acquired.renderedHtmlTruncated ? { truncated: true } : {}),
          },
          representations,
          qualityReport: quality.report,
        },
        params.attempts,
      );
      return { output, terminal: false, code: "internal", message: "" };
    } catch (error) {
      const normalized = normalizeBrowserFailure(error);
      // Chrome reports a proxy transport failure by quoting the endpoint it
      // could not reach, and the attempt trail is agent-readable, so no message
      // produced inside a proxied browser leaves this rung whole. The status
      // and the error class survive, because an operator cannot otherwise tell
      // a proxy that refused the host from a source that refused the read.
      const redacted = params.proxy
        ? redactedBrowserProxyFailure(error, normalized.outcome)
        : { reason: normalized.message };
      params.attempts.push({
        method,
        outcome: normalized.outcome,
        startedAt: started.toISOString(),
        durationMs: Math.max(0, this.now().getTime() - started.getTime()),
        ...whenDefined(redacted.httpStatus, (httpStatus) => ({ httpStatus })),
        reason: redacted.reason,
        ...whenDefined(normalized.challengeType, (challengeType) => ({
          challengeType,
        })),
        ...whenDefined(normalized.browserRuntime, (browserRuntime) => ({
          browserRuntime,
        })),
        ...(params.proxy ? { proxyRuntime: WEBSHARE_PROXY_RUNTIME } : {}),
      });
      return { ...normalized, message: redacted.reason };
    }
  }

  /**
   * The one managed-browser retry a host-scoped denial earns.
   *
   * Returns `undefined` when the retry does not run at all, which leaves the
   * caller's own browser result standing. An absent browser endpoint is such a
   * case: a port that cannot express one is a decision, not a fault, so it is
   * not recorded as an attempt.
   */
  private async retryBrowserThroughProxy(params: {
    readonly context: McpBrokerRequestContext & {
      readonly activityScopeId: string;
    };
    readonly assignmentPath: string;
    readonly activityId: string;
    readonly url: string;
    readonly attempts: AcquisitionAttempt[];
    readonly policy: BrowserAgentPolicy;
    readonly counters: { browsers: number };
    readonly triggered: WebshareTrigger;
    readonly signal?: AbortSignal;
  }): Promise<BrowserRungResult | undefined> {
    const started = this.now();
    if (params.triggered.cancelled) {
      params.attempts.push({
        method: "managed-browser-proxied",
        outcome: "cancelled",
        startedAt: started.toISOString(),
        durationMs: 0,
        reason: CANCELLED_ACQUISITION_MESSAGE,
      });
      return {
        terminal: false,
        code: "cancelled",
        message: CANCELLED_ACQUISITION_MESSAGE,
      };
    }
    const openFailure = params.triggered.openFailure;
    if (openFailure) {
      params.attempts.push({
        method: "managed-browser-proxied",
        outcome: "failed",
        startedAt: started.toISOString(),
        durationMs: 0,
        reason: openFailure,
      });
      return { terminal: false, code: "internal", message: openFailure };
    }
    const endpoint = params.triggered.session?.browserEndpoint;
    if (!endpoint) return undefined;
    // Check-and-increment stays synchronous with the call it pays for.
    params.counters.browsers += 1;
    return this.acquireWithBrowser({
      context: params.context,
      assignmentPath: params.assignmentPath,
      activityId: params.activityId,
      url: params.url,
      attempts: params.attempts,
      policy: params.policy,
      method: "managed-browser-proxied",
      proxy: endpoint,
      ...whenDefined(params.signal, (presentSignal) => ({
        signal: presentSignal,
      })),
    });
  }

  private async acquireWithManagedReader(params: {
    readonly context: McpBrokerRequestContext & {
      readonly activityScopeId: string;
    };
    readonly assignmentPath: string;
    readonly activityId: string;
    readonly url: string;
    readonly attempts: AcquisitionAttempt[];
    readonly provider: ManagedReaderProvider;
    readonly cacheKey: string;
    readonly signal?: AbortSignal;
  }): Promise<ResearchWebToolOutput> {
    const started = this.now();
    try {
      const result = await params.provider.acquire(params.url, params.signal);
      const quality = evaluateAcquisitionQuality({
        ...whenDefined(result.title, (title) => ({ title })),
        url: result.finalUrl,
        text: result.text,
        mediaType: result.mediaType,
      });
      params.attempts.push({
        method: "managed-reader",
        provider: params.provider.id,
        outcome: quality.usable ? "usable" : quality.outcome,
        startedAt: started.toISOString(),
        durationMs: Math.max(0, this.now().getTime() - started.getTime()),
        contentBytes: Buffer.byteLength(result.text, "utf8"),
        ...(!quality.usable ? { reason: quality.reason } : {}),
      });
      if (!quality.usable) {
        return failure(
          "acquire",
          quality.code,
          quality.reason,
          false,
          params.attempts,
          params.url,
          result.finalUrl,
        );
      }
      const output = await this.persistSuccess(
        params.context,
        params.assignmentPath,
        params.activityId,
        "managed-reader",
        {
          requestedUrl: params.url,
          ...result,
          representations: markdownRepresentation(
            result.text,
            result.mediaType,
            {
              ...whenDefined(result.title, (title) => ({ title })),
            },
          ),
          rawOmissionReason:
            "The managed reader returned normalized Markdown without a raw response body.",
          qualityReport: quality.report,
        },
        params.attempts,
        params.cacheKey,
        params.provider.id,
      );
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      params.attempts.push({
        method: "managed-reader",
        provider: params.provider.id,
        outcome: params.signal?.aborted ? "cancelled" : "failed",
        startedAt: started.toISOString(),
        durationMs: Math.max(0, this.now().getTime() - started.getTime()),
        reason: message,
      });
      return failure(
        "acquire",
        params.signal?.aborted ? "cancelled" : "internal",
        params.signal?.aborted
          ? "Web acquisition was cancelled."
          : "The managed reader could not produce usable evidence.",
        !params.signal?.aborted,
        params.attempts,
        params.url,
      );
    }
  }

  private async persistSuccess(
    context: McpBrokerRequestContext & { readonly activityScopeId: string },
    assignmentPath: string,
    activityId: string,
    method:
      | "direct-http"
      | "direct-http-proxied"
      | "managed-browser"
      | "managed-browser-proxied"
      | "managed-reader"
      | "cloud-browser"
      | "document-parser",
    source: {
      readonly requestedUrl: string;
      readonly finalUrl: string;
      readonly canonicalUrl: string;
      readonly title?: string;
      readonly mediaType: string;
      readonly text: string;
      readonly rawSource?: {
        readonly bytes: Uint8Array;
        readonly fileExtension: string;
        readonly mediaType: string;
        readonly truncated?: boolean;
      };
      readonly rawOmissionReason?: string;
      readonly representations?: SourceRepresentationDraft;
      readonly qualityReport?: AcquisitionQualityReport;
    },
    attempts: readonly AcquisitionAttempt[],
    cacheKey?: string,
    provider?: string,
  ): Promise<ResearchWebToolOutput> {
    const persisted = await this.observationStore.persist({
      assignmentPath,
      identity: identityFrom(context),
      activityId,
      method,
      ...(provider ? { provider } : {}),
      requestedUrl: source.requestedUrl,
      finalUrl: source.finalUrl,
      canonicalUrl: source.canonicalUrl,
      ...(source.title ? { title: source.title } : {}),
      mediaType: source.mediaType,
      content: source.text,
      ...whenDefined(source.representations?.structured, (structuredRepresentations) => ({
        structuredRepresentations,
      })),
      ...whenDefined(source.representations?.warnings, (representationWarnings) => ({
        representationWarnings,
      })),
      ...whenDefined(source.qualityReport, (qualityReport) => ({ qualityReport })),
      ...(source.rawSource ? { rawSource: source.rawSource } : {}),
      ...(source.rawOmissionReason
        ? { rawOmissionReason: source.rawOmissionReason }
        : {}),
      attempts,
      observedAt: this.now().toISOString(),
    });
    const output: ResearchWebToolOutput = {
      ok: true,
      action: "acquire",
      requestedUrl: persisted.receipt.requestedUrl,
      finalUrl: persisted.receipt.finalUrl,
      canonicalUrl: persisted.receipt.canonicalUrl,
      ...(persisted.receipt.title ? { title: persisted.receipt.title } : {}),
      mediaType: persisted.receipt.mediaType,
      method,
      ...(provider ? { provider } : {}),
      ...whenDefined(persisted.content.text, (text) => ({ text })),
      content: persisted.content,
      observationReceipt: persisted.view,
      attempts,
    };
    if (cacheKey) this.observationCache.set(cacheKey, output);
    return output;
  }

  private async extract(
    context: McpBrokerRequestContext & { readonly activityScopeId: string },
    assignmentPath: string,
    extractionId: string,
    input: ResearchWebToolInput,
    signal?: AbortSignal,
  ): Promise<SourceExtractionExecution> {
    if (!input.contentId || !input.schema) {
      throw new Error("Extraction requires a content ID and schema.");
    }
    const budget = await this.options.settings.budgets();
    const counters = this.counters(context);
    const modelSelection = await this.options.settings.extractionModel();
    const execution = await this.extractionService.extract({
      assignmentPath,
      identity: identityFrom(context),
      extractionId,
      contentId: input.contentId,
      schema: input.schema,
      ...whenDefined(input.requiredFields, (requiredFields) => ({ requiredFields })),
      ...whenDefined(input.mode, (mode) => ({ mode })),
      ...whenDefined(input.extractionInstructions, (instructions) => ({ instructions })),
      modelSelection,
      allowModel: true,
      claimModelCall: () => {
        if (counters.modelExtractions >= budget.maximumModelExtractions)
          return false;
        counters.modelExtractions += 1;
        return true;
      },
      ...whenDefined(signal, (presentSignal) => ({ signal: presentSignal })),
    });
    return execution;
  }

  private async readContent(
    context: McpBrokerRequestContext & { readonly activityScopeId: string },
    assignmentPath: string,
    input: ResearchWebToolInput,
  ): Promise<ResearchWebToolOutput> {
    if (!input.contentId) {
      return failure(
        input.action,
        "invalid_request",
        "Content ID is required.",
      );
    }
    const content = await this.observationStore.read({
      assignmentPath,
      activityScopeId: context.activityScopeId,
      contentId: input.contentId,
      ...whenDefined(input.chunkIndex, (chunkIndex) => ({ chunkIndex })),
    });
    return content
      ? {
          ok: true,
          action: "read_content",
          content,
          ...whenDefined(content.text, (text) => ({ text })),
        }
      : failure(input.action, "not_found", "Acquired content was not found.");
  }

  private async searchContent(
    context: McpBrokerRequestContext & { readonly activityScopeId: string },
    assignmentPath: string,
    input: ResearchWebToolInput,
  ): Promise<ResearchWebToolOutput> {
    if (!input.contentId || !input.searchText?.trim()) {
      return failure(
        input.action,
        "invalid_request",
        "Content ID and search text are required.",
      );
    }
    const matches = await this.observationStore.search({
      assignmentPath,
      activityScopeId: context.activityScopeId,
      contentId: input.contentId,
      query: input.searchText,
    });
    return matches
      ? { ok: true, action: "search_content", matches }
      : failure(input.action, "not_found", "Acquired content was not found.");
  }

  private counters(scope: {
    readonly sessionId: string;
    readonly runId: string;
    readonly assignmentId: string;
    readonly activityScopeId?: string;
  }): {
    searches: number;
    browsers: number;
    managedReaders: number;
    modelExtractions: number;
    cloudBrowsers: number;
    cloudCostMicros: number;
    cloudMeterUnknown: boolean;
  } {
    const key = assignmentKey(scope);
    const current = this.assignmentCounters.get(key) ?? {
      searches: 0,
      browsers: 0,
      managedReaders: 0,
      modelExtractions: 0,
      cloudBrowsers: 0,
      cloudCostMicros: 0,
      cloudMeterUnknown: false,
    };
    this.assignmentCounters.set(key, current);
    return current;
  }

  private blockHost(
    key: string,
    host: string,
    code: ResearchWebErrorCode,
  ): void {
    const blocked =
      this.terminalHosts.get(key) ?? new Map<string, ResearchWebErrorCode>();
    blocked.set(host, code);
    this.terminalHosts.set(key, blocked);
  }

  /**
   * A place in the session journal for one call, claimed at service entry.
   *
   * `begin` waits only for the previous call's `begin`, never for its whole
   * execution. That is what makes the running rows of parallel calls appear
   * together: a reservation that stayed held until its call finished would
   * publish the second call's running row only after the first call ended,
   * which is the opposite of a live view. Entry order is still the order rows
   * land in, because both `begin` and the reservation are taken at the same
   * synchronous point in `execute`.
   */
  private reserveActivityAppend(
    sessionId: string,
  ): ActivityAppendReservation {
    const previousBegin =
      this.activityBeginQueues.get(sessionId) ?? Promise.resolve();
    let releaseBegin: (() => void) | undefined;
    const begun = new Promise<void>((resolve) => {
      releaseBegin = resolve;
    });
    const tail = previousBegin.catch(() => undefined).then(() => begun);
    this.activityBeginQueues.set(sessionId, tail);
    let released = false;
    const finish = (): void => {
      if (released) return;
      released = true;
      releaseBegin?.();
      if (this.activityBeginQueues.get(sessionId) === tail) {
        this.activityBeginQueues.delete(sessionId);
      }
    };
    return {
      cancel: finish,
      begin: async (activity) => {
        await previousBegin.catch(() => undefined);
        try {
          // The journal is a diagnostic and a UI surface, not the tool's
          // product. A workspace that cannot be written costs the turn its
          // visible activity; it must not also cost the user their research.
          await this.writeActivity(activity).catch(() => undefined);
        } finally {
          finish();
        }
      },
      commit: async (activity) => {
        await begun;
        await this.writeActivity(activity).catch(() => undefined);
      },
    };
  }

  /**
   * Insert or replace one activity, then rewrite the session file.
   *
   * Keyed by `activityId` so a call's terminal record lands on the row its
   * running record already occupies. File writes are serialized per session;
   * the in-memory list is mutated synchronously once hydrated, so a terminal
   * write can never be reordered ahead of the row it is replacing.
   */
  private writeActivity(activity: ResearchWebActivityView): Promise<void> {
    const previous =
      this.activityPersistQueues.get(activity.sessionId) ?? Promise.resolve();
    const write: Promise<void> = previous
      .catch(() => undefined)
      .then(() => this.persistActivity(activity))
      .finally(() => {
        if (this.activityPersistQueues.get(activity.sessionId) === write) {
          this.activityPersistQueues.delete(activity.sessionId);
        }
      });
    this.activityPersistQueues.set(activity.sessionId, write);
    return write;
  }

  private async persistActivity(
    activity: ResearchWebActivityView,
  ): Promise<void> {
    const file = this.activityPath(activity.sessionId);
    if (!file) return;
    const current = [...(await this.listSession(activity.sessionId))];
    const existing = current.findIndex(
      (entry) => entry.activityId === activity.activityId,
    );
    if (existing >= 0) current[existing] = activity;
    else insertInProviderCallOrder(current, activity);
    if (current.length > MAX_ACTIVITY_PER_SESSION) {
      current.splice(0, current.length - MAX_ACTIVITY_PER_SESSION);
    }
    this.activities.set(activity.sessionId, current);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private activityPath(sessionId: string): string | null {
    return resolveRelativePathInside(
      path.resolve(this.options.workspacePath),
      `sessions/${sessionId}/research-acquisition.json`,
    );
  }
}

/**
 * Place one activity in the provider's own tool-call order.
 *
 * Reservation order is service-entry order, which under parallel dispatch is
 * not the model's call order: each call independently crosses authorization,
 * evidence, policy, and budget gates before reaching this service, so a delayed
 * earlier call can arrive after a later one. When the provider exposed an
 * ordinal, insert by it within the same lane; otherwise keep append order.
 */
function insertInProviderCallOrder(
  current: ResearchWebActivityView[],
  activity: ResearchWebActivityView,
): void {
  const ordinal = activity.providerCallOrdinal;
  if (ordinal === undefined) {
    current.push(activity);
    return;
  }
  // Scan right to left past this lane's later calls; stop at the first one
  // that already precedes the new call so unrelated lanes keep their places.
  let insertAt = current.length;
  for (let index = current.length - 1; index >= 0; index -= 1) {
    const candidate = current[index];
    if (!candidate) continue;
    if (
      candidate.activityScopeId !== activity.activityScopeId ||
      candidate.runId !== activity.runId ||
      candidate.assignmentId !== activity.assignmentId
    ) continue;
    if (
      candidate.providerCallOrdinal === undefined ||
      candidate.providerCallOrdinal <= ordinal
    ) break;
    insertAt = index;
  }
  current.splice(insertAt, 0, activity);
}

export function parseResearchWebToolInput(
  value: unknown,
): ResearchWebToolInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Research web input must be an object.");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "action",
    "query",
    "url",
    "contentId",
    "chunkIndex",
    "searchText",
    "schema",
    "requiredFields",
    "mode",
    "extractionInstructions",
    "maximumResults",
    "includeDomains",
    "excludeDomains",
    "publishedAfter",
    "publishedBefore",
    "sourceValue",
    "allowBrowserFallback",
    "allowManagedReaderFallback",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error("Research web input contains an unknown field.");
  }
  if (
    ![
      "search",
      "acquire",
      "extract",
      "read_content",
      "search_content",
    ].includes(String(input.action))
  ) {
    throw new Error("Research web action is invalid.");
  }
  const result = constructResearchWebToolInput(input);
  if (result.action === "search" && !boundedString(result.query, 2_000)) {
    throw new Error("Search query is required.");
  }
  if (result.action === "acquire" && !boundedString(result.url, 8_192)) {
    throw new Error("Source URL is required.");
  }
  if (
    (result.action === "read_content" ||
      result.action === "search_content" ||
      result.action === "extract") &&
    !boundedString(result.contentId, 256)
  ) {
    throw new Error("Content ID is required.");
  }
  if (result.action === "extract") {
    const schema = validateExtractionSchema(result.schema);
    validateRequiredFields(schema.fields, result.requiredFields);
    if (
      result.mode !== undefined &&
      result.mode !== "best-effort" &&
      result.mode !== "strict"
    ) {
      throw new Error("Extraction mode is invalid.");
    }
    if (
      result.extractionInstructions !== undefined &&
      !boundedString(result.extractionInstructions, 4_000)
    ) {
      throw new Error("Extraction instructions are invalid.");
    }
  }
  if (
    result.action === "search_content" &&
    !boundedString(result.searchText, 1_000)
  ) {
    throw new Error("Search text is required.");
  }
  if (
    result.maximumResults !== undefined &&
    (!Number.isSafeInteger(result.maximumResults) ||
      result.maximumResults < 1 ||
      result.maximumResults > 20)
  ) {
    throw new Error("maximumResults must be from 1 through 20.");
  }
  if (
    result.chunkIndex !== undefined &&
    (!Number.isSafeInteger(result.chunkIndex) || result.chunkIndex < 0)
  ) {
    throw new Error("chunkIndex must be a non-negative integer.");
  }
  const normalizedDomainGroups: Array<readonly string[] | undefined> = [];
  for (const domains of [result.includeDomains, result.excludeDomains]) {
    if (
      domains !== undefined &&
      (!Array.isArray(domains) ||
        domains.length > 20 ||
        domains.some(
          (domain) =>
            !boundedString(domain, 253) ||
            normalizeSearchDomain(domain) === null,
        ))
    ) {
      throw new Error("Search domains are invalid.");
    }
    normalizedDomainGroups.push(
      domains
        ? [...new Set(domains.map((domain: string) => {
            const normalized = normalizeSearchDomain(domain);
            if (normalized === null) {
              throw new Error("A search domain that passed validation did not normalize.");
            }
            return normalized;
          }))]
        : undefined,
    );
  }
  for (const field of ["publishedAfter", "publishedBefore"] as const) {
    const value = result[field];
    if (
      value !== undefined &&
      (!boundedString(value, 64) || !Number.isFinite(Date.parse(value)))
    ) {
      throw new Error(`${field} must be a valid date or ISO timestamp.`);
    }
  }
  if (
    result.publishedAfter &&
    result.publishedBefore &&
    Date.parse(result.publishedAfter) > Date.parse(result.publishedBefore)
  ) {
    throw new Error("publishedAfter must not be later than publishedBefore.");
  }
  for (const field of [
    "allowBrowserFallback",
    "allowManagedReaderFallback",
  ] as const) {
    if (result[field] !== undefined && typeof result[field] !== "boolean") {
      throw new Error(`${field} must be a boolean.`);
    }
  }
  if (
    result.sourceValue !== undefined &&
    !["replaceable", "important", "unique-primary"].includes(result.sourceValue)
  ) {
    throw new Error("sourceValue is invalid.");
  }
  return {
    ...result,
    ...(normalizedDomainGroups[0]
      ? { includeDomains: normalizedDomainGroups[0] }
      : {}),
    ...(normalizedDomainGroups[1]
      ? { excludeDomains: normalizedDomainGroups[1] }
      : {}),
  };
}

function constructResearchWebToolInput(
  input: Record<string, unknown>,
): ResearchWebToolInput {
  const action = input.action;
  if (
    action !== "search" &&
    action !== "acquire" &&
    action !== "extract" &&
    action !== "read_content" &&
    action !== "search_content"
  ) {
    throw new Error("Research web action is invalid.");
  }
  const result: {
    action: typeof action;
    query?: string;
    url?: string;
    contentId?: string;
    chunkIndex?: number;
    searchText?: string;
    schema?: Readonly<Record<string, unknown>>;
    requiredFields?: readonly string[];
    mode?: "best-effort" | "strict";
    extractionInstructions?: string;
    maximumResults?: number;
    includeDomains?: readonly string[];
    excludeDomains?: readonly string[];
    publishedAfter?: string;
    publishedBefore?: string;
    sourceValue?: "replaceable" | "important" | "unique-primary";
    allowBrowserFallback?: boolean;
    allowManagedReaderFallback?: boolean;
  } = { action };
  if (input.query !== undefined)
    result.query = inputString(input.query, "query");
  if (input.url !== undefined) result.url = inputString(input.url, "url");
  if (input.contentId !== undefined)
    result.contentId = inputString(input.contentId, "contentId");
  if (input.chunkIndex !== undefined)
    result.chunkIndex = inputNumber(input.chunkIndex, "chunkIndex");
  if (input.searchText !== undefined)
    result.searchText = inputString(input.searchText, "searchText");
  if (input.schema !== undefined)
    result.schema = inputRecord(input.schema, "schema");
  if (input.requiredFields !== undefined)
    result.requiredFields = inputStringArray(
      input.requiredFields,
      "requiredFields",
    );
  if (input.mode !== undefined) result.mode = inputMode(input.mode);
  if (input.extractionInstructions !== undefined)
    result.extractionInstructions = inputString(
      input.extractionInstructions,
      "extractionInstructions",
    );
  if (input.maximumResults !== undefined)
    result.maximumResults = inputNumber(input.maximumResults, "maximumResults");
  if (input.includeDomains !== undefined)
    result.includeDomains = inputStringArray(
      input.includeDomains,
      "includeDomains",
    );
  if (input.excludeDomains !== undefined)
    result.excludeDomains = inputStringArray(
      input.excludeDomains,
      "excludeDomains",
    );
  if (input.publishedAfter !== undefined)
    result.publishedAfter = inputString(input.publishedAfter, "publishedAfter");
  if (input.publishedBefore !== undefined)
    result.publishedBefore = inputString(
      input.publishedBefore,
      "publishedBefore",
    );
  if (input.sourceValue !== undefined)
    result.sourceValue = inputSourceValue(input.sourceValue);
  if (input.allowBrowserFallback !== undefined)
    result.allowBrowserFallback = inputBoolean(
      input.allowBrowserFallback,
      "allowBrowserFallback",
    );
  if (input.allowManagedReaderFallback !== undefined)
    result.allowManagedReaderFallback = inputBoolean(
      input.allowManagedReaderFallback,
      "allowManagedReaderFallback",
    );
  return result;
}

function inputString(value: unknown, key: string): string {
  if (typeof value !== "string")
    throw new Error(`Research web field '${key}' must be a string.`);
  return value;
}

function inputNumber(value: unknown, key: string): number {
  if (typeof value !== "number")
    throw new Error(`Research web field '${key}' must be a number.`);
  return value;
}

function inputBoolean(value: unknown, key: string): boolean {
  if (typeof value !== "boolean")
    throw new Error(`Research web field '${key}' must be a boolean.`);
  return value;
}

function inputRecord(
  value: unknown,
  key: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Research web field '${key}' must be an object.`);
  return { ...value };
}

function inputStringArray(value: unknown, key: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry: unknown): entry is string => typeof entry === "string")
  )
    throw new Error(`Research web field '${key}' must be a string array.`);
  return [...value];
}

function inputMode(value: unknown): "best-effort" | "strict" {
  if (value === "best-effort" || value === "strict") return value;
  throw new Error("Research web field 'mode' is invalid.");
}

function inputSourceValue(
  value: unknown,
): "replaceable" | "important" | "unique-primary" {
  if (
    value === "replaceable" ||
    value === "important" ||
    value === "unique-primary"
  )
    return value;
  throw new Error("Research web field 'sourceValue' is invalid.");
}

function identityFrom(
  context: McpBrokerRequestContext & { readonly activityScopeId: string },
): ObservationIdentity {
  return {
    sessionId: context.sessionId,
    runId: context.runId,
    assignmentId: context.assignmentId,
    activityScopeId: context.activityScopeId,
    agentPath: context.agentPath,
    ...(context.agentDisplayName
      ? { agentDisplayName: context.agentDisplayName }
      : {}),
  };
}

function failure(
  action: ResearchWebAction,
  code: ResearchWebErrorCode,
  message: string,
  retryable = false,
  attempts?: readonly AcquisitionAttempt[],
  requestedUrl?: string,
  finalUrl?: string,
): ResearchWebToolOutput {
  return {
    ok: false,
    action,
    ...(attempts ? { attempts } : {}),
    ...(requestedUrl ? { requestedUrl } : {}),
    ...(finalUrl ? { finalUrl } : {}),
    error: { code, message, retryable },
  };
}

function normalizeFailure(
  action: ResearchWebAction,
  error: unknown,
  signal?: AbortSignal,
): ResearchWebToolOutput {
  if (signal?.aborted) {
    return failure(
      action,
      "cancelled",
      "Research web acquisition was cancelled.",
    );
  }
  const message = error instanceof Error ? error.message : "";
  if (/integrity verification/u.test(message)) {
    return failure(
      action,
      "source_integrity",
      "Stored source artifacts failed integrity verification.",
      false,
    );
  }
  if (/stored source observation was not found/iu.test(message)) {
    return failure(
      action,
      "not_found",
      "Stored source observation was not found.",
    );
  }
  return failure(
    action,
    "internal",
    message || "Research web acquisition failed.",
    true,
  );
}

function normalizeBrowserFailure(error: unknown): {
  readonly terminal: boolean;
  readonly code: ResearchWebErrorCode;
  readonly outcome: AcquisitionAttemptOutcome;
  readonly message: string;
  readonly challengeType?: AcquisitionChallengeType;
  readonly browserRuntime?: AcquisitionBrowserRuntime;
} {
  if (error instanceof BrowserRuntimeError) {
    const mapped: Partial<
      Record<
        typeof error.code,
        {
          code: ResearchWebErrorCode;
          outcome: AcquisitionAttemptOutcome;
          terminal: boolean;
        }
      >
    > = {
      access_challenge: {
        code: "access_challenge",
        outcome: "challenge",
        terminal: true,
      },
      access_denied: {
        code: "access_denied",
        outcome: "access-denied",
        terminal: true,
      },
      rate_limited: {
        code: "rate_limited",
        outcome: "rate-limited",
        terminal: true,
      },
      not_found: { code: "not_found", outcome: "not-found", terminal: true },
      empty_content: {
        code: "empty_content",
        outcome: "insufficient",
        terminal: false,
      },
      domain_denied: {
        code: "domain_denied",
        outcome: "policy-denied",
        terminal: true,
      },
      browser_unavailable: {
        code: "browser_unavailable",
        outcome: "failed",
        terminal: false,
      },
      timeout: { code: "timeout", outcome: "timeout", terminal: false },
      cancelled: { code: "cancelled", outcome: "cancelled", terminal: true },
    };
    const value = mapped[error.code] ?? {
      code: "internal" as const,
      outcome: "failed" as const,
      terminal: false,
    };
    return {
      ...value,
      message: error.message,
      ...whenDefined(error.challengeType, (challengeType) => ({
        challengeType,
      })),
      ...whenDefined(error.browserRuntime, (browserRuntime) => ({
        browserRuntime,
      })),
    };
  }
  return {
    terminal: false,
    code: "internal",
    outcome: "failed",
    message:
      error instanceof Error
        ? error.message
        : "Managed Chrome acquisition failed.",
  };
}

function safeAction(value: unknown): ResearchWebAction {
  return [
    "search",
    "acquire",
    "extract",
    "read_content",
    "search_content",
  ].includes(String(value))
    ? (value as ResearchWebAction)
    : "acquire";
}

function boundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    Boolean(value.trim()) &&
    value.length <= maximum
  );
}

function assignmentKey(scope: {
  readonly sessionId: string;
  readonly runId: string;
  readonly assignmentId: string;
  readonly activityScopeId?: string;
}): string {
  return [
    scope.sessionId,
    scope.runId,
    scope.assignmentId,
    scope.activityScopeId ?? "",
  ].join("\0");
}

function safeHost(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function cacheUrl(value: string): string {
  try {
    return canonicalizeSourceUrl(value);
  } catch {
    return value;
  }
}

/** What either browser rung hands back to the ladder that called it. */
interface BrowserRungResult {
  readonly output?: ResearchWebToolOutput;
  readonly terminal: boolean;
  readonly code: ResearchWebErrorCode;
  readonly message: string;
}

/**
 * Chrome error classes that mean the proxy hop failed, not the source.
 *
 * A residential provider refuses a host at the tunnel, so its refusal and a
 * refusal by the site itself arrive as different Chrome errors. Keeping that
 * apart is the difference between "this proxy will not carry this host" and
 * "this site will not serve us", which call for opposite responses.
 */
const PROXY_HOP_NET_ERRORS: ReadonlySet<string> = new Set([
  "ERR_TUNNEL_CONNECTION_FAILED",
  "ERR_PROXY_CONNECTION_FAILED",
  "ERR_PROXY_AUTH_UNSUPPORTED",
  "ERR_PROXY_CERTIFICATE_INVALID",
  "ERR_UNEXPECTED_PROXY_AUTH",
  "ERR_INVALID_AUTH_CREDENTIALS",
  "ERR_MANDATORY_PROXY_CONFIGURATION_FAILED",
  "ERR_SOCKS_CONNECTION_FAILED",
  "ERR_SOCKS_CONNECTION_HOST_UNREACHABLE",
]);

/**
 * Chrome's own error class, and nothing else, from a browser failure message.
 *
 * The token is a fixed enum drawn from a closed alphabet, so no address and no
 * credential can survive the match. The rest of the message - which quotes the
 * URL Chrome was working on - is discarded.
 */
function chromeNetErrorToken(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return /\bnet::(ERR_[A-Z0-9_]+)/u.exec(message)?.[1];
}

/**
 * Names the failure class of a proxied managed-browser attempt.
 *
 * No message a browser produces on this rung is carried out whole: a Chrome
 * transport error quotes the address it could not reach, and the reason is
 * agent-readable. What is kept is what an operator needs and no credential can
 * hide in - the HTTP status when the source answered one, and Chrome's own
 * error token. Dropping those made a proxy that refuses a host and a source
 * that refuses the read the same line in the journal, which is the one
 * distinction this rung exists to expose.
 */
function redactedBrowserProxyFailure(
  error: unknown,
  outcome: AcquisitionAttemptOutcome,
): { readonly reason: string; readonly httpStatus?: number } {
  if (outcome === "cancelled") return { reason: CANCELLED_ACQUISITION_MESSAGE };
  const netError = chromeNetErrorToken(error);
  if (netError && PROXY_HOP_NET_ERRORS.has(netError)) {
    return {
      reason: `The Webshare proxy refused this read or could not be reached (net::${netError}). The source was never contacted.`,
    };
  }
  const httpStatus =
    error instanceof BrowserRuntimeError ? error.page?.httpStatus : undefined;
  const status = httpStatus === undefined ? "" : ` with HTTP ${httpStatus}`;
  const carried = whenDefined(httpStatus, (value) => ({ httpStatus: value }));
  const trailingClass = netError ? ` (net::${netError})` : "";
  switch (outcome) {
    case "challenge":
      return {
        ...carried,
        reason: `The source presented an anti-bot verification page through the Webshare proxy${status}. Use another source.`,
      };
    case "access-denied":
      return {
        ...carried,
        reason: `The source denied access through the Webshare proxy${status}. Use another source.`,
      };
    case "rate-limited":
      return {
        ...carried,
        reason: `The source rate-limited access through the Webshare proxy${status}. Use another source.`,
      };
    case "not-found":
      return {
        ...carried,
        reason: `The source is missing or returned an error page when read through the Webshare proxy${status}. Use a different page or source.`,
      };
    case "policy-denied":
      return { ...carried, reason: "Acquisition policy refused the proxied managed-browser retry." };
    case "timeout":
      return { ...carried, reason: "The proxied managed-browser retry timed out." };
    case "insufficient":
      return {
        ...carried,
        reason: `The proxied managed-browser retry produced no usable evidence${status}.`,
      };
    default:
      return {
        ...carried,
        reason: `The proxied managed-browser retry failed after reaching the Webshare proxy${trailingClass}.`,
      };
  }
}

/** The three shapes a fired Webshare trigger can carry. */
interface WebshareTrigger {
  readonly session?: AcquisitionProxySession;
  /** Set when the proxy is configured on but could not be opened. */
  readonly openFailure?: string;
  /** Set when the caller aborted while the session was opening. */
  readonly cancelled?: boolean;
}

const CANCELLED_ACQUISITION_MESSAGE = "Web acquisition was cancelled.";

/** True when this failure is the caller withdrawing, not the proxy failing. */
function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Names the failure class without quoting anything that carries a credential.
 *
 * The proxy URL embeds its username and password in userinfo and the attempt
 * trail is agent-readable, so the underlying message is deliberately dropped.
 */
function redactedProxyFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/token/iu.test(message)) {
    return "The Webshare API token was rejected. Check the proxy credentials in settings.";
  }
  if (/required|invalid/iu.test(message)) {
    return "The Webshare proxy configuration is incomplete. Check the proxy settings.";
  }
  return "The Webshare proxy session could not be opened.";
}

/** The attempt record for one direct-transport rung, proxied or not. */
function directAttempt(
  method: Extract<AcquisitionMethod, "direct-http" | "direct-http-proxied">,
  startedAt: Date,
  finishedAt: Date,
  result: Awaited<ReturnType<DirectHttpAcquirer["acquire"]>>,
): AcquisitionAttempt {
  return {
    method,
    ...(method === "direct-http-proxied"
      ? { proxyRuntime: WEBSHARE_PROXY_RUNTIME }
      : {}),
    outcome: result.ok
      ? result.kind === "document"
        ? "insufficient"
        : "usable"
      : result.outcome,
    startedAt: startedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    ...(result.ok
      ? {
          httpStatus: result.httpStatus,
          contentBytes: result.responseBytes,
          ...(result.kind === "document"
            ? { reason: "The response requires native document parsing." }
            : {}),
        }
      : {
          ...(result.httpStatus !== undefined
            ? { httpStatus: result.httpStatus }
            : {}),
          reason: result.message,
          ...whenDefined(result.challengeType, (challengeType) => ({
            challengeType,
          })),
        }),
  };
}

/** A cloud search page is journalled with the same metering shape as a read. */
function cloudSearchAttempt(
  result: CloudAcquisitionResult | undefined,
  startedAt: Date,
  finishedAt: Date,
  outcome: AcquisitionAttemptOutcome,
  reason: string | undefined,
): AcquisitionAttempt | undefined {
  if (!result) return undefined;
  return {
    method: "cloud-browser",
    outcome,
    startedAt: startedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    ...(result.evidence?.httpStatus === undefined
      ? {}
      : { httpStatus: result.evidence.httpStatus }),
    ...(result.evidence
      ? { contentBytes: Buffer.byteLength(result.evidence.text, "utf8") }
      : {}),
    ...(reason ? { reason } : {}),
    cloudBrowserRuntime: result.runtime,
  };
}

/**
 * Why a paid rung could never be created, in the operator's terms.
 *
 * A malformed cloud setting is a fault of the lane's configuration, not of the
 * page it was trying to reach, so it travels beside the caller's real failure
 * instead of replacing it. It is not an acquisition attempt: the fault happens
 * before a session client exists, so there is no cost and no session status to
 * record, and `isAcquisitionAttempt` accepts no `cloud-browser` attempt without
 * that runtime record (domains/acquisition/acquisition-types.ts). Fabricating
 * one would put a session this call never opened into the journal.
 */
function cloudSettingsFaultReason(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The Browser Use provider could not be created.";
}

/** The existing browser-rung gate, named so both ladders read the same. */
function browserFallbackRequested(input: ResearchWebToolInput): boolean {
  return (
    input.allowBrowserFallback === true ||
    (input.allowBrowserFallback !== false &&
      input.sourceValue !== "replaceable")
  );
}

/**
 * Whether a managed-browser result earns one retry from a different egress.
 *
 * Only the three outcomes that mean *this host refused this egress* are worth a
 * different IP. A missing page, a timeout, a transport failure and our own
 * policy denial all say something a residential address cannot change, and a
 * cancelled call is the caller withdrawing.
 *
 * The two gates that need I/O stay at the call site: whether a Webshare session
 * is available, and whether the caller has already aborted.
 */
export function browserProxyRetryApplies(input: {
  readonly outcome: AcquisitionAttemptOutcome | undefined;
  readonly alreadyRetried: boolean;
  readonly browserAttemptsUsed: number;
  readonly maximumBrowserFallbacks: number;
}): boolean {
  if (!input.outcome || !outcomeEarnsProxyRetry(input.outcome)) return false;
  if (input.alreadyRetried) return false;
  return input.browserAttemptsUsed < input.maximumBrowserFallbacks;
}

/**
 * Which outcomes earn one retry from a different egress.
 *
 * All three mean *this host refused this egress*, which a different exit address
 * can change. This is the retry question alone; whether the host is then
 * suppressed for the lane is `outcomeSuppressesHost`, and the two answers
 * deliberately differ for a challenge.
 */
export function outcomeEarnsProxyRetry(
  outcome: AcquisitionAttemptOutcome,
): boolean {
  return (
    outcome === "challenge" ||
    outcome === "access-denied" ||
    outcome === "rate-limited"
  );
}

/**
 * Which outcomes suppress later same-lane calls to the host.
 *
 * A challenge is absent: its page is never citable evidence, but a later
 * explicit call must still reach acquisition rather than being answered from a
 * stored ban. A 403 or a 429 is the source refusing this caller, which repeating
 * the same call cannot change.
 */
export function outcomeSuppressesHost(
  outcome: AcquisitionAttemptOutcome,
): outcome is SuppressingOutcome {
  return outcome === "access-denied" || outcome === "rate-limited";
}

type SuppressingOutcome = Extract<
  AcquisitionAttemptOutcome,
  "access-denied" | "rate-limited"
>;

/** The typed failure a suppressed host reports, named by what caused it. */
function laneBanCode(outcome: SuppressingOutcome): ResearchWebErrorCode {
  return outcome === "rate-limited" ? "rate_limited" : "access_denied";
}

async function canonicalContainedDirectory(
  rootDirectory: string,
  relativeDirectory: string,
): Promise<string | null> {
  try {
    if (path.isAbsolute(relativeDirectory) || relativeDirectory.includes("\0"))
      return null;
    const segments = relativeDirectory.split("/");
    if (segments.some((segment) => !isSafePathSegment(segment))) return null;
    const rootReal = await fs.realpath(rootDirectory);
    let current = rootReal;
    for (const segment of segments) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    }
    return current;
  } catch {
    return null;
  }
}

function isActivity(
  value: unknown,
  sessionId: string,
): value is ResearchWebActivityView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.sessionId === sessionId &&
    typeof record.activityId === "string" &&
    typeof record.runId === "string" &&
    typeof record.assignmentId === "string" &&
    typeof record.activityScopeId === "string" &&
    typeof record.agentPath === "string" &&
    typeof record.toolCallId === "string" &&
    ["search", "acquire", "extract", "read_content", "search_content"].includes(
      String(record.action),
    ) &&
    ["running", "completed", "failed", "cancelled"].includes(
      String(record.state),
    ) &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    Array.isArray(record.attempts)
  );
}

/**
 * The providers a completed search actually returned results from.
 *
 * Derived from the results rather than journalled separately, so the row can
 * name the index the researcher really used without persisting a second copy
 * of the query or the result URLs.
 */
function searchProvidersOf(
  output: ResearchWebToolOutput,
): readonly string[] | undefined {
  if (!output.results) return undefined;
  const providers = new Set<string>();
  for (const result of output.results) {
    if (result.provider) providers.add(result.provider);
  }
  return providers.size > 0 ? [...providers].sort() : undefined;
}

function summarizeExtraction(
  extraction: SourceExtractionView,
): NonNullable<ResearchWebActivityView["extraction"]> {
  const statusCounts: Record<ExtractedFieldStatus, number> = {
    present: 0,
    missing: 0,
    incompatible: 0,
    ambiguous: 0,
    conflicting: 0,
    unsupported: 0,
    invalid_evidence: 0,
  };
  for (const field of extraction.fields) statusCounts[field.status] += 1;
  return {
    extractionId: extraction.extractionId,
    resultRelativePath: extraction.resultRelativePath,
    receiptRelativePath: extraction.receiptRelativePath,
    complete: extraction.complete,
    requirementsMet: extraction.requirementsMet,
    fieldCount: extraction.fields.length,
    statusCounts,
    methodsAttempted: extraction.methodsAttempted,
    warningCount: extraction.warnings.length,
  };
}
