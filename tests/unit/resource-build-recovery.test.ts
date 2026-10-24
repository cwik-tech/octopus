import test from "node:test";
import assert from "node:assert/strict";

import {
  RESOURCE_BUILD_ITEM_STATUSES,
  RESOURCE_BUILD_JOB_STATUSES,
  type ResourceBuildJobSnapshot,
  type ResourceBuildJobStatus,
} from "../../contracts/resource-architect.js";
import {
  API_RESTART_INTERRUPTION_MESSAGE,
  compareResourceBuildJobsNewestFirst,
  isRecoverableResourceBuildJob,
  readLegacyRestartInterruption,
  restorableResourceBuildJob,
} from "../../contracts/resource-build-recovery.js";

/** Whether automatic Create restoration may bring each job status back. */
const JOB_MATRIX: ReadonlyArray<readonly [ResourceBuildJobStatus, boolean]> = [
  ["running", true],
  ["interrupted", true],
  ["partially_completed", true],
  ["completed", false],
  ["failed", false],
  ["cancelled", false],
];

function makeJob(overrides: Partial<ResourceBuildJobSnapshot> = {}): ResourceBuildJobSnapshot {
  return {
    jobId: "job",
    planId: "plan",
    status: "running",
    items: [],
    selectedResource: null,
    events: [],
    ...overrides,
  };
}

test("running, interrupted, and partially completed jobs are recoverable while completed, failed, and cancelled ones are terminal", () => {
  for (const [status, recoverable] of JOB_MATRIX) {
    assert.equal(isRecoverableResourceBuildJob(makeJob({ status })), recoverable, status);
  }
});

test("the recovery matrix names every job status the contract defines", () => {
  assert.deepEqual(
    [...RESOURCE_BUILD_JOB_STATUSES].sort(),
    JOB_MATRIX.map(([status]) => status).sort(),
  );
});

test("a discarded job is terminal whatever its status", () => {
  for (const [status] of JOB_MATRIX) {
    assert.equal(isRecoverableResourceBuildJob(makeJob({ status, discarded: true })), false, status);
  }
});

test("partially completed describes a job, never an item, while interrupted describes both", () => {
  const itemStatuses = new Set<string>(RESOURCE_BUILD_ITEM_STATUSES);
  const jobStatuses = new Set<string>(RESOURCE_BUILD_JOB_STATUSES);

  assert.equal(itemStatuses.has("partially_completed"), false);
  assert.equal(jobStatuses.has("partially_completed"), true);
  assert.equal(itemStatuses.has("interrupted"), true);
  assert.equal(jobStatuses.has("interrupted"), true);
});

test("a newer terminal or discarded job blocks restoring an older interrupted job", () => {
  const older = makeJob({ jobId: "older", planId: "older-plan", status: "interrupted", startedAt: "2026-09-20T08:00:00.000Z" });
  const newerJobs: ResourceBuildJobSnapshot[] = [
    makeJob({ jobId: "newer", status: "failed", startedAt: "2026-09-20T09:00:00.000Z" }),
    makeJob({ jobId: "newer", status: "cancelled", startedAt: "2026-09-20T09:00:00.000Z" }),
    makeJob({ jobId: "newer", status: "completed", startedAt: "2026-09-20T09:00:00.000Z" }),
    makeJob({ jobId: "newer", status: "running", discarded: true, startedAt: "2026-09-20T09:00:00.000Z" }),
    makeJob({ jobId: "newer", status: "interrupted", discarded: true, startedAt: "2026-09-20T09:00:00.000Z" }),
  ];

  for (const newer of newerJobs) {
    // Either input order: the barrier comes from time, not list position.
    assert.equal(restorableResourceBuildJob([older, newer]), undefined, JSON.stringify(newer));
    assert.equal(restorableResourceBuildJob([newer, older]), undefined, JSON.stringify(newer));
  }
});

test("the newest job is restored when it is recoverable, ahead of an older terminal one", () => {
  const olderFailure = makeJob({ jobId: "older", status: "failed", startedAt: "2026-09-20T08:00:00.000Z" });
  const newerInterruption = makeJob({ jobId: "newer", status: "interrupted", startedAt: "2026-09-20T09:00:00.000Z" });

  assert.equal(restorableResourceBuildJob([newerInterruption, olderFailure])?.jobId, "newer");
  assert.equal(restorableResourceBuildJob([olderFailure, newerInterruption])?.jobId, "newer");
  assert.equal(restorableResourceBuildJob([]), undefined);
});

test("jobs sort newest first, dated before undated, with job id ascending on equal or missing times", () => {
  const jobs = [
    makeJob({ jobId: "undated-b" }),
    makeJob({ jobId: "undated-a" }),
    makeJob({ jobId: "early-z", startedAt: "2026-09-20T08:00:00.000Z" }),
    makeJob({ jobId: "late-y", startedAt: "2026-09-20T09:00:00.000Z" }),
    makeJob({ jobId: "late-x", startedAt: "2026-09-20T09:00:00.000Z" }),
  ];

  assert.deepEqual(
    [...jobs].sort(compareResourceBuildJobsNewestFirst).map((job) => job.jobId),
    ["late-x", "late-y", "early-z", "undated-a", "undated-b"],
  );
});

/** A failed job carrying the earlier release's restart message as its error. */
function legacyFailedJob(events: ResourceBuildJobSnapshot["events"]): ResourceBuildJobSnapshot {
  return makeJob({
    status: "failed",
    error: "Resource build was interrupted by an API restart. Retry the build to continue.",
    items: [{
      plannedResource: { kind: "agent", id: "unfinished-lawyer" },
      planIndex: 0,
      status: "failed",
      error: "Resource build was interrupted by an API restart. Retry the build to continue.",
    }],
    events,
  });
}

test("an earlier restart record is read as interrupted only when its closing event carries the application message", () => {
  const started = { id: 1, type: "build_started" as const, message: "Started resource plan `plan`." };
  const exact = "Resource build was interrupted by an API restart. Retry the build to continue.";
  // The literal the earlier release wrote, so a changed constant cannot pass.
  assert.equal(API_RESTART_INTERRUPTION_MESSAGE, exact);

  const migrated = readLegacyRestartInterruption(legacyFailedJob([
    started,
    { id: 2, type: "build_failed", message: exact },
  ]));
  assert.equal(migrated.status, "interrupted");
  assert.equal(migrated.items[0]?.status, "interrupted");
  assert.equal(migrated.events.at(-1)?.type, "build_interrupted");

  const notApplicationRecords: Array<[string, ResourceBuildJobSnapshot["events"]]> = [
    ["no closing event", [started]],
    ["a closing event with provider text", [
      started,
      { id: 2, type: "build_failed", message: "The provider closed the stream." },
    ]],
    ["the message only on an event that does not close the build", [
      started,
      { id: 2, type: "agent_failed", message: exact },
      { id: 3, type: "build_failed", message: "No planned Agent was published." },
    ]],
  ];
  for (const [label, events] of notApplicationRecords) {
    const job = readLegacyRestartInterruption(legacyFailedJob(events));
    assert.equal(job.status, "failed", label);
    assert.equal(job.items[0]?.status, "failed", label);
    assert.deepEqual(job.events, events, label);
  }
});
