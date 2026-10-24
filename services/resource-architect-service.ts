import { publishResourceMutation } from "../contracts/resource-publication.js";
import type { ModelSelectionRecord } from "../contracts/agent-model-selection.js";
import type { ResourceArchitectComposerSelection } from '../contracts/schemas/resource-architect-composer.js';
import type { ResourceArchitectFeedbackDiagnostics } from '../contracts/schemas/resource-architect-review.js';
import { RESOURCE_ARCHITECT_TURN_TIMEOUT_MS } from '../contracts/resource-architect.js';
import { combineAbortSignals } from '../core/timeout-manager.js';
import { whenDefined } from "../core/optional-properties.js"
import type { ResourceAgentPublisher } from "../contracts/resource-publication.js";
import type {
  ChatTurn,
  ResourceArchitectOperation,
  ResourceArchitectPlan,
  CreateResourceRef,
  ResourceArchitectTranscriptTurn,
  ResourceArchitectTurnDraftOutcome,
  ResourceArchitectTurnOutcome,
  ResourceReferenceDocument,
  ResourceTeamAgentPlan,
  ResourceTeamNewAgentPlan,
  ResourceArchitectTurnHttpResponse,
  ResourceBuildEventType,
  ResourceBuildJobSnapshot,
  ResourcePlanAdmission,
  ResourceBuildItem,
  ResourceBuildItemStatus,
} from "../contracts/resource-architect.js";
import {
  resourceArchitectBuildRequestSchema,
  resourceArchitectTurnRequestSchema,
} from "../contracts/schemas/builder-requests.js";
import { isPublishedResourceBuildItemStatus } from "../contracts/resource-architect.js";
import {
  API_RESTART_INTERRUPTION_MESSAGE,
  newestResourceBuildJob,
} from "../contracts/resource-build-recovery.js";
import { isApplicationShutdownAbort } from "../core/lifecycle.js";
import {
  addTeamBuilderAgent,
  deleteTeamBuilderTeam,
  discardGeneratedTeamShell,
  GeneratedTeamShellRefusal,
  listAgents,
  listTeamBuilderTeams,
  teamPublishedBy,
  isTeamBuilding,
  readGeneratedTeamShell,
  readTeamBuilderTeam,
} from "../domains/agent-generator/index.js";
import {
  buildPlannedAgents,
  type PlannedAgentBuildUpdate,
} from "../domains/agent-generator/planned-agent-builder.js";
import {
  releasePlannedAgentReservation,
  validateExactAgentName,
} from "../domains/agent-generator/agent-name-reservation.js";
import { hasReadyStagedPlannedAgent } from "../domains/agent-generator/planned-agent-persistence.js";
import { runResourceArchitectTurn } from "../domains/resource-architect/resource-architect-llm.js";
import type { SelectedAgentMcpServers } from "../domains/resource-architect/resource-architect-prompt.js";
import type { McpAgentGrantServerView } from "../domains/mcp/mcp-agent-grant-view.js";
import { McpAgentGrantsServiceError } from "./mcp-agent-grants-service.js";
import { McpSettingsServiceError } from "./mcp-settings-service.js";
import {
  materializeResourceUpdatePlan,
  ResourceUpdatePlanError,
  ResourceUpdateTargetConfirmationRequired,
} from "../domains/resource-architect/resource-update-plan.js";
import { resolveProviderMaxConcurrentRequests } from "../domains/provider/provider-concurrency.js";
import { createTeamBuildShell } from "../domains/resource-architect/team-build-shell.js";
import { finishTeamBuilderPublication } from "../domains/agent-generator/team-manager.js";
import { renderResourceArchitectPlannedAgentBrief } from "../domains/resource-architect/planned-agent-brief.js";
import {
  renderUploadedFilesBlock,
  UPLOADED_DOCUMENTS_POLICY,
} from "../domains/resource-architect/resource-architect-prompt.js";
import {
  TeamFileStore,
  TeamFileStoreError,
} from "../domains/team-files/team-file-store.js";
import type { FileParserLauncher } from "../core/file-parser-launcher.js";
import { parseYaml, type YamlObject } from "../core/yaml-parser.js";
import type { PlannedAgentGenerationGate } from "../domains/agent-generator/planned-agent-builder.js";
import {
  reconcileSkillUpdateEvents,
  runResourceUpdateBuild,
  type ResourceUpdatePersistenceObserver,
} from "./resource-update-executor.js";
import { parseServiceRequest, ServiceError } from "./service-errors.js";
import {
  toAuthoredPlannedAgent,
  toAuthoredTeamNewAgentPlan,
  type PersistedResourceArchitectPlan,
} from "../contracts/resource-architect-persisted.js";

export interface ResourceArchitectStorePort {
  savePlan(plan: ResourceArchitectPlan): Promise<void>;
  /**
   * The build this plan is admitted for. Optional on the port so the fakes
   * that only exercise job recovery are not obliged to model admission.
   */
  getPlanAdmission?(planId: string): Promise<ResourcePlanAdmission | null>;
  /** What the store actually holds; see `PersistedResourceArchitectPlan`. */
  getPlan(planId: string): Promise<PersistedResourceArchitectPlan | null>;
  claimPlan(planId: string): () => void;
  saveJob(job: ResourceBuildJobSnapshot): Promise<void>;
  getJob(jobId: string): Promise<ResourceBuildJobSnapshot | null>;
  listJobs(): Promise<ResourceBuildJobSnapshot[]>;
}

export function parseResourceArchitectTurnBody(payload: unknown) {
  return parseServiceRequest(resourceArchitectTurnRequestSchema, payload);
}

export function parseResourceArchitectBuildBody(payload: unknown) {
  return parseServiceRequest(resourceArchitectBuildRequestSchema, payload);
}

export async function runResourceArchitectTurnService(params: {
  documentReviewCacheDir?: string;
  repoRootPath?: string;
  store: ResourceArchitectStorePort;
  operation: ResourceArchitectOperation;
  history: ReturnType<typeof parseResourceArchitectTurnBody>["history"];
  currentPlan: ResourceArchitectPlan | null;
  selectedResource?: CreateResourceRef;
  /** Reads the MCP rows the Tools tab shows for the selected Agent. */
  mcpAgentGrants?: SelectedAgentMcpGrantReader;
  /** Names the connection kind behind a `connection:<id>` provider. */
  resolveConnectionKind?: (provider: string) => string | undefined;
  provider?: string;
  model?: string;
  composerSelection?: ResourceArchitectComposerSelection;
  reviewEnabled?: boolean;
  onReviewDiagnostics?: (review: ResourceArchitectFeedbackDiagnostics) => Promise<void>;
  onUnreviewedDraft?: (review: ResourceArchitectFeedbackDiagnostics) => Promise<void>;
  uploadedDocuments?: ResourceReferenceDocument[];
  uploadedDocumentWarnings?: string[];
  /** The saved conversation with server turn times, as this turn's admission wrote it. */
  admittedHistory?: ResourceArchitectTranscriptTurn[];
  jobId: string;
  signal?: AbortSignal;
  /** Injectable deadline source; the service also bounds direct callers. */
  createTurnTimeoutSignal?: (durationMs: number) => AbortSignal;
  /**
   * Display-only observer for streamed answer suffixes. The response returned
   * below stays the authority; this is a preview of it.
   */
  onTextDelta?: (text: string) => void;
  /** Called once the turn knows its pair, before anything is sent. */
  onSelectionResolved?: (selection: ModelSelectionRecord) => Promise<void>;
}): Promise<ResourceArchitectTurnHttpResponse> {
  const startedAt = performance.now();
  const signal = params.operation === 'conversation'
    ? combineAbortSignals(params.signal, (params.createTurnTimeoutSignal ?? AbortSignal.timeout)(RESOURCE_ARCHITECT_TURN_TIMEOUT_MS))
    : params.signal;
  throwIfResourceArchitectTurnAborted(signal);
  if (!params.repoRootPath) {
    throw new ServiceError(
      "not_configured",
      "Agent Architect requires repoRootPath to be configured",
    );
  }
  // Resolved here, in the service shell, so prompt assembly receives plain
  // grant rows and never the settings service or its connection records.
  const selectedAgentMcpServers = params.selectedResource?.kind === "agent"
    ? await untilAborted(resolveSelectedAgentMcpServers(params.mcpAgentGrants, params.selectedResource.id), signal)
    : undefined;
  throwIfResourceArchitectTurnAborted(signal);
  const result = await runResourceArchitectTurn({
    ...whenDefined(params.documentReviewCacheDir, (documentReviewCacheDir) => ({ documentReviewCacheDir })),
    repoRoot: params.repoRootPath,
    operation: params.operation,
    history: params.history,
    currentPlan: params.currentPlan,
    ...whenDefined(params.selectedResource, (definedValue) => ({ selectedResource: definedValue })),
    ...whenDefined(selectedAgentMcpServers, (definedValue) => ({ selectedAgentMcpServers: definedValue })),
    ...whenDefined(params.resolveConnectionKind, (resolveConnectionKind) => ({ resolveConnectionKind })),
    ...whenDefined(params.provider, (definedValue) => ({ provider: definedValue })),
    ...whenDefined(params.model, (definedValue) => ({ model: definedValue })),
    ...whenDefined(params.composerSelection, (composerSelection) => ({ composerSelection })),
    ...whenDefined(params.reviewEnabled, (reviewEnabled) => ({ reviewEnabled })),
    ...whenDefined(params.onReviewDiagnostics, (onReviewDiagnostics) => ({ onReviewDiagnostics })),
    ...whenDefined(params.uploadedDocuments, (definedValue) => ({ uploadedDocuments: definedValue })),
    ...whenDefined(params.admittedHistory, (definedValue) => ({ admittedHistory: definedValue })),
    ...whenDefined(signal, (definedValue) => ({ signal: definedValue })),
    ...whenDefined(params.onTextDelta, (definedValue) => ({ onTextDelta: definedValue })),
    ...whenDefined(params.onSelectionResolved, (definedValue) => ({ onSelectionResolved: definedValue })),
  });
  throwIfResourceArchitectTurnAborted(signal);
  const warnings = [
    ...(params.uploadedDocumentWarnings ?? []),
    ...result.response.warnings,
  ];
  if (result.review?.reviewStatus === 'not_reviewed') {
    throwIfResourceArchitectTurnAborted(signal);
    if (!params.onUnreviewedDraft) {
      throw new ServiceError('internal', 'The unreviewed draft could not be journaled.');
    }
    await params.onUnreviewedDraft(result.review);
    throwIfResourceArchitectTurnAborted(signal);
    result.timing.totalDurationMs = Math.max(0, performance.now() - startedAt);
    result.timing.firstTextMs = result.timing.totalDurationMs;
    params.onTextDelta?.(result.response.message);
  }
  const meta = {
    provider: result.provider,
    model: result.model,
    // Carried into the operation that owns this turn, so a Create surface can
    // disclose default use from what the turn recorded rather than from
    // Settings as they stand when someone looks.
    ...whenDefined(result.selection, (selection) => ({ selection })),
    fallback: result.fallback,
    ...whenDefined(result.reason, (reason) => ({ reason })),
    reasoning: result.reasoning,
    timing: result.timing,
    ...whenDefined(result.review, (review) => ({ review })),
  };
  if (result.response.operation === "conversation") {
    return { jobId: params.jobId, ...result.response, warnings, meta };
  }

  // The model proposes; the server decides. Materialization enforces target
  // authorization and stamps the revision it calculated itself, so a plan is
  // persisted only once it describes a change this repository can actually make.
  let outcome: ResourceArchitectTurnOutcome;
  try {
    outcome = materializeTurnOutcome(
      params.repoRootPath,
      result.response.outcome,
      params.history,
    );
  } catch (error) {
    if (error instanceof ResourceUpdateTargetConfirmationRequired) {
      return {
        jobId: params.jobId, operation: 'proposal', message: error.question,
        outcome: { kind: 'discussion' }, warnings, meta,
      };
    }
    if (error instanceof ServiceError) {
      throw new ResourceArchitectTurnServiceError(error, {
        jobId: params.jobId,
        operation: "proposal",
        outcomeKind: result.response.outcome.kind,
        meta,
      });
    }
    throw error;
  }
  const response: ResourceArchitectTurnHttpResponse = {
    jobId: params.jobId,
    operation: "proposal",
    message: result.response.message,
    outcome,
    warnings,
    meta,
  };
  if (isResourceArchitectPlan(outcome)) {
    throwIfResourceArchitectTurnAborted(params.signal);
    await params.store.savePlan(outcome);
  }
  return response;
}

/** The one grant-service read the Agent Architect needs for a selected Agent. */
export interface SelectedAgentMcpGrantReader {
  listServers(agentName: string): Promise<readonly McpAgentGrantServerView[]>;
}

async function resolveSelectedAgentMcpServers(
  reader: SelectedAgentMcpGrantReader | undefined,
  agentName: string,
): Promise<SelectedAgentMcpServers> {
  if (!reader) {
    return { status: "unavailable", reason: "MCP grants are not available on this server" };
  }
  try {
    return { status: "available", servers: await reader.listServers(agentName) };
  } catch (error) {
    // Both MCP services report sanitized, user-facing messages. Anything else
    // is withheld rather than risk echoing a connection detail.
    return {
      status: "unavailable",
      reason: error instanceof McpSettingsServiceError || error instanceof McpAgentGrantsServiceError
        ? error.message
        : "MCP grant state could not be read",
    };
  }
}

/**
 * `work`, unless the turn is stopped first.
 *
 * The grant read can wait on provider-support checks that start local CLIs, and
 * none of that takes a signal. Stop ends the turn at once; the read finishes on
 * its own and its answer is dropped.
 */
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** What a rejected proposal still reports to sanitized turn telemetry. */
export interface ResourceArchitectTurnFailureReport {
  jobId: string;
  operation: ResourceArchitectOperation;
  outcomeKind: ResourceArchitectTurnOutcome["kind"] | null;
  meta: ResourceArchitectTurnHttpResponse["meta"];
}

/** Carries sanitized timing through a rejected model outcome without changing the HTTP error. */
export class ResourceArchitectTurnServiceError extends ServiceError {
  constructor(
    error: ServiceError,
    readonly turnResponse: ResourceArchitectTurnFailureReport,
  ) {
    super(error.code, error.message, error.details);
  }
}

function materializeTurnOutcome(
  repoRoot: string,
  outcome: ResourceArchitectTurnDraftOutcome,
  history: ChatTurn[],
): ResourceArchitectTurnOutcome {
  if (outcome.kind === "resource_updates") {
    try {
      return materializeResourceUpdatePlan({ repoRoot, draft: outcome, history });
    } catch (error) {
      // Only a decision this module actually made becomes an answer about the
      // proposal. Anything else is an unexpected fault, and turning it into a
      // `bad_request` would blame the user for their own valid request and
      // lose what really failed.
      if (error instanceof ResourceUpdateTargetConfirmationRequired) throw error;
      if (error instanceof ResourceUpdatePlanError) {
        throw new ServiceError(error.code, error.message);
      }
      throw error;
    }
  }
  validateOutcome(repoRoot, outcome);
  return outcome;
}

function isResourceArchitectPlan(
  outcome: ResourceArchitectTurnOutcome,
): outcome is ResourceArchitectPlan {
  return (
    outcome.kind === "standalone_agents" ||
    outcome.kind === "team" ||
    outcome.kind === "resource_updates"
  );
}

function throwIfResourceArchitectTurnAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function createPlannedBuildItems(
  plan: PersistedResourceArchitectPlan,
): ResourceBuildItem[] {
  if (plan.kind === "standalone_agents") {
    return plan.agents.map((agent, planIndex) => ({
      plannedResource: { kind: "agent", id: agent.name },
      planIndex,
      status: "planned",
    }));
  }
  if (plan.kind === "team") {
    return [{
      plannedResource: { kind: "team", id: plan.team.teamId },
      planIndex: 0,
      status: "planned",
    }];
  }
  return plan.operations.map((operation, planIndex) => ({
    plannedResource: operation.target,
    planIndex,
    status: "planned",
  }));
}

/** A Team build job holds exactly one item, the Team, created with the job. */
function requireTeamBuildItem(job: ResourceBuildJobSnapshot): ResourceBuildItem {
  const item = job.items[0];
  if (!item) {
    throw new Error(`Team build job ${job.jobId} has no Team item`);
  }
  return item;
}

export function createResourceBuildSnapshot(params: {
  plan: ResourceArchitectPlan;
  jobId: string;
  /**
   * The plan revision this build was admitted against.
   *
   * Publication records the admitted plan and revision. Recovery requires that
   * same identity; retries of this lineage share it. Changed plan content
   * cannot satisfy the original admission. Absent only for a job built outside
   * admission, which has no revision to record.
   */
  admittedRevision?: string;
  /** When the build was admitted; the current instant unless a caller says. */
  startedAt?: string;
}): ResourceBuildJobSnapshot {
  const items: ResourceBuildItem[] = createPlannedBuildItems(params.plan);
  return {
    jobId: params.jobId,
    planId: params.plan.id,
    ...whenDefined(params.admittedRevision, (revision) => ({
      admittedRevision: revision,
    })),
    startedAt: params.startedAt ?? new Date().toISOString(),
    status: "running",
    items,
    selectedResource: null,
    events: [{
      id: 1,
      type: "build_started",
      message: `Started resource plan \`${params.plan.id}\`.`,
    }],
  };
}

export async function runResourceBuild(params: {
  resourcePublisher?: ResourceAgentPublisher;
  repoRoot: string;
  plan: PersistedResourceArchitectPlan;
  job: ResourceBuildJobSnapshot;
  store: ResourceArchitectStorePort;
  provider?: string;
  model?: string;
  signal?: AbortSignal;
  draftId?: string;
  teamFileStore?: TeamFileStore;
  fileParserLauncher?: FileParserLauncher;
  uploadedDocuments?: ResourceReferenceDocument[];
  documentReviewCacheDir?: string;
  /** Durable-boundary observer used by update recovery tests. */
  onPersistenceBoundary?: ResourceUpdatePersistenceObserver;
  /** One provider budget shared by every generation in an update job. */
  generationGate?: PlannedAgentGenerationGate;
}): Promise<void> {
  if (params.plan.kind === "team") {
    await runTeamResourceBuild(params as typeof params & {
      plan: Extract<PersistedResourceArchitectPlan, { kind: "team" }>;
    });
    return;
  }
  if (params.plan.kind === "resource_updates") {
    const updatePlan = params.plan;
    await runResourceUpdateBuild({
      ...whenDefined(params.resourcePublisher, (resourcePublisher) => ({ resourcePublisher })),
      repoRoot: params.repoRoot,
      plan: updatePlan,
      job: params.job,
      store: params.store,
      maxConcurrency: resolveAgentBuildConcurrency(
        params.provider,
        updatePlan.operations.length,
      ),
      ...whenDefined(params.provider, (definedValue) => ({ provider: definedValue })),
      ...whenDefined(params.model, (definedValue) => ({ model: definedValue })),
      ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
      ...whenDefined(renderAgentReferenceContext(params.uploadedDocuments), (definedValue) => ({ referenceContext: definedValue })),
      referenceDocuments: (params.uploadedDocuments ?? []).flatMap((document) => document.documentSource ? [document.documentSource] : []),
      ...whenDefined(params.documentReviewCacheDir, (documentReviewCacheDir) => ({ documentReviewCacheDir })),
      ...whenDefined(params.onPersistenceBoundary, (definedValue) => ({ onPersistenceBoundary: definedValue })),
      ...whenDefined(params.generationGate, (definedValue) => ({ generationGate: definedValue })),
    });
    return;
  }

  const standalonePlan = params.plan;
  try {
    const result = await buildPlannedAgents({
      ...whenDefined(params.resourcePublisher, (resourcePublisher) => ({ resourcePublisher })),
      repoRoot: params.repoRoot,
      planId: params.plan.id,
      jobId: params.job.jobId,
      agents: standalonePlan.agents.map(toAuthoredPlannedAgent),
      maxConcurrency: resolveAgentBuildConcurrency(
        params.provider,
        standalonePlan.agents.length,
      ),
      ...whenDefined(params.provider, (definedValue) => ({ provider: definedValue })),
      ...whenDefined(params.model, (definedValue) => ({ model: definedValue })),
      ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
      renderBrief: (agent) =>
        renderResourceArchitectPlannedAgentBrief(undefined, agent),
      ...whenDefined(renderAgentReferenceContext(params.uploadedDocuments), (definedValue) => ({ referenceContext: definedValue })),
      referenceDocuments: (params.uploadedDocuments ?? []).flatMap((document) => document.documentSource ? [document.documentSource] : []),
      ...whenDefined(params.documentReviewCacheDir, (documentReviewCacheDir) => ({ documentReviewCacheDir })),
      allowFallback: true,
      onUpdate: (update) => applyBuildUpdate(params.job, params.store, update),
    });
    params.job.items = result.items;
    const successful = result.items
      .filter((item) => isPublishedResourceBuildItemStatus(item.status))
      .sort((left, right) => left.planIndex - right.planIndex);
    params.job.selectedResource = successful[0]?.resource ?? null;
    if (result.items.every((item) => isPublishedResourceBuildItemStatus(item.status))) {
      params.job.status = "completed";
      pushEvent(params.job, "build_completed", "Finished creating all planned Agents.");
    } else if (successful.length > 0) {
      params.job.status = "partially_completed";
      pushEvent(
        params.job,
        "build_partially_completed",
        "Created part of the planned Agent batch.",
      );
    } else if (params.signal?.aborted || result.items.every((item) => item.status === "cancelled")) {
      params.job.status = "cancelled";
      pushEvent(params.job, "build_cancelled", "Cancelled the planned Agent batch.");
    } else {
      params.job.status = "failed";
      pushEvent(params.job, "build_failed", "No planned Agent was published.");
    }
  } catch (error) {
    params.job.status = params.signal?.aborted ? "cancelled" : "failed";
    params.job.error = error instanceof Error ? error.message : String(error);
    pushEvent(
      params.job,
      params.signal?.aborted ? "build_cancelled" : "build_failed",
      params.job.error,
    );
  }
  await params.store.saveJob(params.job);
}

/**
 * Starts a resource build as background work and terminates its promise.
 *
 * `runResourceBuild` rejects on durable-evidence and persistence faults rather
 * than settling them as operation outcomes. Launched with a bare `void`, such a
 * rejection escapes as an unhandled rejection. The job it failed has already
 * been recorded, so the boundary reports the failure and leaves that record
 * exactly as it stands.
 *
 * `onFailure` is required. It is the only place a background fault can be
 * observed — the response was sent long before — so it must not be optional
 * enough to forget.
 */
export function launchBackgroundResourceBuild(
  params: Parameters<typeof runResourceBuild>[0],
  handlers: {
    onFailure: (error: unknown) => void;
    onSettled?: () => void;
  },
): void {
  void runResourceBuild({ ...params, store: silencedAtShutdown(params.store, params.signal) })
    .catch((error: unknown) => {
      handlers.onFailure(error);
    })
    .finally(() => {
      handlers.onSettled?.();
    })
    // Terminal by construction. Nothing is awaiting this promise, so a
    // reporting boundary that itself fails would otherwise surface as an
    // unhandled rejection and take the process down instead of the build.
    .catch(() => undefined);
}

/**
 * The store a background build records through, silent once the application
 * shuts down under it.
 *
 * Shutdown aborts a build the way Stop does, and the build would save that as
 * a cancellation nobody asked for. Recording nothing more leaves the job as it
 * last stood, still `running`, so the next start's restart reconciliation marks
 * it `interrupted` and Create restores it, exactly as after a crash.
 */
function silencedAtShutdown(
  store: ResourceArchitectStorePort,
  signal: AbortSignal | undefined,
): ResourceArchitectStorePort {
  if (!signal) return store;
  const getPlanAdmission = store.getPlanAdmission?.bind(store);
  return {
    savePlan: (plan) => store.savePlan(plan),
    ...(getPlanAdmission ? { getPlanAdmission } : {}),
    getPlan: (planId) => store.getPlan(planId),
    claimPlan: (planId) => store.claimPlan(planId),
    saveJob: async (job) => {
      if (isApplicationShutdownAbort(signal)) return;
      await store.saveJob(job);
    },
    getJob: (jobId) => store.getJob(jobId),
    listJobs: () => store.listJobs(),
  };
}

/** What discarding a build's team needs from the store. */
export interface ResourceDiscardStorePort extends ResourceArchitectStorePort {
  getPlanAdmission?(planId: string): Promise<ResourcePlanAdmission | null>;
  savePlanAdmission?(admission: ResourcePlanAdmission): Promise<void>;
  withPlanLock?<T>(planId: string, operation: () => Promise<T>): Promise<T>;
}

/**
 * What releasing a stuck admission needs, and nothing more.
 *
 * Kept apart from the build store port because the question it answers is
 * different: not "what did this job do", but "is this plan still held by an
 * attempt that exists".
 */
export interface ResourcePlanAdmissionPort {
  listPlanAdmissions(): Promise<ResourcePlanAdmission[]>;
  getPlanAdmission(planId: string): Promise<ResourcePlanAdmission | null>;
  savePlanAdmission(admission: ResourcePlanAdmission): Promise<void>;
  clearPlanAdmission(planId: string): Promise<void>;
  getJob(jobId: string): Promise<ResourceBuildJobSnapshot | null>;
  isPlanBeingApplied(planId: string): boolean;
  withPlanLock<T>(planId: string, operation: () => Promise<T>): Promise<T>;
}

/**
 * Frees plans whose admitted build never came into existence.
 *
 * A crash between recording an admission and creating its job leaves the plan
 * held for an attempt that is not there, and nothing can build it again: every
 * later submission is refused as competing with a job that has no record.
 *
 * "No job yet" is not by itself evidence of a crash — a live submission has the
 * same shape for a moment. The two are told apart by the plan claim, which is
 * taken inside the same critical section that writes the admission and given
 * back only when the build settles. So it is held for exactly the window in
 * which no job record exists, and a plan that is not claimed has no build
 * starting.
 *
 * Returns the plan ids it released.
 */
export async function releaseDeadPlanAdmissions(
  store: ResourcePlanAdmissionPort,
): Promise<string[]> {
  const released: string[] = [];
  for (const admission of await store.listPlanAdmissions()) {
    // Re-read inside the plan's own critical section. Checked outside it, a
    // submission admitted in between would have its brand new admission
    // cleared out from under it.
    await store.withPlanLock(admission.planId, async () => {
      if (store.isPlanBeingApplied(admission.planId)) return;
      const current = await store.getPlanAdmission(admission.planId);
      if (!current || current.jobId !== admission.jobId) return;
      // The job must be this plan's own. A job id is global, so an admission
      // left by a submission that lost a race points at an id another plan's
      // build owns — and reading any record with that id as proof of life kept
      // the refused plan held forever.
      if (await ownsJob(store, current.planId, current.jobId)) return;

      // The admitted attempt left no record, but an earlier one in this
      // lineage may have. Releasing the plan outright would forget that it has
      // been built against at all — there is a shell on disk — and unfreeze a
      // shape that no longer matches it. So the lineage falls back to its last
      // real attempt, keeping the revision it was admitted at.
      const priorJobIds = [...current.priorJobIds];
      while (priorJobIds.length > 0) {
        const candidate = priorJobIds[priorJobIds.length - 1] ?? "";
        if (await ownsJob(store, current.planId, candidate)) {
          await store.savePlanAdmission({
            planId: current.planId,
            jobId: candidate,
            revision: current.revision,
            priorJobIds: priorJobIds.slice(0, -1),
          });
          return;
        }
        priorJobIds.pop();
      }
      // Nothing in this lineage ever ran. This is the crash between recording
      // the first admission and creating its job, and the plan is free again.
      await store.clearPlanAdmission(current.planId);
      released.push(current.planId);
    });
  }
  return released;
}

/** Whether this plan owns the job record under that id. */
async function ownsJob(
  store: ResourcePlanAdmissionPort,
  planId: string,
  jobId: string,
): Promise<boolean> {
  if (jobId.length === 0) return false;
  const job = await store.getJob(jobId);
  return job !== null && job.planId === planId;
}

/**
 * Throws away the unpublished Team shell a stopped build left behind.
 *
 * The other half of what a restored card offers. A Team shell exists from the
 * first moment of a build and is not a team anybody can use, so a build that
 * stopped leaves one on disk that nothing lists and nothing can run — and every
 * ordinary write to a team marked as being built is refused, precisely so that
 * a half-assembled team cannot be edited into existence. Discard is the one
 * exception, and it is narrow: the shell must be the one this job made, owned
 * by this job's plan, and still unpublished.
 *
 * Returns the updated receipt, so the card stops offering to finish a build
 * whose team is gone.
 */
export async function discardResourceBuildTeam(params: {
  repoRoot: string;
  store: ResourceDiscardStorePort;
  jobId: string;
  isActive: (jobId: string) => boolean;
  resourcePublisher?: ResourceAgentPublisher;
}): Promise<ResourceBuildJobSnapshot> {
  const store = params.store;
  const job = await store.getJob(params.jobId);
  if (!job) {
    throw new ServiceError("not_found", `Resource build job not found: ${params.jobId}`);
  }
  // Everything after this runs in the same critical section admission uses, so
  // a newer submission for this plan cannot land between the checks below and
  // the deletion they authorize. It does *not* exclude publication, which takes
  // the registry writer's lock rather than this one — that is why the removal
  // itself rechecks ownership and unfinished state inside that writer's lock.
  const withPlanLock = store.withPlanLock?.bind(store) ??
    (async <T>(_planId: string, operation: () => Promise<T>): Promise<T> => operation());
  return withPlanLock(job.planId, () => publishResourceMutation(params.resourcePublisher, () => discardUnderPlanLock(params, job)));
}

async function discardUnderPlanLock(
  params: {
    repoRoot: string;
    store: ResourceDiscardStorePort;
    jobId: string;
    isActive: (jobId: string) => boolean;
  },
  job: ResourceBuildJobSnapshot,
): Promise<ResourceBuildJobSnapshot> {
  // A build that is still going owns its shell. Deleting it underneath would
  // take the team away from the writer that is assembling it.
  if (job.status === "running" || params.isActive(job.jobId)) {
    throw new ServiceError(
      "conflict",
      "This build is still running. Stop it before discarding what it made.",
    );
  }
  if (job.discarded) {
    throw new ServiceError(
      "conflict",
      "What this build made has already been discarded.",
    );
  }
  // The lineage's current attempt owns the shell. An older receipt naming the
  // same team must not delete it out from under the attempt the user is
  // actually waiting on.
  const admission = await params.store.getPlanAdmission?.(job.planId);
  if (admission && admission.jobId !== job.jobId) {
    throw new ServiceError(
      "conflict",
      "A newer attempt of this plan owns what was built. Discard that one instead.",
    );
  }
  const teamId = job.items.find(
    (item) => item.resource?.kind === "team",
  )?.resource?.id;
  if (!teamId) {
    throw new ServiceError(
      "not_found",
      "This build did not create a Team, so there is nothing to discard.",
    );
  }
  // Three different states, told apart. A folder that is not there is absent;
  // a file nobody can read proves nothing; and a team that no longer says who
  // built it has no permission attached, which is not the same as being gone.
  const shell = readGeneratedTeamShell(params.repoRoot, teamId);
  if (shell.state === "unreadable") {
    throw new ServiceError(
      "conflict",
      `Team '${teamId}' cannot be read, so it is not safe to remove. Check its configuration.`,
    );
  }
  if (shell.state === "present") {
    // A team this plan did not build is somebody else's, and a published one is
    // a real team with a real delete of its own.
    if (shell.owner !== job.planId) {
      throw new ServiceError(
        "conflict",
        `Team '${teamId}' was not built by this plan.`,
      );
    }
    if (!shell.building) {
      throw new ServiceError(
        "conflict",
        `Team '${teamId}' has been built. Delete it from the team editor instead.`,
      );
    }
  } else {
    // Absent. Only a decision already recorded authorizes finishing: a team
    // that something else removed is not a discard anybody asked for.
    const decided = admission?.discarded === true || job.discarded === true;
    if (!decided) {
      throw new ServiceError(
        "conflict",
        `Team '${teamId}' is not there. Nothing was discarded.`,
      );
    }
    if (job.discarded) return job;
  }

  // The decision is recorded before anything is destroyed. A deletion that
  // succeeded under a decision nobody could write leaves a team that is gone
  // and a plan that still believes it can be retried — which rebuilds exactly
  // what the user removed. Written first, the worst case is a decision with
  // its cleanup unfinished, and asking again finishes it.
  //
  // It is the same record for the whole lineage: one plan has many receipts,
  // and every one of them was otherwise a way back to the shell.
  if (admission && !admission.discarded && params.store.savePlanAdmission) {
    await params.store.savePlanAdmission({ ...admission, discarded: true });
  }

  // The folder and the catalog entry are two removals, and either can be the
  // one still outstanding. A cleanup resumed after the folder was already gone
  // still has an entry to remove, and an entry naming a team that is not there
  // is a catalog that lies.
  if (shell.state === "present" || registryListsTeam(params.repoRoot, teamId)) {
    // Ownership and unfinished state are read again inside the writer's own
    // critical section, immediately before anything is removed. The checks
    // above were made outside it, and a publication landing in between turns
    // the shell into a real team — which this would then have deleted.
    try {
      await discardGeneratedTeamShell({
        repoRoot: params.repoRoot,
        teamId,
        owner: job.planId,
      });
    } catch (error) {
      // The team's own state refused it — most often because a publication
      // landed while this discard was deciding. That is something to tell the
      // user about, not a failure of the request.
      if (error instanceof GeneratedTeamShellRefusal) {
        throw new ServiceError("conflict", error.message);
      }
      throw error;
    }
  }
  // Verified, not assumed. Reporting a removal that did not finish would
  // strand what is left with nothing pointing at it and nothing to ask again.
  const afterwards = readGeneratedTeamShell(params.repoRoot, teamId);
  if (afterwards.state !== "absent" || registryListsTeam(params.repoRoot, teamId)) {
    throw new ServiceError(
      "conflict",
      `Team '${teamId}' could not be removed completely. Check its permissions and try again.`,
    );
  }

  job.items = job.items.map((item) => {
    if (item.resource?.kind !== "team" || item.resource.id !== teamId) return item;
    const { resource: _discarded, ...rest } = item;
    return { ...rest, status: "cancelled" as const };
  });
  job.selectedResource = null;
  job.status = "cancelled";
  job.discarded = true;
  delete job.error;
  pushEvent(
    job,
    "build_cancelled",
    `Discarded the unfinished Team \`${teamId}\`.`,
  );
  await params.store.saveJob(job);
  return job;
}

/** Whether the team catalog still names this team. */
function registryListsTeam(repoRoot: string, teamId: string): boolean {
  try {
    return listTeamBuilderTeams(repoRoot).some((team) => team.id === teamId);
  } catch {
    return false;
  }
}

export async function reconcileInterruptedResourceBuilds(params: {
  repoRoot?: string;
  store: ResourceArchitectStorePort;
  isActive: (jobId: string) => boolean;
}): Promise<ResourceBuildJobSnapshot[]> {
  const jobs = await params.store.listJobs();
  const repoRoot = params.repoRoot;
  const reconciledNow = new Set<string>();
  for (const job of jobs) {
    if (job.status !== "running" || params.isActive(job.jobId)) continue;
    reconciledNow.add(job.jobId);

    const plan = await params.store.getPlan(job.planId);
    const plannedAgents = plan?.kind === "standalone_agents"
      ? plan.agents
      : plan?.kind === "team"
        ? plan.team.newAgents
        : plan?.kind === "resource_updates"
          ? plan.operations.flatMap((operation) =>
              operation.kind === "add_team_agents" ? operation.newAgentsToCreate : [],
            )
          : [];
    if (repoRoot) {
      // An update stages its packages and publishes them only once the target
      // still matches, so a restart can find a finished package waiting. Its
      // name belongs to that package until the same plan publishes it or gives
      // it up; releasing the name here would let another plan claim the exact
      // name the package on disk carries.
      // Decided for every name before anything is released, so a staging root
      // that cannot be read stops the sweep with nothing given away.
      const releasable = plannedAgents.filter((agent) =>
        plan?.kind !== "resource_updates" ||
        !hasReadyStagedPlannedAgent({
          repoRoot,
          orchestratorKey: job.planId,
          requestedName: agent.name,
        }),
      );
      for (const agent of releasable) {
        await releasePlannedAgentReservation({
          repoRoot,
          planId: job.planId,
          jobId: job.jobId,
          name: agent.name,
        }).catch(() => undefined);
      }
    }

    const interruption = API_RESTART_INTERRUPTION_MESSAGE;
    const recoveredTeamId = plan?.kind === "team" && repoRoot
      ? findTeamOwnedByPlan(repoRoot, plan.id)
      : null;
    // Whether the shell this plan owns is the finished team this job published.
    // A shell that exists is not an outcome: it is created before anything is
    // added to it, and a build that stopped leaves one behind every time.
    const publishedThisJob = publishedTeamOwnedByPlan(repoRoot, job);
    job.items = job.items.map((item) => {
      if (
        recoveredTeamId &&
        item.plannedResource.kind === "team" &&
        (item.status === "planned" || item.status === "generating")
      ) {
        // The shell's identity is recorded either way, because retry and
        // discard both need it. Only publication makes it a created team.
        return publishedThisJob
          ? {
            ...item,
            resource: { kind: "team" as const, id: recoveredTeamId },
            status: "created" as const,
          }
          : {
            ...item,
            resource: { kind: "team" as const, id: recoveredTeamId },
            status: "interrupted" as const,
            error: interruption,
          };
      }
      // Interrupted, not failed: nothing about the work went wrong, the API
      // stopped under it, and Create keeps interrupted work recoverable.
      return item.status === "planned" || item.status === "generating"
        ? { ...item, status: "interrupted" as const, error: interruption }
        : item;
    });
    // A skill the receipt proves staged or published is part of what this job
    // did, even when the process exited before the job file heard about it.
    // Recorded before the closing event, as it would have been had the job run on.
    if (repoRoot && plan?.kind === "resource_updates") {
      reconcileSkillUpdateEvents(repoRoot, plan, job);
    }
    const successful = job.items
      .filter((item) => isPublishedResourceBuildItemStatus(item.status))
      .sort((left, right) => left.planIndex - right.planIndex);
    job.selectedResource = successful[0]?.resource ?? null;
    // An update carries one item per operation, so every item published means
    // the whole plan was applied. A Team plan carries one item for the Team
    // while its planned Agents are not items at all, and a standalone plan is
    // not what this rule was written for, so neither is read that way here.
    const itemsCoverTheWholePlan = plan?.kind === "resource_updates";
    if (
      itemsCoverTheWholePlan &&
      job.items.length > 0 &&
      successful.length === job.items.length
    ) {
      // Every item had already reached a published state when the API stopped,
      // so there is nothing left to retry. Recording the interruption anyway
      // would offer the user a retry of work that is finished.
      job.status = "completed";
      delete job.error;
      pushEvent(
        job,
        "build_completed",
        "Every item had finished when the API restarted.",
      );
    } else if (publishedThisJob) {
      // The team this plan owns is published, and publication is the durable
      // fact: it happens only once everything the build was admitted with
      // exists. The job receipt is bookkeeping written after it, so a stop in
      // between leaves a finished team and a job that says otherwise. Offering
      // a retry then fails, because a published team is not the retry's to
      // rewrite — and it would be a retry of work that is already done.
      //
      // Ownership, never a matching name: a team someone else made with the
      // same id says nothing about this plan.
      job.status = "completed";
      delete job.error;
      pushEvent(
        job,
        "build_completed",
        "The Team this build published was already finished when the API restarted.",
      );
    } else {
      job.status = successful.length > 0 ? "partially_completed" : "interrupted";
      job.error = interruption;
      pushEvent(
        job,
        successful.length > 0 ? "build_partially_completed" : "build_interrupted",
        interruption,
      );
    }
    await params.store.saveJob(job);
  }
  // An interruption an earlier release saved never had its receipts read, as
  // that release wrote no skill events. Its rows get the same evidence, and
  // the job is saved with it, so this happens once.
  if (repoRoot) {
    for (const job of jobs) {
      if (reconciledNow.has(job.jobId) || !isUnreadRestartInterruption(job, jobs)) continue;
      const plan = await params.store.getPlan(job.planId);
      if (plan?.kind !== "resource_updates") continue;
      const known = job.events.length;
      reconcileSkillUpdateEvents(repoRoot, plan, job);
      if (job.events.length > known) await params.store.saveJob(job);
    }
  }
  return jobs;
}

/**
 * A restart interruption whose receipts were never read into its events.
 *
 * Only the newest attempt of its plan qualifies. The receipts belong to the
 * plan, so what they prove after a later attempt ran is that attempt's work.
 */
function isUnreadRestartInterruption(
  job: ResourceBuildJobSnapshot,
  jobs: readonly ResourceBuildJobSnapshot[],
): boolean {
  if (job.error !== API_RESTART_INTERRUPTION_MESSAGE) return false;
  if (job.status !== "interrupted" && job.status !== "partially_completed") return false;
  if (job.events.some((event) => event.skill !== undefined)) return false;
  const attempts = jobs.filter((candidate) => candidate.planId === job.planId);
  return newestResourceBuildJob(attempts)?.jobId === job.jobId;
}

/**
 * Whether this plan's own team exists and has been published.
 *
 * Both halves matter. A shell this plan owns but never published is still
 * unfinished, and a published team it does not own is somebody else's.
 */
function publishedTeamOwnedByPlan(
  repoRoot: string | undefined,
  job: ResourceBuildJobSnapshot,
): boolean {
  if (!repoRoot) return false;
  try {
    const owned = findTeamOwnedByPlan(repoRoot, job.planId);
    // Positive evidence only. A team with neither marker was built before this
    // one existed, and saying nothing is not the same as saying finished — the
    // conservative answer for a legacy shell is that the build is unfinished,
    // which offers a retry rather than claiming work nobody can verify.
    const evidence = teamPublishedBy(repoRoot, owned ?? "");
    if (owned === null || evidence === undefined) return false;
    // The admitted plan *and revision* have to match, not merely the plan.
    // Publication records the admitted plan and revision. Recovery requires
    // that same identity; retries of this lineage share it. Changed plan
    // content cannot satisfy the original admission.
    return evidence === publicationEvidenceFor(job);
  } catch {
    return false;
  }
}

/**
 * The evidence a team published for this job's admitted plan and revision
 * carries.
 *
 * A job admitted without a revision is from before admission recorded one. It
 * is matched against the bare plan id, which is what publication wrote then —
 * the deliberate legacy path, and the only case where a plan id alone is
 * accepted as proof.
 */
function publicationEvidenceFor(job: ResourceBuildJobSnapshot): string {
  return job.admittedRevision === undefined
    ? job.planId
    : `${job.planId}@${job.admittedRevision}`;
}

function findTeamOwnedByPlan(repoRoot: string, planId: string): string | null {
  for (const summary of listTeamBuilderTeams(repoRoot)) {
    try {
      const detail = readTeamBuilderTeam(repoRoot, summary.id);
      const parsed = parseYaml(detail.yaml);
      const team = parsed.team as YamlObject | undefined;
      if (team?.created_by_orchestrator === planId) return detail.id;
    } catch {
      // Ignore unrelated malformed Teams; reconciliation only restores exact ownership.
    }
  }
  return null;
}

async function runTeamResourceBuild(params: {
  resourcePublisher?: ResourceAgentPublisher;
  repoRoot: string;
  plan: Extract<PersistedResourceArchitectPlan, { kind: "team" }>;
  job: ResourceBuildJobSnapshot;
  store: ResourceArchitectStorePort;
  provider?: string;
  model?: string;
  signal?: AbortSignal;
  draftId?: string;
  teamFileStore?: TeamFileStore;
  fileParserLauncher?: FileParserLauncher;
  uploadedDocuments?: ResourceReferenceDocument[];
  documentReviewCacheDir?: string;
}): Promise<void> {
  const teamRef = { kind: "team" as const, id: params.plan.team.teamId };
  try {
    const team = await publishResourceMutation(params.resourcePublisher, () => createTeamBuildShell({
      repoRoot: params.repoRoot,
      plan: params.plan.team,
      orchestratorKey: params.plan.id,
      ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
    }));
    let activeTeamId = team.id;
    if (params.draftId) {
      if (!params.teamFileStore) {
        await publishResourceMutation(params.resourcePublisher, () => deleteTeamBuilderTeam(params.repoRoot, team.id)).catch(() => undefined);
        throw new ServiceError(
          "not_configured",
          "Document storage is not configured",
        );
      }
      try {
        const fileParserLauncher = params.fileParserLauncher;
        await params.teamFileStore.transferFiles({
          fromOwnerId: params.draftId,
          toOwnerId: team.id,
          ...whenDefined(fileParserLauncher
            ? (inputsDir: string) => fileParserLauncher.parseDirectory(inputsDir)
            : undefined, (definedValue) => ({ parseDestination: definedValue })),
        });
      } catch (error) {
        await publishResourceMutation(params.resourcePublisher, () => deleteTeamBuilderTeam(params.repoRoot, team.id)).catch(() => undefined);
        if (error instanceof TeamFileStoreError) {
          throw new ServiceError(error.code, error.message);
        }
        throw error;
      }
    }
    params.job.items[0] = {
      ...requireTeamBuildItem(params.job),
      status: "generating",
      resource: { kind: "team", id: activeTeamId },
    };
    pushEvent(
      params.job,
      "team_created",
      `Created Team shell \`${team.id}\`.`,
      params.job.items[0],
    );
    await params.store.saveJob(params.job);

    for (const existing of params.plan.team.existingAgents) {
      activeTeamId = await addAgentToCurrentResourceTeam({
        params,
        activeTeamId,
        agent: existing,
      });
      params.job.events.push({
        id: params.job.events.length + 1,
        type: "agent_reused",
        plannedResource: { kind: "agent", id: existing.name },
        resource: { kind: "agent", id: existing.name },
        message: `Reused Agent \`${existing.name}\`.`,
      });
      params.job.events.push({
        id: params.job.events.length + 1,
        type: "agent_added",
        plannedResource: { kind: "agent", id: existing.name },
        resource: { kind: "agent", id: existing.name },
        message: `Added \`${existing.name}\` to \`${activeTeamId}\`.`,
      });
    }

    const built = params.plan.team.newAgents.length > 0
      ? await buildPlannedAgents({
          ...whenDefined(params.resourcePublisher, (resourcePublisher) => ({ resourcePublisher })),
          repoRoot: params.repoRoot,
          planId: params.plan.id,
          jobId: params.job.jobId,
          agents: params.plan.team.newAgents.map(toAuthoredTeamNewAgentPlan),
          maxConcurrency: resolveAgentBuildConcurrency(
            params.provider,
            params.plan.team.newAgents.length,
          ),
          ...whenDefined(params.provider, (definedValue) => ({ provider: definedValue })),
          ...whenDefined(params.model, (definedValue) => ({ model: definedValue })),
          ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
          renderBrief: (agent) =>
            renderResourceArchitectPlannedAgentBrief(params.plan.team, agent),
          ...whenDefined(renderAgentReferenceContext(params.uploadedDocuments), (definedValue) => ({ referenceContext: definedValue })),
          referenceDocuments: (params.uploadedDocuments ?? []).flatMap((document) => document.documentSource ? [document.documentSource] : []),
          ...whenDefined(params.documentReviewCacheDir, (documentReviewCacheDir) => ({ documentReviewCacheDir })),
          onUpdate: async (update) => {
            params.job.events.push({
              id: params.job.events.length + 1,
              type: update.eventType,
              plannedResource: update.item.plannedResource,
              ...whenDefined(update.item.resource, (definedValue) => ({ resource: definedValue })),
              planIndex: update.item.planIndex,
              message: update.message,
            });
            if (isTerminalAgentUpdate(update)) {
              await params.store.saveJob(params.job);
            }
          },
        })
      : { items: [], staged: [], cleanupIssues: [] };

    for (const [planIndex, planned] of params.plan.team.newAgents.entries()) {
      const result = built.items[planIndex];
      if (!result || !isPublishedResourceBuildItemStatus(result.status)) continue;
      activeTeamId = await addAgentToCurrentResourceTeam({
        params,
        activeTeamId,
        agent: planned,
      });
      params.job.events.push({
        id: params.job.events.length + 1,
        type: "agent_added",
        plannedResource: { kind: "agent", id: planned.name },
        resource: { kind: "agent", id: planned.name },
        planIndex,
        message: `Added \`${planned.name}\` to \`${activeTeamId}\`.`,
      });
    }

    const failures = built.items.filter(
      (item) => !isPublishedResourceBuildItemStatus(item.status),
    );
    // The shell's identity, recorded whatever happens next. Retry and discard
    // both need to know which shell this build made, and a build that stops
    // here still made one.
    params.job.items[0] = {
      ...requireTeamBuildItem(params.job),
      plannedResource: teamRef,
      resource: { kind: "team", id: activeTeamId },
    };
    // Cancellation is checked here, not only before the work started. An abort
    // that arrives during assembly used to be overtaken by this branch, and the
    // build published a team the user had already stopped.
    throwIfResourceBuildAborted(params.signal);
    if (failures.length === 0) {
      // Published only now. Everything the team needs exists, so it can be
      // listed and launched. A build that failed, was cancelled, or finished
      // with incomplete Agents leaves the team unpublished and reachable only
      // by its own builder and by retry.
      await publishResourceMutation(params.resourcePublisher, () => finishTeamBuilderPublication(params.repoRoot, activeTeamId, {
        // What this build was admitted to produce, so a team that merely parses
        // is not mistaken for one that finished.
        expectedRoster: [
          ...params.plan.team.existingAgents.map((agent) => agent.name),
          ...params.plan.team.newAgents.map((agent) => agent.name),
        ],
        ...whenDefined(params.plan.team.shape, (shape) => ({ expectedShape: shape })),
        // Publication records the admitted plan and revision. Recovery requires
        // that same identity; retries of this lineage share it. Changed plan
        // content cannot satisfy the original admission.
        ...whenDefined(params.job.admittedRevision, (revision) => ({
          admittedRevision: revision,
        })),
        ...whenDefined(params.signal, (signal) => ({ signal })),
      }));
      // Reported created only now, and selected only now. Until this line the
      // team is an unpublished shell: it has no roster the user approved, it is
      // hidden from every catalog, and a card that offered to open it would
      // hand back something that fails the moment it runs.
      params.job.items[0] = { ...params.job.items[0], status: "created" };
      params.job.selectedResource = { kind: "team", id: activeTeamId };
      params.job.status = "completed";
      pushEvent(params.job, "build_completed", `Finished building Team \`${activeTeamId}\`.`);
    } else if (
      params.signal?.aborted ||
      failures.every((item) => item.status === "cancelled")
    ) {
      params.job.items[0] = { ...params.job.items[0], status: "cancelled" };
      params.job.status = "cancelled";
      pushEvent(params.job, "build_cancelled", `Cancelled Team \`${activeTeamId}\` build.`);
    } else {
      params.job.items[0] = { ...params.job.items[0], status: "failed" };
      params.job.status = "partially_completed";
      pushEvent(
        params.job,
        "build_partially_completed",
        `Built Team \`${activeTeamId}\` with ${failures.length} incomplete Agent(s).`,
      );
    }
  } catch (error) {
    params.job.status = params.signal?.aborted ? "cancelled" : "failed";
    params.job.error = error instanceof Error ? error.message : String(error);
    // The item settles with the job. Left as it was, the receipt says the Team
    // is still being generated, and a card reading it shows a build in progress
    // that nothing is running. The shell reference stays: retry and discard
    // both need to know which shell this attempt made.
    const unsettled = params.job.items[0];
    if (unsettled && !isTerminalResourceBuildItemStatus(unsettled.status)) {
      params.job.items[0] = {
        ...unsettled,
        status: params.job.status === "cancelled" ? "cancelled" : "failed",
        error: params.job.error,
      };
    }
    // Nothing was published, so nothing is selected.
    params.job.selectedResource = null;
    pushEvent(
      params.job,
      params.signal?.aborted ? "build_cancelled" : "build_failed",
      params.job.error,
    );
  }
  await params.store.saveJob(params.job);
}

/**
 * Whether an item has settled.
 *
 * A settled item is not reopened by the failure handler: an Agent that failed
 * for its own reason keeps that reason rather than inheriting the build's.
 */
function isTerminalResourceBuildItemStatus(
  status: ResourceBuildItemStatus,
): boolean {
  return status !== "planned" && status !== "generating";
}

/** Stops the build if the caller has already cancelled it. */
function throwIfResourceBuildAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

async function addAgentToCurrentResourceTeam(params: {
  params: Parameters<typeof runTeamResourceBuild>[0];
  activeTeamId: string;
  agent: ResourceTeamAgentPlan | ResourceTeamNewAgentPlan;
}): Promise<string> {
  return publishResourceMutation(params.params.resourcePublisher, async () => {
    const teamId = await resolveCurrentResourceTeamId(params.params, params.activeTeamId);
    try {
      await addTeamBuilderAgent({
        repoRoot: params.params.repoRoot,
        teamId,
        agentName: params.agent.name,
        role: params.agent.role,
      });
      return teamId;
    } catch (error) {
      const renamedTeamId = await resolveCurrentResourceTeamId(params.params, teamId);
      if (renamedTeamId === teamId) throw error;
      await addTeamBuilderAgent({
        repoRoot: params.params.repoRoot,
        teamId: renamedTeamId,
        agentName: params.agent.name,
        role: params.agent.role,
      });
      return renamedTeamId;
    }
  });
}

async function resolveCurrentResourceTeamId(
  params: Parameters<typeof runTeamResourceBuild>[0],
  activeTeamId: string,
): Promise<string> {
  const renamedTeamId = findTeamOwnedByPlan(params.repoRoot, params.plan.id);
  if (!renamedTeamId || renamedTeamId === activeTeamId) return activeTeamId;

  const item = requireTeamBuildItem(params.job);
  params.job.items[0] = {
    ...item,
    resource: { kind: "team", id: renamedTeamId },
  };
  if (params.job.selectedResource?.kind === "team") {
    params.job.selectedResource = { kind: "team", id: renamedTeamId };
  }
  pushEvent(
    params.job,
    "team_renamed",
    `Renamed active Team from \`${activeTeamId}\` to \`${renamedTeamId}\`.`,
    params.job.items[0],
  );
  await params.store.saveJob(params.job);
  return renamedTeamId;
}

function renderAgentReferenceContext(
  documents: ResourceReferenceDocument[] | undefined,
): string | undefined {
  if (!documents?.length) return undefined;
  return [
    UPLOADED_DOCUMENTS_POLICY,
    "Use this context to ground the planned Agent, but do not copy the source files into the Agent package.",
    renderUploadedFilesBlock(documents),
  ].join("\n\n");
}

function validateOutcome(
  repoRoot: string,
  outcome: Exclude<ResourceArchitectTurnDraftOutcome, { kind: "resource_updates" }>,
): void {
  if (outcome.kind !== "standalone_agents" && outcome.kind !== "team") return;
  const planned = outcome.kind === "standalone_agents"
    ? outcome.agents
    : outcome.team.newAgents;
  if (planned.length === 0 && outcome.kind === "standalone_agents") {
    throw new ServiceError("bad_request", "Standalone Agent plans must contain at least one Agent");
  }
  const names = new Set<string>();
  const existing = new Set(listAgents(repoRoot).map((agent) => agent.name));
  for (const agent of planned) {
    try {
      validateExactAgentName(agent.name);
    } catch (error) {
      throw new ServiceError(
        "bad_request",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (names.has(agent.name)) {
      throw new ServiceError("bad_request", `Duplicate planned Agent name: ${agent.name}`);
    }
    if (existing.has(agent.name)) {
      throw new ServiceError("conflict", `Agent name already exists: ${agent.name}`);
    }
    names.add(agent.name);
  }
}

async function applyBuildUpdate(
  job: ResourceBuildJobSnapshot,
  store: ResourceArchitectStorePort,
  update: PlannedAgentBuildUpdate,
): Promise<void> {
  job.items[update.item.planIndex] = update.item;
  pushEvent(job, update.eventType, update.message, update.item);
  if (isTerminalAgentUpdate(update)) await store.saveJob(job);
}

function isTerminalAgentUpdate(update: PlannedAgentBuildUpdate): boolean {
  return update.item.status !== "planned" && update.item.status !== "generating";
}

function pushEvent(
  job: ResourceBuildJobSnapshot,
  type: ResourceBuildEventType,
  message: string,
  item?: ResourceBuildItem,
): void {
  job.events.push({
    id: job.events.length + 1,
    type,
    message,
    ...(item
      ? {
          plannedResource: item.plannedResource,
          ...whenDefined(item.resource, (resource) => ({ resource })),
          planIndex: item.planIndex,
        }
      : {}),
  });
}

export function resolveAgentBuildConcurrency(
  provider: string | undefined,
  batchSize: number,
): number {
  const override = process.env.RESOURCE_ARCHITECT_MAX_CONCURRENT_REQUESTS;
  if (override !== undefined) {
    const parsed = Number(override);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new ServiceError(
        "not_configured",
        "RESOURCE_ARCHITECT_MAX_CONCURRENT_REQUESTS must be a positive integer",
      );
    }
    return Math.min(parsed, Math.max(1, batchSize));
  }
  return resolveProviderMaxConcurrentRequests({ ...whenDefined(provider, (definedValue) => ({ provider: definedValue })), batchSize });
}
