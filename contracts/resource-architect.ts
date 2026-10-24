import type { ModelSelectionRecord } from "./agent-model-selection.js";
import type { ChatTurn, PlannedAgentSpec } from "./agent-generator.js";
import type { TeamShape } from "./schemas/team-shape.js";
import type { ThinkingLevel } from "./thinking-levels.js";
import type { ResourceArchitectFeedbackDiagnostics } from './schemas/resource-architect-review.js';

export type { ChatTurn, PlannedAgentSpec };

/** One authoring turn retains the existing ten-minute provider budget. */
export const RESOURCE_ARCHITECT_TURN_TIMEOUT_MS = 10 * 60 * 1_000;

export interface ResourceTeamAgentPlan {
  name: string;
  role: string;
  rationale: string;
}

export interface ResourceTeamDocumentDomain {
  domain: string;
  evidenceAnchors: string[];
}

export interface ResourceTeamDocumentSpecialization {
  expertiseDomain: string;
  focus: string;
  evidenceAnchors: string[];
  assessmentTargets: string[];
  outOfScope: string[];
}

export interface ResourceTeamNewAgentPlan extends PlannedAgentSpec {
  documentSpecialization?: ResourceTeamDocumentSpecialization;
}

export interface ResourceTeamPlan {
  teamId: string;
  description: string;
  tags: string[];
  /**
   * How the members work together, as proposed to the user and possibly
   * amended by them.
   *
   * Optional so that plans recorded before shapes existed still parse. Absent
   * means the chain every generated team used to be, so a legacy plan rebuilds
   * into the same team it built before.
   */
  shape?: TeamShape;
  /**
   * Set when the stored plan carried a shape this app cannot build.
   *
   * Absence of `shape` means "no shape chosen", which builds the chain
   * generated teams have always built. A malformed value is a different thing
   * and must not become that: the record still loads so the plan's agents are
   * not lost behind a 404, and this flag makes the build and the amendment
   * endpoint refuse by name rather than quietly building something else.
   */
  shapeRejected?: true;
  documentDomains?: ResourceTeamDocumentDomain[];
  existingAgents: ResourceTeamAgentPlan[];
  newAgents: ResourceTeamNewAgentPlan[];
  questionsResolved: string[];
}

export type { ResourceArchitectTranscriptTurn } from "./schemas/resource-architect-conversation.js";

export interface ResourceReferenceDocument {
  /** Full captured source for bounded host preparation; never rendered wholesale. */
  documentSource?: import('./document-reference.js').DocumentSource;
  name: string;
  content: string;
  /** The saved file revision, as the Team file store reports it. */
  uploadedAt?: string;
  /** When a chat first used this revision, from the store's usage ledger. */
  usedAt?: string;
}

export type CreateResourceRef =
  | { kind: "agent"; id: string }
  | { kind: "team"; id: string };

export interface ResourceStandaloneAgentsPlan {
  id: string;
  kind: "standalone_agents";
  agents: PlannedAgentSpec[];
}

export interface ResourceTeamCreationPlan {
  id: string;
  kind: "team";
  team: ResourceTeamPlan;
}

/** One skill action on one existing Agent. */
export interface ResourceSkillUpdate {
  action: "create" | "update";
  name: string;
  instruction: string;
}

export interface ResourceAddTeamAgentsFields {
  target: { kind: "team"; id: string };
  libraryAgentsToAdd: ResourceTeamAgentPlan[];
  newAgentsToCreate: ResourceTeamNewAgentPlan[];
}

export interface ResourceUpdateAgentSkillsFields {
  target: { kind: "agent"; id: string };
  skillUpdates: ResourceSkillUpdate[];
}

/**
 * What the model may propose. Every `expectedRevision` is absent here: the
 * model has no source revision in its prompt and must not choose one.
 */
export type ResourceUpdateOperationDraft =
  | ({ kind: "add_team_agents" } & ResourceAddTeamAgentsFields)
  | ({ kind: "update_agent_skills" } & ResourceUpdateAgentSkillsFields);

/** What the server persists, with the revision it calculated itself. */
export type ResourceUpdateOperation =
  | ({ kind: "add_team_agents"; expectedRevision: string } & ResourceAddTeamAgentsFields)
  | ({
      kind: "update_agent_skills";
      expectedRevision: string;
    } & ResourceUpdateAgentSkillsFields);

export interface ResourceUpdatePlanDraft {
  id: string;
  kind: "resource_updates";
  operations: ResourceUpdateOperationDraft[];
}

export interface ResourceUpdatePlan {
  id: string;
  kind: "resource_updates";
  operations: ResourceUpdateOperation[];
}

/** A plan the model produced, before the server materialized its revisions. */
export type ResourceArchitectPlanDraft =
  | ResourceStandaloneAgentsPlan
  | ResourceTeamCreationPlan
  | ResourceUpdatePlanDraft;

/** A persisted, buildable plan. */
export type ResourceArchitectPlan =
  | ResourceStandaloneAgentsPlan
  | ResourceTeamCreationPlan
  | ResourceUpdatePlan;

export type ResourceArchitectOperation = "conversation" | "proposal";

/** Every build item status, as a list the recovery rules can enumerate. */
export const RESOURCE_BUILD_ITEM_STATUSES = [
  "planned",
  "generating",
  "created",
  "reused",
  "updated",
  "needs_input",
  "interrupted",
  "failed",
  "cancelled",
] as const;

export type ResourceBuildItemStatus = (typeof RESOURCE_BUILD_ITEM_STATUSES)[number];

/**
 * The single definition of a published build item, so snapshot selection,
 * completion, and restart reconciliation cannot keep divergent lists.
 */
export function isPublishedResourceBuildItemStatus(
  status: ResourceBuildItemStatus,
): boolean {
  return status === "created" || status === "reused" || status === "updated";
}

export interface ResourceBuildItem {
  plannedResource: CreateResourceRef;
  resource?: CreateResourceRef;
  planIndex: number;
  status: ResourceBuildItemStatus;
  error?: string;
}

/**
 * Every build job status, as a list the recovery rules can enumerate.
 * `partially_completed` describes a job only; no single item is ever partly done.
 */
export const RESOURCE_BUILD_JOB_STATUSES = [
  "running",
  "interrupted",
  "partially_completed",
  "completed",
  "failed",
  "cancelled",
] as const;

export type ResourceBuildJobStatus = (typeof RESOURCE_BUILD_JOB_STATUSES)[number];

/**
 * Where one skill of an Agent update stands, apart from what it proposes.
 *
 * `create` or `update` is the proposed action and never a status. `staged`
 * means the generated bytes and their hash are recorded in the private
 * operation receipt while the live Agent is unchanged; `updated` means those
 * exact bytes reached the live Agent.
 */
export const RESOURCE_SKILL_UPDATE_STATUSES = [
  "planned",
  "generating",
  "staged",
  "updated",
  "interrupted",
  "failed",
  "cancelled",
] as const;

export type ResourceSkillUpdateStatus = (typeof RESOURCE_SKILL_UPDATE_STATUSES)[number];

/** The build events that describe one skill of an Agent update. */
export const RESOURCE_SKILL_UPDATE_EVENT_TYPES = [
  "skill_generating",
  "skill_staged",
  "skill_updated",
  "skill_failed",
  "skill_cancelled",
] as const;

export type ResourceSkillUpdateEventType = (typeof RESOURCE_SKILL_UPDATE_EVENT_TYPES)[number];

/** Which skill a skill-scoped build event is about, and what was proposed for it. */
export interface ResourceSkillUpdateIdentity {
  name: string;
  action: ResourceSkillUpdate["action"];
}

export function isResourceSkillUpdateEventType(
  type: ResourceBuildEventType,
): type is ResourceSkillUpdateEventType {
  return RESOURCE_SKILL_UPDATE_EVENT_TYPES.some((candidate) => candidate === type);
}

export type ResourceBuildEventType =
  | ResourceSkillUpdateEventType
  | "build_started"
  | "name_reserved"
  | "agent_generating"
  | "skill_repaired"
  | "agent_created"
  | "agent_reused"
  | "agent_needs_input"
  | "agent_failed"
  | "agent_cancelled"
  | "team_created"
  | "agent_added"
  | "team_renamed"
  | "resource_update_started"
  | "resource_update_applied"
  | "resource_update_conflict"
  | "resource_update_failed"
  | "resource_update_cancelled"
  | "build_completed"
  | "build_partially_completed"
  | "build_interrupted"
  | "build_cancelled"
  | "build_failed";

export interface ResourceBuildEvent {
  id: number;
  type: ResourceBuildEventType;
  plannedResource?: CreateResourceRef;
  resource?: CreateResourceRef;
  planIndex?: number;
  /** Present on exactly the skill-scoped event types, and on no other. */
  skill?: ResourceSkillUpdateIdentity;
  message: string;
}

/**
 * The one build a plan was approved for, recorded before that build starts.
 *
 * A plan id is not an authorization. The same plan can be submitted twice, and
 * without a durable record of which submission was admitted the second one
 * lands on the first one's job file — replacing a finished build with a new
 * attempt nobody asked for. This record is written inside the same critical
 * section that reads the plan, so exactly one submission can ever create it.
 *
 * It is stored apart from the plan on purpose. The plan's revision is a digest
 * of the plan record, so writing admission into that record would move the very
 * revision admission was granted against.
 */
export interface ResourcePlanAdmission {
  planId: string;
  /** The job this plan is admitted to build right now. */
  jobId: string;
  /** The plan revision the admitted card was rendered from. */
  revision: string;
  /**
   * The job ids this lineage has already used, oldest first.
   *
   * Retry starts a new attempt at the same admitted work, so it arrives with a
   * different job id and must still be told apart from an unrelated second
   * submission. It is recognised by the attempt it is retrying.
   */
  priorJobIds: string[];
  /**
   * The user threw away what this plan built.
   *
   * Recorded on the admission rather than only on the receipt that asked,
   * because one plan's lineage has many receipts and every one of them was a
   * route back: retrying any earlier attempt rebuilt the shell the user had
   * removed. The admission is what every submission passes through.
   */
  discarded?: true;
}

export interface ResourceBuildJobSnapshot {
  jobId: string;
  planId: string;
  /**
   * The digest of the plan this job was admitted against.
   *
   * A plan id alone does not identify what was approved. Publication records
   * the admitted plan and revision. Recovery requires that same identity;
   * retries of this lineage share it. Changed plan content cannot satisfy the
   * original admission.
   *
   * Absent on jobs written before this was recorded. Those are treated as
   * legacy on both sides rather than matched against a revision that was never
   * captured.
   */
  admittedRevision?: string;
  /**
   * When this build was admitted, as an ISO instant.
   *
   * A reopened Create has to choose which stopped build to put back on screen,
   * and job ids say nothing about order. Absent on jobs written before this was
   * recorded, which sort as the oldest.
   */
  startedAt?: string;
  /**
   * The user threw away what this build made.
   *
   * A decision, recorded durably: a discarded attempt is not offered for retry
   * and is not put back on screen when Create is reopened, so nothing can
   * rebuild the shell the user removed.
   */
  discarded?: true;
  status: ResourceBuildJobStatus;
  items: ResourceBuildItem[];
  selectedResource: CreateResourceRef | null;
  events: ResourceBuildEvent[];
  error?: string;
}

export interface ResourceArchitectDiscussionOutcome {
  kind: "discussion";
}

/**
 * A pointer that opens a resource the user named. It authorizes no write, so
 * it carries no revision: there is nothing for one to be checked against.
 */
export interface ResourceArchitectEditPointerOutcome {
  kind: "edit_existing";
  target: CreateResourceRef;
}

/** The outcome the provider normalizer produces, before materialization. */
export type ResourceArchitectTurnDraftOutcome =
  | ResourceArchitectPlanDraft
  | ResourceArchitectDiscussionOutcome
  | ResourceArchitectEditPointerOutcome;

/** The outcome the server returns and persists. */
export type ResourceArchitectTurnOutcome =
  | ResourceArchitectPlan
  | ResourceArchitectDiscussionOutcome
  | ResourceArchitectEditPointerOutcome;

export interface ResourceArchitectConversationResponse {
  operation: "conversation";
  message: string;
  warnings: string[];
  proposalRequested?: true;
}

export interface ResourceArchitectProposalResponse {
  operation: "proposal";
  message: string;
  outcome: ResourceArchitectTurnOutcome;
  warnings: string[];
}

/** The proposal shape the provider layer returns before materialization. */
export interface ResourceArchitectDraftProposalResponse {
  operation: "proposal";
  message: string;
  outcome: ResourceArchitectTurnDraftOutcome;
  warnings: string[];
}

export type ResourceArchitectTurnResponse =
  | ResourceArchitectConversationResponse
  | ResourceArchitectProposalResponse;

export type ResourceArchitectDraftTurnResponse =
  | ResourceArchitectConversationResponse
  | ResourceArchitectDraftProposalResponse;

export interface ResourceArchitectTimingContext {
  instructionsChars: number;
  operationChars: number;
  uploadedDocumentPolicyChars: number;
  visualizationPolicyChars: number;
  teamLibraryChars: number;
  agentLibraryChars: number;
  totalChars: number;
  historyChars: number;
}

export interface ResourceArchitectTurnTiming {
  contextAssemblyMs: number;
  providerDurationMs: number;
  processSpawnMs: number | null;
  firstProviderEventMs: number | null;
  firstTextMs: number | null;
  parseDurationMs: number;
  repairOccurred: boolean;
  repairDurationMs: number;
  totalDurationMs: number;
  context: ResourceArchitectTimingContext;
}

export interface ResourceArchitectTurnMeta {
  provider: string;
  model: string;
  /**
   * How this authoring turn's pair was decided.
   *
   * The Architect is an Agent like any other, so the operation that owns the
   * turn has to be able to say when it ran on the application default — from
   * what the turn recorded, not from Settings as they stand when someone
   * looks. A pair supplied for one authoring turn is the *user's* choice, and
   * is never recorded as the Architect's own.
   */
  selection?: ModelSelectionRecord;
  fallback: boolean;
  reason?: string;
  reasoning: ThinkingLevel;
  timing: ResourceArchitectTurnTiming;
  review?: ResourceArchitectFeedbackDiagnostics;
}

export type ResourceArchitectTurnHttpResponse = ResourceArchitectTurnResponse & {
  jobId: string;
  meta: ResourceArchitectTurnMeta;
};

export type ResourceArchitectTurnMetricStatus =
  /**
   * The turn has resolved its model and is running.
   *
   * Written before the provider is called, so a person can be told which model
   * is in use while it is in use, and so a crash before the reply still leaves
   * a record of what was running. Replaced in place by the terminal status.
   */
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * Sanitized, durable performance record. User prompts, model output, uploaded
 * documents, and provider credentials must never be added to this contract.
 */
export interface ResourceArchitectTurnMetric {
  schemaVersion: 1;
  recordedAt: string;
  jobId: string;
  operation: ResourceArchitectOperation;
  status: ResourceArchitectTurnMetricStatus;
  provider: string | null;
  model: string | null;
  /**
   * How that pair was decided, when the turn got far enough to decide one.
   *
   * provider/model alone cannot distinguish a pair the Architect Agent names
   * from the application default it fell back to, and the difference is the
   * whole point of the disclosure. Absent on a turn that failed before any
   * pair was resolved.
   */
  selection?: ModelSelectionRecord;
  reasoning: ThinkingLevel | null;
  outcomeKind: ResourceArchitectTurnOutcome["kind"] | null;
  fallback: boolean;
  errorCode?: string;
  timing: ResourceArchitectTurnTiming;
  review?: ResourceArchitectFeedbackDiagnostics;
}

/** Older plans have no internet recommendation and remain compatible. */
export function hasPlannedWebResearchChoice(plan: ResourceArchitectPlan): boolean {
  const agents = plan.kind === "standalone_agents" ? plan.agents
    : plan.kind === "team" ? plan.team.newAgents
    : plan.operations.flatMap((operation) => operation.kind === "add_team_agents" ? operation.newAgentsToCreate : []);
  return agents.some((agent) => agent.webResearchEnabled !== undefined);
}
