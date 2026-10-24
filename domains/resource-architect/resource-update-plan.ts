/**
 * Reads the repository a `resource_updates` proposal is decided against.
 *
 * This file does the looking: which Teams are registered, who is on each
 * roster, which Agents the library holds, and what revision each Team's
 * `team.yaml` currently digests to. The decision itself is
 * `resource-update-policy.ts`, which sees only that snapshot. Nothing here
 * writes: it runs before `store.savePlan`, so a rejected proposal leaves the
 * repository exactly as it was.
 */

import type {
  ChatTurn,
  ResourceUpdateOperationDraft,
  ResourceUpdatePlan,
  ResourceUpdatePlanDraft,
} from '../../contracts/resource-architect.js'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  listAgents,
  readTeamBuilderTeam,
} from '../agent-generator/index.js'
import {
  agentPackagePath,
  AgentRevisionError,
  isMissingAgentError,
} from '../agent-generator/agent-revision.js'
import { computeAgentRevision, computeTeamRevision } from './resource-revision.js'
import {
  planResourceUpdates,
  type ResourceUpdateAgentSnapshot,
  type ResourceUpdateInventory,
  type ResourceUpdateTeamSnapshot,
} from './resource-update-policy.js'
import { ResourceUpdatePlanError } from './resource-update-policy.js'
import { parseTeamRegistry } from '../../parsers/team-registry.js'
import { agentSkillFolderPath, SKILL_DOCUMENT_FILENAME } from './skill-update-rules.js'

export {
  findResourceUpdatePlanViolation,
  ResourceUpdatePlanError,
  ResourceUpdateTargetConfirmationRequired,
  type ResourceUpdateAgentSnapshot,
  type ResourceUpdateInventory,
  type ResourceUpdatePlanErrorCode,
  type ResourceUpdateTeamSnapshot,
} from './resource-update-policy.js'

/** Validates a proposed update plan and returns the persisted form. */
export function materializeResourceUpdatePlan(params: {
  repoRoot: string
  draft: ResourceUpdatePlanDraft
  history: ChatTurn[]
}): ResourceUpdatePlan {
  return planResourceUpdates({
    inventory: readResourceUpdateInventory(params.repoRoot, params.draft.operations),
    draft: params.draft,
    history: params.history,
  })
}

/**
 * Reads only the Teams this draft names.
 *
 * A target the registry does not list is simply absent from the snapshot, which
 * is how the policy learns the Team does not exist. Reading every registered
 * Team instead would parse Team files the proposal never mentions.
 */
export function readResourceUpdateInventory(
  repoRoot: string,
  operations: readonly ResourceUpdateOperationDraft[],
): ResourceUpdateInventory {
  // `teams.yaml` is the register, so it is what says a Team exists. The
  // builder's projection defines existence by a `team.yaml` that is there and
  // swallows read failures, so asking it would report a Team the registry
  // plainly names as one nobody created — and blame the user's proposal for a
  // repository this server cannot act on. Parse once, and consult per target.
  const registry = readTeamRegistry(repoRoot)
  const teams = new Map<string, ResourceUpdateTeamSnapshot>()
  const agents = new Map<string, ResourceUpdateAgentSnapshot>()
  for (const operation of operations) {
    const targetId = operation.target.id
    if (operation.target.kind === 'agent') {
      if (agents.has(targetId)) continue
      const snapshot = readAgentSnapshot(repoRoot, targetId)
      if (snapshot) agents.set(targetId, snapshot)
      continue
    }
    if (teams.has(targetId)) continue
    // A Team the registry lists but this server cannot read is neither absent
    // nor the user's mistake. Reported where it is read, with what failed, so
    // the proposal is not blamed for it.
    const teamPath = resolveRegisteredTeamPath(registry, targetId)
    if (teamPath === null) continue
    try {
      assertTeamYamlIsReadable(targetId, teamPath)
      const detail = readTeamBuilderTeam(repoRoot, targetId)
      teams.set(targetId, {
        id: targetId,
        rosterAgentNames: new Set(detail.agents.map((agent) => agent.name)),
        revision: computeTeamRevision(repoRoot, targetId),
      })
    } catch (error) {
      throw new ResourceUpdatePlanError(
        'conflict',
        `Team '${targetId}' cannot be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  return {
    teams,
    agents,
    libraryAgentNames: new Set(listAgents(repoRoot).map((agent) => agent.name)),
  }
}

/**
 * The Team registry, parsed once, with its faults kept rather than discarded.
 *
 * `parseTeamRegistry` reports three different things in one list: that the
 * file could not be read at all, that one named entry was rejected, and that
 * some other entry was. They lead somewhere different — the first two are the
 * repository failing the user, the third is somebody else's problem — so they
 * are separated here instead of being thrown away together.
 */
interface TeamRegistryView {
  /** Why the whole registry is unusable, when it is. */
  readError: string | null
  /** Resolved `team_path` for each entry the parser accepted. */
  teamPathById: ReadonlyMap<string, string>
  /** Why one named entry was rejected, when it was. */
  entryErrorById: ReadonlyMap<string, string>
}

const REGISTRY_ENTRY_ERROR = /^Registry entry '(.+?)':\s*(.*)$/u

function readTeamRegistry(repoRoot: string): TeamRegistryView {
  const registryPath = path.join(repoRoot, 'teams.yaml')
  // A wrong filesystem shape is decided here. The parser then performs the one
  // content read, and any non-entry error it reports is retained as a registry
  // fault rather than inferred from particular wording.
  try {
    const stats = fs.lstatSync(registryPath)
    if (!stats.isFile()) {
      return emptyRegistry(`the Team registry at ${registryPath} is not a regular file`)
    }
  } catch (error) {
    return emptyRegistry(
      `the Team registry at ${registryPath} cannot be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  const parsed = parseTeamRegistry(registryPath)
  let readError: string | null = null
  const teamPathById = new Map<string, string>()
  for (const entry of parsed.entries) {
    if (entry.type !== 'team') continue
    teamPathById.set(entry.name, entry.team_path)
  }
  const entryErrorById = new Map<string, string>()
  for (const message of parsed.errors) {
    const match = message.match(REGISTRY_ENTRY_ERROR)
    if (!match?.[1]) {
      if (readError === null) readError = message
      continue
    }
    if (!entryErrorById.has(match[1])) entryErrorById.set(match[1], match[2] ?? message)
  }
  return { readError, teamPathById, entryErrorById }
}

function emptyRegistry(readError: string): TeamRegistryView {
  return { readError, teamPathById: new Map(), entryErrorById: new Map() }
}

/**
 * Where this Team lives, or `null` when the registry genuinely does not name it.
 *
 * A registry nobody can read, and an entry the parser rejected, are repository
 * faults about a Team the user named correctly. A name no entry carries is the
 * one case that is simply not there, and it stays a plain "not found".
 */
function resolveRegisteredTeamPath(
  registry: TeamRegistryView,
  teamId: string,
): string | null {
  if (registry.readError !== null) {
    throw new ResourceUpdatePlanError(
      'conflict',
      `Team '${teamId}' cannot be resolved because ${registry.readError}`,
    )
  }
  const entryError = registry.entryErrorById.get(teamId)
  if (entryError !== undefined) {
    throw new ResourceUpdatePlanError(
      'conflict',
      `Team '${teamId}' has a registry entry this repository rejected: ${entryError}`,
    )
  }
  return registry.teamPathById.get(teamId) ?? null
}

/**
 * The named Team's own `team.yaml` is a readable regular file.
 *
 * The builder's projection reads YAML forgivingly: it swallows read and parse
 * failures and defines registration by a `team.yaml` that exists. A registered
 * Team whose file is unreadable therefore comes back empty and valid-looking,
 * and an update would be authorized against a roster that is not the Team's.
 */
function assertTeamYamlIsReadable(teamId: string, teamPath: string): void {
  const teamYamlPath = path.join(teamPath, 'team.yaml')
  let stats: fs.Stats
  try {
    stats = fs.lstatSync(teamYamlPath)
  } catch (error) {
    throw new ResourceUpdatePlanError(
      'conflict',
      `Team '${teamId}' cannot be read at ${teamYamlPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (!stats.isFile()) {
    throw new ResourceUpdatePlanError(
      'conflict',
      `Team '${teamId}' has a team.yaml that is not a regular file: ${teamYamlPath}`,
    )
  }
  try {
    fs.readFileSync(teamYamlPath, 'utf8')
  } catch (error) {
    throw new ResourceUpdatePlanError(
      'conflict',
      `Team '${teamId}' cannot be read at ${teamYamlPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

/**
 * One existing Agent, or `null` when there is genuinely no package to update.
 *
 * Absence and corruption are answered differently on purpose. An id that names
 * nothing — or is not an exact Agent name at all — is simply not in the
 * snapshot, which is how the policy learns the Agent does not exist. A package
 * that is there but cannot be described faithfully is neither present nor
 * absent, so it fails with what was actually wrong instead of being reported
 * as an Agent nobody ever created.
 */
function readAgentSnapshot(
  repoRoot: string,
  agentId: string,
): ResourceUpdateAgentSnapshot | null {
  let packageRoot: string
  let revision: string
  try {
    packageRoot = agentPackagePath(repoRoot, agentId)
    revision = computeAgentRevision(repoRoot, agentId)
  } catch (error) {
    if (isMissingAgentError(error)) return null
    throw new ResourceUpdatePlanError(
      'conflict',
      `Agent '${agentId}' cannot be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  const skillFolderNames = new Set<string>()
  const readableSkillNames = new Set<string>()
  for (const entry of readSkillEntries(packageRoot, agentId)) {
    // Every direct child, not only the directories. A regular file at
    // `skills/<name>` occupies the exact path a `create` would write into, so
    // treating it as nothing would authorize a create that cannot land.
    skillFolderNames.add(entry.name)
    if (!entry.isDirectory()) continue
    let documentPath: string
    try {
      documentPath = path.join(
        agentSkillFolderPath({ repoRoot, agentId, skillName: entry.name }),
        SKILL_DOCUMENT_FILENAME,
      )
    } catch {
      // A folder whose name this repository would never publish still occupies
      // the name, so it stays in `skillFolderNames` and is never readable.
      continue
    }
    try {
      fs.readFileSync(documentPath, 'utf8')
      readableSkillNames.add(entry.name)
    } catch {
      // Present but unreadable. `update` needs the current bytes as context,
      // so a skill it cannot read is not one it can rewrite. Conformance is
      // deliberately not consulted: a document that breaks the specification
      // is exactly the one a user asks to have rewritten.
    }
  }
  return { id: agentId, revision, skillFolderNames, readableSkillNames }
}

/**
 * The direct children of `skills/`, or none when there is no such folder.
 *
 * The revision read just above already refused a `skills` entry that is a
 * symlink or not a directory, so anything other than a genuinely absent folder
 * reaching here is a state nothing understands, and it fails rather than being
 * read as an Agent with no skills.
 */
function readSkillEntries(packageRoot: string, agentId: string): fs.Dirent[] {
  try {
    return fs.readdirSync(path.join(packageRoot, 'skills'), { withFileTypes: true })
  } catch (error) {
    if (
      typeof error === 'object' && error !== null && 'code' in error &&
      error.code === 'ENOENT'
    ) {
      return []
    }
    throw new ResourceUpdatePlanError(
      'conflict',
      `Agent '${agentId}' has a skills folder that cannot be read: ${
        error instanceof AgentRevisionError || error instanceof Error
          ? error.message
          : String(error)
      }`,
    )
  }
}
