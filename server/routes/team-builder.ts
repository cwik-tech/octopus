import { publishResourceMutation } from "../../contracts/resource-publication.js";
import type { ResourceLibraryService } from "../../services/resource-library-service.js";
import type * as http from "node:http";
import { URL } from "node:url";

import type { ProviderFailureHealthService } from "../../services/provider-failure-health-service.js";
import { ServiceError } from "../../services/service-errors.js";
import {
  addTeamBuilderTeamAgent,
  createTeamBuilderTeamDetail,
  deleteTeamBuilderTeamById,
  listTeamBuilderTeamSummaries,
  parseTeamBuilderAgentBody,
  parseTeamBuilderBody,
  parseTeamRevision,
  changeSavedTeamShapeDetail,
  readTeamBuilderTeamDetail,
  removeTeamBuilderTeamAgent,
  updateTeamBuilderTeamDetail,
} from "../../services/team-builder-service.js";
import {
  readJsonBody,
  writeJson,
  writeServiceError,
} from "../http.js";
import type { TeamBuilderDetail } from "../../contracts/agent-generator.js";
import { teamShapeSchema } from "../../contracts/schemas/team-shape.js";
import {
  TeamRevisionConflictError,
  TeamShapeNotEditableError,
  TeamShapeRosterError,
} from "../../domains/agent-generator/team-manager.js";

export interface TeamBuilderRoutesOptions {
  repoRootPath: string;
  resourceLibraryService?: ResourceLibraryService;
  /**
   * What runs have discovered about each provider.
   *
   * Team health is otherwise entirely static — it reads files and environment
   * keys and never calls a provider — so this is the only way a Team badge can
   * know that a key its members share stopped working during a run.
   */
  providerFailureHealth?: Pick<ProviderFailureHealthService, "read">;
}

export async function handleTeamBuilderRoutes(params: Parameters<typeof handleTeamBuilderRoutesWithoutReadLock>[0]): Promise<boolean> {
  if (params.req.method === 'GET' && params.options.resourceLibraryService) {
    return params.options.resourceLibraryService.withResourceRead(() => handleTeamBuilderRoutesWithoutReadLock(params));
  }
  return handleTeamBuilderRoutesWithoutReadLock(params);
}

async function handleTeamBuilderRoutesWithoutReadLock(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  options: TeamBuilderRoutesOptions;
}): Promise<boolean> {
  const { req, res, url, options } = params;

  try {
    if (req.method === "GET" && url.pathname === "/create/team-builder/teams") {
      const teams = listTeamBuilderTeamSummaries(options.repoRootPath, {
        providerFailures: options.providerFailureHealth?.read(),
      });
      writeJson(res, 200, { teams });
      return true;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/create/team-builder/teams"
    ) {
      const payload = await readJsonBody(req);
      const input = parseTeamBuilderBody(payload);
      const team = await publishResourceMutation(options.resourceLibraryService, () => createTeamBuilderTeamDetail({
        repoRootPath: options.repoRootPath,
        input,
      }));
      writeJson(res, 201, { team });
      return true;
    }

    const teamMatch = url.pathname.match(
      /^\/create\/team-builder\/teams\/([^/]+)$/,
    );
    if (teamMatch) {
      const teamId = decodeURIComponent(teamMatch[1] ?? "");
      if (req.method === "GET") {
        const team = readTeamBuilderTeamDetail({
          repoRootPath: options.repoRootPath,
          teamId,
        });
        writeJson(res, 200, { team });
        return true;
      }

      if (req.method === "PUT") {
        const payload = await readJsonBody(req);
        const input = parseTeamBuilderBody(payload);
        const team = await publishResourceMutation(options.resourceLibraryService, () => updateTeamBuilderTeamDetail({
          repoRootPath: options.repoRootPath,
          teamId,
          input,
          expectedRevision: parseTeamRevision(payload),
        }));
        writeJson(res, 200, { team });
        return true;
      }

      if (req.method === "DELETE") {
        await publishResourceMutation(options.resourceLibraryService, () => deleteTeamBuilderTeamById({
          repoRootPath: options.repoRootPath,
          teamId,
          expectedRevision: parseTeamRevision(revisionQuery(url)),
        }));
        writeJson(res, 200, { deleted: true });
        return true;
      }
    }

    const shapeMatch = url.pathname.match(
      /^\/create\/team-builder\/teams\/([^/]+)\/shape$/,
    );
    if (req.method === "POST" && shapeMatch) {
      const teamId = decodeURIComponent(shapeMatch[1] ?? "");
      const payload = await readJsonBody(req);
      const fields = payload && typeof payload === "object"
        ? payload as Record<string, unknown>
        : {};
      const parsedShape = teamShapeSchema.safeParse(fields.shape);
      if (!parsedShape.success) {
        writeJson(res, 422, {
          error: "invalid_shape",
          reason: "That is not a way a team can work together.",
        });
        return true;
      }
      if (typeof fields.expectedRevision !== "string") {
        writeJson(res, 400, {
          error: "missing_revision",
          reason: "A change has to say which version of the team it was written against.",
        });
        return true;
      }
      const expectedRevision = fields.expectedRevision;
      try {
        const team = await publishResourceMutation(options.resourceLibraryService, () => changeSavedTeamShapeDetail({
          repoRootPath: options.repoRootPath,
          teamId,
          shape: parsedShape.data,
          expectedRevision,
        }));
        writeJson(res, 200, { team });
      } catch (error) {
        // Three states of the team, each answered as a state rather than as a
        // generic failure: the card has something to say about every one.
        if (error instanceof TeamRevisionConflictError) {
          writeTeamRevisionConflict(res, options.repoRootPath, teamId);
          return true;
        }
        if (error instanceof TeamShapeNotEditableError) {
          writeJson(res, 422, { error: "shape_not_editable", reason: error.message });
          return true;
        }
        if (error instanceof TeamShapeRosterError) {
          writeJson(res, 422, { error: "invalid_shape", reason: error.message });
          return true;
        }
        throw error;
      }
      return true;
    }

    const agentAddMatch = url.pathname.match(
      /^\/create\/team-builder\/teams\/([^/]+)\/agents$/,
    );
    if (req.method === "POST" && agentAddMatch) {
      const teamId = decodeURIComponent(agentAddMatch[1] ?? "");
      const payload = await readJsonBody(req);
      const input = parseTeamBuilderAgentBody(payload);
      const team = await publishResourceMutation(options.resourceLibraryService, () => addTeamBuilderTeamAgent({
        repoRootPath: options.repoRootPath,
        teamId,
        input,
        expectedRevision: parseTeamRevision(payload),
      }));
      writeJson(res, 200, { team });
      return true;
    }

    const agentDeleteMatch = url.pathname.match(
      /^\/create\/team-builder\/teams\/([^/]+)\/agents\/([^/]+)$/,
    );
    if (req.method === "DELETE" && agentDeleteMatch) {
      const teamId = decodeURIComponent(agentDeleteMatch[1] ?? "");
      const agentName = decodeURIComponent(agentDeleteMatch[2] ?? "");
      const team = await publishResourceMutation(options.resourceLibraryService, () => removeTeamBuilderTeamAgent({
        repoRootPath: options.repoRootPath,
        teamId,
        agentName,
        expectedRevision: parseTeamRevision(revisionQuery(url)),
      }));
      writeJson(res, 200, { team });
      return true;
    }
  } catch (error) {
    if (error instanceof TeamRevisionConflictError) {
      writeTeamRevisionConflict(res, options.repoRootPath, error.teamId);
      return true;
    }
    if (error instanceof ServiceError) {
      writeServiceError(res, error);
      return true;
    }
    throw error;
  }

  return false;
}

/**
 * The revision a DELETE names, which has no body to carry it.
 *
 * An absent parameter is a caller that asked for no check; an empty one is
 * handed on as it is, so it is refused rather than read as absent.
 */
function revisionQuery(url: URL): { expectedRevision?: string } {
  const expectedRevision = url.searchParams.get("expectedRevision");
  return expectedRevision === null ? {} : { expectedRevision };
}

/**
 * Answers a team write made against a revision the team has moved on from.
 *
 * The team as it now stands travels with the refusal, so the editor redraws
 * from what is there instead of asking the user to reopen it and work out what
 * changed. A team that has since become unreadable (another editor deleted it,
 * say) is answered the way a fresh read of it would be.
 */
export function writeTeamRevisionConflict(
  res: http.ServerResponse,
  repoRootPath: string,
  teamId: string,
): void {
  let team: TeamBuilderDetail;
  try {
    team = readTeamBuilderTeamDetail({ repoRootPath, teamId });
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    writeServiceError(res, error);
    return;
  }
  writeJson(res, 409, {
    error: "team_revision_conflict",
    reason: "Someone changed this team. This is how it stands now.",
    team,
  });
}
