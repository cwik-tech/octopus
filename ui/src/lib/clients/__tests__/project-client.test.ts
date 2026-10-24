import { afterEach, expect, test, vi } from "vitest";

import {
  assignSessionToProject,
  createProject,
  deleteProject,
  deleteProjectFile,
  getProjectBrief,
  getProjectCatalogRoot,
  getProjectCatalogSession,
  getProjectDetails,
  listProjectSessions,
  listProjectFiles,
  listProjects,
  removeSessionFromProject,
  updateProject,
  updateProjectBrief,
  uploadProjectFile,
} from "@/lib/clients/project-client";

type FetchMock = (input: string, init?: RequestInit) => Promise<Response>;

const project = {
  version: 1 as const,
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme",
  status: "active" as const,
  createdAt: "2026-08-04T12:00:00.000Z",
  updatedAt: "2026-08-04T12:00:00.000Z",
  sessionCount: 0,
  activeSessionCount: 0,
};

const projectDetails = {
  version: 1 as const,
  project,
  brief: { content: "", updatedAt: project.updatedAt },
  files: [],
  catalog: {
    version: 1 as const,
    projectId: project.id,
    sharedInputs: [],
    sessions: [],
  },
  sessions: [],
  schedules: [],
  memoryProposals: [],
};

afterEach(() => {
  vi.restoreAllMocks();
});

test("listProjects requests archived projects only when asked", async () => {
  const fetchMock = vi.fn<FetchMock>(async () =>
    new Response(JSON.stringify({ projects: [project] }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);

  expect(await listProjects({ includeArchived: true })).toEqual([project]);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/projects?includeArchived=true",
  );
});

test("createProject and updateProject send normalized project commands", async () => {
  const fetchMock = vi.fn<FetchMock>(async () =>
    new Response(JSON.stringify(project), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await createProject({ name: "  Acme  ", description: " Brief " });
  await updateProject(project.id, { status: "archived" });

  expect(fetchMock.mock.calls[0]).toEqual([
    "/api/projects",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "Acme", description: "Brief" }),
    }),
  ]);
  expect(fetchMock.mock.calls[1]).toEqual([
    `/api/projects/${project.id}`,
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ status: "archived" }),
    }),
  ]);
});

test("project membership commands use the project and session resource path", async () => {
  const membership = {
    version: 1 as const,
    projectId: project.id,
    sessionId: "22222222-2222-4222-8222-222222222222",
    assignedAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
  };
  const fetchMock = vi.fn<FetchMock>(async (_url, init) =>
    init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(membership), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);

  expect(
    await assignSessionToProject(project.id, membership.sessionId),
  ).toEqual(membership);
  await removeSessionFromProject(project.id, membership.sessionId);
  await deleteProject(project.id, "ungroup_sessions");

  const membershipPath =
    `/api/projects/${project.id}/sessions/${membership.sessionId}`;
  expect(fetchMock.mock.calls).toEqual([
    [membershipPath, { method: "PUT" }],
    [membershipPath, { method: "DELETE" }],
    [
      `/api/projects/${project.id}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "ungroup_sessions" }),
      },
    ],
  ]);
});

test("listProjectSessions returns the selected project's enriched sessions", async () => {
  const sessions = [
    {
      id: "22222222-2222-4222-8222-222222222222",
      projectId: project.id,
      title: "Project session",
      status: "idle" as const,
      activityType: "chat" as const,
      createdAt: "2026-08-04T12:00:00.000Z",
      updatedAt: "2026-08-04T12:00:00.000Z",
    },
  ];
  const fetchMock = vi.fn<FetchMock>(async () =>
    new Response(JSON.stringify({ sessions }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);

  expect(await listProjectSessions(project.id)).toEqual(sessions);
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/projects/${project.id}/sessions`,
  );
});

test("project client surfaces the API error message", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(async () =>
      new Response(JSON.stringify({ error: "Project is archived" }), {
        status: 409,
      }),
    ),
  );

  await expect(
    assignSessionToProject(
      project.id,
      "22222222-2222-4222-8222-222222222222",
    ),
  ).rejects.toThrow("Project is archived");
});

test("project context client preserves brief text and transports shared files", async () => {
  const brief = {
    content: "# Stable facts\n\nEU launch",
    updatedAt: "2026-08-04T12:00:00.000Z",
  };
  const fileRecord = {
    name: "brief.md",
    size: 12,
    uploadedAt: brief.updatedAt,
    parseStatus: "parsed" as const,
  };
  const fetchMock = vi.fn<FetchMock>(async (url, init) => {
    if (url.endsWith("/brief")) {
      return new Response(JSON.stringify(brief), { status: 200 });
    }
    if (init?.method === "POST") {
      return new Response(JSON.stringify(fileRecord), { status: 201 });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ files: [fileRecord] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);

  expect(await getProjectBrief(project.id)).toEqual(brief);
  expect(await updateProjectBrief(project.id, brief.content)).toEqual(brief);
  expect(await listProjectFiles(project.id)).toEqual([fileRecord]);
  const source = new File(["source text"], "brief.md", { type: "text/markdown" });
  expect(await uploadProjectFile(project.id, source)).toEqual(fileRecord);
  await deleteProjectFile(project.id, fileRecord.name);

  const base = `/api/projects/${project.id}`;
  expect(fetchMock.mock.calls).toEqual([
    [`${base}/brief`],
    [
      `${base}/brief`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ content: brief.content }),
      }),
    ],
    [`${base}/files`],
    [
      `${base}/files`,
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "text/markdown",
          "x-filename": "brief.md",
        },
      }),
    ],
    [`${base}/files/brief.md`, { method: "DELETE" }],
  ]);
});

test("project catalog client loads the root before an individual session branch", async () => {
  const root = {
    version: 1 as const,
    projectId: project.id,
    sharedInputs: [],
    sessions: [],
  };
  const branch = {
    version: 1 as const,
    projectId: project.id,
    sessionId: "session-1",
    inputs: [],
    deliveries: [],
    artifacts: [],
    evidence: [],
  };
  const fetchMock = vi.fn<FetchMock>(async (url) =>
    new Response(JSON.stringify(url.endsWith("/session-1") ? branch : root), {
      status: 200,
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  expect(await getProjectCatalogRoot(project.id)).toEqual(root);
  expect(await getProjectCatalogSession(project.id, "session-1")).toEqual(branch);
  expect(fetchMock.mock.calls).toEqual([
    [`/api/projects/${project.id}/catalog`],
    [`/api/projects/${project.id}/catalog/sessions/session-1`],
  ]);
});

test("project details forwards request cancellation to fetch", async () => {
  const fetchMock = vi.fn<FetchMock>(async () =>
    new Response(JSON.stringify(projectDetails), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const controller = new AbortController();

  await (
    getProjectDetails as unknown as (
      projectId: string,
      signal: AbortSignal,
    ) => Promise<unknown>
  )(project.id, controller.signal);

  expect(fetchMock).toHaveBeenCalledWith(
    `/api/projects/${project.id}/details`,
    { signal: controller.signal },
  );
});

test("project details rejects an unsupported response version", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<FetchMock>(async () =>
      new Response(JSON.stringify({ ...projectDetails, version: 2 }), {
        status: 200,
      }),
    ),
  );

  await expect(getProjectDetails(project.id)).rejects.toThrow(
    "Unsupported project details version",
  );
});
