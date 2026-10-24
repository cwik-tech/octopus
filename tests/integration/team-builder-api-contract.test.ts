import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { startApiServer } from "../../server/api-server.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "team-builder-api-contract-"));
}

function writeAgent(
  repoRoot: string,
  name: string,
  marker?: "ui_hidden" | "system",
): void {
  const agentDir = path.join(repoRoot, "agents", name);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, `${name}.md`),
    [
      "---",
      `name: ${name}`,
      "description: Sample analyst.",
      "tier: execution",
      "provider: openai",
      "model: gpt-5.4-mini",
      "thinking: medium",
      ...(marker ? [`${marker}: true`] : []),
      "---",
      "",
      "# Sample Analyst",
      "",
    ].join("\n"),
  );
}

async function withTeamBuilderServer(
  fn: (base: string, repoRoot: string) => Promise<void>,
): Promise<void> {
  const workspacePath = makeWorkspace();
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "team-builder-api-repo-"),
  );
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  writeAgent(repoRoot, "sample-agent");
  writeAgent(repoRoot, "runtime-router", "ui_hidden");
  writeAgent(repoRoot, "general-agent", "system");

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

test("team-builder API contract covers team CRUD and roster mutations", async () => {
  await withTeamBuilderServer(async (base, repoRoot) => {
    const createResponse = await fetch(`${base}/create/team-builder/teams`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "sample-team",
        description: "Sample team.",
        tags: ["public"],
      }),
    });
    const createPayload = (await createResponse.json()) as {
      team: { id: string; description: string; yaml: string };
    };
    assert.equal(createResponse.status, 201);
    assert.equal(createPayload.team.id, "sample-team");
    assert.match(createPayload.team.yaml, /name: "sample-team"/);

    const readResponse = await fetch(
      `${base}/create/team-builder/teams/sample-team`,
    );
    const readPayload = (await readResponse.json()) as {
      team: { id: string };
    };
    assert.equal(readResponse.status, 200);
    assert.equal(readPayload.team.id, "sample-team");

    const updateResponse = await fetch(
      `${base}/create/team-builder/teams/sample-team`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "renamed-team",
          description: "Renamed team.",
          tags: ["updated"],
        }),
      },
    );
    const updatePayload = (await updateResponse.json()) as {
      team: { id: string; description: string };
    };
    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.team.id, "renamed-team");
    assert.equal(updatePayload.team.description, "Renamed team.");

    const addAgentResponse = await fetch(
      `${base}/create/team-builder/teams/renamed-team/agents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentName: "sample-agent",
          role: "Researcher",
        }),
      },
    );
    const addAgentPayload = (await addAgentResponse.json()) as {
      team: { agents: Array<{ name: string; role: string }> };
    };
    assert.equal(addAgentResponse.status, 200);
    assert.deepEqual(addAgentPayload.team.agents.map((agent) => agent.name), [
      "sample-agent",
    ]);

    const addHiddenAgentResponse = await fetch(
      `${base}/create/team-builder/teams/renamed-team/agents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentName: "runtime-router",
          role: "Internal router",
        }),
      },
    );
    const addHiddenAgentPayload = (await addHiddenAgentResponse.json()) as {
      team: { agents: Array<{ name: string }> };
    };
    assert.equal(addHiddenAgentResponse.status, 200);
    assert.deepEqual(
      addHiddenAgentPayload.team.agents.map((agent) => agent.name),
      ["sample-agent"],
    );
    assert.match(
      fs.readFileSync(
        path.join(repoRoot, "teams", "renamed-team", "team.yaml"),
        "utf8",
      ),
      /name: "runtime-router"/,
    );

    const removeAgentResponse = await fetch(
      `${base}/create/team-builder/teams/renamed-team/agents/sample-agent`,
      { method: "DELETE" },
    );
    const removeAgentPayload = (await removeAgentResponse.json()) as {
      team: { agents: Array<{ name: string }> };
    };
    assert.equal(removeAgentResponse.status, 200);
    assert.deepEqual(removeAgentPayload.team.agents, []);

    const listResponse = await fetch(`${base}/create/team-builder/teams`);
    const listPayload = (await listResponse.json()) as {
      teams: Array<{ id: string }>;
    };
    assert.equal(listResponse.status, 200);
    assert.deepEqual(listPayload.teams.map((team) => team.id), ["renamed-team"]);

    const deleteResponse = await fetch(
      `${base}/create/team-builder/teams/renamed-team`,
      { method: "DELETE" },
    );
    const deletePayload = (await deleteResponse.json()) as { deleted: boolean };
    assert.equal(deleteResponse.status, 200);
    assert.equal(deletePayload.deleted, true);
    assert.equal(fs.existsSync(path.join(repoRoot, "teams", "renamed-team")), false);
  });
});

test("team-builder API contract maps validation errors to JSON responses", async () => {
  await withTeamBuilderServer(async (base) => {
    const response = await fetch(`${base}/create/team-builder/teams`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "bad-team", tags: "public" }),
    });
    const payload = (await response.json()) as { error: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, "Field tags must be an array");
  });
});

test("team-builder API refuses to write retired Team runtime settings", async () => {
  // Returning success for a setting that no longer changes anything would be
  // worse than failing: the user would believe the team pins a model.
  await withTeamBuilderServer(async (base) => {
    const withModels = await fetch(`${base}/create/team-builder/teams`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "grade-team",
        models: { strategic: { model: "gpt-5.4-mini", thinking: "medium" } },
      }),
    });
    const modelsPayload = (await withModels.json()) as { error: string };
    assert.equal(withModels.status, 400);
    assert.match(modelsPayload.error, /models/);
    assert.match(modelsPayload.error, /agent/i);

    const withDefaultProvider = await fetch(`${base}/create/team-builder/teams`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "provider-team", defaultProvider: "openai" }),
    });
    const providerPayload = (await withDefaultProvider.json()) as {
      error: string;
    };
    assert.equal(withDefaultProvider.status, 400);
    assert.match(providerPayload.error, /defaultProvider/);
  });
});

test("team-builder API refuses a member provider/model override", async () => {
  await withTeamBuilderServer(async (base) => {
    await fetch(`${base}/create/team-builder/teams`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "member-team" }),
    });

    const response = await fetch(
      `${base}/create/team-builder/teams/member-team/agents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentName: "sample-agent",
          role: "Researcher",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        }),
      },
    );
    const payload = (await response.json()) as { error: string };
    assert.equal(response.status, 400);
    assert.match(payload.error, /model/);
  });
});

test("adding an existing agent saves its reference, not its current model", async () => {
  await withTeamBuilderServer(async (base, repoRoot) => {
    await fetch(`${base}/create/team-builder/teams`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "reference-team" }),
    });

    const response = await fetch(
      `${base}/create/team-builder/teams/reference-team/agents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentName: "sample-agent",
          role: "Researcher",
        }),
      },
    );
    assert.equal(response.status, 200);

    // The agent's persona says openai/gpt-5.4-mini. Copying that into the
    // roster would freeze today's choice and diverge the moment the agent is
    // edited, so team.yaml must carry only the reference and the role.
    const yaml = fs.readFileSync(
      path.join(repoRoot, "teams", "reference-team", "team.yaml"),
      "utf8",
    );
    assert.match(yaml, /name: "sample-agent"/);
    assert.doesNotMatch(yaml, /gpt-5\.4-mini/);
    assert.doesNotMatch(yaml, /^\s*provider:/m);
    assert.doesNotMatch(yaml, /^models:/m);
  });
});

test("a legacy team.yaml keeps its bytes and stops deciding models", async () => {
  await withTeamBuilderServer(async (base, repoRoot) => {
    const teamDir = path.join(repoRoot, "teams", "legacy-team");
    fs.mkdirSync(teamDir, { recursive: true });
    const legacyYaml = [
      "team:",
      '  name: "legacy-team"',
      '  description: "Legacy"',
      '  version: "0.1.0"',
      "workspace:",
      '  path: "workspace"',
      "  watch: false",
      "defaults:",
      "  provider: anthropic",
      "models:",
      "  strategic:",
      "    model: claude-sonnet-4-6",
      "    thinking: high",
      "    provider: anthropic",
      "agents:",
      '  - name: "sample-agent"',
      '    type: "agent"',
      '    role: "Researcher"',
      "    tier: strategic",
      '    agent_file: "../../agents/sample-agent/sample-agent.md"',
      "    provider: gemini",
      "    model: gemini-2.5-pro",
      "levels: []",
      "",
    ].join("\n");
    const teamPath = path.join(teamDir, "team.yaml");
    fs.writeFileSync(teamPath, legacyYaml);
    fs.appendFileSync(
      path.join(repoRoot, "teams.yaml"),
      [
        "legacy-team:",
        "  type: team",
        "  description: Legacy team.",
        "  team_path: ./teams/legacy-team",
        "",
      ].join("\n"),
    );
    const before = fs.readFileSync(teamPath);

    const response = await fetch(
      `${base}/create/team-builder/teams/legacy-team`,
    );
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      team: {
        warnings: string[];
        agents: Array<{ name: string; effectiveProvider?: string; effectiveModel?: string }>;
      };
    };

    // Reading a legacy file never rewrites it.
    assert.deepEqual(fs.readFileSync(teamPath), before);

    // The retired fields are reported, not obeyed.
    const warnings = payload.team.warnings.join(" ");
    assert.match(warnings, /models/);
    assert.match(warnings, /sample-agent/);
  });
});

test("team-builder API keeps healthy Teams visible when one Team is malformed", async () => {
  await withTeamBuilderServer(async (base, repoRoot) => {
    for (const id of ["malformed-team", "healthy-team"]) {
      fs.mkdirSync(path.join(repoRoot, "teams", id), { recursive: true });
    }
    fs.writeFileSync(
      path.join(repoRoot, "teams.yaml"),
      [
        "malformed-team:",
        "  type: team",
        "  team_path: ./teams/malformed-team",
        "healthy-team:",
        "  type: team",
        "  team_path: ./teams/healthy-team",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(repoRoot, "teams", "malformed-team", "team.yaml"),
      "team:\n  name: malformed-team\nagents: [null]\nlevels: []\ngates: []\n",
    );
    fs.writeFileSync(
      path.join(repoRoot, "teams", "healthy-team", "team.yaml"),
      "team:\n  name: healthy-team\nagents: []\nlevels: []\ngates: []\n",
    );

    const response = await fetch(`${base}/create/team-builder/teams`);
    const payload = (await response.json()) as {
      teams: Array<{
        id: string;
        health: { status: string; errors: string[] };
      }>;
    };

    assert.equal(response.status, 200);
    assert.deepEqual(payload.teams.map((team) => team.id), [
      "healthy-team",
      "malformed-team",
    ]);
    const malformed = payload.teams.find((team) => team.id === "malformed-team");
    assert.ok(malformed);
    assert.equal(malformed.health.status, "error");
    assert.match(malformed.health.errors.join("\n"), /could not be validated/i);
  });
});

test("team-builder API refuses to remove an agent a team still depends on", async () => {
  await withTeamBuilderServer(async (base, repoRoot) => {
    const teamDir = path.join(repoRoot, "teams", "board-team");
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "teams.yaml"),
      [
        "board-team:",
        "  type: team",
        "  description: Board team.",
        "  team_path: ./teams/board-team",
        "",
      ].join("\n"),
    );
    const teamYamlPath = path.join(teamDir, "team.yaml");
    fs.writeFileSync(
      teamYamlPath,
      [
        "team:",
        '  name: "board-team"',
        "  description: Board team.",
        '  version: "0.1.0"',
        "",
        "agents:",
        '  - name: "sample-agent"',
        "    type: agent",
        "    role: Convening lead.",
        "    tier: orchestration",
        "    tools: []",
        '    agent_file: "../../agents/sample-agent/sample-agent.md"',
        "    produces:",
        '      - path: "final-result.md"',
        "",
        '  - name: "runtime-router"',
        "    type: agent",
        "    role: Internal router.",
        "    tier: strategic",
        "    tools: []",
        '    agent_file: "../../agents/runtime-router/runtime-router.md"',
        "",
        "levels:",
        "  - id: setup",
        "    name: Setup",
        "    order: 0",
        "    stage:",
        "      type: discussion",
        '      coordinator: "sample-agent"',
        "      participants:",
        '        - "runtime-router"',
        "",
        "gates:",
        "  - from: setup",
        "    to: done",
        "    condition:",
        "      type: artifact_exists",
        '      artifact: "final-result.md"',
        "",
      ].join("\n"),
    );
    const savedBefore = fs.readFileSync(teamYamlPath, "utf8");

    const response = await fetch(
      `${base}/create/team-builder/teams/board-team/agents/sample-agent`,
      { method: "DELETE" },
    );
    const payload = (await response.json()) as { error: string };

    assert.equal(response.status, 400);
    assert.match(payload.error, /Cannot remove 'sample-agent'/);
    assert.match(
      payload.error,
      /the discussion coordinator of level 'setup'/,
    );
    assert.equal(fs.readFileSync(teamYamlPath, "utf8"), savedBefore);
  });
});

test("adding a roster member that names a grade is refused, and writes nothing", async () => {
  // The corrected boundary. `currentPlan` is this server's own earlier output
  // handed back as context, so a grade there is read past. This is the other
  // case: a genuinely new roster write, where a grade is the author's own
  // input. Accepting it would answer 200 for a setting that decides nothing —
  // the outcome §4.5 names — so it is refused by name, and the Team file is
  // left exactly as it was.
  await withTeamBuilderServer(async (base, repoRoot) => {
    const createResponse = await fetch(`${base}/create/team-builder/teams`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "grade-team", description: "Grade team." }),
    });
    assert.equal(createResponse.status, 201);
    const teamYamlPath = path.join(repoRoot, "teams", "grade-team", "team.yaml");
    const savedBefore = fs.readFileSync(teamYamlPath, "utf8");

    const response = await fetch(
      `${base}/create/team-builder/teams/grade-team/agents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentName: "sample-agent",
          role: "Researcher",
          tier: "strategic",
        }),
      },
    );
    const payload = (await response.json()) as { error?: string };

    assert.equal(response.status, 400, JSON.stringify(payload));
    // Named, and actionable: the author has to be able to tell what to remove
    // and why the setting is gone.
    assert.match(payload.error ?? "", /tier/);
    assert.match(payload.error ?? "", /no longer/i);
    assert.equal(
      fs.readFileSync(teamYamlPath, "utf8"),
      savedBefore,
      "a refused write must not change team.yaml",
    );

    // The same request without the retired field still works, so the refusal
    // is about the field and not about the route.
    const accepted = await fetch(
      `${base}/create/team-builder/teams/grade-team/agents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentName: "sample-agent", role: "Researcher" }),
      },
    );
    const acceptedPayload = (await accepted.json()) as {
      team: { agents: Array<{ name: string; tier?: unknown }> };
    };
    assert.equal(accepted.status, 200, JSON.stringify(acceptedPayload));
    assert.deepEqual(
      acceptedPayload.team.agents.map((agent) => agent.name),
      ["sample-agent"],
    );
    assert.equal(acceptedPayload.team.agents[0]?.tier, undefined);
    assert.doesNotMatch(fs.readFileSync(teamYamlPath, "utf8"), /^ {4}tier:/m);
  });
});

/**
 * The `system` marker says "never a team member", and a check that runs after
 * the write does not say that: it hides the member the API just persisted, so
 * the roster on disk and the roster on screen disagree and a real participant
 * vanishes. The refusal has to come before the write.
 *
 * `ui_hidden` keeps the behaviour the contract above pins. Its members are
 * written and then hidden, which is a decision this change did not make and
 * does not revisit.
 */
test("a system agent is refused as a team member before anything is written", async () => {
  await withTeamBuilderServer(async (base, repoRoot) => {
    const create = await fetch(`${base}/create/team-builder/teams`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "roster-team", description: "Roster team." }),
    });
    assert.equal(create.status, 201, await create.clone().text());

    const teamYamlPath = path.join(repoRoot, "teams", "roster-team", "team.yaml");
    const before = fs.readFileSync(teamYamlPath, "utf8");

    const response = await fetch(
      `${base}/create/team-builder/teams/roster-team/agents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentName: "general-agent", role: "Front door" }),
      },
    );

    assert.equal(response.status, 400, await response.clone().text());
    assert.equal(
      fs.readFileSync(teamYamlPath, "utf8"),
      before,
      "a refused member leaves the roster on disk byte-identical",
    );

    // The domain normalizes the supplied name before it resolves the persona,
    // so a guard that reads the raw string is checking a different value.
    const spelled = await fetch(
      `${base}/create/team-builder/teams/roster-team/agents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentName: "General Agent", role: "Front door" }),
      },
    );

    assert.equal(spelled.status, 400, await spelled.clone().text());
    assert.equal(
      fs.readFileSync(teamYamlPath, "utf8"),
      before,
      "a refused member leaves the roster on disk byte-identical",
    );
  });
});
