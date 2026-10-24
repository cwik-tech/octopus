import { whenDefined } from "../../core/optional-properties.js"
import {
  createTeamBuilderTeam,
  listTeamBuilderTeams,
  readTeamBuilderTeam,
} from "../agent-generator/index.js";
import type { TeamCreatePersistenceBoundary } from "../agent-generator/team-manager.js";
import type { TeamBuilderDetail } from "../../contracts/agent-generator.js";
import type { ResourceTeamPlan } from "../../contracts/resource-architect.js";
import { parseYaml, type YamlObject } from "../../core/yaml-parser.js";
import {
  applyTeamBuilderShape,
  isTeamBuilding,
} from "../agent-generator/team-manager.js";
import { depthRounds, type TeamShape } from "../../contracts/schemas/team-shape.js";

export async function createTeamBuildShell(params: {
  repoRoot: string;
  plan: ResourceTeamPlan;
  orchestratorKey?: string;
  signal?: AbortSignal;
  onTeamPersistenceBoundary?: (
    boundary: TeamCreatePersistenceBoundary,
  ) => void | Promise<void>;
}): Promise<TeamBuilderDetail> {
  throwIfAborted(params.signal);
  const baseId = slugify(params.plan.teamId || "generated-team", "generated-team");
  if (params.orchestratorKey) {
    const existing = listTeamBuilderTeams(params.repoRoot).find(
      (team) => team.id === baseId,
    );
    if (existing) {
      const detail = readTeamBuilderTeam(params.repoRoot, baseId);
      if (teamOrchestratorKey(detail.yaml) !== params.orchestratorKey) {
        throw new Error(`Team already exists: ${baseId}`);
      }
      // A published team is finished and may already be running. Reconciliation
      // exists to let a retry complete a shell a previous attempt left
      // half-built, and rewriting a finished team's stage from a plan would
      // change what it does with nobody asking.
      if (!isTeamBuilding(params.repoRoot, detail.id)) {
        throw new Error(
          `Team '${detail.id}' has already been built. Change it from the team ` +
            `editor, or create a new one.`,
        );
      }
      // A failed build leaves this shell behind, and the user may have changed
      // the shape before pressing Retry. Handing the shell back unchanged
      // would build the old shape and silently ignore an amendment the
      // endpoint accepted, so the shell is reconciled to what the plan now
      // says. A retry that changed nothing rewrites nothing.
      return reconcileShellShape({
        repoRoot: params.repoRoot,
        detail,
        ...whenDefined(params.plan.shape, (definedValue) => ({ shape: definedValue })),
      });
    }
  }
  // The model that writes a team is not the model its members run with, so no
  // runtime setting is derived from the authoring selection here.
  return createTeamBuilderTeam(
    params.repoRoot,
    {
      id: params.orchestratorKey
        ? baseId
        : nextAvailableTeamId(params.repoRoot, params.plan.teamId),
      description: params.plan.description,
      tags: Array.from(new Set(params.plan.tags)),
      ...whenDefined(params.orchestratorKey, (definedValue) => ({ orchestratorKey: definedValue })),
      // The shape the user was shown and agreed to. Dropping it here is how a
      // chosen discussion silently becomes a chain.
      ...whenDefined(params.plan.shape, (definedValue) => ({ shape: definedValue })),
      // Unpublished until the build says otherwise. A shell whose roster is
      // half-assembled, or whose stage names members that do not exist yet, is
      // not a team anyone can launch — offering it produces a failure the user
      // did not cause.
      building: true,
    },
    { ...whenDefined(params.onTeamPersistenceBoundary, (definedValue) => ({ onPersistenceBoundary: definedValue })) },
  );
}

function teamOrchestratorKey(yaml: string): string | undefined {
  const raw = parseYaml(yaml);
  const team = raw.team as YamlObject | undefined;
  return typeof team?.created_by_orchestrator === "string"
    ? team.created_by_orchestrator
    : undefined;
}

function nextAvailableTeamId(repoRoot: string, baseId: string): string {
  const reserved = new Set(listTeamBuilderTeams(repoRoot).map((team) => team.id));
  const base = slugify(baseId || "generated-team", "generated-team");
  if (!reserved.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!reserved.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 44)
    .replace(/-+$/g, "");
  return slug || fallback;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

/**
 * Brings an owned shell's stage back in line with the plan it is built from.
 *
 * Only the stage is touched, and only when the plan asks for something the file
 * does not already say. The roster and every other byte are left alone: the
 * members added so far belong to the build in progress, and the plan's shape
 * was already checked against the roster it describes.
 */
async function reconcileShellShape(params: {
  repoRoot: string;
  detail: TeamBuilderDetail;
  shape?: TeamShape;
}): Promise<TeamBuilderDetail> {
  if (!params.shape) return params.detail;
  if (shapeMatchesStage(params.detail.yaml, params.shape)) return params.detail;
  return applyTeamBuilderShape({
    repoRoot: params.repoRoot,
    teamId: params.detail.id,
    shape: params.shape,
  });
}

/**
 * Whether the saved stage already runs exactly this shape.
 *
 * Every field compared is executable. The order a chain runs in and the order a
 * discussion speaks in both change what the team produces, and the depth is the
 * round ceiling the engine loops to. Comparing only the kind and the role names
 * accepted an amendment and then rebuilt the previous arrangement.
 */
function shapeMatchesStage(yaml: string, shape: TeamShape): boolean {
  const raw = parseYaml(yaml);
  const levels = Array.isArray(raw.levels) ? raw.levels : [];
  const level = levels[0];
  if (!isYamlObject(level) || !isYamlObject(level.stage)) return false;
  const stage = level.stage;
  if (stage.type !== shape.kind) return false;
  const config = isYamlObject(stage.config) ? stage.config : {};
  const { rounds } = depthRounds(shape.depth);

  if (shape.kind === "chain") {
    // Depth is not written for a chain and the engine runs the sequence once,
    // so there is no round ceiling to compare.
    return sameOrder(stage.sequence, shape.order);
  }
  if (shape.kind === "discussion") {
    return (
      stage.coordinator === shape.coordinator &&
      sameOrder(stage.participants, shape.participants) &&
      config.max_rounds === rounds
    );
  }
  return (
    stage.producer === shape.producer &&
    stage.reviewer === shape.reviewer &&
    config.max_iterations === rounds
  );
}

/** Whether a saved list is the same names in the same order. */
function sameOrder(saved: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(saved) || saved.length !== expected.length) return false;
  return saved.every((name, index) => name === expected[index]);
}

function isYamlObject(value: unknown): value is YamlObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
