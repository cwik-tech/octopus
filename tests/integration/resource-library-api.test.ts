import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FileSystemRunStore } from "../../domains/run/run-store.js";
import { startApiServer, type StartedApiServer } from "../../server/api-server.js";

test("resource API browses migrated skills agents and teams with exact revision files", async (t) => {
  const fixture = makeFixture();
  let server: StartedApiServer | undefined;
  t.after(async () => {
    await server?.close();
    fixture.cleanup();
  });
  const skillDir = path.join(fixture.repoRoot, "agents", "spec-alpha", "skills", "research");
  fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: research\ndescription: Researches exactly. Use when exact research is needed.\n---\n\n# Shared instructions\n",
  );
  fs.writeFileSync(path.join(skillDir, "scripts", "run.mjs"), "console.log('shared');\n");

  server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspacePath),
    launcher: { async startRun() { return { launched: true as const, pid: 0, cwd: "" } } },
    repoRootPath: fixture.repoRoot,
    workspacePath: fixture.workspacePath,
    requireResourceLibraryMigrationApproval: false,
    resourceLibraryRootPath: fixture.libraryRoot,
  });
  const response = await fetch(`${server.url}/resource-library`);
  assert.equal(response.status, 200, await response.clone().text());
  const snapshot = await response.json() as {
    generation: number;
    skills: Array<{ id: string; slug: string; currentRevisionId: string }>;
    agents: Array<{ id: string; attachments: Array<{ alias: string; revisionId: string }> }>;
    agentDetails: Array<{ name: string }>;
    teamDetails: Array<{ id: string; agents: Array<{ name: string }> }>;
  };
  assert.equal(snapshot.generation, 1);
  const skill = snapshot.skills.find((candidate) => candidate.slug === "research");
  assert.ok(skill);
  const agent = snapshot.agents.find((candidate) => candidate.id === "spec-alpha");
  assert.equal(agent?.attachments[0]?.alias, "research");
  assert.equal(agent?.attachments[0]?.revisionId, skill.currentRevisionId);
  assert.ok(snapshot.agentDetails.some((candidate) => candidate.name === "spec-alpha"));
  const team = snapshot.teamDetails.find((candidate) => candidate.id === "board-team");
  assert.ok(team?.agents.some((candidate) => candidate.name === "board-lead"));

  const filesResponse = await fetch(
    `${server.url}/resource-library/skills/${encodeURIComponent(skill.id)}/revisions/${encodeURIComponent(skill.currentRevisionId)}/files`,
  );
  assert.equal(filesResponse.status, 200, await filesResponse.clone().text());
  const files = await filesResponse.json() as {
    files: Array<{ path: string; contentBase64: string; executable: boolean }>;
  };
  assert.equal(
    Buffer.from(files.files.find((file) => file.path === "SKILL.md")?.contentBase64 ?? "", "base64").toString("utf8"),
    "---\nname: research\ndescription: Researches exactly. Use when exact research is needed.\n---\n\n# Shared instructions\n",
  );
  assert.equal(
    Buffer.from(files.files.find((file) => file.path === "scripts/run.mjs")?.contentBase64 ?? "", "base64").toString("utf8"),
    "console.log('shared');\n",
  );
});

function makeFixture(): { repoRoot: string; workspacePath: string; libraryRoot: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resource-library-api-"));
  const repoRoot = path.join(root, "project");
  fs.cpSync(path.resolve("tests/fixtures/team-chat-e2e"), repoRoot, { recursive: true });
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });
  return {
    repoRoot,
    workspacePath,
    libraryRoot: path.join(root, "library"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
