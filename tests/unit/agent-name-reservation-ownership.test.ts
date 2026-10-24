/**
 * Whose reservation a build may give back.
 *
 * A reservation stops two builds racing for one Agent name. Once a package is
 * published under a plan's ownership marker, the folder itself holds the name
 * and that plan's own receipt has nothing left to do. Every other receipt at
 * that same path belongs to somebody this build cannot speak for: another
 * plan's, or bytes this module cannot read. Those must survive untouched, or
 * cleanup becomes a way to steal a name.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  releaseFulfilledPlannedAgentReservation,
  reservePlannedAgentName,
} from "../../domains/agent-generator/agent-name-reservation.js";

const PLAN_ID = "owning-plan";
const AGENT_NAME = "drafting-lawyer";

function withTempRepo(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reservation-ownership-"));
  fs.mkdirSync(path.join(repoRoot, "agents"), { recursive: true });
  return run(repoRoot).finally(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
}

/** Publishes a package `planId` owns, exactly as the persistence layer does. */
function publishOwnedAgent(repoRoot: string, planId: string, name: string): void {
  const agentPath = path.join(repoRoot, "agents", name);
  fs.mkdirSync(agentPath, { recursive: true });
  fs.writeFileSync(
    path.join(agentPath, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} description.\n---\n\n# ${name}\n`,
  );
  fs.writeFileSync(
    path.join(agentPath, ".create-orchestrator"),
    `${JSON.stringify({ orchestratorKey: planId, requestedName: name })}\n`,
  );
}

function reservationFile(repoRoot: string, name: string): string {
  return path.join(
    repoRoot,
    ".create-orchestrator",
    "agent-name-reservations",
    `${createHash("sha256").update(name, "utf8").digest("hex")}.json`,
  );
}

function writeReservationBytes(repoRoot: string, name: string, contents: string): void {
  const file = reservationFile(repoRoot, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

test("a fulfilled reservation of the owning plan is given back", async () => {
  await withTempRepo(async (repoRoot) => {
    writeReservationBytes(
      repoRoot,
      AGENT_NAME,
      `${JSON.stringify({
        version: 1,
        planId: PLAN_ID,
        jobId: "a-job-that-was-killed",
        name: AGENT_NAME,
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    publishOwnedAgent(repoRoot, PLAN_ID, AGENT_NAME);

    await releaseFulfilledPlannedAgentReservation({
      repoRoot,
      planId: PLAN_ID,
      name: AGENT_NAME,
    });

    assert.equal(fs.existsSync(reservationFile(repoRoot, AGENT_NAME)), false);
  });
});

test("another plan's receipt at the same name survives a fulfilled release", async () => {
  await withTempRepo(async (repoRoot) => {
    const foreign = `${JSON.stringify({
      version: 1,
      planId: "a-different-plan",
      jobId: "a-different-job",
      name: AGENT_NAME,
      createdAt: "2026-01-01T00:00:00.000Z",
    })}\n`;
    writeReservationBytes(repoRoot, AGENT_NAME, foreign);
    publishOwnedAgent(repoRoot, PLAN_ID, AGENT_NAME);

    await releaseFulfilledPlannedAgentReservation({
      repoRoot,
      planId: PLAN_ID,
      name: AGENT_NAME,
    });

    assert.equal(
      fs.readFileSync(reservationFile(repoRoot, AGENT_NAME), "utf8"),
      foreign,
      "a receipt this plan does not own is left byte-for-byte as it was",
    );
  });
});

test("unreadable bytes at the same name survive a fulfilled release", async () => {
  await withTempRepo(async (repoRoot) => {
    const unreadable = "{ this is not a reservation\n";
    writeReservationBytes(repoRoot, AGENT_NAME, unreadable);
    publishOwnedAgent(repoRoot, PLAN_ID, AGENT_NAME);

    await releaseFulfilledPlannedAgentReservation({
      repoRoot,
      planId: PLAN_ID,
      name: AGENT_NAME,
    });

    assert.equal(
      fs.readFileSync(reservationFile(repoRoot, AGENT_NAME), "utf8"),
      unreadable,
      "evidence this module cannot read is never removed",
    );
  });
});

test("a reservation is kept while the plan has published nothing under that name", async () => {
  await withTempRepo(async (repoRoot) => {
    const own = `${JSON.stringify({
      version: 1,
      planId: PLAN_ID,
      jobId: "a-running-job",
      name: AGENT_NAME,
      createdAt: "2026-01-01T00:00:00.000Z",
    })}\n`;
    writeReservationBytes(repoRoot, AGENT_NAME, own);

    await releaseFulfilledPlannedAgentReservation({
      repoRoot,
      planId: PLAN_ID,
      name: AGENT_NAME,
    });

    assert.equal(
      fs.readFileSync(reservationFile(repoRoot, AGENT_NAME), "utf8"),
      own,
      "nothing is fulfilled while no package carries this plan's marker",
    );
  });
});

test("reserving a name this plan already published clears only its own receipt", async () => {
  await withTempRepo(async (repoRoot) => {
    writeReservationBytes(
      repoRoot,
      AGENT_NAME,
      `${JSON.stringify({
        version: 1,
        planId: PLAN_ID,
        jobId: "a-job-that-was-killed",
        name: AGENT_NAME,
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    publishOwnedAgent(repoRoot, PLAN_ID, AGENT_NAME);

    assert.deepEqual(
      await reservePlannedAgentName({
        repoRoot,
        planId: PLAN_ID,
        jobId: "a-later-job",
        name: AGENT_NAME,
      }),
      { status: "reused" },
    );
    assert.equal(fs.existsSync(reservationFile(repoRoot, AGENT_NAME)), false);
  });
});
