import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCreateWorkspaceController } from "@/hooks/use-create-workspace-controller";
import { clearResourceArchitectConversation } from "@/lib/clients/resource-architect-conversation-client";

vi.mock("@/lib/clients/resource-architect-conversation-client", () => ({
  clearResourceArchitectConversation: vi.fn(),
}));

vi.mock("@/hooks/use-create-sidebar", () => ({
  useCreateSidebar: () => ({
    data: { agents: [], teams: [], workflows: [] },
    loading: false,
    error: null,
    setData: vi.fn(),
    setError: vi.fn(),
    refresh: vi.fn(),
    handleResourcesChanged: vi.fn(),
  }),
}));

describe("useCreateWorkspaceController", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(["", "1"])("opens Create on Teams with workflow flag %s", (flag) => {
    vi.stubEnv("VITE_ENABLE_WORKFLOWS", flag);
    const { result } = renderHook(() =>
      useCreateWorkspaceController({
        activeTab: "create",
        setActiveTab: vi.fn(),
      }),
    );

    expect(result.current.createTab).toBe("teams");
  });

  it("keeps one typed resource selection and synchronizes its sidebar tab", () => {
    const { result } = renderHook(() =>
      useCreateWorkspaceController({
        activeTab: "create",
        setActiveTab: vi.fn(),
      }),
    );

    act(() => result.current.selectAgent("scoping-lawyer"));
    expect(result.current.resourceSelection).toMatchObject({
      kind: "agent",
      id: "scoping-lawyer",
    });
    expect(result.current.createTab).toBe("agents");
    expect(result.current.teamSelectionRequest).toBeNull();

    act(() => result.current.selectTeam("legal-review-team"));
    expect(result.current.resourceSelection).toMatchObject({
      kind: "team",
      id: "legal-review-team",
    });
    expect(result.current.createTab).toBe("teams");
    expect(result.current.agentSelectionRequest).toBeNull();
  });

  it("keeps details minimized when selecting a Team after an Agent", () => {
    const { result } = renderHook(() =>
      useCreateWorkspaceController({
        activeTab: "create",
        setActiveTab: vi.fn(),
      }),
    );

    act(() => result.current.selectAgent("scoping-lawyer"));
    act(() => result.current.setInspectorOpen(false));
    act(() => result.current.selectTeam("legal-review-team"));

    expect(result.current.resourceSelection).toMatchObject({
      kind: "team",
      id: "legal-review-team",
    });
    expect(result.current.createTab).toBe("teams");
    expect(result.current.inspectorOpen).toBe(false);
  });

  it("exposes a single create tab that switches between workflow and resource workspaces", () => {
    const { result } = renderHook(() =>
      useCreateWorkspaceController({
        activeTab: "create",
        setActiveTab: vi.fn(),
      }),
    );

    expect(result.current.createTab).toBe("teams");

    act(() => result.current.changeCreateTab("teams"));
    expect(result.current.createTab).toBe("teams");

    act(() => result.current.changeCreateTab("agents"));
    expect(result.current.createTab).toBe("agents");

    act(() => result.current.changeCreateTab("workflows"));
    expect(result.current.createTab).toBe("workflows");
  });

  it("preserves the resource selection when leaving and re-entering its tab", () => {
    const { result } = renderHook(() =>
      useCreateWorkspaceController({
        activeTab: "create",
        setActiveTab: vi.fn(),
      }),
    );

    act(() => result.current.selectTeam("legal-review-team"));
    act(() => result.current.changeCreateTab("workflows"));
    expect(result.current.teamSelectionRequest).toMatchObject({
      id: "legal-review-team",
    });

    act(() => result.current.changeCreateTab("teams"));
    expect(result.current.teamSelectionRequest).toMatchObject({
      id: "legal-review-team",
    });
  });

  it("re-issues the workflow selection request when returning to a selected workflow", () => {
    const { result } = renderHook(() =>
      useCreateWorkspaceController({
        activeTab: "create",
        setActiveTab: vi.fn(),
      }),
    );

    act(() => result.current.selectWorkflow("deep-research"));
    const firstRequest = result.current.workflowSelectionRequest;
    expect(firstRequest).toMatchObject({ id: "deep-research" });

    act(() => result.current.changeCreateTab("agents"));
    expect(result.current.workflowSelectionRequest).toBeNull();

    act(() => result.current.changeCreateTab("workflows"));
    expect(result.current.workflowSelectionRequest).toMatchObject({
      id: "deep-research",
    });
    expect(result.current.workflowSelectionRequest?.requestId).not.toBe(
      firstRequest?.requestId,
    );
  });

  it("keeps selection request identity stable across unrelated re-renders", () => {
    const { result, rerender } = renderHook(() =>
      useCreateWorkspaceController({
        activeTab: "create",
        setActiveTab: vi.fn(),
      }),
    );

    act(() => result.current.selectAgent("scoping-lawyer"));
    const agentRequest = result.current.agentSelectionRequest;
    expect(agentRequest).not.toBeNull();

    rerender();
    act(() => result.current.setInspectorOpen(false));
    act(() => result.current.setInspectorOpen(true));

    expect(result.current.agentSelectionRequest).toBe(agentRequest);

    act(() => result.current.selectTeam("legal-review-team"));
    const teamRequest = result.current.teamSelectionRequest;
    expect(teamRequest).not.toBeNull();

    rerender();
    act(() => result.current.setInspectorOpen(false));
    act(() => result.current.setInspectorOpen(true));

    expect(result.current.teamSelectionRequest).toBe(teamRequest);
  });

  it("blocks leaving the Workflows tab while the workflow draft is dirty", () => {
    const { result } = renderHook(() =>
      useCreateWorkspaceController({
        activeTab: "create",
        setActiveTab: vi.fn(),
      }),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    act(() => result.current.changeCreateTab("workflows"));
    act(() => result.current.setIsWorkflowDraftDirty(true));
    act(() => result.current.changeCreateTab("teams"));
    expect(result.current.createTab).toBe("workflows");
    expect(confirm).toHaveBeenCalled();

    confirm.mockReturnValue(true);
    act(() => result.current.changeCreateTab("teams"));
    expect(result.current.createTab).toBe("teams");
  });

  // The remounted Create restores from the server at once, so New must not
  // remount it until the saved conversation is gone. The hook test pairs with
  // this one: it proves a remount over a failed build then stays empty.
  it("New waits for the saved Agent Architect conversation to be cleared before remounting Create", async () => {
    let finishClear = (): void => {};
    const clearing = new Promise<void>((resolve) => {
      finishClear = resolve;
    });
    vi.mocked(clearResourceArchitectConversation).mockReturnValue(clearing);
    const { result } = renderHook(() =>
      useCreateWorkspaceController({
        activeTab: "create",
        setActiveTab: vi.fn(),
      }),
    );
    act(() => result.current.changeCreateTab("agents"));
    const before = result.current.workspaceKey;

    act(() => result.current.createNewItem());
    expect(clearResourceArchitectConversation).toHaveBeenCalledOnce();
    expect(result.current.workspaceKey).toBe(before);

    await act(async () => {
      finishClear();
      await clearing;
    });
    expect(result.current.workspaceKey).toBe(before + 1);
  });
});
