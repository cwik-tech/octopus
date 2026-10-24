import { readModelSelectionRecord } from "@contracts/agent-model-selection";
import { isThinkingLevel, THINKING_REQUEST_VALUES } from "@contracts/thinking-levels";
import type { ResourceArchitectComposerSelection } from "@contracts/schemas/resource-architect-composer";
import { resourceArchitectFeedbackDiagnosticsSchema } from "@contracts/schemas/resource-architect-review";
import {
  isResourceSkillUpdateEventType,
  RESOURCE_ARCHITECT_TURN_TIMEOUT_MS,
  RESOURCE_SKILL_UPDATE_EVENT_TYPES,
  type ResourceSkillUpdateIdentity,
} from "@contracts/resource-architect";
import type {
  ChatTurn,
  CreateResourceRef,
  PlannedAgentSpec,
  ResourceArchitectOperation,
  ResourceArchitectPlan,
  ResourceArchitectTurnCancelledResponse,
  ResourceArchitectTurnMetric,
  ResourceArchitectTurnOutcome,
  ResourceArchitectTurnResponse,
  ResourceBuildEvent,
  ResourceBuildEventType,
  ResourceBuildItem,
  ResourceBuildItemStatus,
  ResourceBuildJobSnapshot,
  ResourceBuildJobStatus,
  ResourceSkillUpdate,
  ResourceTeamPlan,
  ResourceUpdateOperation,
} from "@/lib/models/resource-architect-model";
import { teamShapeSchema, type TeamShape } from "@contracts/schemas/team-shape";
import { getApiBaseUrl } from "@/lib/utils/desktop";
import type { ModelChoice } from "@/lib/utils/model-catalog";
import { ResourceArchitectConnectionError } from "./resource-architect-conversation-client";

const API_BASE = getApiBaseUrl();

type ResourceBuildStartResponse =
  | { jobId: string; job: ResourceBuildJobSnapshot; cancelled?: false }
  | { jobId: string; cancelled: true; job?: never };

async function expectOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  const fallback = `${response.status} ${response.statusText}`;
  const report = readErrorReport(await response.json().catch(() => null));
  const details = report.details.length > 0 ? `: ${report.details.join("; ")}` : "";
  // The sentence first. A refusal carries two things: a code the card branches
  // on, and words a person can act on. Reporting the code showed the user
  // `build_discarded` where the server had already written what happened and
  // what to do about it.
  throw new Error(`${report.reason ?? report.error ?? fallback}${details}`);
}

/**
 * What a failed response said about itself, as far as it can be believed.
 *
 * A failure report is the one payload that must not be refused for being
 * malformed: the request already failed, and the status line is a truthful
 * answer on its own. So each field is taken only when it is the shape it
 * claims, and anything else is simply not there.
 */
function readErrorReport(
  value: unknown,
): { error?: string; reason?: string; details: string[] } {
  if (!isRecord(value)) return { details: [] };
  return {
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(typeof value.reason === "string" && value.reason.trim().length > 0
      ? { reason: value.reason }
      : {}),
    details: isStringArray(value.details) ? value.details : [],
  };
}

export async function postResourceArchitectTurn(input: {
  jobId: string;
  operation: ResourceArchitectOperation;
  history: ChatTurn[];
  currentPlan: ResourceArchitectPlan | null;
  selectedResource?: CreateResourceRef | undefined;
  draftId?: string;
  documentReader?: ModelChoice | undefined;
  provider?: string;
  model?: string;
  composerSelection?: ResourceArchitectComposerSelection;
}): Promise<ResourceArchitectTurnResponse | ResourceArchitectTurnCancelledResponse> {
  const response = await fetch(`${API_BASE}/create/resource-architect/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(RESOURCE_ARCHITECT_TURN_TIMEOUT_MS),
    body: JSON.stringify({
      ...input,
      history: boundRecentHistory(input.history),
    }),
  }).catch((cause: unknown) => {
    if (input.operation === "conversation") throw new ResourceArchitectConnectionError(cause);
    throw cause;
  });
  await expectOk(response);
  const payload: unknown = await response.json().catch((cause: unknown) => {
    if (input.operation === "conversation" &&
        (cause instanceof TypeError || (cause instanceof Error && ["TimeoutError", "AbortError"].includes(cause.name)))) {
      throw new ResourceArchitectConnectionError(cause);
    }
    throw cause;
  });
  return parseResourceArchitectTurnResponse(payload);
}

class ApiContractError extends Error {
  constructor(contract: string) {
    super(`Invalid API response: expected ${contract}`);
    this.name = "ApiContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function requireNumber(value: unknown, contract: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ApiContractError(contract);
  }
  return value;
}

function requireNullableNumber(value: unknown, contract: string): number | null {
  if (value === null) return null;
  return requireNumber(value, contract);
}

function parseResourceArchitectTurnResponse(
  value: unknown,
): ResourceArchitectTurnResponse | ResourceArchitectTurnCancelledResponse {
  if (!isRecord(value)) throw new ApiContractError("ResourceArchitectTurnResponse");
  if (value.cancelled !== undefined) return requireCancelledTurn(value);
  if (value.operation === "conversation") return requireConversationTurn(value);
  if (value.operation === "proposal") return requireProposalTurn(value);
  throw new ApiContractError("ResourceArchitectTurnResponse");
}

function requireJobId(value: Record<string, unknown>, contract: string): string {
  if (typeof value.jobId !== "string") throw new ApiContractError(contract);
  return value.jobId;
}

function requireCancelledTurn(
  value: Record<string, unknown>,
): ResourceArchitectTurnCancelledResponse {
  const contract = "ResourceArchitectTurnCancelledResponse";
  if (value.cancelled !== true || value.proposalRequested !== undefined) {
    throw new ApiContractError(contract);
  }
  const result: ResourceArchitectTurnCancelledResponse = {
    jobId: requireJobId(value, contract),
    cancelled: true,
  };
  if (value.operation !== undefined) {
    if (value.operation !== "conversation" && value.operation !== "proposal") {
      throw new ApiContractError(contract);
    }
    result.operation = value.operation;
  }
  return result;
}

function requireConversationTurn(
  value: Record<string, unknown>,
): ResourceArchitectTurnResponse {
  const contract = "ResourceArchitectConversationResponse";
  const result = {
    jobId: requireJobId(value, contract),
    operation: "conversation" as const,
    message: requireMessage(value, contract),
    warnings: requireWarnings(value, contract),
    meta: requireTurnMeta(value.meta),
  };
  if (value.proposalRequested !== undefined) {
    if (value.proposalRequested !== true) throw new ApiContractError(contract);
    return { ...result, proposalRequested: true as const };
  }
  return result;
}

function requireProposalTurn(
  value: Record<string, unknown>,
): ResourceArchitectTurnResponse {
  const contract = "ResourceArchitectProposalResponse";
  if (value.proposalRequested !== undefined) throw new ApiContractError(contract);
  return {
    jobId: requireJobId(value, contract),
    operation: "proposal" as const,
    message: requireMessage(value, contract),
    warnings: requireWarnings(value, contract),
    outcome: requireTurnOutcome(value.outcome),
    meta: requireTurnMeta(value.meta),
  };
}

function requireMessage(value: Record<string, unknown>, contract: string): string {
  if (typeof value.message !== "string") throw new ApiContractError(contract);
  return value.message;
}

function requireWarnings(value: Record<string, unknown>, contract: string): string[] {
  if (!isStringArray(value.warnings)) throw new ApiContractError(contract);
  return value.warnings;
}

function requireTurnMeta(value: unknown): ResourceArchitectTurnResponse["meta"] {
  const contract = "ResourceArchitectTurnMeta";
  if (
    !isRecord(value) ||
    typeof value.provider !== "string" ||
    typeof value.model !== "string" ||
    typeof value.fallback !== "boolean" ||
    // The full vocabulary, from the list the Agent editor offers. The
    // Architect honours the level its own persona names, so a successful reply
    // can report any of them; a narrower check here would fail an authoring
    // request because of a setting the user chose and the turn respected.
    !isThinkingLevel(value.reasoning)
  ) {
    throw new ApiContractError(contract);
  }
  const reason = value.reason;
  if (reason !== undefined && typeof reason !== "string") {
    throw new ApiContractError(contract);
  }
  // Validated rather than asserted, and dropped rather than half-shown. The
  // rest of the turn is still usable without it, so an unreadable record costs
  // the disclosure and nothing else.
  const selection = readModelSelectionRecord(value.selection);
  const review = readFeedbackDiagnostics(value.review);
  return {
    provider: value.provider,
    model: value.model,
    ...(selection ? { selection } : {}),
    ...(review ? { review } : {}),
    fallback: value.fallback,
    ...(reason !== undefined ? { reason } : {}),
    reasoning: value.reasoning,
    timing: requireTurnTiming(value.timing, contract),
  };
}

function readFeedbackDiagnostics(value: unknown) {
  if (value === undefined) return undefined;
  const parsed = resourceArchitectFeedbackDiagnosticsSchema.safeParse(value);
  if (!parsed.success) throw new ApiContractError("ResourceArchitectFeedbackDiagnostics");
  return parsed.data;
}

/** The same timing block a turn and a recorded metric both carry. */
function requireTurnTiming(
  value: unknown,
  contract: string,
): ResourceArchitectTurnResponse["meta"]["timing"] {
  if (!isRecord(value) || typeof value.repairOccurred !== "boolean") {
    throw new ApiContractError(contract);
  }
  const context = value.context;
  if (!isRecord(context)) throw new ApiContractError(contract);
  return {
    contextAssemblyMs: requireNumber(value.contextAssemblyMs, contract),
    providerDurationMs: requireNumber(value.providerDurationMs, contract),
    processSpawnMs: requireNullableNumber(value.processSpawnMs, contract),
    firstProviderEventMs: requireNullableNumber(value.firstProviderEventMs, contract),
    firstTextMs: requireNullableNumber(value.firstTextMs, contract),
    parseDurationMs: requireNumber(value.parseDurationMs, contract),
    repairOccurred: value.repairOccurred,
    repairDurationMs: requireNumber(value.repairDurationMs, contract),
    totalDurationMs: requireNumber(value.totalDurationMs, contract),
    context: {
      instructionsChars: requireNumber(context.instructionsChars, contract),
      operationChars: requireNumber(context.operationChars, contract),
      uploadedDocumentPolicyChars: requireNumber(context.uploadedDocumentPolicyChars, contract),
      visualizationPolicyChars: requireNumber(context.visualizationPolicyChars, contract),
      teamLibraryChars: requireNumber(context.teamLibraryChars, contract),
      agentLibraryChars: requireNumber(context.agentLibraryChars, contract),
      totalChars: requireNumber(context.totalChars, contract),
      historyChars: requireNumber(context.historyChars, contract),
    },
  };
}

function requireTurnOutcome(value: unknown): ResourceArchitectTurnOutcome {
  const contract = "ResourceArchitectTurnOutcome";
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new ApiContractError(contract);
  }
  if (value.kind === "discussion") return { kind: "discussion" };
  if (value.kind === "edit_existing") {
    return {
      kind: "edit_existing",
      target: requireResourceRef(value.target),
    };
  }
  if (typeof value.id !== "string") throw new ApiContractError(contract);
  if (value.kind === "standalone_agents") {
    if (!Array.isArray(value.agents)) throw new ApiContractError(contract);
    return {
      id: value.id,
      kind: "standalone_agents",
      agents: value.agents.map(requirePlannedAgent),
    };
  }
  if (value.kind === "team") {
    return { id: value.id, kind: "team", team: requireTeamPlan(value.team) };
  }
  if (value.kind === "resource_updates") {
    if (!Array.isArray(value.operations) || value.operations.length === 0) {
      throw new ApiContractError(contract);
    }
    return {
      id: value.id,
      kind: "resource_updates",
      operations: value.operations.map(requireUpdateOperation),
    };
  }
  throw new ApiContractError(contract);
}

/**
 * Every operation must carry the revision the server calculated. An operation
 * without one could only have come from a build the server never pinned, so it
 * is rejected rather than shown as an applicable update.
 */
function requireUpdateOperation(value: unknown): ResourceUpdateOperation {
  const contract = "ResourceUpdateOperation";
  if (
    !isRecord(value) ||
    typeof value.expectedRevision !== "string" ||
    value.expectedRevision.length === 0
  ) {
    throw new ApiContractError(contract);
  }
  if (value.kind === "add_team_agents") {
    if (
      !Array.isArray(value.libraryAgentsToAdd) ||
      !Array.isArray(value.newAgentsToCreate)
    ) {
      throw new ApiContractError(contract);
    }
    return {
      kind: "add_team_agents",
      target: requireTeamRef(value.target),
      expectedRevision: value.expectedRevision,
      libraryAgentsToAdd: value.libraryAgentsToAdd.map(requireTeamAgentPlan),
      newAgentsToCreate: value.newAgentsToCreate.map(requireTeamNewAgent),
    };
  }
  if (value.kind === "update_agent_skills") {
    if (!Array.isArray(value.skillUpdates)) throw new ApiContractError(contract);
    return {
      kind: "update_agent_skills",
      target: requireAgentRef(value.target),
      expectedRevision: value.expectedRevision,
      skillUpdates: value.skillUpdates.map(requireSkillUpdate),
    };
  }
  throw new ApiContractError(contract);
}

function requireTeamRef(value: unknown): { kind: "team"; id: string } {
  const ref = requireResourceRef(value);
  if (ref.kind !== "team") throw new ApiContractError("ResourceUpdateOperation");
  return { kind: "team", id: ref.id };
}

function requireAgentRef(value: unknown): { kind: "agent"; id: string } {
  const ref = requireResourceRef(value);
  if (ref.kind !== "agent") throw new ApiContractError("ResourceUpdateOperation");
  return { kind: "agent", id: ref.id };
}

function requireSkillUpdate(value: unknown): ResourceSkillUpdate {
  const contract = "ResourceSkillUpdate";
  if (
    !isRecord(value) ||
    (value.action !== "create" && value.action !== "update") ||
    typeof value.name !== "string" ||
    typeof value.instruction !== "string"
  ) {
    throw new ApiContractError(contract);
  }
  return { action: value.action, name: value.name, instruction: value.instruction };
}

function requireResourceRef(value: unknown): CreateResourceRef {
  const contract = "CreateResourceRef";
  if (
    !isRecord(value) ||
    (value.kind !== "agent" && value.kind !== "team") ||
    typeof value.id !== "string"
  ) {
    throw new ApiContractError(contract);
  }
  return { kind: value.kind, id: value.id };
}

function requirePlannedAgent(value: unknown): PlannedAgentSpec {
  const contract = "PlannedAgentSpec";
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.role !== "string" ||
    (value.summary !== undefined && (typeof value.summary !== "string" || value.summary.trim() === "")) ||
    typeof value.description !== "string" ||
    (value.webResearchEnabled !== undefined && typeof value.webResearchEnabled !== "boolean") ||
    typeof value.rationale !== "string"
  ) {
    throw new ApiContractError(contract);
  }
  // No grade. A plan produced now has none, and a plan recovered from before
  // may still carry one on the wire — it is read past rather than demanded,
  // because requiring it would reject every valid plan the server now sends.
  // The card summary is kept when present. A plan saved before summaries
  // existed has none, and it stays absent here: the card derives display copy
  // for it, and the plan the renderer echoes back stays the one it was sent.
  return {
    name: value.name,
    role: value.role,
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    description: value.description,
    rationale: value.rationale,
    ...(typeof value.webResearchEnabled === "boolean" ? { webResearchEnabled: value.webResearchEnabled } : {}),
  };
}

function requireTeamPlan(value: unknown): ResourceTeamPlan {
  const contract = "ResourceTeamPlan";
  if (
    !isRecord(value) ||
    typeof value.teamId !== "string" ||
    typeof value.description !== "string" ||
    !isStringArray(value.tags) ||
    !Array.isArray(value.existingAgents) ||
    !Array.isArray(value.newAgents) ||
    !isStringArray(value.questionsResolved)
  ) {
    throw new ApiContractError(contract);
  }
  return {
    teamId: value.teamId,
    description: value.description,
    tags: value.tags,
    ...(value.documentDomains !== undefined
      ? { documentDomains: requireDocumentDomains(value.documentDomains) }
      : {}),
    ...(value.shape === undefined || value.shape === null
      ? {}
      : { shape: requireTeamShape(value.shape) }),
    // A plan restored from disk can say its saved shape is unbuildable. That is
    // not the same as having none, and the card draws a repair prompt for it.
    ...(value.shapeRejected === true ? { shapeRejected: true as const } : {}),
    existingAgents: value.existingAgents.map(requireTeamAgentPlan),
    newAgents: value.newAgents.map(requireTeamNewAgent),
    questionsResolved: value.questionsResolved,
  };
}

/**
 * The proposed interaction shape, rebuilt by the contract that defines it.
 *
 * Absent and null both mean "no shape chosen", which is what a plan proposed
 * before shapes existed carries, and it builds the chain it always built. A
 * present value that is not a shape this app can build is refused like any
 * other contract violation: dropping it would leave the card showing nothing
 * and the build quietly producing a different team from the one described.
 */
function requireTeamShape(value: unknown): TeamShape {
  const parsed = teamShapeSchema.safeParse(value);
  if (!parsed.success) throw new ApiContractError("TeamShape");
  return parsed.data;
}

function requireDocumentDomains(
  value: unknown,
): NonNullable<ResourceTeamPlan["documentDomains"]> {
  const contract = "ResourceTeamDocumentDomain";
  if (!Array.isArray(value)) throw new ApiContractError(contract);
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.domain !== "string" ||
      !isStringArray(entry.evidenceAnchors)
    ) {
      throw new ApiContractError(contract);
    }
    return { domain: entry.domain, evidenceAnchors: entry.evidenceAnchors };
  });
}

function requireTeamNewAgent(
  value: unknown,
): ResourceTeamPlan["newAgents"][number] {
  const contract = "ResourceTeamNewAgentPlan";
  const agent = requirePlannedAgent(value);
  if (!isRecord(value)) throw new ApiContractError(contract);
  if (value.documentSpecialization === undefined) return agent;
  return {
    ...agent,
    documentSpecialization: requireDocumentSpecialization(
      value.documentSpecialization,
    ),
  };
}

function requireDocumentSpecialization(
  value: unknown,
): NonNullable<ResourceTeamPlan["newAgents"][number]["documentSpecialization"]> {
  const contract = "ResourceTeamDocumentSpecialization";
  if (
    !isRecord(value) ||
    typeof value.expertiseDomain !== "string" ||
    typeof value.focus !== "string" ||
    !isStringArray(value.evidenceAnchors) ||
    !isStringArray(value.assessmentTargets) ||
    !isStringArray(value.outOfScope)
  ) {
    throw new ApiContractError(contract);
  }
  return {
    expertiseDomain: value.expertiseDomain,
    focus: value.focus,
    evidenceAnchors: value.evidenceAnchors,
    assessmentTargets: value.assessmentTargets,
    outOfScope: value.outOfScope,
  };
}

function requireTeamAgentPlan(value: unknown): ResourceTeamPlan["existingAgents"][number] {
  const contract = "ResourceTeamAgentPlan";
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.role !== "string" ||
    typeof value.rationale !== "string"
  ) {
    throw new ApiContractError(contract);
  }
  return {
    name: value.name,
    role: value.role,
    rationale: value.rationale,
  };
}

export async function listResourceArchitectMetrics(
  limit = 50,
  signal?: AbortSignal,
): Promise<ResourceArchitectTurnMetric[]> {
  const response = await fetch(
    `${API_BASE}/create/resource-architect/metrics?limit=${encodeURIComponent(String(limit))}`,
    { cache: "no-store", ...(signal ? { signal } : {}) },
  );
  await expectOk(response);
  return requireTurnMetrics(await response.json());
}

const TURN_METRIC_STATUSES = [
  // A turn in flight, recorded before its provider answered. History is
  // rebuilt from these, and this is the record that describes a pending turn.
  "running",
  "completed",
  "cancelled",
  "failed",
] as const;
const TURN_OUTCOME_KINDS = [
  "standalone_agents",
  "team",
  "resource_updates",
  "discussion",
  "edit_existing",
] as const;

function requireTurnMetrics(value: unknown): ResourceArchitectTurnMetric[] {
  const contract = "ResourceArchitectTurnMetric[]";
  if (!isRecord(value) || !Array.isArray(value.metrics)) {
    throw new ApiContractError(contract);
  }
  return value.metrics.map(requireTurnMetric);
}

function requireTurnMetric(value: unknown): ResourceArchitectTurnMetric {
  const contract = "ResourceArchitectTurnMetric";
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.recordedAt !== "string" ||
    typeof value.jobId !== "string" ||
    typeof value.fallback !== "boolean" ||
    (value.operation !== "conversation" && value.operation !== "proposal")
  ) {
    throw new ApiContractError(contract);
  }
  const status = requireChoice(value.status, TURN_METRIC_STATUSES, contract);
  const provider = requireNullableString(value.provider, contract);
  const model = requireNullableString(value.model, contract);
  const reasoning = value.reasoning === null
    ? null
    // The full vocabulary, from the same list the agent editor offers. A
    // narrower check here would reject a turn that ran perfectly well at a
    // level this client had not heard of, and the metric would vanish rather
    // than say so.
    : requireChoice(value.reasoning, THINKING_REQUEST_VALUES, contract);
  const outcomeKind = value.outcomeKind === null
    ? null
    : requireChoice(value.outcomeKind, TURN_OUTCOME_KINDS, contract);
  const errorCode = value.errorCode;
  if (errorCode !== undefined && typeof errorCode !== "string") {
    throw new ApiContractError(contract);
  }
  // Validated and dropped rather than half-shown, like the turn's own record.
  // A metric without it is still a usable timing record; a half-read one would
  // let a restored notice claim something no turn recorded.
  const selection = readModelSelectionRecord(value.selection);
  const review = readFeedbackDiagnostics(value.review);
  return {
    schemaVersion: 1,
    recordedAt: value.recordedAt,
    jobId: value.jobId,
    operation: value.operation,
    status,
    provider,
    model,
    ...(selection ? { selection } : {}),
    ...(review ? { review } : {}),
    reasoning,
    outcomeKind,
    fallback: value.fallback,
    ...(errorCode !== undefined ? { errorCode } : {}),
    timing: requireTurnTiming(value.timing, contract),
  };
}

function requireChoice<T extends string>(
  value: unknown,
  choices: readonly T[],
  contract: string,
): T {
  const match = choices.find((choice) => choice === value);
  if (match === undefined) throw new ApiContractError(contract);
  return match;
}

function requireNullableString(value: unknown, contract: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new ApiContractError(contract);
  return value;
}

const RESOURCE_ARCHITECT_HISTORY_MAX_CHARS = 24_000;

function boundRecentHistory(history: ChatTurn[]): ChatTurn[] {
  const selected: ChatTurn[] = [];
  let characters = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    // Read rather than asserted. An index inside a list is not a promise the
    // element is there — a sparse array has holes at legal indexes — and the
    // assertion would only move the failure to whoever read the turn next.
    const turn = history[index];
    if (turn === undefined) continue;
    if (turn.text.length > RESOURCE_ARCHITECT_HISTORY_MAX_CHARS) {
      if (selected.length === 0) {
        selected.unshift({
          ...turn,
          text: turn.text.slice(-RESOURCE_ARCHITECT_HISTORY_MAX_CHARS),
        });
      }
      break;
    }
    if (characters + turn.text.length > RESOURCE_ARCHITECT_HISTORY_MAX_CHARS) break;
    selected.unshift(turn);
    characters += turn.text.length;
  }
  return selected;
}

export async function startResourceBuildJob(input: {
  planId: string;
  jobId?: string;
  draftId?: string;
  provider?: string;
  model?: string;
  /** The plan revision the card that authorized this build was showing. */
  expectedRevision?: string;
}): Promise<ResourceBuildStartResponse> {
  const response = await fetch(`${API_BASE}/create/resource-architect/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await expectOk(response);
  return requireBuildStartResponse(await response.json());
}

export async function readResourceBuildJob(
  jobId: string,
): Promise<ResourceBuildJobSnapshot> {
  const response = await fetch(
    `${API_BASE}/create/resource-architect/jobs/${encodeURIComponent(jobId)}`,
  );
  await expectOk(response);
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new ApiContractError("ResourceBuildJobSnapshot");
  return requireJobSnapshot(payload.job);
}

export async function listResourceBuildJobs(): Promise<ResourceBuildJobSnapshot[]> {
  const response = await fetch(`${API_BASE}/create/resource-architect/jobs`);
  await expectOk(response);
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
    throw new ApiContractError("ResourceBuildJobSnapshot[]");
  }
  return payload.jobs.map(requireJobSnapshot);
}

/**
 * Throws away the unfinished Team a stopped build left behind.
 *
 * The shell is not a team anybody can use, and every ordinary write to one is
 * refused while it is still marked as being built — so this is the only way to
 * remove it, and the server checks that the build asking made it.
 */
export async function discardResourceBuildTeam(
  jobId: string,
): Promise<ResourceBuildJobSnapshot> {
  const response = await fetch(
    `${API_BASE}/create/resource-architect/jobs/${encodeURIComponent(jobId)}/discard`,
    { method: "POST" },
  );
  await expectOk(response);
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new ApiContractError("ResourceBuildJobSnapshot");
  return requireJobSnapshot(payload.job);
}

export async function retryResourceBuildJob(input: {
  jobId: string;
  draftId?: string;
  provider?: string;
  model?: string;
}): Promise<ResourceBuildStartResponse> {
  const response = await fetch(
    `${API_BASE}/create/resource-architect/jobs/${encodeURIComponent(input.jobId)}/retry`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draftId: input.draftId,
        provider: input.provider,
        model: input.model,
      }),
    },
  );
  await expectOk(response);
  return requireBuildStartResponse(await response.json());
}

/**
 * A build the server either started or refused to start.
 *
 * The two answers are distinguished by `cancelled`, and only one of them
 * carries a snapshot. A response claiming both, or neither, describes a build
 * this renderer cannot follow.
 */
function requireBuildStartResponse(value: unknown): ResourceBuildStartResponse {
  const contract = "ResourceBuildStartResponse";
  if (!isRecord(value)) throw new ApiContractError(contract);
  const jobId = requireJobId(value, contract);
  if (value.cancelled !== undefined) {
    if (value.cancelled !== true || value.job !== undefined) {
      throw new ApiContractError(contract);
    }
    return { jobId, cancelled: true };
  }
  return { jobId, job: requireJobSnapshot(value.job) };
}

const BUILD_JOB_STATUSES = [
  "running",
  "interrupted",
  "partially_completed",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly ResourceBuildJobStatus[];

const BUILD_ITEM_STATUSES = [
  "planned",
  "generating",
  "created",
  "reused",
  "updated",
  "needs_input",
  "interrupted",
  "failed",
  "cancelled",
] as const satisfies readonly ResourceBuildItemStatus[];

const BUILD_EVENT_TYPES = [
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
] as const satisfies readonly ResourceBuildEventType[];

/**
 * One build job, rebuilt field by field.
 *
 * Every status and event type is checked against the union the renderer
 * switches on. A value outside it would flow into a `switch` that has no case
 * for it and silently take the default branch, which is how a card ends up
 * reporting "planned" about something that failed.
 */
function requireJobSnapshot(value: unknown): ResourceBuildJobSnapshot {
  const contract = "ResourceBuildJobSnapshot";
  if (
    !isRecord(value) ||
    typeof value.jobId !== "string" ||
    typeof value.planId !== "string" ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.events)
  ) {
    throw new ApiContractError(contract);
  }
  const error = value.error;
  if (error !== undefined && typeof error !== "string") {
    throw new ApiContractError(contract);
  }
  // Two records a reopened Create depends on: which stopped build to put back,
  // and what the team it published is checked against. Absent is legitimate —
  // a job written before either was recorded has neither — but present and
  // unreadable is refused, so a blank instant never sorts as the oldest build.
  const startedAt = requireOptionalText(value.startedAt, contract);
  const admittedRevision = requireOptionalText(value.admittedRevision, contract);
  // A decision, so it is read as one. Anything but the flag itself is refused
  // rather than read as "not discarded", which would offer to rebuild what the
  // user removed.
  if (value.discarded !== undefined && value.discarded !== true) {
    throw new ApiContractError(contract);
  }
  return {
    jobId: value.jobId,
    planId: value.planId,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(admittedRevision === undefined ? {} : { admittedRevision }),
    ...(value.discarded === true ? { discarded: true as const } : {}),
    status: requireChoice(value.status, BUILD_JOB_STATUSES, contract),
    items: value.items.map(requireBuildItem),
    selectedResource: value.selectedResource === null
      ? null
      : requireResourceRef(value.selectedResource),
    events: value.events.map(requireBuildEvent),
    ...(error !== undefined ? { error } : {}),
  };
}

/** A non-empty string, or nothing; anything else fails the contract. */
function requireOptionalText(value: unknown, contract: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiContractError(contract);
  }
  return value;
}

function requireBuildItem(value: unknown): ResourceBuildItem {
  const contract = "ResourceBuildItem";
  if (!isRecord(value) || typeof value.planIndex !== "number") {
    throw new ApiContractError(contract);
  }
  if (!Number.isSafeInteger(value.planIndex) || value.planIndex < 0) {
    throw new ApiContractError(contract);
  }
  const error = value.error;
  if (error !== undefined && typeof error !== "string") {
    throw new ApiContractError(contract);
  }
  return {
    plannedResource: requireResourceRef(value.plannedResource),
    ...(value.resource !== undefined
      ? { resource: requireResourceRef(value.resource) }
      : {}),
    planIndex: value.planIndex,
    status: requireChoice(value.status, BUILD_ITEM_STATUSES, contract),
    ...(error !== undefined ? { error } : {}),
  };
}

function requireBuildEvent(value: unknown): ResourceBuildEvent {
  const contract = "ResourceBuildEvent";
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    typeof value.message !== "string"
  ) {
    throw new ApiContractError(contract);
  }
  const planIndex = value.planIndex;
  if (
    planIndex !== undefined &&
    (typeof planIndex !== "number" || !Number.isSafeInteger(planIndex) || planIndex < 0)
  ) {
    throw new ApiContractError(contract);
  }
  const type = requireChoice(value.type, BUILD_EVENT_TYPES, contract);
  // Exactly the skill events name a skill. One without it, or without the
  // operation it belongs to, cannot be placed on a row, and a skill on any
  // other event would paint an Agent-level fact on a single row.
  if (!isResourceSkillUpdateEventType(type) && value.skill !== undefined) {
    throw new ApiContractError(contract);
  }
  if (isResourceSkillUpdateEventType(type) && planIndex === undefined) {
    throw new ApiContractError(contract);
  }
  const skill = isResourceSkillUpdateEventType(type)
    ? requireSkillIdentity(value.skill, contract)
    : undefined;
  return {
    id: value.id,
    type,
    ...(value.plannedResource !== undefined
      ? { plannedResource: requireResourceRef(value.plannedResource) }
      : {}),
    ...(value.resource !== undefined
      ? { resource: requireResourceRef(value.resource) }
      : {}),
    ...(planIndex !== undefined ? { planIndex } : {}),
    ...(skill !== undefined ? { skill } : {}),
    message: value.message,
  };
}

function requireSkillIdentity(value: unknown, contract: string): ResourceSkillUpdateIdentity {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) {
    throw new ApiContractError(contract);
  }
  return {
    name: value.name,
    action: requireChoice(value.action, ["create", "update"] as const, contract),
  };
}

/**
 * What the shape endpoint answered, as something the card can act on.
 *
 * Deliberately not `expectOk`. Every refusal here is a state the user is in
 * rather than a fault: someone else moved the plan, a build is running, or the
 * roles do not cover the roster. A thrown Error would flatten all three into
 * one message and throw away the names and the current shape the card needs to
 * redraw itself.
 */
export type TeamShapeAmendment =
  | {
    ok: true;
    revision: string;
    shape: TeamShape;
    plan: ResourceArchitectPlan;
    /** The admitted build, if the answer named one. Absent means none. */
    admitted?: { jobId: string; revision: string };
  }
  | {
      ok: false;
      reason: "conflict";
      currentRevision: string;
      currentPlan: ResourceArchitectPlan;
      currentShape?: TeamShape;
    }
  | { ok: false; reason: "invalid"; message: string; offendingNames?: string[] }
  | { ok: false; reason: "building"; message: string }
  /**
   * The plan already has an admitted build, so its shape is settled.
   *
   * Distinct from "being built": that one ends when the build does, and this
   * one never does. The card offers the built team instead of a retry of the
   * change, so it is told which build holds the plan.
   */
  | {
    ok: false;
    reason: "admitted";
    message: string;
    jobId: string;
    admittedRevision: string;
  };

export async function amendTeamShape(input: {
  planId: string;
  shape: TeamShape;
  expectedRevision: string;
  signal?: AbortSignal;
}): Promise<TeamShapeAmendment> {
  const response = await fetch(shapeUrl(input.planId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      shape: input.shape,
      expectedRevision: input.expectedRevision,
    }),
    // Bounded, and cancellable by the caller. A request nothing can end keeps
    // the card's "being changed" state forever, including after the user has
    // moved on to a different plan entirely.
    signal: boundedSignal(input.signal),
  });
  const payload: unknown = await response.json().catch(() => null);
  const body = isRecord(payload) ? payload : {};

  if (response.ok) {
    const shape = readShape(body.shape);
    if (!shape || typeof body.revision !== "string") {
      throw new Error("The server accepted the change but did not describe it.");
    }
    // The same whole-plan requirement a read is held to. An accepted change
    // that describes only the shape leaves every other field of the card
    // unaccounted for under a revision that covers all of them.
    const admitted = readAdmission(body.admitted, "TeamShapeAmendment");
    return {
      ok: true,
      revision: body.revision,
      shape,
      plan: requirePlanSnapshot(body.plan, input.planId),
      ...(admitted ? { admitted } : {}),
    };
  }

  if (body.error === "plan_revision_conflict" && typeof body.currentRevision === "string") {
    const currentShape = readShape(body.currentShape);
    return {
      ok: false,
      reason: "conflict",
      currentRevision: body.currentRevision,
      // The whole plan to redraw from. Patching one field of what the card had
      // is what let a concurrent roster change go unnoticed.
      currentPlan: requirePlanSnapshot(body.plan, input.planId),
      ...(currentShape ? { currentShape } : {}),
    };
  }
  if (
    body.error === "plan_already_admitted" &&
    typeof body.jobId === "string" &&
    typeof body.admittedRevision === "string"
  ) {
    return {
      ok: false,
      reason: "admitted",
      jobId: body.jobId,
      admittedRevision: body.admittedRevision,
      message: typeof body.reason === "string"
        ? body.reason
        : "This team has already been built from this plan.",
    };
  }
  if (body.error === "plan_being_built") {
    return {
      ok: false,
      reason: "building",
      message: typeof body.reason === "string"
        ? body.reason
        : "This team is being built.",
    };
  }
  if (body.error === "invalid_shape") {
    return {
      ok: false,
      reason: "invalid",
      message: typeof body.reason === "string"
        ? body.reason
        : "That is not a way a team can work together.",
      ...(isStringArray(body.offendingNames)
        ? { offendingNames: body.offendingNames }
        : {}),
    };
  }
  throw new Error(`${response.status} ${response.statusText}`);
}

/**
 * One authoritative description of a stored plan: its current shape, and the
 * revision an edit must be written against.
 *
 * The plan and the revision that describes it arrive together and are applied
 * together. Binding a revision to data the card already had is what let a
 * concurrent roster change leave the two disagreeing.
 */
export interface TeamPlanSnapshot {
  planId: string;
  revision: string;
  /**
   * The whole plan the revision describes. Required.
   *
   * An answer carrying a revision with no plan would advance the authority the
   * card holds while leaving it showing whatever it had, so the two would
   * describe different things with nothing to notice it. A plan that never
   * chose a shape is still a whole plan; that is absence inside a complete
   * snapshot, not a missing one.
   */
  plan: ResourceArchitectPlan;
  shape?: TeamShape;
  shapeRejected?: true;
  /**
   * The build this plan was admitted for, when it has one.
   *
   * Reported by the server rather than guessed from a failed write, because it
   * settles what the card may offer: a plan with an admitted build can no
   * longer be amended, whatever became of that build.
   */
  admitted?: { jobId: string; revision: string };
}

export async function readTeamShape(
  planId: string,
  options: { signal?: AbortSignal } = {},
): Promise<TeamPlanSnapshot> {
  const response = await fetch(shapeUrl(planId), {
    signal: boundedSignal(options.signal),
  });
  await expectOk(response);
  const payload: unknown = await response.json();
  const body = isRecord(payload) ? payload : {};
  if (typeof body.revision !== "string") {
    throw new Error("The server did not say which revision this plan is at.");
  }
  const shape = readShape(body.shape);
  const admitted = readAdmission(body.admitted, "TeamPlanSnapshot");
  return {
    planId,
    revision: body.revision,
    plan: requirePlanSnapshot(body.plan, planId),
    ...(shape ? { shape } : {}),
    ...(body.shapeRejected === true ? { shapeRejected: true as const } : {}),
    ...(admitted ? { admitted } : {}),
  };
}

/**
 * The admitted build an answer named, or nothing.
 *
 * Absent means the plan has no admitted build, which is a state the card can
 * act on. A value that is present but not readable means the state is unknown,
 * and that is refused rather than reported as absent: reading it as "no
 * admitted build" would offer the user a shape change on a plan that may have
 * already been built.
 */
function readAdmission(
  value: unknown,
  contract: string,
): { jobId: string; revision: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !isRecord(value) ||
    typeof value.jobId !== "string" ||
    value.jobId.length === 0 ||
    typeof value.revision !== "string" ||
    value.revision.length === 0
  ) {
    throw new ApiContractError(contract);
  }
  return { jobId: value.jobId, revision: value.revision };
}

/**
 * The plan an answer carried, held to the contract a proposal is held to.
 *
 * Refused rather than dropped. Dropping it produced a snapshot with a revision
 * and no plan, which is the exact failure this field exists to prevent, and the
 * card would have carried on with stale data under a fresher revision. The
 * identity is checked too: a reply describing some other plan is not authority
 * over the one that was asked for.
 */
function requirePlanSnapshot(
  value: unknown,
  planId: string,
): ResourceArchitectPlan {
  const contract = "TeamPlanSnapshot";
  if (!isRecord(value)) throw new ApiContractError(contract);
  const outcome = requireTurnOutcome(value);
  if (
    outcome.kind !== "team" &&
    outcome.kind !== "standalone_agents" &&
    outcome.kind !== "resource_updates"
  ) {
    throw new ApiContractError(contract);
  }
  if (outcome.id !== planId) throw new ApiContractError(contract);
  return outcome;
}

/** How long either shape request may take before it is given up on. */
const SHAPE_REQUEST_TIMEOUT_MS = 15_000;

/**
 * The caller's cancellation, plus a deadline of our own.
 *
 * Either ends the request. Without the deadline a server that accepts a
 * connection and never answers leaves the card stuck in a state only a reload
 * clears; without the caller's signal, a card that has moved on cannot let go.
 */
function boundedSignal(caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(SHAPE_REQUEST_TIMEOUT_MS);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

function shapeUrl(planId: string): string {
  return `${API_BASE}/create/resource-architect/plans/${encodeURIComponent(planId)}/shape`;
}

/**
 * A shape from the wire, rebuilt by the contract that defines it.
 *
 * The card renders role names and a headline from this, so a value that only
 * looked like a shape would put text on screen that no emitter could build.
 */
function readShape(value: unknown): TeamShape | undefined {
  const parsed = teamShapeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export async function amendAgentWebResearch(input: {
  planId: string;
  agentName: string;
  enabled: boolean;
  expectedRevision: string;
  signal?: AbortSignal;
}): Promise<{ plan: ResourceArchitectPlan; revision: string; notice?: string; admitted?: { jobId: string; revision: string } }> {
  const response = await fetch(`${API_BASE}/create/resource-architect/plans/${encodeURIComponent(input.planId)}/web-research`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentName: input.agentName, enabled: input.enabled, expectedRevision: input.expectedRevision }),
    signal: boundedSignal(input.signal),
  });
  if (!response.ok && response.status !== 409) await expectOk(response);
  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || typeof payload.revision !== "string") {
    const report = readErrorReport(payload);
    throw new Error(report.reason ?? report.error ?? "Internet access could not be saved.");
  }
  const admitted = readAdmission(payload.admitted, "WebResearchAmendment");
  return {
    plan: requirePlanSnapshot(payload.plan, input.planId),
    revision: payload.revision,
    ...(!response.ok ? { notice: typeof payload.reason === "string" ? payload.reason : "This proposal changed. Review it before creating." } : {}),
    ...(admitted ? { admitted } : {}),
  };
}
