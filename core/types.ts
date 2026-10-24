/**
 * Team Runtime — Shared Type Definitions
 *
 * All types that flow through the generic team runtime system.
 * Covers config (parsed from team.yaml), runtime state, engine state,
 * and agent interfaces.
 */

import type { ProviderErrorKind } from '../contracts/provider.js'
import type { AgentQuestionContext, AgentQuestionInterruption } from '../contracts/agent-questions.js'
import type { ReviewQuestionPhase } from '../contracts/review-question-phase.js'
import type { BroadcastSettledSlot, PipelineQuestionTaskIds } from '../contracts/agent-question-engine-progress.js'
import type { TSchema } from 'typebox'
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  BudgetDispatchAdmission,
  BudgetLedger,
  BudgetPolicy,
} from './budget-ledger.js'
import type {
  AgentModelDiagnostic,
  ModelSelection,
  ModelSelectionError,
  ModelSelectionRecord,
} from '../contracts/agent-model-selection.js'
import type { HostEntryAdmission } from '../contracts/host-entry-admission.js'
import type { WorkerTurnFailure } from '../contracts/worker-turn-failure.js'
import {
  STAGE_TYPE,
  DISCUSSION_MODE,
  LEVEL_STATUS,
  STAGE_LIFECYCLE_STATUS,
  AGENT_STATE,
  AGGREGATION_MODE,
  GATE_STRICTNESS,
} from './constants.js'
import type { RunAssignmentLocation } from './run-assignment-location.js'
import type { ProviderProtocolEvent } from '../contracts/provider.js'

type WorkflowStageType = (typeof STAGE_TYPE)[keyof typeof STAGE_TYPE]

// ─── Team Config Types (parsed from team.yaml) ─────────────────────────────

export interface TeamConfig {
  team: TeamMeta
  workspace: WorkspaceConfig
  workflow?: WorkflowTemplateConfig
  /** Retired team-wide provider, read only so it can be reported as ignored. */
  defaults?: TeamDefaultsConfig
  composition?: TeamCompositionConfig
  /** Retired per-grade table, present only when a legacy file declares one. */
  legacyModels?: Record<string, LegacyModelConfig>
  levels: LevelConfig[]
  gates: GateConfig[]
  agents: AgentRosterEntry[]
  rateLimiting?: RateLimitConfig
  budget?: SessionBudgetConfig
}

export interface TeamMeta {
  name: string
  description: string
  version: string
  /**
   * The team's build has not finished, so it cannot be run yet.
   *
   * Read by every delegated launch through `resolveChildTeamContract`. Absent
   * on every team that was finished, and on every team that predates the
   * marker, so absence means runnable.
   */
  building?: boolean
}

export interface WorkspaceConfig {
  path: string
  watch: boolean
  routing_agent?: string
  external_watches?: ExternalWatch[]
}

export interface WorkflowTemplateConfig {
  entry_level?: string
  capabilities?: string[]
  invocation_modes?: Array<'user' | 'external' | 'team'>
  user_facing?: boolean
  input_contract?: StageInputContract
  output_contract?: StageOutputContract
}

export interface TeamDefaultsConfig {
  provider?: string
}

export interface ExternalWatch {
  path: string
  label: string
  notify: string
}

export interface TeamCompositionConfig {
  team_registry?: string
  registry_entries?: RegistryEntry[]
  spawn_limits?: SpawnLimits
}

/**
 * A retired models-by-tier row.
 *
 * Read from legacy `team.yaml` files so the field can be reported as ignored.
 * Nothing resolves an execution from it: an agent runs with its own
 * provider/model, or with the one application default.
 */
export interface LegacyModelConfig {
  model: string
  thinking: ThinkingLevel
  context?: string
  provider?: string
  provider_config?: Record<string, unknown>
}

/**
 * The effort vocabulary, defined once as a leaf contract.
 *
 * Re-exported here because `ThinkingLevel` is part of this module's public
 * shape and backend importers reach for it through this module. The
 * definition lives in `contracts/thinking-levels.ts` so
 * the editor can read the same list without importing the backend.
 */
export {
  THINKING_LEVELS,
  PROVIDER_DEFAULT_THINKING,
  isThinkingLevel,
  readThinkingLevel,
} from '../contracts/thinking-levels.js'
export type { EffortLevel, ThinkingLevel } from '../contracts/thinking-levels.js'
import type { ThinkingLevel } from '../contracts/thinking-levels.js'

export interface LevelConfig {
  id: string
  name: string
  order: number
  stage: StageConfig
  permissions?: LevelPermissions
}

export interface LevelPermissions {
  spawn_teams?: boolean
  loopback?: string[]
}

export type StageConfig =
  | RoutingStageConfig
  | DiscussionStageConfig
  | PipelineStageConfig
  | ChainStageConfig
  | BroadcastStageConfig
  | ReviewStageConfig

// ─── Routing Stage ──────────────────────────────────────────────────────────

export interface RoutingStageConfig {
  type: typeof STAGE_TYPE.ROUTING
  coordinator: string
  config: {
    constraints?: ConstraintConfig
    output: OutputConfig
    input_contract?: StageInputContract
    output_contract?: StageOutputContract
  }
}

// ─── Discussion Stage ───────────────────────────────────────────────────────

export interface DiscussionStageConfig {
  type: typeof STAGE_TYPE.DISCUSSION
  coordinator: string
  participants: string[]
  config: {
    mode: DiscussionMode
    min_rounds: number
    max_rounds: number
    min_successful_participants?: number
    constraints: ConstraintConfig
    output: OutputConfig
    on_agent_failure?: 'retry' | 'fallback' | 'skip' | 'halt'
    context_strategy?: ContextStrategy
    context_window_rounds?: number
    summarize_after_rounds?: number
    input_contract?: StageInputContract
    output_contract?: StageOutputContract
  }
}

export type DiscussionMode = typeof DISCUSSION_MODE[keyof typeof DISCUSSION_MODE]

// ─── Context Strategy ───────────────────────────────────────────────────────

export type ContextStrategy = 'full' | 'recent_N' | 'rolling_summary'

// ─── Pipeline Stage ─────────────────────────────────────────────────────────

export interface PipelineStageConfig {
  type: typeof STAGE_TYPE.PIPELINE
  coordinator?: string
  participants?: string[]
  config: {
    plan_file?: string
    /** Optional immutable machine-readable plan used to authorize task overlays. */
    plan_artifact?: string
    /** Resolve plan_file from the assignment without enabling a research task overlay. */
    run_owned_plan?: boolean
    /** Persist each successful agent response to its declared result file. */
    persist_result?: boolean
    /** Serial remains the compatibility default; bounded_parallel drains ready tasks in waves. */
    execution_mode?: 'serial' | 'bounded_parallel'
    /** Maximum ready tasks dispatched in one bounded_parallel wave. */
    max_concurrency?: number
    /** Task scope derives each worker output directory from its declared result file. */
    assignment_scope?: 'stage' | 'task'
    /** Optional runtime-owned deadline contract shared across Deep Research stages. */
    deadline_artifact?: string
    /**
     * Deep Research section drafting. The dossier index assigns each task's
     * declared result file its evidence, and the approved plan is what both
     * the index and the dossier must belong to. Its presence turns a task
     * whose result file the index claims into a section draft: the runtime
     * materializes that section's evidence into the request and validates the
     * answer before persisting it.
     */
    section_dossier_drafting?: {
      plan_artifact: string
      dossier_index_artifact: string
      context_window_tokens: number
      output_reserve_tokens: number
    }
    parallel: boolean
    constraints?: ConstraintConfig
    gate: {
      type: 'validation' | 'all_tasks_terminal' | 'artifact_exists'
      strictness: GateStrictness
      quality_checks?: string[]
    }
    on_agent_failure?: 'retry' | 'fallback' | 'skip' | 'halt'
    input_contract?: StageInputContract
    output_contract?: StageOutputContract
  }
}

// ─── Chain Stage ────────────────────────────────────────────────────────────

export interface ChainStageConfig {
  type: typeof STAGE_TYPE.CHAIN
  coordinator?: string
  sequence: string[]
  config: {
    handoff_format?: string
    /** Keep the immutable entry artifact visible to later chain steps. */
    preserve_initial_input?: boolean
    /** Optional runtime validator for a machine-readable final chain artifact. */
    structured_output?: 'deep_research_quality_verdict'
    /** Optional runtime-owned deadline contract shared across Deep Research stages. */
    deadline_artifact?: string
    /**
     * Deep Research report synthesis: build the chain's entry content as one
     * runtime-owned bundle — approved plan context, evidence index, validated
     * section drafts — and admit it against this budget before dispatch,
     * instead of handing the step whichever declared input artifact exists.
     */
    research_synthesis_bundle?: {
      plan_artifact: string
      dossier_index_artifact: string
      synthesis_artifact: string
      /** Optional active correction context; absent on the first synthesis wave. */
      corrections_artifact?: string
      context_window_tokens: number
      output_reserve_tokens: number
    }
    /**
     * Deep Research quality review: resolve the critic's authoritative inputs
     * inside the current assignment and materialize them into the request.
     */
    research_quality_bundle?: {
      plan_artifact: string
      quality_packet_artifact: string
      deterministic_verdict_artifact: string
      report_artifact: string
      context_window_tokens: number
      output_reserve_tokens: number
    }
    constraints?: ConstraintConfig
    output: OutputConfig
    on_agent_failure?: 'retry' | 'fallback' | 'skip' | 'halt'
    input_contract?: StageInputContract
    output_contract?: StageOutputContract
  }
}

// ─── Broadcast Stage ────────────────────────────────────────────────────────

export interface BroadcastStageConfig {
  type: typeof STAGE_TYPE.BROADCAST
  coordinator?: string
  fan_out: string[]
  config: {
    aggregation: AggregationMode
    constraints?: ConstraintConfig
    output: OutputConfig
    on_agent_failure?: 'retry' | 'fallback' | 'skip' | 'halt'
    input_contract?: StageInputContract
    output_contract?: StageOutputContract
  }
}

export type AggregationMode = typeof AGGREGATION_MODE[keyof typeof AGGREGATION_MODE]

// ─── Review Stage ───────────────────────────────────────────────────────────

export interface ReviewStageConfig {
  type: typeof STAGE_TYPE.REVIEW
  coordinator?: string
  producer: string
  reviewer: string
  config: {
    max_iterations: number
    on_max_iterations?: 'block' | 'approve_latest' | 'approve_latest_with_warnings' | 'escalate_to_user'
    /**
     * Behavior when the reviewer agent is skipped under a 'skip' failure policy.
     * - 'approve_latest': explicitly allow the current draft with a warning.
     * - 'fail' (default): block the iteration and preserve the review guarantee.
     */
    on_reviewer_skip?: 'approve_latest' | 'fail'
    constraints?: ConstraintConfig
    research_publication_validation?: {
      source_artifact: string
      evidence_graph_artifact?: string
      audit_artifact: string
    }
    output: OutputConfig
    on_agent_failure?: 'retry' | 'fallback' | 'skip' | 'halt'
    input_contract?: StageInputContract
    output_contract?: StageOutputContract
  }
}

// ─── Shared Stage Sub-types ─────────────────────────────────────────────────

/**
 * Stage-level constraints.
 *
 * The `enforce` and `on_exceed` keys were removed from the public schema because
 * they were never wired to any runtime behaviour, and are now rejected at parse
 * time — see docs/adr/2026-08-21-Stage-Constraint-Schema-Removal.md. What remains
 * is a mix, and the difference matters:
 *
 * - `agent_timeout_minutes` and `max_time_minutes` are **consumed**.
 * - `max_budget_usd` is **advisory only** — no code enforces it. Real spend
 *   control is the top-level `budget` section (SessionBudgetConfig).
 */
export interface ConstraintConfig {
  /**
   * Wall-clock budget for the stage, in minutes.
   *
   * Not purely advisory: `team-runtime/index.ts:1590-1593` passes this to
   * `runAgent` as `timeoutMinutes` for the delegated routing coordinator, and
   * `core/constraints.ts:25` derives the time-remaining warning from it. Also
   * drives the dashboard progress bar.
   */
  max_time_minutes: number
  /**
   * Spend guidance for the stage, in USD. **Advisory only — nothing enforces
   * it.** Surfaced through `{{CONSTRAINTS}}`, the constraint-status block and
   * the dashboard bar. Use the top-level `budget` section to actually cap spend.
   */
  max_budget_usd: number
  /** Per-dispatch subprocess timeout in minutes. Enforced by every engine. */
  agent_timeout_minutes?: number
}

export interface SessionBudgetConfig {
  /** Maximum budget for this session in USD. */
  cap_usd: number
  /** When true, enforce as a dispatch boundary. When false, advisory only. */
  enforce: boolean
  /** What to do when cap is exceeded. */
  on_exceed: 'halt' | 'warn'
}

export interface OutputConfig {
  format: string
  path?: string
  /** When true (default), the coordinator presents a draft report to the user for feedback before finalizing. */
  user_review: boolean
}

export interface StageArtifactContract {
  path: string
  required?: boolean
  description?: string
}

export interface StageStructuredContract {
  schema?: string
  description?: string
}

export interface StageInputContract {
  artifacts?: StageArtifactContract[]
  structured?: StageStructuredContract
}

export interface StageOutputContract {
  artifacts?: StageArtifactContract[]
  structured?: StageStructuredContract
  completion_artifact?: string
}

export type GateStrictness = typeof GATE_STRICTNESS[keyof typeof GATE_STRICTNESS]

// ─── Gates ──────────────────────────────────────────────────────────────────

/** The single canonical value for a terminal gate target (no next level). */
export const TERMINAL_GATE = 'done'

/** Check whether a gate target is the terminal marker. */
export function isTerminalGate(target: string): boolean {
  return target === TERMINAL_GATE
}

export interface GateTransform {
  type: 'script' | 'agent'
  strictness?: GateStrictness  // optional — inherits from gate if omitted
  // script transform
  script?: string
  // agent transform (stubbed)
  agent?: string
  prompt?: string
  // shared
  input?: string   // input artifact filename
  output?: string  // output artifact filename or path
  timeout_minutes?: number
}

export interface GateConfig {
  from: string
  to: string
  condition: GateCondition
  transform?: GateTransform
  /** Controls which completed stages are reset when this gate loops backward. */
  reset_scope?: 'target' | 'target_through_source'
  /** Per-route correction cap. Falls back to DEFAULT_MAX_LOOPBACKS when omitted. */
  max_loopbacks?: number
}

export type GateCondition =
  | { type: 'artifact_exists'; artifact: string }
  | { type: 'validation'; validator: string; strictness: GateStrictness }
  | { type: 'all_tasks_terminal' }
  | { type: 'manual'; permission: string[] }
  | { type: 'artifact_content'; artifact: string; match: string; match_type?: 'contains' | 'regex' }
  | { type: 'agent_verdict'; validator: string; verdict: string }
  | {
      type: 'artifact_json'
      artifact: string
      pointer: string
      operator: 'equals'
      value: string | number | boolean | null
    }

export interface GateResult {
  passed: boolean
  reason: string
  boundary_artifacts?: string[]
  transformed_artifact?: string
}

// ─── Failure Recovery Types ─────────────────────────────────────────────────

export interface AgentFailurePolicy {
  policy: 'retry' | 'fallback' | 'skip' | 'halt'
  max_retries?: number
  fallback_agent?: string
}

export interface AgentErrorEvent {
  timestamp: string
  root_session_id?: string
  session_id: string
  level_id: string
  agent_name: string
  attempt: number
  max_attempts: number
  policy: string
  error_message: string
  error_type: 'agent_failure' | 'fallback_failure' | 'halt' | 'skipped'
  fallback_agent?: string
  duration_ms: number
}

export type DelegationResultStatus =
  | 'queued'
  | 'validating_contract'
  | 'accepted'
  | 'running'
  | 'waiting_on_stage'
  | 'waiting_on_child'
  | 'completed'
  | 'completed_with_warnings'
  | 'blocked'
  | 'failed'
  | 'timed_out'

export interface TeamInvocationContract {
  job_id: string
  parent_job_id?: string
  root_job_id?: string
  caller_team: string
  target_team: string
  requested_capability?: string
  requested_result_type: string
  input_payload: string
  input_artifact_refs?: string[]
  constraints?: {
    budget_usd?: number
    timeout_minutes?: number
  }
  lineage_metadata?: Record<string, string>
}

export interface TeamResultContract {
  job_id: string
  parent_job_id?: string
  root_job_id?: string
  team: string
  result_type: string
  status: Exclude<DelegationResultStatus, 'queued' | 'validating_contract' | 'accepted' | 'running' | 'waiting_on_stage' | 'waiting_on_child' | 'timed_out'>
  primary_artifact?: string
  secondary_artifacts?: string[]
  structured_payload?: Record<string, unknown>
  issues?: string[]
  diagnostics?: string[]
  lineage?: Record<string, string>
}

export interface DelegationStatusSnapshot {
  jobId: string
  parentJobId?: string
  rootJobId?: string
  delegationId: string
  fromTeam: string
  fromLevel: string
  fromAgent: string
  toTeam: string
  requestedResultType: string
  childSessionId?: string
  childAssignmentPath?: string
  briefArtifact?: string
  resultArtifact?: string
  startedAt: string
  status: DelegationResultStatus
  activeLevel?: string
  activeStageType?: string
  stageStatus?: string
  lastArtifact?: string
  blockedReason?: string
  failureReason?: string
  lastEventAt?: string
}

/**
 * A dispatch's terminal failure, as codes.
 *
 * Deliberately the same vocabulary the conversation journal uses, so one
 * policy can read either. `phase` is how far the attempt got, which is what
 * decides whether anything could have run.
 */
export interface AgentRunFailure {
  readonly phase:
    | 'provider-resolution'
    | 'tool-discovery'
    | 'provider-request'
    | 'tool-execution'
    | 'artifact-publication'
  /** The runtime's own stable code, e.g. `provider_failed`. */
  readonly serviceCode: string
  /** The normalized provider error kind, when one was recognized. */
  readonly providerKind?: string
  /** The provider's own error code, when it stated one. */
  readonly providerCode?: string
  readonly httpStatus?: number
  readonly retryable: boolean
  /**
   * Whether the attempt had sent anything when it failed.
   *
   * `false` means the adapter refused before making the request, which is the
   * one positive fact about effects this runtime has. Absent means unknown,
   * and unknown refuses a retry. Nothing about the persona's tool list can
   * stand in for it: the MCP worker route chooses its own grants and can run a
   * native tool loop whatever the persona declares.
   */
  readonly dispatched?: boolean
  /**
   * Where a parent worker turn failed, when the parent reported no category
   * of its own: a closed stage, with only a Node error code or a status beside
   * it. Never the worker URL, its path token, a header, a body or a message.
   */
  readonly workerTurn?: WorkerTurnFailure
}

export interface AgentRunEvent {
  timestamp: string
  event: 'start' | 'end' | 'fail' | 'skip'
  session_id: string
  root_session_id?: string
  assignment_path: string
  team: string
  level_id?: string
  stage_type?: string
  trigger_tool?: string
  agent_name: string
  /** Unique runtime actor, such as a Deep Research lane id. */
  agent_id?: string
  /** User-facing role for this specific runtime actor. */
  agent_display_name?: string
  /** Runtime activity scope used to correlate tool and artifact events. */
  activity_scope_id?: string
  agent_type: 'agent' | 'team'
  from?: string
  to?: string
  input_artifact?: string
  output_artifact?: string
  status?: string
  /**
   * Why the provider refused, when this run failed because one did.
   *
   * `status` holds whatever the thrown error said, which can be a transport
   * sentence, a child's stderr, or an absolute path — so a surface that must
   * not show provider text cannot use it, and had nothing else to offer. This
   * is a closed union the same surfaces can render into their own copy.
   */
  provider_failure_kind?: ProviderErrorKind
  duration_ms?: number
  model?: string
  provider?: string
  model_selection?: ModelSelectionRecord
  /**
   * Why a dispatch failed, in codes rather than prose.
   *
   * Present on `fail`. The `status` field carries the message a person reads;
   * this is what a reader can act on — deciding whether a user may be offered
   * a retry needs the failure's kind and the phase it reached, and a sentence
   * is not evidence. Paired with `dispatch_id` so a run where one agent spoke
   * twice can tell its two failures apart.
   */
  failure?: AgentRunFailure
  child_session_id?: string
  /**
   * The display-only text channel this run's participant output goes to.
   *
   * Recorded deliberately: reading the channel still requires the session that
   * owns it, so the id grants nothing on its own, and having it on the event
   * is what lets the UI find the stream from the run it is already watching.
   * The child's posting credential is a separate value and is never recorded
   * here, in an engine event, or on disk.
   */
  text_channel_id?: string
  /**
   * This concrete attempt. One bubble in the channel belongs to one
   * `dispatch_id`, which is what lets a retry supersede the attempt before it
   * instead of appending to it.
   */
  dispatch_id?: string
  /**
   * The logical step this attempt belongs to.
   *
   * Stable across retries and across a fallback that runs a different agent,
   * so the UI can tell that a later attempt replaces an earlier one rather
   * than speaking alongside it.
   */
  logical_invocation_id?: string
}

export interface ProviderEvent {
  timestamp: string
  provider: string
  event: string
  model?: string
  agent_name?: string
  session_id?: string
  root_session_id?: string
  assignment_path?: string
  request_id?: string
  model_instance_id?: string
  progress?: number
  status?: 'started' | 'streaming' | 'completed' | 'failed'
  detail?: string
  raw?: Record<string, unknown>
}

// ─── Roster Entry Slim (used by engines) ────────────────────────────────────

/**
 * A minimal projection of AgentRosterEntry used in engine context interfaces.
 * Defined once here to avoid inline type duplication across all 5 engine files.
 */
export type RosterEntrySlim = {
  type: 'agent' | 'team'
  role?: string
  team_path?: string
  input_artifact?: string
  output_artifact?: string
  host_model?: string
  host_provider?: string
  mount?: Array<{ from: string; to: string }>
  on_failure?: AgentFailurePolicy
}

// ─── Rate Limiting ──────────────────────────────────────────────────────────

export interface RateLimitConfig {
  maxConcurrent: number
  delayBetweenMs: number
}

export interface RateLimiterInterface {
  acquire(): Promise<void>
  release(): void
  run<T>(fn: () => Promise<T>): Promise<T>
  readonly active: number
  readonly pending: number
}

/**
 * Immutable workflow feedback forwarded to a successor Team runtime.
 * Kept in Core because the runtime must not depend on transport contracts.
 */
export interface HumanInputRoutingContext {
  interactionId: string
  source: string
  messages: Array<{
    id: string
    text: string
    recipients: 'all' | string[]
  }>
}

// ─── Base Engine Context ─────────────────────────────────────────────────────

/**
 * Common fields shared by all 5 engine context interfaces.
 * Each engine's context interface extends this with its extra fields.
 * Eliminates the ~90% field duplication across DiscussionContext, PipelineContext, etc.
 */
export interface BaseEngineContext<TConfig extends StageConfig = StageConfig> {
  teamName?: string
  teamConfig: TeamConfig
  config: TConfig
  levelId: string
  teamRootPath: string
  agents: Map<string, LoadedAgent>
  rosterEntries: Map<string, RosterEntrySlim>
  state: RuntimeState
  workspacePath: string
  outputPath: string
  inputFilesContent: string
  /** Frozen workflow feedback selectively supplied to discussion participants. */
  humanInputRouting?: HumanInputRoutingContext
  agentMetrics: Map<string, AgentMetrics>
  onDashboardUpdate?: () => void
  /** Stage-level on_agent_failure override (blanket control for all agents in this stage). */
  stageFailureOverride?: 'retry' | 'fallback' | 'skip' | 'halt'
  /** Rate limiter instance for throttling concurrent agent dispatches. */
  rateLimiter?: RateLimiterInterface
  /** B2: Master shutdown signal — abort to kill all active dispatches. */
  shutdownSignal?: AbortSignal
  /** B4: Budget enforcement ledger — undefined means no budget cap. */
  budgetLedger?: BudgetLedger
  /** Adopt the dispatcher-owned envelope budget before engine side effects. */
  adoptCapabilityBudget?: (toolCallId: string) =>
    BudgetDispatchAdmission | undefined
  /** True only for a replacement process explicitly authorized to resume this child run. */
  recoveryMode?: boolean
  /** True in a headless delegated child run, where no user turn is available. */
  delegatedAutostart?: boolean
  /**
   * True when this Team was launched from Run chat rather than from a workflow.
   *
   * Supplied by the runtime shell so engine logic never reads process-global
   * state to answer it, and so a test can put an engine in chat mode without
   * mutating the environment of everything else in the process.
   */
  chatMode?: boolean
}

// ─── Agent Roster ───────────────────────────────────────────────────────────

export interface ArtifactDeclaration {
  path: string          // relative path, e.g. 'research/brief.md' or 'output.md'
  description?: string  // human-readable description
}

export interface RegistryEntryBase {
  name: string
  type: 'agent' | 'team'
  description?: string
  tags?: string[]
}

export interface TeamRegistryEntry extends RegistryEntryBase {
  type: 'team'
  team_path: string
  input_artifact?: string
  output_artifact?: string
  requested_capability?: string
  mount?: Array<{ from: string; to: string }>
  host_model?: string
  host_provider?: string
}

export interface AgentRegistryEntry extends RegistryEntryBase {
  type: 'agent'
  role: string
  /**
   * A grade the file already declares, kept exactly as written.
   *
   * Nothing reads it and nothing new writes one. It is not an `AgentTier`,
   * because a file authored elsewhere can hold a word the runtime never had —
   * `specialist`, for instance — and calling that a tier would be a claim this
   * parser cannot make.
   */
  tier?: string
  agent_file: string
  tools?: string[]
  model?: string
  provider?: string
  provider_config?: Record<string, unknown>
}

export type RegistryEntry = TeamRegistryEntry | AgentRegistryEntry

export interface AgentRosterEntry {
  name: string
  type: 'agent' | 'team'
  role: string
  /** A grade the roster already declares, kept as written. See above. */
  tier?: string
  agent_file: string
  tools?: string[]
  experience_file?: string
  experience_enabled?: boolean
  color?: number
  /** Retired member override, read only so it can be reported as ignored. */
  legacyModel?: string
  /** Retired member override, read only so it can be reported as ignored. */
  legacyProvider?: string
  /** Retired member provider options, read only so they can be reported. */
  legacyProviderConfig?: Record<string, unknown>
  team_path?: string
  input_artifact?: string
  output_artifact?: string
  host_model?: string
  host_provider?: string
  mount?: Array<{ from: string; to: string }>
  produces?: ArtifactDeclaration[]
  consumes?: ArtifactDeclaration[]
  on_failure?: AgentFailurePolicy
}

// ─── Loaded Agent (runtime) ─────────────────────────────────────────────────

export interface LoadedAgent {
  name: string
  /** The selected model, or '' when selection failed. Read `selection`. */
  model: string
  thinking: ThinkingLevel
  tools?: string[]
  systemPrompt: string
  experienceContent: string
  experienceEnabled: boolean
  skillsContent: string
  knowledgeContent: string
  agentDir: string
  color: number
  /** The selected provider, or '' when selection failed. */
  provider: string
  providerConfig?: Record<string, unknown>
  /**
   * How this agent's provider/model was decided: its own explicit choice or
   * the one application default. `null` when no pair could be selected, in
   * which case `selectionError` says why. Preflight turns that into a startup
   * error rather than letting some other model be substituted.
   */
  selection: ModelSelection | null
  selectionError?: ModelSelectionError
  /** Legacy configuration shapes that were reinterpreted while reading. */
  selectionDiagnostics?: readonly AgentModelDiagnostic[]
}

// ─── Agent Run Types ────────────────────────────────────────────────────────

export type GovernedWebEvidenceMode = 'acquire' | 'reuse-existing'

export interface AgentRunOptions {
  questionContext?: AgentQuestionContext
  systemPrompt: string
  userMessage: string
  model: string
  thinking: ThinkingLevel
  tools?: string[]
  provider?: string
  providerConfig?: Record<string, unknown>
  cwd?: string
  signal?: AbortSignal
  outputPath?: string
  /** Optional JSON Schema constraining the provider's final response. */
  outputSchema?: Readonly<Record<string, unknown>>
  sessionId?: string
  rootSessionId?: string
  /** Agent name for error reporting (e.g. TimeoutError). */
  agentName?: string
  /** Internal per-turn identity used by the parent-owned MCP worker bridge. */
  workerEnvironment?: NodeJS.ProcessEnv
  /** Whether a Deep Research turn must acquire evidence or may reuse validated receipts. */
  governedWebEvidenceMode?: GovernedWebEvidenceMode
  /** If set, SIGTERM is sent after this many minutes; SIGKILL after grace period. */
  timeoutMinutes?: number
  /**
   * Runtime-only observer for provider protocol events, used to stream partial
   * text to a display channel while the turn is still running.
   *
   * Display-only and never persisted: the returned `AgentRunResult` remains the
   * authoritative text. A throwing observer must not fail the turn.
   */
  onProtocolEvent?: (event: ProviderProtocolEvent) => void
}

export interface AgentRunResult {
  /** Actual parent-owned provider after a quota fallback. */
  provider?: string
  interruption?: AgentQuestionInterruption
  text: string
  cost: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  contextTokens: number
  model: string
  costTracked?: boolean
  costSource?: 'reported' | 'provider_config' | 'environment' | 'zero_cost' | 'untracked'
  /**
   * Agent settings this turn's route did not apply, by name.
   *
   * Set only where a route decided it — today the MCP lanes, which resolve the
   * question from the provider's support mode. Carried out so the dispatch that
   * owns the durable record can write it down: a setting that quietly stopped
   * applying is otherwise indistinguishable from a provider that ignored it.
   */
  droppedProviderOptions?: readonly string[]
}

export interface TeamRunOptions {
  teamPath: string
  workspacePath: string
  brief: string
  /** Preallocated child identity. Callers that publish lifecycle events must pass this through. */
  childSessionId?: string
  bootEntry?: TeamRegistryEntry
  kickoffPrompt?: string
  inputArtifact?: string
  outputArtifact?: string
  requestedResultType?: string
  mount?: Array<{ from: string; to: string }>
  /** Durable human feedback to route to successor discussion participants. */
  humanInputRouting?: HumanInputRoutingContext
  signal?: AbortSignal
  spawnDepth: number
  budgetUsd?: number
  /** Budget policy to propagate to child team via TEAM_BUDGET_POLICY env var. */
  budgetPolicy?: BudgetPolicy
  timeoutMinutes?: number
  rootSessionId?: string
  parentSessionId?: string
  /** Authoritative workflow lineage for parent-broker evidence and policy. */
  workflowId?: string
  workflowStepId?: string
  runtimeOverrides?: TeamRuntimeOverrides
  workspacePathOverride?: string
  /** Current assignment scope used to place the child under the same product session/run. */
  parentAssignmentLocation?: RunAssignmentLocation
  /** Resume an existing child run from its run-local checkpoint when available. */
  recoveryMode?: boolean
  /** Stable key for steps that declare idempotent external side effects. */
  idempotencyKey?: string
  /** Direct Team chat uses coordinator-selected, single-pass participant replies. */
  executionMode?: 'team-chat'
}

export interface TeamRunResult {
  interruption?: import('../contracts/agent-questions.js').AgentQuestionInterruption
  text: string
  cost: number
  durationMs: number
  artifactPath: string
  assignmentPath: string
  childSessionId: string
  requestedResultType?: string
  costTracked?: boolean
  /** Structured terminal outcome. New callers should use this instead of parsing prose. */
  status?: 'completed' | 'completed_with_warnings' | 'blocked' | 'failed'
  succeeded: boolean
  exitCode: number | null
  exitSignal?: string | null
}

// ─── Runtime State ──────────────────────────────────────────────────────────

export interface RuntimeState {
  sessionId: string
  tenantId?: string
  currentLevelIndex: number
  levelStates: Map<string, LevelState>
  totalCost: number
  startTime: number
  questionPausedAt?: number
  timerStarted: boolean
  endTime: number | null
  spawnDepth: number
  rootSessionId?: string
  parentSessionId?: string
  /**
   * The one stage entry this host has admitted, or absent when none is.
   *
   * Part of the run's state rather than a side table, because it is exactly as
   * durable as the level it enters: a destination that is recorded without the
   * entry that enters it is the window Phase 4B closes. Written to the
   * checkpoint and deliberately not to the Pi session journal, so there is one
   * authority for it.
   */
  hostEntryAdmission?: HostEntryAdmission
}

export interface DiscussionLevelRuntimeOverride {
  participants?: string[]
  min_rounds?: number
  max_rounds?: number
  min_successful_participants?: number
}

export interface ReviewLevelRuntimeOverride {
  max_iterations?: number
}

export interface TeamLevelRuntimeOverride {
  discussion?: DiscussionLevelRuntimeOverride
  review?: ReviewLevelRuntimeOverride
}

export interface TeamRuntimeOverrides {
  /** Run only the first team level with this stage type. */
  stage_type?: WorkflowStageType
  levels?: Record<string, TeamLevelRuntimeOverride>
}

export interface LevelState {
  status: typeof LEVEL_STATUS[keyof typeof LEVEL_STATUS]
  stageStatus: typeof STAGE_LIFECYCLE_STATUS[keyof typeof STAGE_LIFECYCLE_STATUS]
  engineState: DiscussionState | PipelineState | ChainState | BroadcastState | ReviewState | null
  /** Loopbacks that targeted this level. Bounds `max_loopbacks`. */
  loopbackCount: number
  /**
   * How many times this level has been entered.
   *
   * `loopbackCount` only counts loopbacks that *targeted* this level, so a
   * level between a loopback's target and its source re-runs without it
   * changing. Durable dispatch identities need a value that advances on every
   * re-entry, or a second visit reproduces the first visit's identities and its
   * contributions are deduplicated away instead of published.
   */
  visitCount?: number
}

// ─── Discussion Engine State ────────────────────────────────────────────────

export interface DiscussionState {
  type: typeof STAGE_TYPE.DISCUSSION
  round: number
  messages: ConversationMessage[]
  outputPath: string
  /** Wall-clock origin for this visit to the discussion stage. */
  activationStartedAtMs?: number
  /** Proposed roster awaiting explicit user confirmation on a later turn. */
  pendingRoster?: string[]
  /** Coordinator run id in which the pending roster was proposed. */
  pendingRosterRunId?: number
  /** User-approved subset of participants. Set via `set_roster` tool before first `converse`. */
  approvedRoster?: string[]
  /**
   * The chosen roster and the reason for each name have reached the reader.
   *
   * Team chat convenes a subset on the user's behalf, so `converse` waits for
   * this rather than letting specialists answer a selection nobody explained.
   */
  rosterAnnounced?: boolean
  /** Accumulated rolling summary text (for rolling_summary context strategy). */
  compressedSummary?: string
  /** The highest round number covered by compressedSummary. */
  compressedUpToRound?: number
  /**
   * Durable hand-off between a specialist pass and the lead decision that
   * follows it. Recovery reads this before dispatching any more work.
   */
  continuation?: DiscussionContinuationProgress
  /** Accepted roster selection waiting for its durable user announcement. */
  setup?: DiscussionSetupProgress
}

export interface DiscussionSetupProgress {
  phase: 'awaiting_roster_announcement'
  agents: string[]
  rosterRationale: Record<string, string>
}

export interface DiscussionContinuationAssignment {
  targets: string[]
  message: string
}

export type DiscussionContinuationProgress =
  | {
      phase: 'awaiting_specialist_pass'
      startedAtMs: number
      assignment?: DiscussionContinuationAssignment
    }
  | {
      phase: 'awaiting_lead_decision'
      startedAtMs: number
    }
  | {
      phase: 'running_specialist_pass'
      startedAtMs: number
      passNumber: number
      /** Monotonic outer dispatch identity for this pass across process restarts. */
      attemptNumber: number
      /** Exact approved members addressed by this pass. Absent only on legacy checkpoints. */
      targets?: string[]
      assignment?: DiscussionContinuationAssignment
      completedTargets: string[]
      successfulTargets: string[]
    }
  | {
      phase: 'publishing_continuation'
      startedAtMs: number
      reason: string
      message: string
      targets: string[]
    }
  | {
      phase: 'publishing_completion'
      startedAtMs: number
      reason: string
      finalResponse: string
    }

export interface ConversationMessage {
  from: string
  /** Assigned roster member when a fallback Agent produced the response. */
  target?: string
  to: string | string[]
  round: number
  timestamp: string
  type: 'framing' | 'position' | 'probe' | 'synthesis' | 'error'
  message: string
  /**
   * The dispatch that produced this message.
   *
   * Agent name, round and timestamp cannot identify one attempt when the same
   * agent runs twice, and this is what lets a live preview be replaced by
   * exactly the message that finished it.
   */
  dispatchId?: string
}

// ─── Pipeline Engine State ──────────────────────────────────────────────────

export interface PipelineState {
  type: typeof STAGE_TYPE.PIPELINE
  planPath: string
  completedSprintIds: string[]
  activeTaskIds: string[]
  questionTaskIds?: PipelineQuestionTaskIds
}

// ─── Chain Engine State ─────────────────────────────────────────────────────

export interface ChainState {
  type: typeof STAGE_TYPE.CHAIN
  currentStep: number
  totalSteps: number
  outputs: Array<{ agent: string; text: string }>
}

// ─── Broadcast Engine State ─────────────────────────────────────────────────

export interface BroadcastState {
  type: typeof STAGE_TYPE.BROADCAST
  responses: Array<{ agent: string; text: string; cost: number }>
  aggregatedResult: string | null
  /** Settled independent slots survive another participant's human wait. */
  settledSlots?: BroadcastSettledSlot[]
}

// ─── Review Engine State ────────────────────────────────────────────────────

export interface ReviewState {
  type: typeof STAGE_TYPE.REVIEW
  iteration: number
  maxIterations: number
  lastVerdict: 'approve' | 'revise' | null
  lastFeedback: string
  lastDraft: string
  /** The unfinished phase retains its iteration across a human question. */
  pendingPhase?: ReviewQuestionPhase
}

// ─── Agent Metrics (dashboard) ──────────────────────────────────────────────

export interface AgentMetrics {
  state: typeof AGENT_STATE[keyof typeof AGENT_STATE]
  rounds: number
  totalCost: number
  contextTokens: number
  model: string
  color: number
  activeStartedAt?: number
  failureCount: number
  lastError?: string
}

// ─── Spawn Limits ───────────────────────────────────────────────────────────

export interface SpawnLimits {
  maxDepth: number
  maxConcurrent: number
  maxTotalBudgetUsd: number
}

// ─── Engine Interface ───────────────────────────────────────────────────────

export interface Engine<TConfig extends StageConfig, TState> {
  createTool(
    pi: ExtensionAPI,
    config: TConfig,
    agents: Map<string, LoadedAgent>,
    state: RuntimeState,
    workspacePath: string,
    outputPath: string,
  ): ToolDefinition

  isComplete(state: TState, config: TConfig): boolean

  getOutputArtifactPath(config: TConfig, workspacePath: string): string
}

// ─── Constraint Status ──────────────────────────────────────────────────────

export interface ConstraintStatus {
  elapsedMinutes: number
  budgetSpent: number
  timeRemaining: number
  budgetRemaining: number
  timeWarning: boolean
  budgetWarning: boolean
}
