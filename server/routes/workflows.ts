import { performance } from "node:perf_hooks";
import type { ModelSelectionRecord } from "../../contracts/agent-model-selection.js";
import type { ResourceArchitectTurnMetric } from "../../contracts/resource-architect.js";
import { emptyTurnTiming } from "./resource-architect.js";
import { TurnMetricStore } from "../turn-metric-store.js";
import { whenDefined } from "../../core/optional-properties.js"
import * as crypto from "node:crypto";
import type * as http from "node:http";
import { URL } from "node:url";

import { ServiceError } from "../../services/service-errors.js";
import {
  deleteWorkflowById,
  listWorkflowEntries,
  listWorkflowGeneratorTeams,
  parseGeneratorSaveBody,
  parseGeneratorTurnBody,
  parseGeneratorValidateYamlBody,
  parseWorkflowUpdateBody,
  readWorkflowYaml,
  runWorkflowGeneratorTurn,
  saveGeneratedWorkflow,
  updateWorkflowYaml,
  validateWorkflowYaml,
} from "../../services/workflow-service.js";
import type { CreateJobRegistry } from "../create-job-registry.js";
import { handleAgentTextStreamRequest } from "./agent-text-stream-route.js";
import { openTurnTextStream } from "../../domains/runtime/agent-text-stream-turn.js";
import type { AgentTextStreamHub } from "../../domains/runtime/agent-text-stream-hub.js";
import {
  readJsonBody,
  writeJson,
  writeServiceError,
} from "../http.js";

/**
 * Create-lane channels are owned by this constant rather than by a user
 * resource, because a Create turn belongs to no session. Lanes hold disjoint
 * owner values, so a channel opened here cannot be read through a session URL
 * or through the sibling architect endpoint.
 */
/** The name a disclosure names, matching what the Create surface calls it. */
const WORKFLOW_ARCHITECT_SPEAKER = "Workflow Architect";

export const WORKFLOW_ARCHITECT_CHANNEL_OWNER = "create:workflow-architect";

export interface WorkflowRoutesOptions {
  repoRootPath?: string;
  workflowsRegistryPath?: string;
  createJobRegistry: CreateJobRegistry;
  /** Where this helper's durable turn records live. */
  workflowArchitectTurnStore?: TurnMetricStore;
  agentTextStreamHub?: AgentTextStreamHub;
  agentTextStreamWaitMs?: number;
  agentTextStreamHeartbeatMs?: number;
  isAbortLike(error: unknown): boolean;
}

/**
 * One Workflow Architect turn, in the shape every authoring helper records.
 *
 * Timing is left empty here: this record exists to say which model ran and how
 * it was chosen, and inventing durations the route never measured would be
 * worse than recording none.
 */
function workflowTurnRecord(
  jobId: string,
  status: "running" | "completed" | "cancelled" | "failed",
  selection: ModelSelectionRecord | undefined,
  fallback = false,
): ResourceArchitectTurnMetric {
  return {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    jobId,
    operation: "conversation",
    status,
    provider: selection?.provider ?? null,
    model: selection?.model ?? null,
    ...(selection ? { selection } : {}),
    reasoning: null,
    outcomeKind: null,
    fallback,
    timing: emptyTurnTiming(performance.now()),
  };
}

export async function handleWorkflowRoutes(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  options: WorkflowRoutesOptions;
}): Promise<boolean> {
  const { req, res, url, options } = params;

  if (req.method === "GET" && url.pathname === "/workflows") {
    const workflows = listWorkflowEntries(options.workflowsRegistryPath);
    writeJson(res, 200, { workflows });
    return true;
  }

  const workflowByIdMatch = url.pathname.match(/^\/workflows\/([^/]+)$/);
  if (workflowByIdMatch) {
    const workflowId = decodeURIComponent(workflowByIdMatch[1] ?? "");
    try {
      if (req.method === "GET") {
        writeJson(
          res,
          200,
          await readWorkflowYaml({
            workflowId,
            ...whenDefined(options.workflowsRegistryPath, (definedValue) => ({ registryPath: definedValue })),
          }),
        );
        return true;
      }

      if (req.method === "PATCH") {
        const payload = await readJsonBody(req);
        const body = parseWorkflowUpdateBody(payload);
        writeJson(
          res,
          200,
          await updateWorkflowYaml({
            ...whenDefined(options.repoRootPath, (definedValue) => ({ repoRootPath: definedValue })),
            ...whenDefined(options.workflowsRegistryPath, (definedValue) => ({ registryPath: definedValue })),
            workflowId,
            yaml: body.yaml,
          }),
        );
        return true;
      }

      if (req.method === "DELETE") {
        await deleteWorkflowById({
          workflowId,
          ...whenDefined(options.workflowsRegistryPath, (definedValue) => ({ registryPath: definedValue })),
        });
        res.writeHead(204);
        res.end();
        return true;
      }
    } catch (error) {
      if (error instanceof ServiceError) {
        writeServiceError(res, error);
        return true;
      }
      throw error;
    }
  }

  if (req.method === "GET" && url.pathname === "/create/teams") {
    try {
      writeJson(res, 200, listWorkflowGeneratorTeams(options.repoRootPath));
    } catch (error) {
      if (error instanceof ServiceError) {
        writeServiceError(res, error);
        return true;
      }
      throw error;
    }
    return true;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/create/workflow-architect/turns"
  ) {
    // What the run recorded, not what Settings say now. Reopening Create has to
    // describe a finished turn by the pair it actually ran on, and re-deriving
    // that from the current default would relabel history every time somebody
    // changed it.
    //
    // Only the turn's identity and its selection are published. The rest of the
    // record — timings, token counts, prompt sizes — is operational detail this
    // reader has no use for, and a surface that returns everything it holds
    // invites a consumer to depend on it.
    const requested = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(requested) ? requested : 50;
    const metrics =
      (await options.workflowArchitectTurnStore?.list(limit)) ?? [];
    res.setHeader("cache-control", "no-store");
    writeJson(res, 200, {
      turns: metrics.map((metric) => ({
        jobId: metric.jobId,
        status: metric.status,
        recordedAt: metric.recordedAt,
        // Absent on a turn that failed before choosing a pair. Left absent
        // rather than filled in: there is no honest value for it.
        ...(metric.selection ? { selection: metric.selection } : {}),
      })),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/create/turn") {
    return handleAgentTextStreamRequest({
      hub: options.agentTextStreamHub,
      req,
      res,
      url,
      ownerId: WORKFLOW_ARCHITECT_CHANNEL_OWNER,
      ...whenDefined(options.agentTextStreamWaitMs, (waitMs) => ({ waitMs })),
      ...whenDefined(options.agentTextStreamHeartbeatMs, (heartbeatMs) => ({
        heartbeatMs,
      })),
    });
  }

  if (req.method === "POST" && url.pathname === "/create/turn") {
    const payload = await readJsonBody(req);
    const body = parseGeneratorTurnBody(payload);
    const jobId = body.jobId ?? crypto.randomUUID();
    const startResult = options.createJobRegistry.start(jobId);
    if (startResult.status === "pending_cancelled") {
      writeJson(res, 200, { jobId, cancelled: true });
      return true;
    }
    if (startResult.status === "conflict") {
      writeJson(res, 409, {
        error: `Create job '${jobId}' is already running`,
      });
      return true;
    }

    const { job } = startResult;
    const textStream = openTurnTextStream({
      ...whenDefined(options.agentTextStreamHub, (hub) => ({ hub })),
      channelId: jobId,
      ownerId: WORKFLOW_ARCHITECT_CHANNEL_OWNER,
      streaming: true,
    });
    // One turn, one terminal record. Tracked here rather than asked of the
    // registry, because the two answer different questions: a turn can hold no
    // completion claim and still have written its outcome.
    let terminalRecordStored = false;
    try {
      const result = await runWorkflowGeneratorTurn({
        ...whenDefined(options.repoRootPath, (definedValue) => ({ repoRootPath: definedValue })),
        history: body.history,
        currentDraft: body.currentDraft,
        ...whenDefined(body.provider, (definedValue) => ({ provider: definedValue })),
        ...whenDefined(body.model, (definedValue) => ({ model: definedValue })),
        signal: job.controller.signal,
        ...whenDefined(textStream.onTextDelta, (onTextDelta) => ({ onTextDelta })),
        // Published before the model is called, so the notice exists while the
        // provider is working rather than arriving with its answer.
        onSelectionResolved: async (selection) => {
          // Durable first, shown second. The record is the authority and the
          // frame is a preview, so a frame nobody receives costs the live
          // notice and nothing else — but a notice shown before the record
          // exists would be a claim with nothing behind it.
          await options.workflowArchitectTurnStore?.save(
            workflowTurnRecord(jobId, "running", selection),
          );
          textStream.publishSelection(WORKFLOW_ARCHITECT_SPEAKER, selection);
        },
      });
      // Asked for in one step rather than read and then acted on. A claim is
      // granted only while nothing has cancelled the job, and from that moment
      // a cancellation no longer changes what this turn is about to report —
      // which a bare read could not promise, because one landing just after it
      // used to leave Stop and this reply telling different stories.
      //
      // Closed after that decision, not before it: the bubble closes once, so a
      // turn the user stopped must not first be shown as a finished answer. One
      // decision still drives both the record and the reply, so they cannot
      // disagree, and only one terminal record is ever written — the store
      // replaces a `running` row and would otherwise leave two.
      const claim = options.createJobRegistry.claimCompletion(jobId);
      await options.workflowArchitectTurnStore?.save(
        claim === "cancelled"
          ? workflowTurnRecord(jobId, "cancelled", result.meta.selection)
          : workflowTurnRecord(
              jobId,
              "completed",
              result.meta.selection,
              result.meta.fallback,
            ),
      );
      terminalRecordStored = true;
      if (claim === "cancelled") {
        textStream.close("error");
        writeJson(res, 200, { jobId, cancelled: true });
        return true;
      }
      // The claim becomes the outcome here and not before: what is reported has
      // to be what was persisted, so a write that failed leaves nothing to
      // confirm and the catch below sees a job that is cancellable again.
      options.createJobRegistry.confirmCompletion(jobId);
      writeJson(res, 200, { jobId, ...result });
      // Last, deliberately: see the sibling architect route. Anything that can
      // still fail must fail before a bubble is closed as a success, because
      // that close cannot be taken back.
      textStream.close("completed");
    } catch (error) {
      // An unconfirmed claim goes back, so the cancellation read below sees the
      // truth rather than a reservation that came to nothing.
      options.createJobRegistry.releaseCompletion(jobId);
      if (terminalRecordStored) {
        // This turn's outcome is already on disk and its reply already sent.
        // Whatever failed afterwards, a second terminal record would turn one
        // turn into two: the store replaces a `running` row, so writing again
        // here appends rather than corrects. Asked of the record rather than
        // of the registry, because a turn can hold no claim and still have
        // stored its outcome.
        throw error;
      }
      // Whatever ended this turn, the record must stop saying it is running.
      // A pending record nobody replaces reports a turn still in progress that
      // ended long ago, to every later read and every restart. The selection is
      // carried forward by the store: the turn did use a model.
      const terminal =
        options.createJobRegistry.isCancelled(job) || options.isAbortLike(error)
          ? "cancelled"
          : "failed";
      await options.workflowArchitectTurnStore?.save(
        workflowTurnRecord(jobId, terminal, undefined),
      );
      if (terminal === "cancelled") {
        writeJson(res, 200, { jobId, cancelled: true });
        return true;
      }
      if (error instanceof ServiceError) {
        writeServiceError(res, error);
        return true;
      }
      throw error;
    } finally {
      // Never leave the bubble open: a reader waiting on this channel would
      // otherwise sit on a reply that is never coming.
      textStream.close("error");
      options.createJobRegistry.finish(jobId);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/create/validate-yaml") {
    const payload = await readJsonBody(req);
    const body = parseGeneratorValidateYamlBody(payload);
    try {
      writeJson(
        res,
        200,
        validateWorkflowYaml({
          ...whenDefined(options.repoRootPath, (definedValue) => ({ repoRootPath: definedValue })),
          yaml: body.yaml,
        }),
      );
    } catch (error) {
      if (error instanceof ServiceError) {
        writeServiceError(res, error);
        return true;
      }
      throw error;
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/create/save") {
    const payload = await readJsonBody(req);
    const body = parseGeneratorSaveBody(payload);
    try {
      writeJson(
        res,
        201,
        await saveGeneratedWorkflow({
          ...whenDefined(options.repoRootPath, (definedValue) => ({ repoRootPath: definedValue })),
          ...whenDefined(options.workflowsRegistryPath, (definedValue) => ({ workflowsRegistryPath: definedValue })),
          body,
        }),
      );
    } catch (error) {
      if (error instanceof ServiceError) {
        writeServiceError(res, error);
        return true;
      }
      throw error;
    }
    return true;
  }

  return false;
}
