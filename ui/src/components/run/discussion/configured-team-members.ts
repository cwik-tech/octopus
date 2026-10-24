import type { AppDefaultModelState } from "@contracts/agent-model-selection";

import { resolveRosterAgentRuntime } from "@/components/create/team-architect/team-models";
import type { TeamBuilderSummary } from "@/lib/models/team-builder-model";

import type { ConfiguredTeamMember } from "./discussion-journey-model";

/**
 * The Team as configured, ready for the Run sidebar before anything has run.
 *
 * Each member's provider and model come from `resolveRosterAgentRuntime`, the
 * same rule the Team Builder page and the team runtime use, so the rail cannot
 * advertise a pair the run would not pick. Only a discussion entry level names
 * a lead; for every other stage type the whole roster are participants.
 */
export function configuredTeamMembers(
  team: TeamBuilderSummary | undefined,
  appDefault: AppDefaultModelState,
): ConfiguredTeamMember[] {
  if (!team) return [];
  // A catalog entry that carries names but no runtime layers still knows who
  // is on the Team. Showing the roster without icons beats showing neither.
  if (!team.agents) {
    return (team.agentNames ?? []).map((name) => ({
      name,
      role: memberRole(team, name),
    }));
  }
  return team.agents
    .filter((agent) => agent.type === "agent")
    .map((agent) => {
      const runtime = resolveRosterAgentRuntime(agent, appDefault);
      return {
        model: runtime.model,
        name: agent.name,
        provider: runtime.provider,
        role: memberRole(team, agent.name),
      };
    });
}

function memberRole(
  team: TeamBuilderSummary,
  name: string,
): ConfiguredTeamMember["role"] {
  return team.discussionCoordinator === name ? "Coordinator" : "Participant";
}
