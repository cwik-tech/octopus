/**
 * Deleting a Team from the Create sidebar names the version of the row the
 * person confirmed.
 *
 * Nothing in the app is mocked. The real sidebar hooks and components run,
 * wired as `App.tsx` wires them (the list, the delete request, the
 * confirmation dialog), against a loopback HTTP server that keeps the
 * backend's revision rule. Each test observes what reached the network and
 * what the sidebar shows. The rest of the app shell is left to the
 * renderer-to-API journey.
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  REVISION_CONFLICT_REASON,
  startTeamBuilderApiServer,
  type RecordedRequest,
  type TeamBuilderApiServer,
} from "@/components/create/team-architect/__tests__/team-builder-api-server";

const TEAM = "furniture-makers";

let api: TeamBuilderApiServer;
let modules: {
  useCreateSidebar: typeof import("@/hooks/use-create-sidebar").useCreateSidebar;
  useSidebarDeletion: typeof import("@/hooks/use-sidebar-deletion").useSidebarDeletion;
  CreateResourcesSidebar: typeof import("@/components/sidebar/create-resources-sidebar").CreateResourcesSidebar;
  SidebarDeleteDialog: typeof import("@/components/sidebar/sidebar-delete-dialog").SidebarDeleteDialog;
  TooltipProvider: typeof import("@/components/ui/tooltip").TooltipProvider;
};

beforeAll(async () => {
  api = await startTeamBuilderApiServer();
  // The clients read their API base once, when they are first loaded, so the
  // sidebar is imported only after the server's address is known.
  sessionStorage.setItem("pipeline.desktop-api-base-url", api.baseUrl);
  modules = {
    useCreateSidebar: (await import("@/hooks/use-create-sidebar")).useCreateSidebar,
    useSidebarDeletion: (await import("@/hooks/use-sidebar-deletion")).useSidebarDeletion,
    CreateResourcesSidebar: (await import("@/components/sidebar/create-resources-sidebar"))
      .CreateResourcesSidebar,
    SidebarDeleteDialog: (await import("@/components/sidebar/sidebar-delete-dialog"))
      .SidebarDeleteDialog,
    TooltipProvider: (await import("@/components/ui/tooltip")).TooltipProvider,
  };
});

afterAll(async () => {
  await api.close();
  sessionStorage.clear();
});

afterEach(() => cleanup());

const ignore = (): void => undefined;

/** The Create sidebar's Teams list and its delete confirmation, as App wires them. */
function TeamsSidebar() {
  const { useCreateSidebar, useSidebarDeletion, CreateResourcesSidebar, SidebarDeleteDialog, TooltipProvider } =
    modules;
  const sidebar = useCreateSidebar("create");
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const deletion = useSidebarDeletion({
    selectedSidebarSessionId: null,
    selectedCreateWorkflowId: null,
    selectedCreateTeamId: selectedTeamId,
    selectedCreateAgentName: null,
    setSidebarSessions: ignore,
    setSidebarSessionsError: ignore,
    setSelectedSidebarSessionId: ignore,
    setRunSessionSelectionRequest: ignore,
    setRunSessionDeletionRequest: ignore,
    setCreateSidebarData: sidebar.setData,
    setCreateSidebarError: sidebar.setError,
    setSelectedCreateWorkflowId: ignore,
    setWorkflowSelectionRequest: ignore,
    setSelectedCreateTeamId: setSelectedTeamId,
    setTeamSelectionRequest: ignore,
    setSelectedCreateAgentName: ignore,
    setCreateAgentSelectionRequest: ignore,
    setCreateInspectorOpen: ignore,
  });
  return (
    <TooltipProvider>
      <CreateResourcesSidebar
        createData={sidebar.data}
        createError={sidebar.error}
        createLoading={sidebar.loading}
        createTab="teams"
        deletingSidebarItem={deletion.deletingSidebarItem}
        selectedCreateWorkflowId={null}
        selectedCreateTeamId={selectedTeamId}
        selectedCreateAgentName={null}
        onWorkflowSelect={ignore}
        onTeamSelect={setSelectedTeamId}
        onAgentSelect={ignore}
        onDelete={deletion.requestSidebarDelete}
      />
      <SidebarDeleteDialog
        target={deletion.pendingSidebarDelete}
        deleting={
          deletion.pendingSidebarDelete !== null &&
          deletion.deletingSidebarItem === deletion.pendingSidebarDelete.id
        }
        error={deletion.sidebarDeleteError}
        onOpenChange={(open) => {
          if (!open && !deletion.deletingSidebarItem) {
            deletion.setPendingSidebarDelete(null);
            deletion.setSidebarDeleteError(null);
          }
        }}
        onConfirm={(neverAskAgain) => {
          if (deletion.pendingSidebarDelete) {
            void deletion.deleteSidebarItem(deletion.pendingSidebarDelete, neverAskAgain);
          }
        }}
      />
    </TooltipProvider>
  );
}

function requestsFor(method: string, path: string): RecordedRequest[] {
  return api.requests.filter((request) => request.method === method && request.path === path);
}

/** Opens the delete confirmation for a Team row, as the person does. */
async function confirmDeleteOf(label: string) {
  await userEvent.click(await screen.findByRole("button", { name: `Delete ${label}` }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Yes, delete" }));
  return dialog;
}

describe("deleting a Team from the sidebar", () => {
  beforeEach(() => {
    api.reset(
      [
        { id: TEAM, name: "Furniture Makers", description: "Makes furniture.", members: [] },
        {
          id: "unreadable-team",
          name: "Unreadable Team",
          description: "Its file cannot be read.",
          members: [],
          unreadable: true,
        },
      ],
      [],
    );
  });

  it("names the revision of the row the person confirmed, encoded, and reads nothing first", async () => {
    render(<TeamsSidebar />);
    await screen.findByRole("button", { name: "Delete Furniture Makers" });
    const shownRevision = api.team(TEAM)?.revision;

    await confirmDeleteOf("Furniture Makers");

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Delete Furniture Makers" })).not.toBeInTheDocument(),
    );
    const [deletion] = requestsFor("DELETE", `/create/team-builder/teams/${TEAM}`);
    expect(deletion?.query.get("expectedRevision")).toBe(shownRevision);
    expect(deletion?.rawPathAndQuery).toContain(
      `expectedRevision=${encodeURIComponent(shownRevision ?? "")}`,
    );
    // The revision came with the row: the team itself was never read.
    expect(requestsFor("GET", `/create/team-builder/teams/${TEAM}`)).toHaveLength(0);
    expect(api.team(TEAM)).toBeUndefined();
  });

  it("refuses a stale row's delete for as long as that confirmation is open, and deletes only after the person confirms the updated row", async () => {
    render(<TeamsSidebar />);
    await screen.findByRole("button", { name: "Delete Furniture Makers" });
    const confirmedRevision = api.team(TEAM)?.revision;
    // Someone else changes the team after the list was read.
    api.changeElsewhere(TEAM, { name: "Furniture Workshop" });
    const currentRevision = api.team(TEAM)?.revision;
    const listReadsBefore = requestsFor("GET", "/create/team-builder/teams").length;
    // The list read the refusal causes is held, so a redrawn row seen before it
    // is released can only have come from the refusal itself.
    const reload = api.holdNext("GET");

    const dialog = await confirmDeleteOf("Furniture Makers");

    expect(await within(dialog).findByText(REVISION_CONFLICT_REASON)).toBeInTheDocument();
    // The row is redrawn behind the confirmation, which keeps the rest of the
    // page inert while it is open, so the query includes hidden elements.
    expect(
      await screen.findByRole("button", { name: "Delete Furniture Workshop", hidden: true }),
    ).toBeInTheDocument();
    expect(api.team(TEAM)).toBeDefined();
    // The refusal proved the list stale, so it is read again for everyone.
    await waitFor(() =>
      expect(requestsFor("GET", "/create/team-builder/teams").length).toBeGreaterThan(listReadsBefore),
    );
    await act(async () => {
      reload.release();
      await reload.answered;
    });

    // The confirmation still names the row the person confirmed, so saying
    // yes again sends that row's revision and is refused again.
    await userEvent.click(within(dialog).getByRole("button", { name: "Yes, delete" }));
    await waitFor(() =>
      expect(requestsFor("DELETE", `/create/team-builder/teams/${TEAM}`)).toHaveLength(2),
    );
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Yes, delete" })).toBeEnabled(),
    );
    expect(within(dialog).getByText(REVISION_CONFLICT_REASON)).toBeInTheDocument();
    expect(api.team(TEAM)).toBeDefined();

    // Only a new confirmation, started from the updated row on screen, names
    // the current revision.
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const renewed = await confirmDeleteOf("Furniture Workshop");
    expect(renewed).toHaveTextContent("Furniture Workshop");

    await waitFor(() => expect(api.team(TEAM)).toBeUndefined());
    const deletions = requestsFor("DELETE", `/create/team-builder/teams/${TEAM}`);
    expect(deletions.map((deletion) => deletion.query.get("expectedRevision"))).toEqual([
      confirmedRevision,
      confirmedRevision,
      currentRevision,
    ]);
    expect(requestsFor("GET", `/create/team-builder/teams/${TEAM}`)).toHaveLength(0);
  });

  it("deletes a Team whose row carries no revision without one", async () => {
    render(<TeamsSidebar />);

    await confirmDeleteOf("Unreadable Team");

    await waitFor(() => expect(api.team("unreadable-team")).toBeUndefined());
    const [deletion] = requestsFor("DELETE", "/create/team-builder/teams/unreadable-team");
    expect(deletion?.query.has("expectedRevision")).toBe(false);
  });
});
