import { render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { SharedFolderView } from "@contracts/shared-folders";
import { ProjectContextDetails } from "@/components/library/project-context-details";
import type { WorkspaceProjectSummary } from "@/lib/models/session-model";

/**
 * The project page's context cards. The Shared folders card reads the
 * project's folders from `/projects/:id/folders`
 * (docs/feature-local-folder-access.md, "Library: Shared folders card").
 * Only the network and the Electron picker are replaced.
 */

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function makeProject(overrides: Partial<WorkspaceProjectSummary> = {}): WorkspaceProjectSummary {
  return {
    version: 1,
    id: PROJECT_ID,
    name: "Acme launch",
    status: "active",
    createdAt: "2026-08-04T09:00:00.000Z",
    updatedAt: "2026-08-04T11:00:00.000Z",
    sessionCount: 1,
    activeSessionCount: 0,
    ...overrides,
  };
}

function makeFolder(overrides: Partial<SharedFolderView> = {}): SharedFolderView {
  return {
    id: "f_0000000000",
    label: "Contracts 2026",
    path: "/Users/example/Contracts 2026",
    source: "project",
    addedAt: "2026-10-08T10:00:00.000Z",
    projectId: PROJECT_ID,
    projectName: "Acme launch",
    ...overrides,
  };
}

/** The project folder API, answering every list with `folders`. */
function serveProjectFolders(folders: SharedFolderView[]): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchStub = vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `/api/projects/${PROJECT_ID}/folders`) return Response.json({ folders });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

function renderDetails(project: WorkspaceProjectSummary): void {
  render(
    <ProjectContextDetails
      project={project}
      uploadRequest={0}
      initialBrief={{ content: "", updatedAt: "2026-08-04T11:00:00.000Z" }}
      initialFiles={[]}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.pipeline;
});

test("the project page lists the folders the project shares", async () => {
  serveProjectFolders([makeFolder()]);
  window.pipeline = { selectBatchFolder: vi.fn(async () => null), selectSharedFolder: vi.fn(async () => null) };

  renderDetails(makeProject());

  const card = screen.getByRole("region", { name: "Shared folders" });
  expect(await within(card).findByText("Contracts 2026")).toBeInTheDocument();
  expect(within(card).getByText("/Users/example/Contracts 2026")).toBeInTheDocument();
});

test("an archived project's page does not offer to add a folder", async () => {
  serveProjectFolders([]);
  const selectSharedFolder = vi.fn(async () => ({ path: "/Users/example/Contracts 2026" }));
  window.pipeline = { selectBatchFolder: vi.fn(async () => null), selectSharedFolder };

  renderDetails(makeProject({ status: "archived", archivedAt: "2026-08-05T09:00:00.000Z" }));

  const card = screen.getByRole("region", { name: "Shared folders" });
  const addFolder = within(card).getByRole("button", { name: "Add folder" });
  expect(addFolder).toBeDisabled();
  expect(addFolder).toHaveAccessibleDescription("Restore this project to change its folders.");
  expect(await within(card).findByText("No folders yet. Add a folder to let this project's chats search and read it.")).toBeInTheDocument();
});
