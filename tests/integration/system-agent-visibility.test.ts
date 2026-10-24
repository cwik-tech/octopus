import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { startApiServer } from "../../server/api-server.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";

/**
 * "Not selectable as a Run target" and "not listed in the library" were one
 * flag, and the front door needs them apart: it must stay out of the Agent
 * picker while staying open in Create, because a persona nobody can edit is
 * the thing making it an agent was supposed to fix.
 */

function personaMarkdown(name: string, marker?: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: Sample agent.",
    "tier: execution",
    "provider: openai",
    "model: gpt-5.4-mini",
    "thinking: medium",
    ...(marker ? [marker] : []),
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n");
}

function writeAgent(repoRoot: string, name: string, marker?: string): void {
  const agentDir = path.join(repoRoot, "agents", name);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, `${name}.md`), personaMarkdown(name, marker));
}

async function withAgentServer(
  fn: (base: string, repoRoot: string) => Promise<void>,
): Promise<void> {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), "system-agent-workspace-"),
  );
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "system-agent-repo-"));
  writeAgent(repoRoot, "sample-agent");
  writeAgent(repoRoot, "runtime-router", "ui_hidden: true");
  writeAgent(repoRoot, "general-agent", "system: true");

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

async function listNames(
  base: string,
  query = "",
): Promise<Array<{ name: string; system?: boolean; uiHidden?: boolean }>> {
  const response = await fetch(`${base}/create/agents${query}`);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    agents: Array<{ name: string; system?: boolean; uiHidden?: boolean }>;
  };
  return payload.agents;
}

test("a system agent is not offered as a Run target", async () => {
  await withAgentServer(async (base) => {
    const agents = await listNames(base);

    assert.deepEqual(
      agents.map((agent) => agent.name),
      ["sample-agent"],
      "the default catalog is the Run picker's, and holds neither marker",
    );
  });
});

test("a system agent is listed for Create, and says so", async () => {
  await withAgentServer(async (base) => {
    const agents = await listNames(base, "?include_system=1");

    assert.deepEqual(
      agents.map((agent) => agent.name),
      ["general-agent", "sample-agent"],
      "Create lists system agents; ui_hidden agents stay hidden",
    );
    assert.equal(
      agents.find((agent) => agent.name === "general-agent")?.system,
      true,
    );
  });
});

test("a hidden agent stays hidden from Create", async () => {
  await withAgentServer(async (base) => {
    const agents = await listNames(base, "?include_system=1");

    assert.equal(
      agents.some((agent) => agent.name === "runtime-router"),
      false,
      "include_system must not smuggle in ui_hidden agents",
    );
  });
});

test("a system agent's persona can be read and saved from Create", async () => {
  await withAgentServer(async (base, repoRoot) => {
    const readResponse = await fetch(`${base}/create/agents/general-agent`);
    assert.equal(readResponse.status, 200);
    const readPayload = (await readResponse.json()) as {
      agentName: string;
      system?: boolean;
      personaMarkdown: string;
    };
    assert.equal(readPayload.agentName, "general-agent");
    assert.equal(readPayload.system, true);

    const edited = personaMarkdown("general-agent", "system: true").replace(
      "# general-agent",
      "# Edited front door",
    );
    const saveResponse = await fetch(`${base}/create/agents/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentName: "general-agent",
        personaMarkdown: edited,
      }),
    });
    assert.equal(saveResponse.status, 200, await saveResponse.clone().text());

    const onDisk = fs.readFileSync(
      path.join(repoRoot, "agents", "general-agent", "general-agent.md"),
      "utf8",
    );
    assert.match(onDisk, /# Edited front door/);
  });
});
