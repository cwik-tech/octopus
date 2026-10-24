import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FileSystemRunStore } from "../../domains/run/run-store.js";
import { startApiServer, type StartedApiServer } from "../../server/api-server.js";

test("resource mutation API creates edits attaches selects and detaches exact skills", async (t) => {
  const fixture = makeFixture();
  let server: StartedApiServer | undefined;
  t.after(async () => {
    await server?.close();
    fixture.cleanup();
  });
  server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspacePath),
    launcher: { async startRun() { return { launched: true as const, pid: 0, cwd: "" } } },
    repoRootPath: fixture.repoRoot,
    workspacePath: fixture.workspacePath,
    requireResourceLibraryMigrationApproval: false,
    resourceLibraryRootPath: fixture.libraryRoot,
  });
  const initial = await getSnapshot(server.url);
  const createdResponse = await fetch(`${server.url}/resource-library/skills`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      slug: "research",
      changeNote: "Initial skill",
      expectedGeneration: initial.generation,
      files: [
        file("SKILL.md", skillDocument("Initial instructions")),
        file("scripts/run.mjs", "old script\n", true),
      ],
    }),
  });
  assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
  const created = await createdResponse.json() as MutationPayload;
  const skillId = created.skill.id;
  const initialRevisionId = created.revision.id;

  const attachedResponse = await fetch(`${server.url}/resource-library/agents/alpha/attachments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      skillId,
      revisionId: initialRevisionId,
      alias: "research",
      expectedGeneration: initial.generation + 1,
    }),
  });
  assert.equal(attachedResponse.status, 200, await attachedResponse.clone().text());

  const editedResponse = await fetch(`${server.url}/resource-library/skills/${encodeURIComponent(skillId)}/revisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevisionId: initialRevisionId,
      changeNote: "Update only the script",
      expectedGeneration: initial.generation + 2,
      files: [
        file("SKILL.md", skillDocument("Initial instructions")),
        file("scripts/run.mjs", "new script\n", true),
      ],
    }),
  });
  assert.equal(editedResponse.status, 200, await editedResponse.clone().text());
  const edited = await editedResponse.json() as MutationPayload;
  assert.equal(
    fs.readFileSync(path.join(fixture.repoRoot, "agents", "alpha", "skills", "research", "scripts", "run.mjs"), "utf8"),
    "old script\n",
  );

  const selectedResponse = await fetch(`${server.url}/resource-library/agents/alpha/revision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      skillId,
      revisionId: edited.revision.id,
      expectedGeneration: initial.generation + 3,
    }),
  });
  assert.equal(selectedResponse.status, 200, await selectedResponse.clone().text());
  assert.equal(
    fs.readFileSync(path.join(fixture.repoRoot, "agents", "alpha", "skills", "research", "scripts", "run.mjs"), "utf8"),
    "new script\n",
  );

  const detachedResponse = await fetch(`${server.url}/resource-library/agents/alpha/attachments/research`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedGeneration: initial.generation + 4 }),
  });
  assert.equal(detachedResponse.status, 200, await detachedResponse.clone().text());
  assert.equal(fs.existsSync(path.join(fixture.repoRoot, "agents", "alpha", "skills", "research")), false);

  const staleResponse = await fetch(`${server.url}/resource-library/skills/${encodeURIComponent(skillId)}/revisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevisionId: initialRevisionId,
      changeNote: "Stale write",
      expectedGeneration: initial.generation,
      files: [file("SKILL.md", skillDocument("Stale instructions"))],
    }),
  });
  assert.equal(staleResponse.status, 409);
  const finalSnapshot = await getSnapshot(server.url);
  assert.equal(finalSnapshot.skills.find((skill) => skill.id === skillId)?.revisions.length, 2);
  assert.equal(finalSnapshot.agents.find((agent) => agent.id === "alpha")?.attachments.length, 0);
});

interface MutationPayload {
  skill: { id: string };
  revision: { id: string };
}

async function getSnapshot(baseUrl: string): Promise<{
  generation: number;
  skills: Array<{ id: string; revisions: unknown[] }>;
  agents: Array<{ id: string; attachments: unknown[] }>;
}> {
  const response = await fetch(`${baseUrl}/resource-library`);
  assert.equal(response.status, 200);
  return await response.json() as ReturnType<typeof getSnapshot> extends Promise<infer T> ? T : never;
}

function file(path: string, contents: string, executable = false) {
  return { path, contentBase64: Buffer.from(contents).toString("base64"), executable };
}

function skillDocument(instructions: string): string {
  return `---\nname: research\ndescription: Researches exactly. Use when exact research is needed.\n---\n\n# ${instructions}\n`;
}

function makeFixture(): { repoRoot: string; workspacePath: string; libraryRoot: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resource-library-mutations-"));
  const repoRoot = path.join(root, "project");
  const agentDir = path.join(repoRoot, "agents", "alpha");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "alpha.md"), "# Alpha\n");
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });
  return {
    repoRoot,
    workspacePath,
    libraryRoot: path.join(root, "library"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
