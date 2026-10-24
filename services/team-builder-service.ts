import {
  addTeamBuilderAgent,
  createTeamBuilderTeam,
  deleteTeamBuilderTeam,
  listAgents,
  isTeamBuilding,
  listPublishedTeams,
  readTeamBuilderTeam,
  removeTeamBuilderAgent,
  updateTeamBuilderTeam,
} from "../domains/agent-generator/index.js";
import type { TeamHealthRuntimeContext } from "../domains/agent-generator/index.js";
import { isSelectableAgent } from "../contracts/agent-generator.js";
import type {
  TeamBuilderDetail,
  TeamBuilderSummary,
  TeamBuilderUpsertInput,
} from "../contracts/agent-generator.js";
import {
  teamBuilderAgentRequestSchema,
  teamBuilderRequestSchema,
  teamRevisionRequestSchema,
} from "../contracts/schemas/builder-requests.js";
import {
  parseServiceRequest,
  ServiceError,
} from "./service-errors.js";
import {
  changeSavedTeamShape,
  TeamRevisionConflictError,
} from "../domains/agent-generator/team-manager.js";
import type { TeamShape } from "../contracts/schemas/team-shape.js";

/**
 * What a roster write may carry.
 *
 * A grade, a model and a provider are all refused at the request schema rather
 * than listed here: this type describes what the write actually uses, and a
 * field it advertised but ignored would read as an accepted setting.
 */
export interface TeamBuilderAgentInput {
  agentName: string;
  role?: string;
}

export function parseTeamBuilderBody(payload: unknown): TeamBuilderUpsertInput {
  return parseServiceRequest(teamBuilderRequestSchema, payload);
}

export function parseTeamBuilderAgentBody(
  payload: unknown,
): TeamBuilderAgentInput {
  return parseServiceRequest(teamBuilderAgentRequestSchema, payload);
}

/**
 * The revision a team write was made against, or undefined when it names none.
 *
 * `payload` is the write's JSON body, or for a DELETE an object built from its
 * query.
 */
export function parseTeamRevision(payload: unknown): string | undefined {
  return parseServiceRequest(teamRevisionRequestSchema, payload).expectedRevision;
}

export function listTeamBuilderTeamSummaries(
  repoRootPath: string,
  runtime: TeamHealthRuntimeContext = {},
): TeamBuilderSummary[] {
  // The published catalog, not the builder's own. A team whose build has not
  // finished is visible to the thing assembling it and to nobody else.
  return listPublishedTeams(repoRootPath, runtime);
}

/**
 * Changes how a saved team works together.
 *
 * Refused while a build still owns the team — an unfinished roster is not
 * something to rearrange — and refused for a team this app did not write, whose
 * file it has no business rewriting.
 */
export async function changeSavedTeamShapeDetail(params: {
  repoRootPath: string;
  teamId: string;
  shape: TeamShape;
  expectedRevision: string;
}): Promise<TeamBuilderDetail> {
  refuseWhileBuilding(params.repoRootPath, params.teamId);
  // Projected like every other answer about a team: a member the product keeps
  // out of the UI is written to the file and left out of what is returned, and
  // this was the one writer that answered with the roster raw.
  //
  // Only the success is wrapped. The refusals this operation raises — a
  // revision that moved, a team whose shape is not this app's to rewrite, a
  // shape that does not fit the roster — are typed, and the route answers each
  // with its own status. Putting them through the generic error mapping would
  // flatten all three into one.
  const team = await changeSavedTeamShape({
    repoRoot: params.repoRootPath,
    teamId: params.teamId,
    shape: params.shape,
    expectedRevision: params.expectedRevision,
  });
  return projectTeamDetailForUi(params.repoRootPath, team);
}

export function readTeamBuilderTeamDetail(params: {
  repoRootPath: string;
  teamId: string;
}): TeamBuilderDetail {
  return projectTeamDetailForUi(
    params.repoRootPath,
    mapTeamManagerError(() =>
      readTeamBuilderTeam(params.repoRootPath, params.teamId),
    ),
  );
}

/**
 * Refuses an ordinary product edit while a build owns the team.
 *
 * The roster and stage of a team being assembled belong to that build: it was
 * admitted to produce a particular roster and shape, and publication checks the
 * result against them. An edit from elsewhere would make that check fail, or
 * worse, pass against something nobody approved.
 *
 * Reads are untouched. The builder has to be able to show what it is
 * assembling.
 */
function refuseWhileBuilding(repoRootPath: string, teamId: string): void {
  if (!isTeamBuilding(repoRootPath, teamId)) return;
  throw new ServiceError(
    "conflict",
    `Team '${teamId}' is still being built. Wait for it to finish before changing it.`,
  );
}

export async function createTeamBuilderTeamDetail(params: {
  repoRootPath: string;
  input: TeamBuilderUpsertInput;
}): Promise<TeamBuilderDetail> {
  return mapTeamManagerError(() =>
    createTeamBuilderTeam(params.repoRootPath, params.input).then((team) =>
      projectTeamDetailForUi(params.repoRootPath, team),
    ),
  );
}

export async function updateTeamBuilderTeamDetail(params: {
  repoRootPath: string;
  teamId: string;
  input: TeamBuilderUpsertInput;
  expectedRevision?: string | undefined;
}): Promise<TeamBuilderDetail> {
  refuseWhileBuilding(params.repoRootPath, params.teamId);
  return mapTeamManagerError(() =>
    updateTeamBuilderTeam(params.repoRootPath, params.teamId, params.input, {
      expectedRevision: params.expectedRevision,
    }).then((team) => projectTeamDetailForUi(params.repoRootPath, team)),
  );
}

export async function deleteTeamBuilderTeamById(params: {
  repoRootPath: string;
  teamId: string;
  expectedRevision?: string | undefined;
}): Promise<void> {
  refuseWhileBuilding(params.repoRootPath, params.teamId);
  await mapTeamManagerError(() =>
    deleteTeamBuilderTeam(params.repoRootPath, params.teamId, {
      expectedRevision: params.expectedRevision,
    }),
  );
}

export async function addTeamBuilderTeamAgent(params: {
  repoRootPath: string;
  teamId: string;
  input: TeamBuilderAgentInput;
  expectedRevision?: string | undefined;
}): Promise<TeamBuilderDetail> {
  refuseWhileBuilding(params.repoRootPath, params.teamId);
  return mapTeamManagerError(() =>
    addTeamBuilderAgent({
      repoRoot: params.repoRootPath,
      teamId: params.teamId,
      ...params.input,
      expectedRevision: params.expectedRevision,
    }).then((team) => projectTeamDetailForUi(params.repoRootPath, team)),
  );
}

export async function removeTeamBuilderTeamAgent(params: {
  repoRootPath: string;
  teamId: string;
  agentName: string;
  expectedRevision?: string | undefined;
}): Promise<TeamBuilderDetail> {
  refuseWhileBuilding(params.repoRootPath, params.teamId);
  return mapTeamManagerError(() =>
    removeTeamBuilderAgent({
      repoRoot: params.repoRootPath,
      teamId: params.teamId,
      agentName: params.agentName,
      expectedRevision: params.expectedRevision,
    }).then((team) => projectTeamDetailForUi(params.repoRootPath, team)),
  );
}

function projectTeamDetailForUi(
  repoRootPath: string,
  team: TeamBuilderDetail,
): TeamBuilderDetail {
  const hiddenAgentNames = new Set(
    listAgents(repoRootPath)
      .filter((agent) => !isSelectableAgent(agent))
      .map((agent) => agent.name),
  );
  const agents = team.agents.filter(
    (agent) => agent.type === "team" || !hiddenAgentNames.has(agent.name),
  );
  return { ...team, agents, agentCount: agents.length };
}

function mapTeamManagerError<T>(operation: () => Promise<T>): Promise<T>;
function mapTeamManagerError<T>(operation: () => T): T;
function mapTeamManagerError<T>(operation: () => T | Promise<T>): T | Promise<T> {
  try {
    const result = operation();
    if (result instanceof Promise) {
      return result.catch((error: unknown) => {
        throw toTeamBuilderServiceError(error);
      });
    }
    return result;
  } catch (error) {
    throw toTeamBuilderServiceError(error);
  }
}

function toTeamBuilderServiceError(
  error: unknown,
): ServiceError | TeamRevisionConflictError {
  if (error instanceof ServiceError) return error;
  // Kept typed, so the route answers a write made against a revision the team
  // has moved on from with the team as it now stands, the way it answers a
  // shape change, instead of as one more bad request.
  if (error instanceof TeamRevisionConflictError) return error;
  return new ServiceError(
    "bad_request",
    error instanceof Error ? error.message : String(error),
  );
}
