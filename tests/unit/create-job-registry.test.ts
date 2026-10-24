import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CreateJobRegistry } from "../../server/create-job-registry.js";

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "create-job-registry-"));
}

test("CreateJobRegistry starts, conflicts, and finishes active jobs", () => {
  const registry = new CreateJobRegistry();

  const started = registry.start("job-1");
  assert.equal(started.status, "started");
  if (started.status !== "started") throw new Error("expected started job");

  assert.equal(registry.start("job-1").status, "conflict");
  assert.equal(registry.isCancelled(started.job), false);

  registry.finish("job-1");
  assert.equal(registry.start("job-1").status, "started");
  registry.close();
});

test("CreateJobRegistry cancels an active job", () => {
  const registry = new CreateJobRegistry();
  const started = registry.start("job-1");
  if (started.status !== "started") throw new Error("expected started job");

  assert.deepEqual(registry.cancel("job-1"), {
    jobId: "job-1",
    cancelled: true,
    status: "cancelled",
  });
  assert.equal(registry.isCancelled(started.job), true);
  registry.close();
});

test("CreateJobRegistry cancellation acknowledgement waits for job quiescence", async () => {
  const registry = new CreateJobRegistry();
  const started = registry.start("job-1");
  if (started.status !== "started") throw new Error("expected started job");

  let settled = false;
  const cancellation = registry.cancelAndWait("job-1").then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(started.job.controller.signal.aborted, true);
  assert.equal(settled, false);

  registry.finish("job-1");
  assert.deepEqual(await cancellation, {
    jobId: "job-1",
    cancelled: true,
    status: "cancelled",
  });
  registry.close();
});

test("CreateJobRegistry remembers pending cancellation before job start", () => {
  const registry = new CreateJobRegistry();

  assert.deepEqual(registry.cancel("job-1"), {
    jobId: "job-1",
    cancelled: true,
    status: "pending",
  });
  assert.equal(registry.start("job-1").status, "pending_cancelled");
  assert.equal(registry.start("job-1").status, "started");
  registry.close();
});

test("CreateJobRegistry expires pending cancellation", async () => {
  const registry = new CreateJobRegistry(5);

  registry.cancel("job-1");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(registry.start("job-1").status, "started");
  registry.close();
});

test("CreateJobRegistry persists pending cancellation across restart", () => {
  const workspacePath = makeWorkspace();
  const firstRegistry = new CreateJobRegistry({ workspacePath });

  try {
    firstRegistry.cancel("job-pending");
    firstRegistry.close();

    const secondRegistry = new CreateJobRegistry({ workspacePath });
    assert.equal(
      secondRegistry.start("job-pending").status,
      "pending_cancelled",
    );
    assert.equal(secondRegistry.start("job-pending").status, "started");
    secondRegistry.close();

    const statePath = path.join(workspacePath, "create-jobs", "state.json");
    assert.equal(fs.existsSync(statePath), true);
    assert.deepEqual(
      fs.readdirSync(path.dirname(statePath)).filter((name) =>
        name.endsWith(".tmp"),
      ),
      [],
    );
  } finally {
    firstRegistry.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("CreateJobRegistry reconciles a stale running job after restart", () => {
  const workspacePath = makeWorkspace();
  const firstRegistry = new CreateJobRegistry({ workspacePath });

  try {
    assert.equal(firstRegistry.start("job-running").status, "started");
    firstRegistry.close();

    const secondRegistry = new CreateJobRegistry({ workspacePath });
    assert.equal(
      secondRegistry.start("job-running").status,
      "pending_cancelled",
    );
    assert.equal(secondRegistry.start("job-running").status, "started");
    secondRegistry.close();
  } finally {
    firstRegistry.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("CreateJobRegistry rejects corrupt persisted state", () => {
  const workspacePath = makeWorkspace();
  const stateDirectory = path.join(workspacePath, "create-jobs");
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.writeFileSync(path.join(stateDirectory, "state.json"), "{}\n");

  try {
    assert.throws(
      () => new CreateJobRegistry({ workspacePath }),
      /Invalid Create job registry state/,
    );
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("a job the registry cannot persist as finished is still finished", () => {
  const workspacePath = makeWorkspace();
  const statePath = path.join(workspacePath, "create-jobs", "state.json");
  const registry = new CreateJobRegistry({ workspacePath });
  const started = registry.start("job-1");
  assert.equal(started.status, "started");

  // The state file cannot be written any more. The job is still over: it has
  // no process behind it, and an entry put back because the file could not be
  // updated would reserve the id forever with nothing left to release it. A
  // state file that still lists the job is recovered on the next start.
  fs.rmSync(statePath, { force: true });
  fs.mkdirSync(statePath, { recursive: true });

  assert.throws(() => registry.finish("job-1"));

  assert.equal(registry.isActive("job-1"), false);
  fs.rmSync(statePath, { recursive: true, force: true });
  assert.equal(registry.start("job-1").status, "started");
  registry.close();
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

/**
 * Which of Stop and the turn decides how a job ended.
 *
 * A turn that has produced an answer asks to settle as completed. Read-then-act
 * could not express that: a cancellation landing between the read and the reply
 * was invisible to the turn and still flipped the job, so one turn ended with
 * two accounts of itself. The claim decides it in one step — and is a
 * reservation until the record behind it is stored, because reporting a
 * completion nobody could read back is the same lie in the other direction.
 */
test("a completion claimed before a cancellation decides the job", async () => {
  const registry = new CreateJobRegistry();
  const started = registry.start("job-1");
  if (started.status !== "started") throw new Error("expected started job");

  assert.equal(registry.claimCompletion("job-1"), "granted");

  const acknowledgement = registry.cancelAndWait("job-1");
  // Stop stays immediately effective: whatever is still listening is
  // interrupted at once. What it no longer does is decide the outcome.
  assert.equal(started.job.controller.signal.aborted, true);
  assert.equal(registry.isCancelled(started.job), false);

  registry.confirmCompletion("job-1");
  registry.finish("job-1");
  assert.deepEqual(await acknowledgement, {
    jobId: "job-1",
    cancelled: false,
    status: "completed",
  });
  registry.close();
});

test("a claim given back is not a completion", async () => {
  const registry = new CreateJobRegistry();
  const started = registry.start("job-1");
  if (started.status !== "started") throw new Error("expected started job");

  assert.equal(registry.claimCompletion("job-1"), "granted");
  const acknowledgement = registry.cancelAndWait("job-1");

  // The record the claim was made for could not be stored, so there is no
  // completion to report and the cancellation held back by the claim applies.
  registry.releaseCompletion("job-1");
  assert.equal(registry.isCancelled(started.job), true);

  registry.finish("job-1");
  assert.deepEqual(await acknowledgement, {
    jobId: "job-1",
    cancelled: true,
    status: "cancelled",
  });
  registry.close();
});

test("a confirmed completion is not given back", async () => {
  const registry = new CreateJobRegistry();
  const started = registry.start("job-1");
  if (started.status !== "started") throw new Error("expected started job");

  assert.equal(registry.claimCompletion("job-1"), "granted");
  registry.confirmCompletion("job-1");

  const acknowledgement = registry.cancelAndWait("job-1");
  // Releasing releases an *unconfirmed* claim. The outcome here is already
  // stored, so a failure in what came after it — a reply, a socket, a stream
  // closing — may not make the job cancellable again.
  registry.releaseCompletion("job-1");
  assert.equal(registry.isCancelled(started.job), false);

  registry.finish("job-1");
  assert.deepEqual(await acknowledgement, {
    jobId: "job-1",
    cancelled: false,
    status: "completed",
  });
  registry.close();
});

test("a cancellation that lands first refuses the claim, and confirming changes nothing", async () => {
  const registry = new CreateJobRegistry();
  const started = registry.start("job-1");
  if (started.status !== "started") throw new Error("expected started job");

  const acknowledgement = registry.cancelAndWait("job-1");
  assert.equal(registry.claimCompletion("job-1"), "cancelled");

  // Confirming without a claim is how the persisted-proposal exception stays
  // honest: that turn reports its stored plan as completed over a cancellation
  // it lost, and retro-claiming the job would tell the person their cancelled
  // turn finished.
  registry.confirmCompletion("job-1");
  assert.equal(registry.isCancelled(started.job), true);

  registry.finish("job-1");
  assert.deepEqual(await acknowledgement, {
    jobId: "job-1",
    cancelled: true,
    status: "cancelled",
  });
  registry.close();
});

test("a claim on a job the registry no longer tracks is refused", () => {
  const registry = new CreateJobRegistry();
  const started = registry.start("job-1");
  if (started.status !== "started") throw new Error("expected started job");
  registry.finish("job-1");

  // Nothing about a job that has ended is still a turn's to decide.
  assert.equal(registry.claimCompletion("job-1"), "cancelled");
  registry.close();
});
