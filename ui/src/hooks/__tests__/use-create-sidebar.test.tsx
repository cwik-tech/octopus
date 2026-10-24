import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCreateSidebar } from "@/hooks/use-create-sidebar";

const agentClientMocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
}));
const sessionClientMocks = vi.hoisted(() => ({
  listWorkflows: vi.fn(),
}));
const teamClientMocks = vi.hoisted(() => ({
  invalidateTeamBuilderTeamsCache: vi.fn(),
  listTeamBuilderTeams: vi.fn(),
  subscribeToTeamBuilderTeams: vi.fn<(listener: () => void) => () => void>(),
}));

vi.mock("@/lib/clients/agent-generator-client", () => agentClientMocks);
vi.mock("@/lib/clients/session-client", () => sessionClientMocks);
vi.mock("@/lib/clients/team-builder-client", () => teamClientMocks);

let catalogListener: (() => void) | undefined;
const unsubscribe = vi.fn();

function publishCatalogInvalidation() {
  if (!catalogListener) throw new Error("Team catalog listener was not registered");
  catalogListener();
}

function teamSummary(status: "ok" | "warning") {
  return {
    id: "teaching-team",
    name: "Teaching Team",
    tags: [],
    agentCount: 2,
    health:
      status === "ok"
        ? { status, errors: [], warnings: [] }
        : {
            status,
            errors: [],
            warnings: ["Claude provider is not configured"],
          },
  } as const;
}

describe("useCreateSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    catalogListener = undefined;
    agentClientMocks.listAgents.mockResolvedValue([]);
    sessionClientMocks.listWorkflows.mockResolvedValue([]);
    teamClientMocks.subscribeToTeamBuilderTeams.mockImplementation((listener) => {
      catalogListener = listener;
      return unsubscribe;
    });
    teamClientMocks.invalidateTeamBuilderTeamsCache.mockImplementation(() => {
      catalogListener?.();
    });
  });

  it("refreshes Team health after provider settings change while Create stays mounted", async () => {
    teamClientMocks.listTeamBuilderTeams
      .mockResolvedValueOnce([teamSummary("warning")])
      .mockResolvedValueOnce([teamSummary("ok")]);

    const { result, unmount } = renderHook(() => useCreateSidebar("create"));

    await waitFor(() => {
      expect(result.current.data.teams[0]?.health.status).toBe("warning");
    });
    expect(teamClientMocks.subscribeToTeamBuilderTeams).toHaveBeenCalledOnce();
    expect(teamClientMocks.listTeamBuilderTeams).toHaveBeenCalledOnce();

    act(() => publishCatalogInvalidation());

    await waitFor(() => {
      expect(result.current.data.teams[0]?.health.status).toBe("ok");
    });
    expect(teamClientMocks.listTeamBuilderTeams).toHaveBeenCalledTimes(2);

    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("asks for system agents, because Create is where their persona is edited", async () => {
    // The Run picker uses the default catalog and must not offer the front
    // door. Create uses this one and must, or the General Agent's persona is
    // editable only by editing the repository.
    const { unmount } = renderHook(() => useCreateSidebar("create"));

    await waitFor(() => {
      expect(agentClientMocks.listAgents).toHaveBeenCalledWith({
        includeSystem: true,
      });
    });

    unmount();
  });
});
