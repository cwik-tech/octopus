/**
 * Where one `team.yaml` names a roster member, read from its parsed form.
 *
 * `collectTeamLocalReferences` lists each place that names the member: a
 * stage's coordinator or membership list, a review stage's producer or
 * reviewer, the workspace `routing_agent`, a gate's agent transform or its
 * `validation` or `agent_verdict` validator, and another member's
 * `on_failure.fallback_agent`.
 * Each is a `list` reference removal prunes or a `singleton` role it refuses
 * to drop. `joinReferenceLabels` joins their labels into the text of a
 * message. Neither does I/O. `removeTeamBuilderAgent` in `team-manager.ts`
 * keeps the lock, the reads, the refusals, validation and the write. The
 * membership key each stage type reads comes from `STAGE_MEMBERSHIP_KEY` in
 * `team-yaml-scalars.ts`, so this module does not import the removal edits,
 * and it does not import `team-manager.ts`.
 */

import type { YamlObject } from '../../core/yaml-parser.js'
import {
  STAGE_MEMBERSHIP_KEY,
  isObject,
  joinLabels,
  parseStringList,
  stringOrUndefined,
} from './team-yaml-scalars.js'

export interface TeamLocalReference {
  /**
   * `list` is a membership the stage can lose and stay structurally valid, so
   * removal prunes it. `singleton` is the one agent a role is defined by, so
   * dropping the key would silently change what the team does; removal is
   * rejected and the caller reassigns the role.
   */
  kind: 'list' | 'singleton'
  label: string
}

/**
 * Gate condition types whose `validator` names a roster agent.
 *
 * Both run the named agent: `engines/gate-checker.ts:74` dispatches a
 * `validation` condition through `checkValidation`, `:86` dispatches
 * `agent_verdict` through `checkAgentVerdict`, and both resolve the name
 * against the roster before running it. Only `agent_verdict` is checked by
 * `validateConditionalRouting`, so a dangling `validation` validator is not a
 * parse error and nothing downstream would catch it.
 */
const AGENT_VALIDATOR_CONDITION_TYPES = new Set<string>(['validation', 'agent_verdict'])

/** Every place inside one `team.yaml` that can name a roster member. */
export function collectTeamLocalReferences(
  raw: YamlObject,
  agentName: string,
): TeamLocalReference[] {
  const references: TeamLocalReference[] = []
  const levels = Array.isArray(raw.levels) ? raw.levels.filter(isObject) : []
  for (const [index, level] of levels.entries()) {
    const stage = isObject(level.stage) ? level.stage : undefined
    if (!stage) continue
    const where = `level '${stringOrUndefined(level.id) ?? `level-${index}`}'`
    const stageType = stringOrUndefined(stage.type) ?? 'discussion'
    // A coordinator is the level's host on every stage type
    // (`team-runtime/index.ts` `getCurrentCoordinator`). A producer and a
    // reviewer are read only by a review stage; on any other type they are
    // inert text, and an inert key is not a role to reassign.
    const roles = stageType === 'review'
      ? (['coordinator', 'producer', 'reviewer'] as const)
      : (['coordinator'] as const)
    for (const role of roles) {
      if (stringOrUndefined(stage[role]) === agentName) {
        references.push({ kind: 'singleton', label: `the ${stageType} ${role} of ${where}` })
      }
    }
    const membership = STAGE_MEMBERSHIP_KEY[stageType]
    if (membership && parseStringList(stage[membership]).includes(agentName)) {
      references.push({ kind: 'list', label: `a member of ${membership} in ${where}` })
    }
  }

  const workspace = isObject(raw.workspace) ? raw.workspace : undefined
  if (workspace && stringOrUndefined(workspace.routing_agent) === agentName) {
    references.push({ kind: 'singleton', label: 'the workspace routing_agent' })
  }

  const gates = Array.isArray(raw.gates) ? raw.gates.filter(isObject) : []
  for (const gate of gates) {
    const where =
      `the gate from '${stringOrUndefined(gate.from) ?? ''}' ` +
      `to '${stringOrUndefined(gate.to) ?? ''}'`
    const transform = isObject(gate.transform) ? gate.transform : undefined
    // A script transform runs its script; an `agent:` beside it names nobody.
    if (
      transform &&
      stringOrUndefined(transform.type) !== 'script' &&
      stringOrUndefined(transform.agent) === agentName
    ) {
      references.push({ kind: 'singleton', label: `the gate transform agent of ${where}` })
    }
    const condition = isObject(gate.condition) ? gate.condition : undefined
    const conditionType = condition ? stringOrUndefined(condition.type) : undefined
    if (
      condition &&
      conditionType !== undefined &&
      AGENT_VALIDATOR_CONDITION_TYPES.has(conditionType) &&
      stringOrUndefined(condition.validator) === agentName
    ) {
      references.push({ kind: 'singleton', label: `the ${conditionType} validator of ${where}` })
    }
  }

  const rosterAgents = Array.isArray(raw.agents) ? raw.agents.filter(isObject) : []
  for (const rosterAgent of rosterAgents) {
    const name = stringOrUndefined(rosterAgent.name)
    if (!name || name === agentName) continue
    const onFailure = isObject(rosterAgent.on_failure) ? rosterAgent.on_failure : undefined
    if (onFailure && stringOrUndefined(onFailure.fallback_agent) === agentName) {
      references.push({
        kind: 'singleton',
        label: `the on_failure.fallback_agent of agent '${name}'`,
      })
    }
  }

  return references
}

export function joinReferenceLabels(references: TeamLocalReference[]): string {
  return joinLabels(references.map((reference) => reference.label))
}
