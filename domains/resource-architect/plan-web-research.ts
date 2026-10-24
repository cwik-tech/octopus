import type { PersistedResourceArchitectPlan } from "../../contracts/resource-architect-persisted.js";
import type { PlannedAgentSpec } from "../../contracts/agent-generator.js";

/** Only newly planned Agents can change here. Reused Agents keep their settings. */
export function changePlanWebResearch(
  plan: PersistedResourceArchitectPlan,
  agentName: string,
  enabled: boolean,
): PersistedResourceArchitectPlan | null {
  let found = false;
  function update<T extends PlannedAgentSpec>(agent: T): T {
    if (agent.name !== agentName) return agent;
    found = true;
    return { ...agent, webResearchEnabled: enabled };
  }
  const next = plan.kind === "standalone_agents"
    ? { ...plan, agents: plan.agents.map(update) }
    : plan.kind === "team"
      ? { ...plan, team: { ...plan.team, newAgents: plan.team.newAgents.map(update) } }
      : { ...plan, operations: plan.operations.map((operation) => operation.kind === "add_team_agents"
        ? { ...operation, newAgentsToCreate: operation.newAgentsToCreate.map(update) }
        : operation) };
  return found ? next : null;
}
