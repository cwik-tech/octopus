import { publishResourceMutation } from "../../contracts/resource-publication.js";
import { whenDefined } from "../../core/optional-properties.js"
import * as crypto from "node:crypto";
import type * as http from "node:http";
import { URL } from "node:url";

import { agentHealthRequestSchema } from "../../contracts/schemas/agent-requests.js";
import {
  addAgentToTeam,
  addAgentPackageFiles,
  checkAgentProviderHealth,
  commitAgent,
  commitAgentPackageImport,
  deleteAgent,
  listAgents,
  listAgentTeamOptions,
  listSkillsTree,
  nextAvailableAgentName,
  previewAgentDelete,
  previewAgentPackageImport,
  readAgentDetail,
  removeAgentPackageItem,
  runCreateAgent,
  runRefineAgent,
  savePersona,
} from "../../domains/agent-generator/index.js";
import {
  parseAddAgentToTeamBody,
  parseAgentPackageAddBody,
  parseAgentPackageImportBody,
  parseAgentPackageRemoveBody,
  parseCommitAgentBody,
  parseDeleteAgentBody,
  parseDeleteAgentRequestBody,
  parseDraftAgentBody,
  parseListSkillsBody,
  parseRefineAgentBody,
  parseSaveAgentPersonaBody,
} from "../../services/agent-service.js";
import { parseServiceRequest } from "../../services/service-errors.js";
import { parseTeamRevision } from "../../services/team-builder-service.js";
import { TeamRevisionConflictError } from "../../domains/agent-generator/team-manager.js";
import type { CreateJobRegistry } from "../create-job-registry.js";
import { readJsonBody, writeJson } from "../http.js";
import { writeTeamRevisionConflict } from "./team-builder.js";
import type { AgentProviderHealthTarget } from "../../contracts/agent-generator.js";
import type { McpAgentGrantsService } from "../../services/mcp-agent-grants-service.js";
import { BUILT_IN_PROVIDER_USAGE_SOURCES } from "../../domains/provider/provider-usage-sources.js";
import type { ProviderUsageSource } from "../../domains/provider/provider-usage.js";
import type { ProviderFailureHealthService } from "../../services/provider-failure-health-service.js";
import type { ProviderSettingsService } from "../../services/provider-settings-service.js";
import type { ResourceLibraryService } from "../../services/resource-library-service.js";

export interface AgentRoutesOptions {
  repoRootPath: string;
  createJobRegistry: CreateJobRegistry;
  isAbortLike(error: unknown): boolean;
  mcpAgentGrantsService?: McpAgentGrantsService;
  resourceLibraryService?: ResourceLibraryService;
  providerSettingsService: Pick<ProviderSettingsService, "listCliAgents">;
  /** What runs have discovered about each provider. Absent without a workspace. */
  providerFailureHealth?: Pick<ProviderFailureHealthService, "read" | "forget">;
  /**
   * Who can say how much of a provider's allowance is left.
   *
   * Defaults to the built-in sources, which read directories under the user's
   * home. Overridable so a test can drive this route without depending on
   * whatever the machine running it happens to have in `~/.codex`.
   */
  usageSources?: readonly ProviderUsageSource[];
}

export async function handleAgentRoutes(params: Parameters<typeof handleAgentRoutesWithoutReadLock>[0]): Promise<boolean> {
  if (params.req.method === 'GET' && params.options.resourceLibraryService) {
    return params.options.resourceLibraryService.withResourceRead(() => handleAgentRoutesWithoutReadLock(params));
  }
  return handleAgentRoutesWithoutReadLock(params);
}

async function handleAgentRoutesWithoutReadLock(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  options: AgentRoutesOptions;
}): Promise<boolean> {
  const { req, res, url, options } = params;

  if (req.method === "GET" && url.pathname === "/create/agents") {
    const includeHidden = url.searchParams.get("include_hidden") === "1";
    // Asked for separately from `include_hidden`, because the Create library
    // wants exactly one of the two: the front door listed, and the runtime's
    // own hidden personas still out of sight.
    const includeSystem = url.searchParams.get("include_system") === "1";
    const agents = listAgents(options.repoRootPath).filter(
      (agent) =>
        (includeHidden || agent.uiHidden !== true) &&
        (includeHidden || includeSystem || agent.system !== true),
    );
    writeJson(res, 200, { agents });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/create/agents/teams") {
    const teams = listAgentTeamOptions(options.repoRootPath);
    writeJson(res, 200, { teams });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/create/agents/health") {
    const body = await readJsonBody(req);
    const healthRequest = parseAgentHealthBody(body);
    const health = await checkAgentProviderHealth({
      repoRoot: options.repoRootPath,
      cliSettingsReader: options.providerSettingsService,
      // The composition edge is where ambient machine state is named: these
      // read directories under the user's home, which is exactly what a domain
      // function must not help itself to.
      usageSources: options.usageSources ?? BUILT_IN_PROVIDER_USAGE_SOURCES,
      ...whenDefined(options.providerFailureHealth?.read(), (providerFailures) => ({
        providerFailures,
      })),
      ...healthRequest,
    });
    // Two different things can retire what a past run recorded, and neither
    // of them is the badge.
    //
    // A reading disproves exactly the failure it was compared against, and
    // nothing newer: a check reads a snapshot and answers milliseconds later,
    // so a run that failed in between must survive. That is the cutoff.
    //
    // A live answer from the provider disproves anything known when it came
    // back, so its cutoff is the moment of the check itself. `status: "ok"` is
    // deliberately not used for this — for a CLI provider it means the binary
    // is installed and the model is enabled, which is equally true of an
    // account that ran out an hour ago.
    const recovered = options.providerFailureHealth;
    if (recovered) {
      await Promise.all(
        health.flatMap((checked) => {
          if (checked.provider === undefined) return [];
          const observedNoLaterThan =
            checked.disprovedRuntimeFailureAt ??
            (checked.answeredLivePing === true ? checked.checkedAt : undefined);
          if (observedNoLaterThan === undefined) return [];
          return [
            recovered.forget({
              provider: checked.provider,
              ...whenDefined(checked.model, (model) => ({ model })),
              observedNoLaterThan,
            }),
          ];
        }),
      );
    }
    writeJson(res, 200, { health });
    return true;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/create/agents/list-skills"
  ) {
    const payload = await readJsonBody(req);
    const body = parseListSkillsBody(payload);
    const tree = listSkillsTree(body.path);
    if (!tree) {
      writeJson(res, 404, {
        error: `Path does not exist or is not a directory: ${body.path}`,
      });
      return true;
    }
    writeJson(res, 200, { tree });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/create/agents/draft") {
    const payload = await readJsonBody(req);
    const body = parseDraftAgentBody(payload);
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
    try {
      const result = await runCreateAgent({
        repoRoot: options.repoRootPath,
        skillPaths: body.skillPaths,
        chatHistory: body.chatHistory,
        ...whenDefined(body.duplicatePolicy, (definedValue) => ({ duplicatePolicy: definedValue })),
        ...whenDefined(body.provider, (definedValue) => ({ provider: definedValue })),
        ...whenDefined(body.model, (definedValue) => ({ model: definedValue })),
        signal: job.controller.signal,
      });
      if (options.createJobRegistry.isCancelled(job)) {
        writeJson(res, 200, { jobId, cancelled: true });
        return true;
      }
      writeJson(res, 200, { jobId, ...result });
    } catch (error) {
      if (
        options.createJobRegistry.isCancelled(job) ||
        options.isAbortLike(error)
      ) {
        writeJson(res, 200, { jobId, cancelled: true });
        return true;
      }
      throw error;
    } finally {
      options.createJobRegistry.finish(jobId);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/create/agents/commit") {
    const payload = await readJsonBody(req);
    const body = parseCommitAgentBody(payload);
    const approvedName = body.overwrite
      ? body.approvedName
      : nextAvailableAgentName(options.repoRootPath, body.approvedName);
    try {
      const result = await publishAgent(options, approvedName, commitAgent, {
        repoRoot: options.repoRootPath,
        approvedName,
        personaMarkdown: body.personaMarkdown,
        skillPaths: body.skillPaths,
        ...whenDefined(body.generatedSkills, (definedValue) => ({ generatedSkills: definedValue })),
        ...whenDefined(body.overwrite, (definedValue) => ({ overwrite: definedValue })),
      });
      writeJson(res, 201, result);
    } catch (error) {
      writeRouteError(res, 400, error);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/create/agents/refine") {
    const payload = await readJsonBody(req);
    const body = parseRefineAgentBody(payload);
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
    try {
      const result = await runRefineAgent({
        repoRoot: options.repoRootPath,
        agentName: body.agentName,
        currentPersona: body.currentPersona,
        chatHistory: body.chatHistory,
        ...whenDefined(body.provider, (definedValue) => ({ provider: definedValue })),
        ...whenDefined(body.model, (definedValue) => ({ model: definedValue })),
        signal: job.controller.signal,
      });
      if (options.createJobRegistry.isCancelled(job)) {
        writeJson(res, 200, { jobId, cancelled: true });
        return true;
      }
      writeJson(res, 200, { jobId, ...result });
    } catch (error) {
      if (
        options.createJobRegistry.isCancelled(job) ||
        options.isAbortLike(error)
      ) {
        writeJson(res, 200, { jobId, cancelled: true });
        return true;
      }
      throw error;
    } finally {
      options.createJobRegistry.finish(jobId);
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/create/agents/save") {
    const payload = await readJsonBody(req);
    const body = parseSaveAgentPersonaBody(payload);
    try {
      const result = await publishAgent(options, body.agentName, savePersona, {
        repoRoot: options.repoRootPath,
        agentName: body.agentName,
        personaMarkdown: body.personaMarkdown,
      });
      writeJson(res, 200, result);
    } catch (error) {
      writeRouteError(res, 400, error);
    }
    return true;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/create/agents/package/add"
  ) {
    const payload = await readJsonBody(req);
    const body = parseAgentPackageAddBody(payload);
    try {
      const agent = await publishAgent(options, body.agentName, addAgentPackageFiles, {
        repoRoot: options.repoRootPath,
        agentName: body.agentName,
        kind: body.kind,
        files: body.files,
      });
      writeJson(res, 200, agent);
    } catch (error) {
      writeRouteError(res, 400, error);
    }
    return true;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/create/agents/package/import-preview"
  ) {
    const payload = await readJsonBody(req);
    const body = parseAgentPackageImportBody(payload);
    try {
      const result = previewAgentPackageImport({
        repoRoot: options.repoRootPath,
        agentName: body.agentName,
        preferredKind: body.preferredKind,
        files: body.files,
      });
      writeJson(res, 200, result);
    } catch (error) {
      writeRouteError(res, 400, error);
    }
    return true;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/create/agents/package/import"
  ) {
    const payload = await readJsonBody(req);
    const body = parseAgentPackageImportBody(payload);
    try {
      const agent = await publishAgent(options, body.agentName, commitAgentPackageImport, {
        repoRoot: options.repoRootPath,
        agentName: body.agentName,
        preferredKind: body.preferredKind,
        files: body.files,
        choices: body.choices ?? [],
      });
      writeJson(res, 200, agent);
    } catch (error) {
      writeRouteError(res, 400, error);
    }
    return true;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/create/agents/package/remove"
  ) {
    const payload = await readJsonBody(req);
    const body = parseAgentPackageRemoveBody(payload);
    try {
      const agent = await publishAgent(options, body.agentName, removeAgentPackageItem, {
        repoRoot: options.repoRootPath,
        agentName: body.agentName,
        kind: body.kind,
        agentPath: body.agentPath,
        mode: body.mode,
      });
      writeJson(res, 200, agent);
    } catch (error) {
      writeRouteError(res, 400, error);
    }
    return true;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/create/agents/add-to-team"
  ) {
    const payload = await readJsonBody(req);
    const body = parseAddAgentToTeamBody(payload);
    const expectedRevision = parseTeamRevision(payload);
    try {
      const result = await publishResourceMutation(options.resourceLibraryService, () => addAgentToTeam({
        repoRoot: options.repoRootPath,
        agentName: body.agentName,
        teamId: body.teamId,
        ...whenDefined(body.role, (definedValue) => ({ role: definedValue })),
        expectedRevision,
      }));
      writeJson(res, 200, result);
    } catch (error) {
      // The same refusal the Team Builder gives, so either page can redraw
      // the team from it.
      if (error instanceof TeamRevisionConflictError) {
        writeTeamRevisionConflict(res, options.repoRootPath, error.teamId);
      } else {
        writeRouteError(res, 400, error);
      }
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/create/agents/delete") {
    const payload = await readJsonBody(req);
    const body = parseDeleteAgentRequestBody(payload);
    try {
      const result = await publishAgentDeletion(options, body.agentName, deleteAgent, {
        repoRoot: options.repoRootPath,
        agentName: body.agentName,
        deleteSkills: body.deleteSkills,
      });
      await options.mcpAgentGrantsService?.deleteAgentGrants(body.agentName);
      writeJson(res, 200, result);
    } catch (error) {
      writeRouteError(res, 400, error);
    }
    return true;
  }

  const agentDeletePreviewMatch = url.pathname.match(
    /^\/create\/agents\/([^/]+)\/delete-preview$/,
  );
  if (req.method === "GET" && agentDeletePreviewMatch) {
    const agentName = decodeURIComponent(agentDeletePreviewMatch[1] ?? "");
    try {
      const preview = previewAgentDelete(options.repoRootPath, agentName);
      writeJson(res, 200, preview);
    } catch (error) {
      writeRouteError(res, 404, error);
    }
    return true;
  }

  const agentReadMatch = url.pathname.match(/^\/create\/agents\/([^/]+)$/);
  if (req.method === "DELETE" && agentReadMatch) {
    const agentName = decodeURIComponent(agentReadMatch[1] ?? "");
    const payload = await readJsonBody(req);
    const body = parseDeleteAgentBody(payload);
    try {
      const result = await publishAgentDeletion(options, agentName, deleteAgent, {
        repoRoot: options.repoRootPath,
        agentName,
        deleteSkills: body.deleteSkills,
      });
      await options.mcpAgentGrantsService?.deleteAgentGrants(agentName);
      writeJson(res, 200, result);
    } catch (error) {
      writeRouteError(res, 400, error);
    }
    return true;
  }

  if (req.method === "GET" && agentReadMatch) {
    const agentName = decodeURIComponent(agentReadMatch[1] ?? "");
    try {
      const agent = readAgentDetail(options.repoRootPath, agentName);
      writeJson(res, 200, { agentName, ...agent });
    } catch (error) {
      writeRouteError(res, 404, error);
    }
    return true;
  }

  return false;
}

async function publishAgent<TParams, TResult>(
  options: AgentRoutesOptions,
  agentName: string,
  writer: (params: TParams) => Promise<TResult>,
  params: TParams,
): Promise<TResult> {
  return options.resourceLibraryService?.publishAgent(agentName, () => writer(params)) ??
    writer(params);
}

async function publishAgentDeletion<TParams, TResult>(
  options: AgentRoutesOptions,
  agentName: string,
  writer: (params: TParams) => Promise<TResult>,
  params: TParams,
): Promise<TResult> {
  return options.resourceLibraryService?.deleteAgentPublication(agentName, () => writer(params)) ??
    writer(params);
}

function writeRouteError(
  res: http.ServerResponse,
  statusCode: number,
  error: unknown,
): void {
  writeJson(res, statusCode, {
    error: error instanceof Error ? error.message : String(error),
  });
}

function parseAgentHealthBody(payload: unknown): {
  agentNames?: string[];
  targets?: AgentProviderHealthTarget[];
} {
  return parseServiceRequest(agentHealthRequestSchema, payload);
}
