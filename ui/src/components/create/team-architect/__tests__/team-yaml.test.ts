import { describe, expect, it } from "vitest";

import type { TeamBuilderDetail } from "@/lib/models/team-builder-model";
import { getTeamYaml, renderTeamYamlPreview } from "../team-yaml";

describe("team YAML preview", () => {
  it("uses persisted YAML when it contains content", () => {
    expect(getTeamYaml(teamDetail({ yaml: "team:\n  name: persisted\n" })))
      .toBe("team:\n  name: persisted\n");
  });

  it("renders the complete fallback shape with a trailing newline", () => {
    const yaml = renderTeamYamlPreview(
      teamDetail({
        agents: [
          {
            name: "analyst",
            type: "agent",
            role: "Examines evidence.",
            tier: "strategic",
            tools: ["browser", "files"],
            agent_file: "agents/analyst/agent.md",
            experience_enabled: false,
            referenced: true,
          },
        ],
      }),
    );

    // No `defaults:` and no `models:` sections: a team declares no runtime
    // settings, so a preview that showed them would advertise controls the run
    // ignores.
    expect(yaml).toBe(
      [
        "team:",
        '  name: "research-team"',
        "  description: >",
        "    Research team",
        "",
        "agents:",
        '  - name: "analyst"',
        "    type: agent",
        "    role: >",
        "      Examines evidence.",
        "    tier: strategic",
        "    tools:",
        '      - "browser"',
        '      - "files"',
        '    agent_file: "agents/analyst/agent.md"',
        "    experience_enabled: false",
        "",
      ].join("\n"),
    );
  });

  it("writes no grade for a member that declares none", () => {
    // The preview has to be the file that will be written. Authoring produces
    // no grade, so a preview that printed `tier: undefined` — or invented a
    // default — would show the person a line their team.yaml will not have.
    const yaml = renderTeamYamlPreview(
      teamDetail({
        agents: [
          {
            name: "analyst",
            type: "agent",
            role: "Examines evidence.",
            tools: [],
            referenced: true,
          },
        ],
      }),
    );

    expect(yaml).not.toMatch(/^ {4}tier:/m);
    expect(yaml).toContain('  - name: "analyst"');
    expect(yaml).toContain("      Examines evidence.");
  });

  it("still shows the grade a member added before the field was retired", () => {
    // A roster written earlier keeps its own lines. Hiding one would make the
    // preview disagree with the file on disk, which is the one thing a preview
    // must never do.
    const yaml = renderTeamYamlPreview(
      teamDetail({
        agents: [
          {
            name: "analyst",
            type: "agent",
            role: "Examines evidence.",
            tier: "strategic",
            tools: [],
            referenced: true,
          },
        ],
      }),
    );

    expect(yaml).toMatch(/^ {4}tier: strategic$/m);
  });

  it("renders an empty roster without dropping sections", () => {
    expect(renderTeamYamlPreview(teamDetail())).toBe(
      [
        "team:",
        '  name: "research-team"',
        "  description: >",
        "    Research team",
        "",
        "agents: []",
        "",
      ].join("\n"),
    );
  });
});

function teamDetail(
  overrides: Partial<TeamBuilderDetail> = {},
): TeamBuilderDetail {
  return {
    id: "research-team",
    name: "research-team",
    description: "Research team",
    tags: [],
    agentCount: 0,
    revision: "sha256:fixture",
    teamPath: "teams/research-team",
    yaml: "",
    agents: [],
    warnings: [],
    ...overrides,
    health: overrides.health ?? { status: "ok", errors: [], warnings: [] },
  };
}
