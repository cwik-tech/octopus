/**
 * The five user-facing writes of a saved team, guarded by the revision the
 * editor was showing (A6.2).
 *
 * Saving a team's details, deleting it, adding or removing a member in the
 * Team Builder, and adding an agent to a team from the Agent page each read
 * `team.yaml`, change it and write it back. Two editors open on the same team
 * would each write a file that never saw the other's change, so a write may
 * name the revision it was made against. A revision the team has moved on from
 * is refused with 409 and the team as it now stands, and nothing is written. A
 * present revision that names nothing (empty, or not a string) is refused with
 * 400 rather than read as "skip the check".
 *
 * The revision is optional: a caller that omits it writes exactly as before.
 * The contract suites for both pages send none and are the gate for that.
 */

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

import { startApiServer } from "../../server/api-server.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";

const TEAM_ID = "revision-team";
const TEAM_URL = `/create/team-builder/teams/${TEAM_ID}`;

const teamResponseSchema = z.object({
  team: z.object({
    id: z.string(),
    revision: z.string(),
    agents: z.array(z.object({ name: z.string() })),
  }),
});

const conflictSchema = z.object({
  error: z.literal("team_revision_conflict"),
  team: z.object({ id: z.string(), revision: z.string() }),
});

const errorSchema = z.object({ error: z.string() });

function writeAgent(repoRoot: string, name: string): void {
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
      "---",
      "",
      `# ${name}`,
      "",
    ].join("\n"),
  );
}

interface Server {
  base: string;
  repoRoot: string;
}

/**
 * A running API over a repository holding one saved team whose roster is
 * `writer-agent`, with `reviewer-agent` and `editor-agent` in the library.
 */
async function startWithTeam(t: TestContext): Promise<Server> {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), "team-revision-writes-"),
  );
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "team-revision-writes-repo-"),
  );
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  for (const name of ["writer-agent", "reviewer-agent", "editor-agent"]) {
    writeAgent(repoRoot, name);
  }
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 1, cwd: workspacePath };
      },
    },
    repoRootPath: repoRoot,
  });
  t.after(async () => {
    await server.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  const created = await send(server.url, "POST", "/create/team-builder/teams", {
    id: TEAM_ID,
    description: "A team two editors have open.",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const added = await send(server.url, "POST", `${TEAM_URL}/agents`, {
    agentName: "writer-agent",
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  return { base: server.url, repoRoot };
}

async function send(
  base: string,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${pathname}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return { status: response.status, body: await response.json() };
}

async function readTeam(
  base: string,
): Promise<z.infer<typeof teamResponseSchema>["team"]> {
  const read = await send(base, "GET", TEAM_URL);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  return teamResponseSchema.parse(read.body).team;
}

/**
 * The revision one editor read, after which another editor added a member.
 * The second editor sends no revision, the way every caller did before.
 */
async function revisionAnotherEditorMovedOn(base: string): Promise<string> {
  const stale = (await readTeam(base)).revision;
  const otherEdit = await send(base, "POST", `${TEAM_URL}/agents`, {
    agentName: "editor-agent",
  });
  assert.equal(otherEdit.status, 200, JSON.stringify(otherEdit.body));
  assert.notEqual((await readTeam(base)).revision, stale);
  return stale;
}

/** Every file and folder a team write can touch, with each file's text. */
function teamFiles(repoRoot: string): Record<string, string> {
  const files: Record<string, string> = {
    "teams.yaml": fs.readFileSync(path.join(repoRoot, "teams.yaml"), "utf8"),
  };
  const teamsDir = path.join(repoRoot, "teams");
  const entries = fs.readdirSync(teamsDir, { encoding: "utf8", recursive: true });
  for (const entry of entries.sort()) {
    const full = path.join(teamsDir, entry);
    files[path.join("teams", entry)] = fs.statSync(full).isDirectory()
      ? "<folder>"
      : fs.readFileSync(full, "utf8");
  }
  return files;
}

/** The refusal names the conflict and carries the team as it now stands. */
async function assertConflict(
  base: string,
  response: { status: number; body: unknown },
): Promise<void> {
  assert.equal(response.status, 409, JSON.stringify(response.body));
  const conflict = conflictSchema.parse(response.body);
  const current = await readTeam(base);
  assert.equal(conflict.team.id, TEAM_ID);
  assert.equal(conflict.team.revision, current.revision);
}

test("saving a team's details against a revision another editor moved on from is refused, and nothing is written", async (t) => {
  const { base, repoRoot } = await startWithTeam(t);
  const stale = await revisionAnotherEditorMovedOn(base);
  const before = teamFiles(repoRoot);

  const response = await send(base, "PUT", TEAM_URL, {
    id: "renamed-team",
    description: "Written from a stale editor.",
    expectedRevision: stale,
  });

  await assertConflict(base, response);
  assert.deepEqual(teamFiles(repoRoot), before);
});

test("deleting a team against a revision another editor moved on from is refused, and nothing is written", async (t) => {
  const { base, repoRoot } = await startWithTeam(t);
  const stale = await revisionAnotherEditorMovedOn(base);
  const before = teamFiles(repoRoot);

  const response = await send(
    base,
    "DELETE",
    `${TEAM_URL}?expectedRevision=${encodeURIComponent(stale)}`,
  );

  await assertConflict(base, response);
  assert.deepEqual(teamFiles(repoRoot), before);
});

test("adding a member in the Team Builder against a revision another editor moved on from is refused, and nothing is written", async (t) => {
  const { base, repoRoot } = await startWithTeam(t);
  const stale = await revisionAnotherEditorMovedOn(base);
  const before = teamFiles(repoRoot);

  const response = await send(base, "POST", `${TEAM_URL}/agents`, {
    agentName: "reviewer-agent",
    expectedRevision: stale,
  });

  await assertConflict(base, response);
  assert.deepEqual(teamFiles(repoRoot), before);
});

test("removing a member against a revision another editor moved on from is refused, and nothing is written", async (t) => {
  const { base, repoRoot } = await startWithTeam(t);
  const stale = await revisionAnotherEditorMovedOn(base);
  const before = teamFiles(repoRoot);

  const response = await send(
    base,
    "DELETE",
    `${TEAM_URL}/agents/writer-agent?expectedRevision=${encodeURIComponent(stale)}`,
  );

  await assertConflict(base, response);
  assert.deepEqual(teamFiles(repoRoot), before);
});

test("adding an agent to a team from the Agent page against a revision another editor moved on from is refused, and nothing is written", async (t) => {
  const { base, repoRoot } = await startWithTeam(t);
  const stale = await revisionAnotherEditorMovedOn(base);
  const before = teamFiles(repoRoot);

  const response = await send(base, "POST", "/create/agents/add-to-team", {
    agentName: "reviewer-agent",
    teamId: TEAM_ID,
    expectedRevision: stale,
  });

  await assertConflict(base, response);
  assert.deepEqual(teamFiles(repoRoot), before);
});

test("each of the five writes goes through when it names the team's current revision", async (t) => {
  const { base, repoRoot } = await startWithTeam(t);

  const builderAdd = await send(base, "POST", `${TEAM_URL}/agents`, {
    agentName: "reviewer-agent",
    expectedRevision: (await readTeam(base)).revision,
  });
  assert.equal(builderAdd.status, 200, JSON.stringify(builderAdd.body));
  assert.deepEqual(
    (await readTeam(base)).agents.map((agent) => agent.name),
    ["writer-agent", "reviewer-agent"],
  );

  const removal = await send(
    base,
    "DELETE",
    `${TEAM_URL}/agents/reviewer-agent?expectedRevision=${encodeURIComponent((await readTeam(base)).revision)}`,
  );
  assert.equal(removal.status, 200, JSON.stringify(removal.body));
  assert.deepEqual(
    (await readTeam(base)).agents.map((agent) => agent.name),
    ["writer-agent"],
  );

  const pageAdd = await send(base, "POST", "/create/agents/add-to-team", {
    agentName: "editor-agent",
    teamId: TEAM_ID,
    expectedRevision: (await readTeam(base)).revision,
  });
  assert.equal(pageAdd.status, 200, JSON.stringify(pageAdd.body));
  assert.deepEqual(
    (await readTeam(base)).agents.map((agent) => agent.name),
    ["writer-agent", "editor-agent"],
  );

  const details = await send(base, "PUT", TEAM_URL, {
    id: TEAM_ID,
    description: "Saved from a current editor.",
    expectedRevision: (await readTeam(base)).revision,
  });
  assert.equal(details.status, 200, JSON.stringify(details.body));
  assert.match(
    fs.readFileSync(path.join(repoRoot, "teams.yaml"), "utf8"),
    /Saved from a current editor\./,
  );

  const deletion = await send(
    base,
    "DELETE",
    `${TEAM_URL}?expectedRevision=${encodeURIComponent((await readTeam(base)).revision)}`,
  );
  assert.equal(deletion.status, 200, JSON.stringify(deletion.body));
  assert.equal(fs.existsSync(path.join(repoRoot, "teams", TEAM_ID)), false);
});

test("a revision that is present but names nothing is refused with 400 by each of the five writes, and nothing is written", async (t) => {
  const { base, repoRoot } = await startWithTeam(t);
  const before = teamFiles(repoRoot);

  // One at a time, so each is judged against the same untouched team.
  const attempts: Array<[string, () => Promise<{ status: number; body: unknown }>]> = [
    ["save details with an empty revision", () => send(base, "PUT", TEAM_URL, {
      id: TEAM_ID,
      description: "Written with no revision named.",
      expectedRevision: "",
    })],
    ["save details with a numeric revision", () => send(base, "PUT", TEAM_URL, {
      id: TEAM_ID,
      description: "Written with no revision named.",
      expectedRevision: 7,
    })],
    ["delete the team with an empty revision", () => send(base, "DELETE", `${TEAM_URL}?expectedRevision=`)],
    ["add a member with an empty revision", () => send(base, "POST", `${TEAM_URL}/agents`, {
      agentName: "reviewer-agent",
      expectedRevision: "",
    })],
    ["add a member with a null revision", () => send(base, "POST", `${TEAM_URL}/agents`, {
      agentName: "reviewer-agent",
      expectedRevision: null,
    })],
    ["remove a member with an empty revision", () => send(base, "DELETE", `${TEAM_URL}/agents/writer-agent?expectedRevision=`)],
    ["add from the Agent page with an empty revision", () => send(base, "POST", "/create/agents/add-to-team", {
      agentName: "reviewer-agent",
      teamId: TEAM_ID,
      expectedRevision: "",
    })],
  ];

  for (const [label, attempt] of attempts) {
    const response = await attempt();
    assert.equal(response.status, 400, `${label}: ${JSON.stringify(response.body)}`);
    assert.match(
      errorSchema.parse(response.body).error,
      /expectedRevision/,
      label,
    );
  }
  assert.deepEqual(teamFiles(repoRoot), before);
});
