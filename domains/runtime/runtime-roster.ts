import type {
  AgentRosterEntry,
  RegistryEntry,
  TeamConfig,
  TeamRegistryEntry,
} from '../../core/types.js'

function isTeamRegistryEntry(entry: RegistryEntry): entry is TeamRegistryEntry {
  return entry.type === 'team'
}

export function getAutoRegisteredTeamEntries(
  teamConfig: TeamConfig,
  teamRegistry: Map<string, RegistryEntry>,
): AgentRosterEntry[] {
  const canSpawnTeams = teamConfig.levels.some((level) => level.permissions?.spawn_teams)
  if (!canSpawnTeams) return []

  const existingNames = new Set(teamConfig.agents.map((agent) => agent.name))

  return [...teamRegistry.values()]
    .filter(isTeamRegistryEntry)
    .filter((entry) => entry.name !== teamConfig.team.name)
    .filter((entry) => !existingNames.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      type: 'team',
      role: entry.description ?? 'Registered specialist team.',
      agent_file: '',
      experience_enabled: false,
      team_path: entry.team_path,
      ...whenDefined(entry.input_artifact, (input_artifact) => ({ input_artifact })),
      ...whenDefined(entry.output_artifact, (output_artifact) => ({ output_artifact })),
      ...whenDefined(entry.host_model, (host_model) => ({ host_model })),
      ...whenDefined(entry.host_provider, (host_provider) => ({ host_provider })),
      ...whenDefined(entry.mount, (mount) => ({ mount })),
    }))
}
import { whenDefined } from '../../core/optional-properties.js'
