import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FileSystemRunStore } from "../../domains/run/run-store.js";
import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import { WorkspaceProjectContextStore } from "../../domains/projects/project-context-store.js";
import { WorkspaceProjectMembershipStore } from "../../domains/projects/project-membership-store.js";
import { WorkspaceProjectStore } from "../../domains/projects/project-store.js";
import { WorkspaceProjectService } from "../../domains/projects/workspace-project-service.js";
import { buildChatMessage } from "../../services/session-service.js";
import { WorkspaceProjectFileCatalogService } from "../../services/project-file-catalog-service.js";

test("project catalog loads session branches lazily and hides private runtime files", async () => {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), "project-file-catalog-"),
  );
  try {
    const sessionStore = new FileSystemSessionStore(workspacePath);
    const contextStore = new WorkspaceProjectContextStore({ workspacePath });
    const projectService = new WorkspaceProjectService({
      projectStore: new WorkspaceProjectStore({ workspacePath }),
      membershipStore: new WorkspaceProjectMembershipStore({ workspacePath }),
      projectContextStore: contextStore,
      sessionStore,
    });
    const project = await projectService.createProject({ name: "Catalog owner" });
    const session = await projectService.createSession({
      title: "Research session",
      projectId: project.id,
    });
    await contextStore.saveFile(project.id, {
      filename: "shared.pdf",
      contents: Buffer.from("project input"),
    });
    await sessionStore.saveUploadedFile(session.id, {
      filename: "notes.txt",
      contents: Buffer.from("session input"),
    });
    const task = await sessionStore.createTaskRecord(session.id, {
      workflowId: "catalog-workflow",
      brief: "Create catalog artifacts.",
      workflowYaml: "workflow:\n  id: catalog-workflow\n",
    });
    assert.ok(task?.assignmentPath);
    fs.writeFileSync(path.join(task.assignmentPath, "final.md"), "delivery");
    fs.mkdirSync(path.join(task.assignmentPath, "evidence"));
    fs.writeFileSync(
      path.join(task.assignmentPath, "evidence", "sources.json"),
      "{}",
    );
    fs.mkdirSync(path.join(task.assignmentPath, "checkpoints"));
    fs.writeFileSync(
      path.join(task.assignmentPath, "checkpoints", "private.json"),
      "secret",
    );
    await sessionStore.appendChatMessage(
      session.id,
      buildChatMessage("assistant", "Delivered.", {
        delivery: {
          taskId: task.id,
          artifacts: [
            { runId: task.runId, path: "final.md", role: "final" },
          ],
        },
      }),
    );
    const catalog = new WorkspaceProjectFileCatalogService({
      projectService,
      projectContextStore: contextStore,
      sessionStore,
      runStore: new FileSystemRunStore(workspacePath),
    });

    const originalGetSession = sessionStore.getSession.bind(sessionStore);
    let targetedSessionReads = 0;
    sessionStore.getSession = async (sessionId) => {
      targetedSessionReads += 1;
      return originalGetSession(sessionId);
    };
    sessionStore.listSessions = async () => {
      throw new Error("catalog roots must not enumerate every session");
    };

    const root = await catalog.listRoot(project.id);
    assert.deepEqual(root.sharedInputs.map((file) => file.name), ["shared.pdf"]);
    assert.deepEqual(root.sessions.map((entry) => entry.title), ["Research session"]);
    assert.doesNotMatch(JSON.stringify(root), /final\.md/);
    assert.equal(targetedSessionReads, 1);

    targetedSessionReads = 0;
    const branch = await catalog.listSessionBranch(project.id, session.id);
    assert.deepEqual(branch.inputs.map((file) => file.name), ["notes.txt"]);
    assert.deepEqual(branch.deliveries.map((file) => file.name), ["final.md"]);
    assert.deepEqual(branch.evidence.map((file) => file.name), ["sources.json"]);
    assert.equal(
      [...branch.artifacts, ...branch.evidence, ...branch.deliveries].some(
        (file) => file.resource.resourcePath.includes("checkpoints"),
      ),
      false,
    );
    const serialized = JSON.stringify(branch);
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(workspacePath)));
    assert.doesNotMatch(serialized, /assignmentPath|runPath|input-snapshot/);
    assert.equal(targetedSessionReads, 1);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
