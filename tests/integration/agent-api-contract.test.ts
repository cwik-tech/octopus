import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { startApiServer } from "../../server/api-server.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-api-contract-"));
}

function personaMarkdown(name: string, uiHidden = false): string {
  return [
    "---",
    `name: ${name}`,
    "description: Sample agent.",
    "tier: execution",
    "provider: openai",
    "model: gpt-5.4-mini",
    "thinking: medium",
    ...(uiHidden ? ["ui_hidden: true"] : []),
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n");
}

function writeAgent(repoRoot: string, name: string, uiHidden = false): void {
  const agentDir = path.join(repoRoot, "agents", name);
  fs.mkdirSync(path.join(agentDir, "skills", "sample-skill"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(agentDir, `${name}.md`),
    personaMarkdown(name, uiHidden),
  );
  fs.writeFileSync(
    path.join(agentDir, "skills", "sample-skill", "SKILL.md"),
    [
      "---",
      "name: sample-skill",
      "description: Sample skill.",
      "---",
      "",
      "# Sample Skill",
      "",
    ].join("\n"),
  );
}

function writeTeam(repoRoot: string): void {
  fs.mkdirSync(path.join(repoRoot, "teams", "sample-team"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "teams.yaml"),
    [
      "sample-team:",
      "  type: team",
      "  description: Sample team.",
      "  team_path: ./teams/sample-team",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(repoRoot, "teams", "sample-team", "team.yaml"),
    [
      "team:",
      "  name: sample-team",
      "  description: Sample team.",
      "agents: []",
      "levels: []",
      "",
    ].join("\n"),
  );
}

async function withAgentServer(
  fn: (base: string, repoRoot: string) => Promise<void>,
): Promise<void> {
  const workspacePath = makeWorkspace();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-api-repo-"));
  writeTeam(repoRoot);
  writeAgent(repoRoot, "sample-agent");
  writeAgent(repoRoot, "runtime-router", true);

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 1, cwd: workspacePath };
      },
    },
    repoRootPath: repoRoot,
  });

  try {
    await fn(server.url, repoRoot);
  } finally {
    await server.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("agent API contract covers library, package, team, save, and delete operations", async () => {
  await withAgentServer(async (base, repoRoot) => {
    const listResponse = await fetch(`${base}/create/agents`);
    const listPayload = (await listResponse.json()) as {
      agents: Array<{ name: string; skills: string[] }>;
    };
    assert.equal(listResponse.status, 200);
    assert.deepEqual(listPayload.agents.map((agent) => agent.name), [
      "sample-agent",
    ]);
    assert.deepEqual(listPayload.agents[0]?.skills, ["sample-skill"]);

    const internalListResponse = await fetch(
      `${base}/create/agents?include_hidden=1`,
    );
    const internalListPayload = (await internalListResponse.json()) as {
      agents: Array<{ name: string; uiHidden?: boolean }>;
    };
    assert.equal(internalListResponse.status, 200);
    assert.deepEqual(
      internalListPayload.agents.map((agent) => agent.name),
      ["runtime-router", "sample-agent"],
    );
    assert.equal(internalListPayload.agents[0]?.uiHidden, true);

    const readResponse = await fetch(`${base}/create/agents/sample-agent`);
    const readPayload = (await readResponse.json()) as {
      agentName: string;
      personaMarkdown: string;
      counts: { skills: number; templates: number };
    };
    assert.equal(readResponse.status, 200);
    assert.equal(readPayload.agentName, "sample-agent");
    assert.match(readPayload.personaMarkdown, /# sample-agent/);
    assert.equal(readPayload.counts.skills, 1);

    const saveResponse = await fetch(`${base}/create/agents/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentName: "sample-agent",
        personaMarkdown: personaMarkdown("sample-agent").replace(
          "# sample-agent",
          "# Updated Agent",
        ),
      }),
    });
    const savePayload = (await saveResponse.json()) as { personaPath: string };
    assert.equal(saveResponse.status, 200);
    assert.match(savePayload.personaPath, /sample-agent\.md$/);

    const addPackageResponse = await fetch(
      `${base}/create/agents/package/add`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentName: "sample-agent",
          kind: "template",
          files: [
            {
              relativePath: "brief.md",
              contentBase64: Buffer.from("# Brief\n").toString("base64"),
            },
          ],
        }),
      },
    );
    const addPackagePayload = (await addPackageResponse.json()) as {
      counts: { templates: number };
    };
    assert.equal(addPackageResponse.status, 200);
    assert.equal(addPackagePayload.counts.templates, 1);

    const importPreviewResponse = await fetch(
      `${base}/create/agents/package/import-preview`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentName: "sample-agent",
          kind: "reference",
          files: [
            {
              relativePath: "references/source.md",
              contentBase64: Buffer.from("# Source\n").toString("base64"),
            },
          ],
        }),
      },
    );
    const importPreviewPayload = (await importPreviewResponse.json()) as {
      items: Array<{ kind: string; targetAgentPath: string }>;
    };
    assert.equal(importPreviewResponse.status, 200);
    assert.deepEqual(importPreviewPayload.items.map((item) => item.kind), [
      "reference",
    ]);

    const addToTeamResponse = await fetch(`${base}/create/agents/add-to-team`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentName: "sample-agent",
        teamId: "sample-team",
        role: "Researcher",
      }),
    });
    const addToTeamPayload = (await addToTeamResponse.json()) as {
      added: boolean;
      agentName: string;
      teamId: string;
    };
    assert.equal(addToTeamResponse.status, 200);
    assert.equal(addToTeamPayload.added, true);
    assert.equal(addToTeamPayload.agentName, "sample-agent");
    assert.equal(addToTeamPayload.teamId, "sample-team");

    const previewDeleteResponse = await fetch(
      `${base}/create/agents/sample-agent/delete-preview`,
    );
    const previewDeletePayload = (await previewDeleteResponse.json()) as {
      agentName: string;
      skills: Array<{ name: string }>;
    };
    assert.equal(previewDeleteResponse.status, 200);
    assert.equal(previewDeletePayload.agentName, "sample-agent");
    assert.deepEqual(
      previewDeletePayload.skills.map((skill) => skill.name),
      ["sample-skill"],
    );

    const deleteResponse = await fetch(`${base}/create/agents/sample-agent`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deleteSkills: false }),
    });
    const deletePayload = (await deleteResponse.json()) as {
      deleted: boolean;
      agentName: string;
    };
    assert.equal(deleteResponse.status, 200);
    assert.equal(deletePayload.deleted, true);
    assert.equal(deletePayload.agentName, "sample-agent");
    assert.equal(
      fs.existsSync(path.join(repoRoot, "agents", "sample-agent")),
      false,
    );
  });
});

test("agent API contract maps service validation errors to JSON responses", async () => {
  await withAgentServer(async (base) => {
    const response = await fetch(`${base}/create/agents/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentName: "sample-agent" }),
    });
    const payload = (await response.json()) as { error: string };

    assert.equal(response.status, 400);
    assert.equal(
      payload.error,
      "Field personaMarkdown is required and must be a string",
    );
  });
});
