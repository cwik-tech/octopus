/**
 * Outer acceptance loop for vertical capability 1: adding library and newly
 * generated Agents to an existing Team from chat.
 *
 * One coherent user journey: the user names an existing Team and the Agents to
 * add, reviews the returned update proposal, authorizes it with a stored-plan
 * build request, and finds the Team's roster and entry discussion updated while
 * every unrelated part of `team.yaml` survives untouched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { startApiServer } from "../../server/api-server.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";

const EXISTING_TEAM_ID = "contract-review-team";
const LIBRARY_AGENT = "scoping-lawyer";
const NEW_AGENT = "drafting-completeness-lawyer";
const SEEDED_ROSTER_AGENT = "michigan-contract-lawyer";
const CUSTOM_TEAM_MARKER = "CUSTOM-ESCALATION-CONTRACT";

interface ResourceBuildJobView {
  status: string;
  error?: string;
  selectedResource: { kind: string; id: string } | null;
  items: Array<{
    planIndex: number;
    status: string;
    plannedResource: { kind: string; id: string };
    resource?: { kind: string; id: string };
    error?: string;
  }>;
  events: Array<{ id: number; type: string; message: string }>;
}

function makeDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Entries of the first explicit `participants:` block, and nothing after it. */
function participantNames(yaml: string): string[] {
  const lines = yaml.split("\n");
  const keyIndex = lines.findIndex((line) => /^\s*participants:\s*$/.test(line));
  if (keyIndex < 0) return [];
  const keyIndent = lines[keyIndex]!.match(/^\s*/)![0].length;
  const names: string[] = [];
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const entry = lines[index]!.match(/^(\s*)- (.*)$/);
    if (!entry || entry[1]!.length <= keyIndent) break;
    names.push(entry[2]!.trim().replace(/"/g, ""));
  }
  return names;
}

function persona(name: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} description.`,
    "tier: specialist",
    "provider: openai",
    "model: local-test-model",
    "thinking: medium",
    "tools: none",
    "---",
    "",
    `# ${name}`,
    "",
    `Perform the ${name} assignment.`,
    "",
  ].join("\n");
}

function writeAgent(repoRoot: string, name: string): void {
  const agentDir = path.join(repoRoot, "agents", name);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, `${name}.md`), persona(name));
}

function writeArchitectConfig(repoRoot: string): void {
  for (const architect of ["workflow-architect", "resource-architect"]) {
    const teamDir = path.join(repoRoot, "teams", architect);
    const agentDir = path.join(repoRoot, "agents", architect);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, "team.yaml"),
      [
        "team:",
        `  name: ${architect}`,
        "agents:",
        `  - name: ${architect}`,
        `    agent_file: ../../agents/${architect}/${architect}.md`,
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(agentDir, `${architect}.md`),
      // The architect runs with its own agent file's pair.
      "---\nprovider: openai\nmodel: local-test-model\n---\n\n" + (architect === "resource-architect"
        ? "RESOURCE_ARCHITECT_RESPONSE_SCHEMA\n"
        : "Create one complete Agent package from the brief.\n"),
    );
  }
}

/**
 * A Team the update path did not create: no `created_by_orchestrator` marker,
 * an explicit discussion entry stage, and a custom gate block that no update
 * may rewrite.
 */
function writeExistingTeam(repoRoot: string): string {
  const teamDir = path.join(repoRoot, "teams", EXISTING_TEAM_ID);
  fs.mkdirSync(teamDir, { recursive: true });
  const yaml = [
    "team:",
    `  name: "${EXISTING_TEAM_ID}"`,
    "  description: >",
    "    Reviews contracts from complementary legal perspectives.",
    '  version: "0.1.0"',
    "defaults: {}",
    "",
    "workflow:",
    "  entry_level: review",
    "  invocation_modes:",
    "    - user",
    "  user_facing: true",
    "",
    "",
    "agents:",
    `  - name: "${SEEDED_ROSTER_AGENT}"`,
    "    type: agent",
    "    role: >",
    "      Michigan contract reviewer",
    "    tier: strategic",
    "    tools: []",
    `    agent_file: "../../agents/${SEEDED_ROSTER_AGENT}/${SEEDED_ROSTER_AGENT}.md"`,
    "    experience_enabled: true",
    "",
    "levels:",
    "  - id: review",
    "    name: Review",
    "    order: 0",
    "    stage:",
    "      type: discussion",
    `      coordinator: "${SEEDED_ROSTER_AGENT}"`,
    "      participants:",
    `        - "${SEEDED_ROSTER_AGENT}"`,
    "      config:",
    "        mode: brainstorm",
    "        min_rounds: 1",
    "        max_rounds: 2",
    "",
    "gates:",
    "  - from: review",
    "    to: done",
    "    condition:",
    "      type: artifact_exists",
    `      artifact: "${CUSTOM_TEAM_MARKER}.md"`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(teamDir, "team.yaml"), yaml);
  fs.writeFileSync(
    path.join(repoRoot, "teams.yaml"),
    [
      `${EXISTING_TEAM_ID}:`,
      "  type: team",
      "  description: Reviews contracts.",
      `  team_path: ./teams/${EXISTING_TEAM_ID}`,
      "  tags: []",
      "",
    ].join("\n"),
  );
  return yaml;
}

interface ProviderHarness {
  close(): Promise<void>;
  url: string;
  generationCount(): number;
}

async function startProviderHarness(): Promise<ProviderHarness> {
  let generationCount = 0;
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const system = body.messages?.find((message) => message.role === "system")
        ?.content ?? "";
      const lastUser = [...(body.messages ?? [])]
        .reverse()
        .find((message) => message.role === "user")?.content ?? "";

      let content: string;
      if (system.trimStart().startsWith("RESOURCE_ARCHITECT_RESPONSE_SCHEMA")) {
        content = JSON.stringify({
          message: `I will add two Agents to ${EXISTING_TEAM_ID}.`,
          // No `expectedRevision` anywhere: the server owns Team revisions.
          outcome: {
            id: "team-update-proposal",
            kind: "resource_updates",
            operations: [
              {
                kind: "add_team_agents",
                target: { kind: "team", id: EXISTING_TEAM_ID },
                libraryAgentsToAdd: [
                  {
                    name: LIBRARY_AGENT,
                    role: "Scope reviewer",
                    tier: "strategic",
                    rationale: "Reuse the existing scope specialist.",
                  },
                ],
                newAgentsToCreate: [
                  {
                    name: NEW_AGENT,
                    role: "Drafting completeness reviewer",
                    tier: "strategic",
                    summary: "Finds drafting gaps before a contract is signed.",
                    description: "Checks drafting completeness.",
                    rationale: "No existing Agent covers drafting gaps.",
                    documentSpecialization: null,
                  },
                ],
              },
            ],
          },
          warnings: [],
        });
      } else {
        generationCount += 1;
        const plannedName =
          lastUser.match(/Planned Agent name:\s*`([^`]+)`/i)?.[1] ?? NEW_AGENT;
        content = JSON.stringify({
          message: `Created ${plannedName}.`,
          suggestedName: plannedName,
          personaMarkdown: persona(plannedName),
          generatedSkills: [
            {
              name: `${plannedName}-review`,
              body: [
                "---",
                `name: ${plannedName}-review`,
                "description: >",
                "  Review a contract draft for missing clauses and unresolved",
                "  cross-references. Use when a contract draft needs a",
                "  completeness pass before signature.",
                "---",
                "",
                "# Review",
                "",
                "Check every clause reference resolves.",
                "",
              ].join("\n"),
            },
          ],
        });
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "local-test-model",
          choices: [{ message: { content } }],
        }),
      );
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    generationCount: () => generationCount,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

test("chat adds library and new Agents to an existing Team only after the user applies the update", async () => {
  const workspacePath = makeDirectory("team-update-workspace-");
  const repoRoot = makeDirectory("team-update-repo-");
  const provider = await startProviderHarness();
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousApiUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = provider.url;
  writeArchitectConfig(repoRoot);
  writeAgent(repoRoot, SEEDED_ROSTER_AGENT);
  writeAgent(repoRoot, LIBRARY_AGENT);
  const originalTeamYaml = writeExistingTeam(repoRoot);
  const teamYamlPath = path.join(repoRoot, "teams", EXISTING_TEAM_ID, "team.yaml");

  const api = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 1, cwd: workspacePath };
      },
    },
    workspacePath,
    repoRootPath: repoRoot,
  });

  try {
    // Arrange / Act — the proposal turn.
    const turnResponse = await fetch(`${api.url}/create/resource-architect/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "proposal",
        history: [{
          role: "user",
          text:
            `Add ${LIBRARY_AGENT} and a new ${NEW_AGENT} to the ${EXISTING_TEAM_ID} team.`,
        }],
      }),
    });
    const turn = (await turnResponse.json()) as {
      outcome: {
        id: string;
        kind: string;
        operations: Array<{
          kind: string;
          target: { kind: string; id: string };
          expectedRevision: string;
          libraryAgentsToAdd: Array<{ name: string }>;
          newAgentsToCreate: Array<{ name: string }>;
        }>;
      };
    };

    // Assert — a buildable update plan, with a server-owned revision.
    assert.equal(turnResponse.status, 200);
    assert.equal(turn.outcome.kind, "resource_updates", JSON.stringify(turn, null, 2));
    assert.equal(turn.outcome.operations.length, 1);
    const operation = turn.outcome.operations[0]!;
    assert.equal(operation.kind, "add_team_agents");
    assert.deepEqual(operation.target, { kind: "team", id: EXISTING_TEAM_ID });
    assert.match(operation.expectedRevision, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(
      operation.libraryAgentsToAdd.map((agent) => agent.name),
      [LIBRARY_AGENT],
    );
    assert.deepEqual(
      operation.newAgentsToCreate.map((agent) => agent.name),
      [NEW_AGENT],
    );

    // Assert — nothing was written before the user authorized the update.
    assert.equal(fs.readFileSync(teamYamlPath, "utf8"), originalTeamYaml);
    assert.equal(fs.existsSync(path.join(repoRoot, "agents", NEW_AGENT)), false);
    assert.equal(provider.generationCount(), 0);

    // Act — the user applies the update.
    const buildResponse = await fetch(`${api.url}/create/resource-architect/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId: turn.outcome.id }),
    });
    assert.equal(buildResponse.status, 202);
    const build = (await buildResponse.json()) as { jobId: string };

    let job: ResourceBuildJobView | null = null;
    for (let attempt = 0; attempt < 1_500; attempt += 1) {
      const response = await fetch(
        `${api.url}/create/resource-architect/jobs/${encodeURIComponent(build.jobId)}`,
      );
      job = ((await response.json()) as { job: ResourceBuildJobView }).job;
      if (job.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // Assert — the job reports the update truthfully.
    assert.equal(job?.status, "completed", JSON.stringify(job, null, 2));
    assert.deepEqual(
      job?.items.map((item) => ({
        planned: item.plannedResource,
        status: item.status,
        resource: item.resource,
      })),
      [{
        planned: { kind: "team", id: EXISTING_TEAM_ID },
        status: "updated",
        resource: { kind: "team", id: EXISTING_TEAM_ID },
      }],
    );
    assert.deepEqual(job?.selectedResource, {
      kind: "team",
      id: EXISTING_TEAM_ID,
    });
    const eventTypes = job?.events.map((event) => event.type) ?? [];
    assert.ok(
      eventTypes.includes("resource_update_started"),
      `expected a started update event: ${eventTypes.join(", ")}`,
    );
    assert.ok(
      eventTypes.includes("agent_created"),
      `expected the new Agent to be reported as created: ${eventTypes.join(", ")}`,
    );
    assert.ok(
      eventTypes.includes("agent_added"),
      `expected roster additions to be reported: ${eventTypes.join(", ")}`,
    );
    assert.ok(
      eventTypes.includes("resource_update_applied"),
      `expected an applied update event: ${eventTypes.join(", ")}`,
    );
    assert.equal(
      eventTypes.includes("team_created"),
      false,
      "an update must never claim it created the Team",
    );

    // Assert — the Team was updated in place, and nothing unrelated moved.
    assert.equal(fs.existsSync(path.join(repoRoot, "agents", NEW_AGENT)), true);
    const updatedYaml = fs.readFileSync(teamYamlPath, "utf8");
    assert.ok(
      updatedYaml.includes(CUSTOM_TEAM_MARKER),
      "the custom gate block must survive the update",
    );
    assert.equal(
      updatedYaml.includes("created_by_orchestrator"),
      false,
      "an update must never claim creation ownership of an existing Team",
    );
    assert.ok(updatedYaml.includes("entry_level: review"));
    const roster = updatedYaml
      .matchAll(/^ {2}- name: "([^"]+)"$/gmu);
    assert.deepEqual(
      [...roster].map((match) => match[1]),
      [SEEDED_ROSTER_AGENT, LIBRARY_AGENT, NEW_AGENT],
    );
    assert.deepEqual(
      participantNames(updatedYaml),
      [SEEDED_ROSTER_AGENT, LIBRARY_AGENT, NEW_AGENT],
      "every added Agent joins the explicit entry discussion",
    );
    assert.deepEqual(
      fs.readdirSync(path.join(repoRoot, "teams")).sort(),
      [EXISTING_TEAM_ID, "resource-architect", "workflow-architect"],
      "an update must not create, rename, or delete a Team folder",
    );
  } finally {
    await api.close();
    await provider.close();
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousApiUrl === undefined) {
      delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    } else {
      process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousApiUrl;
    }
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
