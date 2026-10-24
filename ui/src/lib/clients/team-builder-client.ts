import type {
  TeamBuilderDetail,
  TeamBuilderHealth,
  TeamBuilderInput,
  TeamBuilderSummary,
  LegacyTeamModelSettings,
  TeamRosterAgent,
  TeamRosterAgentRuntime,
} from "@/lib/models/team-builder-model";
import { getApiBaseUrl } from "@/lib/utils/desktop";
import {
  teamShapeSchema,
  type TeamShape,
} from "@contracts/schemas/team-shape";

const API_BASE = getApiBaseUrl();
let cachedTeamBuilderTeamsRequest: Promise<TeamBuilderSummary[]> | undefined;
const teamCatalogListeners = new Set<() => void>();

function toUrl(path: string): string {
  return `${API_BASE}${path}`;
}

async function expectOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  const fallback = `${response.status} ${response.statusText}`;
  let message: string;
  try {
    const payload: unknown = await response.json();
    message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : fallback;
  } catch (error) {
    throw new Error(fallback, { cause: error });
  }
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A team write refused because the team changed since it was loaded.
 *
 * Carries the server's own words and the team as it now stands, so the editor
 * can say what happened and redraw from what is there.
 */
export class TeamRevisionConflictError extends Error {
  readonly team: TeamBuilderDetail;

  constructor(message: string, team: TeamBuilderDetail) {
    super(message);
    this.name = "TeamRevisionConflictError";
    this.team = team;
  }
}

/**
 * `expectOk` for a write to a team, which also recognises the refusal of a
 * write made against a revision the team has moved on from.
 */
async function expectTeamWriteOk(response: Response): Promise<Response> {
  if (response.status !== 409) return expectOk(response);
  const payload: unknown = await response.json().catch(() => null);
  if (
    isRecord(payload) &&
    payload.error === "team_revision_conflict" &&
    typeof payload.reason === "string" &&
    payload.team !== undefined
  ) {
    const team = parseTeamBuilderDetail(payload.team);
    // The refusal proves every list read before it stale for this team.
    invalidateTeamBuilderTeamsCache();
    throw new TeamRevisionConflictError(payload.reason, team);
  }
  throw new Error(
    isRecord(payload) && typeof payload.error === "string"
      ? payload.error
      : `${response.status} ${response.statusText}`,
  );
}

/** The revision a DELETE names, which has no body to carry it. */
function revisionQuery(expectedRevision: string | undefined): string {
  return expectedRevision === undefined
    ? ""
    : `?expectedRevision=${encodeURIComponent(expectedRevision)}`;
}

function parseTeamBuilderSummary(value: unknown): TeamBuilderSummary {
  const health = isRecord(value) ? parseTeamBuilderHealth(value.health) : null;
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !Array.isArray(value.tags) ||
    !value.tags.every((tag) => typeof tag === "string") ||
    typeof value.agentCount !== "number" ||
    !Number.isInteger(value.agentCount) ||
    value.agentCount < 0 ||
    health === null ||
    (value.agentNames !== undefined &&
      (!Array.isArray(value.agentNames) ||
        !value.agentNames.every((name) => typeof name === "string"))) ||
    (value.description !== undefined &&
      typeof value.description !== "string") ||
    (value.entryStageType !== undefined &&
      typeof value.entryStageType !== "string") ||
    (value.discussionCoordinator !== undefined &&
      typeof value.discussionCoordinator !== "string") ||
    (value.legacyDefaultProvider !== undefined &&
      typeof value.legacyDefaultProvider !== "string") ||
    (value.agents !== undefined && !isRosterAgentList(value.agents)) ||
    (value.legacyModels !== undefined && !isLegacyModelsByTier(value.legacyModels)) ||
    (value.userInvocable !== undefined &&
      typeof value.userInvocable !== "boolean") ||
    // Held to the detail's rule: a revision that is present is a non-empty
    // string, or the row is refused rather than sent back as a bad check.
    (value.revision !== undefined &&
      (typeof value.revision !== "string" || value.revision.length === 0))
  ) {
    throw new Error("Invalid Team catalog response");
  }
  return {
    id: value.id,
    name: value.name,
    tags: value.tags,
    agentCount: value.agentCount,
    health,
    // The revision of the file this row was read from, so a delete made from
    // the row can name the version the person saw.
    ...(value.revision === undefined ? {} : { revision: value.revision }),
    ...(value.agentNames === undefined ? {} : { agentNames: value.agentNames }),
    ...(value.description === undefined
      ? {}
      : { description: value.description }),
    ...(value.entryStageType === undefined
      ? {}
      : { entryStageType: value.entryStageType }),
    ...(value.discussionCoordinator === undefined
      ? {}
      : { discussionCoordinator: value.discussionCoordinator }),
    ...(value.agents === undefined ? {} : { agents: value.agents }),
    ...(value.legacyModels === undefined
      ? {}
      : { legacyModels: value.legacyModels }),
    ...(value.legacyDefaultProvider === undefined
      ? {}
      : { legacyDefaultProvider: value.legacyDefaultProvider }),
    ...(value.userInvocable === undefined
      ? {}
      : { userInvocable: value.userInvocable }),
  };
}

function parseTeamBuilderHealth(value: unknown): TeamBuilderHealth | null {
  if (
    !isRecord(value) ||
    (value.status !== "ok" &&
      value.status !== "warning" &&
      value.status !== "error") ||
    !Array.isArray(value.errors) ||
    !value.errors.every((message) => typeof message === "string") ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every((message) => typeof message === "string")
  ) {
    return null;
  }
  const statusMatchesDiagnostics =
    (value.status === "error" && value.errors.length > 0) ||
    (value.status === "warning" &&
      value.errors.length === 0 &&
      value.warnings.length > 0) ||
    (value.status === "ok" &&
      value.errors.length === 0 &&
      value.warnings.length === 0);
  if (!statusMatchesDiagnostics) return null;
  return {
    status: value.status,
    errors: value.errors,
    warnings: value.warnings,
  };
}

/**
 * The roster entries the catalog carries for the Run sidebar.
 *
 * Proves every field of `TeamRosterAgentRuntime` and claims nothing more. The
 * full roster contract has other fields, and a guard that narrowed to it while
 * checking only these would hand callers a type the payload never earned.
 */
function isRosterAgentList(value: unknown): value is TeamRosterAgentRuntime[] {
  return (
    Array.isArray(value) &&
    value.every(
      (agent) =>
        isRecord(agent) &&
        typeof agent.name === "string" &&
        // Optional, not required. Authoring writes no grade, so a Team created
        // now has none anywhere on its roster; demanding one would make the
        // client reject the server's own valid answer. A grade that *is* there
        // still has to be a string, so a wrong one is not waved through.
        isOptionalString(agent.tier) &&
        (agent.type === "agent" || agent.type === "team") &&
        isOptionalString(agent.personaProvider) &&
        isOptionalString(agent.personaModel),
    )
  );
}

function isTeamRosterAgentList(value: unknown): value is TeamRosterAgent[] {
  return (
    Array.isArray(value) &&
    value.every(
      (agent) =>
        isRecord(agent) &&
        typeof agent.name === "string" &&
        (agent.type === "agent" || agent.type === "team") &&
        typeof agent.role === "string" &&
        isOptionalString(agent.tier) &&
        isStringList(agent.tools) &&
        typeof agent.referenced === "boolean" &&
        isOptionalString(agent.agent_file) &&
        isOptionalString(agent.legacyModel) &&
        isOptionalString(agent.legacyProvider) &&
        isOptionalString(agent.personaProvider) &&
        isOptionalString(agent.personaModel) &&
        isOptionalBoolean(agent.personaMissing) &&
        isOptionalBoolean(agent.experience_enabled) &&
        isOptionalArtifactList(agent.produces) &&
        isOptionalArtifactList(agent.consumes),
    )
  );
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isOptionalArtifactList(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (artifact) =>
          isRecord(artifact) &&
          typeof artifact.path === "string" &&
          isOptionalString(artifact.description),
      ))
  );
}

function isLegacyModelsByTier(
  value: unknown,
): value is Record<string, LegacyTeamModelSettings> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (tier) =>
        isRecord(tier) &&
        typeof tier.model === "string" &&
        typeof tier.thinking === "string" &&
        isOptionalString(tier.provider),
    )
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/** How long a shape change may take before it is given up on. */
const SHAPE_CHANGE_TIMEOUT_MS = 15_000;

/**
 * Changes how a saved team works together.
 *
 * Written against the revision the editor was showing, so a change made from a
 * stale view fails instead of overwriting whoever wrote first. The refusals are
 * states of the team rather than faults in the shape, so they come back as
 * answers the editor can put on screen.
 */
export async function changeSavedTeamShape(input: {
  teamId: string;
  shape: TeamShape;
  expectedRevision: string;
  /** The caller's own cancellation, when it has one to give. */
  signal?: AbortSignal;
}): Promise<
  | { ok: true; team: TeamBuilderDetail }
  /**
   * Refused, with the team as it now stands when the server could say.
   *
   * A conflict is the one refusal where the editor has something to do: redraw
   * from what is there. Telling the user to reopen it themselves leaves them to
   * work out what changed.
   */
  | { ok: false; message: string; team?: TeamBuilderDetail }
> {
  const response = await fetch(
    `${API_BASE}/create/team-builder/teams/${encodeURIComponent(input.teamId)}/shape`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shape: input.shape,
        expectedRevision: input.expectedRevision,
      }),
      // Bounded, and cancellable by the caller. Either ends it: without the
      // deadline a server that accepts and never answers leaves the editor
      // "being changed" until a reload, and without the caller's signal an
      // editor that has moved to another team cannot let go.
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(SHAPE_CHANGE_TIMEOUT_MS)])
        : AbortSignal.timeout(SHAPE_CHANGE_TIMEOUT_MS),
    },
  );
  const payload: unknown = await response.json().catch(() => null);
  const body = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  if (response.ok) return { ok: true, team: parseTeamBuilderDetail(body.team) };
  if (typeof body.reason === "string") {
    return {
      ok: false,
      message: body.reason,
      ...(body.team === undefined
        ? {}
        : { team: parseTeamBuilderDetail(body.team) }),
    };
  }
  throw new Error(`${response.status} ${response.statusText}`);
}

export async function listTeamBuilderTeams(options?: {
  signal?: AbortSignal;
}): Promise<TeamBuilderSummary[]> {
  const response = await expectOk(
    await fetch(
      toUrl("/create/team-builder/teams"),
      options?.signal ? { signal: options.signal } : undefined,
    ),
  );
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.teams)) {
    throw new Error("Invalid Team catalog response");
  }
  return payload.teams.map(parseTeamBuilderSummary);
}

export function listCachedTeamBuilderTeams(): Promise<TeamBuilderSummary[]> {
  if (cachedTeamBuilderTeamsRequest) return cachedTeamBuilderTeamsRequest;
  const request = listTeamBuilderTeams();
  cachedTeamBuilderTeamsRequest = request;
  return request.then(
    (teams) => {
      if (cachedTeamBuilderTeamsRequest === request) {
        cachedTeamBuilderTeamsRequest = undefined;
      }
      return teams;
    },
    (error: unknown) => {
      if (cachedTeamBuilderTeamsRequest === request) {
        cachedTeamBuilderTeamsRequest = undefined;
      }
      throw error;
    },
  );
}

/**
 * Watch for team-catalog changes.
 *
 * Teams can appear without this module creating them — the Agent and Team
 * Architect builds them server-side — so long-lived readers such as the Run
 * tab subscribe instead of fetching once on mount and going stale.
 */
export function subscribeToTeamBuilderTeams(listener: () => void): () => void {
  teamCatalogListeners.add(listener);
  return () => {
    teamCatalogListeners.delete(listener);
  };
}

export function invalidateTeamBuilderTeamsCache(): void {
  cachedTeamBuilderTeamsRequest = undefined;
  for (const listener of [...teamCatalogListeners]) listener();
}

function parseTeamBuilderDetail(value: unknown): TeamBuilderDetail {
  let summary: TeamBuilderSummary;
  try {
    summary = parseTeamBuilderSummary(value);
  } catch (error) {
    throw new Error("Invalid Team detail response", { cause: error });
  }
  if (
    !isRecord(value) ||
    typeof value.teamPath !== "string" ||
    typeof value.yaml !== "string" ||
    typeof value.revision !== "string" ||
    value.revision.length === 0 ||
    !isTeamRosterAgentList(value.agents) ||
    !isStringList(value.warnings)
  ) {
    throw new Error("Invalid Team detail response");
  }
  // Absent means this app did not write the team, which is a state the editor
  // acts on. Present and not a shape is refused rather than dropped: the editor
  // would otherwise offer to rewrite a file it could not read.
  const shape = value.shape === undefined
    ? undefined
    : teamShapeSchema.safeParse(value.shape);
  if (shape && !shape.success) throw new Error("Invalid Team detail response");
  return {
    ...summary,
    teamPath: value.teamPath,
    yaml: value.yaml,
    revision: value.revision,
    ...(shape?.success ? { shape: shape.data } : {}),
    agents: value.agents,
    warnings: value.warnings,
  };
}

async function readTeamBuilderDetailResponse(response: Response): Promise<TeamBuilderDetail> {
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error("Invalid Team detail response");
  return parseTeamBuilderDetail(payload.team);
}

export async function readTeamBuilderTeam(
  teamId: string,
): Promise<TeamBuilderDetail> {
  const response = await expectOk(
    await fetch(toUrl(`/create/team-builder/teams/${encodeURIComponent(teamId)}`)),
  );
  return readTeamBuilderDetailResponse(response);
}

export async function createTeamBuilderTeam(
  input: TeamBuilderInput,
): Promise<TeamBuilderDetail> {
  const response = await expectOk(
    await fetch(toUrl("/create/team-builder/teams"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  invalidateTeamBuilderTeamsCache();
  return readTeamBuilderDetailResponse(response);
}

/**
 * Saves a team's details.
 *
 * `expectedRevision` is the revision of the team the editor loaded; with it, a
 * save made from a stale view is refused with a `TeamRevisionConflictError`
 * instead of overwriting whoever wrote first. Every write below takes it the
 * same way.
 */
export async function updateTeamBuilderTeam(
  teamId: string,
  input: TeamBuilderInput,
  expectedRevision?: string | undefined,
): Promise<TeamBuilderDetail> {
  const response = await expectTeamWriteOk(
    await fetch(toUrl(`/create/team-builder/teams/${encodeURIComponent(teamId)}`), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        expectedRevision === undefined ? input : { ...input, expectedRevision },
      ),
    }),
  );
  invalidateTeamBuilderTeamsCache();
  return readTeamBuilderDetailResponse(response);
}

export async function deleteTeamBuilderTeam(
  teamId: string,
  expectedRevision?: string | undefined,
): Promise<void> {
  await expectTeamWriteOk(
    await fetch(
      toUrl(
        `/create/team-builder/teams/${encodeURIComponent(teamId)}${revisionQuery(expectedRevision)}`,
      ),
      { method: "DELETE" },
    ),
  );
  invalidateTeamBuilderTeamsCache();
}

export async function addTeamBuilderAgent(input: {
  teamId: string;
  agentName: string;
  role?: string;
  expectedRevision?: string | undefined;
}): Promise<TeamBuilderDetail> {
  const response = await expectTeamWriteOk(
    await fetch(
      toUrl(
        `/create/team-builder/teams/${encodeURIComponent(input.teamId)}/agents`,
      ),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentName: input.agentName,
          role: input.role,
          ...(input.expectedRevision === undefined
            ? {}
            : { expectedRevision: input.expectedRevision }),
        }),
      },
    ),
  );
  invalidateTeamBuilderTeamsCache();
  return readTeamBuilderDetailResponse(response);
}

export async function removeTeamBuilderAgent(input: {
  teamId: string;
  agentName: string;
  expectedRevision?: string | undefined;
}): Promise<TeamBuilderDetail> {
  const response = await expectTeamWriteOk(
    await fetch(
      toUrl(
        `/create/team-builder/teams/${encodeURIComponent(
          input.teamId,
        )}/agents/${encodeURIComponent(input.agentName)}${revisionQuery(input.expectedRevision)}`,
      ),
      { method: "DELETE" },
    ),
  );
  invalidateTeamBuilderTeamsCache();
  return readTeamBuilderDetailResponse(response);
}
