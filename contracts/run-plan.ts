import type { ChatMessage, SessionTask } from './sessions.js'
import type { McpWorkflowPreflightDiagnostic } from './mcp.js'
import type { ResearchPlan } from './deep-research.js'
import type { WorkspaceProjectContextSelection } from './projects.js'
import {
  isDeepResearchPlanningRevision,
  type DeepResearchPlanningRevision,
} from './deep-research-planning.js'

export type RunPlanStatus =
  | "draft"
  | "ready"
  | "needs_input"
  | "applying"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

export type RunPlanActionType =
  | "collect_input"
  | "select_workflow"
  | "launch_workflow"
  | "inspect_status"
  | "cancel_run";

export type RunPlanActionStatus =
  | "pending"
  | "ready"
  | "needs_input"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

/**
 * Who put this Workflow on the plan.
 *
 * `"user"` is the only value that carries launch authority. A model
 * recommendation and a legacy record that predates this field both read as a
 * proposal, so neither can turn itself into an instruction to run something.
 */
export type RunPlanSelectionSource = "user" | "coordinator";

export interface RunPlanWorkflowSelection {
  id: string;
  rationale: string;
  confidence: "low" | "medium" | "high";
  /** Absent on plans written before selection provenance existed. */
  selectionSource?: RunPlanSelectionSource;
}

export interface RunPlanAction {
  id: string;
  type: RunPlanActionType;
  status: RunPlanActionStatus;
  title: string;
  rationale: string;
  workflowId?: string;
}

export interface RunPlan {
  id: string;
  goal: string;
  summary: string;
  status: RunPlanStatus;
  selectedWorkflow?: RunPlanWorkflowSelection;
  /** True only after the receptionist confirms every Deep Research intake field. */
  deepResearchIntakeComplete?: boolean;
  /** Strict, assignment-scoped plan required by the Deep Research workflow. */
  researchPlan?: ResearchPlan;
  /** Hash shown to the user and compared exactly when approval is submitted. */
  researchPlanProposalHash?: string;
  /** Server-authored provenance and recovery metadata for pre-launch planning. */
  deepResearchPlanning?: DeepResearchPlanningRevision;
  requiredInputs: string[];
  brief?: string;
  projectContext?: WorkspaceProjectContextSelection;
  actions: RunPlanAction[];
  warnings: string[];
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
  taskId?: string;
  applyClaimId?: string;
  applyClaimOwnerInstanceId?: string;
  applyClaimOwnerPid?: number;
  applyClaimedAt?: string;
  error?: string;
}

export interface RunPlanEvent {
  id: number;
  actionId?: string;
  type: string;
  message: string;
}

export type RunApplyResult =
  | {
      ok: true;
      plan: RunPlan;
      task: SessionTask;
      events: RunPlanEvent[];
      warnings: readonly McpWorkflowPreflightDiagnostic[];
    }
  | {
      ok: false;
      status: "needs_input";
      plan: RunPlan;
      assistant: ChatMessage;
      events: RunPlanEvent[];
    }
  | {
      ok: false;
      status: "conflict";
      statusCode: 409;
      error: string;
      detail: string;
      retryable: true;
      diagnostics: readonly McpWorkflowPreflightDiagnostic[];
      plan: RunPlan;
      events: RunPlanEvent[];
    }
  | {
      ok: false;
      status: "failed";
      statusCode: 400 | 409 | 500 | 502;
      error: string;
      detail?: string;
      task?: SessionTask;
      plan: RunPlan;
      events: RunPlanEvent[];
    };

const RUN_PLAN_STATUSES = new Set<string>([
  'draft',
  'ready',
  'needs_input',
  'applying',
  'queued',
  'running',
  'completed',
  'failed',
  'blocked',
  'cancelled',
])
const RUN_PLAN_ACTION_TYPES = new Set<string>([
  'collect_input',
  'select_workflow',
  'launch_workflow',
  'inspect_status',
  'cancel_run',
])
const RUN_PLAN_ACTION_STATUSES = new Set<string>([
  'pending',
  'ready',
  'needs_input',
  'queued',
  'running',
  'completed',
  'failed',
  'blocked',
  'cancelled',
])
const RESEARCH_LENSES = new Set<string>([
  'foundational',
  'market',
  'competitive',
  'regulatory',
  'technical',
  'historical',
  'source_verification',
])
const RESEARCH_SOURCE_TYPES = new Set<string>([
  'primary',
  'secondary',
  'regulatory',
  'academic',
  'industry',
  'news',
  'vendor',
  'community',
])
const RESEARCH_COVERAGE_KINDS = new Set<string>([
  'fact',
  'quantitative_metric',
  'comparison',
  'source_authority',
  'caveat',
  'decision',
])
const RESEARCH_COVERAGE_VALIDATIONS = new Set<string>([
  'claim_support',
  'quantitative_value',
  'independent_comparison',
  'source_authority',
  'explicit_caveat',
  'decision_support',
])

export function isRunPlan(value: unknown): value is RunPlan {
  if (!isRecord(value)) return false
  if (
    !isString(value.id) ||
    !isString(value.goal) ||
    !isString(value.summary) ||
    typeof value.status !== 'string' ||
    !RUN_PLAN_STATUSES.has(value.status) ||
    !isStringArray(value.requiredInputs) ||
    !Array.isArray(value.actions) ||
    !value.actions.every(isRunPlanAction) ||
    !isStringArray(value.warnings) ||
    !isString(value.createdAt)
  ) {
    return false
  }
  if (
    value.projectContext !== undefined &&
    !isWorkspaceProjectContextSelection(value.projectContext)
  ) {
    return false
  }
  if (
    value.selectedWorkflow !== undefined &&
    !isRunPlanWorkflowSelection(value.selectedWorkflow)
  ) {
    return false
  }
  if (
    value.researchPlan !== undefined &&
    !isResearchPlan(value.researchPlan)
  ) {
    return false
  }
  if (
    value.deepResearchIntakeComplete !== undefined &&
    typeof value.deepResearchIntakeComplete !== 'boolean'
  ) {
    return false
  }
  if (
    value.deepResearchPlanning !== undefined &&
    !isDeepResearchPlanningRevision(value.deepResearchPlanning)
  ) {
    return false
  }
  if (
    value.deepResearchPlanning?.sourceProposalSnapshot !== undefined &&
    !isResearchPlan(value.deepResearchPlanning.sourceProposalSnapshot)
  ) {
    return false
  }
  const optionalStrings = [
    value.researchPlanProposalHash,
    value.brief,
    value.updatedAt,
    value.completedAt,
    value.taskId,
    value.applyClaimId,
    value.applyClaimOwnerInstanceId,
    value.applyClaimedAt,
    value.error,
  ]
  return (
    optionalStrings.every(isOptionalString) &&
    (value.applyClaimOwnerPid === undefined ||
      (typeof value.applyClaimOwnerPid === 'number' &&
        Number.isFinite(value.applyClaimOwnerPid)))
  )
}

function isWorkspaceProjectContextSelection(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    isString(value.projectId) &&
    typeof value.includeBrief === 'boolean' &&
    isStringArray(value.fileNames) &&
    new Set(value.fileNames).size === value.fileNames.length
  )
}

function isRunPlanWorkflowSelection(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.rationale) &&
    (value.confidence === 'low' ||
      value.confidence === 'medium' ||
      value.confidence === 'high') &&
    // Absent is legitimate — it is what a plan written before provenance
    // existed looks like — but an unrecognised value is refused rather than
    // guessed. Guessing here would decide whether something may launch.
    (value.selectionSource === undefined ||
      value.selectionSource === 'user' ||
      value.selectionSource === 'coordinator')
  )
}

function isRunPlanAction(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.id) &&
    typeof value.type === 'string' &&
    RUN_PLAN_ACTION_TYPES.has(value.type) &&
    typeof value.status === 'string' &&
    RUN_PLAN_ACTION_STATUSES.has(value.status) &&
    isString(value.title) &&
    isString(value.rationale) &&
    isOptionalString(value.workflowId)
  )
}

function isResearchPlan(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isString(value.planId) ||
    !isString(value.requestId) ||
    !isDeepResearchRequest(value.request) ||
    !Array.isArray(value.sections) ||
    !value.sections.every(isResearchSection) ||
    !Array.isArray(value.tasks) ||
    !value.tasks.every(isResearchTask) ||
    !Array.isArray(value.workerSpecs) ||
    !value.workerSpecs.every(isResearchWorkerSpec) ||
    !isFiniteNumber(value.maxDurationMinutes) ||
    !isFiniteNumber(value.maxResearcherAgents) ||
    !isFiniteNumber(value.expectedPeakWorkers) ||
    !isStringArray(value.authenticatedDomains) ||
    (
      value.executionPolicy !== undefined &&
      !isResearchExecutionPolicy(value.executionPolicy)
    )
  ) {
    return false
  }
  return (
    isOptionalString(value.approvedAt) &&
    isOptionalString(value.approvalHash)
  )
}

function isResearchExecutionPolicy(value: unknown): boolean {
  if (!isRecord(value)) return false
  const evidenceTargets = value.evidenceTargets
  const stopping = value.stopping
  const synthesis = value.synthesis
  return (
    value.schemaVersion === 1 &&
    (
      value.complexity === 'simple' ||
      value.complexity === 'standard' ||
      value.complexity === 'complex'
    ) &&
    isString(value.complexityRationale) &&
    (
      value.searchBreadth === 'focused' ||
      value.searchBreadth === 'balanced' ||
      value.searchBreadth === 'broad'
    ) &&
    isFiniteNumber(value.maxCostUsd) &&
    isRecord(evidenceTargets) &&
    isFiniteNumber(evidenceTargets.minimumSupportedClaims) &&
    isFiniteNumber(
      evidenceTargets.minimumIndependentSourcesPerConsequentialClaim,
    ) &&
    typeof evidenceTargets.crossVerifyConsequentialClaims === 'boolean' &&
    isRecord(stopping) &&
    isFiniteNumber(stopping.minimumExpectedInformationGain) &&
    (
      stopping.maximumCorrectionWaves === 0 ||
      stopping.maximumCorrectionWaves === 1 ||
      stopping.maximumCorrectionWaves === 2
    ) &&
    isRecord(synthesis) &&
    (
      synthesis.mode === 'single_pass' ||
      synthesis.mode === 'section_dossiers'
    ) &&
    isFiniteNumber(synthesis.maximumParallelSections)
  )
}

function isDeepResearchRequest(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    isString(value.requestId) &&
    isString(value.question) &&
    isString(value.objective) &&
    isString(value.audience) &&
    isStringArray(value.includedScope) &&
    isStringArray(value.excludedScope) &&
    isStringArray(value.desiredSections) &&
    isStringArray(value.jurisdictions) &&
    isString(value.freshnessAsOf) &&
    isStringArray(value.authenticatedDomains) &&
    isStringArray(value.sourceRequirements) &&
    isFiniteNumber(value.maxDurationMinutes) &&
    isFiniteNumber(value.maxResearcherAgents) &&
    Array.isArray(value.outputFormats) &&
    value.outputFormats.length === 2 &&
    value.outputFormats[0] === 'markdown' &&
    value.outputFormats[1] === 'docx'
  )
}

function isResearchSection(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    isString(value.id) &&
    isString(value.title) &&
    isString(value.objective) &&
    isStringArray(value.taskIds)
  )
}

function isResearchTask(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    isString(value.id) &&
    isString(value.sectionId) &&
    isString(value.title) &&
    isString(value.question) &&
    isString(value.workerSpecId) &&
    isStringArray(value.dependsOn) &&
    (value.correctionWave === 0 ||
      value.correctionWave === 1 ||
      value.correctionWave === 2)
  )
}

function isResearchWorkerSpec(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isString(value.id) ||
    !isString(value.laneId) ||
    !isString(value.sectionId) ||
    value.baseAgent !== 'web-researcher' ||
    !isString(value.displayRole) ||
    !isString(value.domain) ||
    typeof value.lens !== 'string' ||
    !RESEARCH_LENSES.has(value.lens) ||
    !isStringArray(value.methodCardIds) ||
    !isOptionalString(value.domainCardRef) ||
    !isString(value.specialistStance) ||
    !isString(value.question) ||
    !isString(value.decisionUse) ||
    !isStringArray(value.workingDefinitions) ||
    !isStringArray(value.dependencyClaimIds) ||
    !isRecord(value.sourceRequirements) ||
    !isSourceTypeArray(value.sourceRequirements.preferredTypes) ||
    !isSourceTypeArray(value.sourceRequirements.requiredAuthorityTypes) ||
    !isStringArray(value.sourceRequirements.queryHints) ||
    !isStringArray(value.prohibitedAssumptions) ||
    !isRecord(value.stopRule) ||
    !isFiniteNumber(value.stopRule.minimumPrimarySources) ||
    !isFiniteNumber(value.stopRule.minimumIndependentSources) ||
    !isFiniteNumber(value.stopRule.maximumSources) ||
    !isRecord(value.limits) ||
    !isFiniteNumber(value.limits.deadlineMs)
  ) {
    return false
  }
  if (
    value.requiredMetrics !== undefined &&
    !isStringArray(value.requiredMetrics)
  ) {
    return false
  }
  return (
    value.coverageRequirements === undefined ||
    (Array.isArray(value.coverageRequirements) &&
      value.coverageRequirements.every(isResearchCoverageRequirement))
  )
}

function isResearchCoverageRequirement(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.schemaVersion === 2 &&
    isString(value.id) &&
    isString(value.label) &&
    typeof value.kind === 'string' &&
    RESEARCH_COVERAGE_KINDS.has(value.kind) &&
    typeof value.validation === 'string' &&
    RESEARCH_COVERAGE_VALIDATIONS.has(value.validation) &&
    typeof value.required === 'boolean'
  )
}

function isSourceTypeArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'string' && RESEARCH_SOURCE_TYPES.has(entry),
    )
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
