import type { PlannedAgentGenerationInput } from "../../contracts/agent-generator.js";
import type {
  ResourceTeamNewAgentPlan,
  ResourceTeamPlan,
} from "../../contracts/resource-architect.js";

export function renderResourceArchitectPlannedAgentBrief(
  team: ResourceTeamPlan | undefined,
  agent: PlannedAgentGenerationInput,
): string {
  if (!team) {
    return [
      "Create this planned Agent package.",
      "",
      `Planned Agent name: \`${agent.name}\``,
      `Role: ${agent.role}`,
      `Description: ${agent.description}`,
      `Rationale: ${agent.rationale}`,
      "",
      `The JSON suggestedName and persona frontmatter name must both be exactly \`${agent.name}\`.`,
    ].join("\n");
  }

  const lines = [
    `Create the missing agent \`${agent.name}\` for team \`${team.teamId}\`.`,
    `Team purpose: ${team.description}`,
    `Agent role: ${agent.role}`,
    `Agent persona brief: ${agent.description}`,
    `Reason this agent is missing: ${agent.rationale}`,
    `The JSON suggestedName and persona frontmatter name must both be exactly \`${agent.name}\`.`,
  ];
  if (team.documentDomains?.length) {
    lines.push("Document domains this team must cover:");
    for (const domain of team.documentDomains) {
      lines.push(`- ${domain.domain}: ${domain.evidenceAnchors.join("; ")}`);
    }
  }
  const specialization = (agent as ResourceTeamNewAgentPlan).documentSpecialization;
  if (specialization) {
    lines.push(
      `Established expertise domain: ${specialization.expertiseDomain}`,
      `Document-specific focus: ${specialization.focus}`,
      `Evidence anchors: ${specialization.evidenceAnchors.join("; ")}`,
      `Assessment targets: ${specialization.assessmentTargets.join("; ")}`,
      `Out of scope: ${specialization.outOfScope.join("; ")}`,
      "Base the permanent agent identity and title on the established expertise domain. Keep the evidence anchors and assessment targets as this document's assignment; do not turn document fragments into a fake scientific specialty.",
    );
  }
  return lines.join("\n");
}
