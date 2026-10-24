import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FileSystemRunStore } from "../../domains/run/run-store.js";
import { startApiServer, type StartedApiServer } from "../../server/api-server.js";

test("existing Create package publication registers the new Agent skill in Library", async (t) => {
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
  const added = await fetch(`${server.url}/create/agents/package/add`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentName: "alpha",
      kind: "skill",
      files: [{
        relativePath: "research/SKILL.md",
        contentBase64: Buffer.from("---\nname: research\ndescription: Researches exactly. Use when exact research is needed.\n---\n\n# Research\n").toString("base64"),
      }],
    }),
  });
  assert.equal(added.status, 200, await added.clone().text());

  const snapshot = await (await fetch(`${server.url}/resource-library`)).json() as {
    agents: Array<{ id: string; attachments: Array<{ alias: string }> }>;
  };
  assert.equal(snapshot.agents.find((agent) => agent.id === "alpha")?.attachments[0]?.alias, "research");
});

function makeFixture(): { repoRoot: string; workspacePath: string; libraryRoot: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resource-library-create-"));
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
