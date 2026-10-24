import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  WorkspaceProject,
  WorkspaceProjectCatalogRoot,
  WorkspaceProjectCatalogSessionBranch,
  WorkspaceProjectExport,
  WorkspaceProjectMemoryProposal,
  WorkspaceProjectMembership,
} from "../../contracts/projects.js";
import type { SessionSummary } from "../../contracts/sessions.js";
import type { RunPlan } from "../../contracts/run-plan.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";
import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import { startApiServer } from "../../server/api-server.js";
import { SourceFileParserLauncher } from "../../core/file-parser-launcher.js";
import { WorkspaceProjectService } from "../../domains/projects/workspace-project-service.js";
import { WorkspaceProjectStore } from "../../domains/projects/project-store.js";
import { WorkspaceProjectMembershipStore } from "../../domains/projects/project-membership-store.js";
import { WorkspaceProjectContextStore } from "../../domains/projects/project-context-store.js";
import { buildWorkspaceProjectChatContext } from "../../services/project-context-service.js";
import { MIXED_OCR_FIXTURE } from "../../file-parser/tests/mixed-ocr-expectations.js";

async function withProjectServer(
  run: (
    baseUrl: string,
    workspacePath: string,
    sessionStore: FileSystemSessionStore,
  ) => Promise<void>,
): Promise<void> {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), "projects-api-"),
  );
  const sessionStore = new FileSystemSessionStore(workspacePath);
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 0, cwd: "" };
      },
    },
    sessionStore,
    fileParserLauncher: new SourceFileParserLauncher(process.cwd()),
    workspacePath,
  });

  try {
    await run(server.url, workspacePath, sessionStore);
  } finally {
    await server.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
}

test("project brief and shared-file reads avoid global session enumeration", async () => {
  await withProjectServer(async (baseUrl, _workspacePath, sessionStore) => {
    const createResponse = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fast context" }),
    });
    const project = (await createResponse.json()) as WorkspaceProject;
    let globalSessionReads = 0;
    const originalListSessions = sessionStore.listSessions.bind(sessionStore);
    sessionStore.listSessions = async () => {
      globalSessionReads += 1;
      return originalListSessions();
    };

    const briefResponse = await fetch(`${baseUrl}/projects/${project.id}/brief`);
    const filesResponse = await fetch(`${baseUrl}/projects/${project.id}/files`);

    assert.equal(briefResponse.status, 200);
    assert.equal(filesResponse.status, 200);
    assert.equal(globalSessionReads, 0);
  });
});

test("GET /projects/:projectId/details returns the complete initial Library payload", async () => {
  await withProjectServer(async (baseUrl, _workspacePath, sessionStore) => {
    const createResponse = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Aggregate details" }),
    });
    const project = (await createResponse.json()) as WorkspaceProject;
    const sessionResponse = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Owned session", projectId: project.id }),
    });
    const session = (await sessionResponse.json()) as SessionSummary;
    await fetch(`${baseUrl}/projects/${project.id}/brief`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Stable project context" }),
    });
    await fetch(`${baseUrl}/projects/${project.id}/files`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-filename": "source.txt",
      },
      body: "source material",
    });
    let globalSessionReads = 0;
    const originalListSessions = sessionStore.listSessions.bind(sessionStore);
    sessionStore.listSessions = async () => {
      globalSessionReads += 1;
      return originalListSessions();
    };

    const response = await fetch(`${baseUrl}/projects/${project.id}/details`);

    assert.equal(response.status, 200);
    const details = (await response.json()) as {
      project: WorkspaceProject & { sessionCount: number };
      brief: { content: string };
      files: Array<{ name: string }>;
      catalog: WorkspaceProjectCatalogRoot;
      sessions: SessionSummary[];
      schedules: unknown[];
      memoryProposals: WorkspaceProjectMemoryProposal[];
    };
    assert.equal(details.project.sessionCount, 1);
    assert.equal(details.brief.content, "Stable project context");
    assert.deepEqual(details.files.map((file) => file.name), ["source.txt"]);
    assert.deepEqual(details.catalog.sessions.map((entry) => entry.id), [session.id]);
    assert.deepEqual(details.sessions.map((entry) => entry.id), [session.id]);
    assert.deepEqual(details.schedules, []);
    assert.deepEqual(details.memoryProposals, []);
    assert.equal(globalSessionReads, 0);
  });
});

test("POST /projects creates and durably stores a normalized project", async () => {
  await withProjectServer(async (baseUrl, workspacePath) => {
    const response = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "  Acme launch  ",
        description: "Customer launch workspace",
      }),
    });

    assert.equal(response.status, 201);
    const project = (await response.json()) as WorkspaceProject;
    assert.equal(project.name, "Acme launch");
    assert.equal(project.description, "Customer launch workspace");
    assert.equal(project.status, "active");
    assert.match(project.id, /^[0-9a-f-]{36}$/);

    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(workspacePath, "projects", project.id, "project.json"),
        "utf8",
      ),
    ) as WorkspaceProject;
    assert.deepEqual(persisted, project);
  });
});

test("GET /projects lists active projects with derived session counts", async () => {
  await withProjectServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Northwind" }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as WorkspaceProject;

    const response = await fetch(`${baseUrl}/projects`);

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      projects: Array<WorkspaceProject & {
        sessionCount: number;
        activeSessionCount: number;
      }>;
    };
    assert.deepEqual(body.projects, [
      {
        ...created,
        sessionCount: 0,
        activeSessionCount: 0,
      },
    ]);
  });
});

test("GET /projects/:projectId returns the project summary and rejects unsafe IDs", async () => {
  await withProjectServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme" }),
    });
    const created = (await createResponse.json()) as WorkspaceProject;

    const response = await fetch(`${baseUrl}/projects/${created.id}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ...created,
      sessionCount: 0,
      activeSessionCount: 0,
    });

    const unsafeResponse = await fetch(`${baseUrl}/projects/not-a-uuid`);
    assert.equal(unsafeResponse.status, 400);
    assert.deepEqual(await unsafeResponse.json(), {
      error: "Invalid project id",
    });
  });
});

test("PATCH /projects/:projectId updates persisted project metadata", async () => {
  await withProjectServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Old name" }),
    });
    const created = (await createResponse.json()) as WorkspaceProject;

    const response = await fetch(`${baseUrl}/projects/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "  New name  ",
        description: "Updated brief",
      }),
    });

    assert.equal(response.status, 200);
    const updated = (await response.json()) as WorkspaceProject;
    assert.equal(updated.name, "New name");
    assert.equal(updated.description, "Updated brief");
    assert.notEqual(updated.updatedAt, created.updatedAt);

    const detailResponse = await fetch(`${baseUrl}/projects/${created.id}`);
    const detail = (await detailResponse.json()) as WorkspaceProject;
    assert.equal(detail.name, "New name");
    assert.equal(detail.description, "Updated brief");
  });
});

test("PATCH /projects/:projectId archives and restores project visibility", async () => {
  await withProjectServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Seasonal campaign" }),
    });
    const created = (await createResponse.json()) as WorkspaceProject;

    const archiveResponse = await fetch(`${baseUrl}/projects/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });
    assert.equal(archiveResponse.status, 200);
    const archived = (await archiveResponse.json()) as WorkspaceProject;
    assert.equal(archived.status, "archived");
    assert.equal(typeof archived.archivedAt, "string");

    const activeList = (await (
      await fetch(`${baseUrl}/projects`)
    ).json()) as { projects: WorkspaceProject[] };
    assert.deepEqual(activeList.projects, []);

    const allListResponse = await fetch(
      `${baseUrl}/projects?includeArchived=true`,
    );
    assert.equal(allListResponse.status, 200);
    const allList = (await allListResponse.json()) as {
      projects: WorkspaceProject[];
    };
    assert.equal(allList.projects[0]?.id, created.id);
    assert.equal(allList.projects[0]?.status, "archived");

    const restoreResponse = await fetch(`${baseUrl}/projects/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    assert.equal(restoreResponse.status, 200);
    const restored = (await restoreResponse.json()) as WorkspaceProject;
    assert.equal(restored.status, "active");
    assert.equal(restored.archivedAt, undefined);
  });
});

test("PUT /projects/:projectId/sessions/:sessionId durably assigns a session", async () => {
  await withProjectServer(async (baseUrl, workspacePath) => {
    const projectResponse = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Client work" }),
    });
    const project = (await projectResponse.json()) as WorkspaceProject;
    const sessionResponse = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Discovery" }),
    });
    const session = (await sessionResponse.json()) as SessionSummary;

    const response = await fetch(
      `${baseUrl}/projects/${project.id}/sessions/${session.id}`,
      { method: "PUT" },
    );

    assert.equal(response.status, 200);
    const membership = (await response.json()) as WorkspaceProjectMembership;
    assert.equal(membership.version, 1);
    assert.equal(membership.projectId, project.id);
    assert.equal(membership.sessionId, session.id);

    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(
          workspacePath,
          "project-memberships",
          `${session.id}.json`,
        ),
        "utf8",
      ),
    ) as WorkspaceProjectMembership;
    assert.deepEqual(persisted, membership);
  });
});

test("project membership is projected through project and session read APIs", async () => {
  await withProjectServer(async (baseUrl, workspacePath) => {
    const project = (await (
      await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Projected work" }),
      })
    ).json()) as WorkspaceProject;
    const session = (await (
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Planning" }),
      })
    ).json()) as SessionSummary;
    await fetch(`${baseUrl}/projects/${project.id}/sessions/${session.id}`, {
      method: "PUT",
    });

    const projectSessionsResponse = await fetch(
      `${baseUrl}/projects/${project.id}/sessions`,
    );
    assert.equal(projectSessionsResponse.status, 200);
    const projectSessions = (await projectSessionsResponse.json()) as {
      sessions: SessionSummary[];
    };
    assert.equal(projectSessions.sessions[0]?.projectId, project.id);

    const sessionList = (await (
      await fetch(`${baseUrl}/sessions`)
    ).json()) as { sessions: SessionSummary[] };
    assert.equal(sessionList.sessions[0]?.projectId, project.id);

    const detail = (await (
      await fetch(`${baseUrl}/sessions/${session.id}`)
    ).json()) as SessionSummary;
    assert.equal(detail.projectId, project.id);

    const physicalSession = JSON.parse(
      fs.readFileSync(
        path.join(workspacePath, "sessions", session.id, "session.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.equal(physicalSession.projectId, undefined);
  });
});

test("POST /sessions with projectId creates an enriched project-owned session", async () => {
  await withProjectServer(async (baseUrl, workspacePath) => {
    const project = (await (
      await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "New chat project" }),
      })
    ).json()) as WorkspaceProject;

    const response = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Project kickoff",
        projectId: project.id,
      }),
    });

    assert.equal(response.status, 201);
    const session = (await response.json()) as SessionSummary;
    assert.equal(session.title, "Project kickoff");
    assert.equal(session.projectId, project.id);
    assert.equal(
      fs.existsSync(
        path.join(
          workspacePath,
          "project-memberships",
          `${session.id}.json`,
        ),
      ),
      true,
    );
  });
});

test("POST /sessions rejects unavailable projects without leaving a session", async () => {
  await withProjectServer(async (baseUrl) => {
    const project = (await (
      await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Archived work" }),
      })
    ).json()) as WorkspaceProject;
    await fetch(`${baseUrl}/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });

    const archivedResponse = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Rejected", projectId: project.id }),
    });
    assert.equal(archivedResponse.status, 409);
    assert.equal(
      ((await archivedResponse.json()) as { code?: string }).code,
      "archived_project",
    );

    const missingResponse = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Also rejected",
        projectId: "00000000-0000-4000-8000-000000000099",
      }),
    });
    assert.equal(missingResponse.status, 404);
    assert.equal(
      ((await missingResponse.json()) as { code?: string }).code,
      "project_not_found",
    );

    const sessions = (await (
      await fetch(`${baseUrl}/sessions`)
    ).json()) as { sessions: SessionSummary[] };
    assert.deepEqual(sessions.sessions, []);
  });
});

test("DELETE project membership unassigns but preserves the session", async () => {
  await withProjectServer(async (baseUrl, workspacePath) => {
    const project = (await (
      await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Temporary grouping" }),
      })
    ).json()) as WorkspaceProject;
    const session = (await (
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Keep me", projectId: project.id }),
      })
    ).json()) as SessionSummary;

    const response = await fetch(
      `${baseUrl}/projects/${project.id}/sessions/${session.id}`,
      { method: "DELETE" },
    );

    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assert.equal(
      fs.existsSync(
        path.join(
          workspacePath,
          "project-memberships",
          `${session.id}.json`,
        ),
      ),
      false,
    );
    const detailResponse = await fetch(`${baseUrl}/sessions/${session.id}`);
    assert.equal(detailResponse.status, 200);
    const detail = (await detailResponse.json()) as SessionSummary;
    assert.equal(detail.projectId, undefined);
  });
});

test("DELETE /projects/:projectId refuses members and deletes an empty project", async () => {
  await withProjectServer(async (baseUrl) => {
    const project = (await (
      await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Delete carefully" }),
      })
    ).json()) as WorkspaceProject;
    const session = (await (
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Owned", projectId: project.id }),
      })
    ).json()) as SessionSummary;

    const guardedResponse = await fetch(`${baseUrl}/projects/${project.id}`, {
      method: "DELETE",
    });
    assert.equal(guardedResponse.status, 409);
    assert.equal(
      ((await guardedResponse.json()) as { code?: string }).code,
      "project_not_empty",
    );

    await fetch(
      `${baseUrl}/projects/${project.id}/sessions/${session.id}`,
      { method: "DELETE" },
    );
    const deleteResponse = await fetch(`${baseUrl}/projects/${project.id}`, {
      method: "DELETE",
    });
    assert.equal(deleteResponse.status, 204);
    assert.equal(await deleteResponse.text(), "");

    assert.equal(
      (await fetch(`${baseUrl}/projects/${project.id}`)).status,
      404,
    );
    assert.equal((await fetch(`${baseUrl}/sessions/${session.id}`)).status, 200);
  });
});

test("DELETE /projects/:projectId can leave owned sessions ungrouped", async () => {
  await withProjectServer(async (baseUrl, workspacePath) => {
    const project = (await (
      await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Preserve sessions" }),
      })
    ).json()) as WorkspaceProject;
    const session = (await (
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Keep this chat", projectId: project.id }),
      })
    ).json()) as SessionSummary;
    await fetch(`${baseUrl}/projects/${project.id}/brief`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Project-only data" }),
    });

    const response = await fetch(`${baseUrl}/projects/${project.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "ungroup_sessions" }),
    });

    assert.equal(response.status, 204);
    assert.equal(fs.existsSync(path.join(workspacePath, "projects", project.id)), false);
    assert.equal(
      fs.existsSync(
        path.join(workspacePath, "project-memberships", `${session.id}.json`),
      ),
      false,
    );
    const preserved = await fetch(`${baseUrl}/sessions/${session.id}`);
    assert.equal(preserved.status, 200);
    assert.equal(((await preserved.json()) as SessionSummary).projectId, undefined);
  });
});

test("DELETE /projects/:projectId can delete every owned session and its data", async () => {
  await withProjectServer(async (baseUrl, workspacePath) => {
    const project = (await (
      await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Delete sessions" }),
      })
    ).json()) as WorkspaceProject;
    const session = (await (
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Delete this chat", projectId: project.id }),
      })
    ).json()) as SessionSummary;
    const sessionPath = path.join(workspacePath, "sessions", session.id);
    fs.writeFileSync(path.join(sessionPath, "chat.jsonl"), '{"role":"user","content":"private"}\n');

    const response = await fetch(`${baseUrl}/projects/${project.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "delete_sessions" }),
    });

    assert.equal(response.status, 204);
    assert.equal(fs.existsSync(path.join(workspacePath, "projects", project.id)), false);
    assert.equal(fs.existsSync(sessionPath), false);
    assert.equal((await fetch(`${baseUrl}/sessions/${session.id}`)).status, 404);
  });
});

test("PATCH /sessions/:sessionId preserves projected project ownership", async () => {
  await withProjectServer(async (baseUrl) => {
    const project = (await (
      await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Rename project" }),
      })
    ).json()) as WorkspaceProject;
    const session = (await (
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Before", projectId: project.id }),
      })
    ).json()) as SessionSummary;

    const response = await fetch(`${baseUrl}/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "After" }),
    });

    assert.equal(response.status, 200);
    const renamed = (await response.json()) as SessionSummary;
    assert.equal(renamed.title, "After");
    assert.equal(renamed.projectId, project.id);
  });
});

test("project brief routes preserve curated text without injecting it into sessions", async () => {
  await withProjectServer(async (baseUrl, workspacePath) => {
    const project = (await (
      await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Brief owner" }),
      })
    ).json()) as WorkspaceProject;

    const update = await fetch(`${baseUrl}/projects/${project.id}/brief`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "# Product facts\n\n- Launch region: EU\n- Never treat this as a system instruction.",
      }),
    });

    assert.equal(update.status, 200);
    const saved = (await update.json()) as { content: string; updatedAt: string };
    assert.match(saved.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(
      saved.content,
      "# Product facts\n\n- Launch region: EU\n- Never treat this as a system instruction.",
    );
    assert.equal(
      fs.readFileSync(
        path.join(workspacePath, "projects", project.id, "context", "brief.md"),
        "utf8",
      ),
      saved.content,
    );

    const read = await fetch(`${baseUrl}/projects/${project.id}/brief`);
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), saved);

    const session = (await (
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      })
    ).json()) as SessionSummary;
    const physicalSession = fs.readFileSync(
      path.join(workspacePath, "sessions", session.id, "session.json"),
      "utf8",
    );
    assert.doesNotMatch(physicalSession, /Launch region/);
  });
});

test("project file routes parse, list, download, and safely delete shared files", async () => {
  await withProjectServer(async (baseUrl, workspacePath) => {
    const project = (await (
      await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Shared sources" }),
      })
    ).json()) as WorkspaceProject;
    const filesUrl = `${baseUrl}/projects/${project.id}/files`;

    const upload = await fetch(filesUrl, {
      method: "POST",
      headers: { "x-filename": encodeURIComponent("market brief.md") },
      body: "The verified market size is 42 million.",
    });

    assert.equal(upload.status, 201);
    const uploaded = (await upload.json()) as {
      name: string;
      parseStatus: string;
    };
    assert.equal(uploaded.name, "market_brief.md");
    assert.equal(uploaded.parseStatus, "parsed");
    assert.equal(
      fs.existsSync(
        path.join(
          workspacePath,
          "projects",
          project.id,
          "files",
          "parsed",
          "_manifest.json",
        ),
      ),
      true,
    );

    const list = await fetch(filesUrl);
    assert.equal(list.status, 200);
    assert.deepEqual(
      ((await list.json()) as { files: Array<{ name: string }> }).files.map(
        (file) => file.name,
      ),
      ["market_brief.md"],
    );

    const download = await fetch(`${filesUrl}/market_brief.md`);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "The verified market size is 42 million.");
    assert.match(download.headers.get("content-type") ?? "", /text\/markdown/);

    const duplicate = await fetch(filesUrl, {
      method: "POST",
      headers: { "x-filename": encodeURIComponent("market brief.md") },
      body: "replacement",
    });
    assert.equal(duplicate.status, 409);

    const unsafe = await fetch(`${filesUrl}/..%2Fproject.json`);
    assert.equal(unsafe.status, 400);

    const guardedDelete = await fetch(`${baseUrl}/projects/${project.id}`, {
      method: "DELETE",
    });
    assert.equal(guardedDelete.status, 409);

    const deleted = await fetch(`${filesUrl}/market_brief.md`, {
      method: "DELETE",
    });
    assert.equal(deleted.status, 204);
    assert.deepEqual(await (await fetch(filesUrl)).json(), { files: [] });
  });
});

test("project catalog routes expose a lazy logical file tree without physical paths", async () => {
  await withProjectServer(async (baseUrl, workspacePath) => {
    const project = (await (
      await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Catalog API" }),
      })
    ).json()) as WorkspaceProject;
    const session = (await (
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Catalog session", projectId: project.id }),
      })
    ).json()) as SessionSummary;
    const uploaded = await fetch(`${baseUrl}/projects/${project.id}/files`, {
      method: "POST",
      headers: { "x-filename": "source.pdf" },
      body: "source",
    });
    assert.equal(uploaded.status, 201);

    const rootResponse = await fetch(
      `${baseUrl}/projects/${project.id}/catalog`,
    );
    assert.equal(rootResponse.status, 200);
    const root = (await rootResponse.json()) as WorkspaceProjectCatalogRoot;
    assert.deepEqual(root.sharedInputs.map((entry) => entry.name), ["source.pdf"]);
    assert.deepEqual(root.sessions.map((entry) => entry.id), [session.id]);

    const branchResponse = await fetch(
      `${baseUrl}/projects/${project.id}/catalog/sessions/${session.id}`,
    );
    assert.equal(branchResponse.status, 200);
    const branch = (await branchResponse.json()) as WorkspaceProjectCatalogSessionBranch;
    assert.equal(branch.projectId, project.id);
    assert.equal(branch.sessionId, session.id);
    assert.doesNotMatch(JSON.stringify({ root, branch }), new RegExp(escapeRegExp(workspacePath)));
  });
});

test("project memory proposals require project ownership and explicit API approval", async () => {
  await withProjectServer(async (baseUrl, workspacePath) => {
    const project = (await (
      await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Durable knowledge" }),
      })
    ).json()) as WorkspaceProject;
    const otherProject = (await (
      await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Other owner" }),
      })
    ).json()) as WorkspaceProject;
    const session = (await (
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Source", projectId: project.id }),
      })
    ).json()) as SessionSummary;

    const wrongOwner = await fetch(
      `${baseUrl}/projects/${otherProject.id}/memory-proposals`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "This must not cross project boundaries.",
          sourceSessionId: session.id,
        }),
      },
    );
    assert.equal(wrongOwner.status, 409);

    const create = await fetch(
      `${baseUrl}/projects/${project.id}/memory-proposals`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "  The customer approved the European launch.  ",
          sourceSessionId: session.id,
        }),
      },
    );
    assert.equal(create.status, 201);
    const pending = (await create.json()) as WorkspaceProjectMemoryProposal;
    assert.equal(pending.status, "pending");
    assert.equal(pending.content, "The customer approved the European launch.");

    const beforeApproval = await fetch(
      `${baseUrl}/projects/${project.id}/memory-proposals?status=approved`,
    );
    assert.deepEqual(await beforeApproval.json(), { proposals: [] });

    const approve = await fetch(
      `${baseUrl}/projects/${project.id}/memory-proposals/${pending.id}/approve`,
      { method: "POST" },
    );
    assert.equal(approve.status, 200);
    const approved = (await approve.json()) as WorkspaceProjectMemoryProposal;
    assert.equal(approved.status, "approved");

    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(
          workspacePath,
          "projects",
          project.id,
          "context",
          "memory-proposals",
          `${pending.id}.json`,
        ),
        "utf8",
      ),
    ) as WorkspaceProjectMemoryProposal;
    assert.deepEqual(persisted, approved);
  });
});

test("DELETE /projects/:projectId refuses durable memory proposals", async () => {
  await withProjectServer(async (baseUrl) => {
    const project = (await (
      await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Remembered project" }),
      })
    ).json()) as WorkspaceProject;
    const proposal = await fetch(
      `${baseUrl}/projects/${project.id}/memory-proposals`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "A durable project decision" }),
      },
    );
    assert.equal(proposal.status, 201);

    const response = await fetch(`${baseUrl}/projects/${project.id}`, {
      method: "DELETE",
    });

    assert.equal(response.status, 409);
    assert.equal(
      ((await response.json()) as { code?: string }).code,
      "project_not_empty",
    );
  });
});

test("GET /projects/:projectId/export returns portable project data without physical paths", async () => {
  await withProjectServer(async (baseUrl, workspacePath) => {
    const project = (await (
      await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Portable project" }),
      })
    ).json()) as WorkspaceProject;
    await fetch(`${baseUrl}/projects/${project.id}/brief`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "# Exported brief" }),
    });
    await fetch(`${baseUrl}/projects/${project.id}/files`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-filename": "source.txt",
      },
      body: "portable source",
    });
    const session = (await (
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Exported session", projectId: project.id }),
      })
    ).json()) as SessionSummary;
    const pending = (await (
      await fetch(`${baseUrl}/projects/${project.id}/memory-proposals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Approved fact", sourceSessionId: session.id }),
      })
    ).json()) as WorkspaceProjectMemoryProposal;
    await fetch(
      `${baseUrl}/projects/${project.id}/memory-proposals/${pending.id}/approve`,
      { method: "POST" },
    );

    const response = await fetch(`${baseUrl}/projects/${project.id}/export`);

    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-disposition") ?? "",
      /attachment; filename\*=UTF-8''portable-project\.workspace-project\.json/,
    );
    const exported = (await response.json()) as WorkspaceProjectExport;
    assert.equal(exported.version, 1);
    assert.equal(exported.project.id, project.id);
    assert.equal(exported.brief?.content, "# Exported brief");
    assert.equal(exported.sessions[0]?.id, session.id);
    assert.equal(exported.memoryProposals[0]?.status, "approved");
    assert.equal(exported.files[0]?.name, "source.txt");
    assert.equal(
      Buffer.from(exported.files[0]?.contentBase64 ?? "", "base64").toString("utf8"),
      "portable source",
    );
    assert.match(exported.files[0]?.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(exported).includes(workspacePath), false);
  });
});

test("session messages accept context only from their project and persist the selection on the RunPlan", async () => {
  await withProjectServer(async (baseUrl) => {
    const owner = (await (
      await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Owner project" }),
      })
    ).json()) as WorkspaceProject;
    const other = (await (
      await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Other project" }),
      })
    ).json()) as WorkspaceProject;
    const session = (await (
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Scoped chat", projectId: owner.id }),
      })
    ).json()) as SessionSummary;

    const rejected = await fetch(`${baseUrl}/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Use another project's context",
        provider: "provider-without-registered-credentials",
        projectContext: {
          projectId: other.id,
          includeBrief: false,
          fileNames: [],
        },
      }),
    });
    assert.equal(rejected.status, 400);
    assert.match(
      ((await rejected.json()) as { error: string }).error,
      /does not belong/i,
    );

    const selection = {
      projectId: owner.id,
      includeBrief: false,
      fileNames: [] as string[],
    };
    const accepted = await fetch(`${baseUrl}/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Use my project context",
        provider: "provider-without-registered-credentials",
        projectContext: selection,
      }),
    });

    assert.equal(accepted.status, 201);
    const body = (await accepted.json()) as { plan: RunPlan };
    assert.deepEqual(body.plan.projectContext, selection);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("a Library project PDF is recognized locally and reaches selected project context", async () => {
  await withProjectServer(async (baseUrl, workspacePath, sessionStore) => {
    const project = (await (
      await fetch(`${baseUrl}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Operating plan" }),
      })
    ).json()) as WorkspaceProject;

    const uploaded = await fetch(`${baseUrl}/projects/${project.id}/files`, {
      method: "POST",
      headers: { "x-filename": encodeURIComponent(MIXED_OCR_FIXTURE.fileName) },
      body: new Uint8Array(
        fs.readFileSync(
          path.join(
            process.cwd(),
            "file-parser",
            "tests",
            "fixtures",
            MIXED_OCR_FIXTURE.fileName,
          ),
        ),
      ),
    });
    assert.equal(uploaded.status, 201);
    assert.equal((await uploaded.json() as { parseStatus: string }).parseStatus, "parsed");

    const session = (await (
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Plan questions", projectId: project.id }),
      })
    ).json()) as SessionSummary;

    const context = await buildWorkspaceProjectChatContext({
      sessionId: session.id,
      selection: {
        projectId: project.id,
        includeBrief: false,
        fileNames: [MIXED_OCR_FIXTURE.fileName],
      },
      projectService: new WorkspaceProjectService({
        projectStore: new WorkspaceProjectStore({ workspacePath }),
        membershipStore: new WorkspaceProjectMembershipStore({ workspacePath }),
        projectContextStore: new WorkspaceProjectContextStore({ workspacePath }),
        sessionStore,
      }),
      contextStore: new WorkspaceProjectContextStore({ workspacePath }),
    });

    assert.ok(
      context.includes(MIXED_OCR_FIXTURE.page10.salesMarketing2028),
      "Selected project context must carry the value that exists only as pixels on page 10",
    );
  });
});
