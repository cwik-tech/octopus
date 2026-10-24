/**
 * Type definitions for the agent-generator feature.
 *
 * Mirrors the shape exposed to the Create tab UI for the Agent Architect mode.
 * An agent is a folder under `agents/<name>/` containing a persona markdown
 * file, an `experience/scratch-pad.md`, and one or more `skills/<skill>/`
 * subfolders copied from an external skill source.
 */

import type { Diagnostic } from "./health.js";
import type { TeamShape } from "./schemas/team-shape.js";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

/** A final, plan-visible identity and brief for exact-name Agent creation. */
export interface PlannedAgentSpec {
  /** Proposed internet access; absent on older plans means disabled. */
  webResearchEnabled?: boolean;
  name: string;
  role: string;
  /**
   * One plain sentence for the proposal card, at most
   * `MAX_PLANNED_AGENT_SUMMARY_LENGTH` characters.
   *
   * The provider schema and the proposal parser require it on every newly
   * authored Agent. It is optional here because a plan saved before summaries
   * existed has none, and that record is read back unchanged. It is display
   * copy only: generation never reads it in place of `description`.
   */
  summary?: string;
  /**
   * The detailed generation brief the Agent generator builds the package from.
   * Do not render it as default card copy. The key keeps its old name so saved
   * plans, update receipts, and generation inputs stay compatible.
   */
  description: string;
  rationale: string;
}

/**
 * A planned Agent as a proposal authors it now: the card summary is required.
 * The provider schema and the proposal parser refuse a new Agent without one.
 */
export type AuthoredPlannedAgentSpec = PlannedAgentSpec & { summary: string };

/**
 * A planned Agent saved before card summaries existed.
 *
 * It is read back without one and never given a derived one on disk, because
 * the plan's revision and an update operation's identity are digests over the
 * stored record. Display copy for it is derived at the card instead.
 */
export type LegacyPlannedAgentSpec = Omit<PlannedAgentSpec, "summary"> & { summary?: never };

/**
 * What Agent generation reads: identity and the detailed build brief.
 *
 * The card summary is left out on purpose, so no brief renderer or fallback
 * skill can put the summary where the brief belongs.
 */
export type PlannedAgentGenerationInput = Omit<PlannedAgentSpec, "summary">;

export interface AgentSummary {
  /** Folder name under `agents/`. Also the basename of the persona MD file. */
  name: string;
  /** First-line `description` from the persona frontmatter, if present. */
  description?: string;
  /**
   * A grade the persona file still declares, if it declares one.
   *
   * Read-only compatibility. Nothing selects a model from it and nothing new
   * writes one; it is here so a reader can report what a file says.
   */
  tier?: string;
  /** Default runtime model from the persona frontmatter, if present. */
  model?: string;
  /** Default runtime provider from the persona frontmatter, if present. */
  provider?: string;
  /** Default thinking level from the persona frontmatter, if present. */
  thinking?: string;
  /** Names of the skill subfolders the agent owns (sorted, deduplicated). */
  skills: string[];
  /** Runtime teams whose team.yaml roster already references this agent. */
  usedInTeams: AgentTeamUsage[];
  /** True when the persona `tools:` list explicitly includes `browser`. */
  browserEnabled?: boolean;
  /** True when this runtime-only agent must not appear in app agent catalogs. */
  uiHidden?: boolean;
  /**
   * True when the runtime owns this agent's role but the user owns its
   * persona: never a Run target or a team member, always editable in Create.
   */
  system?: boolean;
}

/**
 * Whether the app may offer this agent as something a user picks.
 *
 * One predicate rather than one condition per catalog: the Run picker, the
 * schedule target list, the team roster and the architect's roster all have to
 * agree, and they drifted apart the last time each wrote its own check.
 */
export function isSelectableAgent(
  agent: Pick<AgentSummary, "uiHidden" | "system">,
): boolean {
  return agent.uiHidden !== true && agent.system !== true;
}

/**
 * `warning` exists for a fault that is real but expected to clear on its own,
 * such as a rate limit a run hit minutes ago. Without it such a state had to be
 * reported either as broken, which stops people using a provider that works, or
 * as fine, which sends them into a run that will fail.
 */
export type AgentProviderHealthStatus =
  | "ok"
  | "warning"
  | "error"
  | "unknown";

export interface AgentProviderHealth {
  agentName: string;
  provider?: string;
  model?: string;
  status: AgentProviderHealthStatus;
  message?: string;
  checkedAt: string;
  latencyMs?: number;
  /**
   * The classified reasons behind `status`, one per thing that is wrong.
   *
   * Optional on the type so a payload written before this field still parses;
   * every producer in this repository fills it. `summarizeAgentProviderHealth`
   * is the one reader, and it reconstructs diagnostics from `status` and
   * `message` when the field is absent.
   */
  diagnostics?: Diagnostic[];
  /**
   * That a failure an earlier run recorded for this provider and model has
   * been disproved by something this check saw.
   *
   * Separate from `status` because the two answer different questions. A
   * reading can disprove a stored usage limit and still leave the agent
   * warning, since an allowance at 90% is working and nearly gone at once.
   * A reader that retired the stored fact only when the badge came back green
   * would leave that failure on disk forever — and the Teams list, which reads
   * the stored view and never asks for an allowance, would go on reporting it
   * as blocked while the Agents list said otherwise.
   *
   * The value is when the disproved failure was observed, not a bare yes. A
   * check reads a snapshot and answers some milliseconds later, and a run can
   * fail in between; clearing by provider and model alone would throw that
   * newer failure away on the strength of evidence that predates it.
   */
  disprovedRuntimeFailureAt?: string;
  /**
   * That the provider itself answered a call during this check.
   *
   * The only evidence that an account works *now*. `status: "ok"` is not it:
   * for a CLI provider that status means the binary is installed and the model
   * is enabled in Settings, which is true of an account that ran out of credit
   * an hour ago. Anything that clears a stored failure on the strength of a
   * working provider has to read this, not the badge.
   */
  answeredLivePing?: boolean;
}

export interface AgentProviderHealthTarget {
  agentName: string;
  provider?: string;
  model?: string;
}

export type AgentAssetKind =
  | "template"
  | "reference"
  | "script"
  | "experience"
  | "knowledge"
  | "skill"
  | "other";

export interface AgentAssetFile {
  /** Repo-relative path, suitable for display. */
  path: string;
  /** Path relative to the selected agent folder. */
  agentPath: string;
  kind: AgentAssetKind;
  sizeBytes: number;
}

export interface AgentSkillDetail {
  name: string;
  path: string;
  description?: string;
  files: AgentAssetFile[];
  templateCount: number;
  referenceCount: number;
  scriptCount: number;
}

export interface AgentAssetCounts {
  skills: number;
  templates: number;
  references: number;
  scripts: number;
  experience: number;
  knowledge: number;
  other: number;
}

export interface AgentDetail extends AgentSummary {
  personaMarkdown: string;
  personaPath: string;
  agentPath: string;
  frontmatter: Record<string, string>;
  skillDetails: AgentSkillDetail[];
  assets: AgentAssetFile[];
  counts: AgentAssetCounts;
}

export interface AgentTeamUsage {
  teamId: string;
  teamName: string;
}

export interface AgentTeamOption {
  id: string;
  name: string;
  description?: string;
}

export interface AgentSkillUsage {
  name: string;
  usedByAgents: string[];
  usedByCount: number;
}

export interface AgentDeletePreview {
  agentName: string;
  skills: AgentSkillUsage[];
}

export interface AgentDeleteResult extends AgentDeletePreview {
  deleted: true;
  deleteSkills: boolean;
  deletedSkills: string[];
  preservedSkills: string[];
  preservedSkillPaths: string[];
}

export type AgentPackageAddKind =
  | "skill"
  | "template"
  | "reference"
  | "script"
  | "context";

export interface AgentPackageFileInput {
  relativePath: string;
  contentBase64: string;
}

export type AgentPackageRemoveMode = "disconnect" | "delete";

export type AgentPackageImportAction = "add" | "skip" | "replace" | "keepBoth";

export interface AgentPackageImportItem {
  id: string;
  kind: AgentPackageAddKind;
  label: string;
  sourcePath: string;
  targetAgentPath: string;
  parentSkill?: string;
  exists: boolean;
  defaultSelected: boolean;
  defaultAction: AgentPackageImportAction;
  availableActions: AgentPackageImportAction[];
}

export interface AgentPackageImportChoice {
  id: string;
  selected: boolean;
  action: AgentPackageImportAction;
}

/**
 * A retired per-grade model row, still read from legacy `team.yaml` files so
 * the field can be reported as ignored. Nothing resolves execution from it.
 */
export interface LegacyTeamModelSettings {
  model: string;
  thinking: string;
  provider?: string;
}

export interface TeamRosterAgent {
  name: string;
  type: "agent" | "team";
  role: string;
  /**
   * The grade this member already declares, where it declares one.
   *
   * Optional because authoring no longer produces it. Carried verbatim so a
   * re-render of the roster writes back what the file said rather than a
   * normalized substitute, and omitted entirely for a member written now.
   */
  tier?: string;
  tools: string[];
  agent_file?: string;
  /** Retired member override, read only so it can be reported as ignored. */
  legacyModel?: string;
  /** Retired member override, read only so it can be reported as ignored. */
  legacyProvider?: string;
  /**
   * Provider declared by the agent's own persona file, read live rather than
   * copied into `team.yaml`, so the roster shows what the Agents page shows.
   */
  personaProvider?: string;
  /** Model declared by the agent's own persona file. See `personaProvider`. */
  personaModel?: string;
  /**
   * The persona file this entry names is absent or unreadable. The runtime
   * skips such an entry, so it must not be presented as runnable.
   */
  personaMissing?: boolean;
  experience_enabled?: boolean;
  produces?: Array<{ path: string; description?: string }>;
  consumes?: Array<{ path: string; description?: string }>;
  referenced: boolean;
}

/**
 * The roster facts the Team catalog summary carries.
 *
 * Deliberately narrower than `TeamRosterAgent`: exactly the fields the shared
 * runtime-selection rule reads, and exactly what a reader of the catalog over
 * HTTP can prove about the payload. A summary must not claim the whole roster
 * contract on the strength of a partial check.
 */
export interface TeamRosterAgentRuntime {
  name: string;
  type: "agent" | "team";
  /** The grade this member declares, where it declares one. */
  tier?: string;
  /** The agent persona's own declaration — the only member-level input. */
  personaProvider?: string;
  personaModel?: string;
}

export interface TeamBuilderHealth {
  status: "ok" | "warning" | "error";
  /** Every error diagnostic's message, in order. Kept for older readers. */
  errors: string[];
  /** Every warning diagnostic's message, in order. Kept for older readers. */
  warnings: string[];
  /**
   * The same faults as `errors` and `warnings`, each carrying its severity,
   * its kind, and who it is about. `summarizeTeamBuilderHealth` reads this and
   * falls back to the two string arrays when it is absent.
   */
  diagnostics?: Diagnostic[];
}

export interface TeamBuilderSummary {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  agentCount: number;
  /** Authoritative configuration and local provider readiness for Run/Create. */
  health: TeamBuilderHealth;
  /** Complete individual-agent roster used by Team chat and mentions. */
  agentNames?: string[];
  /** Stage type of the level the team enters on — how a run of it actually starts. */
  entryStageType?: string;
  /**
   * The lead the entry level declares, present only when that level is a
   * discussion. Every other stage type runs its whole bench, so a reader that
   * found a lead here would advertise a selection that never happens.
   */
  discussionCoordinator?: string;
  /**
   * The configured roster, with each entry's runtime layers attached.
   *
   * Carried on the summary and not only on the detail, so a reader such as the
   * Run sidebar can resolve and show every member's provider and model before
   * the team has run once.
   */
  agents?: TeamRosterAgentRuntime[];
  /** Retired per-grade table, present only when a legacy file still holds one. */
  legacyModels?: Record<string, LegacyTeamModelSettings>;
  /** Retired team-wide provider, present only for a legacy file. */
  legacyDefaultProvider?: string;
  /**
   * Whether the team declares itself invocable directly by a person.
   * Teams that only declare `invocation_modes: [team]` or `user_facing: false`
   * expect a caller to prepare their inputs, so they are not offered in chat.
   */
  userInvocable?: boolean;
  /**
   * The digest of the `team.yaml` bytes this row was read from: the value the
   * detail's `revision` reports for the same bytes. A write that names it is
   * refused once the file has moved on. Absent when the file could not be read.
   */
  revision?: string;
}

export interface TeamBuilderDetail extends TeamBuilderSummary {
  teamPath: string;
  yaml: string;
  agents: TeamRosterAgent[];
  warnings: string[];
  /**
   * How this team works together, when the file says so in a form this app
   * wrote. Absent for a team it did not write, so the editor offers nothing to
   * change rather than offering to rewrite a file it does not understand.
   */
  shape?: TeamShape;
  /**
   * The digest of the file these values were read from.
   *
   * Every change is written against it, so an edit made from a stale editor
   * fails instead of overwriting whoever wrote first.
   */
  revision: string;
}

export interface TeamBuilderUpsertInput {
  id: string;
  description?: string;
  tags?: string[];
  /** Stable planned-Agent ownership marker used to resume interrupted builds. */
  orchestratorKey?: string;
  /**
   * How the members work together. Optional, and absent means the chain every
   * generated team emitted before shapes existed, so a caller that predates
   * this field keeps its behaviour byte for byte.
   */
  shape?: TeamShape;
  /**
   * The build that owns this team has still to finish.
   *
   * An unfinished team is visible to its builder and to nobody else: its roster
   * is half-assembled and its stage may name members that do not exist yet.
   */
  building?: boolean;
}

export interface SkillTreeNode {
  /** Display label for the node (folder basename). */
  label: string;
  /** Absolute filesystem path. */
  path: string;
  /** A leaf — a folder containing a SKILL.md. */
  isSkill: boolean;
  /** Children — non-empty for intermediate folders. */
  children?: SkillTreeNode[];
}

export interface DuplicateAgentMatch {
  /** Name of the agent in `agents/` that already wraps this exact skill set. */
  existingAgentName: string;
}

export interface GeneratedSkill {
  /** Kebab-case folder name for the skill. */
  name: string;
  /** Full SKILL.md markdown body, including YAML frontmatter. */
  body: string;
}

export interface DraftAgentRequest {
  /** Absolute paths of skill folders the new agent should own. Empty when inventing skills from chat. */
  skillPaths: string[];
  /** Conversation history from the center-pane chat. May be empty. */
  chatHistory: ChatTurn[];
  /**
   * Caller policy on duplicates. If undefined and a duplicate is found, the
   * response will contain `duplicate` rather than a draft.
   */
  duplicatePolicy?: "overwrite" | "duplicate";
  /** Optional per-turn model override; falls back to the architect config. */
  provider?: string;
  model?: string;
}

export interface DraftAgentSuccess {
  duplicate?: undefined;
  needsInput?: undefined;
  /** LLM-suggested kebab-case agent name. */
  suggestedName: string;
  /** Persona markdown including YAML frontmatter. */
  personaMarkdown: string;
  /** Newly invented skills when no existing skills were selected. */
  generatedSkills?: GeneratedSkill[];
  meta: {
    model: string;
    fallback: boolean;
    reason?: string;
  };
}

export interface DraftAgentDuplicate {
  duplicate: DuplicateAgentMatch;
}

export interface DraftAgentNeedsInput {
  needsInput: true;
  message: string;
}

export type DraftAgentResponse =
  | DraftAgentSuccess
  | DraftAgentDuplicate
  | DraftAgentNeedsInput;

export interface CommitAgentRequest {
  /** Final agent folder name (already approved by the user). */
  approvedName: string;
  /** Persona markdown to write at `agents/<approvedName>/<approvedName>.md`. */
  personaMarkdown: string;
  /** Source skill folders to copy into `agents/<approvedName>/skills/`. */
  skillPaths: string[];
  /** Newly invented skills to write into `agents/<approvedName>/skills/`. */
  generatedSkills?: GeneratedSkill[];
  /** If true, replace any existing agent folder at the target path. */
  overwrite?: boolean;
}

export interface CommitAgentResult {
  agentName: string;
  agentFolderPath: string;
  personaPath: string;
  importedSkills: string[];
  generatedSkills?: string[];
}

export interface RefineAgentRequest {
  agentName: string;
  currentPersona: string;
  chatHistory: ChatTurn[];
  /** Optional per-turn model override; falls back to the architect config. */
  provider?: string;
  model?: string;
}

export interface RefineAgentResult {
  personaMarkdown: string;
  message: string;
  meta: {
    model: string;
    fallback: boolean;
    reason?: string;
  };
}

export interface DraftAgentHttpSuccess extends DraftAgentSuccess {
  jobId: string
  cancelled?: undefined
}

export interface DraftAgentHttpDuplicate extends DraftAgentDuplicate {
  jobId: string
  cancelled?: undefined
}

export interface DraftAgentHttpNeedsInput extends DraftAgentNeedsInput {
  jobId: string
  cancelled?: undefined
}

export interface DraftAgentHttpCancelled {
  jobId: string
  cancelled: true
}

export type DraftAgentHttpResponse =
  | DraftAgentHttpSuccess
  | DraftAgentHttpDuplicate
  | DraftAgentHttpNeedsInput
  | DraftAgentHttpCancelled

export interface RefineAgentHttpResult extends RefineAgentResult {
  jobId: string
  cancelled?: false
}

export interface RefineAgentHttpCancelled {
  jobId: string
  cancelled: true
}

export type RefineAgentHttpResponse =
  | RefineAgentHttpResult
  | RefineAgentHttpCancelled
