/**
 * Team Runtime — Team Config Parser (Orchestrator)
 *
 * Parses team.yaml into a typed TeamConfig object.
 * Delegates to stage-parsers.ts and config-validator.ts for specialised logic.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'
import { whenDefined } from '../core/optional-properties.js'
import { parseYaml, type YamlObject, type YamlValue } from '../core/yaml-parser.js'
import { isTerminalGate } from '../core/types.js'
import {
  STAGE_TYPE as _STAGE_TYPE,
  DEFAULT_MODEL,
  DEFAULT_THINKING,
  DEFAULT_ORCHESTRATION_MODEL,
  DEFAULT_ORCHESTRATION_THINKING,
  DEFAULT_EXECUTION_THINKING,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_DISPATCH_DELAY_MS,
  DEFAULT_BUDGET_POLICY,
  DEFAULT_SESSION_BUDGET_USD,
} from '../core/constants.js'
import type {
  TeamConfig,
  TeamDefaultsConfig,
  WorkflowTemplateConfig,
  LevelConfig,
  GateConfig,
  GateCondition,
  GateTransform,
  AgentRosterEntry,
  ArtifactDeclaration,
  LegacyModelConfig,
  WorkspaceConfig,
  TeamCompositionConfig,
  ConstraintConfig,
  OutputConfig,
  GateStrictness,
  LevelPermissions,
  AgentFailurePolicy,
  RateLimitConfig,
  SessionBudgetConfig,
} from '../core/types.js'
import { parseStage } from './stage-parsers.js'
import { parseYamlList, validateEnum } from './config-parse-utils.js'
import {
  validateAgentReferences,
  validateArtifactContracts,
  validateStageContracts,
  validateWorkflowTemplate,
  validateConditionalRouting,
  validateFailurePolicies,
} from './config-validator.js'
import { parseTeamRegistry } from './team-registry.js'
import { parseToolList } from '../core/tool-policy.js'

export interface ParseResult {
  config: TeamConfig | null
  errors: string[]
  warnings: string[]
}

// ─── Utility helpers ─────────────────────────────────────────────────────────

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

function isYamlObject(value: YamlValue | undefined): value is YamlObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const GATE_CONDITION_TYPES = [
  'artifact_exists',
  'validation',
  'all_tasks_terminal',
  'manual',
  'artifact_content',
  'agent_verdict',
  'artifact_json',
] as const

const BUDGET_POLICIES = ['halt', 'warn'] as const
const GATE_TRANSFORM_TYPES = ['script', 'agent'] as const
const GATE_STRICTNESSES = ['hard', 'soft', 'off'] as const
const ARTIFACT_MATCH_TYPES = ['contains', 'regex'] as const
const AGENT_TYPES = ['agent', 'team'] as const
const INVOCATION_MODES = ['user', 'external', 'team'] as const

function resolvePath(baseDir: string, p: string): string {
  if (!p) return p
  if (p.startsWith('~')) return path.join(homedir(), p.slice(1))
  if (path.isAbsolute(p)) return p
  return path.resolve(baseDir, p)
}

function resolveRegistryPath(baseDir: string, p: string): string {
  const resolved = resolvePath(baseDir, p)
  try {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return path.join(resolved, 'teams.yaml')
    }
  } catch {
    // Fall through — parse-time validation will surface path issues later.
  }
  return resolved
}

// ─── Sub-parsers ─────────────────────────────────────────────────────────────

function parseGateTransform(raw: YamlObject, baseDir: string, errors: string[]): GateTransform {
  const type = validateEnum(
    str(raw.type, 'script'),
    GATE_TRANSFORM_TYPES,
    "gate transform 'type'",
    errors,
  )
  const strictnessRaw = raw.strictness ? str(raw.strictness, '') : undefined
  const strictness = strictnessRaw
    ? validateEnum(strictnessRaw, GATE_STRICTNESSES, "gate transform 'strictness'", errors) as GateStrictness
    : undefined
  return {
    type,
    ...whenDefined(strictness, (presentStrictness) => ({ strictness: presentStrictness })),
    ...(raw.script ? { script: resolvePath(baseDir, str(raw.script, '')) } : {}),
    ...(raw.agent ? { agent: str(raw.agent, '') } : {}),
    ...(raw.prompt ? { prompt: str(raw.prompt, '') } : {}),
    ...(raw.input ? { input: str(raw.input, '') } : {}),
    ...(raw.output ? { output: str(raw.output, '') } : {}),
    ...(raw.timeout_minutes != null ? { timeout_minutes: num(raw.timeout_minutes, 0) } : {}),
  }
}

function parseGateCondition(raw: YamlObject | undefined, errors: string[], gateLabel: string): GateCondition {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`Gate ${gateLabel} is missing a 'condition' mapping`)
    // Placeholder only — the parse fails on the error above, so this value
    // never reaches a runnable config.
    return { type: 'artifact_exists', artifact: 'output.md' }
  }
  const condType = validateEnum(
    str(raw.type, 'artifact_exists'),
    GATE_CONDITION_TYPES,
    "gate condition 'type'",
    errors,
  )
  switch (condType) {
    case 'artifact_exists':
      return { type: 'artifact_exists', artifact: str(raw.artifact, 'output.md') }
    case 'validation':
      return {
        type: 'validation',
        validator: str(raw.validator, ''),
        strictness: validateEnum(
          str(raw.strictness, 'hard'),
          GATE_STRICTNESSES,
          "validation gate 'strictness'",
          errors,
        ) as GateStrictness,
      }
    case 'all_tasks_terminal':
      return { type: 'all_tasks_terminal' }
    case 'manual':
      return {
        type: 'manual',
        permission: parseYamlList(raw.permission, 'manual gate permission', errors).map((p) => String(p)),
      }
    case 'artifact_content':
      return {
        type: 'artifact_content',
        artifact: str(raw.artifact, ''),
        match: str(raw.match, ''),
        match_type: raw.match_type
          ? validateEnum(str(raw.match_type, 'contains'), ARTIFACT_MATCH_TYPES, "artifact_content 'match_type'", errors)
          : 'contains',
      }
    case 'agent_verdict':
      return {
        type: 'agent_verdict',
        validator: str(raw.validator, ''),
        verdict: str(raw.verdict, ''),
      }
    case 'artifact_json': {
      const value = raw.value
      if (
        value !== null &&
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      ) {
        errors.push("artifact_json 'value' must be a string, number, boolean, or null")
      }
      const operator = str(raw.operator, 'equals')
      if (operator !== 'equals') {
        errors.push("artifact_json 'operator' must be 'equals'")
      }
      const artifact = str(raw.artifact, '')
      const pointer = str(raw.pointer, '')
      if (!artifact) errors.push("artifact_json 'artifact' is required")
      if (pointer !== '' && !pointer.startsWith('/')) {
        errors.push("artifact_json 'pointer' must be empty or start with '/'")
      }
      return {
        type: 'artifact_json',
        artifact,
        pointer,
        operator: 'equals',
        value: value === null || ['string', 'number', 'boolean'].includes(typeof value)
          ? value as string | number | boolean | null
          : null,
      }
    }
    default:
      return { type: 'artifact_exists', artifact: 'output.md' }
  }
}

function parsePermissions(raw: YamlObject, errors: string[]): LevelPermissions {
  return {
    ...(raw.spawn_teams ? { spawn_teams: bool(raw.spawn_teams, false) } : {}),
    ...(raw.loopback != null
      ? { loopback: parseYamlList(raw.loopback, 'level permissions.loopback', errors).map((l) => String(l)) }
      : {}),
  }
}

function parseExternalWatches(raw: YamlValue, errors: string[]): Array<{ path: string; label: string; notify: string }> {
  return parseYamlList(raw, 'workspace.external_watches', errors).map((w) => {
    const watch = w as YamlObject
    return { path: str(watch.path, ''), label: str(watch.label, ''), notify: str(watch.notify, '') }
  })
}

function parseMounts(raw: YamlValue, errors: string[]): Array<{ from: string; to: string }> {
  return parseYamlList(raw, 'agent mount', errors).map((m) => {
    const mount = m as YamlObject
    return { from: str(mount.from, ''), to: str(mount.to, '') }
  })
}

function parseArtifactDeclarations(raw: YamlValue, field: string, errors: string[]): ArtifactDeclaration[] {
  return parseYamlList(raw, field, errors).map((item) => {
    const a = item as YamlObject
    return {
      path: str(a.path, ''),
      ...(a.description ? { description: str(a.description, '') } : {}),
    }
  })
}

function parseStructuredContract(raw: YamlObject | undefined): { schema?: string; description?: string } | undefined {
  if (!raw) return undefined
  return {
    ...(raw.schema ? { schema: str(raw.schema, '') } : {}),
    ...(raw.description ? { description: str(raw.description, '') } : {}),
  }
}

function parseStageInputContract(raw: YamlObject | undefined, errors: string[]) {
  if (!raw) return undefined
  return {
    ...(raw.artifacts ? { artifacts: parseArtifactDeclarations(raw.artifacts, 'workflow input_contract.artifacts', errors) } : {}),
    ...whenDefined(
      parseStructuredContract(isYamlObject(raw.structured) ? raw.structured : undefined),
      (structured) => ({ structured }),
    ),
  }
}

function parseStageOutputContract(raw: YamlObject | undefined, errors: string[]) {
  if (!raw) return undefined
  return {
    ...(raw.artifacts ? { artifacts: parseArtifactDeclarations(raw.artifacts, 'workflow output_contract.artifacts', errors) } : {}),
    ...whenDefined(
      parseStructuredContract(isYamlObject(raw.structured) ? raw.structured : undefined),
      (structured) => ({ structured }),
    ),
    ...(raw.completion_artifact ? { completion_artifact: str(raw.completion_artifact, '') } : {}),
  }
}

// ─── Failure policy parser ───────────────────────────────────────────────────

function parseAgentFailurePolicy(raw: YamlObject | undefined, errors: string[]): AgentFailurePolicy | undefined {
  if (!raw) return undefined
  const policy = validateEnum(
    str(raw.policy, 'retry'),
    ['retry', 'fallback', 'skip', 'halt'],
    `agent on_failure 'policy'`,
    errors,
  ) as AgentFailurePolicy['policy']
  return {
    policy,
    ...(raw.max_retries != null ? { max_retries: num(raw.max_retries, DEFAULT_MAX_RETRIES) } : {}),
    ...(raw.fallback_agent ? { fallback_agent: str(raw.fallback_agent, '') } : {}),
  }
}

// ─── Main orchestrator ───────────────────────────────────────────────────────

/**
 * Parse a team.yaml file into a typed TeamConfig.
 */
export function parseTeamConfig(filePath: string): ParseResult {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return { config: null, errors: [`Cannot read ${filePath}`], warnings: [] }
  }

  const errors: string[] = []
  const raw = parseYaml(content)
  const baseDir = path.dirname(path.resolve(filePath))

  // ── Team metadata ──
  const teamRaw = raw.team as YamlObject | undefined
  if (!teamRaw) {
    errors.push('Missing required field: team')
    return { config: null, errors, warnings: [] }
  }
  const team = {
    name: str(teamRaw.name, 'unnamed-team'),
    description: str(teamRaw.description, ''),
    version: str(teamRaw.version, '0.1.0'),
    // Only `true` marks a team unfinished; anything else is a runnable team.
    ...(teamRaw?.building === true ? { building: true as const } : {}),
  }

  // ── Defaults ──
  const defaultsRaw = raw.defaults as YamlObject | undefined
  const defaults: TeamDefaultsConfig | undefined = defaultsRaw
    ? {
        ...(defaultsRaw.provider ? { provider: str(defaultsRaw.provider, '') } : {}),
      }
    : undefined

  // ── Legacy models-by-tier table (read for diagnostics, never obeyed) ──
  const modelsRaw = raw.models as YamlObject | undefined
  const legacyModels: Record<string, LegacyModelConfig> = {}
  if (modelsRaw) {
    for (const [key, val] of Object.entries(modelsRaw)) {
      const m = val as YamlObject
      legacyModels[key] = {
        model: str(m.model, ''),
        thinking: str(m.thinking, DEFAULT_THINKING) as LegacyModelConfig['thinking'],
        ...(m.context != null ? { context: String(m.context) } : {}),
        ...(m.provider ? { provider: str(m.provider, '') } : {}),
        ...(isYamlObject(m.provider_config) ? { provider_config: m.provider_config } : {}),
      }
    }
  }
  const hasLegacyModels = Object.keys(legacyModels).length > 0

  // ── Agents ──
  const agentsRaw = raw.agents as YamlValue[] | undefined
  const agents: AgentRosterEntry[] = []
  if (!agentsRaw || !Array.isArray(agentsRaw)) {
    errors.push('Missing or invalid required field: agents (must be an array)')
  } else {
    for (const entry of agentsRaw) {
      const a = entry as YamlObject
      // The grade is read, not judged. It selects nothing, so an unfamiliar
      // one — `specialist` from an older Resource Architect, say — is a label
      // on somebody's working Team rather than a reason to refuse the file.
      // The checks this parser does make are untouched: `type` is still an
      // enum, and the reference and artifact validators still run.
      const retiredTier = typeof a.tier === 'string' ? a.tier : undefined
      agents.push({
        name: str(a.name, ''),
        type: validateEnum(str(a.type, 'agent'), AGENT_TYPES, "agent 'type'", errors),
        role: str(a.role, ''),
        ...whenDefined(retiredTier, (tier) => ({ tier })),
        agent_file: resolvePath(baseDir, str(a.agent_file, '')),
        ...whenDefined(parseToolList(a.tools), (tools) => ({ tools })),
        ...(a.experience_file ? { experience_file: resolvePath(baseDir, str(a.experience_file, '')) } : {}),
        experience_enabled: bool(a.experience_enabled, true),
        ...(a.color != null ? { color: num(a.color, 36) } : {}),
        ...(a.model ? { legacyModel: str(a.model, '') } : {}),
        ...(a.team_path ? { team_path: resolvePath(baseDir, str(a.team_path, '')) } : {}),
        ...(a.input_artifact ? { input_artifact: str(a.input_artifact, '') } : {}),
        ...(a.output_artifact ? { output_artifact: str(a.output_artifact, '') } : {}),
        ...(a.mount ? { mount: parseMounts(a.mount, errors) } : {}),
        ...(a.produces ? { produces: parseArtifactDeclarations(a.produces, 'agent produces', errors) } : {}),
        ...(a.consumes ? { consumes: parseArtifactDeclarations(a.consumes, 'agent consumes', errors) } : {}),
        ...whenDefined(parseAgentFailurePolicy(a.on_failure as YamlObject | undefined, errors), (on_failure) => ({ on_failure })),
        ...(a.provider ? { legacyProvider: str(a.provider, '') } : {}),
        ...(isYamlObject(a.provider_config) ? { legacyProviderConfig: a.provider_config } : {}),
      })
    }
  }
  const agentNames = new Set(agents.map((a) => a.name))

  // ── Warnings (collected across all parsing phases) ──
  const warnings: string[] = []

  // Retired runtime settings are read so they can be named, never obeyed.
  if (hasLegacyModels) {
    warnings.push(
      `Team declares a models-by-tier table (${Object.keys(legacyModels).sort().join(', ')}). ` +
        `It is ignored: each agent runs with its own provider/model, or with the application default.`,
    )
  }
  if (defaults?.provider) {
    warnings.push(
      `Team declares defaults.provider '${defaults.provider}'. It is ignored: an agent ` +
        `without its own model uses the application default from Settings.`,
    )
  }
  // Named once for the whole roster rather than per member, so a Team that
  // predates the change reports the setting without burying its real
  // diagnostics under one line per Agent.
  const gradedMembers = agents.filter((agent) => agent.tier !== undefined)
  if (gradedMembers.length > 0) {
    warnings.push(
      `Team declares a tier for ${gradedMembers.map((agent) => agent.name).join(', ')}. ` +
        `It is ignored: a member's role says how it is used, and each agent runs with ` +
        `its own provider/model or with the application default.`,
    )
  }
  for (const agent of agents) {
    if (!agent.legacyModel && !agent.legacyProvider && !agent.legacyProviderConfig) {
      continue
    }
    const declared = [
      ...(agent.legacyProvider ? [`provider '${agent.legacyProvider}'`] : []),
      ...(agent.legacyModel ? [`model '${agent.legacyModel}'`] : []),
      ...(agent.legacyProviderConfig ? ['provider options'] : []),
    ].join(' and ')
    warnings.push(
      `Roster entry '${agent.name}' declares ${declared}. It is ignored: edit the ` +
        `agent itself to change the model it runs with.`,
    )
  }

  // ── Levels ──
  const levelsRaw = raw.levels as YamlValue[] | undefined
  const levels: LevelConfig[] = []
  if (!levelsRaw || !Array.isArray(levelsRaw)) {
    errors.push('Missing or invalid required field: levels (must be an array)')
  } else {
    for (let i = 0; i < levelsRaw.length; i++) {
      const l = levelsRaw[i] as YamlObject
      levels.push({
        id: str(l.id, `level-${i}`),
        name: str(l.name, `Level ${i + 1}`),
        order: num(l.order, i),
        stage: parseStage(l.stage as YamlObject, agentNames, errors, warnings),
        ...(l.permissions ? { permissions: parsePermissions(l.permissions as YamlObject, errors) } : {}),
      })
    }
  }

  // ── Gates ──
  const levelIds = new Set(levels.map((l) => l.id))
  const gatesRaw = raw.gates as YamlValue[] | undefined
  const gates: GateConfig[] = []
  if (gatesRaw && Array.isArray(gatesRaw)) {
    for (const g of gatesRaw) {
      const gate = g as YamlObject
      const gateFrom = str(gate.from, '')
      const gateTo = str(gate.to, '')
      if (!gateFrom) {
        errors.push("Gate is missing required 'from' field")
      } else if (!levelIds.has(gateFrom)) {
        errors.push(`Gate 'from' references unknown level '${gateFrom}'`)
      }
      if (!gateTo) {
        errors.push("Gate is missing required 'to' field")
      } else if (!isTerminalGate(gateTo) && !levelIds.has(gateTo)) {
        errors.push(`Gate 'to' references unknown level '${gateTo}' (use 'done' for the terminal gate)`)
      }
      let transform: GateTransform | undefined
      if (gate.transform) {
        transform = parseGateTransform(gate.transform as YamlObject, baseDir, errors)
        if (transform.type === 'agent' && transform.agent && !agentNames.has(transform.agent)) {
          errors.push(`Gate transform agent '${transform.agent}' not found in agent roster`)
        }
        if (transform.type === 'script' && transform.script && !fs.existsSync(transform.script)) {
          warnings.push(`Gate transform script not found at parse time: ${transform.script}`)
        }
      }
      const resetScopeRaw = gate.reset_scope ? str(gate.reset_scope, '') : undefined
      const resetScope = resetScopeRaw
        ? validateEnum(
            resetScopeRaw,
            ['target', 'target_through_source'] as const,
            "gate 'reset_scope'",
            errors,
          ) as GateConfig['reset_scope']
        : undefined
      let maxLoopbacks: number | undefined
      if (gate.max_loopbacks != null) {
        maxLoopbacks = num(gate.max_loopbacks, 0)
        if (!Number.isInteger(maxLoopbacks) || maxLoopbacks < 0) {
          errors.push("gate 'max_loopbacks' must be a non-negative integer")
          maxLoopbacks = undefined
        }
      }
      gates.push({
        from: gateFrom,
        to: gateTo,
        condition: parseGateCondition(gate.condition as YamlObject, errors, `from '${gateFrom}' to '${gateTo}'`),
        ...whenDefined(transform, (presentTransform) => ({ transform: presentTransform })),
        ...(resetScope ? { reset_scope: resetScope } : {}),
        ...(maxLoopbacks !== undefined ? { max_loopbacks: maxLoopbacks } : {}),
      })
    }
  }

  // ── Workspace ──
  const workspaceRaw = raw.workspace as YamlObject | undefined
  if (typeof workspaceRaw?.watch === 'string' && !['true', 'false'].includes(workspaceRaw.watch.toLowerCase())) {
    warnings.push(
      `workspace.watch: '${workspaceRaw.watch}' is not a recognized boolean — use true/false (unquoted yes/no stay strings in YAML 1.2); treating as false`,
    )
  }
  const workspace: WorkspaceConfig = {
    path: resolvePath(baseDir, str(workspaceRaw?.path, 'workspace')),
    watch: bool(workspaceRaw?.watch, false),
    ...(workspaceRaw?.routing_agent ? { routing_agent: str(workspaceRaw.routing_agent, '') } : {}),
    ...(workspaceRaw?.external_watches
      ? { external_watches: parseExternalWatches(workspaceRaw.external_watches, errors) }
      : {}),
  }

  // ── Workflow Template ──
  const workflowRaw = raw.workflow as YamlObject | undefined
  const workflow: WorkflowTemplateConfig | undefined = workflowRaw
    ? {
        ...(workflowRaw.entry_level ? { entry_level: str(workflowRaw.entry_level, '') } : {}),
        ...(workflowRaw.capabilities ? { capabilities: parseYamlList(workflowRaw.capabilities, 'workflow capabilities', errors).map((value) => String(value)) } : {}),
        ...(workflowRaw.invocation_modes ? { invocation_modes: parseYamlList(workflowRaw.invocation_modes, 'workflow invocation_modes', errors).map((value) => validateEnum(String(value), INVOCATION_MODES, "workflow invocation mode", errors)) } : {}),
        ...(workflowRaw.user_facing != null ? { user_facing: bool(workflowRaw.user_facing, true) } : {}),
        ...whenDefined(parseStageInputContract(workflowRaw.input_contract as YamlObject | undefined, errors), (input_contract) => ({ input_contract })),
        ...whenDefined(parseStageOutputContract(workflowRaw.output_contract as YamlObject | undefined, errors), (output_contract) => ({ output_contract })),
      }
    : undefined

  // ── Composition ──
  const compositionRaw = raw.composition as YamlObject | undefined
  let composition: TeamCompositionConfig | undefined
  if (compositionRaw) {
    const registryPath = compositionRaw.team_registry
      ? resolveRegistryPath(baseDir, str(compositionRaw.team_registry, ''))
      : undefined
    const parsedComposition: TeamCompositionConfig = {
      ...whenDefined(registryPath, (team_registry) => ({ team_registry })),
      ...(compositionRaw.spawn_limits
        ? { spawn_limits: {
            maxDepth: num((compositionRaw.spawn_limits as YamlObject).max_depth, 3),
            maxConcurrent: num((compositionRaw.spawn_limits as YamlObject).max_concurrent, 2),
            maxTotalBudgetUsd: num((compositionRaw.spawn_limits as YamlObject).max_total_budget_usd, 50),
          } }
        : {}),
    }
    composition = parsedComposition

    if (registryPath) {
      const registryResult = parseTeamRegistry(registryPath)
      if (registryResult.errors.length > 0) {
        errors.push(...registryResult.errors)
      }
      warnings.push(...registryResult.warnings)
      parsedComposition.registry_entries = registryResult.entries
    }
  } else {
    const implicitRegistryCandidates = [
      path.join(baseDir, 'teams.yaml'),
      path.join(baseDir, '.pi', 'teams.yaml'),
    ]

    const implicitRegistryPath = implicitRegistryCandidates.find((candidate) => fs.existsSync(candidate))
    if (implicitRegistryPath) {
      const registryResult = parseTeamRegistry(implicitRegistryPath)
      if (registryResult.errors.length > 0) {
        errors.push(...registryResult.errors)
      }
      warnings.push(...registryResult.warnings)
      composition = {
        team_registry: implicitRegistryPath,
        registry_entries: registryResult.entries,
      }
    }
  }

  // ── Rate Limiting ──
  const rateLimitingRaw = raw.rate_limiting as YamlObject | undefined
  let rateLimiting: RateLimitConfig | undefined
  if (rateLimitingRaw) {
    let maxConcurrent = num(rateLimitingRaw.max_concurrent, DEFAULT_MAX_CONCURRENT_AGENTS)
    if (maxConcurrent < 1) {
      warnings.push(`rate_limiting.max_concurrent must be >= 1 (got ${maxConcurrent}), clamping to 1`)
      maxConcurrent = 1
    }
    rateLimiting = {
      maxConcurrent,
      delayBetweenMs: num(rateLimitingRaw.delay_between_ms, DEFAULT_DISPATCH_DELAY_MS),
    }
  }

  // ── Budget ──
  const budgetRaw = raw.budget as YamlObject | undefined
  let budget: SessionBudgetConfig | undefined
  if (budgetRaw) {
    const capUsd = num(budgetRaw.cap_usd, DEFAULT_SESSION_BUDGET_USD)
    if (capUsd <= 0) {
      warnings.push('budget.cap_usd must be > 0 for enforcement to be meaningful')
    }
    // Declaring `cap_usd` alone reads as tightening spend, but `enforce` parses
    // as false when omitted, so team-runtime/index.ts:778 computes
    // shouldEnforce=false and this configured cap never applies.
    //
    // The claim is deliberately scoped to *this* cap. The parser cannot see the
    // environment, and TEAM_BUDGET_CAP can still supply one
    // (team-runtime/index.ts:773-792), in which case a ledger is created after
    // all — from the override, not from this file.
    //
    // `== null` treats an absent key and an explicit `enforce: null` alike: both
    // are "not stated", which is the case worth flagging. An explicit
    // `enforce: false` is a deliberate opt-out and stays silent.
    if (budgetRaw.cap_usd != null && budgetRaw.enforce == null) {
      warnings.push(
        `budget.cap_usd is set but budget.enforce is not stated, so this configured cap ` +
        `is INACTIVE unless a runtime override such as TEAM_BUDGET_CAP supplies one. ` +
        `Note that omitting the budget section entirely would still yield a finite ` +
        `advisory ledger. Add 'enforce: true' to apply this cap, or 'enforce: false' to ` +
        `opt out deliberately.`,
      )
    }
    budget = {
      cap_usd: capUsd,
      enforce: bool(budgetRaw.enforce, false),
      on_exceed: validateEnum(str(budgetRaw.on_exceed, DEFAULT_BUDGET_POLICY), BUDGET_POLICIES, "budget 'on_exceed'", errors) as 'halt' | 'warn',
    }
  }

  // ── Basic validation ──
  if (levels.length === 0) errors.push('At least one level is required')
  if (agents.length === 0) errors.push('At least one agent is required')
  validateAgentReferences(agents, errors)
  validateStageContracts(levels, errors)
  validateWorkflowTemplate(workflow, levels, gates, errors)
  validateArtifactContracts(agents, levels, gates, errors, warnings)
  validateConditionalRouting(gates, agentNames, errors, warnings)
  validateFailurePolicies(agents, errors, warnings)

  if (errors.length > 0) {
    return { config: null, errors, warnings }
  }

  return {
    config: {
      team,
      workspace,
      ...whenDefined(workflow, (presentWorkflow) => ({ workflow: presentWorkflow })),
      ...whenDefined(defaults, (presentDefaults) => ({ defaults: presentDefaults })),
      ...whenDefined(composition, (presentComposition) => ({ composition: presentComposition })),
      ...(hasLegacyModels ? { legacyModels } : {}),
      levels,
      gates,
      agents,
      ...whenDefined(rateLimiting, (presentRateLimiting) => ({ rateLimiting: presentRateLimiting })),
      ...whenDefined(budget, (presentBudget) => ({ budget: presentBudget })),
    },
    errors: [],
    warnings,
  }
}

// ─── Child workspace resolver ────────────────────────────────────────────────

/**
 * Resolve the workspace path for a child team.
 *
 * Reads the child team's team.yaml to find the configured workspace path.
 * Falls back to `<teamPath>/workspace` if no config is found or no path is set.
 *
 * Parsing stays at the parser boundary; Agent Execution consumes the resolved
 * workspace path rather than owning team configuration discovery.
 */
export function resolveChildWorkspacePath(teamPath: string): string {
  const configCandidates = [
    path.join(teamPath, 'team.yaml'),
    path.join(teamPath, '.pi', 'team.yaml'),
  ]

  for (const configPath of configCandidates) {
    if (!fs.existsSync(configPath)) continue
    try {
      const raw = parseYaml(fs.readFileSync(configPath, 'utf-8'))
      const workspaceRaw = raw.workspace as YamlObject | undefined
      const workspacePath = str(workspaceRaw?.path, '')
      if (workspacePath) return resolvePath(path.dirname(configPath), workspacePath)
    } catch {
      // Ignore parse failures and try the full parser next.
    }

    const result = parseTeamConfig(configPath)
    if (result.config?.workspace.path) return result.config.workspace.path
  }

  return path.join(teamPath, 'workspace')
}
