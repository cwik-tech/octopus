import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listAgents } from "@/lib/clients/agent-generator-client";
import {
  changeSavedTeamShape,
  listTeamBuilderTeams,
  readTeamBuilderTeam,
} from "@/lib/clients/team-builder-client";
import type { TeamBuilderDetail } from "@/lib/models/team-builder-model";
import { useTeamEditor } from "../use-team-editor";

vi.mock("@/lib/clients/agent-generator-client", () => ({
  deleteAgent: vi.fn(),
  listAgents: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/lib/clients/team-builder-client", () => ({
  addTeamBuilderAgent: vi.fn(),
  changeSavedTeamShape: vi.fn(),
  createTeamBuilderTeam: vi.fn(),
  deleteTeamBuilderTeam: vi.fn(),
  listTeamBuilderTeams: vi.fn(() => Promise.resolve([])),
  readTeamBuilderTeam: vi.fn(),
  removeTeamBuilderAgent: vi.fn(),
  updateTeamBuilderTeam: vi.fn(),
}));

function team(agentNames: string[]): TeamBuilderDetail {
  return {
    id: "furniture-makers",
    name: "Furniture Makers",
    description: "A practical woodworking team.",
    tags: ["furniture-making"],
    agentCount: agentNames.length,
    health: { status: "ok", errors: [], warnings: [] },
    revision: "sha256:fixture",
    teamPath: "teams/furniture-makers/team.yaml",
    yaml: "id: furniture-makers\n",
    agents: agentNames.map((name) => ({
      name,
      type: "agent" as const,
      role: "Specialist.",
      tier: "strategic",
      tools: [],
      referenced: true,
    })),
    warnings: [],
  };
}

const onDetailsOpenChange = vi.fn();

function renderTeamEditor(requestId: string) {
  return renderHook(
    (props: { teamSelectionRequest: { id: string; requestId: string } }) =>
      useTeamEditor({ ...props, onDetailsOpenChange }),
    {
      initialProps: {
        teamSelectionRequest: { id: "furniture-makers", requestId },
      },
    },
  );
}

describe("useTeamEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset, not clear: each test queues its own one-shot detail responses.
    vi.mocked(readTeamBuilderTeam).mockReset();
    vi.mocked(listAgents).mockResolvedValue([]);
    vi.mocked(listTeamBuilderTeams).mockResolvedValue([]);
  });

  it("re-reads the open team when the same team is selected again", async () => {
    // The Architect builds a team shell first and fills its roster as the
    // build runs, so a team opened mid-build is on screen with an empty
    // roster. Selecting it again is the only signal the panel gets that the
    // build finished.
    vi.mocked(readTeamBuilderTeam)
      .mockResolvedValueOnce(team([]))
      .mockResolvedValueOnce(team(["furniture-making-lead", "furniture-designer"]));

    const { result, rerender } = renderTeamEditor("request-1");
    await waitFor(() => expect(result.current.detail).not.toBeNull());
    expect(result.current.detail?.agents).toHaveLength(0);

    rerender({
      teamSelectionRequest: { id: "furniture-makers", requestId: "request-2" },
    });

    await waitFor(() => expect(result.current.detail?.agents).toHaveLength(2));
    expect(vi.mocked(readTeamBuilderTeam)).toHaveBeenCalledTimes(2);
  });

  it("keeps unsaved detail edits when the open team is re-read", async () => {
    vi.mocked(readTeamBuilderTeam)
      .mockResolvedValueOnce(team([]))
      .mockResolvedValueOnce(team(["furniture-making-lead"]));

    const { result, rerender } = renderTeamEditor("request-1");
    await waitFor(() => expect(result.current.detail).not.toBeNull());

    act(() => {
      result.current.setDraft((current) => ({
        ...current,
        description: "Edited while the build ran",
      }));
    });

    rerender({
      teamSelectionRequest: { id: "furniture-makers", requestId: "request-2" },
    });

    await waitFor(() => expect(result.current.detail?.agents).toHaveLength(1));
    expect(result.current.draft.description).toBe("Edited while the build ran");
  });

  // A change to one team's shape can answer after the user has opened another.
  // Applying it then replaced the team on screen with a different one, under a
  // selection that still said the one they were looking at.
  it("does not apply a shape change to a team the user has left", async () => {
    const teamA: TeamBuilderDetail = { ...team([]), id: "team-a", name: "Team A" };
    const teamB: TeamBuilderDetail = { ...team([]), id: "team-b", name: "Team B" };
    vi.mocked(readTeamBuilderTeam).mockImplementation((id: string) =>
      Promise.resolve(id === "team-a" ? teamA : teamB),
    );
    let answerChange = (): void => {};
    vi.mocked(changeSavedTeamShape).mockImplementation(
      () =>
        new Promise((resolve) => {
          answerChange = () =>
            resolve({
              ok: true,
              team: { ...teamA, description: "Changed A." },
            });
        }),
    );

    const { result } = renderHook(() => useTeamEditor({}));
    await act(async () => {
      result.current.setSelectedTeamId("team-a");
    });
    await waitFor(() => expect(result.current.detail?.id).toBe("team-a"));

    // The change is started, and the user opens another team while it is out.
    await act(async () => {
      void result.current.changeShape({
        kind: "chain",
        rationale: "One after another.",
        depth: "quick",
        order: [],
      });
    });
    await act(async () => {
      result.current.setSelectedTeamId("team-b");
    });
    await waitFor(() => expect(result.current.detail?.id).toBe("team-b"));

    await act(async () => {
      answerChange();
      await Promise.resolve();
    });

    expect(result.current.detail?.id).toBe("team-b");
    expect(result.current.selectedTeamId).toBe("team-b");
  });
});
