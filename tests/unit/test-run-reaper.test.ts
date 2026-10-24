/**
 * The reaper is the backstop for processes no test could clean up itself.
 *
 * Durable task hosts are launched detached and unref'd on purpose, so the
 * product's own recovery guarantee — a run survives the API server restarting —
 * is the same property that lets a run survive the test that started it. Killing
 * a process tree cannot reach them, and per-test `finally` blocks do not run at
 * all when the test file process is killed outright. What every one of those
 * processes does inherit is the environment, so the run id in the environment is
 * the one handle that reaches an untracked grandchild.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  TEST_RUN_ID_ENV,
  collectAncestors,
  createTestRunId,
  findAbandonedSurvivors,
  findSurvivors,
  isProcessAlive,
  isRunningState,
  parseParentMap,
  parseProcessTable,
  readRunId,
  readRunOwnerPid,
  reapSurvivors,
} from "../support/test-run-reaper.js";

const psLine = (pid: number, command: string, runId?: string): string =>
  `${pid} ${command}${runId ? ` ${TEST_RUN_ID_ENV}=${runId}` : ""} PATH=/usr/bin`;

test("the environment variable name is the one launchers propagate", () => {
  assert.equal(TEST_RUN_ID_ENV, "PIPELINE_TEST_RUN_ID");
});

test("each run id is unique so concurrent runs never reap each other", () => {
  const first = createTestRunId();
  const second = createTestRunId();

  assert.notEqual(first, second);
  assert.match(first, /^pipeline-test-/u);
});

test("the process table parses a pid and the rest of the line", () => {
  const entries = parseProcessTable(
    [
      psLine(4242, "/usr/bin/node worker.js", "pipeline-test-a"),
      psLine(77, "/usr/bin/node other.js"),
      "",
      "   ",
    ].join("\n"),
  );

  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.pid, 4242);
  assert.match(entries[0]?.line ?? "", /worker\.js/u);
  assert.equal(entries[1]?.pid, 77);
});

test("a survivor is a process carrying this run's id", () => {
  const survivors = findSurvivors({
    runId: "pipeline-test-a",
    processTable: parseProcessTable(
      [
        psLine(10, "/usr/bin/node leaked.js", "pipeline-test-a"),
        psLine(11, "/usr/bin/node unrelated.js"),
      ].join("\n"),
    ),
  });

  assert.deepEqual(survivors, [10]);
});

test("a concurrent run's processes are left alone", () => {
  const survivors = findSurvivors({
    runId: "pipeline-test-a",
    processTable: parseProcessTable(
      [
        psLine(10, "/usr/bin/node mine.js", "pipeline-test-a"),
        psLine(11, "/usr/bin/node theirs.js", "pipeline-test-b"),
      ].join("\n"),
    ),
  });

  assert.deepEqual(survivors, [10]);
});

test("the reaper never targets itself", () => {
  const survivors = findSurvivors({
    runId: "pipeline-test-a",
    excludePids: [10],
    processTable: parseProcessTable(
      [
        psLine(10, "/usr/bin/node runner.js", "pipeline-test-a"),
        psLine(11, "/usr/bin/node leaked.js", "pipeline-test-a"),
      ].join("\n"),
    ),
  });

  assert.deepEqual(survivors, [11]);
});

test("a survivor that stops on SIGTERM is never sent SIGKILL", async () => {
  const signals: Array<{ pid: number; signal: string }> = [];
  const alive = new Set([10]);

  const result = await reapSurvivors({
    runId: "pipeline-test-a",
    readProcessTable: () => psLine(10, "/usr/bin/node leaked.js", "pipeline-test-a"),
    kill: (pid, signal) => {
      signals.push({ pid, signal });
      if (signal === "SIGTERM") alive.delete(pid);
    },
    isAlive: (pid) => alive.has(pid),
    delay: async () => undefined,
  });

  assert.deepEqual(signals, [{ pid: 10, signal: "SIGTERM" }]);
  assert.deepEqual(result.terminated, [10]);
  assert.deepEqual(result.killed, []);
});

test("a survivor that ignores SIGTERM is escalated to SIGKILL", async () => {
  const signals: Array<{ pid: number; signal: string }> = [];

  const result = await reapSurvivors({
    runId: "pipeline-test-a",
    readProcessTable: () => psLine(10, "/usr/bin/node stuck.js", "pipeline-test-a"),
    kill: (pid, signal) => {
      signals.push({ pid, signal });
    },
    isAlive: () => true,
    delay: async () => undefined,
  });

  assert.deepEqual(signals, [
    { pid: 10, signal: "SIGTERM" },
    { pid: 10, signal: "SIGKILL" },
  ]);
  assert.deepEqual(result.terminated, []);
  assert.deepEqual(result.killed, [10]);
});

test("a clean run reaps nothing and reads the table once", async () => {
  let reads = 0;

  const result = await reapSurvivors({
    runId: "pipeline-test-a",
    readProcessTable: () => {
      reads += 1;
      return psLine(11, "/usr/bin/node unrelated.js");
    },
    kill: () => assert.fail("a clean run must not signal anything"),
    isAlive: () => false,
    delay: async () => undefined,
  });

  assert.equal(reads, 1);
  assert.deepEqual(result.terminated, []);
  assert.deepEqual(result.killed, []);
});

test("an unreadable process table is reported, not thrown", async () => {
  const result = await reapSurvivors({
    runId: "pipeline-test-a",
    readProcessTable: () => {
      throw new Error("ps is unavailable");
    },
    kill: () => assert.fail("nothing can be signalled without a process table"),
    isAlive: () => false,
    delay: async () => undefined,
  });

  assert.deepEqual(result.terminated, []);
  assert.deepEqual(result.killed, []);
  assert.match(result.failure ?? "", /ps is unavailable/u);
});

/**
 * A run killed with SIGKILL never reaches its own sweep, so its survivors are
 * only ever collected by a later run. A later run must not collect a *concurrent*
 * run's processes, which is the normal case across worktrees. The run id carries
 * the runner's pid so the difference is decidable: an owner that is gone cannot
 * still be using them.
 */
test("a run id carries the pid of the runner that owns it", () => {
  const runId = createTestRunId();

  assert.equal(readRunOwnerPid(runId), process.pid);
});

test("a run id from an unknown format owns nothing", () => {
  assert.equal(readRunOwnerPid("pipeline-test-not-a-pid"), null);
  assert.equal(readRunOwnerPid("something-else"), null);
});

test("the run id is read back out of a process table line", () => {
  const entries = parseProcessTable(
    psLine(10, "/usr/bin/node leaked.js", "pipeline-test-99-abc"),
  );

  assert.equal(readRunId(entries[0]?.line ?? ""), "pipeline-test-99-abc");
  assert.equal(readRunId("/usr/bin/node untagged.js PATH=/usr/bin"), null);
});

test("survivors of a run whose runner is gone are abandoned", () => {
  const abandoned = findAbandonedSurvivors({
    currentRunId: "pipeline-test-500-mine",
    isAlive: (pid) => pid === 400,
    processTable: parseProcessTable(
      [
        psLine(10, "/usr/bin/node dead-owner.js", "pipeline-test-300-gone"),
        psLine(11, "/usr/bin/node live-owner.js", "pipeline-test-400-running"),
        psLine(12, "/usr/bin/node mine.js", "pipeline-test-500-mine"),
        psLine(13, "/usr/bin/node untagged.js"),
      ].join("\n"),
    ),
  });

  assert.deepEqual(abandoned, [10]);
});

/**
 * The reaper reads a process table that includes each process's command line as
 * well as its environment, and cannot tell the two apart in one flat line. A
 * shell invoked as `PIPELINE_TEST_RUN_ID=... some-command` therefore carries the
 * id in its *command*, and that shell is usually the reaper's own parent. Killing
 * it would take out the terminal that asked for the cleanup, so the reaper's
 * own ancestry is excluded before anything is signalled.
 */
test("the parent map parses a pid and ppid table", () => {
  const parents = parseParentMap(["  1     0", "500   1", "900 500", "", "junk"].join("\n"));

  assert.equal(parents.get(500), 1);
  assert.equal(parents.get(900), 500);
  assert.equal(parents.get(12345), undefined);
});

test("ancestors are collected up to the root", () => {
  const parents = new Map([
    [900, 500],
    [500, 300],
    [300, 1],
    [1, 0],
  ]);

  assert.deepEqual(collectAncestors(900, parents), [500, 300, 1]);
});

test("a cycle in the parent map cannot hang the walk", () => {
  const parents = new Map([
    [900, 500],
    [500, 900],
  ]);

  assert.deepEqual(collectAncestors(900, parents), [500]);
});

test("a survivor sweep never targets the reaper's own ancestry", async () => {
  const signals: number[] = [];

  const result = await reapSurvivors({
    runId: "pipeline-test-a",
    // The shell that typed the id, then the process that actually carries it.
    readProcessTable: () =>
      [
        psLine(900, "/bin/zsh -c PIPELINE_TEST_RUN_ID=pipeline-test-a npm run x"),
        psLine(950, "/usr/bin/node leaked.js", "pipeline-test-a"),
      ].join("\n"),
    readAncestors: () => [900, 500, 1],
    kill: (pid) => signals.push(pid),
    isAlive: () => false,
    delay: async () => undefined,
  });

  assert.deepEqual(signals, [950], "only the real survivor may be signalled");
  assert.deepEqual(result.terminated, [950]);
});

test("an abandoned sweep never targets the reaper's own ancestry", () => {
  const abandoned = findAbandonedSurvivors({
    currentRunId: "",
    isAlive: () => false,
    ancestorPids: [900, 500, 1],
    processTable: parseProcessTable(
      [
        psLine(900, "/bin/zsh -c PIPELINE_TEST_RUN_ID=pipeline-test-300-gone npm run x"),
        psLine(950, "/usr/bin/node leaked.js", "pipeline-test-300-gone"),
      ].join("\n"),
    ),
  });

  assert.deepEqual(abandoned, [950]);
});

/**
 * A process that has been signalled away stays in the process table until its
 * parent collects it. `process.kill(pid, 0)` succeeds for that corpse, so
 * liveness by signal alone reports a process the reaper just stopped as one it
 * failed to stop. The process state is what distinguishes the two.
 */
test("a terminated process awaiting its parent is not running", () => {
  assert.equal(isRunningState("Z"), false);
  assert.equal(isRunningState("Z+"), false);
});

test("a sleeping or running process is running", () => {
  for (const state of ["S", "S+", "Ss", "R", "R+", "U", "I"]) {
    assert.equal(isRunningState(state), true, `${state} must count as running`);
  }
});

test("no state at all means the process is gone", () => {
  assert.equal(isRunningState(null), false);
  assert.equal(isRunningState(""), false);
});

test("liveness rejects a corpse even while the signal probe still succeeds", () => {
  // This process is unquestionably alive, so only the state can produce false.
  assert.equal(isProcessAlive(process.pid, () => "Z+"), false);
  assert.equal(isProcessAlive(process.pid, () => "S+"), true);
});
