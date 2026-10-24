/**
 * The rules that decide whether a proposed `resource_updates` plan may exist.
 *
 * Everything here is a pure function of a draft, the user's own words, and a
 * snapshot of the repository. It reads no files and writes none, so the same
 * decision can be examined without a temporary directory, and the reading of
 * the repository is somebody else's job (`resource-update-plan.ts`).
 */

import type {
  ChatTurn,
  ResourceSkillUpdate,
  ResourceTeamAgentPlan,
  ResourceTeamNewAgentPlan,
  ResourceUpdateOperation,
  ResourceUpdateOperationDraft,
  ResourceUpdatePlan,
  ResourceUpdatePlanDraft,
} from '../../contracts/resource-architect.js'
import { validateExactAgentName } from '../agent-generator/agent-name-rules.js'
import { findSkillUpdateStructureViolation } from './skill-update-rules.js'

export type ResourceUpdatePlanErrorCode = 'bad_request' | 'conflict'

export class ResourceUpdatePlanError extends Error {
  constructor(readonly code: ResourceUpdatePlanErrorCode, message: string) {
    super(message)
    this.name = 'ResourceUpdatePlanError'
  }
}

export class ResourceUpdateTargetConfirmationRequired extends ResourceUpdatePlanError {
  constructor(readonly question: string) {
    super('bad_request', question)
    this.name = 'ResourceUpdateTargetConfirmationRequired'
  }
}

/** One registered Team as the policy needs to see it. */
export interface ResourceUpdateTeamSnapshot {
  id: string
  rosterAgentNames: ReadonlySet<string>
  /** The revision the server calculated from the registered `team.yaml`. */
  revision: string
}

/** One existing Agent as the policy needs to see it. */
export interface ResourceUpdateAgentSnapshot {
  id: string
  /** The revision the server calculated from the persona and `skills/**`. */
  revision: string
  /** Skill folders the Agent already owns. */
  skillFolderNames: ReadonlySet<string>
  /**
   * Skill folders whose `SKILL.md` could be read, whatever it contains.
   *
   * Conformance is deliberately not part of this: a skill whose current
   * document breaks the specification is exactly the skill a user asks to have
   * rewritten, and requiring conformance here would lock the repair out of the
   * one path that can perform it. Only the newly authored document has to
   * conform, and that is checked where it is generated.
   */
  readableSkillNames: ReadonlySet<string>
}

/** The repository state one plan is decided against. */
export interface ResourceUpdateInventory {
  /** Registered Teams by exact id. A target that is absent does not exist. */
  teams: ReadonlyMap<string, ResourceUpdateTeamSnapshot>
  libraryAgentNames: ReadonlySet<string>
  /** Existing Agents by exact id. A target that is absent does not exist. */
  agents: ReadonlyMap<string, ResourceUpdateAgentSnapshot>
}

/**
 * Validates a proposed update plan and returns the persisted form.
 *
 * Throws `ResourceUpdatePlanError` rather than returning a partial plan: a
 * proposal the user cannot have meant is not worth persisting in any form.
 */
export function planResourceUpdates(params: {
  inventory: ResourceUpdateInventory
  draft: ResourceUpdatePlanDraft
  history: ChatTurn[]
}): ResourceUpdatePlan {
  if (params.draft.operations.length === 0) {
    throw new ResourceUpdatePlanError(
      'bad_request',
      'An update plan must contain at least one operation',
    )
  }
  assertPlanWideUniqueness(params.draft.operations)
  const requested = renderRequestedText(params.history)
  const confirmedTeamIds = confirmInferredTeamTargets(
    params.inventory, params.draft.operations, params.history, requested,
  )
  const operations = params.draft.operations.map((operation) =>
    materializeOperation(params.inventory, operation, requested, confirmedTeamIds),
  )
  return { id: params.draft.id, kind: 'resource_updates', operations }
}

/**
 * The first plan-wide rule these operations break, or `null` when they break none.
 *
 * Two operations on one Team would be stamped with the same revision, and each
 * would be authorized against a Team the other is about to change: whichever
 * ran second would conflict against its own sibling's write. Two operations
 * creating one Agent name are worse — one name is one Agent, so both would
 * reserve and generate a single global identity and race for the same folder.
 * A library Agent joining several Teams is different in kind: that identity
 * already exists and is only being referenced.
 *
 * Returned rather than thrown, because the same rules apply in two places with
 * two different answers: a proposal is refused with this message, and a plan
 * read back from disk is simply not a plan. Persisted operations carry a
 * revision the drafts do not, and are otherwise the same shape, so both go
 * through this one rule.
 */
export function findResourceUpdatePlanViolation(
  operations: readonly ResourceUpdateOperationDraft[],
): string | null {
  const targets = new Set<string>()
  const createdNames = new Set<string>()
  for (const operation of operations) {
    const target = `${operation.target.kind}:${operation.target.id}`
    if (targets.has(target)) {
      return `A plan may update ${describeTargetKind(operation.target.kind)} '${operation.target.id}' only once`
    }
    targets.add(target)
    if (operation.kind !== 'add_team_agents') continue
    for (const planned of operation.newAgentsToCreate) {
      if (createdNames.has(planned.name)) {
        return `A plan may create Agent '${planned.name}' only once`
      }
      createdNames.add(planned.name)
    }
  }
  return null
}

function assertPlanWideUniqueness(
  operations: readonly ResourceUpdateOperationDraft[],
): void {
  const violation = findResourceUpdatePlanViolation(operations)
  if (violation) throw new ResourceUpdatePlanError('bad_request', violation)
}

/**
 * The first structural rule these additions break, or `null`.
 *
 * Shared with the parser that reads a plan back from disk, for the same reason
 * the skill rules are: an operation with two empty lists reaches the executor
 * with no names at all and can report a Team as updated having changed no
 * roster, and a duplicate reaches the Team writer twice.
 */
export function findTeamAdditionStructureViolation(
  libraryAgentsToAdd: readonly { name: string }[],
  newAgentsToCreate: readonly { name: string }[],
  teamId: string,
): string | null {
  const additions = [...libraryAgentsToAdd, ...newAgentsToCreate]
  if (additions.length === 0) {
    return `Operation on Team '${teamId}' must add at least one Agent`
  }
  const seen = new Set<string>()
  for (const addition of additions) {
    if (seen.has(addition.name)) {
      return `Duplicate Agent in one update operation: ${addition.name}`
    }
    seen.add(addition.name)
  }
  return null
}

function describeTargetKind(kind: 'agent' | 'team'): string {
  return kind === 'team' ? 'Team' : 'Agent'
}

function materializeOperation(
  inventory: ResourceUpdateInventory,
  operation: ResourceUpdateOperationDraft,
  requestedText: string,
  confirmedTeamIds: ReadonlySet<string>,
): ResourceUpdateOperation {
  if (operation.target.kind !== 'team' || !confirmedTeamIds.has(operation.target.id)) {
    assertExplicitlyRequested(operation.target.id, requestedText)
  }
  if (operation.kind === 'update_agent_skills') {
    return materializeSkillOperation(inventory, operation)
  }
  const team = inventory.teams.get(operation.target.id)
  if (!team) {
    throw new ResourceUpdatePlanError(
      'bad_request',
      `Team not found: ${operation.target.id}`,
    )
  }
  const roster = team.rosterAgentNames
  const library = inventory.libraryAgentNames

  const structure = findTeamAdditionStructureViolation(
    operation.libraryAgentsToAdd,
    operation.newAgentsToCreate,
    operation.target.id,
  )
  if (structure) throw new ResourceUpdatePlanError('bad_request', structure)

  for (const existing of operation.libraryAgentsToAdd) {
    if (!library.has(existing.name)) {
      throw new ResourceUpdatePlanError(
        'bad_request',
        `Agent is not in the library: ${existing.name}`,
      )
    }
    if (roster.has(existing.name)) {
      throw new ResourceUpdatePlanError(
        'conflict',
        `Agent is already on the '${operation.target.id}' roster: ${existing.name}`,
      )
    }
  }

  for (const planned of operation.newAgentsToCreate) {
    try {
      validateExactAgentName(planned.name)
    } catch (error) {
      throw new ResourceUpdatePlanError(
        'bad_request',
        error instanceof Error ? error.message : String(error),
      )
    }
    if (library.has(planned.name)) {
      throw new ResourceUpdatePlanError(
        'conflict',
        `Agent name already exists: ${planned.name}`,
      )
    }
    if (roster.has(planned.name)) {
      throw new ResourceUpdatePlanError(
        'conflict',
        `Agent is already on the '${operation.target.id}' roster: ${planned.name}`,
      )
    }
  }

  return {
    kind: 'add_team_agents',
    target: { kind: 'team', id: operation.target.id },
    expectedRevision: team.revision,
    libraryAgentsToAdd: operation.libraryAgentsToAdd.map(copyLibraryAgent),
    newAgentsToCreate: operation.newAgentsToCreate.map(copyNewAgent),
  }
}

function materializeSkillOperation(
  inventory: ResourceUpdateInventory,
  operation: Extract<ResourceUpdateOperationDraft, { kind: 'update_agent_skills' }>,
): ResourceUpdateOperation {
  const agent = inventory.agents.get(operation.target.id)
  if (!agent) {
    throw new ResourceUpdatePlanError(
      'bad_request',
      `Agent not found: ${operation.target.id}`,
    )
  }
  const violation = findSkillUpdateStructureViolation(operation.skillUpdates)
  if (violation) throw new ResourceUpdatePlanError('bad_request', violation)

  for (const update of operation.skillUpdates) {
    if (update.action === 'create') {
      // Any occupied name, not only an existing skill folder. A regular file
      // at that path would collide with the create just the same.
      if (agent.skillFolderNames.has(update.name)) {
        throw new ResourceUpdatePlanError(
          'conflict',
          `Agent '${agent.id}' already has a skill named '${update.name}'`,
        )
      }
      continue
    }
    if (!agent.skillFolderNames.has(update.name)) {
      throw new ResourceUpdatePlanError(
        'bad_request',
        `Agent '${agent.id}' has no skill named '${update.name}' to update`,
      )
    }
    // Readable, not conformant. The bytes are context for the rewrite; only
    // what the rewrite produces has to satisfy the specification.
    if (!agent.readableSkillNames.has(update.name)) {
      throw new ResourceUpdatePlanError(
        'conflict',
        `Skill '${update.name}' on Agent '${agent.id}' has no readable SKILL.md to update`,
      )
    }
  }

  return {
    kind: 'update_agent_skills',
    target: { kind: 'agent', id: agent.id },
    expectedRevision: agent.revision,
    skillUpdates: operation.skillUpdates.map(copySkillUpdate),
  }
}

function copySkillUpdate(update: ResourceSkillUpdate): ResourceSkillUpdate {
  return { action: update.action, name: update.name, instruction: update.instruction }
}

/**
 * Mutation authority comes from the user's own words.
 *
 * The visible resource and any assistant turn are context. The user must type
 * either the exact id or its exact visible-name form. A Team inferred by the
 * Architect requires the user's affirmative answer to the server's question
 * naming that exact ID. Other assistant mentions carry no write authority.
 */
function confirmInferredTeamTargets(
  inventory: ResourceUpdateInventory,
  operations: readonly ResourceUpdateOperationDraft[],
  history: readonly ChatTurn[],
  requestedText: string,
): ReadonlySet<string> {
  const userIndex = history.map((turn) => turn.role).lastIndexOf('user')
  const answer = history[userIndex]?.text.trim()
  const preceding = history[userIndex - 1]
  const pendingQuestion = preceding?.role === 'assistant'
    ? preceding.text.trim().split('\n\nContext notes:\n')[0] ?? ''
    : ''
  const pendingIds = confirmationQuestionIds(pendingQuestion)
  const inferredIds = operations.flatMap((operation) =>
    operation.target.kind === 'team' && inventory.teams.has(operation.target.id) &&
      (pendingIds.has(operation.target.id) || !mentionsResourceName(operation.target.id, requestedText))
      ? [operation.target.id] : [],
  ).sort()
  if (inferredIds.length === 0) return new Set()
  const question = teamConfirmationQuestion(inferredIds)
  const affirmative = answer !== undefined && /^(?:yes(?:,? please)?|confirm|confirmed|correct)[.!]?$/iu.test(answer)
  const exactIdAnswer = inferredIds.length === 1 && answer === inferredIds[0]
  if (pendingQuestion === question && (affirmative || exactIdAnswer)) {
    return new Set(inferredIds)
  }
  throw new ResourceUpdateTargetConfirmationRequired(question)
}

function teamConfirmationQuestion(ids: readonly string[]): string {
  return `Did you mean ${ids.map((id) => `Team \`${id}\``).join(' and ')}? Reply yes to confirm, or give the exact Team ID you meant.`
}

function confirmationQuestionIds(question: string): ReadonlySet<string> {
  const ids = [...question.matchAll(/Team `([^`]+)`/gu)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  )
  // Only our exact question grants confirmation authority. Model commentary
  // and appended document warnings cannot introduce additional Team IDs.
  return question === teamConfirmationQuestion(ids) ? new Set(ids) : new Set()
}

function assertExplicitlyRequested(targetId: string, requestedText: string): void {
  if (mentionsResourceName(targetId, requestedText)) return
  throw new ResourceUpdatePlanError('bad_request', `Update target was never named in the request: ${targetId}`)
}

function mentionsResourceName(targetId: string, requestedText: string): boolean {
  const escapedId = escapeRegularExpression(targetId)
  const visibleNameParts = targetId
    .split(/[-_]+/u)
    .filter((part) => part.length > 0)
    .map(escapeRegularExpression)
  const visibleName = visibleNameParts.length > 1
    ? visibleNameParts.join('(?:[-_]+|[ \\t]+)')
    : escapedId
  const target = visibleName === escapedId
    ? escapedId
    : `(?:${escapedId}|${visibleName})`
  return new RegExp(`(^|[^a-z0-9_-])${target}($|[^a-z0-9_-])`, 'iu').test(requestedText)
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function renderRequestedText(history: ChatTurn[]): string {
  return history
    .filter((turn) => turn.role === 'user')
    .map((turn) => turn.text)
    .join('\n')
}

function copyLibraryAgent(agent: ResourceTeamAgentPlan): ResourceTeamAgentPlan {
  return {
    name: agent.name,
    role: agent.role,
    rationale: agent.rationale,
  }
}

function copyNewAgent(agent: ResourceTeamNewAgentPlan): ResourceTeamNewAgentPlan {
  return {
    name: agent.name,
    role: agent.role,
    ...(typeof agent.summary === "string" ? { summary: agent.summary } : {}),
    description: agent.description,
    rationale: agent.rationale,
    ...(typeof agent.webResearchEnabled === "boolean" ? { webResearchEnabled: agent.webResearchEnabled } : {}),
    ...(agent.documentSpecialization
      ? { documentSpecialization: agent.documentSpecialization }
      : {}),
  }
}
