/**
 * The reaper against real processes.
 *
 * Its unit tests inject a process table, which proves the matching but not that
 * the table can be read at all: the whole mechanism rests on `ps` exposing the
 * environment of a process this one did not spawn a handle for. A detached,
 * unref'd child — the shape the durable task hosts actually leak in — is the
 * case that has to work.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import {
  TEST_RUN_ID_ENV,
  createTestRunId,
  findAbandonedSurvivors,
  isProcessAlive,
  parseProcessTable,
  readAncestorPids,
  readProcessTable,
  reapSurvivors,
} from "../support/test-run-reaper.js";

const readParentPid = (pid: number): number =>
  Number(
    spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
    }).stdout?.trim(),
  );

const spawnTaggedSurvivor = (runId: string): number => {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    {
      // The shape that defeats process-tree teardown: its own process group,
      // no stdio held open, and unref'd so this process can exit without it.
      detached: true,
      stdio: "ignore",
      env: { ...process.env, [TEST_RUN_ID_ENV]: runId },
    },
  );
  child.unref();
  assert.ok(child.pid, "the survivor must expose a pid");
  return child.pid;
};

const waitUntilListed = async (pid: number, runId: string): Promise<void> => {
  // The process table is the reaper's only input, so readiness is "ps can see
  // its environment", not "the child has started".
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const listed = parseProcessTable(readProcessTable()).some(
      (entry) => entry.pid === pid && entry.line.includes(runId),
    );
    if (listed) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`ps never listed ${String(pid)} carrying ${runId}`);
};

test("a detached survivor is found by its run id and stopped", async () => {
  const runId = createTestRunId();
  const pid = spawnTaggedSurvivor(runId);

  try {
    await waitUntilListed(pid, runId);

    const result = await reapSurvivors({
      runId,
      excludePids: [process.pid],
    });

    assert.deepEqual(
      [...result.terminated, ...result.killed],
      [pid],
      "the survivor must be the only process reaped",
    );
    assert.equal(isProcessAlive(pid), false, "the survivor must be stopped");
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already stopped, which is the passing case.
    }
  }
});

test("a survivor of a run with no live owner is collectable by a later run", async () => {
  // An owner pid that cannot be running: a run killed outright leaves exactly
  // this, and it is what the next run has to be able to collect.
  const runId = `pipeline-test-2147483647-${createTestRunId()}`;
  const pid = spawnTaggedSurvivor(runId);

  try {
    await waitUntilListed(pid, runId);

    const abandoned = findAbandonedSurvivors({
      processTable: parseProcessTable(readProcessTable()),
      currentRunId: createTestRunId(),
    });

    assert.ok(
      abandoned.includes(pid),
      `${String(pid)} must be collectable; got ${abandoned.join(", ")}`,
    );
  } finally {
    process.kill(pid, "SIGKILL");
  }
});

test("a survivor of a run that is still going is left alone", async () => {
  // This process is alive and owns the id, so the run it names is still going.
  const runId = createTestRunId(process.pid);
  const pid = spawnTaggedSurvivor(runId);

  try {
    await waitUntilListed(pid, runId);

    const abandoned = findAbandonedSurvivors({
      processTable: parseProcessTable(readProcessTable()),
      currentRunId: createTestRunId(),
    });

    assert.equal(
      abandoned.includes(pid),
      false,
      "a live owner's survivor must not be collected",
    );
  } finally {
    process.kill(pid, "SIGKILL");
  }
});

/**
 * The ancestry guard against the real process tree.
 *
 * Its unit tests inject the ancestor list, which proves the exclusion but not
 * that the walk finds anything. A guard that silently returned an empty list
 * would pass those and still let the reaper kill the terminal that invoked it.
 */
test("the ancestor walk reaches this process's real parent", () => {
  const ancestors = readAncestorPids();

  assert.ok(ancestors.length > 0, "a test process always has a parent");
  assert.equal(
    ancestors[0],
    readParentPid(process.pid),
    "the first ancestor must be the real parent",
  );
});

test("a sweep will not signal a process in this one's real ancestry", async () => {
  const runId = createTestRunId();
  const ancestorPid = readAncestorPids()[0];
  assert.ok(ancestorPid, "the walk must produce an ancestor to exclude");
  const signalled: number[] = [];

  // The shape that caused this guard to exist: a shell whose *command line*
  // carries the id because the run was started as `PIPELINE_TEST_RUN_ID=... cmd`.
  const result = await reapSurvivors({
    runId,
    readProcessTable: () =>
      `${String(ancestorPid)} /bin/zsh -c ${TEST_RUN_ID_ENV}=${runId} npm test`,
    kill: (pid) => signalled.push(pid),
    isAlive: () => false,
    delay: async () => undefined,
  });

  assert.deepEqual(signalled, [], "an ancestor must never be signalled");
  assert.deepEqual(result.terminated, []);
  assert.deepEqual(result.killed, []);
});
