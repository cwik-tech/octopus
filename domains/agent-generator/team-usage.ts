import { whenDefined } from '../../core/optional-properties.js'
import {
  assertTeamRevision,
  extendGeneratedStageMembership,
  isTeamBuilding,
  refusalToAddMember,
} from './team-manager.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseYaml, type YamlObject } from '../../core/yaml-parser.js'
import { parseAgentFrontmatter } from '../../parsers/load-agent.js'
import { withFileMutationLock, writeFileAtomic } from '../../core/file-mutation.js'
import type { AgentTeamOption, AgentTeamUsage, TeamRosterAgent } from './types.js'
import {
  insertRosterEntries,
  refusalForRosterShape,
  rosterEditKeepsTeam,
} from './team-yaml-addition.js'

interface TeamRecord extends AgentTeamOption {
  teamYamlPath: string
}

export function listAgentTeamOptions(repoRoot: string): AgentTeamOption[] {
  // The teams a user may add an Agent to. A half-built one is not among them:
  // its roster is the build's to finish, not a page's to edit.
  return listTeamRecords(repoRoot)
    .filter((team) => !isTeamBuilding(repoRoot, team.id))
    .map(({ teamYamlPath: _teamYamlPath, ...team }) => team)
}

export function listAgentTeamUsage(repoRoot: string): Map<string, AgentTeamUsage[]> {
  const usage = new Map<string, AgentTeamUsage[]>()
  const agentsRoot = path.resolve(repoRoot, 'agents')

  for (const team of listTeamRecords(repoRoot)) {
    const raw = readYamlSafe(team.teamYamlPath)
    const agents = Array.isArray(raw.agents) ? raw.agents : []
    for (const entry of agents) {
      if (!isObject(entry)) continue
      if (typeof entry.agent_file !== 'string') continue
      const agentPath = path.resolve(path.dirname(team.teamYamlPath), entry.agent_file)
      const relative = path.relative(agentsRoot, agentPath)
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue
      const parts = relative.split(path.sep)
      const agentName = parts[0]
      if (!agentName) continue
      const next = usage.get(agentName) ?? []
      next.push({ teamId: team.id, teamName: team.name })
      usage.set(agentName, next)
    }
  }

  for (const teams of usage.values()) {
    teams.sort((left, right) => left.teamName.localeCompare(right.teamName))
  }
  return usage
}

/**
 * Add one library agent to a team roster from the Agent page.
 *
 * Runs under the same `teams.yaml` lock key the Team Builder mutations take and
 * ends in an atomic replace. This is the other public writer of `team.yaml`, so
 * without that key a roster read here can straddle a Team Builder add or
 * removal and write back a snapshot that resurrects or loses a member.
 */
export async function addAgentToTeam(params: {
  repoRoot: string
  agentName: string
  teamId: string
  role?: string
  expectedRevision?: string | undefined
}): Promise<{ agentName: string; teamId: string; teamYamlPath: string; added: boolean }> {
  const agentName = sanitizeAgentName(params.agentName)
  if (!agentName) throw new Error('agentName must be a non-empty kebab-case identifier')

  const registryPath = path.join(params.repoRoot, 'teams.yaml')
  return withFileMutationLock(registryPath, async () => {
    const team = listTeamRecords(params.repoRoot).find((entry) => entry.id === params.teamId)
    if (!team) throw new Error(`Team not found: ${params.teamId}`)
    await assertTeamRevision(team.id, team.teamYamlPath, params.expectedRevision)

    const agentPath = path.join(params.repoRoot, 'agents', agentName, `${agentName}.md`)
    if (!fs.existsSync(agentPath)) {
      throw new Error(`Agent persona does not exist: agents/${agentName}/${agentName}.md`)
    }

    // The roster of a team being built belongs to that build. Hiding it from
    // the picker is not protection: a stale page or a direct request reaches
    // this writer anyway, and an added member would not be part of the roster
    // the build was admitted with.
    if (isTeamBuilding(params.repoRoot, params.teamId)) {
      throw new Error(
        `Team '${params.teamId}' is still being built. Wait for it to finish ` +
          `before adding members.`,
      )
    }
    const raw = readYamlSafe(team.teamYamlPath)
    // The same refusal the Create writers apply. A member no stage can run is
    // the same loss whichever page adds it, so the rule lives with the team
    // rather than with one caller.
    const refusal = refusalToAddMember(raw, [agentName])
    if (refusal) throw new Error(refusal)

    const agents = Array.isArray(raw.agents) ? raw.agents : []
    const alreadyPresent = agents.some((entry) => {
      if (!isObject(entry)) return false
      return entry.name === agentName || entry.agent_file === path.relative(path.dirname(team.teamYamlPath), agentPath)
    })
    if (alreadyPresent) {
      return { agentName, teamId: team.id, teamYamlPath: team.teamYamlPath, added: false }
    }

    const frontmatter = parseAgentFrontmatter(agentPath).frontmatter
    const role = (params.role ?? frontmatter.description ?? `${agentName} library agent.`).trim()
    const relativeAgentPath = path
      .relative(path.dirname(team.teamYamlPath), agentPath)
      .split(path.sep)
      .join('/')

    // The Team Builder's roster entry, with the role this page has always
    // written: an empty role falls back to "Library agent.", never to the
    // renderer's own "<name> library agent.".
    const entry: TeamRosterAgent = {
      name: agentName,
      type: 'agent',
      role: role.replace(/\s+/gu, ' ').trim() || 'Library agent.',
      tools: [],
      agent_file: relativeAgentPath,
      experience_enabled: true,
      referenced: false,
    }

    const current = await fs.promises.readFile(team.teamYamlPath, 'utf8')
    const shapeRefusal = refusalForRosterShape(team.id, current)
    if (shapeRefusal) throw new Error(shapeRefusal)
    // Allowed onto the roster is not the same as being run. A generated
    // discussion has a participants list, and a member that never reaches it
    // sits on the team without ever speaking — so the same stage edit the
    // Create writers make is applied here too.
    const next = extendGeneratedStageMembership(
      insertRosterEntries(current, [entry]),
      agentName,
    )
    if (!rosterEditKeepsTeam(parseYaml(current), parseYaml(next), [agentName])) {
      throw new Error(
        `Team '${team.id}' has a roster this page cannot extend without hiding or losing a member, so it cannot take new members`,
      )
    }
    await writeFileAtomic(team.teamYamlPath, next.endsWith('\n') ? next : `${next}\n`)
    return { agentName, teamId: team.id, teamYamlPath: team.teamYamlPath, added: true }
  })
}

function listTeamRecords(repoRoot: string): TeamRecord[] {
  const registryPath = path.join(repoRoot, 'teams.yaml')
  const raw = readYamlSafe(registryPath)
  const teams: TeamRecord[] = []
  for (const [teamId, value] of Object.entries(raw)) {
    if (teamId === 'workflow-architect') continue
    if (!isObject(value)) continue
    const tags = Array.isArray(value.tags) ? value.tags.map(String) : []
    if (tags.includes('internal')) continue
    if (value.type !== undefined && value.type !== 'team') continue
    if (typeof value.team_path !== 'string') continue
    const teamPath = path.resolve(path.dirname(registryPath), value.team_path)
    const teamYamlPath = path.join(teamPath, 'team.yaml')
    if (!fs.existsSync(teamYamlPath)) continue
    teams.push({
      id: teamId,
      name: teamId,
      ...whenDefined(typeof value.description === 'string' ? value.description.trim() : undefined, (definedValue) => ({ description: definedValue })),
      teamYamlPath,
    })
  }
  teams.sort((left, right) => left.name.localeCompare(right.name))
  return teams
}

function readYamlSafe(filePath: string): YamlObject {
  try {
    const parsed = parseYaml(fs.readFileSync(filePath, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeAgentName(input: string): string {
  return (input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
}
