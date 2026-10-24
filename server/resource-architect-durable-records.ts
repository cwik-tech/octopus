/**
 * Reads plans and build jobs back from disk without trusting what is there.
 *
 * A durable file outlives the process that wrote it. It can be from an older
 * shape of the contract, half-written by a machine that lost power, or edited
 * by hand. Reading one straight through would put a value into the store that
 * the type system believes and the code cannot use: a plan whose Agent has no
 * role, a job in a status nothing knows how to finish.
 *
 * Every record is therefore rebuilt field by field from `unknown`. A record
 * that cannot be rebuilt completely is refused, and refusing it is the whole
 * point: an unreadable file is not a partial record.
 */

import { readModelSelectionRecord } from "../contracts/agent-model-selection.js";
import { teamShapeSchema } from "../contracts/schemas/team-shape.js";
import { resourceArchitectFeedbackDiagnosticsSchema } from '../contracts/schemas/resource-architect-review.js';
import type {
  CreateResourceRef,
  ResourceArchitectTimingContext,
  ResourceArchitectTurnMetric,
  ResourceArchitectTurnMetricStatus,
  ResourceArchitectTurnOutcome,
  ResourceArchitectTurnTiming,
  ResourceBuildEvent,
  ResourceBuildEventType,
  ResourceBuildItem,
  ResourceBuildItemStatus,
  ResourceBuildJobSnapshot,
  ResourceBuildJobStatus,
  ResourcePlanAdmission,
  ResourceSkillUpdateIdentity,
  ResourceTeamDocumentDomain,
  ResourceTeamDocumentSpecialization,
} from "../contracts/resource-architect.js";
import type {
  PersistedPlannedAgentSpec,
  PersistedResourceArchitectPlan,
  PersistedResourceTeamAgentPlan,
  PersistedResourceTeamNewAgentPlan,
  PersistedResourceTeamPlan,
  PersistedResourceUpdateOperation,
} from "../contracts/resource-architect-persisted.js";
import {
  findResourceUpdatePlanViolation,
  findTeamAdditionStructureViolation,
} from "../domains/resource-architect/resource-update-policy.js";
import { findSkillUpdateStructureViolation } from "../domains/resource-architect/skill-update-rules.js";
import { validateExactAgentName } from "../domains/agent-generator/agent-name-rules.js";
import { THINKING_REQUEST_VALUES } from "../contracts/thinking-levels.js";
import { readLegacyRestartInterruption } from "../contracts/resource-build-recovery.js";
import {
  isResourceSkillUpdateEventType,
  RESOURCE_SKILL_UPDATE_EVENT_TYPES,
} from "../contracts/resource-architect.js";

const BUILD_ITEM_STATUSES: readonly ResourceBuildItemStatus[] = [
  "planned",
  "generating",
  "created",
  "reused",
  "updated",
  "needs_input",
  "interrupted",
  "failed",
  "cancelled",
];

const BUILD_JOB_STATUSES: readonly ResourceBuildJobStatus[] = [
  "running",
  "interrupted",
  "partially_completed",
  "completed",
  "failed",
  "cancelled",
];

const BUILD_EVENT_TYPES: readonly ResourceBuildEventType[] = [
  ...RESOURCE_SKILL_UPDATE_EVENT_TYPES,
  "build_started",
  "name_reserved",
  "agent_generating",
  "skill_repaired",
  "agent_created",
  "agent_reused",
  "agent_needs_input",
  "agent_failed",
  "agent_cancelled",
  "team_created",
  "agent_added",
  "team_renamed",
  "resource_update_started",
  "resource_update_applied",
  "resource_update_conflict",
  "resource_update_failed",
  "resource_update_cancelled",
  "build_completed",
  "build_partially_completed",
  "build_interrupted",
  "build_cancelled",
  "build_failed",
];

const TURN_METRIC_STATUSES: readonly ResourceArchitectTurnMetricStatus[] = [
  // A turn recorded before its provider answered. It is the only account of a
  // turn interrupted while running, so a reader that refuses it drops exactly
  // the record that exists to survive a crash.
  "running",
  "completed",
  "cancelled",
  "failed",
];

const TURN_OUTCOME_KINDS: readonly ResourceArchitectTurnOutcome["kind"][] = [
  "standalone_agents",
  "team",
  "resource_updates",
  "discussion",
  "edit_existing",
];

/**
 * One recorded turn, or `null` when the stored entry is not one.
 *
 * Every field the record carries is checked, including each number inside the
 * timing and its context. A guard that stopped at "timing is an object" would
 * pass an entry that throws the moment anything reads through it, and one such
 * entry in a file of two hundred would take the whole history with it.
 */
export function parseTurnMetricRecord(
  value: unknown,
): ResourceArchitectTurnMetric | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 1) return null;
  const recordedAt = requiredString(value.recordedAt);
  const jobId = requiredString(value.jobId);
  const operation = pick(value.operation, ["conversation", "proposal"] as const);
  const status = pick(value.status, TURN_METRIC_STATUSES);
  const timing = parseTurnTiming(value.timing);
  if (
    recordedAt === null ||
    jobId === null ||
    operation === null ||
    status === null ||
    timing === null ||
    typeof value.fallback !== "boolean"
  ) {
    return null;
  }
  const provider = nullableString(value.provider);
  const model = nullableString(value.model);
  if (provider === undefined || model === undefined) return null;
  const reasoning = nullableChoice(value.reasoning, THINKING_REQUEST_VALUES);
  const outcomeKind = nullableChoice(value.outcomeKind, TURN_OUTCOME_KINDS);
  if (reasoning === undefined || outcomeKind === undefined) return null;
  const errorCode = optionalString(value.errorCode);
  if (errorCode === null) return null;
  // A record read from disk is validated, not asserted. A selection that
  // cannot be read whole is dropped rather than half-shown: the metric is
  // still a useful timing record without it.
  const selection = readModelSelectionRecord(value.selection);
  const review = value.review === undefined ? undefined : resourceArchitectFeedbackDiagnosticsSchema.safeParse(value.review);
  if (review && !review.success) return null;
  return {
    schemaVersion: 1,
    recordedAt,
    jobId,
    operation,
    status,
    provider,
    model,
    ...(selection ? { selection } : {}),
    ...(review?.success ? { review: review.data } : {}),
    reasoning,
    outcomeKind,
    fallback: value.fallback,
    ...(errorCode === undefined ? {} : { errorCode }),
    timing,
  };
}

function parseTurnTiming(value: unknown): ResourceArchitectTurnTiming | null {
  if (!isRecord(value)) return null;
  const contextAssemblyMs = finiteNumber(value.contextAssemblyMs);
  const providerDurationMs = finiteNumber(value.providerDurationMs);
  const parseDurationMs = finiteNumber(value.parseDurationMs);
  const repairDurationMs = finiteNumber(value.repairDurationMs);
  const totalDurationMs = finiteNumber(value.totalDurationMs);
  const processSpawnMs = nullableNumber(value.processSpawnMs);
  const firstProviderEventMs = nullableNumber(value.firstProviderEventMs);
  const firstTextMs = nullableNumber(value.firstTextMs);
  const context = parseTimingContext(value.context);
  if (
    contextAssemblyMs === null ||
    providerDurationMs === null ||
    parseDurationMs === null ||
    repairDurationMs === null ||
    totalDurationMs === null ||
    processSpawnMs === undefined ||
    firstProviderEventMs === undefined ||
    firstTextMs === undefined ||
    context === null ||
    typeof value.repairOccurred !== "boolean"
  ) {
    return null;
  }
  return {
    contextAssemblyMs,
    providerDurationMs,
    processSpawnMs,
    firstProviderEventMs,
    firstTextMs,
    parseDurationMs,
    repairOccurred: value.repairOccurred,
    repairDurationMs,
    totalDurationMs,
    context,
  };
}

function parseTimingContext(value: unknown): ResourceArchitectTimingContext | null {
  if (!isRecord(value)) return null;
  const instructionsChars = finiteNumber(value.instructionsChars);
  const operationChars = finiteNumber(value.operationChars);
  const uploadedDocumentPolicyChars = finiteNumber(value.uploadedDocumentPolicyChars);
  const visualizationPolicyChars = finiteNumber(value.visualizationPolicyChars);
  const teamLibraryChars = finiteNumber(value.teamLibraryChars);
  const agentLibraryChars = finiteNumber(value.agentLibraryChars);
  const totalChars = finiteNumber(value.totalChars);
  const historyChars = finiteNumber(value.historyChars);
  if (
    instructionsChars === null ||
    operationChars === null ||
    uploadedDocumentPolicyChars === null ||
    visualizationPolicyChars === null ||
    teamLibraryChars === null ||
    agentLibraryChars === null ||
    totalChars === null ||
    historyChars === null
  ) {
    return null;
  }
  return {
    instructionsChars,
    operationChars,
    uploadedDocumentPolicyChars,
    visualizationPolicyChars,
    teamLibraryChars,
    agentLibraryChars,
    totalChars,
    historyChars,
  };
}

/** A persisted plan, or `null` when the file does not describe one. */
export function parseResourceArchitectPlanRecord(
  value: unknown,
): PersistedResourceArchitectPlan | null {
  if (!isRecord(value)) return null;
  const id = requiredString(value.id);
  if (id === null) return null;
  if (value.kind === "standalone_agents") {
    const agents = collect(value.agents, parsePlannedAgent);
    return agents === null ? null : { id, kind: "standalone_agents", agents };
  }
  if (value.kind === "team") {
    const team = parseTeamPlan(value.team);
    return team === null ? null : { id, kind: "team", team };
  }
  if (value.kind === "resource_updates") {
    const operations = collect(value.operations, parseUpdateOperation);
    if (operations === null || operations.length === 0) return null;
    // The same plan-wide rules the proposal boundary applies. A file that
    // breaks them reached the disk some other way, and running it would put two
    // writes with one revision against a Team, or generate one Agent identity
    // twice.
    if (findResourceUpdatePlanViolation(operations) !== null) return null;
    return { id, kind: "resource_updates", operations };
  }
  return null;
}

/** A persisted build job, or `null` when the file does not describe one. */
export function parseResourceBuildJobRecord(
  value: unknown,
): ResourceBuildJobSnapshot | null {
  if (!isRecord(value)) return null;
  const jobId = requiredString(value.jobId);
  const planId = requiredString(value.planId);
  const status = pick(value.status, BUILD_JOB_STATUSES);
  if (jobId === null || planId === null || status === null) return null;
  const items = collect(value.items, parseBuildItem);
  const events = collect(value.events, parseBuildEvent);
  if (items === null || events === null) return null;
  let selectedResource: CreateResourceRef | null = null;
  if (value.selectedResource !== null) {
    selectedResource = parseResourceRef(value.selectedResource);
    if (selectedResource === null) return null;
  }
  const error = optionalString(value.error);
  if (error === null) return null;
  // Read back as a whole string or not at all. A truncated revision would
  // still compare equal to nothing, but it would also be written back into a
  // publication receipt, so half a digest must not survive the round trip.
  const admittedRevision = value.admittedRevision === undefined
    ? undefined
    : requiredString(value.admittedRevision);
  if (admittedRevision === null) return null;
  const startedAt = value.startedAt === undefined
    ? undefined
    : requiredString(value.startedAt);
  if (startedAt === null) return null;
  // An API-restart interruption saved by an earlier release is read as one.
  return readLegacyRestartInterruption({
    jobId,
    planId,
    ...(admittedRevision === undefined ? {} : { admittedRevision }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(value.discarded === true ? { discarded: true as const } : {}),
    status,
    items,
    selectedResource,
    events,
    ...(error === undefined ? {} : { error }),
  });
}

/**
 * A persisted admission, or `null` when the file does not describe one.
 *
 * Refused whole. A half-read admission is worse than none: it would either free
 * a plan someone is already building, or hold a job id that no attempt owns.
 */
export function parsePlanAdmissionRecord(
  value: unknown,
): ResourcePlanAdmission | null {
  if (!isRecord(value)) return null;
  const planId = requiredString(value.planId);
  const jobId = requiredString(value.jobId);
  const revision = requiredString(value.revision);
  if (planId === null || jobId === null || revision === null) return null;
  const priorJobIds = collect(value.priorJobIds ?? [], parseNonEmptyString);
  if (priorJobIds === null) return null;
  return {
    planId,
    jobId,
    revision,
    priorJobIds,
    ...(value.discarded === true ? { discarded: true as const } : {}),
  };
}

function parseBuildItem(value: unknown): ResourceBuildItem | null {
  if (!isRecord(value)) return null;
  const plannedResource = parseResourceRef(value.plannedResource);
  const status = pick(value.status, BUILD_ITEM_STATUSES);
  const planIndex = wholeNumber(value.planIndex);
  if (!plannedResource || status === null || planIndex === null) return null;
  const resource = value.resource === undefined
    ? undefined
    : parseResourceRef(value.resource);
  if (resource === null) return null;
  const error = optionalString(value.error);
  if (error === null) return null;
  return {
    plannedResource,
    planIndex,
    status,
    ...(resource === undefined ? {} : { resource }),
    ...(error === undefined ? {} : { error }),
  };
}

function parseBuildEvent(value: unknown): ResourceBuildEvent | null {
  if (!isRecord(value)) return null;
  const type = pick(value.type, BUILD_EVENT_TYPES);
  const message = requiredString(value.message);
  const id = wholeNumber(value.id);
  if (type === null || message === null || id === null) return null;
  const plannedResource = value.plannedResource === undefined
    ? undefined
    : parseResourceRef(value.plannedResource);
  if (plannedResource === null) return null;
  const resource = value.resource === undefined
    ? undefined
    : parseResourceRef(value.resource);
  if (resource === null) return null;
  let planIndex: number | undefined;
  if (value.planIndex !== undefined) {
    const parsed = wholeNumber(value.planIndex);
    if (parsed === null) return null;
    planIndex = parsed;
  }
  // A skill event without the skill it is about, or without the operation it
  // belongs to, cannot be placed on a row, and an identity on any other event
  // would put an Agent-level fact on one row. Each is a record this reader
  // does not understand.
  let skill: ResourceSkillUpdateIdentity | undefined;
  if (isResourceSkillUpdateEventType(type)) {
    if (planIndex === undefined) return null;
    const parsed = parseSkillIdentity(value.skill);
    if (parsed === null) return null;
    skill = parsed;
  } else if (value.skill !== undefined) {
    return null;
  }
  return {
    id,
    type,
    message,
    ...(plannedResource === undefined ? {} : { plannedResource }),
    ...(resource === undefined ? {} : { resource }),
    ...(planIndex === undefined ? {} : { planIndex }),
    ...(skill === undefined ? {} : { skill }),
  };
}

function parseSkillIdentity(value: unknown): ResourceSkillUpdateIdentity | null {
  if (!isRecord(value)) return null;
  const name = requiredString(value.name);
  const action = pick(value.action, ["create", "update"] as const);
  return name === null || action === null ? null : { name, action };
}

/**
 * The spelling every server-owned revision has.
 *
 * A persisted operation carrying anything else was not written by this server,
 * and running it would check the target against a revision nothing calculated.
 */
const SERVER_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function parseUpdateOperation(
  value: unknown,
): PersistedResourceUpdateOperation | null {
  if (!isRecord(value)) return null;
  const expectedRevision = requiredString(value.expectedRevision);
  if (expectedRevision === null || !SERVER_REVISION_PATTERN.test(expectedRevision)) return null;
  if (value.kind === "add_team_agents") {
    const target = parseResourceRef(value.target);
    if (!target || target.kind !== "team" || !isExactTeamId(target.id)) return null;
    const libraryAgentsToAdd = collect(value.libraryAgentsToAdd, parseTeamAgentPlan);
    const newAgentsToCreate = collect(value.newAgentsToCreate, parseTeamNewAgent);
    if (libraryAgentsToAdd === null || newAgentsToCreate === null) return null;
    // The Team writer sanitizes an addition name before it looks the Agent up,
    // so a plan naming ' scoping-lawyer ' would add `scoping-lawyer`. A plan
    // that names one Agent and adds another authorizes nothing.
    if (
      ![...libraryAgentsToAdd, ...newAgentsToCreate].every((agent) =>
        isExactAgentId(agent.name)
      )
    ) {
      return null;
    }
    // The same operation-level rules the proposal boundary applied. Parsing the
    // fields alone would let a file that reached the disk some other way hand
    // the executor an operation that adds nothing, or one Agent twice.
    if (
      findTeamAdditionStructureViolation(
        libraryAgentsToAdd,
        newAgentsToCreate,
        target.id,
      ) !== null
    ) {
      return null;
    }
    return {
      kind: "add_team_agents",
      target,
      expectedRevision,
      libraryAgentsToAdd,
      newAgentsToCreate,
    };
  }
  if (value.kind === "update_agent_skills") {
    const target = parseResourceRef(value.target);
    if (!target || target.kind !== "agent" || !isExactAgentId(target.id)) return null;
    const skillUpdates = collect(value.skillUpdates, parseSkillUpdate);
    if (skillUpdates === null) return null;
    // The same structural rules the proposal boundary applied. Parsing the
    // fields alone would let a file that reached the disk some other way hand
    // the executor an empty operation, a name repeated twice, or a name that
    // does not stay inside the Agent's own skills folder.
    if (findSkillUpdateStructureViolation(skillUpdates) !== null) return null;
    return { kind: "update_agent_skills", target, expectedRevision, skillUpdates };
  }
  return null;
}

/**
 * Whether a persisted Team id is the id it will actually mutate.
 *
 * The Team writer sanitizes what it is given — lowercasing and replacing
 * anything outside `a-z0-9_-` — so a plan file naming ` Contract-Review-Team `
 * would be executed against `contract-review-team`. A plan that names one
 * target and changes another authorizes nothing, so it is refused here rather
 * than quietly redirected.
 */
function isExactTeamId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= 64 &&
    /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/.test(id)
  );
}

/** The same rule for an Agent target, from the repository's own naming rule. */
function isExactAgentId(id: string): boolean {
  try {
    validateExactAgentName(id);
    return true;
  } catch {
    return false;
  }
}

function parseSkillUpdate(
  value: unknown,
): { action: "create" | "update"; name: string; instruction: string } | null {
  if (!isRecord(value)) return null;
  const action = pick(value.action, ["create", "update"] as const);
  const name = requiredString(value.name);
  const instruction = requiredString(value.instruction);
  return action !== null && name !== null && instruction !== null
    ? { action, name, instruction }
    : null;
}

function parseTeamPlan(value: unknown): PersistedResourceTeamPlan | null {
  if (!isRecord(value)) return null;
  const teamId = requiredString(value.teamId);
  const description = requiredString(value.description);
  const tags = collect(value.tags, parseNonEmptyString);
  const existingAgents = collect(value.existingAgents, parseTeamAgentPlan);
  const newAgents = collect(value.newAgents, parseTeamNewAgent);
  const questionsResolved = collect(value.questionsResolved, parseNonEmptyString);
  if (
    teamId === null ||
    description === null ||
    tags === null ||
    existingAgents === null ||
    newAgents === null ||
    questionsResolved === null
  ) {
    return null;
  }
  let documentDomains: ResourceTeamDocumentDomain[] | undefined;
  if (value.documentDomains !== undefined) {
    const parsed = collect(value.documentDomains, parseDocumentDomain);
    if (parsed === null) return null;
    documentDomains = parsed;
  }
  // Three cases, kept apart. Absent or null means no shape was chosen, which
  // is what a plan written before shapes existed carries. A present value that
  // does not parse is marked rejected rather than dropped: the record stays
  // loadable, so the plan's agents are not lost behind a "not found", and the
  // build and amendment endpoints refuse it by name instead of quietly
  // building the legacy chain in its place.
  const shapeAbsent = value.shape === undefined || value.shape === null;
  const storedShape = shapeAbsent
    ? undefined
    : teamShapeSchema.safeParse(value.shape);
  const shape = storedShape?.success ? storedShape.data : undefined;
  // Either the stored shape failed to parse now, or a previous read already
  // recorded that it did and the record was saved carrying that verdict. The
  // marker has to survive the round trip, or a restart turns a rejected plan
  // back into a legacy one and the build quietly produces a chain.
  const shapeRejected =
    (storedShape !== undefined && !storedShape.success) ||
    value.shapeRejected === true;
  return {
    teamId,
    description,
    tags,
    ...(documentDomains === undefined ? {} : { documentDomains }),
    ...(shape === undefined ? {} : { shape }),
    ...(shapeRejected ? { shapeRejected: true as const } : {}),
    existingAgents,
    newAgents,
    questionsResolved,
  };
}

function parseDocumentDomain(value: unknown): ResourceTeamDocumentDomain | null {
  if (!isRecord(value)) return null;
  const domain = requiredString(value.domain);
  const evidenceAnchors = collect(value.evidenceAnchors, parseNonEmptyString);
  return domain !== null && evidenceAnchors !== null
    ? { domain, evidenceAnchors }
    : null;
}

function parseDocumentSpecialization(
  value: unknown,
): ResourceTeamDocumentSpecialization | null {
  if (!isRecord(value)) return null;
  const expertiseDomain = requiredString(value.expertiseDomain);
  const focus = requiredString(value.focus);
  const evidenceAnchors = collect(value.evidenceAnchors, parseNonEmptyString);
  const assessmentTargets = collect(value.assessmentTargets, parseNonEmptyString);
  const outOfScope = collect(value.outOfScope, parseNonEmptyString);
  if (
    expertiseDomain === null ||
    focus === null ||
    evidenceAnchors === null ||
    assessmentTargets === null ||
    outOfScope === null
  ) {
    return null;
  }
  return { expertiseDomain, focus, evidenceAnchors, assessmentTargets, outOfScope };
}

function parsePlannedAgent(value: unknown): PersistedPlannedAgentSpec | null {
  if (!isRecord(value)) return null;
  if (value.webResearchEnabled !== undefined && typeof value.webResearchEnabled !== "boolean") return null;
  const name = requiredString(value.name);
  const role = requiredString(value.role);
  const description = requiredString(value.description);
  const rationale = requiredString(value.rationale);
  // A stored record may still carry a grade from before. It is not demanded,
  // and nothing new produces one — but what is there is read back exactly, or
  // the operation would hash to an identity its own receipt never named. The
  // return type says so: this is the persisted shape, not the authored one.
  const tier = requiredString(value.tier);
  // The card summary is absent on a plan saved before summaries existed, and
  // that record loads as it is. A present one is read back exactly, because
  // the plan's revision and an update operation's identity are digests over
  // the stored record: dropping it would change both across a restart. A blank
  // one is refused, because the next turn's plan echo refuses it too.
  const summary = optionalString(value.summary);
  if (summary === null || summary?.trim() === "") return null;
  return name !== null && role !== null && description !== null && rationale !== null
    ? { name, role, ...(summary === undefined ? {} : { summary }), description, rationale, ...(typeof value.webResearchEnabled === "boolean" ? { webResearchEnabled: value.webResearchEnabled } : {}), ...(tier === null ? {} : { tier }) }
    : null;
}

function parseTeamNewAgent(
  value: unknown,
): PersistedResourceTeamNewAgentPlan | null {
  const agent = parsePlannedAgent(value);
  if (!agent || !isRecord(value)) return null;
  if (value.documentSpecialization === undefined) return agent;
  const documentSpecialization = parseDocumentSpecialization(
    value.documentSpecialization,
  );
  return documentSpecialization === null ? null : { ...agent, documentSpecialization };
}

function parseTeamAgentPlan(
  value: unknown,
): PersistedResourceTeamAgentPlan | null {
  if (!isRecord(value)) return null;
  const name = requiredString(value.name);
  const role = requiredString(value.role);
  const rationale = requiredString(value.rationale);
  const tier = requiredString(value.tier);
  return name !== null && role !== null && rationale !== null
    ? { name, role, rationale, ...(tier === null ? {} : { tier }) }
    : null;
}

/**
 * A resource reference, or `null` when the value is not one.
 *
 * Callers that allow the field to be absent check for `undefined` first, so
 * `null` here always means "present and wrong".
 */
function parseResourceRef(value: unknown): CreateResourceRef | null {
  if (!isRecord(value)) return null;
  const id = requiredString(value.id);
  if (id === null) return null;
  if (value.kind === "agent") return { kind: "agent", id };
  if (value.kind === "team") return { kind: "team", id };
  return null;
}

/** Builds a typed list, or reports that one entry could not be built. */
function collect<T>(value: unknown, build: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const collected: T[] = [];
  for (const entry of value) {
    const built = build(entry);
    if (built === null) return null;
    collected.push(built);
  }
  return collected;
}

function parseNonEmptyString(value: unknown): string | null {
  return requiredString(value);
}

/** A finite number, or `null` when the value is not one. */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A finite number or an explicit `null`; `undefined` when it is neither. */
function nullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return finiteNumber(value) ?? undefined;
}

/** A non-empty string or an explicit `null`; `undefined` when it is neither. */
function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return requiredString(value) ?? undefined;
}

/** One of `allowed` or an explicit `null`; `undefined` when it is neither. */
function nullableChoice<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null | undefined {
  if (value === null) return null;
  return pick(value, allowed) ?? undefined;
}

/** A non-negative safe integer, or `null` when the value is not one. */
function wholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** `undefined` when absent, `null` when present but not a usable string. */
function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return allowed.find((candidate) => candidate === value) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
