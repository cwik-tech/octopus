/**
 * Server-owned optimistic revisions for update proposals.
 *
 * The model never supplies a revision. The server records one when it persists
 * an update plan and checks it again under the target's mutation lock, so a
 * Team edited between proposal and apply fails the operation instead of
 * silently overwriting the newer content.
 */

import { computeAgentRevision } from '../agent-generator/agent-revision.js'
import { digestTeamYaml, readTeamBuilderTeam } from '../agent-generator/index.js'

/**
 * Digest of the exact registered `team.yaml` bytes.
 *
 * Throws when the Team is not registered, which is also how a proposal for an
 * unknown Team is rejected before any provider work starts.
 */
export function computeTeamRevision(repoRoot: string, teamId: string): string {
  return digestTeamYaml(readTeamBuilderTeam(repoRoot, teamId).yaml)
}

export { digestTeamYaml }

/**
 * Digest of an Agent's persona and every file under `skills/`.
 *
 * Runtime experience and the ownership marker are outside it on purpose; see
 * `agent-revision.ts` for why.
 */
export { computeAgentRevision }
