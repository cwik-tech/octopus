/**
 * Each row of the Team list carries the revision of the file it was read from
 * (A6.2, the per-Team list revision).
 *
 * The sidebar deletes a Team from the list, without opening its detail. For
 * that delete to be guarded like the editor's writes, the list must name the
 * revision the row describes: the same digest the detail reports, taken from
 * the same `team.yaml` bytes that produced the row, so a delete made against a
 * row the file has moved on from is refused instead of removing a Team the
 * person never saw.
 *
 * Every case runs against the real API server over a temporary repository.
 * The one substitution is in the last case, which makes the file change
 * between two reads inside one list request. `team.yaml` is a named pipe
 * served by a fixture process: the first read of it gets one version, and
 * every later read gets another. No application module is replaced.
 */

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";

import { startApiServer } from "../../server/api-server.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";
import { stopProcessCarrying } from "../support/owned-processes.js";

const TEAM_ID = "listed-team";
const TEAMS_URL = "/create/team-builder/teams";
const TEAM_URL = `${TEAMS_URL}/${TEAM_ID}`;

const listResponseSchema = z.object({
  teams: z.array(
    z.object({
      id: z.string(),
      revision: z.string(),
      agentNames: z.array(z.string()).optional(),
    }),
  ),
});

const detailResponseSchema = z.object({
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
  teamYamlPath: string;
}

/**
 * A running API over a repository holding one saved Team whose roster is
 * `writer-agent`, with `editor-agent` in the library. Its `team.yaml` carries
 * a note a person added by hand, as saved Team files may.
 */
async function startWithTeam(t: TestContext): Promise<Server> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "team-list-revision-"));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "team-list-revision-repo-"));
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  for (const name of ["writer-agent", "editor-agent"]) writeAgent(repoRoot, name);
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

  const created = await send(server.url, "POST", TEAMS_URL, {
    id: TEAM_ID,
    description: "A team listed in the sidebar.",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const added = await send(server.url, "POST", `${TEAM_URL}/agents`, {
    agentName: "writer-agent",
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const teamYamlPath = path.join(repoRoot, "teams", TEAM_ID, "team.yaml");
  fs.appendFileSync(teamYamlPath, "# Kept by hand: the writer drafts first.\n");
  return { base: server.url, repoRoot, teamYamlPath };
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

async function readDetail(
  base: string,
): Promise<z.infer<typeof detailResponseSchema>["team"]> {
  const read = await send(base, "GET", TEAM_URL);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  return detailResponseSchema.parse(read.body).team;
}

async function readListedRow(
  base: string,
): Promise<z.infer<typeof listResponseSchema>["teams"][number]> {
  const read = await send(base, "GET", TEAMS_URL);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const row = listResponseSchema.parse(read.body).teams.find((team) => team.id === TEAM_ID);
  assert.ok(row, `the list includes ${TEAM_ID}: ${JSON.stringify(read.body)}`);
  return row;
}

/** Another editor adds a member, without naming a revision. */
async function addEditorFromAnotherWindow(base: string): Promise<void> {
  const added = await send(base, "POST", `${TEAM_URL}/agents`, {
    agentName: "editor-agent",
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
}

/** Every file and folder a Team write can touch, with each file's bytes. */
function teamFiles(repoRoot: string): Record<string, Buffer | "<folder>"> {
  const files: Record<string, Buffer | "<folder>"> = {
    "teams.yaml": fs.readFileSync(path.join(repoRoot, "teams.yaml")),
  };
  const teamsDir = path.join(repoRoot, "teams");
  const entries = fs.readdirSync(teamsDir, { encoding: "utf8", recursive: true });
  for (const entry of entries.sort()) {
    const full = path.join(teamsDir, entry);
    files[path.join("teams", entry)] = fs.statSync(full).isDirectory()
      ? "<folder>"
      : fs.readFileSync(full);
  }
  return files;
}

/** Resolves with the first line a stream prints. */
async function firstLine(stream: Readable): Promise<string> {
  let seen = "";
  for await (const chunk of stream) {
    seen += String(chunk);
    const end = seen.indexOf("\n");
    if (end >= 0) return seen.slice(0, end);
  }
  throw new Error(`The stream ended before a full line: ${JSON.stringify(seen)}`);
}

test("a listed Team's revision is the revision its detail reports", async (t) => {
  const { base } = await startWithTeam(t);

  const row = await readListedRow(base);

  assert.equal(row.revision, (await readDetail(base)).revision);
});

test("after a write, the listed revision changes and matches the new detail", async (t) => {
  const { base } = await startWithTeam(t);
  const before = (await readListedRow(base)).revision;

  await addEditorFromAnotherWindow(base);

  const after = (await readListedRow(base)).revision;
  assert.notEqual(after, before);
  assert.equal(after, (await readDetail(base)).revision);
});

test("deleting a Team with the revision its row lists goes through", async (t) => {
  const { base, repoRoot } = await startWithTeam(t);
  const listed = (await readListedRow(base)).revision;

  const deletion = await send(
    base,
    "DELETE",
    `${TEAM_URL}?expectedRevision=${encodeURIComponent(listed)}`,
  );

  assert.equal(deletion.status, 200, JSON.stringify(deletion.body));
  assert.equal(fs.existsSync(path.join(repoRoot, "teams", TEAM_ID)), false);
});

test("deleting a Team with a revision listed before another write is refused, and no file changes", async (t) => {
  const { base, repoRoot } = await startWithTeam(t);
  const listed = (await readListedRow(base)).revision;
  await addEditorFromAnotherWindow(base);
  const before = teamFiles(repoRoot);

  const deletion = await send(
    base,
    "DELETE",
    `${TEAM_URL}?expectedRevision=${encodeURIComponent(listed)}`,
  );

  assert.equal(deletion.status, 409, JSON.stringify(deletion.body));
  assert.equal(conflictSchema.parse(deletion.body).team.revision, (await readDetail(base)).revision);
  assert.deepEqual(teamFiles(repoRoot), before);
});

test("a row's revision describes the same file as the rest of the row when the file changes during the listing", {
  timeout: 60_000,
  skip: process.platform === "win32",
}, async (t) => {
  const { base, repoRoot, teamYamlPath } = await startWithTeam(t);
  const versionA = fs.readFileSync(teamYamlPath);
  const detailA = await readDetail(base);
  await addEditorFromAnotherWindow(base);
  const versionB = fs.readFileSync(teamYamlPath);
  const detailB = await readDetail(base);
  const described = {
    A: { agentNames: detailA.agents.map((agent) => agent.name), revision: detailA.revision },
    B: { agentNames: detailB.agents.map((agent) => agent.name), revision: detailB.revision },
  };
  assert.notDeepEqual(described.A, described.B, "arrangement: the two versions differ in roster and revision");

  // The first read of team.yaml during the listing gets version A, and every
  // later read gets version B. The writer blocks until the server opens the
  // pipe, puts version B in place, and only then hands over version A.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "team-list-revision-versions-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const versionAPath = path.join(scratch, "version-a.yaml");
  fs.writeFileSync(versionAPath, versionA);
  const versionBPath = path.join(path.dirname(teamYamlPath), ".version-b.fixture");
  fs.writeFileSync(versionBPath, versionB);
  fs.rmSync(teamYamlPath);
  execFileSync("mkfifo", [teamYamlPath]);

  const marker = `--coverage-fixture-writer=${randomUUID()}`;
  const writer = spawn(
    process.execPath,
    [
      "-e",
      [
        "const fs = require('node:fs')",
        "const versionA = fs.readFileSync(process.env.FIXTURE_VERSION_A)",
        "fs.writeSync(1, 'ready\\n')",
        "const fd = fs.openSync(process.env.FIXTURE_TEAM_YAML, fs.constants.O_WRONLY)",
        "fs.renameSync(process.env.FIXTURE_VERSION_B, process.env.FIXTURE_TEAM_YAML)",
        "fs.writeSync(fd, versionA)",
        "fs.closeSync(fd)",
      ].join("\n"),
      "--",
      marker,
    ],
    {
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        FIXTURE_TEAM_YAML: teamYamlPath,
        FIXTURE_VERSION_A: versionAPath,
        FIXTURE_VERSION_B: versionBPath,
      },
    },
  );
  const writerPid = writer.pid;
  if (writerPid !== undefined) {
    t.after(() => stopProcessCarrying(writerPid, marker));
  }
  const writerExit = once(writer, "exit");
  await once(writer, "spawn");
  assert.equal(await firstLine(writer.stdout), "ready");

  const row = await readListedRow(base);

  assert.deepEqual(await writerExit, [0, null], "arrangement: the listing read the pipe once and the writer finished");
  assert.deepEqual(fs.readFileSync(teamYamlPath), versionB, "arrangement: the file changed during the listing");
  const version = row.agentNames?.includes("editor-agent") ? "B" : "A";
  t.diagnostic(`the row's roster is version ${version}'s`);
  assert.deepEqual(
    { agentNames: row.agentNames, revision: row.revision },
    described[version],
    "The row's revision must be the digest of the bytes its other values were read from, " +
      "not of a file read at another moment.",
  );
  assert.equal(fs.existsSync(path.join(repoRoot, "teams", TEAM_ID, ".version-b.fixture")), false);
});
