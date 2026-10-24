import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { WorkspaceProjectMembershipStore } from "../../domains/projects/project-membership-store.js";
import { WorkspaceProjectStore } from "../../domains/projects/project-store.js";
import {
  WorkspaceProjectService,
  WorkspaceProjectServiceError,
} from "../../domains/projects/workspace-project-service.js";
import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import { hasProjectScheduleReferenceInFile } from "../../services/schedule-service.js";

test("workspace project service joins memberships with real session summaries", async () => {
  const fixture = await makeFixture();
  try {
    const project = await fixture.service.createProject({ name: "Acme" });
    const firstSession = await fixture.sessionStore.createSession({
      title: "Market research",
    });
    const secondSession = await fixture.sessionStore.createSession({
      title: "Pricing strategy",
    });

    await fixture.service.assignSession(project.id, firstSession.id);
    await fixture.service.assignSession(project.id, secondSession.id);

    const [summary] = await fixture.service.listProjects();
    assert.equal(summary?.sessionCount, 2);
    assert.equal(summary?.activeSessionCount, 0);
    assert.equal(summary?.latestActivityAt, secondSession.updatedAt);
    assert.deepEqual(
      (await fixture.service.listProjectSessions(project.id)).map(
        (session) => session.projectId,
      ),
      [project.id, project.id],
    );
    assert.equal(
      (await fixture.service.getSession(firstSession.id))?.projectId,
      project.id,
    );

    await fixture.service.removeSession(project.id, firstSession.id);
    assert.equal(
      (await fixture.service.getSession(firstSession.id))?.projectId,
      undefined,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("workspace project reads hydrate only sessions named by memberships", async () => {
  const fixture = await makeFixture();
  try {
    const project = await fixture.service.createProject({ name: "Targeted" });
    const otherProject = await fixture.service.createProject({ name: "Other" });
    const ownedSession = await fixture.sessionStore.createSession({
      title: "Owned session",
    });
    const unrelatedSession = await fixture.sessionStore.createSession({
      title: "Unrelated session",
    });
    await fixture.service.assignSession(project.id, ownedSession.id);
    await fixture.service.assignSession(otherProject.id, unrelatedSession.id);

    const originalGetSession = fixture.sessionStore.getSession.bind(
      fixture.sessionStore,
    );
    const requestedSessionIds: string[] = [];
    fixture.sessionStore.getSession = async (sessionId) => {
      requestedSessionIds.push(sessionId);
      return originalGetSession(sessionId);
    };
    fixture.sessionStore.listSessions = async () => {
      throw new Error("project reads must not enumerate every session");
    };

    const projectSummary = await fixture.service.getProject(project.id);
    const projectSessions = await fixture.service.listProjectSessions(project.id);

    assert.equal(projectSummary.sessionCount, 1);
    assert.deepEqual(projectSessions.map((session) => session.id), [ownedSession.id]);
    assert.equal(requestedSessionIds.includes(unrelatedSession.id), false);
  } finally {
    await fixture.cleanup();
  }
});

test("project collection summaries hydrate only sessions with memberships", async () => {
  const fixture = await makeFixture();
  try {
    const project = await fixture.service.createProject({ name: "Targeted list" });
    const ownedSession = await fixture.sessionStore.createSession({
      title: "Owned session",
    });
    const unrelatedSession = await fixture.sessionStore.createSession({
      title: "Unrelated session",
    });
    await fixture.service.assignSession(project.id, ownedSession.id);

    const originalGetSession = fixture.sessionStore.getSession.bind(
      fixture.sessionStore,
    );
    const requestedSessionIds: string[] = [];
    fixture.sessionStore.getSession = async (sessionId) => {
      requestedSessionIds.push(sessionId);
      return originalGetSession(sessionId);
    };
    fixture.sessionStore.listSessions = async () => {
      throw new Error("project summaries must not enumerate every session");
    };

    const [summary] = await fixture.service.listProjects();

    assert.equal(summary?.sessionCount, 1);
    assert.deepEqual(requestedSessionIds, [ownedSession.id]);
    assert.equal(requestedSessionIds.includes(unrelatedSession.id), false);
  } finally {
    await fixture.cleanup();
  }
});

test("workspace project hydration bounds concurrent session metadata reads", async () => {
  const fixture = await makeFixture();
  try {
    const project = await fixture.service.createProject({ name: "Large project" });
    for (let index = 0; index < 32; index += 1) {
      const session = await fixture.sessionStore.createSession({
        title: `Session ${index + 1}`,
      });
      await fixture.service.assignSession(project.id, session.id);
    }
    const originalGetSession = fixture.sessionStore.getSession.bind(
      fixture.sessionStore,
    );
    let activeReads = 0;
    let maximumActiveReads = 0;
    fixture.sessionStore.getSession = async (sessionId) => {
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return await originalGetSession(sessionId);
      } finally {
        activeReads -= 1;
      }
    };

    const sessions = await fixture.service.listProjectSessions(project.id);

    assert.equal(sessions.length, 32);
    assert.ok(maximumActiveReads <= 16, `observed ${maximumActiveReads} reads`);
  } finally {
    await fixture.cleanup();
  }
});

test("workspace project service atomically moves a session between active projects", async () => {
  const fixture = await makeFixture();
  try {
    const first = await fixture.service.createProject({ name: "First" });
    const second = await fixture.service.createProject({ name: "Second" });
    const session = await fixture.sessionStore.createSession();

    await fixture.service.assignSession(first.id, session.id);
    const moved = await fixture.service.assignSession(second.id, session.id);

    assert.equal(moved.projectId, second.id);
    assert.deepEqual(await fixture.service.listProjectSessions(first.id), []);
    assert.deepEqual(
      (await fixture.service.listProjectSessions(second.id)).map(
        (entry) => entry.id,
      ),
      [session.id],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("workspace project service rejects assignment to archived projects", async () => {
  const fixture = await makeFixture();
  try {
    const project = await fixture.service.createProject({ name: "Archived" });
    const session = await fixture.sessionStore.createSession();
    await fixture.service.archiveProject(project.id);

    await assert.rejects(
      fixture.service.assignSession(project.id, session.id),
      hasServiceError("archived_project"),
    );
    assert.equal(await fixture.membershipStore.get(session.id), null);
  } finally {
    await fixture.cleanup();
  }
});

test("workspace project service guards hard deletion until memberships are removed", async () => {
  const fixture = await makeFixture();
  try {
    const project = await fixture.service.createProject({ name: "Guarded" });
    const session = await fixture.sessionStore.createSession();
    await fixture.service.assignSession(project.id, session.id);

    await assert.rejects(
      fixture.service.hardDeleteProject(project.id),
      hasServiceError("project_not_empty"),
    );
    await fixture.service.removeSession(project.id, session.id);
    assert.equal(await fixture.service.hardDeleteProject(project.id), true);
  } finally {
    await fixture.cleanup();
  }
});

test("workspace project service blocks hard deletion while a real schedule file references it", async () => {
  const fixture = await makeFixture();
  try {
    const schedulePath = path.join(
      fixture.workspacePath,
      "task-queue",
      "schedules.json",
    );
    const service = new WorkspaceProjectService({
      projectStore: fixture.projectStore,
      membershipStore: fixture.membershipStore,
      sessionStore: fixture.sessionStore,
      hasBlockingReference: (projectId) =>
        hasProjectScheduleReferenceInFile(schedulePath, projectId),
    });
    const project = await service.createProject({ name: "Scheduled" });
    await fs.mkdir(path.dirname(schedulePath), { recursive: true });
    await fs.writeFile(
      schedulePath,
      JSON.stringify({ version: 1, schedules: [{ projectId: project.id }] }),
    );

    await assert.rejects(
      service.hardDeleteProject(project.id),
      hasServiceError("project_not_empty"),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("workspace project service creates a project-owned session without changing SessionStore ownership", async () => {
  const fixture = await makeFixture();
  try {
    const project = await fixture.service.createProject({ name: "Owned" });
    const created = await fixture.service.createSession({
      title: "Project chat",
      projectId: project.id,
    });

    assert.equal(created.title, "Project chat");
    assert.equal(created.projectId, project.id);
    assert.ok(
      await fs.stat(
        path.join(
          fixture.workspacePath,
          "sessions",
          created.id,
          "session.json",
        ),
      ),
    );
    assert.equal(
      await fs.stat(
        path.join(
          fixture.workspacePath,
          "project-memberships",
          `${created.id}.json`,
        ),
      ).then((stat) => stat.isFile()),
      true,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("workspace project service hides membership when its project is missing", async () => {
  const fixture = await makeFixture();
  try {
    const project = await fixture.service.createProject({ name: "Missing" });
    const session = await fixture.sessionStore.createSession();
    await fixture.service.assignSession(project.id, session.id);
    await fixture.projectStore.hardDelete(project.id);

    assert.equal(
      (await fixture.service.getSession(session.id))?.projectId,
      undefined,
    );
    assert.equal(
      (await fixture.service.listSessions())[0]?.projectId,
      undefined,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("workspace project service ignores orphan membership when hard deleting a project", async () => {
  const fixture = await makeFixture();
  try {
    const project = await fixture.service.createProject({ name: "Orphan" });
    const session = await fixture.sessionStore.createSession();
    await fixture.service.assignSession(project.id, session.id);
    await fixture.sessionStore.deleteSession(session.id);

    assert.equal(await fixture.service.hardDeleteProject(project.id), true);
  } finally {
    await fixture.cleanup();
  }
});

test("project session deletion leaves every session intact when any owned task is active", async () => {
  const fixture = await makeFixture();
  try {
    const project = await fixture.service.createProject({ name: "Active work" });
    const sessions = [
      await fixture.sessionStore.createSession({ title: "First" }),
      await fixture.sessionStore.createSession({ title: "Second" }),
    ].sort((left, right) => left.id.localeCompare(right.id));
    for (const session of sessions) {
      await fixture.service.assignSession(project.id, session.id);
    }
    const activeTask = await fixture.sessionStore.createTaskRecord(sessions[1]!.id, {
      workflowId: "active-project-work",
      brief: "Keep all project sessions until this task is cancelled",
      workflowYaml: "workflow:\n  id: active-project-work\n",
    });
    assert.ok(activeTask);

    await assert.rejects(
      fixture.service.deleteProject(project.id, "delete_sessions"),
      hasServiceError("project_not_empty"),
    );

    assert.ok(await fixture.sessionStore.getSession(sessions[0]!.id));
    assert.ok(await fixture.sessionStore.getSession(sessions[1]!.id));
    assert.ok(await fixture.projectStore.get(project.id));
  } finally {
    await fixture.cleanup();
  }
});

function hasServiceError(code: WorkspaceProjectServiceError["code"]) {
  return (error: unknown): boolean =>
    error instanceof WorkspaceProjectServiceError && error.code === code;
}

async function makeFixture() {
  const workspacePath = await fs.mkdtemp(
    path.join(os.tmpdir(), "workspace-project-service-"),
  );
  const sessionStore = new FileSystemSessionStore(workspacePath);
  const projectStore = new WorkspaceProjectStore({ workspacePath });
  const membershipStore = new WorkspaceProjectMembershipStore({ workspacePath });
  const service = new WorkspaceProjectService({
    projectStore,
    membershipStore,
    sessionStore,
  });
  return {
    workspacePath,
    sessionStore,
    projectStore,
    membershipStore,
    service,
    cleanup: () => fs.rm(workspacePath, { recursive: true, force: true }),
  };
}
