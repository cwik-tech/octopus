import { z } from "zod";
import { requestsWholeDocument } from '../../domains/document-access/document-review.js';
import { changePlanWebResearch } from "../../domains/resource-architect/plan-web-research.js";
import type { ModelSelectionRecord } from "../../contracts/agent-model-selection.js";
import { RESOURCE_ARCHITECT_TURN_TIMEOUT_MS } from '../../contracts/resource-architect.js';
import { restorableResourceBuildJob } from "../../contracts/resource-build-recovery.js";
import type { ResourceArchitectConversation } from "../../contracts/schemas/resource-architect-conversation.js";
import { combineAbortSignals } from '../../core/timeout-manager.js';
import { resourceArchitectReviewWarnings, type ResourceArchitectFeedbackDiagnostics } from '../../contracts/schemas/resource-architect-review.js';
import type { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js';
import { resolveResourceArchitectJournalRecorder, resourceArchitectJournalActivityId, type ResourceArchitectJournalRecorder } from '../../services/resource-architect-journal-recorder.js';
import { whenDefined } from "../../core/optional-properties.js"
import { createHash, randomUUID } from "node:crypto";
import type * as http from "node:http";
import { URL } from "node:url";

import {
  createResourceBuildSnapshot,
  parseResourceArchitectBuildBody,
  parseResourceArchitectTurnBody,
  discardResourceBuildTeam,
  reconcileInterruptedResourceBuilds,
  releaseDeadPlanAdmissions,
  launchBackgroundResourceBuild,
  ResourceArchitectTurnServiceError,
  runResourceArchitectTurnService,
  type ResourceArchitectTurnFailureReport,
  type SelectedAgentMcpGrantReader,
} from "../../services/resource-architect-service.js";
import { ServiceError } from "../../services/service-errors.js";
import type { PersistedResourceArchitectPlan } from "../../contracts/resource-architect-persisted.js";
import type {
  CreateJobRegistry,
  CreateJobStartResult,
} from "../create-job-registry.js";
import type { ResourceArchitectStore } from "../resource-architect-store.js";
import { loadResourceArchitectConfig } from "../../domains/resource-architect/resource-architect-prompt.js";
import { readTeamFileContext } from "../../domains/team-files/team-file-context.js";
import type { TeamFileStore } from "../../domains/team-files/team-file-store.js";
import type { FileParserLauncher } from "../../core/file-parser-launcher.js";
import type {
  ResourceArchitectOperation,
  ResourceArchitectTranscriptTurn,
  ResourceArchitectTurnHttpResponse,
  ResourceArchitectTurnMetric,
  ResourceArchitectTurnTiming,
  ResourceArchitectTurnOutcome,
  ResourceBuildJobSnapshot,
  ResourcePlanAdmission,
} from "../../contracts/resource-architect.js";
import { logProcessWarning } from "../../domains/runtime/logger.js";
import { readJsonBody, writeJson, writeServiceError } from "../http.js";
import { canonicalizeJson } from "../../contracts/canonical-json.js";
import {
  teamShapeSchema,
  validateShapeAgainstRoster,
} from "../../contracts/schemas/team-shape.js";
import { handleAgentTextStreamRequest } from "./agent-text-stream-route.js";
import { openTurnTextStream } from "../../domains/runtime/agent-text-stream-turn.js";
import type { AgentTextStreamHub } from "../../domains/runtime/agent-text-stream-hub.js";

/**
 * Every Create-lane channel is owned by this constant rather than by a user
 * resource, because a Create turn belongs to no session. Lanes therefore hold
 * disjoint owner values, so a session's channel id cannot be read through this
 * endpoint and this lane's cannot be read through a session URL.
 */
export const RESOURCE_ARCHITECT_CHANNEL_OWNER = "create:resource-architect";
/** The name a disclosure names, matching what the Create surface calls it. */
const RESOURCE_ARCHITECT_SPEAKER = "Agent Architect";

export interface ResourceArchitectRoutesOptions {
  resourcePublisher?: import('../../contracts/resource-publication.js').ResourceAgentPublisher;
  repoRootPath?: string;
  createJobRegistry: CreateJobRegistry;
  resourceArchitectStore: ResourceArchitectStore;
  reviewEnabled?: boolean;
  /** Injectable deadline source; starts when this route admits the turn. */
  createTurnTimeoutSignal?: (durationMs: number) => AbortSignal;
  conversationJournalRegistry?: WorkspaceConversationJournalRegistry;
  teamFileStore?: TeamFileStore;
  fileParserLauncher?: FileParserLauncher;
  /** The Tools tab's MCP grant rows, for the Agent open in the inspector. */
  mcpAgentGrants?: SelectedAgentMcpGrantReader;
  /** Names the connection kind behind a `connection:<id>` provider. */
  resolveConnectionKind?: (provider: string) => string | undefined;
  agentTextStreamHub?: AgentTextStreamHub;
  agentTextStreamWaitMs?: number;
  agentTextStreamHeartbeatMs?: number;
  isAbortLike(error: unknown): boolean;
}

/**
 * Whether the build a saved conversation owns has ended, and with it the
 * conversation: the newest attempt of its plan is terminal by the shared
 * recovery rule.
 */
async function ownedBuildEnded(
  store: ResourceArchitectStore,
  conversation: ResourceArchitectConversation,
): Promise<boolean> {
  const ownedBuild = conversation.buildJobId ? await store.getJob(conversation.buildJobId) : null;
  const jobs = ownedBuild?.planId === conversation.planId ? await store.listJobs() : [];
  const lineage = jobs.filter((job) => job.planId === conversation.planId);
  return lineage.length > 0 && !restorableResourceBuildJob(lineage);
}

export async function handleResourceArchitectRoutes(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  options: ResourceArchitectRoutesOptions;
}): Promise<boolean> {
  const { req, res, url, options } = params;

  if (url.pathname === "/create/resource-architect/conversation" && (req.method === "GET" || req.method === "DELETE")) {
    const conversation = await options.resourceArchitectStore.conversation.read();
    res.setHeader("cache-control", "no-store");
    if (conversation && req.method === "DELETE") {
      await options.resourceArchitectStore.conversation.clear(conversation.draftId);
      if (options.createJobRegistry.isActive(conversation.turn.jobId)) options.createJobRegistry.cancel(conversation.turn.jobId);
    }
    if (!conversation || req.method === "DELETE") {
      writeJson(res, 200, null);
      return true;
    }
    // The same rule the Create hook restores by: only unfinished work keeps its
    // conversation. A terminal build retires it, and its receipt stays on disk.
    if (await ownedBuildEnded(options.resourceArchitectStore, conversation)) {
      await options.resourceArchitectStore.conversation.clear(conversation.draftId);
      writeJson(res, 200, null);
      return true;
    }
    const interrupted = conversation.turn.status === "running" && !options.createJobRegistry.isActive(conversation.turn.jobId);
    writeJson(res, 200, interrupted
      ? { ...conversation, turn: { ...conversation.turn, status: "interrupted" } }
      : conversation);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/create/resource-architect/metrics") {
    const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
    const metrics = await options.resourceArchitectStore.listTurnMetrics(requestedLimit);
    res.setHeader("cache-control", "no-store");
    writeJson(res, 200, { metrics });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/create/resource-architect/turn") {
    return handleAgentTextStreamRequest({
      hub: options.agentTextStreamHub,
      req,
      res,
      url,
      ownerId: RESOURCE_ARCHITECT_CHANNEL_OWNER,
      ...whenDefined(options.agentTextStreamWaitMs, (waitMs) => ({ waitMs })),
      ...whenDefined(options.agentTextStreamHeartbeatMs, (heartbeatMs) => ({
        heartbeatMs,
      })),
    });
  }

  if (req.method === "POST" && url.pathname === "/create/resource-architect/turn") {
    const body = parseResourceArchitectTurnBody(await readJsonBody(req));
    const jobId = body.jobId ?? randomUUID();
    const turnStartedAt = performance.now();
    const start = options.createJobRegistry.start(jobId);
    if (start.status === "pending_cancelled") {
      await saveTurnMetric(options.resourceArchitectStore, {
        body,
        jobId,
        status: "cancelled",
        timing: emptyTurnTiming(turnStartedAt),
      });
      writeJson(res, 200, { jobId, operation: body.operation, cancelled: true });
      return true;
    }
    if (start.status === "conflict") {
      // No turn record at all. A refused request never owned a model
      // invocation, so it has nothing to disclose, and writing one under the
      // running job's id takes that turn's live disclosure away. Deriving an id
      // instead is no safer: job ids are free-form strings, so a synthesized
      // one lands in the same namespace real jobs use and could overwrite an
      // unrelated turn's record. The 409 is the report.
      writeJson(res, 409, { error: `Create job '${jobId}' is already running` });
      return true;
    }
    // The admitted Create job survives renderer reloads. Its deadline and
    // explicit Stop own cancellation; the lifetime of this HTTP reply does not.
    const publicationSignal = body.operation === 'conversation'
      ? (options.createTurnTimeoutSignal ?? AbortSignal.timeout)(RESOURCE_ARCHITECT_TURN_TIMEOUT_MS)
      : undefined;
    const signal = combineAbortSignals(start.job.controller.signal, publicationSignal);
    // Only a conversational turn produces prose. A proposal turn answers with
    // a JSON envelope that renders as a card, so streaming its body would put
    // raw JSON on screen.
    const textStream = openTurnTextStream({
      ...whenDefined(options.agentTextStreamHub, (hub) => ({ hub })),
      channelId: jobId,
      ownerId: RESOURCE_ARCHITECT_CHANNEL_OWNER,
      streaming: body.operation === "conversation",
    });
    let result: ResourceArchitectTurnHttpResponse | undefined;
    // A rejected proposal still reports its provider, model, and timing, but it
    // has no answer body to return.
    let failureReport: ResourceArchitectTurnFailureReport | undefined;
    // One turn, one terminal record. Tracked here rather than asked of the
    // registry, because the two answer different questions: a proposal turn
    // whose plan is persisted reports completed over a cancellation recorded
    // before it asked to settle, so it holds no completion claim and has still
    // written its outcome.
    let terminalRecordStored = false;
    let authorSelection: ModelSelectionRecord | undefined;
    let firstVisibleTextMs: number | null = null;
    const saveAdmittedTurnMetric = async (metric: Parameters<typeof saveTurnMetric>[1]): Promise<void> => {
      await saveTurnMetric(options.resourceArchitectStore, {
        ...metric,
        ...whenDefined(authorSelection, (selection) => ({ selection })),
      });
    };
    let reviewJournal: ResourceArchitectJournalRecorder | undefined;
    let conversationStarted = false;
    // The saved conversation as admission wrote it, with server turn times.
    // Provider messages are built from it, so an uploaded file is placed by
    // server time and never by anything the client sent.
    let admittedHistory: ResourceArchitectTranscriptTurn[] | undefined;
    let journalOutcome: 'completed' | 'failed' | 'cancelled' = 'failed';
    let journalTerminalStored = false;
    let recordedJournalOutcome: 'completed' | 'failed' | 'cancelled' | undefined;
    const recordReviewTerminal = async (outcome: 'completed' | 'failed' | 'cancelled'): Promise<void> => {
      await reviewJournal?.recordTerminal(outcome);
      journalTerminalStored = true;
      recordedJournalOutcome = outcome;
    };
    try {
      if (body.draftId) {
        // A message after the conversation's build ended is new work in the
        // same conversation, not part of that build. The ended build is let go
        // of in the same save as the message, so the conversation route keeps
        // what the user just said instead of retiring it with the build, and a
        // failed save leaves both untouched. The receipt stays on disk.
        const current = await options.resourceArchitectStore.conversation.read();
        const releaseEndedBuildJobId = current?.draftId === body.draftId && current.buildJobId &&
          await ownedBuildEnded(options.resourceArchitectStore, current)
          ? current.buildJobId
          : undefined;
        admittedHistory = (await options.resourceArchitectStore.conversation.start({
          draftId: body.draftId, jobId, operation: body.operation, history: body.history,
          ...whenDefined(releaseEndedBuildJobId, (definedValue) => ({ releaseEndedBuildJobId: definedValue })),
          planId: body.currentPlan?.id ?? null,
          selectedResource: body.selectedResource ?? null,
          documentReader: body.documentReader ?? null,
          updatedAt: new Date().toISOString(),
        })).history;
        conversationStarted = true;
      }
      signal.throwIfAborted();
      const uploadedContext = options.teamFileStore
        ? await readTeamFileContext(options.teamFileStore, body.draftId, {
            requirePageIndex: requestsWholeDocument(body.history.filter((turn) => turn.role === 'user').at(-1)?.text ?? ''),
            ...whenDefined(options.fileParserLauncher, (parserLauncher) => ({ parserLauncher })),
            ...whenDefined(body.documentReader, (definedValue) => ({ documentReader: definedValue })),
            signal,
          })
        : { documents: [], warnings: [] };
      signal.throwIfAborted();
      result = await runResourceArchitectTurnService({
        ...whenDefined(options.repoRootPath, (definedValue) => ({ repoRootPath: definedValue })),
        store: options.resourceArchitectStore,
        operation: body.operation,
        history: body.history,
        currentPlan: body.currentPlan,
        ...whenDefined(body.selectedResource, (definedValue) => ({ selectedResource: definedValue })),
        ...whenDefined(options.mcpAgentGrants, (mcpAgentGrants) => ({ mcpAgentGrants })),
        ...whenDefined(options.resolveConnectionKind, (resolveConnectionKind) => ({ resolveConnectionKind })),
        ...whenDefined(body.provider, (definedValue) => ({ provider: definedValue })),
        ...whenDefined(body.model, (definedValue) => ({ model: definedValue })),
        ...whenDefined(body.composerSelection, (composerSelection) => ({ composerSelection })),
        ...whenDefined(options.reviewEnabled, (reviewEnabled) => ({ reviewEnabled })),
        uploadedDocuments: uploadedContext.documents,
        ...whenDefined(uploadedContext.reviewCacheDir, (documentReviewCacheDir) => ({ documentReviewCacheDir })),
        uploadedDocumentWarnings: uploadedContext.warnings,
        ...whenDefined(admittedHistory, (definedValue) => ({ admittedHistory: definedValue })),
        jobId,
        signal,
        onReviewDiagnostics: async (review) => {
          await saveAdmittedTurnMetric({
            body, jobId, status: 'running', review,
            timing: emptyTurnTiming(turnStartedAt),
          });
        },
        onUnreviewedDraft: async (review) => {
          signal.throwIfAborted();
          const registry = options.conversationJournalRegistry;
          if (!registry) throw new ServiceError('internal', 'The unreviewed draft could not be journaled.');
          reviewJournal = await resolveResourceArchitectJournalRecorder({
            registry, jobId,
            conversationId: body.draftId ?? `job-${resourceArchitectJournalActivityId(jobId)}`,
          });
          signal.throwIfAborted();
          await reviewJournal.recordFallback(review);
          signal.throwIfAborted();
        },
        onTextDelta: (text) => {
          signal.throwIfAborted();
          if (!text) return;
          firstVisibleTextMs ??= Math.max(0, performance.now() - turnStartedAt);
          textStream.onTextDelta?.(text);
        },
        // Persisted while the provider is still working, so the disclosure
        // exists during the wait and survives a crash before the reply. The
        // terminal record replaces this one under the same job id.
        onSelectionResolved: async (selection) => {
          authorSelection = selection;
          signal.throwIfAborted();
          await saveAdmittedTurnMetric({
            body,
            jobId,
            status: "running",
            selection,
            timing: emptyTurnTiming(turnStartedAt),
          });
          signal.throwIfAborted();
          // Durable first, shown second. The record is the authority and the
          // frame is a preview, so a frame nobody receives costs the live
          // notice and nothing else — but a notice shown before the record
          // exists would be a claim with nothing behind it.
          textStream.publishSelection(RESOURCE_ARCHITECT_SPEAKER, selection);
        },
      });
      if (body.operation === 'conversation') {
        signal.throwIfAborted();
        result.meta.timing.firstTextMs = firstVisibleTextMs;
        result.meta.timing.totalDurationMs = Math.max(0, performance.now() - turnStartedAt);
      }
      // Asked for in one step rather than read and then acted on: a claim is
      // granted only while nothing has cancelled the job, and from that moment
      // a cancellation no longer changes what this turn reports. A bare read
      // could not promise that, because one landing just after it used to leave
      // Stop and this reply telling different stories.
      //
      // Closed after that decision, not before it. A `completed` published
      // first cannot be taken back — the bubble closes once — so a turn the
      // user stopped would be shown as a finished answer.
      const claim = options.createJobRegistry.claimCompletion(jobId);
      if (shouldReturnCancelledResourceArchitectTurn({
        cancelled: claim === "cancelled",
        result,
      })) {
        textStream.close("error");
        await saveAdmittedTurnMetric({
          body,
          jobId,
          status: "cancelled",
          result: toTurnMetricView(result),
        });
        terminalRecordStored = true;
        await recordReviewTerminal('cancelled');
        writeJson(res, 200, { jobId, operation: body.operation, cancelled: true });
        journalOutcome = 'cancelled';
      } else {
        // The granted claim wins a later Stop. The turn deadline still
        // prevents publishing an answer after its allowed execution time.
        publicationSignal?.throwIfAborted();
        await saveAdmittedTurnMetric({
          body,
          jobId,
          status: "completed",
          result: toTurnMetricView(result),
        });
        terminalRecordStored = true;
        publicationSignal?.throwIfAborted();
        // Serialization must succeed before the journal claims completion.
        JSON.stringify(result);
        await recordReviewTerminal('completed');
        publicationSignal?.throwIfAborted();
        if (body.draftId) {
          const warnings = [...new Set([...result.warnings, ...(result.meta.review ? resourceArchitectReviewWarnings(result.meta.review) : [])])];
          const text = warnings.length === 0 ? result.message
            : `${result.message}\n\nContext notes:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
          const outcome = result.operation === "proposal" ? result.outcome : null;
          await options.resourceArchitectStore.conversation.settle({
            draftId: body.draftId, jobId, status: "completed", updatedAt: new Date().toISOString(),
            assistant: { role: "assistant", text, createdAt: new Date().toISOString() },
            ...(outcome && "id" in outcome ? { planId: outcome.id } : {}),
          });
        }
        writeJson(res, 200, result);
        // Confirm only after all awaited acceptance work and synchronous
        // publication succeed. This remains a no-op for an unclaimed proposal.
        options.createJobRegistry.confirmCompletion(jobId);
        journalOutcome = 'completed';
        // Last, deliberately. Everything above it can throw — recording the
        // turn, serializing the answer, writing it to a socket that may have
        // gone away — and the bubble closes once, so a `completed` published
        // before any of them could not be withdrawn. A failure lands in the
        // `finally` below, which closes the bubble as an error instead.
        // The final stream event follows the journal terminal in finally.
      }
    } catch (error) {
      // The bubble must never be left open on a failure: a reader waiting on
      // this channel would otherwise sit on a reply that is never coming.
      textStream.close("error");
      if (reviewJournal && recordedJournalOutcome === 'completed') {
        await reviewJournal.recordPublicationFailed();
      }
      // An unconfirmed claim goes back, so the cancellation read below sees the
      // truth rather than a reservation that came to nothing.
      options.createJobRegistry.releaseCompletion(jobId);
      if (error instanceof ResourceArchitectTurnServiceError) {
        failureReport = error.turnResponse;
      }
      if (terminalRecordStored) {
        // The completed write is a server result, not proof of delivery.
        // Correct it in place: a second ordinary save would append a new turn.
        journalOutcome = options.isAbortLike(error) ? 'cancelled' : 'failed';
        await options.resourceArchitectStore.recordTurnPublicationFailure(
          jobId, journalOutcome, Math.max(0, performance.now() - turnStartedAt),
        );
        throw error;
      }
      if (
        options.createJobRegistry.isCancelled(start.job) ||
        options.isAbortLike(error)
      ) {
        journalOutcome = 'cancelled';
        await saveAdmittedTurnMetric({
          body,
          jobId,
          status: "cancelled",
          ...whenDefined(turnMetricView(result, failureReport), (definedValue) => ({ result: definedValue })),
          ...whenDefined(
            turnMetricView(result, failureReport) ? undefined : emptyTurnTiming(turnStartedAt),
            (definedValue) => ({ timing: definedValue }),
          ),
        });
        await recordReviewTerminal('cancelled');
        writeJson(res, 200, { jobId, operation: body.operation, cancelled: true });
      } else if (error instanceof ServiceError) {
        await saveAdmittedTurnMetric({
          body,
          jobId,
          status: "failed",
          errorCode: error.code,
          ...whenDefined(turnMetricView(result, failureReport), (definedValue) => ({ result: definedValue })),
          ...whenDefined(
            turnMetricView(result, failureReport) ? undefined : emptyTurnTiming(turnStartedAt),
            (definedValue) => ({ timing: definedValue }),
          ),
        });
        writeServiceError(res, error);
      } else {
        await saveAdmittedTurnMetric({
          body,
          jobId,
          status: "failed",
          errorCode: "internal",
          ...whenDefined(turnMetricView(result, failureReport), (definedValue) => ({ result: definedValue })),
          ...whenDefined(
            turnMetricView(result, failureReport) ? undefined : emptyTurnTiming(turnStartedAt),
            (definedValue) => ({ timing: definedValue }),
          ),
        });
        throw error;
      }
    } finally {
      try {
        if (conversationStarted && body.draftId && journalOutcome !== "completed") {
          await options.resourceArchitectStore.conversation.settle({
            draftId: body.draftId, jobId, status: journalOutcome, updatedAt: new Date().toISOString(),
          });
        }
        if (!journalTerminalStored) await recordReviewTerminal(journalOutcome);
        textStream.close(journalOutcome === 'completed' ? 'completed' : 'error');
      } finally {
        textStream.close('error');
        try {
          await reviewJournal?.release();
        } finally {
          options.createJobRegistry.finish(jobId);
        }
      }
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/create/resource-architect/jobs") {
    // Before the jobs are read, not after. An admission left by a run that
    // crashed before creating its job holds its plan against every later
    // submission, and nothing else ever clears it.
    await releaseDeadPlanAdmissions(options.resourceArchitectStore);
    const jobs = await reconcileInterruptedResourceBuilds({
      ...whenDefined(options.repoRootPath, (definedValue) => ({ repoRoot: definedValue })),
      store: options.resourceArchitectStore,
      isActive: (jobId) => options.createJobRegistry.isActive(jobId),
    });
    writeJson(res, 200, { jobs });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/create/resource-architect/jobs") {
    const body = parseResourceArchitectBuildBody(await readJsonBody(req));
    const uploadedContext = options.teamFileStore
      ? await readTeamFileContext(options.teamFileStore, body.draftId)
      : { documents: [], warnings: [] };
    await startBuildAnswering({
      res,
      options,
      planId: body.planId,
      ...whenDefined(body.expectedRevision, (definedValue) => ({ expectedRevision: definedValue })),
      ...whenDefined(body.jobId, (definedValue) => ({ requestedJobId: definedValue })),
      ...whenDefined(body.provider, (definedValue) => ({ provider: definedValue })),
      ...whenDefined(body.model, (definedValue) => ({ model: definedValue })),
      ...whenDefined(body.draftId, (definedValue) => ({ draftId: definedValue })),
      uploadedDocuments: uploadedContext.documents,
      ...whenDefined(uploadedContext.reviewCacheDir, (documentReviewCacheDir) => ({ documentReviewCacheDir })),
    });
    return true;
  }

  const webResearchMatch = url.pathname.match(
    /^\/create\/resource-architect\/plans\/([^/]+)\/web-research$/,
  );
  if (webResearchMatch && req.method === "POST") {
    await handlePlanWebResearch({ req, res, store: options.resourceArchitectStore,
      planId: decodeURIComponent(webResearchMatch[1] ?? ""),
    });
    return true;
  }

  const shapeMatch = url.pathname.match(
    /^\/create\/resource-architect\/plans\/([^/]+)\/shape$/,
  );
  if (shapeMatch && (req.method === "GET" || req.method === "POST")) {
    await handlePlanShape({
      req,
      res,
      store: options.resourceArchitectStore,
      planId: decodeURIComponent(shapeMatch[1] ?? ""),
    });
    return true;
  }

  const retryMatch = url.pathname.match(
    /^\/create\/resource-architect\/jobs\/([^/]+)\/retry$/,
  );
  if (req.method === "POST" && retryMatch) {
    const priorJobId = decodeURIComponent(retryMatch[1] ?? "");
    const prior = await options.resourceArchitectStore.getJob(priorJobId);
    if (!prior) {
      writeJson(res, 404, { error: `Resource build job not found: ${priorJobId}` });
      return true;
    }
    // What this attempt made was thrown away on purpose. Retrying it would
    // rebuild the shell the user removed.
    if (prior.discarded) {
      writeJson(res, 409, {
        error: "build_discarded",
        reason:
          "What this build made was discarded. Start a new plan to build it again.",
      });
      return true;
    }
    const payload = await readJsonBody(req);
    const body = parseResourceArchitectBuildBody({
      ...(payload && typeof payload === "object" ? payload : {}),
      planId: prior.planId,
    });
    const uploadedContext = options.teamFileStore
      ? await readTeamFileContext(options.teamFileStore, body.draftId)
      : { documents: [], warnings: [] };
    // The same admission, answered the same way. Retry reaches the identical
    // refusals — a plan someone amended, a stored shape that cannot be built —
    // and turning those into a generic failure here told the user nothing.
    await startBuildAnswering({
      res,
      options,
      planId: prior.planId,
      // The attempt this retry follows. Admission uses it to tell a new attempt
      // at admitted work from an unrelated second submission, which it would
      // otherwise have to refuse alongside one.
      priorJobId: priorJobId,
      // Forwarded when the caller sends one. Retry rebuilds an admitted
      // lineage and normally sends none, but a caller that displayed a
      // snapshot is held to it rather than quietly exempted.
      ...whenDefined(body.expectedRevision, (definedValue) => ({ expectedRevision: definedValue })),
      ...whenDefined(body.jobId, (definedValue) => ({ requestedJobId: definedValue })),
      ...whenDefined(body.provider, (definedValue) => ({ provider: definedValue })),
      ...whenDefined(body.model, (definedValue) => ({ model: definedValue })),
      ...whenDefined(body.draftId, (definedValue) => ({ draftId: definedValue })),
      uploadedDocuments: uploadedContext.documents,
      ...whenDefined(uploadedContext.reviewCacheDir, (documentReviewCacheDir) => ({ documentReviewCacheDir })),
    });
    return true;
  }

  const discardMatch = url.pathname.match(
    /^\/create\/resource-architect\/jobs\/([^/]+)\/discard$/,
  );
  if (req.method === "POST" && discardMatch) {
    if (!options.repoRootPath) {
      throw new ServiceError(
        "not_configured",
        "Agent and Team Architect requires repoRootPath to be configured",
      );
    }
    const job = await discardResourceBuildTeam({
      ...whenDefined(options.resourcePublisher, (resourcePublisher) => ({ resourcePublisher })),
      repoRoot: options.repoRootPath,
      store: options.resourceArchitectStore,
      jobId: decodeURIComponent(discardMatch[1] ?? ""),
      isActive: (jobId) => options.createJobRegistry.isActive(jobId),
    });
    writeJson(res, 200, { job });
    return true;
  }

  const jobMatch = url.pathname.match(
    /^\/create\/resource-architect\/jobs\/([^/]+)$/,
  );
  if (req.method === "GET" && jobMatch) {
    const jobId = decodeURIComponent(jobMatch[1] ?? "");
    const job = await options.resourceArchitectStore.getJob(jobId);
    if (!job) {
      writeJson(res, 404, { error: `Resource build job not found: ${jobId}` });
      return true;
    }
    writeJson(res, 200, { job });
    return true;
  }

  return false;
}

/** The sanitized fields a turn metric records, from a completed answer. */
function toTurnMetricView(
  result: ResourceArchitectTurnHttpResponse,
): ResourceArchitectTurnFailureReport {
  return {
    jobId: result.jobId,
    operation: result.operation,
    outcomeKind: result.operation === "proposal" ? result.outcome.kind : null,
    meta: result.meta,
  };
}

function turnMetricView(
  result: ResourceArchitectTurnHttpResponse | undefined,
  failureReport: ResourceArchitectTurnFailureReport | undefined,
): ResourceArchitectTurnFailureReport | undefined {
  if (result) return toTurnMetricView(result);
  return failureReport;
}

async function saveTurnMetric(
  store: ResourceArchitectStore,
  params: {
    body: {
      operation: ResourceArchitectOperation;
      provider?: string;
      model?: string;
    };
    jobId: string;
    status: ResourceArchitectTurnMetric["status"];
    errorCode?: string;
    result?: ResourceArchitectTurnFailureReport;
    /** Present on the record written before the provider is called. */
    selection?: ModelSelectionRecord;
    timing?: ResourceArchitectTurnTiming;
    review?: ResourceArchitectFeedbackDiagnostics;
  },
): Promise<void> {
  const result = params.result;
  const metric: ResourceArchitectTurnMetric = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    jobId: params.jobId,
    operation: params.body.operation,
    status: params.status,
    provider: result?.meta.provider ?? params.selection?.provider ?? params.body.provider ?? null,
    model: result?.meta.model ?? params.selection?.model ?? params.body.model ?? null,
    // Only the turn knows how its pair was decided. A metric that records the
    // pair without the provenance cannot later answer whether the default was
    // used, which is the question the disclosure exists to answer.
    ...whenDefined(result?.meta.selection ?? params.selection, (selection) => ({ selection })),
    ...whenDefined(result?.meta.review ?? params.review, (review) => ({ review })),
    reasoning: result?.meta.reasoning ?? (params.body.operation === "conversation" ? "low" : null),
    outcomeKind: result?.outcomeKind ?? null,
    fallback: result?.meta.fallback ?? false,
    ...(params.errorCode ? { errorCode: params.errorCode } : {}),
    timing: params.timing ?? result?.meta.timing ?? emptyTurnTiming(performance.now()),
  };
  await store.saveTurnMetric(metric);
}

/** Exported because every authoring helper records the same shape. */
export function emptyTurnTiming(startedAt: number): ResourceArchitectTurnTiming {
  return {
    contextAssemblyMs: 0,
    providerDurationMs: 0,
    processSpawnMs: null,
    firstProviderEventMs: null,
    firstTextMs: null,
    parseDurationMs: 0,
    repairOccurred: false,
    repairDurationMs: 0,
    totalDurationMs: Math.max(0, performance.now() - startedAt),
    context: {
      instructionsChars: 0,
      operationChars: 0,
      uploadedDocumentPolicyChars: 0,
      visualizationPolicyChars: 0,
      teamLibraryChars: 0,
      agentLibraryChars: 0,
      totalChars: 0,
      historyChars: 0,
    },
  };
}

export function shouldReturnCancelledResourceArchitectTurn(params: {
  cancelled: boolean;
  result: {
    operation: ResourceArchitectOperation;
    outcome?: ResourceArchitectTurnOutcome;
  };
}): boolean {
  if (!params.cancelled) return false;
  // A persisted plan survives a late cancellation: the plan is already stored
  // and the user must be able to see the card that authorizes its build.
  return !(
    params.result.operation === "proposal" &&
    (params.result.outcome?.kind === "standalone_agents" ||
      params.result.outcome?.kind === "team" ||
      params.result.outcome?.kind === "resource_updates")
  );
}

/**
 * `startBuild`, with the two admission refusals rendered as answers.
 *
 * They are states the user is in — someone amended the plan, or its stored
 * shape can no longer be built — so each gets a status and a payload the card
 * can act on, rather than the generic failure a thrown error becomes.
 */
async function startBuildAnswering(
  params: Parameters<typeof startBuild>[0],
): Promise<void> {
  try {
    await startBuild(params);
  } catch (error) {
    if (error instanceof ResourceRevisionConflictError) {
      writeJson(params.res, 409, {
        error: "plan_revision_conflict",
        currentRevision: error.currentRevision,
      });
      return;
    }
    if (error instanceof ResourceInvalidShapeError) {
      writeJson(params.res, 422, { error: "invalid_shape", reason: error.message });
      return;
    }
    if (error instanceof ResourcePlanAlreadyAdmittedError) {
      writeJson(params.res, 409, {
        error: "plan_already_admitted",
        jobId: error.admission.jobId,
        admittedRevision: error.admission.revision,
      });
      return;
    }
    if (error instanceof ResourceLineageDiscardedError) {
      writeJson(params.res, 409, {
        error: "build_discarded",
        reason:
          "What this build made was discarded. Start a new plan to build it again.",
      });
      return;
    }
    if (error instanceof ResourceJobIdConflictError) {
      writeJson(params.res, 409, {
        error: "job_id_conflict",
        reason:
          `That build id already belongs to plan '${error.ownerPlanId}'.`,
      });
      return;
    }
    throw error;
  }
}

/** A build whose card was rendered from a plan that has since moved on. */
class ResourceRevisionConflictError extends Error {
  constructor(readonly currentRevision: string) {
    super("plan_revision_conflict");
  }
}

/** A build whose stored shape is not one this app can build. */
class ResourceInvalidShapeError extends Error {}

/**
 * A submission for a plan that already has an admitted build.
 *
 * Not an error the user caused twice over: it is the state of the plan, and the
 * card has to be able to name the job that holds it.
 */
class ResourcePlanAlreadyAdmittedError extends Error {
  constructor(readonly admission: ResourcePlanAdmission) {
    super("plan_already_admitted");
  }
}

/** A submission for a plan whose built team the user threw away. */
class ResourceLineageDiscardedError extends Error {
  constructor() {
    super("build_discarded");
  }
}

/**
 * A submission under a job id that already belongs to a different plan.
 *
 * Job ids are global, so accepting this would rewrite another plan's receipt.
 * Refused before anything is written, and the record it would have replaced is
 * left exactly as it is.
 */
class ResourceJobIdConflictError extends Error {
  constructor(readonly ownerPlanId: string) {
    super("job_id_conflict");
  }
}

async function startBuild(params: {
  res: http.ServerResponse;
  options: ResourceArchitectRoutesOptions;
  planId: string;
  /** The revision the card that authorized this build was rendered from. */
  expectedRevision?: string;
  /**
   * The attempt this request is retrying, when it is a retry.
   *
   * A retry is a new attempt at work that was already admitted, so it arrives
   * with a job id the admission has never seen. Without the attempt it follows,
   * it is indistinguishable from an unrelated second submission and would be
   * refused along with one.
   */
  priorJobId?: string;
  requestedJobId?: string;
  provider?: string;
  model?: string;
  draftId?: string;
  uploadedDocuments?: Awaited<ReturnType<typeof readTeamFileContext>>["documents"];
  documentReviewCacheDir?: string;
}): Promise<void> {
  if (!params.options.repoRootPath) {
    throw new ServiceError(
      "not_configured",
      "Agent Architect requires repoRootPath to be configured",
    );
  }
  // Read before the claim is taken. Anything that throws after it must give it
  // back, and the simplest way to guarantee that for configuration is not to
  // have taken the claim yet: a missing architect team left the plan marked
  // "already being applied" by a build that never started, and no later retry
  // could clear it.
  // Create and Retry belong to the same Architect as the conversation. The
  // Workflow Architect's pinned pair is unrelated to this composer's choice.
  const runtime = loadResourceArchitectConfig(params.options.repoRootPath);
  const provider = params.provider?.trim() || runtime.provider;
  const model = params.model?.trim() || runtime.model;
  const jobId = params.requestedJobId ?? randomUUID();
  const store = params.options.resourceArchitectStore;
  // Read, checked, admitted and claimed inside one critical section, the same
  // one the amendment endpoint holds. Reading the plan outside it meant a build
  // could be admitted against the plan as it stood before an accepted
  // amendment, and the team built was then not the team the card described.
  const admitted = await store.withPlanLock(
    params.planId,
    async (): Promise<
      | { kind: "already_admitted"; job: ResourceBuildJobSnapshot }
      | { kind: "job_id_busy"; start: CreateJobStartResult }
      | {
        kind: "admit";
        plan: PersistedResourceArchitectPlan;
        job: ResourceBuildJobSnapshot;
        admittedRevision: string;
        start: Extract<CreateJobStartResult, { status: "started" }>;
        releasePlan: () => void;
      }
    > => {
      // The job id is reserved first, before anything is read.
      //
      // A job id names one build for the whole workspace; this lock covers one
      // plan. Two plans submitted at once under one id each pass every check
      // below, so the reservation is the only thing that can separate them —
      // and it has to be taken before the first `await`, or a contender that
      // read "no job" could resume after the winner finished and released the
      // id, and write over the finished receipt.
      //
      // Nothing is held yet when this runs, so a reservation that fails on its
      // own durable write leaves nothing behind to release.
      const start = params.options.createJobRegistry.start(jobId);
      if (start.status !== "started") {
        // Somebody holds the id. A pending cancellation is the caller's own
        // request and is answered as one: it starts nothing, so a discarded
        // lineage has nothing to be resurrected by.
        if (start.status === "pending_cancelled") {
          return { kind: "job_id_busy", start };
        }
        const owner = await store.getJob(jobId);
        // The id belongs to another plan. That is about the id rather than
        // about this plan, and it stays the answer.
        if (owner && owner.planId !== params.planId) {
          throw new ResourceJobIdConflictError(owner.planId);
        }
        // Read before this path answers anything else. A plan whose team was
        // thrown away must not be told its build is busy, and must not be
        // handed back one of its own discarded receipts.
        if ((await store.getPlanAdmission(params.planId))?.discarded) {
          throw new ResourceLineageDiscardedError();
        }
        if (owner) return { kind: "already_admitted", job: owner };
        return { kind: "job_id_busy", start };
      }
      // Narrowed once, here. The admission below is a separate function, and
      // a guard in this one does not follow it in.
      const reservation: Extract<CreateJobStartResult, { status: "started" }> = start;
      // From here the id is held by this request. Every path out of this
      // section other than a granted admission gives it back.
      let reserved = true;
      const releaseReservation = (): void => {
        if (!reserved) return;
        reserved = false;
        params.options.createJobRegistry.finish(jobId);
      };
      try {
        return await admit();
      } finally {
        // A cleanup that fails must not replace the outcome that caused it,
        // and must not stop the plan claim being given back either.
        try {
          releaseReservation();
        } catch (cleanupError) {
          logProcessWarning(
            "resource-build",
            JSON.stringify({
              event: "build_reservation_cleanup_failed",
              jobId,
              planId: params.planId,
              error: cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
            }),
          );
        }
      }

      async function admit(): Promise<
        | { kind: "already_admitted"; job: ResourceBuildJobSnapshot }
        | {
          kind: "admit";
          plan: PersistedResourceArchitectPlan;
          job: ResourceBuildJobSnapshot;
          admittedRevision: string;
          start: Extract<CreateJobStartResult, { status: "started" }>;
          releasePlan: () => void;
        }
      > {
      const stored = await store.getPlan(params.planId);
      if (!stored) {
        throw new ServiceError(
          "conflict",
          "Resource plan is stale or was not generated by this server; create a new plan before applying.",
        );
      }
      // A request carrying an id that already has a record is either a replay
      // of that same submission or an attempt to write over somebody else's
      // receipt, and the two are told apart by the plan the record names.
      const existingJob = await store.getJob(jobId);
      if (existingJob && existingJob.planId !== params.planId) {
        throw new ResourceJobIdConflictError(existingJob.planId);
      }
      const admission = await store.getPlanAdmission(params.planId);
      // Before the replay, not after it. Every receipt in a lineage is a way
      // back to the shell the user removed, and the discarded receipt is one
      // of them: handing it back answered 202 with a record saying
      // `discarded: true`, which reads as a build in progress and says nothing
      // about the plan having been thrown away.
      //
      // Read inside the lock, so it governs every route in: a replay of the
      // same id, a retry of any attempt in the lineage, and a fresh
      // submission.
      if (admission?.discarded) {
        throw new ResourceLineageDiscardedError();
      }
      if (existingJob) {
        // The same submission again. It was already admitted and already ran,
        // so its record is the answer — re-running it would replace a finished
        // build with a fresh attempt nobody asked for.
        return { kind: "already_admitted", job: existingJob };
      }

      if (admission && admission.jobId !== jobId) {
        // A retry follows the attempt it is retrying; anything else is a
        // competing submission and must not take the plan away from the build
        // that holds it.
        const retriesThisLineage = params.priorJobId !== undefined &&
          (admission.jobId === params.priorJobId ||
            admission.priorJobIds.includes(params.priorJobId));
        if (!retriesThisLineage) {
          throw new ResourcePlanAlreadyAdmittedError(admission);
        }
      }
      if (admission) {
        // The plan must still be the plan that was admitted. A retry rebuilds
        // approved work, and it records the admitted revision on its job and in
        // the team's publication evidence — so if the stored bytes have moved
        // since, retrying would build something else and certify it with the
        // old digest. Checked before any job or team is written.
        const currentRevision = digestResourceArchitectPlan(stored);
        if (currentRevision !== admission.revision) {
          throw new ResourceRevisionConflictError(currentRevision);
        }
      }
      if (params.expectedRevision !== undefined) {
        const currentRevision = digestResourceArchitectPlan(stored);
        if (params.expectedRevision !== currentRevision) {
          throw new ResourceRevisionConflictError(currentRevision);
        }
      }
      // A stored shape that no longer parses must not build the legacy chain
      // in its place. The plan stays loadable so amendment can repair it.
      if (stored.kind === "team" && stored.team.shapeRejected) {
        throw new ResourceInvalidShapeError(
          "This team's saved way of working together is no longer one this app can build. Choose it again before building.",
        );
      }
      // And a shape can parse and still name an agent this team does not have.
      // The proposal parser refuses that, but a record on disk can reach here
      // another way — hand-edited, or written before that rule existed — so the
      // roster is checked again here, before any job or shell exists.
      if (stored.kind === "team" && stored.team.shape) {
        const verdict = validateShapeAgainstRoster(stored.team.shape, [
          ...stored.team.existingAgents.map((agent) => agent.name),
          ...stored.team.newAgents.map((agent) => agent.name),
        ]);
        if (!verdict.ok) {
          const names = verdict.offendingNames?.length
            ? ` (${verdict.offendingNames.join(", ")})`
            : "";
          throw new ResourceInvalidShapeError(`${verdict.reason}${names}`);
        }
      }
      // Claimed once everything that could refuse this build has passed. A
      // claim that fails leaves nothing written.
      if (!provider || !model) {
        throw new ServiceError("not_configured", runtime.selectionError?.message ??
          "The Agent and Team Architect has no model selected.");
      }
      const releasePlan = store.claimPlan(stored.id);
      // Retry is bound to the revision its lineage was admitted with, not to
      // whatever the plan reads as now. A fresh admission records the revision
      // it was granted against.
      const admittedRevision = admission?.revision ??
        digestResourceArchitectPlan(stored);
      try {
        await store.savePlanAdmission({
          planId: params.planId,
          jobId,
          revision: admittedRevision,
          priorJobIds: admission
            ? [...admission.priorJobIds, admission.jobId].filter(
              (entry) => entry !== jobId,
            )
            : [],
        });
      } catch (error) {
        // Nothing was admitted. The plan claim goes back; the reservation is
        // released by this section's own cleanup. The admission record is left
        // alone — this request never wrote one, and clearing would take the
        // plan away from whichever attempt does hold it.
        releasePlan();
        throw error;
      }
      // The receipt is written here, not after this section ends. The same
      // request arriving twice at once has to be answered by the one admitted
      // build, and a receipt written after the lock was released left the
      // second arrival holding the plan lock with nothing to find: it saw the
      // job id reserved, no record, and reported a conflict with itself.
      let job: ResourceBuildJobSnapshot;
      try {
        job = createResourceBuildSnapshot({ plan: stored, jobId, admittedRevision });
        if (params.draftId) await store.conversation.attachBuild(params.draftId, stored.id, jobId);
        await store.saveJob(job);
      } catch (error) {
        // The lineage goes back to the attempt that does have a record. This
        // plan has been built against before — there is a shell on disk — so
        // leaving the admission pointing at an attempt that never existed
        // would have reconciliation release the plan entirely and unfreeze a
        // shape that no longer matches what was built.
        if (admission) {
          try {
            await store.savePlanAdmission(admission);
          } catch (restoreError) {
            // Recorded, not raised: the durable backstop is reconciliation,
            // which rolls the lineage back to its last real attempt.
            logProcessWarning(
              "resource-build",
              JSON.stringify({
                event: "build_admission_restore_failed",
                jobId,
                planId: params.planId,
                error: restoreError instanceof Error
                  ? restoreError.message
                  : String(restoreError),
              }),
            );
          }
        }
        releasePlan();
        throw error;
      }
      // The reservation now belongs to the build, and is given back when the
      // build settles rather than when this section ends.
      reserved = false;
      return {
        kind: "admit",
        plan: stored,
        job,
        admittedRevision,
        start: reservation,
        releasePlan,
      };
      }
    },
  );
  if (admitted.kind === "already_admitted") {
    writeJson(params.res, 202, { jobId, job: admitted.job });
    return;
  }
  if (admitted.kind === "job_id_busy") {
    // No entry was created for this request: `pending_cancelled` never made
    // one, and a conflict belongs to the build that is already running, which
    // must not be finished from here.
    if (admitted.start.status === "pending_cancelled") {
      writeJson(params.res, 200, { jobId, cancelled: true });
      return;
    }
    writeJson(params.res, 409, { error: `Create job '${jobId}' is already running` });
    return;
  }
  const { plan, job, releasePlan, start } = admitted;
  // From here on this request owns the plan claim and, once the registry
  // accepts it, the job id. Nothing else can give either back: the only thing
  // that normally does is the build's own completion, and that build has not
  // started yet.
  let ownsBuildSlot = false;
  const releaseBuildOwnership = (): void => {
    if (!ownsBuildSlot) return;
    try {
      releasePlan();
    } finally {
      params.options.createJobRegistry.finish(jobId);
    }
    // Marked given back only once both have actually been given back. Clearing
    // it first would let a failure part-way through look like a completed
    // release to whichever caller ran next.
    ownsBuildSlot = false;
  };
  /**
   * Gives the slot back, recording a cleanup failure instead of raising it.
   *
   * Both callers are places where raising would lose something worse: the
   * original failure on the way out of `startBuild`, and the only report of a
   * finished build once the response is long gone.
   */
  const releaseBuildOwnershipQuietly = (event: string): void => {
    try {
      releaseBuildOwnership();
    } catch (cleanupError) {
      logProcessWarning(
        "resource-build",
        JSON.stringify({
          event,
          jobId,
          planId: plan.id,
          error:
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        }),
      );
    }
  };
  ownsBuildSlot = true;
  launchBackgroundResourceBuild(
    {
      ...whenDefined(params.options.resourcePublisher, (resourcePublisher) => ({ resourcePublisher })),
      repoRoot: params.options.repoRootPath,
      plan,
      job,
      store: params.options.resourceArchitectStore,
      provider,
      model,
      ...whenDefined(params.draftId, (definedValue) => ({ draftId: definedValue })),
      ...whenDefined(params.options.teamFileStore, (definedValue) => ({ teamFileStore: definedValue })),
      ...whenDefined(params.options.fileParserLauncher, (definedValue) => ({ fileParserLauncher: definedValue })),
      ...whenDefined(params.uploadedDocuments, (definedValue) => ({ uploadedDocuments: definedValue })),
      ...whenDefined(params.documentReviewCacheDir, (documentReviewCacheDir) => ({ documentReviewCacheDir })),
      signal: start.job.controller.signal,
    },
    {
      // The build already recorded its own failed job. This is the only
      // process-level record of why, including when recording it is what
      // failed, so it names the job and plan it belongs to. Only the message
      // is logged: an error object from a build can carry provider payloads.
      onFailure: (error) => {
        logProcessWarning(
          "resource-build",
          JSON.stringify({
            event: "background_build_failed",
            jobId,
            planId: plan.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      },
      // The build's promise is terminated by `launchBackgroundResourceBuild`,
      // so a failure here has nowhere else to surface: it would leave the job
      // id active with no build behind it and nothing to say why.
      onSettled: () => {
        releaseBuildOwnershipQuietly("build_settle_cleanup_failed");
      },
    },
  );
  writeJson(params.res, 202, { jobId, job });
}

/**
 * Reads or changes the interaction shape the Architect proposed for a plan.
 *
 * The card states a shape rather than asking for one, so this endpoint is the
 * whole of the user's ability to disagree with it. Three things it refuses,
 * each for a reason the user would otherwise discover only after the build:
 *
 * - a write against a revision that has since moved, which would silently
 *   discard whoever wrote first;
 * - a shape whose roles do not cover the roster exactly once, which emits a
 *   team.yaml naming an agent that never runs, or leaving one out;
 * - a plan a build is already applying, which would change what is being built
 *   half way through.
 *
 * The revision is a digest of the stored plan rather than a counter. It is the
 * idiom the Team writer already uses (`digestTeamYaml` with
 * `expectedRevision`), it needs no migration for the plan files already on
 * disk, and it detects any concurrent change to the plan rather than only a
 * change to its shape.
 */
async function handlePlanShape(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  store: ResourceArchitectStore;
  planId: string;
}): Promise<void> {
  const { res, store, planId } = params;

  if (params.req.method === "GET") {
    const plan = await store.getPlan(planId);
    if (!plan) {
      writeJson(res, 404, { error: `Resource plan not found: ${planId}` });
      return;
    }
    // Reported, never inferred by the card. A plan with an admitted build can
    // no longer be amended, and a card that had to guess that from a failed
    // write would offer a choice it cannot honour.
    const admission = await store.getPlanAdmission(planId);
    writeJson(res, 200, {
      planId,
      ...planSnapshotOf(plan),
      admitted: admission
        ? { jobId: admission.jobId, revision: admission.revision }
        : null,
    });
    return;
  }

  const body = await readJsonBody(params.req);
  const fields = isRecord(body) ? body : {};

  // Read inside the lock, never before it: a revision compared against a value
  // read outside the critical section is a check two writers can both pass.
  await store.withPlanLock(planId, async () => {
    const plan = await store.getPlan(planId);
    if (!plan) {
      writeJson(res, 404, { error: `Resource plan not found: ${planId}` });
      return;
    }
    if (plan.kind !== "team") {
      writeJson(res, 422, {
        error: "invalid_shape",
        reason: "Only a Team plan has a shape to change.",
      });
      return;
    }
    // Refused once a build has ever been admitted for this plan, whatever
    // became of it. Checking only builds that are running now is not enough: a
    // failed or cancelled build still left agents, and possibly a flagged team,
    // on disk — so an amendment afterwards would describe a plan that no longer
    // matches what exists, and retry would rebuild against it. To choose
    // differently the user edits the built team or starts a new plan, which
    // gets an identity of its own.
    const admission = await store.getPlanAdmission(planId);
    if (admission) {
      writeJson(res, 409, {
        error: "plan_already_admitted",
        jobId: admission.jobId,
        admittedRevision: admission.revision,
        reason:
          "This team has already been built from this plan. Edit the team itself, or start a new plan to work differently.",
      });
      return;
    }
    // And refused while a build holds the plan, which covers the window before
    // its admission has been written.
    if (store.isPlanBeingApplied(planId)) {
      writeJson(res, 409, {
        error: "plan_being_built",
        reason: "This team is being built. Wait for it to finish, then change it.",
      });
      return;
    }

    const parsedShape = teamShapeSchema.safeParse(fields.shape);
    if (!parsedShape.success) {
      writeJson(res, 422, {
        error: "invalid_shape",
        reason: "That is not a way a team can work together.",
      });
      return;
    }

    // A request that never said which version it was written against is
    // incomplete, not stale, and the two are different answers: a conflict
    // carries the plan as it now stands, which says nothing about a request
    // that was malformed. The saved-team route already answers this as
    // `400 missing_revision`, and one client has to be able to handle both.
    if (typeof fields.expectedRevision !== "string") {
      writeJson(res, 400, {
        error: "missing_revision",
        reason:
          "A change has to say which version of the plan it was written against.",
      });
      return;
    }
    const currentRevision = digestResourceArchitectPlan(plan);
    if (fields.expectedRevision !== currentRevision) {
      writeJson(res, 409, {
        error: "plan_revision_conflict",
        currentRevision,
        ...planSnapshotOf(plan),
        ...(plan.team.shape ? { currentShape: plan.team.shape } : {}),
      });
      return;
    }

    const roster = [
      ...plan.team.existingAgents.map((agent) => agent.name),
      ...plan.team.newAgents.map((agent) => agent.name),
    ];
    const verdict = validateShapeAgainstRoster(parsedShape.data, roster);
    if (!verdict.ok) {
      writeJson(res, 422, {
        error: "invalid_shape",
        reason: verdict.reason,
        ...(verdict.offendingNames ? { offendingNames: verdict.offendingNames } : {}),
      });
      return;
    }

    // Amendment is the repair route for a plan whose stored shape no longer
    // parses, so accepting a valid one clears the rejection. Leaving it set
    // would keep the build refusing and tell the user to choose again after
    // they just did.
    const { shapeRejected: _repaired, ...team } = plan.team;
    const next = { ...plan, team: { ...team, shape: parsedShape.data } };
    await store.savePlan(next);
    writeJson(res, 200, { planId, ...planSnapshotOf(next) });
  });
}

/**
 * One authoritative description of a stored plan.
 *
 * The plan and the revision that describes it travel together, in every answer
 * about that plan. The revision is a digest of the whole record, so it moves
 * when the description or the roster moves and not only when the shape does —
 * a reader given a revision beside a shape alone would bind the new revision to
 * data it was already showing, and the two would disagree with nothing to
 * notice it.
 */
function planSnapshotOf(plan: PersistedResourceArchitectPlan): Record<string, unknown> {
  return {
    revision: digestResourceArchitectPlan(plan),
    plan,
    ...(plan.kind === "team" && plan.team.shape ? { shape: plan.team.shape } : {}),
    // Reported, because the build refuses this plan and the card has to be able
    // to say so. Without it a restored plan with an unbuildable shape looks
    // exactly like one that never chose a shape.
    ...(plan.kind === "team" && plan.team.shapeRejected ? { shapeRejected: true } : {}),
  };
}

/** `sha256:<hex>` over the stored plan, insensitive to key order. */
function digestResourceArchitectPlan(plan: unknown): string {
  return `sha256:${
    createHash("sha256").update(canonicalizeJson(plan), "utf8").digest("hex")
  }`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const planWebResearchSchema = z.object({
  agentName: z.string().min(1),
  enabled: z.boolean(),
  expectedRevision: z.string().min(1),
}).strict();

async function handlePlanWebResearch(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  store: ResourceArchitectStore;
  planId: string;
}): Promise<void> {
  const { res, store, planId } = params;
  const parsed = planWebResearchSchema.safeParse(await readJsonBody(params.req));
  if (!parsed.success) {
    writeJson(res, 400, { error: "invalid_web_research", reason: "Choose an Agent, internet access and the displayed plan revision." });
    return;
  }
  await store.withPlanLock(planId, async () => {
    const plan = await store.getPlan(planId);
    if (!plan) {
      writeJson(res, 404, { error: "plan_not_found", reason: "This proposal no longer exists." });
      return;
    }
    const admission = await store.getPlanAdmission(planId);
    if (admission || store.isPlanBeingApplied(planId)) {
      writeJson(res, 409, { error: "plan_already_admitted", reason: "Creation has started. Change internet access in the Agent's Tools tab after creation.", ...planSnapshotOf(plan), ...(admission ? { admitted: { jobId: admission.jobId, revision: admission.revision } } : {}) });
      return;
    }
    if (parsed.data.expectedRevision !== digestResourceArchitectPlan(plan)) {
      writeJson(res, 409, { error: "plan_revision_conflict", reason: "This proposal changed. Review its current settings and try again.", ...planSnapshotOf(plan) });
      return;
    }
    const next = changePlanWebResearch(plan, parsed.data.agentName, parsed.data.enabled);
    if (!next) {
      writeJson(res, 422, { error: "agent_not_planned", reason: "Only new Agents in this proposal can change internet access here." });
      return;
    }
    await store.savePlan(next);
    writeJson(res, 200, { planId, ...planSnapshotOf(next) });
  });
}
