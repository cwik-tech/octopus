/**
 * Stage Parsers
 *
 * Parses stage-specific configuration blocks from team.yaml.
 * Each function takes a raw YAML object and returns a typed StageConfig.
 */

import { whenDefined } from '../core/optional-properties.js'
import {
  STAGE_TYPE,
  DISCUSSION_MODE,
  AGGREGATION_MODE,
  DEFAULT_MAX_TIME_MINUTES,
  DEFAULT_MAX_BUDGET_USD,
  DEFAULT_CONTEXT_WINDOW_ROUNDS,
  DEFAULT_SUMMARIZE_AFTER_ROUNDS,
} from '../core/constants.js'
import type { YamlObject, YamlValue } from '../core/yaml-parser.js'
import { parseYamlList, validateEnum } from './config-parse-utils.js'
import type {
  StageConfig,
  ConstraintConfig,
  OutputConfig,
  StageInputContract,
  StageOutputContract,
  RoutingStageConfig,
  DiscussionStageConfig,
  PipelineStageConfig,
  ChainStageConfig,
  BroadcastStageConfig,
  ReviewStageConfig,
  GateStrictness,
  AggregationMode,
  DiscussionMode,
  ContextStrategy,
} from '../core/types.js'

// ─── Local utilities (avoid circular import with team-config.ts) ────────────

function str(val: YamlValue | undefined, fallback: string): string {
  if (val == null) return fallback
  return String(val)
}

function num(val: YamlValue | undefined, fallback: number): number {
  if (val == null) return fallback
  const n = Number(val)
  return Number.isFinite(n) ? n : fallback
}

function bool(val: YamlValue | undefined, fallback: boolean): boolean {
  if (val == null) return fallback
  if (typeof val === 'boolean') return val
  if (typeof val === 'string') {
    const normalized = val.toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return fallback
}

const DISCUSSION_MODES = ['brainstorm', 'evaluate', 'debate', 'deliberate'] as const
const AGGREGATION_MODES = ['merge', 'vote', 'best'] as const
const PIPELINE_GATE_TYPES = ['all_tasks_terminal', 'validation', 'artifact_exists'] as const
const GATE_STRICTNESSES = ['hard', 'soft', 'off'] as const

/**
 * Keys removed from the public stage-constraint schema.
 *
 * Neither was ever wired to runtime behaviour, so a team declaring them was
 * told its stage was enforced when nothing enforced it. They are rejected at
 * this boundary rather than ignored, so the mismatch surfaces at parse time
 * instead of silently at run time. See
 * docs/adr/2026-08-21-Stage-Constraint-Schema-Removal.md.
 *
 * The error text scopes its claim to the removed key. The rest of the block is
 * not advisory: `max_time_minutes` is the delegated routing coordinator's
 * timeout (`team-runtime/index.ts:1590-1593`) and `agent_timeout_minutes` is
 * enforced by every engine.
 */
const REMOVED_CONSTRAINT_KEYS = ['enforce', 'on_exceed'] as const

function parseConstraints(raw: YamlObject | undefined, errors: string[]): ConstraintConfig {
  for (const key of REMOVED_CONSTRAINT_KEYS) {
    // Own-key presence, not a non-null value: `enforce:` with nothing after it
    // is valid YAML that parses to null, and the schema forbids the key itself.
    // A `!= null` test would wave that spelling straight through.
    if (raw !== undefined && Object.prototype.hasOwnProperty.call(raw, key)) {
      errors.push(
        `constraints '${key}' is no longer supported and has been removed from the ` +
        `schema: it never had any runtime effect. Remove it. To cap spend, use a ` +
        `top-level 'budget' section with 'enforce: true'; to bound a single dispatch, ` +
        `use 'agent_timeout_minutes'.`,
      )
    }
  }
  return {
    max_time_minutes: num(raw?.max_time_minutes, DEFAULT_MAX_TIME_MINUTES),
    max_budget_usd: num(raw?.max_budget_usd, DEFAULT_MAX_BUDGET_USD),
    ...(raw?.agent_timeout_minutes != null
      ? { agent_timeout_minutes: num(raw.agent_timeout_minutes, 0) }
      : {}),
  }
}

function parseOutput(raw: YamlObject | undefined): OutputConfig {
  return {
    format: str(raw?.format, 'output.md'),
    ...(raw?.path ? { path: str(raw.path, '') } : {}),
    user_review: raw?.user_review !== undefined ? bool(raw.user_review, true) : true,
  }
}

function parseStageArtifactContracts(raw: YamlValue | undefined, field: string, errors: string[]) {
  if (!raw) return undefined
  return parseYamlList(raw, field, errors).map((item) => {
    const artifact = item as YamlObject
    return {
      path: str(artifact.path, ''),
      ...(artifact.required != null ? { required: bool(artifact.required, true) } : {}),
      ...(artifact.description ? { description: str(artifact.description, '') } : {}),
    }
  })
}

function parseStructuredContract(raw: YamlObject | undefined) {
  if (!raw) return undefined
  return {
    ...(raw.schema ? { schema: str(raw.schema, '') } : {}),
    ...(raw.description ? { description: str(raw.description, '') } : {}),
  }
}

function parseInputContract(raw: YamlObject | undefined, errors: string[]): StageInputContract | undefined {
  if (!raw) return undefined
  return {
    ...whenDefined(parseStageArtifactContracts(raw.artifacts, 'input_contract.artifacts', errors), (artifacts) => ({ artifacts })),
    ...whenDefined(parseStructuredContract(raw.structured as YamlObject | undefined), (structured) => ({ structured })),
  }
}

function parseOutputContract(raw: YamlObject | undefined, errors: string[]): StageOutputContract | undefined {
  if (!raw) return undefined
  return {
    ...whenDefined(parseStageArtifactContracts(raw.artifacts, 'output_contract.artifacts', errors), (artifacts) => ({ artifacts })),
    ...whenDefined(parseStructuredContract(raw.structured as YamlObject | undefined), (structured) => ({ structured })),
    ...(raw.completion_artifact ? { completion_artifact: str(raw.completion_artifact, '') } : {}),
  }
}

// ─── Failure policy helper ───────────────────────────────────────────────────

const VALID_ON_AGENT_FAILURE = new Set(['retry', 'fallback', 'skip', 'halt'])
const VALID_ON_MAX_ITERATIONS = new Set([
  'block',
  'approve_latest',
  'approve_latest_with_warnings',
  'escalate_to_user',
])

function parseOnAgentFailure(
  raw: string | undefined,
  errors: string[],
): 'retry' | 'fallback' | 'skip' | 'halt' | undefined {
  if (!raw) return undefined
  if (!VALID_ON_AGENT_FAILURE.has(raw)) {
    errors.push(`Invalid on_agent_failure value '${raw}'. Must be one of: retry, fallback, skip, halt`)
    return undefined
  }
  return raw as 'retry' | 'fallback' | 'skip' | 'halt'
}

function parseOnMaxIterations(
  raw: string | undefined,
  errors: string[],
): 'block' | 'approve_latest' | 'approve_latest_with_warnings' | 'escalate_to_user' | undefined {
  if (!raw) return undefined
  if (!VALID_ON_MAX_ITERATIONS.has(raw)) {
    errors.push(
      `Invalid on_max_iterations value '${raw}'. ` +
      `Must be one of: block, approve_latest, approve_latest_with_warnings, escalate_to_user`,
    )
    return undefined
  }
  return raw as 'block' | 'approve_latest' | 'approve_latest_with_warnings' | 'escalate_to_user'
}

const VALID_ON_REVIEWER_SKIP = new Set(['approve_latest', 'fail'])

function parseOnReviewerSkip(
  raw: string | undefined,
  errors: string[],
): 'approve_latest' | 'fail' | undefined {
  if (!raw) return undefined
  if (!VALID_ON_REVIEWER_SKIP.has(raw)) {
    errors.push(`Invalid on_reviewer_skip value '${raw}'. Must be one of: approve_latest, fail`)
    return undefined
  }
  return raw as 'approve_latest' | 'fail'
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function validateOptionalAgent(
  name: string | undefined,
  role: string,
  agentNames: Set<string>,
  errors: string[],
): void {
  if (name && !agentNames.has(name)) {
    errors.push(`${role} '${name}' not found in agent roster`)
  }
}

export function validateAgentList(
  names: string[] | undefined,
  role: string,
  agentNames: Set<string>,
  errors: string[],
): void {
  if (!names) return
  for (const name of names) {
    if (!agentNames.has(name)) {
      errors.push(`${role} '${name}' not found in agent roster`)
    }
  }
}

// ─── Stage dispatcher ────────────────────────────────────────────────────────

const FALLBACK_DISCUSSION_STAGE: DiscussionStageConfig = {
  type: STAGE_TYPE.DISCUSSION,
  coordinator: '',
  participants: [],
  config: {
    mode: DISCUSSION_MODE.BRAINSTORM,
    min_rounds: 1,
    max_rounds: 3,
    constraints: { max_time_minutes: DEFAULT_MAX_TIME_MINUTES, max_budget_usd: DEFAULT_MAX_BUDGET_USD },
    output: { format: 'output.md', user_review: true },
  },
}

export function parseStage(
  raw: YamlObject | undefined,
  agentNames: Set<string>,
  errors: string[],
  warnings: string[] = [],
): StageConfig {
  if (!raw) {
    errors.push('Level missing stage configuration')
    return { ...FALLBACK_DISCUSSION_STAGE }
  }

  const stageType = str(raw.type, STAGE_TYPE.DISCUSSION)

  switch (stageType) {
    case STAGE_TYPE.DISCUSSION:
      return parseDiscussionStage(raw, agentNames, errors, warnings)
    case STAGE_TYPE.ROUTING:
      return parseRoutingStage(raw, agentNames, errors)
    case STAGE_TYPE.PIPELINE:
      return parsePipelineStage(raw, agentNames, errors)
    case STAGE_TYPE.CHAIN:
      return parseChainStage(raw, agentNames, errors)
    case STAGE_TYPE.BROADCAST:
      return parseBroadcastStage(raw, agentNames, errors)
    case STAGE_TYPE.REVIEW:
      return parseReviewStage(raw, agentNames, errors)
    default:
      errors.push(`Unknown stage type: ${stageType}`)
      return { ...FALLBACK_DISCUSSION_STAGE }
  }
}

// ─── Stage parsers ───────────────────────────────────────────────────────────

const VALID_CONTEXT_STRATEGIES = new Set<string>(['full', 'recent_N', 'rolling_summary'])

export function parseRoutingStage(
  raw: YamlObject,
  agentNames: Set<string>,
  errors: string[],
): RoutingStageConfig {
  const coordinator = str(raw.coordinator, '')
  if (!coordinator) {
    errors.push('Routing coordinator is required')
  } else if (!agentNames.has(coordinator)) {
    errors.push(`Routing coordinator '${coordinator}' not found in agent roster`)
  }

  const config = raw.config as YamlObject | undefined

  return {
    type: STAGE_TYPE.ROUTING,
    coordinator,
    config: {
      ...whenDefined(config?.constraints ? parseConstraints(config.constraints as YamlObject, errors) : undefined, (constraints) => ({ constraints })),
      output: parseOutput(config?.output as YamlObject | undefined),
      ...whenDefined(parseInputContract(config?.input_contract as YamlObject | undefined, errors), (input_contract) => ({ input_contract })),
      ...whenDefined(parseOutputContract(config?.output_contract as YamlObject | undefined, errors), (output_contract) => ({ output_contract })),
    },
  }
}

export function parseDiscussionStage(
  raw: YamlObject,
  agentNames: Set<string>,
  errors: string[],
  warnings: string[] = [],
): DiscussionStageConfig {
  const coordinator = str(raw.coordinator, '')
  const participants = raw.participants != null
    ? parseYamlList(raw.participants, 'discussion participants', errors).map((p) => String(p))
    : []

  if (!coordinator) {
    errors.push('Discussion coordinator is required')
  } else if (!agentNames.has(coordinator)) {
    errors.push(`Discussion coordinator '${coordinator}' not found in agent roster`)
  }
  for (const p of participants) {
    if (!agentNames.has(p)) {
      errors.push(`Discussion participant '${p}' not found in agent roster`)
    }
  }

  const config = raw.config as YamlObject | undefined

  const onAgentFailureRaw = raw.on_agent_failure ? str(raw.on_agent_failure, '') : undefined
  const onAgentFailure = parseOnAgentFailure(onAgentFailureRaw, errors)

  // ── Context strategy fields ──
  let contextStrategy: ContextStrategy | undefined
  if (config?.context_strategy != null) {
    const rawStrategy = str(config.context_strategy, '')
    if (!VALID_CONTEXT_STRATEGIES.has(rawStrategy)) {
      errors.push(
        `Invalid context_strategy '${rawStrategy}'. Must be one of: full, recent_N, rolling_summary`,
      )
    } else {
      contextStrategy = rawStrategy as ContextStrategy
    }
  }

  if (contextStrategy === 'recent_N' && config?.context_window_rounds == null) {
    errors.push('context_window_rounds is required when context_strategy is recent_N')
  }

  let contextWindowRounds: number | undefined
  if (config?.context_window_rounds != null) {
    contextWindowRounds = num(config.context_window_rounds, DEFAULT_CONTEXT_WINDOW_ROUNDS)
    if (contextWindowRounds < 1) {
      warnings.push(
        `context_window_rounds must be >= 1 (got ${contextWindowRounds}), clamping to 1`,
      )
      contextWindowRounds = 1
    }
  }

  let summarizeAfterRounds: number | undefined
  if (config?.summarize_after_rounds != null) {
    summarizeAfterRounds = num(config.summarize_after_rounds, DEFAULT_SUMMARIZE_AFTER_ROUNDS)
    if (summarizeAfterRounds < 1) {
      warnings.push(
        `summarize_after_rounds must be >= 1 (got ${summarizeAfterRounds}), clamping to 1`,
      )
      summarizeAfterRounds = 1
    }
  }

  let minSuccessfulParticipants: number | undefined
  if (config?.min_successful_participants != null) {
    minSuccessfulParticipants = num(config.min_successful_participants, 1)
    if (minSuccessfulParticipants < 1) {
      warnings.push(
        `min_successful_participants must be >= 1 (got ${minSuccessfulParticipants}), clamping to 1`,
      )
      minSuccessfulParticipants = 1
    }
  }

  const minRounds = num(config?.min_rounds, 1)
  const maxRounds = num(config?.max_rounds, 3)
  if (minRounds > maxRounds) {
    errors.push(
      `Discussion min_rounds (${minRounds}) cannot be greater than max_rounds (${maxRounds}).`,
    )
  }

  return {
    type: STAGE_TYPE.DISCUSSION,
    coordinator,
    participants,
    config: {
      mode: validateEnum(str(config?.mode, DISCUSSION_MODE.BRAINSTORM), DISCUSSION_MODES, "discussion 'mode'", errors) as DiscussionMode,
      min_rounds: minRounds,
      max_rounds: maxRounds,
      constraints: parseConstraints(config?.constraints as YamlObject | undefined, errors),
      output: parseOutput(config?.output as YamlObject | undefined),
      ...whenDefined(onAgentFailure, (on_agent_failure) => ({ on_agent_failure })),
      ...whenDefined(parseInputContract(config?.input_contract as YamlObject | undefined, errors), (input_contract) => ({ input_contract })),
      ...whenDefined(parseOutputContract(config?.output_contract as YamlObject | undefined, errors), (output_contract) => ({ output_contract })),
      ...(minSuccessfulParticipants !== undefined ? { min_successful_participants: minSuccessfulParticipants } : {}),
      ...(contextStrategy !== undefined ? { context_strategy: contextStrategy } : {}),
      ...(contextWindowRounds !== undefined ? { context_window_rounds: contextWindowRounds } : {}),
      ...(summarizeAfterRounds !== undefined ? { summarize_after_rounds: summarizeAfterRounds } : {}),
    },
  }
}

export function parsePipelineStage(
  raw: YamlObject,
  agentNames: Set<string>,
  errors: string[],
): PipelineStageConfig {
  const config = raw.config as YamlObject | undefined
  const gateRaw = config?.gate as YamlObject | undefined
  const coordinator = raw.coordinator ? str(raw.coordinator, '') : undefined
  const participants = raw.participants != null
    ? parseYamlList(raw.participants, 'pipeline participants', errors).map((p) => String(p))
    : undefined
  validateOptionalAgent(coordinator, 'Pipeline coordinator', agentNames, errors)
  validateAgentList(participants, 'Pipeline participant', agentNames, errors)

  const onAgentFailureRaw = raw.on_agent_failure ? str(raw.on_agent_failure, '') : undefined
  const onAgentFailure = parseOnAgentFailure(onAgentFailureRaw, errors)
  const executionMode = validateEnum(
    str(config?.execution_mode, 'serial'),
    ['serial', 'bounded_parallel'] as const,
    "pipeline 'execution_mode'",
    errors,
  ) as PipelineStageConfig['config']['execution_mode']
  const assignmentScope = validateEnum(
    str(config?.assignment_scope, 'stage'),
    ['stage', 'task'] as const,
    "pipeline 'assignment_scope'",
    errors,
  ) as PipelineStageConfig['config']['assignment_scope']
  let maxConcurrency: number | undefined
  if (config?.max_concurrency != null) {
    maxConcurrency = num(config.max_concurrency, 1)
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 8) {
      errors.push("pipeline 'max_concurrency' must be an integer between 1 and 8")
      maxConcurrency = undefined
    }
  }

  return {
    type: STAGE_TYPE.PIPELINE,
    ...whenDefined(coordinator, (presentCoordinator) => ({ coordinator: presentCoordinator })),
    ...whenDefined(participants, (presentParticipants) => ({ participants: presentParticipants })),
    config: {
      ...whenDefined(config?.plan_file ? str(config.plan_file, '') : undefined, (definedValue) => ({ plan_file: definedValue })),
      ...whenDefined(config?.plan_artifact ? str(config.plan_artifact, '') : undefined, (definedValue) => ({ plan_artifact: definedValue })),
      run_owned_plan: bool(config?.run_owned_plan, false),
      persist_result: bool(config?.persist_result, false),
      ...whenDefined(executionMode, (definedValue) => ({ execution_mode: definedValue })),
      ...whenDefined(maxConcurrency, (definedValue) => ({ max_concurrency: definedValue })),
      ...whenDefined(assignmentScope, (definedValue) => ({ assignment_scope: definedValue })),
      ...whenDefined(config?.deadline_artifact ? str(config.deadline_artifact, '') : undefined, (definedValue) => ({ deadline_artifact: definedValue })),
      ...whenDefined(parseSectionDossierDrafting(config?.section_dossier_drafting as YamlObject | undefined, errors), (section_dossier_drafting) => ({ section_dossier_drafting })),
      parallel: bool(config?.parallel, true),
      ...whenDefined(config?.constraints ? parseConstraints(config.constraints as YamlObject, errors) : undefined, (definedValue) => ({ constraints: definedValue })),
      gate: {
        type: validateEnum(str(gateRaw?.type, 'all_tasks_terminal'), PIPELINE_GATE_TYPES, "pipeline gate 'type'", errors) as PipelineStageConfig['config']['gate']['type'],
        strictness: validateEnum(str(gateRaw?.strictness, 'hard'), GATE_STRICTNESSES, "gate 'strictness'", errors) as GateStrictness,
        ...(gateRaw?.quality_checks
          ? { quality_checks: parseYamlList(gateRaw.quality_checks, 'pipeline gate quality_checks', errors).map((q) => String(q)) }
          : {}),
      },
      ...whenDefined(onAgentFailure, (definedValue) => ({ on_agent_failure: definedValue })),
      ...whenDefined(parseInputContract(config?.input_contract as YamlObject | undefined, errors), (definedValue) => ({ input_contract: definedValue })),
      ...whenDefined(parseOutputContract(config?.output_contract as YamlObject | undefined, errors), (definedValue) => ({ output_contract: definedValue })),
    },
  }
}

/**
 * The Deep Research section-drafting contract.
 *
 * Every field is required. Without the approved plan the runtime cannot prove
 * the dossier index it reads belongs to this run, and without a window and
 * reserve it cannot admit the writer's request before dispatch — the two things
 * this option exists to add.
 */
function parseSectionDossierDrafting(
  raw: YamlObject | undefined,
  errors: string[],
): PipelineStageConfig['config']['section_dossier_drafting'] {
  if (!raw) return undefined
  const planArtifact = str(raw.plan_artifact, '')
  const dossierIndexArtifact = str(raw.dossier_index_artifact, '')
  const contextWindowTokens = num(raw.context_window_tokens, 0)
  const outputReserveTokens = num(raw.output_reserve_tokens, 0)
  if (!planArtifact || !dossierIndexArtifact) {
    errors.push(
      "pipeline 'section_dossier_drafting' requires plan_artifact and dossier_index_artifact",
    )
    return undefined
  }
  if (
    !Number.isInteger(contextWindowTokens) ||
    contextWindowTokens < 1 ||
    !Number.isInteger(outputReserveTokens) ||
    outputReserveTokens < 1 ||
    outputReserveTokens >= contextWindowTokens
  ) {
    errors.push(
      "pipeline 'section_dossier_drafting' requires a positive context_window_tokens and a smaller positive output_reserve_tokens",
    )
    return undefined
  }
  return {
    plan_artifact: planArtifact,
    dossier_index_artifact: dossierIndexArtifact,
    context_window_tokens: contextWindowTokens,
    output_reserve_tokens: outputReserveTokens,
  }
}

export function parseChainStage(
  raw: YamlObject,
  agentNames: Set<string>,
  errors: string[],
): ChainStageConfig {
  const config = raw.config as YamlObject | undefined
  const coordinator = raw.coordinator ? str(raw.coordinator, '') : undefined
  const sequence = raw.sequence != null
    ? parseYamlList(raw.sequence, 'chain sequence', errors).map((s) => String(s))
    : []
  validateOptionalAgent(coordinator, 'Chain coordinator', agentNames, errors)
  validateAgentList(sequence, 'Chain sequence agent', agentNames, errors)

  const onAgentFailureRaw = raw.on_agent_failure ? str(raw.on_agent_failure, '') : undefined
  const onAgentFailure = parseOnAgentFailure(onAgentFailureRaw, errors)
  const structuredOutput = config?.structured_output
    ? validateEnum(
        str(config.structured_output, ''),
        ['deep_research_quality_verdict'] as const,
        "chain 'structured_output'",
        errors,
      ) as ChainStageConfig['config']['structured_output']
    : undefined
  if (structuredOutput === 'deep_research_quality_verdict' && sequence.length !== 1) {
    errors.push("chain 'deep_research_quality_verdict' requires exactly one sequence agent")
  }

  const synthesisBundle = parseResearchSynthesisBundle(
    config?.research_synthesis_bundle as YamlObject | undefined,
    errors,
  )
  const qualityBundle = parseResearchQualityBundle(
    config?.research_quality_bundle as YamlObject | undefined,
    errors,
  )

  return {
    type: STAGE_TYPE.CHAIN,
    ...whenDefined(coordinator, (definedValue) => ({ coordinator: definedValue })),
    sequence,
    config: {
      ...(config?.handoff_format ? { handoff_format: str(config.handoff_format, '') } : {}),
      ...whenDefined(synthesisBundle, (research_synthesis_bundle) => ({ research_synthesis_bundle })),
      ...whenDefined(qualityBundle, (research_quality_bundle) => ({ research_quality_bundle })),
      preserve_initial_input: config?.preserve_initial_input === true,
      ...whenDefined(structuredOutput, (structured_output) => ({ structured_output })),
      ...(config?.deadline_artifact ? { deadline_artifact: str(config.deadline_artifact, '') } : {}),
      ...whenDefined(config?.constraints ? parseConstraints(config.constraints as YamlObject, errors) : undefined, (constraints) => ({ constraints })),
      output: parseOutput(config?.output as YamlObject | undefined),
      ...whenDefined(onAgentFailure, (on_agent_failure) => ({ on_agent_failure })),
      ...whenDefined(parseInputContract(config?.input_contract as YamlObject | undefined, errors), (input_contract) => ({ input_contract })),
      ...whenDefined(parseOutputContract(config?.output_contract as YamlObject | undefined, errors), (output_contract) => ({ output_contract })),
    },
  }
}

/** The four assignment-owned artifacts required for factual quality review. */
function parseResearchQualityBundle(
  raw: YamlObject | undefined,
  errors: string[],
): ChainStageConfig['config']['research_quality_bundle'] {
  if (!raw) return undefined
  const planArtifact = str(raw.plan_artifact, '')
  const qualityPacketArtifact = str(raw.quality_packet_artifact, '')
  const deterministicVerdictArtifact = str(raw.deterministic_verdict_artifact, '')
  const reportArtifact = str(raw.report_artifact, '')
  const contextWindowTokens = num(raw.context_window_tokens, 0)
  const outputReserveTokens = num(raw.output_reserve_tokens, 0)
  if (
    !planArtifact ||
    !qualityPacketArtifact ||
    !deterministicVerdictArtifact ||
    !reportArtifact
  ) {
    errors.push(
      "chain 'research_quality_bundle' requires plan_artifact, quality_packet_artifact, deterministic_verdict_artifact, and report_artifact",
    )
    return undefined
  }
  if (
    !Number.isInteger(contextWindowTokens) ||
    contextWindowTokens < 1 ||
    !Number.isInteger(outputReserveTokens) ||
    outputReserveTokens < 1 ||
    outputReserveTokens >= contextWindowTokens
  ) {
    errors.push(
      "chain 'research_quality_bundle' requires a positive context_window_tokens and a smaller positive output_reserve_tokens",
    )
    return undefined
  }
  return {
    plan_artifact: planArtifact,
    quality_packet_artifact: qualityPacketArtifact,
    deterministic_verdict_artifact: deterministicVerdictArtifact,
    report_artifact: reportArtifact,
    context_window_tokens: contextWindowTokens,
    output_reserve_tokens: outputReserveTokens,
  }
}

/**
 * The Deep Research synthesis bundle contract.
 *
 * Every field but `corrections_artifact` is required: a partially declared
 * bundle would silently fall back to the unbounded first-artifact behaviour
 * this option exists to replace. The correction context is optional because a
 * first synthesis wave has none.
 */
function parseResearchSynthesisBundle(
  raw: YamlObject | undefined,
  errors: string[],
): ChainStageConfig['config']['research_synthesis_bundle'] {
  if (!raw) return undefined
  const planArtifact = str(raw.plan_artifact, '')
  const dossierIndexArtifact = str(raw.dossier_index_artifact, '')
  const synthesisArtifact = str(raw.synthesis_artifact, '')
  const contextWindowTokens = num(raw.context_window_tokens, 0)
  const outputReserveTokens = num(raw.output_reserve_tokens, 0)
  if (!planArtifact || !dossierIndexArtifact || !synthesisArtifact) {
    errors.push(
      "chain 'research_synthesis_bundle' requires plan_artifact, dossier_index_artifact, and synthesis_artifact",
    )
    return undefined
  }
  if (
    !Number.isInteger(contextWindowTokens) ||
    contextWindowTokens < 1 ||
    !Number.isInteger(outputReserveTokens) ||
    outputReserveTokens < 1 ||
    outputReserveTokens >= contextWindowTokens
  ) {
    errors.push(
      "chain 'research_synthesis_bundle' requires a positive context_window_tokens and a smaller positive output_reserve_tokens",
    )
    return undefined
  }
  const correctionsArtifact = raw.corrections_artifact
    ? str(raw.corrections_artifact, '')
    : undefined
  return {
    plan_artifact: planArtifact,
    dossier_index_artifact: dossierIndexArtifact,
    synthesis_artifact: synthesisArtifact,
    ...whenDefined(correctionsArtifact, (corrections_artifact) => ({ corrections_artifact })),
    context_window_tokens: contextWindowTokens,
    output_reserve_tokens: outputReserveTokens,
  }
}

export function parseBroadcastStage(
  raw: YamlObject,
  agentNames: Set<string>,
  errors: string[],
): BroadcastStageConfig {
  const config = raw.config as YamlObject | undefined
  const coordinator = raw.coordinator ? str(raw.coordinator, '') : undefined
  const fanOut = raw.fan_out != null
    ? parseYamlList(raw.fan_out, 'broadcast fan_out', errors).map((f) => String(f))
    : []
  validateOptionalAgent(coordinator, 'Broadcast coordinator', agentNames, errors)
  validateAgentList(fanOut, 'Broadcast fan_out agent', agentNames, errors)

  const onAgentFailureRaw = raw.on_agent_failure ? str(raw.on_agent_failure, '') : undefined
  const onAgentFailure = parseOnAgentFailure(onAgentFailureRaw, errors)

  return {
    type: STAGE_TYPE.BROADCAST,
    ...whenDefined(coordinator, (definedValue) => ({ coordinator: definedValue })),
    fan_out: fanOut,
    config: {
      aggregation: validateEnum(str(config?.aggregation, AGGREGATION_MODE.MERGE), AGGREGATION_MODES, "broadcast 'aggregation'", errors) as AggregationMode,
      ...whenDefined(config?.constraints ? parseConstraints(config.constraints as YamlObject, errors) : undefined, (constraints) => ({ constraints })),
      output: parseOutput(config?.output as YamlObject | undefined),
      ...whenDefined(onAgentFailure, (on_agent_failure) => ({ on_agent_failure })),
      ...whenDefined(parseInputContract(config?.input_contract as YamlObject | undefined, errors), (input_contract) => ({ input_contract })),
      ...whenDefined(parseOutputContract(config?.output_contract as YamlObject | undefined, errors), (output_contract) => ({ output_contract })),
    },
  }
}

export function parseReviewStage(
  raw: YamlObject,
  agentNames: Set<string>,
  errors: string[],
): ReviewStageConfig {
  const config = raw.config as YamlObject | undefined
  const coordinator = raw.coordinator ? str(raw.coordinator, '') : undefined
  const producer = str(raw.producer, '')
  const reviewer = str(raw.reviewer, '')
  validateOptionalAgent(coordinator, 'Review coordinator', agentNames, errors)
  validateOptionalAgent(producer, 'Review producer', agentNames, errors)
  validateOptionalAgent(reviewer, 'Review reviewer', agentNames, errors)

  const onAgentFailureRaw = raw.on_agent_failure ? str(raw.on_agent_failure, '') : undefined
  const onAgentFailure = parseOnAgentFailure(onAgentFailureRaw, errors)
  const onMaxIterationsRaw = config?.on_max_iterations ? str(config.on_max_iterations, '') : undefined
  const onMaxIterations = parseOnMaxIterations(onMaxIterationsRaw, errors)
  const onReviewerSkipRaw = config?.on_reviewer_skip ? str(config.on_reviewer_skip, '') : undefined
  const onReviewerSkip = parseOnReviewerSkip(onReviewerSkipRaw, errors)
  const publicationValidationRaw = config?.research_publication_validation as
    | YamlObject
    | undefined
  const publicationValidation = publicationValidationRaw
    ? {
        source_artifact: str(
          publicationValidationRaw.source_artifact,
          '',
        ),
        ...whenDefined(
          publicationValidationRaw.evidence_graph_artifact
            ? str(publicationValidationRaw.evidence_graph_artifact, '')
            : undefined,
          (evidence_graph_artifact) => ({ evidence_graph_artifact }),
        ),
        audit_artifact: str(
          publicationValidationRaw.audit_artifact,
          '',
        ),
      }
    : undefined
  if (
    publicationValidation &&
    (
      !publicationValidation.source_artifact ||
      !publicationValidation.audit_artifact
    )
  ) {
    errors.push(
      "review 'research_publication_validation' requires source_artifact and audit_artifact",
    )
  }

  return {
    type: STAGE_TYPE.REVIEW,
    ...whenDefined(coordinator, (presentCoordinator) => ({ coordinator: presentCoordinator })),
    producer,
    reviewer,
    config: {
      max_iterations: num(config?.max_iterations, 3),
      on_max_iterations: onMaxIterations ?? 'block',
      on_reviewer_skip: onReviewerSkip ?? 'fail',
      ...whenDefined(config?.constraints ? parseConstraints(config.constraints as YamlObject, errors) : undefined, (constraints) => ({ constraints })),
      ...whenDefined(publicationValidation, (research_publication_validation) => ({ research_publication_validation })),
      output: parseOutput(config?.output as YamlObject | undefined),
      ...whenDefined(onAgentFailure, (on_agent_failure) => ({ on_agent_failure })),
      ...whenDefined(parseInputContract(config?.input_contract as YamlObject | undefined, errors), (input_contract) => ({ input_contract })),
      ...whenDefined(parseOutputContract(config?.output_contract as YamlObject | undefined, errors), (output_contract) => ({ output_contract })),
    },
  }
}
