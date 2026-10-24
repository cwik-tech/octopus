/**
 * Config Validator
 *
 * Validates a parsed TeamConfig for correctness:
 * - Artifact contracts (producers, consumers, gate requirements)
 * - Agent reference validation
 * - Stage contracts, conditional routing, and failure policies
 */

import * as path from 'node:path'
import { MAX_ALLOWED_RETRIES, ADDITIVE_STAGE_TYPES } from '../core/constants.js'
import { isSafePathSegment } from '../core/path-safety.js'
import type {
  AgentRosterEntry,
  LevelConfig,
  GateConfig,
  StageArtifactContract,
  WorkflowTemplateConfig,
} from '../core/types.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Lowercase + replace underscores with hyphens for fuzzy matching. */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/_/g, '-')
}

/** Find a near-match in a producers map (same normalized form, different exact form). */
export function findNearMatch(
  p: string,
  declaredProducers: Map<string, string>,
): { produced: string; producer: string } | undefined {
  const normP = normalize(p)
  for (const [produced, producer] of declaredProducers.entries()) {
    if (normalize(produced) === normP && produced !== p) {
      return { produced, producer }
    }
  }
  return undefined
}

function resolveConfiguredArtifactPath(output: { format: string; path?: string } | undefined): string | undefined {
  if (!output?.format) return undefined
  if (!output.path) return output.format
  return path.join(output.path, output.format)
}

// ─── Validators ──────────────────────────────────────────────────────────────

/**
 * Validate that every agent roster entry has a non-empty name that is one
 * path-safe segment with no control characters.
 */
export function validateAgentReferences(
  agents: AgentRosterEntry[],
  errors: string[],
): void {
  for (const agent of agents) {
    if (!agent.name) {
      errors.push('Agent entry missing name')
    } else if (!isSafePathSegment(agent.name)) {
      errors.push(`Agent '${agent.name}' name must be a single path-safe segment`)
    } else if (/\p{Cc}/u.test(agent.name)) {
      // A name becomes a folder name and appears in logs, prompts and the UI.
      // A double-quoted escape decodes to the real character, so a TAB or BEL
      // written as an escape reaches here the same as one typed raw.
      errors.push(`Agent name ${JSON.stringify(agent.name)} must not contain control characters`)
    }
  }
}


/**
 * Validate artifact contracts:
 * - Gate conditions referencing artifact_exists must have a declared producer
 * - Agent consumes declarations must have a declared producer
 * - Gate transform inputs must have a source
 * - No duplicate producers (warning)
 * - No empty paths (error)
 */
export function validateArtifactContracts(
  agents: AgentRosterEntry[],
  levels: LevelConfig[],
  gates: GateConfig[],
  errors: string[],
  warnings: string[],
): void {
  // Check 0: Empty path validation — hard error, config is broken
  for (const agent of agents) {
    for (const art of agent.produces || []) {
      if (art.path === '') {
        errors.push(`Agent '${agent.name}' has a produces declaration with an empty path.`)
      }
    }
    for (const art of agent.consumes || []) {
      if (art.path === '') {
        errors.push(`Agent '${agent.name}' has a consumes declaration with an empty path.`)
      }
    }
  }

  // Build declaredProducers: path → agent name
  // Sources: (a) agents' produces arrays (non-empty paths), (b) team-type agents' output_artifact
  const declaredProducers = new Map<string, string>()

  for (const agent of agents) {
    // Team-type agents' output_artifact counts as a producer
    if (agent.type === 'team' && agent.output_artifact) {
      if (!declaredProducers.has(agent.output_artifact)) {
        declaredProducers.set(agent.output_artifact, agent.name)
      }
    }
    // Explicit produces declarations
    for (const art of agent.produces || []) {
      if (art.path === '') continue
      if (declaredProducers.has(art.path)) {
        // Check 5: Duplicate producers — warning
        warnings.push(
          `Artifact '${art.path}' is declared as produced by both '${declaredProducers.get(art.path)}' and '${agent.name}'. Only one agent should own each artifact.`,
        )
      } else {
        declaredProducers.set(art.path, agent.name)
      }
    }
  }

  for (const level of levels) {
    if (level.stage.type !== 'review') continue
    const runtimeProducedArtifacts = new Set<string>()
    if (level.stage.config.output.format) {
      runtimeProducedArtifacts.add(level.stage.config.output.format)
    }
    if (level.stage.config.output_contract?.completion_artifact) {
      runtimeProducedArtifacts.add(level.stage.config.output_contract.completion_artifact)
    }

    for (const artifact of runtimeProducedArtifacts) {
      if (!artifact || declaredProducers.has(artifact)) continue
      declaredProducers.set(artifact, `runtime:${level.id}`)
    }
  }

  const nearMatch = (p: string) => findNearMatch(p, declaredProducers)

  // Check 1: Gate artifact has a declared producer — hard error
  for (const gate of gates) {
    if (
      gate.condition.type === 'artifact_exists' ||
      gate.condition.type === 'artifact_json'
    ) {
      const artifact = gate.condition.artifact
      if (!declaredProducers.has(artifact)) {
        const nm = nearMatch(artifact)
        if (nm) {
          errors.push(
            `Gate from '${gate.from}' to '${gate.to}' requires artifact '${artifact}' — did you mean '${nm.produced}' (declared by '${nm.producer}')? Names differ only in casing or separator characters.`,
          )
        } else {
          errors.push(
            `Gate from '${gate.from}' to '${gate.to}' requires artifact '${artifact}', but no agent declares producing it.`,
          )
        }
      }
    }
  }

  // Check 2 & 3: Consumed artifact has a declared producer — hard error
  for (const agent of agents) {
    for (const art of (agent.consumes || []).filter((a) => a.path !== '')) {
      if (!declaredProducers.has(art.path)) {
        const nm = nearMatch(art.path)
        if (nm) {
          errors.push(
            `Agent '${agent.name}' consumes '${art.path}' — did you mean '${nm.produced}' (declared by '${nm.producer}')? Names differ only in casing or separator characters.`,
          )
        } else {
          errors.push(`Agent '${agent.name}' consumes '${art.path}' but no agent declares producing it.`)
        }
      }
    }
  }

  // Check 4: Gate transform input has a source — hard error
  for (const gate of gates) {
    if (gate.transform?.input) {
      const input = gate.transform.input
      const conditionArtifact =
        gate.condition.type === 'artifact_exists' || gate.condition.type === 'artifact_json'
          ? gate.condition.artifact
          : undefined
      if (!declaredProducers.has(input) && input !== conditionArtifact) {
        errors.push(
          `Gate from '${gate.from}' to '${gate.to}' has transform input '${input}' but no agent declares producing it and it differs from the gate condition artifact.`,
        )
      }
    }
  }
}

/**
 * Validate conditional routing tables:
 * A — Fallback warning: multi-gate levels where the last gate is not a reliable fallback
 * B — Validator exists: agent_verdict gates referencing a nonexistent agent
 * C — Empty match string: artifact_content gates with an empty match
 * D — Artifact producer check: artifact_content gates referencing an undeclared artifact
 */
export function validateConditionalRouting(
  gates: GateConfig[],
  agentNames: Set<string>,
  errors: string[],
  warnings: string[],
): void {
  // Group gates by `from` level
  const byLevel = new Map<string, GateConfig[]>()
  for (const gate of gates) {
    const arr = byLevel.get(gate.from) ?? []
    arr.push(gate)
    byLevel.set(gate.from, arr)
  }

  // Collect artifact paths used in artifact_exists gate conditions as a proxy for
  // "declared producers". validateArtifactContracts already enforces that every
  // artifact_exists gate has a real producer, so this set is a safe proxy for
  // Validation D (artifact_content gates that reference undeclared artifacts).
  const knownArtifacts = new Set<string>()
  for (const gate of gates) {
    if (
      gate.condition.type === 'artifact_exists' ||
      gate.condition.type === 'artifact_json'
    ) {
      knownArtifacts.add(gate.condition.artifact)
    }
  }

  // Validation A — Fallback warning
  for (const [fromLevel, levelGates] of byLevel.entries()) {
    if (levelGates.length < 2) continue
    const lastGate = levelGates[levelGates.length - 1]
    if (!lastGate) continue
    const lastType = lastGate.condition.type
    if (lastType !== 'artifact_exists' && lastType !== 'all_tasks_terminal') {
      warnings.push(
        `Level '${fromLevel}' has ${levelGates.length} conditional gates but no fallback. ` +
          `If no condition matches, the pipeline will wait indefinitely.`,
      )
    }
  }

  // Validation B, C, D — per-gate checks
  for (const gate of gates) {
    const cond = gate.condition

    if (cond.type === 'agent_verdict') {
      // B — Validator must exist in agent roster
      if (!agentNames.has(cond.validator)) {
        errors.push(
          `Gate from '${gate.from}': agent_verdict validator '${cond.validator}' not found in agent roster.`,
        )
      }
    }

    if (cond.type === 'artifact_content') {
      // C — Empty match string
      if (cond.match === '') {
        warnings.push(
          `Gate from '${gate.from}': artifact_content gate has an empty match string — it will match any content.`,
        )
      }

      // D — Artifact producer check
      if (!knownArtifacts.has(cond.artifact)) {
        warnings.push(
          `Gate from '${gate.from}': artifact_content gate references artifact '${cond.artifact}', but no agent declares producing it.`,
        )
      }
    }
  }
}

function validateStageContractArtifacts(
  artifacts: StageArtifactContract[] | undefined,
  label: string,
  errors: string[],
): void {
  if (!artifacts) return
  for (const artifact of artifacts) {
    if (!artifact.path) {
      errors.push(`${label} contains an artifact contract with an empty path.`)
    }
  }
}

export function validateStageContracts(
  levels: LevelConfig[],
  errors: string[],
): void {
  for (const level of levels) {
    const cfg = level.stage.config as {
      input_contract?: { artifacts?: StageArtifactContract[] }
      output_contract?: { artifacts?: StageArtifactContract[]; completion_artifact?: string }
      output?: { format: string; path?: string }
    }

    validateStageContractArtifacts(
      cfg.input_contract?.artifacts,
      `Level '${level.id}' input_contract`,
      errors,
    )
    validateStageContractArtifacts(
      cfg.output_contract?.artifacts,
      `Level '${level.id}' output_contract`,
      errors,
    )

    const completionArtifact = cfg.output_contract?.completion_artifact
    if (completionArtifact === '') {
      errors.push(`Level '${level.id}' output_contract has an empty completion_artifact.`)
    }

    if (completionArtifact && cfg.output_contract?.artifacts?.length) {
      const declaredPaths = new Set(cfg.output_contract.artifacts.map((artifact) => artifact.path).filter(Boolean))
      if (!declaredPaths.has(completionArtifact)) {
        errors.push(
          `Level '${level.id}' output_contract completion_artifact '${completionArtifact}' is not declared in output_contract.artifacts.`,
        )
      }
    }

    const configuredOutputArtifact = resolveConfiguredArtifactPath(cfg.output)
    if (
      completionArtifact &&
      configuredOutputArtifact &&
      completionArtifact !== configuredOutputArtifact
    ) {
      errors.push(
        `Level '${level.id}' output_contract completion_artifact '${completionArtifact}' does not match stage output artifact '${configuredOutputArtifact}'.`,
      )
    }
  }
}

export function validateWorkflowTemplate(
  workflow: WorkflowTemplateConfig | undefined,
  levels: LevelConfig[],
  gates: GateConfig[],
  errors: string[],
): void {
  if (!workflow) return

  const levelIds = new Set(levels.map((level) => level.id))

  if (workflow.entry_level === '') {
    errors.push('Workflow template has an empty entry_level.')
  } else if (workflow.entry_level && !levelIds.has(workflow.entry_level)) {
    errors.push(`Workflow template entry_level '${workflow.entry_level}' does not match any declared level.`)
  }

  validateStageContractArtifacts(
    workflow.input_contract?.artifacts,
    'Workflow input_contract',
    errors,
  )
  validateStageContractArtifacts(
    workflow.output_contract?.artifacts,
    'Workflow output_contract',
    errors,
  )

  const completionArtifact = workflow.output_contract?.completion_artifact
  if (completionArtifact === '') {
    errors.push('Workflow output_contract has an empty completion_artifact.')
  }

  if (completionArtifact && workflow.output_contract?.artifacts?.length) {
    const declaredPaths = new Set(workflow.output_contract.artifacts.map((artifact) => artifact.path).filter(Boolean))
    if (!declaredPaths.has(completionArtifact)) {
      errors.push(
        `Workflow output_contract completion_artifact '${completionArtifact}' is not declared in workflow.output_contract.artifacts.`,
      )
    }
  }

  const terminalArtifactGate = gates.find((gate) => gate.to === 'done' && gate.condition.type === 'artifact_exists')
  if (
    completionArtifact &&
    terminalArtifactGate?.condition.type === 'artifact_exists' &&
    completionArtifact !== terminalArtifactGate.condition.artifact
  ) {
    errors.push(
      `Workflow output_contract completion_artifact '${completionArtifact}' does not match terminal gate artifact '${terminalArtifactGate.condition.artifact}'.`,
    )
  }
}

/**
 * Validate agent failure policies:
 * - fallback_agent must exist in roster
 * - fallback_agent must not reference itself
 * - max_retries must be 0–MAX_ALLOWED_RETRIES
 * - policy 'fallback' requires fallback_agent
 * - Warn if additive-stage agent has policy 'halt' (unusual but allowed)
 */
export function validateFailurePolicies(
  agents: AgentRosterEntry[],
  errors: string[],
  warnings: string[],
): void {
  const agentNames = new Set(agents.map((a) => a.name))

  for (const agent of agents) {
    const policy = agent.on_failure
    if (!policy) continue

    // max_retries bounds check
    if (policy.max_retries != null && (policy.max_retries < 0 || policy.max_retries > MAX_ALLOWED_RETRIES)) {
      errors.push(
        `Agent '${agent.name}': on_failure.max_retries must be between 0 and ${MAX_ALLOWED_RETRIES}, got ${policy.max_retries}`,
      )
    }

    // policy 'fallback' requires fallback_agent
    if (policy.policy === 'fallback' && !policy.fallback_agent) {
      errors.push(
        `Agent '${agent.name}': on_failure.policy is 'fallback' but no fallback_agent is specified`,
      )
    }

    // fallback_agent validation
    if (policy.fallback_agent) {
      // must not reference itself
      if (policy.fallback_agent === agent.name) {
        errors.push(
          `Agent '${agent.name}': on_failure.fallback_agent references itself — a fallback agent must be a different agent`,
        )
      } else if (!agentNames.has(policy.fallback_agent)) {
        // must exist in roster
        errors.push(
          `Agent '${agent.name}': on_failure.fallback_agent '${policy.fallback_agent}' not found in agent roster`,
        )
      }
    }

    // Warn if an agent in an additive stage role has policy 'halt' (unusual but allowed)
    // We can only check the agent's own policy here; stage context is not available at this point.
    // Emit the warning as a general advisory when policy is halt — engines can produce this at runtime.
    if (policy.policy === 'halt') {
      // Check if this agent name appears in any additive-stage context is not possible here
      // without the level configs. We emit a general advisory warning instead.
      warnings.push(
        `Agent '${agent.name}': on_failure.policy is 'halt' — note that halt stops the entire level including additive stages (discussion/broadcast). Ensure this is intentional.`,
      )
    }
  }
}
