import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

import type { SharedFolderStatus, SharedFolderView } from "@contracts/shared-folders";
import { ChatFolderButton } from "@/components/run/chat/chat-folder-button";
import type { FolderRefreshTimer } from "@/lib/clients/shared-folders-client";

/**
 * The chat header's folder control (docs/feature-local-folder-access.md,
 * "Run: chat header button").
 *
 * Only the two outside boundaries are replaced: the network, with a small
 * in-memory folder API, and the Electron picker on `window.pipeline`. Real
 * attaching, granting and persistence are covered by the backend integration
 * tests and the Electron journey.
 *
 * The run panel mounts a new button for each chat, and a button can also be
 * given another chat. Either way a response can land after its chat is gone.
 * The race tests hold a response at the network boundary and release it once
 * the button shows another chat.
 *
 * While a folder is indexing the button reads its chat's list again on a
 * schedule. The tests run that schedule on a timer of their own, so time
 * passes only when a test says so.
 */

const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const SAVED_SESSION_ID = "44444444-4444-4444-8444-444444444444";

type FolderMethod = "GET" | "POST" | "DELETE";

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
  /**
   * Waits inside `act` until the request reaches the server, so whatever the
   * button rendered before sending it is committed.
   */
  reached: () => Promise<void>;
  /**
   * Lets the response reach the button and returns once the button has
   * handled it. `act` resolves only after a task boundary, and the button
   * handles a response in promise steps with no timers, so by then it has
   * finished and React has committed what it rendered.
   */
  release: () => Promise<void>;
}

interface Failure {
  status: number;
  error: string;
  code: string;
}

const SERVER_FAILURE: Failure = { status: 500, error: "Folder request failed.", code: "internal_shared_folder_error" };

function fakeFolderApi(options: {
  refuse?: Failure;
  /** Folder paths each chat has before the test starts. */
  seed?: Record<string, string[]>;
  /** Chats the server has not created yet, as a new chat is until it is first saved. */
  drafts?: string[];
  /** The project each chat belongs to, with the folder paths the project shares. */
  projects?: Record<string, { id: string; name: string; paths: string[] }>;
  /** The status the server reports for a folder, by path. A folder without one has no status. */
  statuses?: Record<string, SharedFolderStatus>;
} = {}) {
  const statuses = new Map(Object.entries(options.statuses ?? {}));
  const withStatus = (folder: SharedFolderView): SharedFolderView => {
    const status = statuses.get(folder.path);
    return status === undefined ? folder : { ...folder, status };
  };
  const chats = new Map<string, SharedFolderView[]>();
  const issued = new Map<string, number>();
  const drafts = new Set(options.drafts ?? []);
  const projectOf = new Map<string, { id: string; name: string; folders: SharedFolderView[] }>();
  const held: Array<{
    method: FolderMethod;
    sessionId: string;
    arrived: () => void;
    gate: Promise<void>;
    applyOnRelease: boolean;
    failWith: Failure | undefined;
  }> = [];
  const calls: Array<{ method: string; url: string; body?: string }> = [];

  const foldersOf = (sessionId: string): SharedFolderView[] => {
    const existing = chats.get(sessionId);
    if (existing) return existing;
    const created: SharedFolderView[] = [];
    chats.set(sessionId, created);
    return created;
  };
  // Folder IDs are unique within one chat only, so each chat's first folder is f_0000000000.
  // Like the real server, attaching a path the chat already has returns the existing folder.
  const attach = (sessionId: string, folderPath: string): { folder: SharedFolderView; created: boolean } => {
    const existing = foldersOf(sessionId).find((folder) => folder.path === folderPath);
    if (existing) return { folder: existing, created: false };
    const count = issued.get(sessionId) ?? 0;
    issued.set(sessionId, count + 1);
    const folder: SharedFolderView = {
      id: `f_${String(count).padStart(10, "0")}`,
      label: folderPath.split("/").pop() ?? folderPath,
      path: folderPath,
      source: "session",
      addedAt: "2026-10-07T10:00:00.000Z",
    };
    foldersOf(sessionId).push(folder);
    return { folder, created: true };
  };
  for (const [sessionId, paths] of Object.entries(options.seed ?? {})) {
    for (const folderPath of paths) attach(sessionId, folderPath);
  }
  // A project's folder IDs are drawn apart from its chats' own, so the first of each is f_0000000000.
  const shareWithProject = (sessionId: string, folderPath: string): void => {
    const project = projectOf.get(sessionId);
    if (!project) throw new Error(`Chat ${sessionId} is in no project.`);
    project.folders.push({
      id: `f_${String(project.folders.length).padStart(10, "0")}`,
      label: folderPath.split("/").pop() ?? folderPath,
      path: folderPath,
      source: "project",
      addedAt: "2026-10-08T10:00:00.000Z",
      projectId: project.id,
      projectName: project.name,
    });
  };
  for (const [sessionId, project] of Object.entries(options.projects ?? {})) {
    projectOf.set(sessionId, { id: project.id, name: project.name, folders: [] });
    for (const folderPath of project.paths) shareWithProject(sessionId, folderPath);
  }

  const respond = (method: string, sessionId: string, folderId: string | undefined, body: string | undefined): Response => {
    if (drafts.has(sessionId)) return Response.json({ error: "Session not found.", code: "session_not_found" }, { status: 404 });
    const folders = foldersOf(sessionId);
    const project = projectOf.get(sessionId);
    // Like the real server, a chat's list names its project's folders first, then its own.
    if (method === "GET" && folderId === undefined) {
      return Response.json({ folders: [...(project?.folders ?? []), ...folders].map(withStatus) });
    }
    if (method === "POST" && folderId === undefined) {
      if (options.refuse) return Response.json(options.refuse, { status: options.refuse.status });
      const parsed: unknown = JSON.parse(body ?? "{}");
      const folderPath = typeof parsed === "object" && parsed !== null && "path" in parsed && typeof parsed.path === "string" ? parsed.path : "";
      if (project?.folders.some((folder) => folder.path === folderPath)) {
        return Response.json(
          { error: `This folder is already shared with the project "${project.name}".`, code: "already_in_project" },
          { status: 409 },
        );
      }
      const attached = attach(sessionId, folderPath);
      return Response.json(withStatus(attached.folder), { status: attached.created ? 201 : 200 });
    }
    if (method === "DELETE" && folderId !== undefined) {
      const index = folders.findIndex((folder) => folder.id === folderId);
      if (index === -1) return new Response("{}", { status: 404 });
      folders.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return new Response("{}", { status: 405 });
  };

  const fetchStub = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, url, ...(body === undefined ? {} : { body }) });
    const match = /\/sessions\/([^/]+)\/folders(?:\/([^/]+))?$/.exec(url);
    const encodedSessionId = match?.[1];
    if (encodedSessionId === undefined) return new Response("{}", { status: 404 });
    const sessionId = decodeURIComponent(encodedSessionId);
    const encodedFolderId = match?.[2];
    const index = held.findIndex((entry) => entry.method === method && entry.sessionId === sessionId);
    const hold = index === -1 ? undefined : held.splice(index, 1)[0];
    const answer = (): Response => hold?.failWith
      ? Response.json(hold.failWith, { status: hold.failWith.status })
      : respond(method, sessionId, encodedFolderId === undefined ? undefined : decodeURIComponent(encodedFolderId), body);
    if (!hold) return answer();
    if (hold.applyOnRelease) {
      hold.arrived();
      await hold.gate;
      return answer();
    }
    // By default the server applies a request as it arrives; only the response reaches the button later.
    const response = answer();
    hold.arrived();
    await hold.gate;
    return response;
  });
  vi.stubGlobal("fetch", fetchStub);

  return {
    /** The first chat's folders as the server holds them. */
    folders: foldersOf(SESSION_ID),
    calls,
    pathsOf: (sessionId: string): string[] => foldersOf(sessionId).map((folder) => folder.path),
    /** How many times the chat's folder list has been asked for. */
    reads: (sessionId: string): number =>
      calls.filter((call) => call.method === "GET" && call.url === `/api/sessions/${sessionId}/folders`).length,
    /** Changes the status the server reports for a folder, as indexing does. */
    setStatus: (folderPath: string, status: SharedFolderStatus): void => {
      statuses.set(folderPath, status);
    },
    /** Shares a folder with the chat's project, as the Library does. */
    shareWithProject,
    /**
     * Moves the chat into a project that shares `paths`, or out of its project
     * with null, as the sidebar's Add to Project and Remove from project do on
     * the server before the chat is shown with its new project.
     */
    moveToProject: (sessionId: string, project: { id: string; name: string; paths: string[] } | null): void => {
      projectOf.delete(sessionId);
      if (!project) return;
      projectOf.set(sessionId, { id: project.id, name: project.name, folders: [] });
      for (const folderPath of project.paths) shareWithProject(sessionId, folderPath);
    },
    /** Saves a draft chat under the same ID, as the first message does. */
    create: (sessionId: string): void => {
      drafts.delete(sessionId);
    },
    /**
     * Holds the response to one chat's next request of this kind until the
     * test releases it. `applyOnRelease` also holds the server's change until
     * then; `failWith` answers with that failure instead.
     */
    hold(method: FolderMethod, sessionId: string, holdOptions: { applyOnRelease?: boolean; failWith?: Failure } = {}): HeldResponse {
      const arrived = deferred();
      const gate = deferred();
      held.push({
        method,
        sessionId,
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

/** Shows the first chat, in `projectId` if given, and waits until its folder list has loaded. */
async function renderChat(
  api: ReturnType<typeof fakeFolderApi>,
  sessionId: string,
  projectId?: string,
  refreshTimer?: FolderRefreshTimer,
): Promise<ReturnType<typeof render>> {
  const read = api.hold("GET", sessionId);
  const view = render(<ChatFolderButton sessionId={sessionId} projectId={projectId} refreshTimer={refreshTimer} />);
  await read.arrived;
  await read.release();
  return view;
}

/** Shows another chat and waits until its folder list has loaded. */
async function showChat(
  api: ReturnType<typeof fakeFolderApi>,
  view: ReturnType<typeof render>,
  sessionId: string,
  refreshTimer?: FolderRefreshTimer,
): Promise<void> {
  const read = api.hold("GET", sessionId);
  view.rerender(<ChatFolderButton sessionId={sessionId} refreshTimer={refreshTimer} />);
  await read.arrived;
  await read.release();
}

/**
 * The button's re-read timer, run by the test: time passes only when the
 * test says so, and a re-read runs once the time it waits for has passed.
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

/**
 * Opens a chat the way the run panel does, in a button of its own, and waits
 * until its folder list has loaded.
 */
async function mountChat(api: ReturnType<typeof fakeFolderApi>, sessionId: string): Promise<ReturnType<typeof render>> {
  const read = api.hold("GET", sessionId);
  const view = render(<ChatFolderButton key={sessionId} sessionId={sessionId} />);
  await read.reached();
  await read.release();
  return view;
}

/**
 * Shows another chat the way the run panel does, by mounting a new button
 * for it, and waits until its folder list has loaded.
 */
async function remountChat(
  api: ReturnType<typeof fakeFolderApi>,
  view: ReturnType<typeof render>,
  sessionId: string,
): Promise<void> {
  const read = api.hold("GET", sessionId);
  view.rerender(<ChatFolderButton key={sessionId} sessionId={sessionId} />);
  await read.reached();
  await read.release();
}

/** The desktop picker, answering every request with `folderPath` (null is a cancelled picker). */
function installPicker(folderPath: string | null): void {
  window.pipeline = {
    selectBatchFolder: vi.fn(async () => null),
    selectSharedFolder: vi.fn(async () => (folderPath === null ? null : { path: folderPath })),
  };
}

/** The desktop picker, open until the test answers it (null is a cancelled picker). */
function holdPicker(): { opened: Promise<void>; answer: (folderPath: string | null) => Promise<void> } {
  const opened = deferred();
  let choose: (picked: { path: string } | null) => void = () => undefined;
  const picked = new Promise<{ path: string } | null>((settle) => {
    choose = settle;
  });
  window.pipeline = {
    selectBatchFolder: vi.fn(async () => null),
    selectSharedFolder: vi.fn(() => {
      opened.resolve();
      return picked;
    }),
  };
  return {
    opened: opened.promise,
    // Like a held response's release, this returns once the button has handled the answer.
    answer: (folderPath) => act(async () => {
      choose(folderPath === null ? null : { path: folderPath });
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.pipeline;
});

test("with no folders, the button opens the native picker and attaches the chosen folder", async () => {
  const api = fakeFolderApi();
  const selectSharedFolder = vi.fn(async () => ({ path: "/Users/example/Contracts 2026" }));
  window.pipeline = { selectBatchFolder: vi.fn(async () => null), selectSharedFolder };
  const user = userEvent.setup();
  render(<ChatFolderButton sessionId={SESSION_ID} />);

  await user.click(await screen.findByRole("button", { name: "Add folder" }));

  expect(selectSharedFolder).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(api.folders.map((folder) => folder.path)).toEqual(["/Users/example/Contracts 2026"]));
  expect(await screen.findByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();
});

test("a cancelled picker attaches nothing", async () => {
  const api = fakeFolderApi();
  window.pipeline = { selectBatchFolder: vi.fn(async () => null), selectSharedFolder: vi.fn(async () => null) };
  const user = userEvent.setup();
  render(<ChatFolderButton sessionId={SESSION_ID} />);

  await user.click(await screen.findByRole("button", { name: "Add folder" }));

  expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
  expect(screen.getByRole("button", { name: "Add folder" })).toBeInTheDocument();
});

test("a refused folder shows the server's reason", async () => {
  fakeFolderApi({ refuse: { status: 403, error: "This folder is part of the app's own data and can't be shared.", code: "protected_overlap" } });
  window.pipeline = { selectBatchFolder: vi.fn(async () => null), selectSharedFolder: vi.fn(async () => ({ path: "/Users/example" })) };
  const user = userEvent.setup();
  render(<ChatFolderButton sessionId={SESSION_ID} />);

  await user.click(await screen.findByRole("button", { name: "Add folder" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("can't be shared");
});

test("attached folders are listed in the popover and can be removed", async () => {
  const api = fakeFolderApi();
  window.pipeline = { selectBatchFolder: vi.fn(async () => null), selectSharedFolder: vi.fn(async () => ({ path: "/Users/example/Research notes" })) };
  const user = userEvent.setup();
  render(<ChatFolderButton sessionId={SESSION_ID} />);
  await user.click(await screen.findByRole("button", { name: "Add folder" }));

  await user.click(await screen.findByRole("button", { name: "Attached folders (1)" }));
  const popover = await screen.findByRole("dialog", { name: "Attached folders" });
  expect(within(popover).getByText("Research notes")).toBeInTheDocument();
  await user.click(within(popover).getByRole("button", { name: "Remove Research notes" }));

  await waitFor(() => expect(api.folders).toEqual([]));
  expect(api.calls.some((call) => call.method === "DELETE" && call.url.endsWith(`/folders/f_0000000000`))).toBe(true);
});

test("without the desktop picker the button explains that folders need the desktop app", async () => {
  const api = fakeFolderApi();
  const user = userEvent.setup();
  render(<ChatFolderButton sessionId={SESSION_ID} />);

  const button = await screen.findByRole("button", { name: "Add folder (desktop app only)" });
  await user.click(button);

  // The toolbar button's disabled state is its aria-disabled contract.
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
});

test("an attach that lands after the chat changed does not appear in the new chat", async () => {
  const api = fakeFolderApi();
  installPicker("/Users/example/Alpha files");
  const attach = api.hold("POST", SESSION_ID);
  const user = userEvent.setup();
  const view = render(<ChatFolderButton sessionId={SESSION_ID} />);
  await user.click(await screen.findByRole("button", { name: "Add folder" }));
  await attach.arrived;

  const otherRead = api.hold("GET", OTHER_SESSION_ID);
  view.rerender(<ChatFolderButton sessionId={OTHER_SESSION_ID} />);
  await otherRead.arrived;
  await otherRead.release();
  await attach.release();

  expect(api.folders.map((folder) => folder.path)).toEqual(["/Users/example/Alpha files"]);
  expect(screen.queryByRole("button", { name: /^Attached folders/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add folder" })).toBeInTheDocument();
});

test("a folder list read before an attach does not hide the attached folder when it lands late", async () => {
  const api = fakeFolderApi();
  installPicker("/Users/example/Research notes");
  const firstRead = api.hold("GET", SESSION_ID);
  const user = userEvent.setup();
  render(<ChatFolderButton sessionId={SESSION_ID} />);
  await firstRead.arrived;

  await user.click(screen.getByRole("button", { name: "Add folder" }));
  expect(await screen.findByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();
  await firstRead.release();

  expect(screen.getByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();
});

test("a removal that lands after the chat changed leaves the new chat's folders alone", async () => {
  const api = fakeFolderApi({
    seed: { [SESSION_ID]: ["/Users/example/Alpha files"], [OTHER_SESSION_ID]: ["/Users/example/Bravo notes"] },
  });
  installPicker(null);
  const removal = api.hold("DELETE", SESSION_ID);
  const user = userEvent.setup();
  const view = render(<ChatFolderButton sessionId={SESSION_ID} />);
  await user.click(await screen.findByRole("button", { name: "Attached folders (1)" }));
  const popover = await screen.findByRole("dialog", { name: "Attached folders" });
  await user.click(within(popover).getByRole("button", { name: "Remove Alpha files" }));
  await removal.arrived;

  const otherRead = api.hold("GET", OTHER_SESSION_ID);
  view.rerender(<ChatFolderButton sessionId={OTHER_SESSION_ID} />);
  await otherRead.arrived;
  await otherRead.release();
  await removal.release();

  expect(api.folders).toEqual([]);
  expect(screen.getByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();
});

test("an attach failure that lands after the chat changed shows no error in the new chat", async () => {
  const api = fakeFolderApi({ refuse: { status: 403, error: "This folder is part of the app's own data and can't be shared.", code: "protected_overlap" } });
  installPicker("/Users/example");
  const refusal = api.hold("POST", SESSION_ID);
  const user = userEvent.setup();
  const view = render(<ChatFolderButton sessionId={SESSION_ID} />);
  await user.click(await screen.findByRole("button", { name: "Add folder" }));
  await refusal.arrived;

  view.rerender(<ChatFolderButton sessionId={OTHER_SESSION_ID} />);
  await refusal.release();

  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("an attach still in flight for the old chat does not change Add folder in the new chat", async () => {
  const api = fakeFolderApi();
  installPicker("/Users/example/Contracts 2026");
  const oldAttach = api.hold("POST", SESSION_ID);
  const user = userEvent.setup();
  const view = render(<ChatFolderButton sessionId={SESSION_ID} />);
  await user.click(await screen.findByRole("button", { name: "Add folder" }));
  await oldAttach.arrived;

  view.rerender(<ChatFolderButton sessionId={OTHER_SESSION_ID} />);
  const addFolder = screen.getByRole("button", { name: "Add folder" });
  expect(addFolder).not.toHaveAttribute("aria-disabled");

  const newAttach = api.hold("POST", OTHER_SESSION_ID);
  await user.click(addFolder);
  await newAttach.arrived;
  await oldAttach.release();

  expect(screen.getByRole("button", { name: "Add folder" })).toHaveAttribute("aria-disabled", "true");
  await newAttach.release();
});

test("a folder list for the old chat that lands after the chat changed does not appear in the new chat", async () => {
  const api = fakeFolderApi({ seed: { [SESSION_ID]: ["/Users/example/Alpha files"] } });
  installPicker(null);
  const oldRead = api.hold("GET", SESSION_ID);
  const view = render(<ChatFolderButton sessionId={SESSION_ID} />);
  await oldRead.arrived;

  const newRead = api.hold("GET", OTHER_SESSION_ID);
  view.rerender(<ChatFolderButton sessionId={OTHER_SESSION_ID} />);
  await newRead.arrived;
  await newRead.release();
  await oldRead.release();

  expect(screen.queryByRole("button", { name: /^Attached folders/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add folder" })).toBeInTheDocument();
});

test("a draft chat asks the server for no folders and shows Add folder", () => {
  const api = fakeFolderApi({ drafts: [SESSION_ID] });
  installPicker("/Users/example/Contracts 2026");

  render(<ChatFolderButton sessionId={SESSION_ID} isDraft ensureSession={vi.fn(async () => SESSION_ID)} />);

  expect(screen.getByRole("button", { name: "Add folder" })).not.toHaveAttribute("aria-disabled");
  expect(api.calls).toEqual([]);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("a draft chat saved by its first message attaches a folder with no error", async () => {
  const api = fakeFolderApi({ drafts: [SESSION_ID] });
  installPicker("/Users/example/Contracts 2026");
  const ensureSession = vi.fn(async () => SESSION_ID);
  const user = userEvent.setup();
  const view = render(<ChatFolderButton sessionId={SESSION_ID} isDraft ensureSession={ensureSession} />);

  // The first message saves the chat under the same ID.
  api.create(SESSION_ID);
  view.rerender(<ChatFolderButton sessionId={SESSION_ID} isDraft={false} ensureSession={ensureSession} />);
  await user.click(screen.getByRole("button", { name: "Add folder" }));

  expect(await screen.findByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();
  expect(api.folders.map((folder) => folder.path)).toEqual(["/Users/example/Contracts 2026"]);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("a cancelled picker in a draft chat does not save the chat", async () => {
  const api = fakeFolderApi({ drafts: [SESSION_ID] });
  const picker = holdPicker();
  const ensureSession = vi.fn(async () => SESSION_ID);
  const user = userEvent.setup();
  render(<ChatFolderButton sessionId={SESSION_ID} isDraft ensureSession={ensureSession} />);

  await user.click(screen.getByRole("button", { name: "Add folder" }));
  await picker.opened;
  expect(ensureSession).not.toHaveBeenCalled();
  await picker.answer(null);

  expect(ensureSession).not.toHaveBeenCalled();
  expect(api.calls).toEqual([]);
  expect(screen.getByRole("button", { name: "Add folder" })).not.toHaveAttribute("aria-disabled");
});

test("a folder chosen in a draft chat saves the chat and is attached to it", async () => {
  const api = fakeFolderApi({ drafts: [SESSION_ID] });
  const picker = holdPicker();
  // The session store saves a draft under the draft's own ID.
  const ensureSession = vi.fn(async () => {
    api.create(SESSION_ID);
    return SESSION_ID;
  });
  const user = userEvent.setup();
  render(<ChatFolderButton sessionId={SESSION_ID} isDraft ensureSession={ensureSession} />);

  await user.click(screen.getByRole("button", { name: "Add folder" }));
  await picker.opened;
  await picker.answer("/Users/example/Contracts 2026");

  expect(ensureSession).toHaveBeenCalledTimes(1);
  expect(api.pathsOf(SESSION_ID)).toEqual(["/Users/example/Contracts 2026"]);
  expect(screen.getByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("a folder chosen in a draft chat is not attached to the saved chat the sidebar selects before the draft leaves the screen", async () => {
  const api = fakeFolderApi({ drafts: [SESSION_ID] });
  const picker = holdPicker();
  // Like the chat panel's, this save acts on whichever chat is selected when it is called.
  let selected = SESSION_ID;
  const ensureSession = vi.fn(async () => selected);
  const user = userEvent.setup();
  render(<ChatFolderButton key={SESSION_ID} sessionId={SESSION_ID} isDraft ensureSession={ensureSession} />);
  await user.click(screen.getByRole("button", { name: "Add folder" }));
  await picker.opened;

  // The selection moves to a saved chat one render before the draft's button is unmounted.
  selected = SAVED_SESSION_ID;
  await picker.answer("/Users/example/Contracts 2026");

  expect(api.pathsOf(SAVED_SESSION_ID)).toEqual([]);
  expect(api.pathsOf(SESSION_ID)).toEqual([]);
  expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
});

test("a draft chat left while its save is pending gets no folder", async () => {
  const api = fakeFolderApi({ drafts: [SESSION_ID] });
  const picker = holdPicker();
  const saveStarted = deferred();
  let finishSave: (savedId: string) => void = () => undefined;
  const saved = new Promise<string>((settle) => {
    finishSave = settle;
  });
  const ensureSession = vi.fn(() => {
    saveStarted.resolve();
    return saved;
  });
  const user = userEvent.setup();
  const view = render(<ChatFolderButton key={SESSION_ID} sessionId={SESSION_ID} isDraft ensureSession={ensureSession} />);
  await user.click(screen.getByRole("button", { name: "Add folder" }));
  await picker.opened;
  await picker.answer("/Users/example/Contracts 2026");
  await saveStarted.promise;

  await remountChat(api, view, OTHER_SESSION_ID);
  // The save that was already under way finishes after the draft was left.
  await act(async () => {
    api.create(SESSION_ID);
    finishSave(SESSION_ID);
  });

  expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
  expect(api.pathsOf(SESSION_ID)).toEqual([]);
  expect(api.pathsOf(OTHER_SESSION_ID)).toEqual([]);
});

test("a draft chat that fails to save shows the failure and attaches nothing", async () => {
  const api = fakeFolderApi({ drafts: [SESSION_ID] });
  const picker = holdPicker();
  const ensureSession = vi.fn(async (): Promise<string> => {
    throw new Error("Could not create the session.");
  });
  const user = userEvent.setup();
  render(<ChatFolderButton sessionId={SESSION_ID} isDraft ensureSession={ensureSession} />);

  await user.click(screen.getByRole("button", { name: "Add folder" }));
  await picker.opened;
  await picker.answer("/Users/example/Contracts 2026");

  expect(screen.getByRole("alert")).toHaveTextContent("Could not create the session.");
  expect(api.calls).toEqual([]);
  expect(screen.getByRole("button", { name: "Add folder" })).toBeInTheDocument();
});

test("a draft chat left while the picker is open is not saved and gets no folder", async () => {
  const api = fakeFolderApi({ drafts: [SESSION_ID] });
  const picker = holdPicker();
  // Like the chat panel's, this save acts on whichever chat is selected when it is called.
  let selected = SESSION_ID;
  const ensureSession = vi.fn(async () => selected);
  const user = userEvent.setup();
  const view = render(<ChatFolderButton sessionId={SESSION_ID} isDraft ensureSession={ensureSession} />);
  await user.click(screen.getByRole("button", { name: "Add folder" }));
  await picker.opened;

  selected = OTHER_SESSION_ID;
  await showChat(api, view, OTHER_SESSION_ID);
  await picker.answer("/Users/example/Contracts 2026");

  expect(ensureSession).not.toHaveBeenCalled();
  expect(api.pathsOf(OTHER_SESSION_ID)).toEqual([]);
  expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
});

test("an attach the server applies after its chat was left and shown again appears in that chat", async () => {
  const api = fakeFolderApi();
  installPicker("/Users/example/Alpha files");
  const attach = api.hold("POST", SESSION_ID, { applyOnRelease: true });
  const user = userEvent.setup();
  const view = render(<ChatFolderButton sessionId={SESSION_ID} />);
  await user.click(await screen.findByRole("button", { name: "Add folder" }));
  await attach.arrived;

  await showChat(api, view, OTHER_SESSION_ID);
  await showChat(api, view, SESSION_ID);
  await attach.release();

  expect(await screen.findByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();
  expect(api.folders.map((folder) => folder.path)).toEqual(["/Users/example/Alpha files"]);
});

test("a removal the server applies after its chat was left and shown again disappears from that chat", async () => {
  const api = fakeFolderApi({ seed: { [SESSION_ID]: ["/Users/example/Alpha files"] } });
  installPicker(null);
  const removal = api.hold("DELETE", SESSION_ID, { applyOnRelease: true });
  const user = userEvent.setup();
  const view = render(<ChatFolderButton sessionId={SESSION_ID} />);
  await user.click(await screen.findByRole("button", { name: "Attached folders (1)" }));
  await user.click(within(await screen.findByRole("dialog", { name: "Attached folders" })).getByRole("button", { name: "Remove Alpha files" }));
  await removal.arrived;

  await showChat(api, view, OTHER_SESSION_ID);
  await showChat(api, view, SESSION_ID);
  expect(screen.getByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();
  await removal.release();

  await waitFor(() => expect(screen.queryByRole("button", { name: /^Attached folders/ })).not.toBeInTheDocument());
  expect(api.folders).toEqual([]);
});

test("an attach the server applies after its chat was left and opened again appears in the chat's new button", async () => {
  const api = fakeFolderApi();
  installPicker("/Users/example/Alpha files");
  const user = userEvent.setup();
  const view = await mountChat(api, SESSION_ID);
  const attach = api.hold("POST", SESSION_ID, { applyOnRelease: true });
  await user.click(screen.getByRole("button", { name: "Add folder" }));
  await attach.reached();

  await remountChat(api, view, OTHER_SESSION_ID);
  await remountChat(api, view, SESSION_ID);
  expect(screen.getByRole("button", { name: "Add folder" })).toBeInTheDocument();
  await attach.release();

  expect(api.pathsOf(SESSION_ID)).toEqual(["/Users/example/Alpha files"]);
  expect(screen.getByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();
});

test("a removal the server applies after its chat was left and opened again disappears from the chat's new button", async () => {
  const api = fakeFolderApi({ seed: { [SESSION_ID]: ["/Users/example/Alpha files"] } });
  installPicker(null);
  const user = userEvent.setup();
  const view = await mountChat(api, SESSION_ID);
  await user.click(screen.getByRole("button", { name: "Attached folders (1)" }));
  const removal = api.hold("DELETE", SESSION_ID, { applyOnRelease: true });
  await user.click(within(screen.getByRole("dialog", { name: "Attached folders" })).getByRole("button", { name: "Remove Alpha files" }));
  await removal.reached();

  await remountChat(api, view, OTHER_SESSION_ID);
  await remountChat(api, view, SESSION_ID);
  expect(screen.getByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();
  await removal.release();

  expect(api.pathsOf(SESSION_ID)).toEqual([]);
  expect(screen.queryByRole("button", { name: /^Attached folders/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add folder" })).toBeInTheDocument();
});

test("the folder popover stays closed in another chat and when its chat is shown again", async () => {
  const api = fakeFolderApi({
    seed: { [SESSION_ID]: ["/Users/example/Alpha files"], [OTHER_SESSION_ID]: ["/Users/example/Bravo notes"] },
  });
  installPicker(null);
  const user = userEvent.setup();
  const view = render(<ChatFolderButton sessionId={SESSION_ID} />);
  await user.click(await screen.findByRole("button", { name: "Attached folders (1)" }));
  expect(await screen.findByRole("dialog", { name: "Attached folders" })).toBeInTheDocument();

  await showChat(api, view, OTHER_SESSION_ID);
  expect(screen.getByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  await showChat(api, view, SESSION_ID);
  expect(screen.getByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("a Remove click right after a chat switch commits does not remove a folder from the new chat", async () => {
  const api = fakeFolderApi({
    seed: { [SESSION_ID]: ["/Users/example/Alpha files"], [OTHER_SESSION_ID]: ["/Users/example/Bravo notes"] },
  });
  installPicker(null);
  const user = userEvent.setup();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ChatFolderButton sessionId={SESSION_ID} />));
    await user.click(await screen.findByRole("button", { name: "Attached folders (1)" }));
    const remove = within(await screen.findByRole("dialog", { name: "Attached folders" }))
      .getByRole("button", { name: "Remove Alpha files" });

    // A click in the sidebar commits the switch synchronously, outside `act`,
    // and the next click can land before React renders anything else.
    const actEnvironment: unknown = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
    try {
      flushSync(() => root.render(<ChatFolderButton sessionId={OTHER_SESSION_ID} />));
      remove.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    } finally {
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    }

    // Both chats' first folders are f_0000000000, so a removal sent to the new chat would delete Bravo notes.
    expect(api.pathsOf(OTHER_SESSION_ID)).toEqual(["/Users/example/Bravo notes"]);
    expect(api.calls.filter((call) => call.method === "DELETE" && call.url.includes(OTHER_SESSION_ID))).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a folder list error for the old chat that lands after the chat changed shows no error in the new chat", async () => {
  const api = fakeFolderApi();
  installPicker(null);
  const oldRead = api.hold("GET", SESSION_ID, { failWith: SERVER_FAILURE });
  const view = render(<ChatFolderButton sessionId={SESSION_ID} />);
  await oldRead.arrived;

  await showChat(api, view, OTHER_SESSION_ID);
  await oldRead.release();

  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("a removal failure that lands after the chat changed shows no error in the new chat", async () => {
  const api = fakeFolderApi({ seed: { [SESSION_ID]: ["/Users/example/Alpha files"] } });
  installPicker(null);
  const removal = api.hold("DELETE", SESSION_ID, { failWith: SERVER_FAILURE });
  const user = userEvent.setup();
  const view = render(<ChatFolderButton sessionId={SESSION_ID} />);
  await user.click(await screen.findByRole("button", { name: "Attached folders (1)" }));
  await user.click(within(await screen.findByRole("dialog", { name: "Attached folders" })).getByRole("button", { name: "Remove Alpha files" }));
  await removal.arrived;

  await showChat(api, view, OTHER_SESSION_ID);
  await removal.release();

  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("an error shown in one chat is gone when another chat is shown", async () => {
  fakeFolderApi();
  window.pipeline = {
    selectBatchFolder: vi.fn(async () => null),
    selectSharedFolder: vi.fn(async () => {
      throw new Error("The folder dialog could not open.");
    }),
  };
  const user = userEvent.setup();
  const view = render(<ChatFolderButton sessionId={SESSION_ID} />);
  await user.click(await screen.findByRole("button", { name: "Add folder" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The folder dialog could not open.");

  view.rerender(<ChatFolderButton sessionId={OTHER_SESSION_ID} />);

  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("the old chat's folders are not shown while the new chat's list loads", async () => {
  const api = fakeFolderApi({ seed: { [SESSION_ID]: ["/Users/example/Alpha files"] } });
  installPicker(null);
  const view = render(<ChatFolderButton sessionId={SESSION_ID} />);
  expect(await screen.findByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();

  const newRead = api.hold("GET", OTHER_SESSION_ID);
  view.rerender(<ChatFolderButton sessionId={OTHER_SESSION_ID} />);
  await newRead.arrived;

  expect(screen.queryByRole("button", { name: /^Attached folders/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add folder" })).toBeInTheDocument();
  await newRead.release();
});

test("a folder list read before a removal does not bring the removed folder back", async () => {
  const api = fakeFolderApi({ seed: { [SESSION_ID]: ["/Users/example/Alpha files"] } });
  installPicker("/Users/example/Bravo notes");
  const user = userEvent.setup();
  render(<ChatFolderButton sessionId={SESSION_ID} />);
  await user.click(await screen.findByRole("button", { name: "Attached folders (1)" }));
  const popover = await screen.findByRole("dialog", { name: "Attached folders" });

  // The read that follows the attach answers with both folders, and lands only after the removal.
  const readAfterAttach = api.hold("GET", SESSION_ID);
  await user.click(within(popover).getByRole("button", { name: "Add folder" }));
  await readAfterAttach.reached();
  await user.click(within(popover).getByRole("button", { name: "Remove Alpha files" }));
  expect(await screen.findByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();
  await readAfterAttach.release();

  expect(api.pathsOf(SESSION_ID)).toEqual(["/Users/example/Bravo notes"]);
  expect(screen.getByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();
  expect(within(popover).queryByText("Alpha files")).not.toBeInTheDocument();
});

test("attaching a folder the chat already has does not list it twice", async () => {
  const api = fakeFolderApi({ seed: { [SESSION_ID]: ["/Users/example/Alpha files"] } });
  installPicker("/Users/example/Alpha files");
  const user = userEvent.setup();
  render(<ChatFolderButton sessionId={SESSION_ID} />);
  await user.click(await screen.findByRole("button", { name: "Attached folders (1)" }));
  const popover = await screen.findByRole("dialog", { name: "Attached folders" });

  // Hold the read that follows the attach, so only the attach's own answer is on screen.
  const readAfterAttach = api.hold("GET", SESSION_ID);
  await user.click(within(popover).getByRole("button", { name: "Add folder" }));
  await readAfterAttach.reached();

  expect(api.pathsOf(SESSION_ID)).toEqual(["/Users/example/Alpha files"]);
  expect(screen.getByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();
  expect(within(popover).getAllByText("Alpha files")).toHaveLength(1);
  await readAfterAttach.release();
});

test("after the last folder is removed, the next attach does not open the popover by itself", async () => {
  fakeFolderApi({ seed: { [SESSION_ID]: ["/Users/example/Alpha files"] } });
  installPicker("/Users/example/Bravo notes");
  const user = userEvent.setup();
  render(<ChatFolderButton sessionId={SESSION_ID} />);
  await user.click(await screen.findByRole("button", { name: "Attached folders (1)" }));
  await user.click(within(await screen.findByRole("dialog", { name: "Attached folders" })).getByRole("button", { name: "Remove Alpha files" }));
  await user.click(await screen.findByRole("button", { name: "Add folder" }));

  expect(await screen.findByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("an Add folder click opens the picker when a read started by an earlier attach replaces its check that the chat is saved", async () => {
  const api = fakeFolderApi();
  const selectSharedFolder = vi.fn(async () => ({ path: "/Users/example/Alpha files" }));
  window.pipeline = { selectBatchFolder: vi.fn(async () => null), selectSharedFolder };
  const user = userEvent.setup();
  const view = await renderChat(api, SESSION_ID);
  const firstAttach = api.hold("POST", SESSION_ID);
  await user.click(screen.getByRole("button", { name: "Add folder" }));
  await firstAttach.reached();

  // Back in the chat its list has not loaded, so the next click first asks whether the chat is saved.
  await showChat(api, view, OTHER_SESSION_ID);
  const listOnReturn = api.hold("GET", SESSION_ID);
  view.rerender(<ChatFolderButton sessionId={SESSION_ID} />);
  await listOnReturn.reached();
  const savedCheck = api.hold("GET", SESSION_ID);
  await user.click(screen.getByRole("button", { name: "Add folder" }));
  await savedCheck.reached();

  // The first attach lands now, and the read it starts replaces that check.
  const readAfterAttach = api.hold("GET", SESSION_ID);
  await firstAttach.release();
  await readAfterAttach.reached();
  await savedCheck.release();
  await readAfterAttach.release();
  await listOnReturn.release();

  expect(selectSharedFolder).toHaveBeenCalledTimes(2);
});

test("an attach answer that lands after its folder was removed does not list the folder again", async () => {
  const api = fakeFolderApi({ seed: { [SESSION_ID]: ["/Users/example/Alpha files"] } });
  installPicker("/Users/example/Bravo notes");
  const user = userEvent.setup();
  await renderChat(api, SESSION_ID);
  await user.click(screen.getByRole("button", { name: "Attached folders (1)" }));
  const attach = api.hold("POST", SESSION_ID);
  await user.click(within(screen.getByRole("dialog", { name: "Attached folders" })).getByRole("button", { name: "Add folder" }));
  await attach.reached();

  // The server has applied the attach. Its answer is held while both folders are removed.
  const readAfterFirstRemoval = api.hold("GET", SESSION_ID);
  await user.click(within(screen.getByRole("dialog", { name: "Attached folders" })).getByRole("button", { name: "Remove Alpha files" }));
  await readAfterFirstRemoval.reached();
  await readAfterFirstRemoval.release();
  await user.click(screen.getByRole("button", { name: "Attached folders (1)" }));
  const readAfterSecondRemoval = api.hold("GET", SESSION_ID);
  await user.click(within(screen.getByRole("dialog", { name: "Attached folders" })).getByRole("button", { name: "Remove Bravo notes" }));
  await readAfterSecondRemoval.reached();

  // The read the attach starts fails, so only the attach's own answer can change the list.
  const readAfterAttach = api.hold("GET", SESSION_ID, { failWith: SERVER_FAILURE });
  await attach.release();
  await readAfterAttach.reached();
  await readAfterAttach.release();
  await readAfterSecondRemoval.release();

  expect(api.pathsOf(SESSION_ID)).toEqual([]);
  expect(screen.queryByRole("button", { name: /^Attached folders/ })).not.toBeInTheDocument();
});

test("a folder list error goes once a later read of the same chat succeeds", async () => {
  const api = fakeFolderApi();
  installPicker("/Users/example/Alpha files");
  const user = userEvent.setup();
  const view = await renderChat(api, SESSION_ID);
  const attach = api.hold("POST", SESSION_ID);
  await user.click(screen.getByRole("button", { name: "Add folder" }));
  await attach.reached();

  await showChat(api, view, OTHER_SESSION_ID);
  const failedList = api.hold("GET", SESSION_ID, { failWith: SERVER_FAILURE });
  view.rerender(<ChatFolderButton sessionId={SESSION_ID} />);
  await failedList.reached();
  await failedList.release();
  expect(screen.getByRole("alert")).toHaveTextContent("Folder request failed.");

  // The attach lands now, and the chat reads its list again.
  const readAfterAttach = api.hold("GET", SESSION_ID);
  await attach.release();
  await readAfterAttach.reached();
  await readAfterAttach.release();

  expect(screen.getByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("a cancelled picker leaves a failed folder list's error on screen", async () => {
  const api = fakeFolderApi({ seed: { [SESSION_ID]: ["/Users/example/Alpha files"] } });
  installPicker(null);
  const failedList = api.hold("GET", SESSION_ID, { failWith: SERVER_FAILURE });
  const user = userEvent.setup();
  render(<ChatFolderButton sessionId={SESSION_ID} />);
  await failedList.reached();
  await failedList.release();
  expect(screen.getByRole("alert")).toHaveTextContent("Folder request failed.");

  await user.click(screen.getByRole("button", { name: "Add folder" }));

  expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
  expect(screen.getByRole("alert")).toHaveTextContent("Folder request failed.");
});

test("a removal in flight leaves a failed folder list's error on screen", async () => {
  const api = fakeFolderApi({ seed: { [SESSION_ID]: ["/Users/example/Alpha files", "/Users/example/Bravo notes"] } });
  installPicker(null);
  const user = userEvent.setup();
  await renderChat(api, SESSION_ID);
  await user.click(screen.getByRole("button", { name: "Attached folders (2)" }));
  const failedReread = api.hold("GET", SESSION_ID, { failWith: SERVER_FAILURE });
  await user.click(within(screen.getByRole("dialog", { name: "Attached folders" })).getByRole("button", { name: "Remove Alpha files" }));
  await failedReread.reached();
  await failedReread.release();
  expect(screen.getByRole("alert")).toHaveTextContent("Folder request failed.");

  const removal = api.hold("DELETE", SESSION_ID);
  await user.click(within(screen.getByRole("dialog", { name: "Attached folders" })).getByRole("button", { name: "Remove Bravo notes" }));
  await removal.reached();

  expect(screen.getByRole("alert")).toHaveTextContent("Folder request failed.");
  await removal.release();
});

test("an attach failure's error goes once a later attach succeeds", async () => {
  const api = fakeFolderApi();
  installPicker("/Users/example/Alpha files");
  const user = userEvent.setup();
  await renderChat(api, SESSION_ID);
  const failedAttach = api.hold("POST", SESSION_ID, { failWith: SERVER_FAILURE });
  await user.click(screen.getByRole("button", { name: "Add folder" }));
  await failedAttach.reached();
  await failedAttach.release();
  expect(screen.getByRole("alert")).toHaveTextContent("Folder request failed.");

  const attach = api.hold("POST", SESSION_ID);
  await user.click(screen.getByRole("button", { name: "Add folder" }));
  await attach.reached();
  await attach.release();

  expect(api.pathsOf(SESSION_ID)).toEqual(["/Users/example/Alpha files"]);
  expect(screen.getByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("a removal failure's error goes once the removal is tried again and succeeds", async () => {
  const api = fakeFolderApi({ seed: { [SESSION_ID]: ["/Users/example/Alpha files"] } });
  installPicker(null);
  const user = userEvent.setup();
  await renderChat(api, SESSION_ID);
  await user.click(screen.getByRole("button", { name: "Attached folders (1)" }));
  const failedRemoval = api.hold("DELETE", SESSION_ID, { failWith: SERVER_FAILURE });
  await user.click(within(screen.getByRole("dialog", { name: "Attached folders" })).getByRole("button", { name: "Remove Alpha files" }));
  await failedRemoval.reached();
  await failedRemoval.release();
  expect(screen.getByRole("alert")).toHaveTextContent("Folder request failed.");

  const removal = api.hold("DELETE", SESSION_ID);
  await user.click(within(screen.getByRole("dialog", { name: "Attached folders" })).getByRole("button", { name: "Remove Alpha files" }));
  await removal.reached();
  await removal.release();

  expect(api.pathsOf(SESSION_ID)).toEqual([]);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

const PROJECT = { id: "11111111-1111-4111-8111-111111111111", name: "Acme launch" };

test("folders from the chat's project are counted and listed under the project, without remove buttons", async () => {
  const api = fakeFolderApi({
    seed: { [SESSION_ID]: ["/Users/example/Research notes"] },
    projects: { [SESSION_ID]: { ...PROJECT, paths: ["/Users/example/Contracts 2026", "/Users/example/Brand assets"] } },
  });
  installPicker(null);
  const user = userEvent.setup();
  await renderChat(api, SESSION_ID);

  await user.click(screen.getByRole("button", { name: "Attached folders (3)" }));
  const popover = screen.getByRole("dialog", { name: "Attached folders" });
  const fromProject = within(popover).getByRole("list", { name: 'From project "Acme launch"' });
  expect(within(fromProject).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Contracts 2026", "Brand assets"]);
  expect(within(fromProject).queryByRole("button")).not.toBeInTheDocument();
  expect(within(popover).getByText("Manage these in Library")).toBeInTheDocument();
  const chatOnly = within(popover).getByRole("list", { name: "This chat only" });
  expect(within(chatOnly).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Research notes"]);
  expect(within(popover).getAllByRole("button", { name: /^Remove / }).map((button) => button.getAttribute("aria-label")))
    .toEqual(["Remove Research notes"]);
});

test("removing the chat's own folder leaves a project folder with the same ID listed", async () => {
  const api = fakeFolderApi({
    seed: { [SESSION_ID]: ["/Users/example/Research notes"] },
    projects: { [SESSION_ID]: { ...PROJECT, paths: ["/Users/example/Contracts 2026"] } },
  });
  installPicker(null);
  const user = userEvent.setup();
  await renderChat(api, SESSION_ID);
  await user.click(screen.getByRole("button", { name: "Attached folders (2)" }));

  // Hold the read that follows the removal, so only the removal's own change is on screen.
  const readAfterRemoval = api.hold("GET", SESSION_ID);
  await user.click(within(screen.getByRole("dialog", { name: "Attached folders" })).getByRole("button", { name: "Remove Research notes" }));
  await readAfterRemoval.reached();

  expect(api.pathsOf(SESSION_ID)).toEqual([]);
  expect(screen.getByRole("button", { name: "Attached folders (1)" })).toBeInTheDocument();
  const fromProject = within(screen.getByRole("dialog", { name: "Attached folders" })).getByRole("list", { name: 'From project "Acme launch"' });
  expect(within(fromProject).getByText("Contracts 2026")).toBeInTheDocument();
  await readAfterRemoval.release();
});

test("a folder the chat's project already shares is refused with the project's name, and the chat then lists it under the project", async () => {
  const api = fakeFolderApi({ projects: { [SESSION_ID]: { ...PROJECT, paths: [] } } });
  installPicker("/Users/example/Contracts 2026");
  const user = userEvent.setup();
  await renderChat(api, SESSION_ID);
  // The project gains the folder in Library after this chat read its list.
  api.shareWithProject(SESSION_ID, "/Users/example/Contracts 2026");

  const refusal = api.hold("POST", SESSION_ID);
  const readAfterRefusal = api.hold("GET", SESSION_ID);
  await user.click(screen.getByRole("button", { name: "Add folder" }));
  await refusal.reached();
  await refusal.release();
  await readAfterRefusal.release();

  expect(screen.getByRole("alert")).toHaveTextContent('This folder is already shared with the project "Acme launch".');
  expect(api.pathsOf(SESSION_ID)).toEqual([]);
  await user.click(screen.getByRole("button", { name: "Attached folders (1)" }));
  const fromProject = within(screen.getByRole("dialog", { name: "Attached folders" })).getByRole("list", { name: 'From project "Acme launch"' });
  expect(within(fromProject).getByText("Contracts 2026")).toBeInTheDocument();
});

test("a folder attached to the chat is listed as its own when a project folder has the same ID", async () => {
  const api = fakeFolderApi({ projects: { [SESSION_ID]: { ...PROJECT, paths: ["/Users/example/Contracts 2026"] } } });
  installPicker("/Users/example/Research notes");
  const user = userEvent.setup();
  await renderChat(api, SESSION_ID);
  await user.click(screen.getByRole("button", { name: "Attached folders (1)" }));

  // Hold the read that follows the attach, so only the attach's own answer is on screen.
  const readAfterAttach = api.hold("GET", SESSION_ID);
  await user.click(within(screen.getByRole("dialog", { name: "Attached folders" })).getByRole("button", { name: "Add folder" }));
  await readAfterAttach.reached();

  expect(api.pathsOf(SESSION_ID)).toEqual(["/Users/example/Research notes"]);
  expect(screen.getByRole("button", { name: "Attached folders (2)" })).toBeInTheDocument();
  const chatOnly = within(screen.getByRole("dialog", { name: "Attached folders" })).getByRole("list", { name: "This chat only" });
  expect(within(chatOnly).getByText("Research notes")).toBeInTheDocument();
  await readAfterAttach.release();
});

/*
 * A chat moved into, out of or between projects gains or loses that project's
 * folders on its next turn. The sidebar moves the chat on the server, then
 * shows the same chat with its new project, so the button stays mounted and
 * only its project changes.
 */

const OTHER_PROJECT = { id: "55555555-5555-4555-8555-555555555555", name: "Spring catalogue" };

test("a chat moved into a project lists and counts the project's folders", async () => {
  const api = fakeFolderApi();
  installPicker(null);
  const user = userEvent.setup();
  const view = await renderChat(api, SESSION_ID);
  expect(screen.getByRole("button", { name: "Add folder" })).toBeInTheDocument();

  api.moveToProject(SESSION_ID, { ...PROJECT, paths: ["/Users/example/Contracts 2026", "/Users/example/Brand assets"] });
  const read = api.hold("GET", SESSION_ID);
  view.rerender(<ChatFolderButton sessionId={SESSION_ID} projectId={PROJECT.id} />);
  await read.release();

  await user.click(screen.getByRole("button", { name: "Attached folders (2)" }));
  const fromProject = within(screen.getByRole("dialog", { name: "Attached folders" })).getByRole("list", { name: 'From project "Acme launch"' });
  expect(within(fromProject).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Contracts 2026", "Brand assets"]);
});

test("a chat moved out of its project no longer lists or counts the project's folders, and keeps its own", async () => {
  const api = fakeFolderApi({
    seed: { [SESSION_ID]: ["/Users/example/Research notes"] },
    projects: { [SESSION_ID]: { ...PROJECT, paths: ["/Users/example/Contracts 2026", "/Users/example/Brand assets"] } },
  });
  installPicker(null);
  const user = userEvent.setup();
  const view = await renderChat(api, SESSION_ID, PROJECT.id);
  expect(screen.getByRole("button", { name: "Attached folders (3)" })).toBeInTheDocument();

  api.moveToProject(SESSION_ID, null);
  const read = api.hold("GET", SESSION_ID);
  view.rerender(<ChatFolderButton sessionId={SESSION_ID} />);
  await read.release();

  await user.click(screen.getByRole("button", { name: "Attached folders (1)" }));
  const popover = screen.getByRole("dialog", { name: "Attached folders" });
  expect(within(popover).queryByText("Contracts 2026")).not.toBeInTheDocument();
  expect(within(popover).queryByText("Brand assets")).not.toBeInTheDocument();
  const chatOnly = within(popover).getByRole("list", { name: "This chat only" });
  expect(within(chatOnly).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Research notes"]);
});

test("a chat moved to another project lists that project's folders in place of the old project's", async () => {
  const api = fakeFolderApi({
    projects: { [SESSION_ID]: { ...PROJECT, paths: ["/Users/example/Contracts 2026", "/Users/example/Brand assets"] } },
  });
  installPicker(null);
  const user = userEvent.setup();
  const view = await renderChat(api, SESSION_ID, PROJECT.id);
  expect(screen.getByRole("button", { name: "Attached folders (2)" })).toBeInTheDocument();

  api.moveToProject(SESSION_ID, { ...OTHER_PROJECT, paths: ["/Users/example/Catalogue photos"] });
  const read = api.hold("GET", SESSION_ID);
  view.rerender(<ChatFolderButton sessionId={SESSION_ID} projectId={OTHER_PROJECT.id} />);
  await read.release();

  await user.click(screen.getByRole("button", { name: "Attached folders (1)" }));
  const popover = screen.getByRole("dialog", { name: "Attached folders" });
  expect(within(popover).queryByRole("list", { name: 'From project "Acme launch"' })).not.toBeInTheDocument();
  const fromProject = within(popover).getByRole("list", { name: 'From project "Spring catalogue"' });
  expect(within(fromProject).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Catalogue photos"]);
});

test("a folder list read before the chat left its project does not bring the project's folders back when it lands late", async () => {
  const api = fakeFolderApi({
    projects: { [SESSION_ID]: { ...PROJECT, paths: ["/Users/example/Contracts 2026", "/Users/example/Brand assets"] } },
  });
  installPicker(null);
  // The first read answers with the project's folders but reaches the button only after the move.
  const readBeforeMove = api.hold("GET", SESSION_ID);
  const view = render(<ChatFolderButton sessionId={SESSION_ID} projectId={PROJECT.id} />);
  await readBeforeMove.reached();

  api.moveToProject(SESSION_ID, null);
  const readAfterMove = api.hold("GET", SESSION_ID);
  view.rerender(<ChatFolderButton sessionId={SESSION_ID} />);
  await readAfterMove.release();
  await readBeforeMove.release();

  expect(screen.getByRole("button", { name: "Add folder" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Attached folders/ })).not.toBeInTheDocument();
});

/*
 * Folder statuses (docs/feature-local-folder-access.md, "Status" and the chat
 * header sketch). The server sends a status on each folder once the folder
 * index exists; until then the button and its popover show none.
 */

/** The popover's row for the folder labelled `label`. */
function popoverRow(label: string): HTMLElement {
  const popover = screen.getByRole("dialog", { name: "Attached folders" });
  const item = within(popover).getAllByRole("listitem").find((entry) => within(entry).queryByText(label) !== null);
  if (!item) throw new Error(`The popover has no row for ${label}.`);
  return item;
}

const RESEARCH_NOTES = "/Users/example/Research notes";

test("each folder in the popover shows how many files it has and its status", async () => {
  const api = fakeFolderApi({
    seed: { [SESSION_ID]: [RESEARCH_NOTES] },
    projects: { [SESSION_ID]: { ...PROJECT, paths: ["/Users/example/Contracts 2026", "/Users/example/Brand assets"] } },
    statuses: {
      "/Users/example/Contracts 2026": { state: "ready", files: 412 },
      "/Users/example/Brand assets": { state: "indexing", files: 88, pendingDocuments: 12 },
      [RESEARCH_NOTES]: { state: "partial", files: 57, limit: "2 GB of documents parsed" },
    },
  });
  installPicker(null);
  const user = userEvent.setup();
  await renderChat(api, SESSION_ID, PROJECT.id, manualTimer().timer);

  await user.click(screen.getByRole("button", { name: "Attached folders (3)" }));

  expect(within(popoverRow("Contracts 2026")).getByText("412 files · Ready")).toBeInTheDocument();
  expect(within(popoverRow("Brand assets")).getByText("88 files · Indexing · 12 documents left")).toBeInTheDocument();
  expect(within(popoverRow("Research notes")).getByText("57 files · Partial: 2 GB of documents parsed")).toBeInTheDocument();
});

test("an unavailable folder puts a warning on the button, which says how many folders need attention", async () => {
  const api = fakeFolderApi({
    seed: { [SESSION_ID]: [RESEARCH_NOTES] },
    projects: { [SESSION_ID]: { ...PROJECT, paths: ["/Users/example/Contracts 2026", "/Users/example/Old research"] } },
    statuses: {
      "/Users/example/Contracts 2026": { state: "ready", files: 412 },
      "/Users/example/Old research": { state: "unavailable", reason: "not_found" },
      [RESEARCH_NOTES]: { state: "ready", files: 57 },
    },
  });
  installPicker(null);
  const user = userEvent.setup();
  await renderChat(api, SESSION_ID, PROJECT.id, manualTimer().timer);

  await user.click(screen.getByRole("button", { name: "Attached folders (3), 1 needs attention" }));

  expect(within(popoverRow("Old research")).getByText("Folder not found")).toBeInTheDocument();
});

test("two unavailable folders are both counted in the button's name", async () => {
  const api = fakeFolderApi({
    seed: { [SESSION_ID]: [RESEARCH_NOTES] },
    projects: { [SESSION_ID]: { ...PROJECT, paths: ["/Users/example/Payroll"] } },
    statuses: {
      "/Users/example/Payroll": { state: "unavailable", reason: "access_removed" },
      [RESEARCH_NOTES]: { state: "unavailable", reason: "unreadable" },
    },
  });
  installPicker(null);
  const user = userEvent.setup();
  await renderChat(api, SESSION_ID, PROJECT.id, manualTimer().timer);

  await user.click(screen.getByRole("button", { name: "Attached folders (2), 2 need attention" }));

  expect(within(popoverRow("Payroll")).getByText("Access removed")).toBeInTheDocument();
  expect(within(popoverRow("Research notes")).getByText("Can't read folder")).toBeInTheDocument();
});

test("while a folder is indexing, the button reads its chat's list again 3 seconds after the last read and shows the new status", async () => {
  const api = fakeFolderApi({
    seed: { [SESSION_ID]: [RESEARCH_NOTES] },
    statuses: { [RESEARCH_NOTES]: { state: "indexing", files: 57, pendingDocuments: 3 } },
  });
  installPicker(null);
  const user = userEvent.setup();
  const clock = manualTimer();
  await renderChat(api, SESSION_ID, undefined, clock.timer);
  api.setStatus(RESEARCH_NOTES, { state: "ready", files: 57 });

  const reread = api.hold("GET", SESSION_ID);
  await clock.advance(2_999);
  expect(api.reads(SESSION_ID)).toBe(1);
  await clock.advance(1);
  expect(api.reads(SESSION_ID)).toBe(2);
  await reread.reached();
  await reread.release();

  await user.click(screen.getByRole("button", { name: "Attached folders (1)" }));
  expect(within(popoverRow("Research notes")).getByText("57 files · Ready")).toBeInTheDocument();
});

test("the button stops reading its chat's list again once no folder is indexing", async () => {
  const api = fakeFolderApi({
    seed: { [SESSION_ID]: [RESEARCH_NOTES] },
    statuses: { [RESEARCH_NOTES]: { state: "indexing", files: 57, pendingDocuments: 3 } },
  });
  installPicker(null);
  const clock = manualTimer();
  await renderChat(api, SESSION_ID, undefined, clock.timer);
  api.setStatus(RESEARCH_NOTES, { state: "ready", files: 57 });
  const reread = api.hold("GET", SESSION_ID);
  await clock.advance(3_000);
  expect(api.reads(SESSION_ID)).toBe(2);
  await reread.reached();
  await reread.release();

  await clock.advance(AN_HOUR);

  expect(api.reads(SESSION_ID)).toBe(2);
});

test("while a re-read is in flight the button starts no other, however long it takes", async () => {
  const api = fakeFolderApi({
    seed: { [SESSION_ID]: [RESEARCH_NOTES] },
    statuses: { [RESEARCH_NOTES]: { state: "indexing", files: 57, pendingDocuments: 3 } },
  });
  installPicker(null);
  const clock = manualTimer();
  await renderChat(api, SESSION_ID, undefined, clock.timer);
  const reread = api.hold("GET", SESSION_ID);
  await clock.advance(3_000);
  expect(api.reads(SESSION_ID)).toBe(2);

  await clock.advance(AN_HOUR);
  expect(api.reads(SESSION_ID)).toBe(2);
  await reread.reached();
  await reread.release();

  // The folder is still indexing, so the next re-read follows 3 seconds after this one landed.
  await clock.advance(3_000);
  expect(api.reads(SESSION_ID)).toBe(3);
});

test("a re-read that fails while a folder is indexing is tried again on the same schedule", async () => {
  const api = fakeFolderApi({
    seed: { [SESSION_ID]: [RESEARCH_NOTES] },
    statuses: { [RESEARCH_NOTES]: { state: "indexing", files: 57, pendingDocuments: 3 } },
  });
  installPicker(null);
  const user = userEvent.setup();
  const clock = manualTimer();
  await renderChat(api, SESSION_ID, undefined, clock.timer);
  const failed = api.hold("GET", SESSION_ID, { failWith: SERVER_FAILURE });
  await clock.advance(3_000);
  expect(api.reads(SESSION_ID)).toBe(2);
  await failed.reached();
  await failed.release();
  expect(screen.getByRole("alert")).toHaveTextContent("Folder request failed.");

  api.setStatus(RESEARCH_NOTES, { state: "ready", files: 57 });
  const retry = api.hold("GET", SESSION_ID);
  await clock.advance(3_000);
  expect(api.reads(SESSION_ID)).toBe(3);
  await retry.reached();
  await retry.release();

  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Attached folders (1)" }));
  expect(within(popoverRow("Research notes")).getByText("57 files · Ready")).toBeInTheDocument();
});

test("a button that has left the screen reads its chat's list no more", async () => {
  const api = fakeFolderApi({
    seed: { [SESSION_ID]: [RESEARCH_NOTES] },
    statuses: { [RESEARCH_NOTES]: { state: "indexing", files: 57, pendingDocuments: 3 } },
  });
  installPicker(null);
  const clock = manualTimer();
  const view = await renderChat(api, SESSION_ID, undefined, clock.timer);

  view.unmount();
  await clock.advance(AN_HOUR);

  expect(api.reads(SESSION_ID)).toBe(1);
});

test("once the button shows another chat, the previous chat's list is read no more", async () => {
  const api = fakeFolderApi({
    seed: { [SESSION_ID]: [RESEARCH_NOTES] },
    statuses: { [RESEARCH_NOTES]: { state: "indexing", files: 57, pendingDocuments: 3 } },
  });
  installPicker(null);
  const clock = manualTimer();
  const view = await renderChat(api, SESSION_ID, undefined, clock.timer);

  await showChat(api, view, OTHER_SESSION_ID, clock.timer);
  await clock.advance(AN_HOUR);

  expect(api.reads(SESSION_ID)).toBe(1);
  expect(screen.getByRole("button", { name: "Add folder" })).toBeInTheDocument();
});

test("a chat moved out of its project is read once for the move, not again by the schedule its old list started", async () => {
  const api = fakeFolderApi({
    projects: { [SESSION_ID]: { ...PROJECT, paths: ["/Users/example/Brand assets"] } },
    statuses: { "/Users/example/Brand assets": { state: "indexing", files: 88, pendingDocuments: 12 } },
  });
  installPicker(null);
  const clock = manualTimer();
  const view = await renderChat(api, SESSION_ID, PROJECT.id, clock.timer);

  api.moveToProject(SESSION_ID, null);
  const readAfterMove = api.hold("GET", SESSION_ID);
  view.rerender(<ChatFolderButton sessionId={SESSION_ID} refreshTimer={clock.timer} />);
  await readAfterMove.reached();
  await clock.advance(AN_HOUR);

  expect(api.reads(SESSION_ID)).toBe(2);
  await readAfterMove.release();
  expect(screen.getByRole("button", { name: "Add folder" })).toBeInTheDocument();
});

test("clicking a folder's name opens it in the file manager, for the chat's own and the project's folders", async () => {
  const api = fakeFolderApi({
    seed: { [SESSION_ID]: [RESEARCH_NOTES] },
    projects: { [SESSION_ID]: { ...PROJECT, paths: ["/Users/example/Contracts 2026"] } },
  });
  const openSharedFolder = vi.fn(async () => ({ opened: true as const }));
  window.pipeline = {
    selectBatchFolder: vi.fn(async () => null),
    selectSharedFolder: vi.fn(async () => null),
    openSharedFolder,
  };
  const user = userEvent.setup();
  await renderChat(api, SESSION_ID, PROJECT.id, manualTimer().timer);
  await user.click(screen.getByRole("button", { name: "Attached folders (2)" }));

  await user.click(within(popoverRow("Research notes")).getByRole("button", { name: /^Show Research notes in / }));
  await user.click(within(popoverRow("Contracts 2026")).getByRole("button", { name: /^Show Contracts 2026 in / }));

  expect(openSharedFolder.mock.calls).toEqual([[RESEARCH_NOTES], ["/Users/example/Contracts 2026"]]);
});

test("a folder that can't be opened says why, without the Electron wrapper text", async () => {
  const api = fakeFolderApi({ seed: { [SESSION_ID]: [RESEARCH_NOTES] } });
  window.pipeline = {
    selectBatchFolder: vi.fn(async () => null),
    selectSharedFolder: vi.fn(async () => null),
    openSharedFolder: vi.fn(async () => {
      throw new Error("Error invoking remote method 'pipeline:open-shared-folder': Error: This is not a shared folder.");
    }),
  };
  const user = userEvent.setup();
  await renderChat(api, SESSION_ID, undefined, manualTimer().timer);
  await user.click(screen.getByRole("button", { name: "Attached folders (1)" }));

  await user.click(within(popoverRow("Research notes")).getByRole("button", { name: /^Show Research notes in / }));

  expect(await screen.findByRole("alert")).toHaveTextContent(/^This is not a shared folder\.$/);
});

test("without the desktop bridge, a folder's name is plain text", async () => {
  const api = fakeFolderApi({ seed: { [SESSION_ID]: [RESEARCH_NOTES] } });
  installPicker(null);
  const user = userEvent.setup();
  await renderChat(api, SESSION_ID, undefined, manualTimer().timer);
  await user.click(screen.getByRole("button", { name: "Attached folders (1)" }));

  expect(within(popoverRow("Research notes")).queryByRole("button", { name: /^Show Research notes in / })).toBeNull();
});
