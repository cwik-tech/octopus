import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import type { SharedFolderStatus, SharedFolderView } from "@contracts/shared-folders";
import { ProjectSharedFolders } from "@/components/library/project-shared-folders";
import type { FolderRefreshTimer } from "@/lib/clients/shared-folders-client";

/**
 * The Library project page's Shared folders card
 * (docs/feature-local-folder-access.md, "Library: Shared folders card", Flow A).
 *
 * Only the two outside boundaries are replaced: the network, with a small
 * in-memory project folder API, and the Electron picker on `window.pipeline`.
 * Granting, admission and persistence are covered by the backend tests.
 *
 * The Library can show another project in the same card, or in a new one,
 * while a request is under way. The race tests hold a response at the network
 * boundary and release it once the card shows another project.
 *
 * While a folder is indexing the card reads its list again on a schedule. The
 * tests run that schedule on a timer of their own, so time passes only when a
 * test says so.
 */

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "55555555-5555-4555-8555-555555555555";

const EMPTY_STATE = "No folders yet. Add a folder to let this project's chats search and read it.";

type FolderMethod = "GET" | "POST" | "DELETE";

interface Failure {
  status: number;
  error: string;
  code: string;
}

const SERVER_FAILURE: Failure = { status: 500, error: "Folder request failed.", code: "internal_shared_folder_error" };

/** A folder a project has before the test starts, with the status the server reports for it. */
interface SeedFolder {
  path: string;
  status: SharedFolderStatus;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface HeldResponse {
  /** Resolves when the request reaches the server. */
  arrived: Promise<void>;
  /** Waits inside `act` until the request reaches the server. */
  reached: () => Promise<void>;
  /** Lets the response reach the card and returns once the card has handled it. */
  release: () => Promise<void>;
}

function fakeProjectFolderApi(options: {
  refuse?: Failure;
  /** Folders each project has before the test starts: a path alone has no status. */
  seed?: Record<string, Array<string | SeedFolder>>;
} = {}) {
  const projects = new Map<string, SharedFolderView[]>();
  const issued = new Map<string, number>();
  const held: Array<{
    method: FolderMethod;
    projectId: string;
    arrived: () => void;
    gate: Promise<void>;
    applyOnRelease: boolean;
    failWith: Failure | undefined;
  }> = [];
  const calls: Array<{ method: string; url: string; body?: string }> = [];

  const foldersOf = (projectId: string): SharedFolderView[] => {
    const existing = projects.get(projectId);
    if (existing) return existing;
    const created: SharedFolderView[] = [];
    projects.set(projectId, created);
    return created;
  };
  // Folder IDs are unique within one project only, so each project's first folder is f_0000000000.
  // Like the session route, adding a path the project already has returns the existing folder.
  const attach = (
    projectId: string,
    folderPath: string,
    status?: SharedFolderStatus,
  ): { folder: SharedFolderView; created: boolean } => {
    const existing = foldersOf(projectId).find((folder) => folder.path === folderPath);
    if (existing) return { folder: existing, created: false };
    const count = issued.get(projectId) ?? 0;
    issued.set(projectId, count + 1);
    const folder: SharedFolderView = {
      id: `f_${String(count).padStart(10, "0")}`,
      label: folderPath.split("/").pop() ?? folderPath,
      path: folderPath,
      source: "project",
      addedAt: "2026-10-08T10:00:00.000Z",
      projectId,
      projectName: "Acme launch",
      ...(status === undefined ? {} : { status }),
    };
    foldersOf(projectId).push(folder);
    return { folder, created: true };
  };
  for (const [projectId, seeded] of Object.entries(options.seed ?? {})) {
    for (const entry of seeded) {
      if (typeof entry === "string") attach(projectId, entry);
      else attach(projectId, entry.path, entry.status);
    }
  }

  const respond = (method: string, projectId: string, folderId: string | undefined, body: string | undefined): Response => {
    const folders = foldersOf(projectId);
    if (method === "GET" && folderId === undefined) return Response.json({ folders: [...folders] });
    if (method === "POST" && folderId === undefined) {
      if (options.refuse) return Response.json(options.refuse, { status: options.refuse.status });
      const parsed: unknown = JSON.parse(body ?? "{}");
      const folderPath = typeof parsed === "object" && parsed !== null && "path" in parsed && typeof parsed.path === "string" ? parsed.path : "";
      const attached = attach(projectId, folderPath);
      return Response.json(attached.folder, { status: attached.created ? 201 : 200 });
    }
    if (method === "DELETE" && folderId !== undefined) {
      const index = folders.findIndex((folder) => folder.id === folderId);
      if (index === -1) return Response.json({ error: "Folder not found.", code: "shared_folder_not_found" }, { status: 404 });
      folders.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return new Response("{}", { status: 405 });
  };

  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, url, ...(body === undefined ? {} : { body }) });
    const match = /\/projects\/([^/]+)\/folders(?:\/([^/]+))?$/.exec(url);
    const encodedProjectId = match?.[1];
    if (encodedProjectId === undefined) return new Response("{}", { status: 404 });
    const projectId = decodeURIComponent(encodedProjectId);
    const encodedFolderId = match?.[2];
    const index = held.findIndex((entry) => entry.method === method && entry.projectId === projectId);
    const hold = index === -1 ? undefined : held.splice(index, 1)[0];
    const answer = (): Response => hold?.failWith
      ? Response.json(hold.failWith, { status: hold.failWith.status })
      : respond(method, projectId, encodedFolderId === undefined ? undefined : decodeURIComponent(encodedFolderId), body);
    if (!hold) return answer();
    if (hold.applyOnRelease) {
      hold.arrived();
      await hold.gate;
      return answer();
    }
    // By default the server applies a request as it arrives; only the response reaches the card later.
    const response = answer();
    hold.arrived();
    await hold.gate;
    return response;
  }));

  return {
    calls,
    pathsOf: (projectId: string): string[] => foldersOf(projectId).map((folder) => folder.path),
    /** How many times the project's folder list has been asked for. */
    reads: (projectId: string): number =>
      calls.filter((call) => call.method === "GET" && call.url === `/api/projects/${projectId}/folders`).length,
    /** Changes the status the server reports for one of the project's folders, as indexing does. */
    setStatus: (projectId: string, folderPath: string, status: SharedFolderStatus): void => {
      const folders = foldersOf(projectId);
      const index = folders.findIndex((folder) => folder.path === folderPath);
      const folder = folders[index];
      if (!folder) throw new Error(`Project ${projectId} has no folder ${folderPath}.`);
      folders[index] = { ...folder, status };
    },
    /**
     * Holds the response to one project's next request of this kind until the
     * test releases it. `applyOnRelease` also holds the server's change until
     * then; `failWith` answers with that failure instead.
     */
    hold(method: FolderMethod, projectId: string, holdOptions: { applyOnRelease?: boolean; failWith?: Failure } = {}): HeldResponse {
      const arrived = deferred();
      const gate = deferred();
      held.push({
        method,
        projectId,
        arrived: arrived.resolve,
        gate: gate.promise,
        applyOnRelease: holdOptions.applyOnRelease ?? false,
        failWith: holdOptions.failWith,
      });
      return {
        arrived: arrived.promise,
        reached: () => act(async () => {
          await arrived.promise;
        }),
        release: () => act(async () => {
          gate.resolve();
        }),
      };
    },
  };
}

type FakeApi = ReturnType<typeof fakeProjectFolderApi>;

/** Shows a project in a card of its own, as the Library does, and waits until its folder list has loaded. */
async function renderProject(
  api: FakeApi,
  projectId: string,
  active = true,
  refreshTimer?: FolderRefreshTimer,
): Promise<ReturnType<typeof render>> {
  const read = api.hold("GET", projectId);
  const view = render(<ProjectSharedFolders projectId={projectId} active={active} refreshTimer={refreshTimer} />);
  await read.reached();
  await read.release();
  return view;
}

/** Shows another project in the same card and waits until its folder list has loaded. */
async function showProject(
  api: FakeApi,
  view: ReturnType<typeof render>,
  projectId: string,
  refreshTimer?: FolderRefreshTimer,
): Promise<void> {
  const read = api.hold("GET", projectId);
  view.rerender(<ProjectSharedFolders projectId={projectId} active refreshTimer={refreshTimer} />);
  await read.reached();
  await read.release();
}

/**
 * The card's re-read timer, run by the test: time passes only when the test
 * says so, and a re-read runs once the time it waits for has passed.
 */
function manualTimer(): { timer: FolderRefreshTimer; advance: (ms: number) => Promise<void> } {
  let now = 0;
  const waiting = new Set<{ due: number; callback: () => void }>();
  return {
    timer: {
      schedule(callback, delayMs) {
        const entry = { due: now + delayMs, callback };
        waiting.add(entry);
        return () => {
          waiting.delete(entry);
        };
      },
    },
    /** Lets `ms` milliseconds pass and runs, inside `act`, every re-read due by then. */
    advance: (ms: number) => act(async () => {
      now += ms;
      const due = [...waiting].filter((entry) => entry.due <= now).sort((a, b) => a.due - b.due);
      for (const entry of due) {
        if (waiting.delete(entry)) entry.callback();
      }
    }),
  };
}

const AN_HOUR = 60 * 60_000;

/** The desktop picker, answering every request with `folderPath` (null is a cancelled picker). */
function installPicker(folderPath: string | null): ReturnType<typeof vi.fn<() => Promise<{ path: string } | null>>> {
  const selectSharedFolder = vi.fn(async () => (folderPath === null ? null : { path: folderPath }));
  window.pipeline = { selectBatchFolder: vi.fn(async () => null), selectSharedFolder };
  return selectSharedFolder;
}

function card(): HTMLElement {
  return screen.getByRole("region", { name: "Shared folders" });
}

/** The card's row for the folder labelled `label`. */
function row(label: string): HTMLElement {
  const item = within(card()).getAllByRole("listitem").find((entry) => within(entry).queryByText(label) !== null);
  if (!item) throw new Error(`The card has no row for ${label}.`);
  return item;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.pipeline;
});

test("the card lists each project folder with its label and path", async () => {
  const api = fakeProjectFolderApi({ seed: { [PROJECT_ID]: ["/Users/example/Contracts 2026", "/Users/example/Design/Brand assets"] } });
  installPicker(null);

  await renderProject(api, PROJECT_ID);

  expect(within(card()).getAllByRole("listitem")).toHaveLength(2);
  expect(within(card()).getByText("Contracts 2026")).toBeInTheDocument();
  expect(within(card()).getByText("/Users/example/Contracts 2026")).toBeInTheDocument();
  expect(within(card()).getByText("Brand assets")).toBeInTheDocument();
  expect(within(card()).getByText("/Users/example/Design/Brand assets")).toBeInTheDocument();
});

test("a project with no folders shows the empty state", async () => {
  const api = fakeProjectFolderApi();
  installPicker(null);

  await renderProject(api, PROJECT_ID);

  expect(within(card()).getByText(EMPTY_STATE)).toBeInTheDocument();
  expect(within(card()).queryByRole("listitem")).not.toBeInTheDocument();
});

test("Add folder opens the native picker and adds the chosen folder to the project", async () => {
  const api = fakeProjectFolderApi();
  const selectSharedFolder = installPicker("/Users/example/Contracts 2026");
  const user = userEvent.setup();
  await renderProject(api, PROJECT_ID);

  const attach = api.hold("POST", PROJECT_ID);
  await user.click(within(card()).getByRole("button", { name: "Add folder" }));
  await attach.reached();
  await attach.release();

  expect(selectSharedFolder).toHaveBeenCalledTimes(1);
  expect(api.calls).toContainEqual({
    method: "POST",
    url: `/api/projects/${PROJECT_ID}/folders`,
    body: JSON.stringify({ path: "/Users/example/Contracts 2026" }),
  });
  expect(api.pathsOf(PROJECT_ID)).toEqual(["/Users/example/Contracts 2026"]);
  expect(within(card()).getByText("Contracts 2026")).toBeInTheDocument();
  expect(within(card()).queryByText(EMPTY_STATE)).not.toBeInTheDocument();
});

test("a cancelled picker adds nothing", async () => {
  const api = fakeProjectFolderApi();
  const selectSharedFolder = installPicker(null);
  const user = userEvent.setup();
  await renderProject(api, PROJECT_ID);

  await user.click(within(card()).getByRole("button", { name: "Add folder" }));

  expect(selectSharedFolder).toHaveBeenCalledTimes(1);
  expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
  expect(within(card()).getByText(EMPTY_STATE)).toBeInTheDocument();
});

test("a folder the server refuses shows the server's reason and is not listed", async () => {
  const api = fakeProjectFolderApi({ refuse: { status: 409, error: "A project can have up to 10 folders.", code: "shared_folder_limit" } });
  installPicker("/Users/example/Eleventh folder");
  const user = userEvent.setup();
  await renderProject(api, PROJECT_ID);

  const refusal = api.hold("POST", PROJECT_ID);
  await user.click(within(card()).getByRole("button", { name: "Add folder" }));
  await refusal.reached();
  await refusal.release();

  expect(within(card()).getByRole("alert")).toHaveTextContent("A project can have up to 10 folders.");
  expect(within(card()).queryByText("Eleventh folder")).not.toBeInTheDocument();
});

test("a folder removed in the card is removed from the project", async () => {
  const api = fakeProjectFolderApi({ seed: { [PROJECT_ID]: ["/Users/example/Contracts 2026"] } });
  installPicker(null);
  const user = userEvent.setup();
  await renderProject(api, PROJECT_ID);

  const removal = api.hold("DELETE", PROJECT_ID);
  await user.click(within(card()).getByRole("button", { name: "Remove Contracts 2026" }));
  await removal.reached();
  await removal.release();

  expect(api.calls).toContainEqual({ method: "DELETE", url: `/api/projects/${PROJECT_ID}/folders/f_0000000000` });
  expect(api.pathsOf(PROJECT_ID)).toEqual([]);
  expect(within(card()).queryByText("Contracts 2026")).not.toBeInTheDocument();
  expect(within(card()).getByText(EMPTY_STATE)).toBeInTheDocument();
});

test("without the desktop picker Add folder is disabled and the card says why", async () => {
  const api = fakeProjectFolderApi();
  const user = userEvent.setup();
  await renderProject(api, PROJECT_ID);

  const addFolder = within(card()).getByRole("button", { name: "Add folder" });
  await user.click(addFolder);

  expect(addFolder).toBeDisabled();
  expect(addFolder).toHaveAccessibleDescription("Folders can be added only in the desktop app.");
  expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
});

test("in an archived project Add folder is disabled and the card says why", async () => {
  const api = fakeProjectFolderApi();
  const selectSharedFolder = installPicker("/Users/example/Contracts 2026");
  const user = userEvent.setup();
  await renderProject(api, PROJECT_ID, false);

  const addFolder = within(card()).getByRole("button", { name: "Add folder" });
  await user.click(addFolder);

  expect(addFolder).toBeDisabled();
  expect(addFolder).toHaveAccessibleDescription("Restore this project to change its folders.");
  expect(selectSharedFolder).not.toHaveBeenCalled();
  expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
});

test("in an archived project a folder can't be removed, and the card says why", async () => {
  const api = fakeProjectFolderApi({ seed: { [PROJECT_ID]: ["/Users/example/Contracts 2026"] } });
  installPicker(null);
  const user = userEvent.setup();
  await renderProject(api, PROJECT_ID, false);

  const remove = within(card()).getByRole("button", { name: "Remove Contracts 2026" });
  await user.click(remove);

  expect(remove).toBeDisabled();
  expect(remove).toHaveAccessibleDescription("Restore this project to change its folders.");
  expect(api.calls.filter((call) => call.method === "DELETE")).toEqual([]);
  expect(api.pathsOf(PROJECT_ID)).toEqual(["/Users/example/Contracts 2026"]);
});

test("adding a folder the project already has lists it once", async () => {
  const api = fakeProjectFolderApi({ seed: { [PROJECT_ID]: ["/Users/example/Contracts 2026"] } });
  installPicker("/Users/example/Contracts 2026");
  const user = userEvent.setup();
  await renderProject(api, PROJECT_ID);

  // Hold the read that follows the add, so only the add's own answer is on screen.
  const readAfterAdd = api.hold("GET", PROJECT_ID);
  await user.click(within(card()).getByRole("button", { name: "Add folder" }));
  await readAfterAdd.reached();

  expect(api.pathsOf(PROJECT_ID)).toEqual(["/Users/example/Contracts 2026"]);
  expect(within(card()).getAllByText("Contracts 2026")).toHaveLength(1);
  await readAfterAdd.release();
});

test("a folder list for the previous project that lands after the project changed is not shown", async () => {
  const api = fakeProjectFolderApi({ seed: { [PROJECT_ID]: ["/Users/example/Alpha files"] } });
  installPicker(null);
  const oldRead = api.hold("GET", PROJECT_ID);
  const view = render(<ProjectSharedFolders projectId={PROJECT_ID} active />);
  await oldRead.reached();

  await showProject(api, view, OTHER_PROJECT_ID);
  await oldRead.release();

  expect(within(card()).queryByText("Alpha files")).not.toBeInTheDocument();
  expect(within(card()).getByText(EMPTY_STATE)).toBeInTheDocument();
});

test("the previous project's folders are not shown while the next project's list loads", async () => {
  const api = fakeProjectFolderApi({ seed: { [PROJECT_ID]: ["/Users/example/Alpha files"] } });
  installPicker(null);
  const view = await renderProject(api, PROJECT_ID);
  expect(within(card()).getByText("Alpha files")).toBeInTheDocument();

  const newRead = api.hold("GET", OTHER_PROJECT_ID);
  view.rerender(<ProjectSharedFolders projectId={OTHER_PROJECT_ID} active />);
  await newRead.reached();

  expect(within(card()).queryByText("Alpha files")).not.toBeInTheDocument();
  await newRead.release();
});

test("an add that lands after the project changed is saved to its own project and not shown in the next one", async () => {
  const api = fakeProjectFolderApi();
  installPicker("/Users/example/Alpha files");
  const user = userEvent.setup();
  const view = await renderProject(api, PROJECT_ID);
  const attach = api.hold("POST", PROJECT_ID);
  await user.click(within(card()).getByRole("button", { name: "Add folder" }));
  await attach.reached();

  await showProject(api, view, OTHER_PROJECT_ID);
  await attach.release();

  expect(api.pathsOf(PROJECT_ID)).toEqual(["/Users/example/Alpha files"]);
  expect(api.pathsOf(OTHER_PROJECT_ID)).toEqual([]);
  expect(within(card()).queryByText("Alpha files")).not.toBeInTheDocument();
  expect(within(card()).getByText(EMPTY_STATE)).toBeInTheDocument();
});

test("a refusal that lands after the project changed shows no error in the next project", async () => {
  const api = fakeProjectFolderApi({ refuse: { status: 403, error: "This folder is part of the app's own data and can't be shared.", code: "protected_overlap" } });
  installPicker("/Users/example");
  const user = userEvent.setup();
  const view = await renderProject(api, PROJECT_ID);
  const refusal = api.hold("POST", PROJECT_ID);
  await user.click(within(card()).getByRole("button", { name: "Add folder" }));
  await refusal.reached();

  await showProject(api, view, OTHER_PROJECT_ID);
  await refusal.release();

  expect(within(card()).queryByRole("alert")).not.toBeInTheDocument();
});

test("an add still in flight for the previous project does not hold up Add folder in the next one", async () => {
  const api = fakeProjectFolderApi();
  installPicker("/Users/example/Alpha files");
  const user = userEvent.setup();
  const view = await renderProject(api, PROJECT_ID);
  const attach = api.hold("POST", PROJECT_ID);
  await user.click(within(card()).getByRole("button", { name: "Add folder" }));
  await attach.reached();
  expect(within(card()).getByRole("button", { name: "Add folder" })).toBeDisabled();

  await showProject(api, view, OTHER_PROJECT_ID);

  expect(within(card()).getByRole("button", { name: "Add folder" })).toBeEnabled();
  await attach.release();
  expect(within(card()).getByRole("button", { name: "Add folder" })).toBeEnabled();
});

test("a removal that lands after the project changed leaves the next project's folders alone", async () => {
  const api = fakeProjectFolderApi({
    seed: { [PROJECT_ID]: ["/Users/example/Alpha files"], [OTHER_PROJECT_ID]: ["/Users/example/Bravo notes"] },
  });
  installPicker(null);
  const user = userEvent.setup();
  const view = await renderProject(api, PROJECT_ID);
  const removal = api.hold("DELETE", PROJECT_ID);
  await user.click(within(card()).getByRole("button", { name: "Remove Alpha files" }));
  await removal.reached();

  await showProject(api, view, OTHER_PROJECT_ID);
  await removal.release();

  // Both projects' first folders are f_0000000000, so a removal applied to the shown list would hide Bravo notes.
  expect(api.pathsOf(PROJECT_ID)).toEqual([]);
  expect(within(card()).getByText("Bravo notes")).toBeInTheDocument();
});

test("an add the server applies after its project was left and shown again appears in that project", async () => {
  const api = fakeProjectFolderApi();
  installPicker("/Users/example/Alpha files");
  const user = userEvent.setup();
  const view = await renderProject(api, PROJECT_ID);
  const attach = api.hold("POST", PROJECT_ID, { applyOnRelease: true });
  await user.click(within(card()).getByRole("button", { name: "Add folder" }));
  await attach.reached();

  await showProject(api, view, OTHER_PROJECT_ID);
  await showProject(api, view, PROJECT_ID);
  expect(within(card()).getByText(EMPTY_STATE)).toBeInTheDocument();
  const readAfterAdd = api.hold("GET", PROJECT_ID);
  await attach.release();
  await readAfterAdd.reached();
  await readAfterAdd.release();

  expect(api.pathsOf(PROJECT_ID)).toEqual(["/Users/example/Alpha files"]);
  expect(within(card()).getByText("Alpha files")).toBeInTheDocument();
});

/*
 * Folder statuses (docs/feature-local-folder-access.md, "Status" and the
 * Library card sketch). The server sends a status on each folder once the
 * folder index exists; until then a row shows only its label and path.
 */

const INDEXING_BRAND_ASSETS: SeedFolder = {
  path: "/Users/example/Design/Brand assets",
  status: { state: "indexing", files: 88, pendingDocuments: 12 },
};

test("each folder shows how many files it has and whether it is ready, indexing or partial", async () => {
  const api = fakeProjectFolderApi({
    seed: {
      [PROJECT_ID]: [
        { path: "/Users/example/Contracts 2026", status: { state: "ready", files: 412 } },
        INDEXING_BRAND_ASSETS,
        { path: "/Users/example/Inbox", status: { state: "indexing" } },
        { path: "/Users/example/Archive", status: { state: "partial", files: 5000, limit: "2 GB of documents parsed" } },
      ],
    },
  });
  installPicker(null);

  await renderProject(api, PROJECT_ID, true, manualTimer().timer);

  expect(within(row("Contracts 2026")).getByText("412 files · Ready")).toBeInTheDocument();
  expect(within(row("Brand assets")).getByText("88 files · Indexing · 12 documents left")).toBeInTheDocument();
  expect(within(row("Inbox")).getByText("Indexing")).toBeInTheDocument();
  expect(within(row("Archive")).getByText("5,000 files · Partial: 2 GB of documents parsed")).toBeInTheDocument();
});

test("a folder the agent can't reach says why", async () => {
  const api = fakeProjectFolderApi({
    seed: {
      [PROJECT_ID]: [
        { path: "/Users/example/Old research", status: { state: "unavailable", reason: "not_found" } },
        { path: "/Users/example/Payroll", status: { state: "unavailable", reason: "access_removed" } },
        { path: "/Users/example/Locked", status: { state: "unavailable", reason: "unreadable" } },
      ],
    },
  });
  installPicker(null);

  await renderProject(api, PROJECT_ID, true, manualTimer().timer);

  expect(within(row("Old research")).getByText("Folder not found")).toBeInTheDocument();
  expect(within(row("Payroll")).getByText("Access removed")).toBeInTheDocument();
  expect(within(row("Locked")).getByText("Can't read folder")).toBeInTheDocument();
});

test("a folder the server sends no status for shows only its label and path", async () => {
  const api = fakeProjectFolderApi({ seed: { [PROJECT_ID]: ["/Users/example/Contracts 2026"] } });
  installPicker(null);

  await renderProject(api, PROJECT_ID, true, manualTimer().timer);

  expect(row("Contracts 2026").textContent).toBe("Contracts 2026/Users/example/Contracts 2026");
});

test("while a folder is indexing, the card reads its list again 3 seconds after the last read and shows the new status", async () => {
  const api = fakeProjectFolderApi({ seed: { [PROJECT_ID]: [INDEXING_BRAND_ASSETS] } });
  installPicker(null);
  const clock = manualTimer();
  await renderProject(api, PROJECT_ID, true, clock.timer);
  api.setStatus(PROJECT_ID, INDEXING_BRAND_ASSETS.path, { state: "ready", files: 88 });

  const reread = api.hold("GET", PROJECT_ID);
  await clock.advance(2_999);
  expect(api.reads(PROJECT_ID)).toBe(1);
  await clock.advance(1);
  expect(api.reads(PROJECT_ID)).toBe(2);
  await reread.reached();
  await reread.release();

  expect(within(row("Brand assets")).getByText("88 files · Ready")).toBeInTheDocument();
});

test("the card stops reading its list again once no folder is indexing", async () => {
  const api = fakeProjectFolderApi({ seed: { [PROJECT_ID]: [INDEXING_BRAND_ASSETS] } });
  installPicker(null);
  const clock = manualTimer();
  await renderProject(api, PROJECT_ID, true, clock.timer);
  api.setStatus(PROJECT_ID, INDEXING_BRAND_ASSETS.path, { state: "ready", files: 88 });
  const reread = api.hold("GET", PROJECT_ID);
  await clock.advance(3_000);
  expect(api.reads(PROJECT_ID)).toBe(2);
  await reread.reached();
  await reread.release();
  expect(within(row("Brand assets")).getByText("88 files · Ready")).toBeInTheDocument();

  await clock.advance(AN_HOUR);

  expect(api.reads(PROJECT_ID)).toBe(2);
});

test("while a re-read is in flight the card starts no other, however long it takes", async () => {
  const api = fakeProjectFolderApi({ seed: { [PROJECT_ID]: [INDEXING_BRAND_ASSETS] } });
  installPicker(null);
  const clock = manualTimer();
  await renderProject(api, PROJECT_ID, true, clock.timer);
  const reread = api.hold("GET", PROJECT_ID);
  await clock.advance(3_000);
  expect(api.reads(PROJECT_ID)).toBe(2);

  await clock.advance(AN_HOUR);
  expect(api.reads(PROJECT_ID)).toBe(2);
  await reread.reached();
  await reread.release();

  // The folder is still indexing, so the next re-read follows 3 seconds after this one landed.
  await clock.advance(3_000);
  expect(api.reads(PROJECT_ID)).toBe(3);
});

test("a re-read that fails while a folder is indexing is tried again on the same schedule", async () => {
  const api = fakeProjectFolderApi({ seed: { [PROJECT_ID]: [INDEXING_BRAND_ASSETS] } });
  installPicker(null);
  const clock = manualTimer();
  await renderProject(api, PROJECT_ID, true, clock.timer);
  const failed = api.hold("GET", PROJECT_ID, { failWith: SERVER_FAILURE });
  await clock.advance(3_000);
  expect(api.reads(PROJECT_ID)).toBe(2);
  await failed.reached();
  await failed.release();
  expect(within(card()).getByRole("alert")).toHaveTextContent("Folder request failed.");

  api.setStatus(PROJECT_ID, INDEXING_BRAND_ASSETS.path, { state: "ready", files: 88 });
  const retry = api.hold("GET", PROJECT_ID);
  await clock.advance(3_000);
  expect(api.reads(PROJECT_ID)).toBe(3);
  await retry.reached();
  await retry.release();

  expect(within(row("Brand assets")).getByText("88 files · Ready")).toBeInTheDocument();
  expect(within(card()).queryByRole("alert")).not.toBeInTheDocument();
});

test("a card that has left the screen reads its list no more", async () => {
  const api = fakeProjectFolderApi({ seed: { [PROJECT_ID]: [INDEXING_BRAND_ASSETS] } });
  installPicker(null);
  const clock = manualTimer();
  const view = await renderProject(api, PROJECT_ID, true, clock.timer);

  view.unmount();
  await clock.advance(AN_HOUR);

  expect(api.reads(PROJECT_ID)).toBe(1);
});

test("once the card shows another project, the previous project's list is read no more", async () => {
  const api = fakeProjectFolderApi({ seed: { [PROJECT_ID]: [INDEXING_BRAND_ASSETS] } });
  installPicker(null);
  const clock = manualTimer();
  const view = await renderProject(api, PROJECT_ID, true, clock.timer);

  await showProject(api, view, OTHER_PROJECT_ID, clock.timer);
  await clock.advance(AN_HOUR);

  expect(api.reads(PROJECT_ID)).toBe(1);
  expect(within(card()).getByText(EMPTY_STATE)).toBeInTheDocument();
});

test("an add while a re-read is waiting leaves the card reading on one schedule", async () => {
  const api = fakeProjectFolderApi({ seed: { [PROJECT_ID]: [INDEXING_BRAND_ASSETS] } });
  installPicker("/Users/example/Contracts 2026");
  const user = userEvent.setup();
  const clock = manualTimer();
  await renderProject(api, PROJECT_ID, true, clock.timer);

  // The add reads the list again, which restarts the wait for the next re-read.
  const readAfterAdd = api.hold("GET", PROJECT_ID);
  await user.click(within(card()).getByRole("button", { name: "Add folder" }));
  await readAfterAdd.reached();
  await readAfterAdd.release();
  expect(api.reads(PROJECT_ID)).toBe(2);

  await clock.advance(3_000);

  expect(api.reads(PROJECT_ID)).toBe(3);
});

test("clicking a project folder's name opens it in the file manager", async () => {
  const api = fakeProjectFolderApi({ seed: { [PROJECT_ID]: ["/Users/example/Contracts 2026"] } });
  const openSharedFolder = vi.fn(async () => ({ opened: true as const }));
  window.pipeline = {
    selectBatchFolder: vi.fn(async () => null),
    selectSharedFolder: vi.fn(async () => null),
    openSharedFolder,
  };
  const user = userEvent.setup();
  await renderProject(api, PROJECT_ID);

  await user.click(within(row("Contracts 2026")).getByRole("button", { name: /^Show Contracts 2026 in / }));

  expect(openSharedFolder.mock.calls).toEqual([["/Users/example/Contracts 2026"]]);
});
