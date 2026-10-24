import { whenDefined } from '../../core/optional-properties.js'
import * as fs from 'node:fs'
import * as crypto from 'node:crypto'
import * as path from 'node:path'
import {
  DEFAULT_MODEL,
  DEFAULT_ORCHESTRATION_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_THINKING,
} from '../../core/constants.js'
import { parseYaml, type YamlObject, type YamlValue } from '../../core/yaml-parser.js'
import {
  healthStatusFromDiagnostics,
  type Diagnostic,
  type DiagnosticKind,
  type DiagnosticSeverity,
} from '../../contracts/health.js'
import { loadAgent, parseAgentFrontmatter } from '../../parsers/load-agent.js'
import { isSystemAgent } from './agent-visibility.js'
import { parseTeamConfig } from '../../parsers/team-config.js'
import { validateLoadedAgentProviders } from '../provider/provider-preflight.js'
import {
  activeProviderFailure,
  providerFailureDiagnostic,
  type ProviderFailureSnapshot,
} from '../provider/provider-failure-projection.js'
import { withFileMutationLock, writeFileAtomic } from '../../core/file-mutation.js'
import { resolveEntryLevelIndex } from '../../core/stage-helpers.js'
import {
  depthRounds,
  type TeamShape,
  teamShapeSchema,
  validateShapeAgainstRoster,
  type TeamShapeDepth,
} from '../../contracts/schemas/team-shape.js'
import type { TeamConfig } from '../../core/types.js'
import type {
  TeamBuilderDetail,
  TeamBuilderHealth,
  TeamBuilderSummary,
  TeamBuilderUpsertInput,
  LegacyTeamModelSettings,
  TeamRosterAgent,
} from './types.js'
import {
  GENERATED_TEAM_OUTPUT_ARTIFACT,
  GENERATED_TEAM_PROVENANCE_KEY,
  TEAM_BUILDING_KEY,
  TEAM_PUBLISHED_BY_KEY,
  findBlockRange,
  generatedSetupStage,
  intendedGeneratedOutputOwner,
  readTeamBuildingFlag,
  removeGeneratedOutputOwnership,
  settleGeneratedOutputOwnership,
} from './team-yaml-ownership.js'
import {
  STAGE_MEMBERSHIP_KEY,
  ensureTrailingNewline,
  indentWidth,
  isObject,
  joinLabels,
  parseStringList,
  stringOrUndefined,
  yamlQuoted,
} from './team-yaml-scalars.js'
import {
  pruneAgentFromStageLists,
  removeRosterEntry,
} from './team-yaml-removal.js'
import { collectTeamLocalReferences, joinReferenceLabels } from './team-yaml-references.js'
import {
  extendEntryStageMembership,
  insertRosterEntries,
  refusalForRosterShape,
  refusalToAddMember,
  rosterEditKeepsTeam,
  usesDefaultSetupChain,
} from './team-yaml-addition.js'
import {
  GENERATED_TEAM_INPUT_ARTIFACT,
  collapseText,
  removeTopLevelBlock,
  renderLevelsBlock,
  renderNewTeamYaml,
  renderRegistryBlock,
  renderTeamMetaBlock,
  replaceOrAppendTopLevelBlock,
  upsertTopLevelBlock,
} from './team-yaml-render.js'
import {
  replaceGeneratedStageBody,
  savedTeamShapeIsEditable,
  stageDiffersFromShape,
} from './team-yaml-shape.js'

// Defined with the renderers that write it; re-exported so this module keeps exporting it.
export { GENERATED_TEAM_INPUT_ARTIFACT } from './team-yaml-render.js'
// Defined with the ownership transforms and the `team:` block markers;
// re-exported so importers of this module keep their paths.
export {
  GENERATED_TEAM_OUTPUT_ARTIFACT,
  GENERATED_TEAM_PROVENANCE,
  GENERATED_TEAM_PROVENANCE_KEY,
  TEAM_BUILDING_KEY,
  TEAM_PUBLISHED_BY_KEY,
} from './team-yaml-ownership.js'

// Defined with the add-path transforms; re-exported so importers keep their paths.
export { extendGeneratedStageMembership, refusalToAddMember } from './team-yaml-addition.js'

interface TeamRecord extends TeamBuilderSummary {
  teamYamlPath: string
  teamPath: string
  registryEntry: YamlObject
}

export type TeamCreatePersistenceBoundary =
  | 'after_team_staged'
  | 'after_team_published'
  | 'after_team_registered'

export interface TeamCreateOptions {
  /** Observability hook for durable-create boundaries. Throwing leaves recoverable state. */
  onPersistenceBoundary?: (
    boundary: TeamCreatePersistenceBoundary,
  ) => void | Promise<void>
}

/**
 * What a run discovered about a provider, for a check that never calls one.
 *
 * Team health is static: it reads `team.yaml`, the personas, and whether the
 * machine holds the keys. That misses the failure people actually hit — a key
 * that worked this morning and has no credit left this afternoon — because
 * nothing here would ever ask. The projection of past runs is the only way
 * this check can know.
 */
export interface TeamHealthRuntimeContext {
  providerFailures?: ProviderFailureSnapshot | undefined
  now?: Date | undefined
}

export function listTeamBuilderTeams(
  repoRoot: string,
  runtime: TeamHealthRuntimeContext = {},
): TeamBuilderSummary[] {
  return listTeamRecords(repoRoot, runtime).map(({ teamYamlPath: _teamYamlPath, teamPath: _teamPath, registryEntry: _registryEntry, ...team }) => team)
}

export function readTeamBuilderTeam(repoRoot: string, teamId: string): TeamBuilderDetail {
  const record = getTeamRecord(repoRoot, teamId)
  const raw = readYamlSafe(record.teamYamlPath)
  return toTeamDetail(record, raw)
}

export async function createTeamBuilderTeam(
  repoRoot: string,
  input: TeamBuilderUpsertInput,
  options: TeamCreateOptions = {},
): Promise<TeamBuilderDetail> {
  const id = sanitizeTeamId(input.id)
  if (!id) throw new Error('Team id must be a non-empty kebab-case identifier')
  const teamsRoot = path.join(repoRoot, 'teams')
  const teamPath = path.join(teamsRoot, id)
  const description = input.description?.trim() || `${id} team.`
  await fs.promises.mkdir(teamsRoot, { recursive: true })

  return withFileMutationLock(teamPath, async () => {
    const registeredTeam = listTeamRecords(repoRoot).find((team) => team.id === id)
    if (registeredTeam) {
      if (
        input.orchestratorKey &&
        readTeamOrchestratorKey(registeredTeam.teamYamlPath) === input.orchestratorKey
      ) {
        return readTeamBuilderTeam(repoRoot, id)
      }
      throw new Error(`Team already exists: ${id}`)
    }

    if (fs.existsSync(teamPath)) {
      if (
        input.orchestratorKey &&
        readTeamOrchestratorKey(path.join(teamPath, 'team.yaml')) === input.orchestratorKey
      ) {
        await registerTeamBuilderTeam(repoRoot, {
          id,
          description,
          tags: normalizeTags(input.tags),
        })
        await options.onPersistenceBoundary?.('after_team_registered')
        return readTeamBuilderTeam(repoRoot, id)
      }
      throw new Error(`Team already exists: ${id}`)
    }

    const stagedTeamPath =
      (input.orchestratorKey
        ? findRecoverableTeamStage(teamsRoot, id, input.orchestratorKey)
        : null) ??
      path.join(
        teamsRoot,
        '.create-staging',
        `${id}.${process.pid}.${crypto.randomUUID()}`,
      )
    const stagedTeamYamlPath = path.join(stagedTeamPath, 'team.yaml')
    if (!fs.existsSync(stagedTeamYamlPath)) {
      await fs.promises.mkdir(stagedTeamPath, { recursive: true })
      await writeFileAtomic(
        stagedTeamYamlPath,
        renderNewTeamYaml({
          id,
          description,
          ...whenDefined(input.orchestratorKey, (definedValue) => ({ orchestratorKey: definedValue })),
          ...whenDefined(input.shape, (definedValue) => ({ shape: definedValue })),
          ...whenDefined(input.building, (definedValue) => ({ building: definedValue })),
        }),
      )
    }
    await options.onPersistenceBoundary?.('after_team_staged')

    try {
      await fs.promises.rename(stagedTeamPath, teamPath)
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'ENOENT') throw error
      if (
        !input.orchestratorKey ||
        readTeamOrchestratorKey(path.join(teamPath, 'team.yaml')) !== input.orchestratorKey
      ) {
        throw new Error(`Team already exists: ${id}`)
      }
    }
    await options.onPersistenceBoundary?.('after_team_published')

    await registerTeamBuilderTeam(repoRoot, {
      id,
      description,
      tags: normalizeTags(input.tags),
    })
    await removeTeamStage(stagedTeamPath, teamsRoot)
    await options.onPersistenceBoundary?.('after_team_registered')
    return readTeamBuilderTeam(repoRoot, id)
  })
}

function findRecoverableTeamStage(
  teamsRoot: string,
  id: string,
  orchestratorKey: string,
): string | null {
  const stagingRoot = path.join(teamsRoot, '.create-staging')
  if (!fs.existsSync(stagingRoot)) return null
  for (const entry of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${id}.`)) continue
    const candidate = path.join(stagingRoot, entry.name)
    if (readTeamOrchestratorKey(path.join(candidate, 'team.yaml')) === orchestratorKey) {
      return candidate
    }
  }
  return null
}

async function removeTeamStage(stagePath: string, teamsRoot: string): Promise<void> {
  await fs.promises.rm(stagePath, { recursive: true, force: true })
  const stagingRoot = path.join(teamsRoot, '.create-staging')
  await fs.promises.rmdir(stagingRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
  })
}

async function registerTeamBuilderTeam(
  repoRoot: string,
  params: { id: string; description: string; tags: string[] },
): Promise<void> {
  const registryPath = path.join(repoRoot, 'teams.yaml')
  await withFileMutationLock(registryPath, async () => {
    const currentRegistry = await readTextSafe(registryPath)
    const nextRegistry = upsertTopLevelBlock(
      currentRegistry,
      params.id,
      renderRegistryBlock({
        id: params.id,
        description: params.description,
        tags: params.tags,
        teamPath: `./teams/${params.id}`,
        inputArtifact: GENERATED_TEAM_INPUT_ARTIFACT,
        outputArtifact: GENERATED_TEAM_OUTPUT_ARTIFACT,
        // Deliberately no host pair. Writing one decides a model on the user's
        // behalf, and a registry host outranks the coordinator Agent's own
        // choice for the life of the Team. Left out, the host resolves from the
        // coordinator, or from the application default when it names none.
      }),
    )
    await writeFileAtomic(registryPath, ensureTrailingNewline(nextRegistry))
  })
}

function readTeamOrchestratorKey(teamYamlPath: string): string | undefined {
  if (!fs.existsSync(teamYamlPath)) return undefined
  const team = readYamlSafe(teamYamlPath).team
  return isObject(team) && typeof team.created_by_orchestrator === 'string'
    ? team.created_by_orchestrator
    : undefined
}

export async function updateTeamBuilderTeam(
  repoRoot: string,
  teamId: string,
  input: TeamBuilderUpsertInput,
  options: { expectedRevision?: string | undefined } = {},
): Promise<TeamBuilderDetail> {
  const registryPath = path.join(repoRoot, 'teams.yaml')
  return withFileMutationLock(registryPath, async () => {
    const currentId = sanitizeTeamId(teamId)
    const nextId = sanitizeTeamId(input.id || teamId)
    if (!nextId) throw new Error('Team id must be a non-empty kebab-case identifier')
    const record = getTeamRecord(repoRoot, currentId)
    // Before the rename below, which is a write of its own.
    await assertTeamRevision(record.id, record.teamYamlPath, options.expectedRevision)
    const orchestratorKey = readTeamOrchestratorKey(record.teamYamlPath)
    if (nextId !== currentId && listTeamRecords(repoRoot).some((team) => team.id === nextId)) {
      throw new Error(`Team already exists: ${nextId}`)
    }
    const description = input.description?.trim() || record.description || `${nextId} team.`
    const tags = normalizeTags(input.tags)
    const raw = readYamlSafe(record.teamYamlPath)
    const agents = parseRosterAgents(raw.agents, raw.levels)
    const { teamPath, teamYamlPath } =
      nextId === currentId ? record : await renameTeamFolder(repoRoot, record, nextId)

    const currentTeamYaml = await fs.promises.readFile(teamYamlPath, 'utf8')
    let nextTeamYaml = replaceOrAppendTopLevelBlock(
      currentTeamYaml,
      'team',
      renderTeamMetaBlock({
        id: nextId,
        description,
        // Preserved, never minted. A description edit or a rename says nothing
        // about who wrote the file, and a hand-authored team that acquired this
        // marker here would have its ownership rewritten by the next removal.
        ...whenDefined(readTeamProvenance(currentTeamYaml), (definedValue) => ({ provenance: definedValue })),
        // Preserved like provenance, and for the same reason: a rename says
        // nothing about whether the build finished.
        ...(readTeamBuildingFlag(currentTeamYaml) ? { building: true } : {}),
        // Preserved like the others: a rename says nothing about which build
        // published the team.
        ...whenDefined(readTeamPublishedBy(currentTeamYaml), (definedValue) => ({ publishedBy: definedValue })),
        ...whenDefined(orchestratorKey, (definedValue) => ({ orchestratorKey: definedValue })),
      }),
    )
    // `defaults` and `models` are retired. An existing file keeps whatever it
    // holds; nothing new is written and nothing there decides a model.
    //
    // The roster is left alone entirely. This call changes a Team's own
    // metadata and takes no roster in its input, so re-rendering the block from
    // a parsed model could only lose things the model does not carry —
    // comments, field order, keys nobody modelled — as a side effect of an edit
    // that never touched a member. What the members already declare survives
    // because those bytes are never rewritten.
    await fs.promises.writeFile(teamYamlPath, ensureTrailingNewline(nextTeamYaml), 'utf8')

    const currentRegistry = await readTextSafe(registryPath)
    const registryWithoutOld =
      nextId === currentId ? currentRegistry : removeTopLevelBlock(currentRegistry, currentId)
    const nextRegistry = upsertTopLevelBlock(
      registryWithoutOld,
      nextId,
      renderRegistryBlock({
        id: nextId,
        description,
        tags,
        teamPath: toRepoRelativePosix(repoRoot, teamPath),
        ...whenDefined(stringOrUndefined(record.registryEntry.input_artifact), (definedValue) => ({ inputArtifact: definedValue })),
        ...whenDefined(stringOrUndefined(record.registryEntry.output_artifact), (definedValue) => ({ outputArtifact: definedValue })),
        ...whenDefined(stringOrUndefined(record.registryEntry.host_model), (definedValue) => ({ hostModel: definedValue })),
        ...whenDefined(stringOrUndefined(record.registryEntry.host_provider), (definedValue) => ({ hostProvider: definedValue })),
      }),
    )
    await writeFileAtomic(registryPath, ensureTrailingNewline(nextRegistry))
    return readTeamBuilderTeam(repoRoot, nextId)
  })
}

/** Whether a filesystem error means the path is simply not there. */
function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

/**
 * What is at a generated team's own folder, told apart precisely.
 *
 * Three different things have been confused here before. A folder that is not
 * there is absent. A folder whose `team.yaml` cannot be read proves nothing —
 * not that the team is gone, and not that it is anybody's to remove. And a
 * team that no longer says which build made it, or no longer says it is being
 * built, is a team with no permission attached, which is not the same as an
 * absent one either.
 *
 * The path is the team's own folder under `teams/`, not whatever the registry
 * points at: a registry entry that was already removed must not make a folder
 * that is still on disk look absent.
 */
export function readGeneratedTeamShell(
  repoRoot: string,
  teamId: string,
):
  | { state: 'absent' }
  | { state: 'unreadable' }
  | { state: 'present'; teamPath: string; owner?: string; building: boolean } {
  const teamPath = path.join(repoRoot, 'teams', sanitizeTeamId(teamId))
  // Only a path that is genuinely not there is absent. `existsSync` answers
  // "no" to a permission error as readily as to a missing folder, and reading
  // that as absence let a removal report success over a folder that was still
  // on disk — with nothing left pointing at it to try again.
  try {
    fs.lstatSync(teamPath)
  } catch (error) {
    return isMissingPathError(error) ? { state: 'absent' } : { state: 'unreadable' }
  }
  const teamYamlPath = path.join(teamPath, 'team.yaml')
  let raw: string
  try {
    raw = fs.readFileSync(teamYamlPath, 'utf8')
  } catch {
    // A folder that is there without a readable `team.yaml` is not an absent
    // team either: it is one nothing should be authorized against.
    return { state: 'unreadable' }
  }
  let parsed: YamlObject
  try {
    parsed = parseYaml(raw)
  } catch {
    return { state: 'unreadable' }
  }
  const team = parsed.team
  if (!isObject(team)) return { state: 'unreadable' }
  const owner = stringOrUndefined(team.created_by_orchestrator)
  return {
    state: 'present',
    teamPath,
    ...(owner === undefined ? {} : { owner }),
    building: team.building === true,
  }
}

/**
 * A removal the state of the team refuses.
 *
 * Typed, so the caller can answer with the state of the thing rather than with
 * a generic failure: this is a race the user can be told about, not a fault.
 */
export class GeneratedTeamShellRefusal extends Error {}

/**
 * Removes a Team shell a build left behind, checking that it still is one.
 *
 * Ownership and unfinished state are read again *inside* the registry writer's
 * own critical section, immediately before anything is removed. Checking them
 * beforehand leaves a window: a publication that lands in between turns the
 * shell into a real team, and the removal then deletes somebody's team.
 *
 * Everything else it does is `deleteTeamBuilderTeam`: the registry entry and the
 * folder are removed independently, so an attempt that got as far as one of
 * them can be finished by asking again.
 */
export async function discardGeneratedTeamShell(params: {
  repoRoot: string
  teamId: string
  owner: string
}): Promise<void> {
  const id = sanitizeTeamId(params.teamId)
  const registryPath = path.join(params.repoRoot, 'teams.yaml')
  await withFileMutationLock(registryPath, async () => {
    const shell = readGeneratedTeamShell(params.repoRoot, id)
    if (shell.state === 'unreadable') {
      throw new GeneratedTeamShellRefusal(
        `Team '${id}' cannot be read, so it is not safe to remove. Check its configuration.`,
      )
    }
    if (shell.state === 'present') {
      if (shell.owner !== params.owner) {
        throw new GeneratedTeamShellRefusal(`Team '${id}' was not built by this plan.`)
      }
      if (!shell.building) {
        throw new GeneratedTeamShellRefusal(
          `Team '${id}' has been built. Delete it from the team editor instead.`,
        )
      }
    }
    await removeTeamRegistryEntry(registryPath, id)
    await removeTeamFolder(params.repoRoot, id)
  })
}

export async function deleteTeamBuilderTeam(
  repoRoot: string,
  teamId: string,
  options: { expectedRevision?: string | undefined } = {},
): Promise<void> {
  const id = sanitizeTeamId(teamId)
  // Both halves are removed independently, because a delete can stop between
  // them: the registry write can succeed and the folder removal fail, leaving
  // a folder no entry points at. Asking again has to finish that, so a missing
  // registry entry is not treated as "already done".
  let teamPath: string
  try {
    teamPath = getTeamRecord(repoRoot, id).teamPath
  } catch {
    teamPath = path.join(repoRoot, 'teams', id)
    if (!fs.existsSync(teamPath)) throw new Error(`Team not found: ${id}`)
  }
  const registryPath = path.join(repoRoot, 'teams.yaml')
  await withFileMutationLock(registryPath, async () => {
    await assertTeamRevision(id, path.join(teamPath, 'team.yaml'), options.expectedRevision)
    await removeTeamRegistryEntry(registryPath, id)
  })
  await removeTeamFolder(repoRoot, id, teamPath)
}

/** Takes one team out of the catalog. The caller owns the lock. */
async function removeTeamRegistryEntry(registryPath: string, id: string): Promise<void> {
  const currentRegistry = await readTextSafe(registryPath)
  await writeFileAtomic(
    registryPath,
    ensureTrailingNewline(removeTopLevelBlock(currentRegistry, id)),
  )
}

/** Removes a team's own folder, and says so honestly when it could not. */
async function removeTeamFolder(
  repoRoot: string,
  id: string,
  known?: string,
): Promise<void> {
  const teamsRoot = path.join(repoRoot, 'teams')
  const teamPath = known ?? path.join(teamsRoot, id)
  const relative = path.relative(teamsRoot, teamPath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return
  await fs.promises.rm(teamPath, { recursive: true, force: true })
  // `force` swallows a missing path, and it also swallows nothing else. A
  // folder still standing here was not removed, and saying it was would strand
  // it with no entry pointing at it and nothing left to ask again.
  if (fs.existsSync(teamPath)) {
    throw new Error(
      `Team folder could not be removed: teams/${id}. Check its permissions and try again.`,
    )
  }
}

async function renameTeamFolder(
  repoRoot: string,
  record: TeamRecord,
  nextId: string,
): Promise<{ teamPath: string; teamYamlPath: string }> {
  const teamsRoot = path.join(repoRoot, 'teams')
  const relative = path.relative(teamsRoot, record.teamPath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Cannot rename team outside teams folder: ${record.id}`)
  }
  const nextTeamPath = path.join(teamsRoot, nextId)
  if (fs.existsSync(nextTeamPath)) {
    throw new Error(`Team folder already exists: teams/${nextId}`)
  }
  await fs.promises.rename(record.teamPath, nextTeamPath)
  return {
    teamPath: nextTeamPath,
    teamYamlPath: path.join(nextTeamPath, 'team.yaml'),
  }
}

export async function addTeamBuilderAgent(params: {
  repoRoot: string
  teamId: string
  agentName: string
  role?: string
  expectedRevision?: string | undefined
}): Promise<TeamBuilderDetail> {
  const registryPath = path.join(params.repoRoot, 'teams.yaml')
  return withFileMutationLock(registryPath, async () => {
    const record = getTeamRecord(params.repoRoot, sanitizeTeamId(params.teamId))
    await assertTeamRevision(record.id, record.teamYamlPath, params.expectedRevision)
    const agentName = sanitizeTeamId(params.agentName)
    if (!agentName) throw new Error('Agent name must be a non-empty identifier')
    const agentPath = path.join(params.repoRoot, 'agents', agentName, `${agentName}.md`)
    if (!fs.existsSync(agentPath)) {
      throw new Error(`Agent persona does not exist: agents/${agentName}/${agentName}.md`)
    }

    const raw = readYamlSafe(record.teamYamlPath)
    const agents = parseRosterAgents(raw.agents, raw.levels)
    if (agents.some((agent) => agent.name === agentName)) {
      return readTeamBuilderTeam(params.repoRoot, record.id)
    }

    const frontmatter = readRosterPersonaFrontmatter(agentPath, agentName)
    // No grade. Authoring does not produce one, and reading the persona's for a
    // roster entry would put a value on the file that nobody chose here.
    const addition: TeamRosterAgent = {
      name: agentName,
      type: 'agent',
      role: params.role?.trim() || frontmatter.description || `${agentName} library agent.`,
      tools: [],
      agent_file: toPosix(path.relative(path.dirname(record.teamYamlPath), agentPath)),
      experience_enabled: true,
      referenced: false,
    }
    // Only the new entry is written, whatever shape the Team's levels take.
    // Re-rendering the block from a parsed model drops comments, field order
    // and any roster key the model does not carry — from members this add never
    // touched — which is why the batch writer has always inserted instead.
    //
    // A generated chain needs two further things, and they are edits rather
    // than a rebuild: the newest member takes ownership of the generated output
    // artifact from whoever held it, and the entry stage's sequence learns the
    // new name. Both reuse what the batch path already does.
    const currentYaml = await fs.promises.readFile(record.teamYamlPath, 'utf8')
    const parsedYaml = parseYaml(currentYaml)
    const refusal = refusalToAddMember(parsedYaml, [agentName]) ??
      refusalForRosterShape(record.id, currentYaml)
    if (refusal) throw new Error(refusal)
    const isGeneratedSetup = generatedSetupStage(parsedYaml) !== undefined
    const owner = intendedGeneratedOutputOwner(parsedYaml, [agentName])
    const entryToWrite: TeamRosterAgent = owner === agentName
      ? { ...addition, produces: [{ path: GENERATED_TEAM_OUTPUT_ARTIFACT }] }
      : addition
    // Ownership is stripped whenever this team has a generated shape, even when
    // the new member is not the one taking it: a discussion's coordinator may
    // already hold it, and a review's deliverable belongs to no agent at all.
    const rosterYaml = isGeneratedSetup
      ? removeGeneratedOutputOwnership(currentYaml)
      : currentYaml
    // Membership is edited where this path always edited levels — a setup
    // chain — and now also in a generated discussion, whose new participant
    // would otherwise sit on the roster and never be convened. Adding a library
    // Agent to a *hand-authored* discussion still schedules nothing: that would
    // be a new decision, not a preserved one.
    const withRoster = insertRosterEntries(rosterYaml, [entryToWrite])
    const membershipYaml = usesDefaultSetupChain(parsedYaml) || isGeneratedSetup
      ? extendEntryStageMembership(withRoster, parsedYaml, [agentName])
      : withRoster
    // The coordinator may be added after the participants, so the declaration
    // is settled once the roster is final rather than guessed per addition.
    const nextYaml = settleGeneratedOutputOwnership(membershipYaml)
    assertRosterEditKeepsTeam(record.id, parsedYaml, nextYaml, [agentName])
    await fs.promises.writeFile(
      record.teamYamlPath,
      ensureTrailingNewline(nextYaml),
      'utf8',
    )
    return readTeamBuilderTeam(params.repoRoot, record.id)
  })
}

/**
 * The persona a roster entry will be built from, refused if it is not one.
 *
 * On the resolved persona rather than on the name that was asked for: both
 * callers normalize the supplied name before they read the file, so a check
 * over the raw string is checking a value that never reaches disk. And in the
 * domain rather than in `team-builder-service`, because
 * `resource-architect-service` and `resource-update-executor` reach these two
 * functions directly and would walk past a guard that lives above them.
 *
 * `system` means the runtime owns the role: never a Run target, never a team
 * member. `ui_hidden` is a different claim and is deliberately not refused
 * here, since the team-builder contract already pins its members being written
 * and then hidden from the projection.
 */
function readRosterPersonaFrontmatter(
  personaSource: string,
  agentName: string,
): Record<string, string> {
  const frontmatter = parseAgentFrontmatter(personaSource).frontmatter
  if (isSystemAgent(frontmatter)) {
    throw new Error(`${agentName} is a system agent and cannot be added to a team.`)
  }
  return frontmatter
}

export interface TeamBuilderAgentAddition {
  name: string
  role?: string
  /**
   * Where this Agent's persona can be read right now.
   *
   * A newly generated Agent is still staged privately when its roster entry is
   * built, because the entry has to be validated before anything is published.
   * The entry always names the final library path; only the read comes from
   * here.
   */
  stagedPersonaPath?: string
}

/**
 * Adds several Agents to an existing Team as one authorized write.
 *
 * `expectedRevision` is the digest the caller recorded when the update was
 * proposed. It is re-checked here, inside the same lock that performs the
 * write, so a Team edited in between fails the operation instead of losing the
 * newer content. Splitting this into one `addTeamBuilderAgent` call per member
 * would turn one authorized operation into several partial writes.
 */
export async function addTeamBuilderAgents(params: {
  repoRoot: string
  teamId: string
  expectedRevision: string
  agents: readonly TeamBuilderAgentAddition[]
  /**
   * Called inside the lock once the revision matched, every addition resolved
   * to a real persona, the exact final bytes were calculated, and
   * `onIntendedRevision` recorded them. Only the Team write itself remains, so
   * a caller publishing staged packages here cannot strand one behind a step
   * that was still able to fail.
   */
  onRevisionVerified?: () => void | Promise<void>
  /**
   * Called inside the lock with the revision the pending write will produce,
   * before any byte reaches `team.yaml` and before any package is published.
   * A durable caller records it so a process that exits mid-write can
   * recognize its own result on retry.
   */
  onIntendedRevision?: (revision: string) => void | Promise<void>
}): Promise<TeamBuilderDetail> {
  const registryPath = path.join(params.repoRoot, 'teams.yaml')
  return withFileMutationLock(registryPath, async () => {
    const record = getTeamRecord(params.repoRoot, sanitizeTeamId(params.teamId))
    const currentYaml = await fs.promises.readFile(record.teamYamlPath, 'utf8')
    const currentRevision = digestTeamYaml(currentYaml)
    if (currentRevision !== params.expectedRevision) {
      throw new TeamRevisionConflictError(record.id, params.expectedRevision, currentRevision)
    }

    // Everything that can fail without a published Agent is settled first:
    // the Team has to parse, every addition has to resolve to a real persona,
    // and the exact final bytes have to be computable. Publishing before this
    // point would strand a package whenever any of it turned out to be wrong.
    const parsed = parseYaml(currentYaml)
    // The parser accepts a minimal subset and falls back to strings, so a
    // roster that is not a list parses cleanly and then cannot be extended.
    // Appending entries beneath a scalar would leave a Team that no longer
    // describes itself.
    if (parsed.agents !== undefined && !Array.isArray(parsed.agents)) {
      throw new Error(
        `Team '${record.id}' declares a roster that is not a list, so it cannot take new members`,
      )
    }
    const present = new Set(parseRosterAgents(parsed.agents, parsed.levels).map((agent) => agent.name))
    const additions: TeamRosterAgent[] = []
    for (const addition of params.agents) {
      const agentName = sanitizeTeamId(addition.name)
      if (!agentName) throw new Error('Agent name must be a non-empty identifier')
      if (present.has(agentName)) continue
      additions.push(createRosterEntry(params.repoRoot, record.teamYamlPath, agentName, addition))
      present.add(agentName)
    }
    const addedNames = additions.map((agent) => agent.name)
    const batchRefusal = refusalToAddMember(parsed, addedNames) ??
      (additions.length > 0 ? refusalForRosterShape(record.id, currentYaml) : undefined)
    if (batchRefusal) throw new Error(batchRefusal)
    const isGeneratedSetup = generatedSetupStage(parsed) !== undefined
    const owner = intendedGeneratedOutputOwner(parsed, addedNames)
    const additionsToWrite = isGeneratedSetup && additions.length > 0
      ? additions.map((agent) =>
          agent.name === owner
            ? { ...agent, produces: [{ path: GENERATED_TEAM_OUTPUT_ARTIFACT }] }
            : agent,
        )
      : additions
    const rosterYaml = isGeneratedSetup && additions.length > 0
      ? removeGeneratedOutputOwnership(currentYaml)
      : currentYaml

    const nextYaml = settleGeneratedOutputOwnership(
      extendEntryStageMembership(
        insertRosterEntries(rosterYaml, additionsToWrite),
        parsed,
        addedNames,
      ),
    )

    assertRosterEditKeepsTeam(record.id, parsed, nextYaml, addedNames)

    // Durable evidence is recorded before anything becomes public, because
    // recording it is itself something that can fail. Publishing first would
    // leave an Agent visible beside a Team that never changed and a receipt
    // that never named it.
    const finalYaml = ensureTrailingNewline(nextYaml)
    await params.onIntendedRevision?.(digestTeamYaml(finalYaml))

    // Only now, with nothing left that could fail before the write, may the
    // caller publish the packages this write is about to reference.
    await params.onRevisionVerified?.()

    await writeFileAtomic(record.teamYamlPath, finalYaml)
    return readTeamBuilderTeam(params.repoRoot, record.id)
  })
}

/**
 * Refuses a roster add whose result would hide or lose part of the Team.
 *
 * The inserter edits text, and a roster it does not recognize (an indentless
 * one, or one indented other than two spaces) comes out re-parented: members
 * or `levels` vanish from the parsed file. Checking the parsed result is what
 * catches the shapes the header check cannot see, so nothing is written unless
 * it passes.
 */
function assertRosterEditKeepsTeam(
  teamId: string,
  before: YamlObject,
  nextYaml: string,
  addedNames: readonly string[],
): void {
  if (!rosterEditKeepsTeam(before, parseYaml(nextYaml), addedNames)) {
    throw new Error(
      `Team '${teamId}' has a roster this writer cannot extend without hiding or losing a member, so it cannot take new members`,
    )
  }
}

/** Raised when the Team changed between the proposal and its application. */
export class TeamRevisionConflictError extends Error {
  constructor(
    readonly teamId: string,
    readonly expectedRevision: string,
    readonly currentRevision: string,
  ) {
    super(
      `Team '${teamId}' changed since the update was proposed: expected revision ${expectedRevision}, found ${currentRevision}`,
    )
    this.name = 'TeamRevisionConflictError'
  }
}

/** Digest of `team.yaml` content, used as the Team's optimistic revision. */
export function digestTeamYaml(yaml: string): string {
  return `sha256:${crypto.createHash('sha256').update(yaml, 'utf8').digest('hex')}`
}

/**
 * Refuses a write made against a revision the Team has moved on from.
 *
 * The caller holds the `teams.yaml` lock and has written nothing yet, so no
 * other writer can move the file between this check and the write it guards.
 * An absent revision is a caller that asked for no check, which is how every
 * writer behaved before editors sent one.
 */
export async function assertTeamRevision(
  teamId: string,
  teamYamlPath: string,
  expectedRevision: string | undefined,
): Promise<void> {
  if (expectedRevision === undefined) return
  const currentRevision = digestTeamYaml(await fs.promises.readFile(teamYamlPath, 'utf8'))
  if (currentRevision !== expectedRevision) {
    throw new TeamRevisionConflictError(teamId, expectedRevision, currentRevision)
  }
}

function createRosterEntry(
  repoRoot: string,
  teamYamlPath: string,
  agentName: string,
  addition: TeamBuilderAgentAddition,
): TeamRosterAgent {
  // The roster always points at the final library path, whether or not the
  // package has been published yet.
  const agentPath = path.join(repoRoot, 'agents', agentName, `${agentName}.md`)
  const personaSource = addition.stagedPersonaPath ?? agentPath
  if (!fs.existsSync(personaSource)) {
    throw new Error(`Agent persona does not exist: agents/${agentName}/${agentName}.md`)
  }
  const frontmatter = readRosterPersonaFrontmatter(personaSource, agentName)
  return {
    name: agentName,
    type: 'agent',
    role: addition.role?.trim() || frontmatter.description || `${agentName} library agent.`,
    // No grade. Authoring does not produce one, and reading the persona's for a
    // roster entry would write a value nobody chose here.
    tools: [],
    agent_file: toPosix(path.relative(path.dirname(teamYamlPath), agentPath)),
    // Deliberately no model or provider. The roster saves the reference and
    // the responsibilities; the agent's own file decides what it runs with.
    experience_enabled: true,
    referenced: false,
  }
}

/**
 * Removes one Agent from a Team roster.
 *
 * Held under the same `teams.yaml` mutation lock the other roster writers use.
 * Every one of them reads the roster, changes it, and writes the whole block
 * back, so two running at once would each write a roster that never saw the
 * other's change and one of the two changes would simply disappear.
 */
export async function removeTeamBuilderAgent(params: {
  repoRoot: string
  teamId: string
  agentName: string
  expectedRevision?: string | undefined
}): Promise<TeamBuilderDetail> {
  const registryPath = path.join(params.repoRoot, 'teams.yaml')
  // The same lock key `addTeamBuilderAgent` and `updateTeamBuilderTeam` take,
  // so a roster read here cannot straddle one of those mutations. Reading the
  // record and the file inside it is the point: a snapshot taken outside would
  // be written back whole and resurrect whatever the other mutation had just
  // committed.
  return withFileMutationLock(registryPath, async () => {
    const record = getTeamRecord(params.repoRoot, sanitizeTeamId(params.teamId))
    await assertTeamRevision(record.id, record.teamYamlPath, params.expectedRevision)
    const raw = readYamlSafe(record.teamYamlPath)
    const agents = parseRosterAgents(raw.agents, raw.levels)
    const target = agents.find((agent) => agent.name === params.agentName)
    if (!target) return readTeamBuilderTeam(params.repoRoot, record.id)

    const blocking = collectTeamLocalReferences(raw, params.agentName).filter(
      (reference) => reference.kind === 'singleton',
    )
    if (blocking.length > 0) {
      throw new Error(
        `Cannot remove '${params.agentName}' from team '${record.id}': it is ` +
          `${joinReferenceLabels(blocking)}. Name a different agent for ` +
          `${blocking.length === 1 ? 'that role' : 'each of those roles'} ` +
          `in the team configuration first.`,
      )
    }

    const currentYaml = await fs.promises.readFile(record.teamYamlPath, 'utf8')
    const nextYaml = ensureTrailingNewline(
      settleGeneratedOutputOwnership(
        pruneAgentFromStageLists(
          removeRosterEntry(currentYaml, params.agentName),
          params.agentName,
        ),
      ),
    )

    const nextRaw = parseYaml(nextYaml)
    if (parseRosterAgents(nextRaw.agents, nextRaw.levels).some((agent) => agent.name === params.agentName)) {
      throw new Error(
        `Cannot remove '${params.agentName}' from team '${record.id}': its roster ` +
          `entry could not be located in team.yaml.`,
      )
    }

    const residual = collectTeamLocalReferences(nextRaw, params.agentName)
    if (residual.length > 0) {
      throw new Error(
        `Cannot remove '${params.agentName}' from team '${record.id}': ` +
          `${joinReferenceLabels(residual)} could not be cleared automatically.`,
      )
    }

    const emptied = emptiedRequiredStageMemberships(nextRaw)
    if (emptied.length > 0) {
      throw new Error(
        `Cannot remove '${params.agentName}' from team '${record.id}': it would ` +
          `leave ${joinLabels(emptied)} with no agents, and no run can start a ` +
          `stage with an empty membership. Add another agent to that stage first.`,
      )
    }

    const invalid = validateCandidateTeamYaml(record.teamYamlPath, nextYaml)
    if (invalid.length > 0) {
      throw new Error(
        `Cannot remove '${params.agentName}' from team '${record.id}': the ` +
          `resulting team configuration would be invalid — ${invalid.join('; ')}`,
      )
    }

    await writeFileAtomic(record.teamYamlPath, nextYaml)
    return readTeamBuilderTeam(params.repoRoot, record.id)
  })
}

/**
 * Required stage memberships the candidate would leave empty.
 *
 * These are not parser errors — an empty list parses — but no engine can run
 * the stage. A chain with no sequence stops at "Chain sequence is empty — no
 * agents configured." (`engines/chain.ts:625`), a broadcast with no fan-out at
 * "No agents in fan_out list." (`engines/broadcast.ts:358`), and a discussion
 * with an empty participant pool leaves its coordinator nobody to lock, which
 * `set_roster` refuses (`engines/discussion-tools.ts:38`). A pipeline's
 * `participants` list is advisory by contrast: the schema makes it optional and
 * `engines/pipeline.ts` never reads it, so an empty one does not block.
 */
const REQUIRED_MEMBERSHIP_STAGE_TYPES = new Set<string>(['chain', 'broadcast', 'discussion'])

function emptiedRequiredStageMemberships(raw: YamlObject): string[] {
  const emptied: string[] = []
  const levels = Array.isArray(raw.levels) ? raw.levels.filter(isObject) : []
  for (const [index, level] of levels.entries()) {
    const stage = isObject(level.stage) ? level.stage : undefined
    if (!stage) continue
    const stageType = stringOrUndefined(stage.type) ?? 'discussion'
    const membership = STAGE_MEMBERSHIP_KEY[stageType]
    if (!membership || !REQUIRED_MEMBERSHIP_STAGE_TYPES.has(stageType)) continue
    if (parseStringList(stage[membership]).length > 0) continue
    emptied.push(
      `the ${stageType} ${membership} of level '${stringOrUndefined(level.id) ?? `level-${index}`}'`,
    )
  }
  return emptied
}

/**
 * Every validation error the candidate `team.yaml` would have once saved.
 *
 * The whole configuration has to parse cleanly, not merely no worse than
 * before. A removal that clears its own reference while some unrelated
 * structural error remains would otherwise be written out, and the team would
 * still not run — the operation would have reported success for a file the
 * runtime cannot load.
 */
function validateCandidateTeamYaml(teamYamlPath: string, candidateYaml: string): string[] {
  // Validated through a sibling file so the parser resolves agent files,
  // workspace paths, and the implicit team registry exactly as it will once the
  // candidate is saved in place.
  const probePath = path.join(
    path.dirname(teamYamlPath),
    `.team-validation.${process.pid}.${crypto.randomUUID()}.yaml`,
  )
  try {
    fs.writeFileSync(probePath, candidateYaml, 'utf8')
    return parseTeamConfig(probePath).errors
  } finally {
    fs.rmSync(probePath, { force: true })
  }
}

function listTeamRecords(
  repoRoot: string,
  runtime: TeamHealthRuntimeContext = {},
): TeamRecord[] {
  const registryPath = path.join(repoRoot, 'teams.yaml')
  const raw = readYamlSafe(registryPath)
  const records: TeamRecord[] = []
  for (const [id, value] of Object.entries(raw)) {
    if (id === 'workflow-architect') continue
    if (!isObject(value)) continue
    const tags = parseStringList(value.tags)
    if (tags.includes('internal')) continue
    if (value.type !== undefined && value.type !== 'team') continue
    if (typeof value.team_path !== 'string') continue
    const teamPath = path.resolve(path.dirname(registryPath), value.team_path)
    const teamYamlPath = path.join(teamPath, 'team.yaml')
    if (!fs.existsSync(teamYamlPath)) {
      records.push({
        id,
        name: id,
        ...whenDefined(typeof value.description === 'string' ? value.description.trim() : undefined, (definedValue) => ({ description: definedValue })),
        tags,
        agentCount: 0,
        agentNames: [],
        agents: [],
        userInvocable: true,
        health: buildTeamHealth(teamYamlPath, id, runtime),
        teamYamlPath,
        teamPath,
        registryEntry: value,
      })
      continue
    }
    // One read gives both the row's values and its revision, so a write made
    // against this row cannot pass for a file the row never described.
    const teamYaml = readTextSyncOrUndefined(teamYamlPath)
    const rawTeam = teamYaml === undefined ? {} : parseYamlObjectSafe(teamYaml)
    const agents = parseRosterAgents(rawTeam.agents, rawTeam.levels).map((agent) =>
      withPersonaRuntime(agent, teamPath),
    )
    const defaults = isObject(rawTeam.defaults) ? rawTeam.defaults : {}
    records.push({
      id,
      name: id,
      ...whenDefined(typeof value.description === 'string' ? value.description.trim() : undefined, (definedValue) => ({ description: definedValue })),
      tags,
      agentCount: agents.length,
      agentNames: agents
        .filter((agent) => agent.type === 'agent')
        .map((agent) => agent.name),
      agents,
      ...whenDefined(parseLegacyModels(rawTeam.models), (legacyModels) => ({ legacyModels })),
      ...whenDefined(stringOrUndefined(defaults.provider), (legacyDefaultProvider) => ({ legacyDefaultProvider })),
      ...whenDefined(parseEntryStageType(rawTeam), (entryStageType) => ({ entryStageType })),
      ...whenDefined(parseDiscussionCoordinator(rawTeam), (discussionCoordinator) => ({ discussionCoordinator })),
      userInvocable: parseUserInvocable(rawTeam),
      health: buildTeamHealth(teamYamlPath, id, runtime),
      ...whenDefined(teamYaml, (text) => ({ revision: digestTeamYaml(text) })),
      teamYamlPath,
      teamPath,
      registryEntry: value,
    })
  }
  records.sort((left, right) => left.name.localeCompare(right.name))
  return records
}

function buildTeamHealth(
  teamYamlPath: string,
  teamName: string,
  runtime: TeamHealthRuntimeContext,
): TeamBuilderHealth {
  if (!fs.existsSync(teamYamlPath)) {
    return teamHealthFrom([
      teamDiagnostic(
        'error',
        'structure',
        'Team configuration file is missing.',
        teamName,
      ),
    ])
  }

  try {
    return buildValidatedTeamHealth(teamYamlPath, teamName, runtime)
  } catch (error) {
    const detail = error instanceof Error && error.message.trim()
      ? `: ${error.message.trim()}`
      : ''
    return teamHealthFrom([
      teamDiagnostic(
        'error',
        'structure',
        `Team configuration could not be validated${detail}`,
        teamName,
      ),
    ])
  }
}

function buildValidatedTeamHealth(
  teamYamlPath: string,
  teamName: string,
  runtime: TeamHealthRuntimeContext,
): TeamBuilderHealth {
  const now = runtime.now ?? new Date()
  const parsed = parseTeamConfig(teamYamlPath)
  const diagnostics: Diagnostic[] = [
    ...parsed.errors.map((message) =>
      teamDiagnostic('error', 'structure', message, teamName)),
    ...parsed.warnings.map((message) =>
      teamDiagnostic('warning', 'structure', message, teamName)),
  ]
  if (parsed.config) {
    const config = parsed.config
    for (const message of validateRunnableStages(config)) {
      diagnostics.push(teamDiagnostic('error', 'structure', message, teamName))
    }
    for (const message of collectUnreferencedRosterWarnings(config)) {
      diagnostics.push(teamDiagnostic('warning', 'structure', message, teamName))
    }
    for (const [index, entry] of config.agents.entries()) {
      const loaded = loadAgent(entry, config, 31 + (index % 6))
      if (!loaded) {
        diagnostics.push({
          severity: 'error',
          kind: 'structure',
          message:
            `Agent '${entry.name}' names a persona file that is missing or unreadable.`,
          subject: { teamName, agentName: entry.name },
        })
        continue
      }
      // Asked one member at a time. The preflight answers in prose that names
      // the agent, and a badge needs to know *which* member and *which*
      // provider without parsing that sentence back apart.
      for (const message of validateLoadedAgentProviders([loaded])) {
        diagnostics.push({
          severity: 'error',
          kind: 'config',
          message,
          subject: {
            teamName,
            agentName: loaded.name,
            provider: loaded.provider,
            model: loaded.model,
          },
        })
      }
      const observed = runtime.providerFailures
        ? activeProviderFailure(
            runtime.providerFailures,
            { provider: loaded.provider, model: loaded.model },
            now,
          )
        : undefined
      if (observed) {
        diagnostics.push(
          providerFailureDiagnostic(observed, {
            teamName,
            agentName: loaded.name,
          }),
        )
      }
    }
  }

  return teamHealthFrom(diagnostics)
}

function teamDiagnostic(
  severity: DiagnosticSeverity,
  kind: DiagnosticKind,
  message: string,
  teamName: string,
): Diagnostic {
  return { severity, kind, message, subject: { teamName } }
}

/**
 * The payload a catalog reader sees, derived from one list of diagnostics.
 *
 * `errors` and `warnings` are projections of that list rather than sources of
 * their own, so the two can never disagree with the badge about what is wrong.
 * Deduplication is by severity and message, matching what the two arrays did
 * separately before they had a common origin.
 */
function teamHealthFrom(diagnostics: readonly Diagnostic[]): TeamBuilderHealth {
  const seen = new Set<string>()
  const unique = diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.severity} ${diagnostic.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return {
    status: healthStatusFromDiagnostics(unique),
    errors: unique
      .filter((diagnostic) => diagnostic.severity === 'error')
      .map((diagnostic) => diagnostic.message),
    warnings: unique
      .filter((diagnostic) => diagnostic.severity === 'warning')
      .map((diagnostic) => diagnostic.message),
    diagnostics: unique,
  }
}

/**
 * Roster members no level ever names.
 *
 * The Team still parses and still runs, so this is not an error. But the Run
 * sidebar builds its roster from the agents block, and a member no stage
 * dispatches would sit there looking like a participant that never speaks.
 *
 * The usual way in is a round trip through the Team editor: removing a member
 * clears it from the stage, and adding it back restores only the roster entry
 * unless the Team is still on the generated `setup` chain.
 */
function collectUnreferencedRosterWarnings(config: TeamConfig): string[] {
  const referenced = new Set<string>()
  /** A pipeline that names no participants decides its workers at run time. */
  let planDrivenRoster = false
  for (const level of config.levels) {
    const stage = level.stage
    if (stage.coordinator) referenced.add(stage.coordinator)
    switch (stage.type) {
      case 'chain':
        for (const name of stage.sequence) referenced.add(name)
        break
      case 'broadcast':
        for (const name of stage.fan_out) referenced.add(name)
        break
      case 'discussion':
        for (const name of stage.participants ?? []) referenced.add(name)
        break
      case 'pipeline':
        // A pipeline dispatches whoever its plan names at run time. When it
        // declares participants, that list is what config can know about it.
        // When it declares none, nothing here can tell a genuinely idle roster
        // entry from a worker the plan will name, so the warning is withheld
        // for this Team — rather than every roster member being marked
        // reachable, which turned one pipeline into a team-wide off switch.
        if (stage.participants?.length) {
          for (const name of stage.participants) referenced.add(name)
        } else {
          planDrivenRoster = true
        }
        break
      case 'review':
        referenced.add(stage.producer)
        referenced.add(stage.reviewer)
        break
      default:
        break
    }
  }
  if (config.workspace.routing_agent) referenced.add(config.workspace.routing_agent)

  // An agent a level never lists can still be named by the machinery around
  // the levels: as a gate's validator, as a gate transform's agent, or as
  // another agent's failure fallback. None of those is an idle roster entry.
  for (const gate of config.gates) {
    if (gate.transform?.agent) referenced.add(gate.transform.agent)
    const condition = gate.condition
    if (
      (condition.type === 'validation' || condition.type === 'agent_verdict') &&
      condition.validator
    ) {
      referenced.add(condition.validator)
    }
  }
  for (const agent of config.agents) {
    if (agent.on_failure?.fallback_agent) {
      referenced.add(agent.on_failure.fallback_agent)
    }
  }

  if (planDrivenRoster) return []

  return config.agents
    .filter((agent) => !referenced.has(agent.name))
    .map(
      (agent) =>
        `Agent '${agent.name}' is on the roster but no stage uses it, so it ` +
        `will never be dispatched. Add it to a level or remove it.`,
    )
}

function validateRunnableStages(config: TeamConfig): string[] {
  const errors: string[] = []
  for (const level of config.levels) {
    const stage = level.stage
    if (stage.type === 'chain' && stage.sequence.length === 0) {
      errors.push(
        `Chain stage '${level.id}' requires at least one sequence agent to run.`,
      )
    }
    if (stage.type === 'broadcast' && stage.fan_out.length === 0) {
      errors.push(
        `Broadcast stage '${level.id}' requires at least one fan-out agent to run.`,
      )
    }
    if (stage.type === 'discussion' && stage.participants.length === 0) {
      errors.push(
        `Discussion stage '${level.id}' requires at least one participant to run.`,
      )
    }
  }
  return errors
}

/** Stage type of the declared workflow entry, or the first level by default. */
function parseEntryStageType(rawTeam: YamlObject): string | undefined {
  const stage = parseEntryStage(rawTeam)
  return stage ? stringOrUndefined(stage.type) : undefined
}

/**
 * The lead of the entry level, and only when that level deliberates.
 *
 * A chain, pipeline, or broadcast entry names no lead: it runs its declared
 * sequence. Reporting a coordinator for one of those would make the Run
 * sidebar promise a convening step the run never performs.
 */
function parseDiscussionCoordinator(rawTeam: YamlObject): string | undefined {
  const stage = parseEntryStage(rawTeam)
  if (!stage || stringOrUndefined(stage.type) !== 'discussion') return undefined
  return stringOrUndefined(stage.coordinator)
}

function parseEntryStage(rawTeam: YamlObject): YamlObject | undefined {
  const levels = Array.isArray(rawTeam.levels) ? rawTeam.levels.filter(isObject) : []
  const workflow = isObject(rawTeam.workflow) ? rawTeam.workflow : undefined
  const entryLevelIndex = resolveEntryLevelIndex(
    levels.map((level) => ({ id: stringOrUndefined(level.id) ?? '' })),
    workflow ? stringOrUndefined(workflow.entry_level) : undefined,
  )
  const level = levels[entryLevelIndex]
  if (!level || !isObject(level.stage)) return undefined
  return level.stage
}

/**
 * Whether a person may launch this team directly. Absent declarations stay
 * permissive; only an explicit `user_facing: false` or an `invocation_modes`
 * list without `user` marks a team as caller-only.
 */
export function parseUserInvocable(rawTeam: YamlObject): boolean {
  const workflow = isObject(rawTeam.workflow) ? rawTeam.workflow : {}
  if (workflow.user_facing === false) return false
  const modes = Array.isArray(workflow.invocation_modes)
    ? workflow.invocation_modes.filter((mode): mode is string => typeof mode === 'string')
    : undefined
  if (modes && !modes.includes('user')) return false
  return true
}

function getTeamRecord(repoRoot: string, teamId: string): TeamRecord {
  const team = listTeamRecords(repoRoot).find((entry) => entry.id === teamId)
  if (!team) throw new Error(`Team not found: ${teamId}`)
  return team
}

function toTeamDetail(record: TeamRecord, raw: YamlObject): TeamBuilderDetail {
  const yaml = readTextSyncSafe(record.teamYamlPath)
  const defaults = isObject(raw.defaults) ? raw.defaults : {}
  const legacyModels = parseLegacyModels(raw.models)
  const legacyDefaultProvider = stringOrUndefined(defaults.provider)
  const teamDir = path.dirname(record.teamYamlPath)
  const agents = parseRosterAgents(raw.agents, raw.levels).map((agent) =>
    withPersonaRuntime(agent, teamDir),
  )
  const warnings = [
    ...agents
      .filter((agent) => agent.personaMissing)
      .map(
        (agent) =>
          `Agent '${agent.name}' names a persona file that is missing or unreadable (${agent.agent_file ?? 'no agent_file'}). The runtime will skip this agent.`,
      ),
    ...retiredRuntimeFieldWarnings({
      ...whenDefined(legacyModels, (models) => ({ models })),
      ...whenDefined(legacyDefaultProvider, (defaultProvider) => ({ defaultProvider })),
      agents,
    }),
  ]
  return {
    id: record.id,
    name: record.name,
    ...whenDefined(record.description, (description) => ({ description })),
    tags: record.tags,
    agentCount: agents.length,
    health: record.health,
    teamPath: record.teamPath,
    yaml,
    // Both read from the same bytes, so what the editor shows and what it
    // writes against cannot describe different files.
    ...whenDefined(readSavedTeamShape(yaml), (shape) => ({ shape })),
    revision: digestTeamYaml(yaml),
    ...whenDefined(legacyDefaultProvider, (provider) => ({ legacyDefaultProvider: provider })),
    ...whenDefined(legacyModels, (models) => ({ legacyModels: models })),
    agents,
    warnings,
  }
}

/**
 * Says what a legacy file still declares and what the run now ignores.
 *
 * These fields are never obeyed and never rewritten. Reporting them is the
 * only way a user learns that a team-level model setting they can still see in
 * the file stopped deciding anything.
 */
function retiredRuntimeFieldWarnings(params: {
  models?: Record<string, LegacyTeamModelSettings>
  defaultProvider?: string
  agents: readonly TeamRosterAgent[]
}): string[] {
  const warnings: string[] = []
  if (params.models && Object.keys(params.models).length > 0) {
    warnings.push(
      `This team declares a models-by-tier table (${Object.keys(params.models).sort().join(', ')}). ` +
        `It is ignored: each agent runs with its own provider/model, or with the application default.`,
    )
  }
  if (params.defaultProvider) {
    warnings.push(
      `This team declares defaults.provider '${params.defaultProvider}'. It is ignored: ` +
        `an agent without its own model uses the application default from Settings.`,
    )
  }
  for (const agent of params.agents) {
    if (!agent.legacyModel && !agent.legacyProvider) continue
    const declared = [
      ...(agent.legacyProvider ? [`provider '${agent.legacyProvider}'`] : []),
      ...(agent.legacyModel ? [`model '${agent.legacyModel}'`] : []),
    ].join(' and ')
    warnings.push(
      `Roster entry '${agent.name}' declares ${declared}. It is ignored: ` +
        `edit the agent itself to change the model it runs with.`,
    )
  }
  return warnings
}

/**
 * Attach the provider/model the agent's own persona file declares.
 *
 * Read on every detail load instead of copied into `team.yaml`, so editing an
 * agent's provider on the Agents page is reflected in every team that lists
 * it.
 *
 * An agent-type entry whose persona file is absent or unreadable is marked
 * `personaMissing`. `loadAgent` drops exactly these entries at run time, so
 * the roster must report them rather than quietly showing the team runtime as
 * though the agent would start.
 */
function withPersonaRuntime(agent: TeamRosterAgent, teamDir: string): TeamRosterAgent {
  // Team-type entries delegate to another team and have no persona file.
  if (agent.type === 'team') return agent
  if (!agent.agent_file) return { ...agent, personaMissing: true }
  const personaPath = path.resolve(teamDir, agent.agent_file)
  if (!fs.existsSync(personaPath)) return { ...agent, personaMissing: true }
  let frontmatter: Record<string, string>
  try {
    frontmatter = parseAgentFrontmatter(personaPath).frontmatter
  } catch {
    return { ...agent, personaMissing: true }
  }
  return {
    ...agent,
    ...whenDefined(stringOrUndefined(frontmatter.provider), (personaProvider) => ({ personaProvider })),
    ...whenDefined(stringOrUndefined(frontmatter.model), (personaModel) => ({ personaModel })),
  }
}

/**
 * Reads a legacy models-by-tier table exactly as written, with no synthesis.
 *
 * Returns `undefined` when the file has none, so an absent table is never
 * turned into an invented one.
 */
function parseLegacyModels(
  value: YamlValue | undefined,
): Record<string, LegacyTeamModelSettings> | undefined {
  if (!isObject(value)) return undefined
  const models: Record<string, LegacyTeamModelSettings> = {}
  for (const [key, rawModel] of Object.entries(value)) {
    if (!isObject(rawModel)) continue
    models[key] = {
      model: stringOrUndefined(rawModel.model) ?? '',
      thinking: stringOrUndefined(rawModel.thinking) ?? '',
      ...whenDefined(stringOrUndefined(rawModel.provider), (provider) => ({ provider })),
    }
  }
  return Object.keys(models).length > 0 ? models : undefined
}

function parseRosterAgents(value: YamlValue | undefined, levels: YamlValue | undefined): TeamRosterAgent[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isObject)
    .map((agent) => {
      const name = stringOrUndefined(agent.name) || ''
      return {
        name,
        type: stringOrUndefined(agent.type) === 'team' ? 'team' : 'agent',
        role: collapseText(stringOrUndefined(agent.role) || ''),
        // Verbatim, or absent. Normalizing here replaced a grade somebody
        // wrote with one nobody chose, and a re-render then wrote that back.
        ...whenDefined(stringOrUndefined(agent.tier), (tier) => ({ tier })),
        tools: parseStringList(agent.tools),
        ...whenDefined(stringOrUndefined(agent.agent_file), (agent_file) => ({ agent_file })),
        ...whenDefined(stringOrUndefined(agent.model), (legacyModel) => ({ legacyModel })),
        ...whenDefined(stringOrUndefined(agent.provider), (legacyProvider) => ({ legacyProvider })),
        ...whenDefined(typeof agent.experience_enabled === 'boolean' ? agent.experience_enabled : undefined, (experience_enabled) => ({ experience_enabled })),
        ...whenDefined(parseArtifactDeclarations(agent.produces), (produces) => ({ produces })),
        ...whenDefined(parseArtifactDeclarations(agent.consumes), (consumes) => ({ consumes })),
        referenced: recursiveStringContains(levels, name),
      }
    })
}

/**
 * Rewrites a generated team's entry stage to a chosen shape, and nothing else.
 *
 * The `levels:` block is replaced because the stage is exactly what this call
 * is about; the roster, the workflow contract, the gate and every comment
 * outside that block are untouched. Refused on a team this app did not author,
 * for the same reason ownership transfer is: its stage is its author's.
 *
 * Membership already declared is carried across where the new shape has a place
 * for it, so reconciling a shell mid-build does not discard the members added
 * so far.
 */
export async function applyTeamBuilderShape(params: {
  repoRoot: string
  teamId: string
  shape: TeamShape
}): Promise<TeamBuilderDetail> {
  const record = getTeamRecord(params.repoRoot, sanitizeTeamId(params.teamId))
  const registryPath = path.join(params.repoRoot, 'teams.yaml')
  return withFileMutationLock(registryPath, async () => {
    const currentYaml = await fs.promises.readFile(record.teamYamlPath, 'utf8')
    const parsed = parseYaml(currentYaml)
    if (!generatedSetupStage(parsed)) {
      throw new Error(
        `Cannot change how team '${record.id}' works together: it was not created here, ` +
          `so its stage is its author's to change.`,
      )
    }
    // Re-read inside the lock. A caller that checked this before waiting for
    // the lock can have been overtaken: publication takes the same lock, so a
    // team that was unfinished when the retry decided to reconcile can be
    // published by the time the retry actually holds it.
    if (!readTeamBuildingFlag(currentYaml)) {
      throw new Error(
        `Team '${record.id}' has already been built. Change it from the team ` +
          `editor, or create a new one.`,
      )
    }

    const roster = parseRosterAgents(parsed.agents, parsed.levels).map((agent) => ({
      name: agent.name,
    }))
    const nextYaml = ensureTrailingNewline(
      settleGeneratedOutputOwnership(
        replaceOrAppendTopLevelBlock(
          currentYaml,
          'levels',
          renderLevelsBlock(roster, params.shape),
        ),
      ),
    )
    await writeFileAtomic(record.teamYamlPath, nextYaml)
    return readTeamBuilderTeam(params.repoRoot, record.id)
  })
}

/**
 * Whether this team's build has still to finish, as its own file records it.
 *
 * Absent means published, which is what every team that predates the marker
 * says and what a team created outside a build says.
 */
export function isTeamBuilding(repoRoot: string, teamId: string): boolean {
  const record = listTeamRecords(repoRoot).find((team) => team.id === sanitizeTeamId(teamId))
  if (!record) return false
  // Read synchronously: this answers a listing filter, and an async predicate
  // would make every catalog read a fan-out of file reads.
  try {
    return readTeamBuildingFlag(fs.readFileSync(record.teamYamlPath, 'utf8'))
  } catch {
    return false
  }
}

/**
 * The teams a user may see and launch.
 *
 * Deliberately not `listTeamBuilderTeams`. That list is the builder's own, and
 * reconciliation, ownership reservation and member mutation all depend on it
 * still returning a shell that is being assembled — filtering it would hide an
 * unfinished team from the only thing that can finish it.
 */
export function listPublishedTeams(
  repoRoot: string,
  runtime: TeamHealthRuntimeContext = {},
): TeamBuilderSummary[] {
  return listTeamBuilderTeams(repoRoot, runtime).filter(
    (team) => !isTeamBuilding(repoRoot, team.id),
  )
}

/**
 * Marks the build finished, which is what publishes the team.
 *
 * Called only once everything the team needs exists. Until then the team is
 * visible to its builder and to nobody else.
 */
export async function finishTeamBuilderPublication(
  repoRoot: string,
  teamId: string,
  /**
   * What the build was admitted to produce.
   *
   * Parser validity is not completion: a build meant to assemble three agents
   * that stopped after one still leaves a file that parses. Publication is tied
   * to the roster and shape the build was admitted with, so a team that is
   * merely well-formed is not mistaken for a finished one.
   */
  admitted: {
    expectedRoster?: readonly string[]
    /**
     * The complete executable shape, not just its kind.
     *
     * Order, roles and depth are all executable: a chain that runs in the wrong
     * order, a discussion with the wrong lead, or either at the wrong round
     * ceiling is a different team from the one admitted. Comparing only the
     * kind is the same mistake a retry made when it accepted an amendment and
     * rebuilt the previous arrangement.
     */
    expectedShape?: TeamShape
    /**
     * The revision of the plan this build was admitted with.
     *
     * Recorded beside the plan id in the publication evidence, so evidence from
     * one attempt cannot vouch for a later attempt of the same plan after that
     * plan was amended.
     */
    admittedRevision?: string
    /**
     * Cancellation, re-read once this call holds the mutation lock.
     *
     * Checking only before awaiting the lock leaves a window: the lock can be
     * held by another writer for as long as that writer takes, and an abort
     * arriving in between would otherwise still publish.
     */
    signal?: AbortSignal
  } = {},
): Promise<void> {
  const record = getTeamRecord(repoRoot, sanitizeTeamId(teamId))
  const registryPath = path.join(repoRoot, 'teams.yaml')
  await withFileMutationLock(registryPath, async () => {
    if (admitted.signal?.aborted) {
      throw admitted.signal.reason instanceof Error
        ? admitted.signal.reason
        : new Error(`Publication of team '${record.id}' was cancelled.`)
    }
    const current = await fs.promises.readFile(record.teamYamlPath, 'utf8')
    if (!readTeamBuildingFlag(current)) return

    // Publication is the moment a team becomes launchable, so it is the last
    // place that can refuse. A shell with no roster cannot satisfy its own
    // gate, and publishing it hands the user a team that fails the moment they
    // run it. Checked inside the lock, against the bytes about to be published.
    const invalid = validateCandidateTeamYaml(record.teamYamlPath, current)
    if (invalid.length > 0) {
      throw new Error(
        `Cannot publish team '${record.id}': it is not complete — ${invalid.join('; ')}`,
      )
    }

    const parsed = parseYaml(current)
    const roster = parseRosterAgents(parsed.agents, parsed.levels).map((agent) => agent.name)
    if (admitted.expectedRoster) {
      // Exactly the admitted roster. An extra member is as wrong as a missing
      // one: it is on a team the user never approved.
      const missing = admitted.expectedRoster.filter((name) => !roster.includes(name))
      const extra = roster.filter((name) => !admitted.expectedRoster?.includes(name))
      if (missing.length > 0 || extra.length > 0) {
        throw new Error(
          `Cannot publish team '${record.id}': its roster is not the one this build was ` +
            `admitted with${missing.length > 0 ? `, missing ${joinLabels([...missing])}` : ''}` +
            `${extra.length > 0 ? `, unexpected ${joinLabels([...extra])}` : ''}.`,
        )
      }
    }
    if (admitted.expectedShape) {
      const difference = stageDiffersFromShape(parsed, admitted.expectedShape)
      if (difference) {
        throw new Error(
          `Cannot publish team '${record.id}': ${difference}`,
        )
      }
    }

    // The building marker goes, and positive evidence of this publication takes
    // its place. Recovery reads that evidence rather than inferring completion
    // from a missing flag.
    const cleared = removeTeamBuildingKey(current)
    const ownerTeam = parseYaml(cleared).team
    const owner = isObject(ownerTeam)
      ? stringOrUndefined(ownerTeam.created_by_orchestrator)
      : undefined
    await writeFileAtomic(
      record.teamYamlPath,
      ensureTrailingNewline(
        owner
          ? withTeamPublishedBy(
              cleared,
              admitted.admittedRevision ? `${owner}@${admitted.admittedRevision}` : owner,
            )
          : cleared,
      ),
    )
  })
}

/**
 * Removes the `building` key from the `team:` block, and nothing else.
 *
 * Located by its block and its own indent rather than by matching a line. The
 * same word can appear elsewhere in a team's own file, and a line filter
 * deleted an unrelated nested field; a trailing comment is ordinary YAML and
 * made the real key invisible to an exact match, leaving the team hidden with
 * no way to publish it.
 */
function removeTeamBuildingKey(yaml: string): string {
  const lines = yaml.split('\n')
  const range = findBlockRange(lines, 'team')
  if (!range) return yaml
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index] ?? ''
    if (indentWidth(line) !== 2) continue
    if (!new RegExp(`^${TEAM_BUILDING_KEY}:\\s`, 'u').test(line.trimStart())) continue
    lines.splice(index, 1)
    return lines.join('\n')
  }
  return yaml
}

/**
 * How a saved generated team works together, as its own file records it.
 *
 * `undefined` for anything this feature did not write, or wrote in a form it
 * no longer recognises: the editor then offers nothing to change rather than
 * offering to rewrite a file it does not understand.
 *
 * The file records what the team does, not the sentence the Architect once gave
 * for it — that is not written down anywhere. So the rationale says the one
 * thing that is true of a saved team and cannot be invented: this is how it is
 * set up. It is a real sentence because the contract requires one, and every
 * reader renders it.
 */
export const SAVED_SHAPE_RATIONALE = 'this is how the team is set up now.'

export function readSavedTeamShape(yaml: string): TeamShape | undefined {
  let parsed: YamlObject
  try {
    parsed = parseYaml(yaml)
  } catch {
    return undefined
  }
  if (!savedTeamShapeIsEditable(parsed, yaml)) return undefined
  const stage = generatedSetupStage(parsed)
  if (!stage) return undefined
  const roster = parseRosterAgents(parsed.agents, parsed.levels).map(
    (agent) => agent.name,
  )
  const config = isObject(stage.config) ? stage.config : {}
  const type = stringOrUndefined(stage.type)

  if (type === 'chain') {
    return usableShape(
      {
        kind: 'chain',
        rationale: SAVED_SHAPE_RATIONALE,
        // A chain runs each member once, so its depth is the one depth that
        // describes it. Reporting anything else would make the card offer a
        // number the stage does not have.
        depth: 'quick',
        order: parseStringList(stage.sequence),
      },
      roster,
    )
  }
  if (type === 'discussion') {
    const coordinator = stringOrUndefined(stage.coordinator)
    const depth = depthForRounds(config.max_rounds)
    if (!coordinator || !depth) return undefined
    return usableShape(
      {
        kind: 'discussion',
        rationale: SAVED_SHAPE_RATIONALE,
        depth,
        coordinator,
        participants: parseStringList(stage.participants),
      },
      roster,
    )
  }
  const producer = stringOrUndefined(stage.producer)
  const reviewer = stringOrUndefined(stage.reviewer)
  const attempts = depthForRounds(config.max_iterations)
  if (!producer || !reviewer || !attempts) return undefined
  return usableShape(
    {
      kind: 'review',
      rationale: SAVED_SHAPE_RATIONALE,
      depth: attempts,
      producer,
      reviewer,
    },
    roster,
  )
}

/**
 * The shape, or nothing when it is not one anybody could act on.
 *
 * A team can be created before it has any members and filled afterwards. Its
 * stage then names nobody, which is not an arrangement: the contract every
 * reader validates against refuses it, so reporting it hands the editor a value
 * it cannot read. Nothing to report is the truth, and the team stays perfectly
 * readable so members can be added to it.
 */
function usableShape(
  shape: TeamShape,
  roster: readonly string[],
): TeamShape | undefined {
  if (!teamShapeSchema.safeParse(shape).success) return undefined
  return validateShapeAgainstRoster(shape, roster).ok ? shape : undefined
}

/**
 * The depth a saved round count came from, or nothing when none did.
 *
 * Only the three counts this app writes are describable. Rounding anything else
 * down invented behaviour: a team set to two rounds was reported as "one pass
 * each", which is not what it does, and changing anything else about it would
 * then have written that wrong number back.
 */
function depthForRounds(saved: unknown): TeamShapeDepth | undefined {
  const depths: readonly TeamShapeDepth[] = ['quick', 'standard', 'thorough']
  return depths.find((depth) => depthRounds(depth).rounds === saved)
}

/**
 * Rewrites how a saved team works together, and only that.
 *
 * A saved team's file is the product, not a plan: hand-written comments, model
 * pins on individual members, artifacts nobody else declared. So the stage
 * block is replaced in place and everything around it is left exactly as it
 * was, and the write is guarded by the revision the editor was showing.
 *
 * Deliberately not `applyTeamBuilderShape`, which rewrites a team a build still
 * owns and may move ownership of the output artifact as it goes. Here the
 * roster is already settled and is not this operation's to touch.
 */
export async function changeSavedTeamShape(params: {
  repoRoot: string
  teamId: string
  shape: TeamShape
  expectedRevision: string
}): Promise<TeamBuilderDetail> {
  const registryPath = path.join(params.repoRoot, 'teams.yaml')
  return withFileMutationLock(registryPath, async () => {
    const record = getTeamRecord(params.repoRoot, sanitizeTeamId(params.teamId))
    const currentYaml = await fs.promises.readFile(record.teamYamlPath, 'utf8')
    const currentRevision = digestTeamYaml(currentYaml)
    if (currentRevision !== params.expectedRevision) {
      throw new TeamRevisionConflictError(record.id, params.expectedRevision, currentRevision)
    }
    const parsed = parseYaml(currentYaml)
    if (readTeamBuildingFlag(currentYaml)) {
      throw new Error(
        `Team '${record.id}' is still being built. Wait for its build to finish.`,
      )
    }
    if (!savedTeamShapeIsEditable(parsed, currentYaml)) {
      throw new TeamShapeNotEditableError(record.id)
    }
    const roster = parseRosterAgents(parsed.agents, parsed.levels)
    const verdict = validateShapeAgainstRoster(
      params.shape,
      roster.map((agent) => agent.name),
    )
    if (!verdict.ok) {
      const names = verdict.offendingNames?.length
        ? ` (${verdict.offendingNames.join(', ')})`
        : ''
      throw new TeamShapeRosterError(`${verdict.reason}${names}`)
    }

    // The stage first, then who owns the result: which member writes the
    // deliverable is part of the arrangement, not a separate setting. A chain's
    // last member writes it, a discussion's lead writes it, and a review's is
    // written by the runtime once the reviewer approves — so a change that
    // moved the stage and left the old owner declaring it would emit a team
    // whose stage and roster disagree.
    const nextYaml = ensureTrailingNewline(
      settleGeneratedOutputOwnership(
        replaceGeneratedStageBody(currentYaml, roster, params.shape),
      ),
    )
    // Read back by the parser the runtime uses before anything is written. A
    // rewrite that produced a team the runtime cannot load would be discovered
    // only when somebody tried to run it.
    const invalid = validateCandidateTeamYaml(record.teamYamlPath, nextYaml)
    if (invalid.length > 0) {
      throw new Error(
        `Changing how team '${record.id}' works together would leave it unusable: ${
          invalid.join('; ')
        }`,
      )
    }
    await writeFileAtomic(record.teamYamlPath, nextYaml)
    return readTeamBuilderTeam(params.repoRoot, record.id)
  })
}

/** A team whose file this feature did not write, so it will not rewrite it. */
export class TeamShapeNotEditableError extends Error {
  constructor(readonly teamId: string) {
    super(
      `Team '${teamId}' was not created here, so how it works together cannot be changed from this app.`,
    )
  }
}

/** A shape that does not account for the saved roster exactly once. */
export class TeamShapeRosterError extends Error {}

/** The build that published this team, as its own file records it. */
export function teamPublishedBy(repoRoot: string, teamId: string): string | undefined {
  const record = listTeamRecords(repoRoot).find((team) => team.id === sanitizeTeamId(teamId))
  if (!record) return undefined
  try {
    return readTeamPublishedBy(fs.readFileSync(record.teamYamlPath, 'utf8'))
  } catch {
    return undefined
  }
}

function readTeamPublishedBy(yaml: string): string | undefined {
  const team = parseYaml(yaml).team
  return isObject(team) ? stringOrUndefined(team[TEAM_PUBLISHED_BY_KEY]) : undefined
}

/** Writes the publishing build in as the first key of the `team:` block. */
function withTeamPublishedBy(yaml: string, planId: string): string {
  if (readTeamPublishedBy(yaml) === planId) return yaml
  const lines = yaml.split('\n')
  const range = findBlockRange(lines, 'team')
  if (!range) return yaml
  lines.splice(range.start + 1, 0, `  ${TEAM_PUBLISHED_BY_KEY}: ${yamlQuoted(planId)}`)
  return lines.join('\n')
}

/** The provenance marker a team.yaml already records, if it records one. */
function readTeamProvenance(yaml: string): string | undefined {
  const team = parseYaml(yaml).team
  return isObject(team)
    ? stringOrUndefined(team[GENERATED_TEAM_PROVENANCE_KEY])
    : undefined
}

function parseArtifactDeclarations(
  value: YamlValue | undefined,
): Array<{ path: string; description?: string }> | undefined {
  if (!Array.isArray(value)) return undefined
  const declarations = value
    .filter(isObject)
    .map((artifact) => ({
      path: stringOrUndefined(artifact.path) ?? '',
      ...whenDefined(stringOrUndefined(artifact.description), (description) => ({ description })),
    }))
    .filter((artifact) => artifact.path.length > 0)
  return declarations.length > 0 ? declarations : undefined
}

function readYamlSafe(filePath: string): YamlObject {
  try {
    return parseYamlObjectSafe(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return {}
  }
}

function parseYamlObjectSafe(text: string): YamlObject {
  try {
    const parsed = parseYaml(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function readTextSyncOrUndefined(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
}

function readTextSyncSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

async function readTextSafe(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

function normalizeTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean))].sort()
}

function sanitizeTeamId(input: string): string {
  return (input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
}

function recursiveStringContains(value: unknown, needle: string): boolean {
  if (!needle) return false
  if (typeof value === 'string') return value === needle
  if (Array.isArray(value)) return value.some((item) => recursiveStringContains(item, needle))
  if (isObject(value)) return Object.values(value).some((item) => recursiveStringContains(item, needle))
  return false
}

function toRepoRelativePosix(repoRoot: string, targetPath: string): string {
  return `./${toPosix(path.relative(repoRoot, targetPath))}`
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}
