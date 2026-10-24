import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  ResourceArchitectPlan,
  ResourceBuildJobSnapshot,
  ResourceArchitectTurnMetric,
} from "../../contracts/resource-architect.js";
import { ResourceArchitectStore } from "../../server/resource-architect-store.js";

const PLAN_FILE = (workspacePath: string, planId: string): string =>
  path.join(
    workspacePath,
    "resource-architect-plans",
    `${createHash("sha256").update(planId, "utf8").digest("hex")}.json`,
  );

const JOB_FILE = (workspacePath: string, jobId: string): string =>
  path.join(
    workspacePath,
    "resource-build-jobs",
    `${createHash("sha256").update(jobId, "utf8").digest("hex")}.json`,
  );

/** Writes exactly these bytes where the store expects a durable record. */
function writeDurableFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function withTempWorkspace(
  fn: (workspacePath: string) => void | Promise<void>,
): Promise<void> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "resource-architect-store-"));
  return Promise.resolve(fn(workspacePath)).finally(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });
}

function buildJob(status: ResourceBuildJobSnapshot["status"]): ResourceBuildJobSnapshot {
  return {
    jobId: "durable-job",
    planId: "durable-plan",
    status,
    items: [],
    selectedResource: null,
    events: [],
  };
}

function standalonePlan(): ResourceArchitectPlan {
  return {
    id: "durable-plan",
    kind: "standalone_agents",
    agents: [],
  };
}

function turnMetric(index: number): ResourceArchitectTurnMetric {
  return {
    schemaVersion: 1,
    recordedAt: new Date(1_700_000_000_000 + index).toISOString(),
    jobId: `turn-${index}`,
    operation: "conversation",
    status: "completed",
    provider: "codex",
    model: "default",
    reasoning: "low",
    outcomeKind: null,
    fallback: false,
    timing: {
      contextAssemblyMs: 2,
      providerDurationMs: 10,
      processSpawnMs: 3,
      firstProviderEventMs: 4,
      firstTextMs: 9,
      parseDurationMs: 0,
      repairOccurred: false,
      repairDurationMs: 0,
      totalDurationMs: 12,
      context: {
        instructionsChars: 10,
        operationChars: 10,
        uploadedDocumentPolicyChars: 10,
        visualizationPolicyChars: 10,
        teamLibraryChars: 10,
        agentLibraryChars: 10,
        totalChars: 60,
        historyChars: 5,
      },
    },
  };
}

test("resource build job listing hydrates durable jobs only once per store", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const store = new ResourceArchitectStore(workspacePath);
    await store.saveJob(buildJob("running"));
    assert.equal((await store.listJobs())[0]?.status, "running");

    const jobsDirectory = path.join(workspacePath, "resource-build-jobs");
    const [jobFile] = fs.readdirSync(jobsDirectory);
    assert.ok(jobFile);
    fs.writeFileSync(
      path.join(jobsDirectory, jobFile),
      `${JSON.stringify(buildJob("failed"))}\n`,
    );

    assert.equal((await store.listJobs())[0]?.status, "running");
  });
});

test("resource build job listing prunes expired terminal jobs and their unreferenced plans", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const original = new ResourceArchitectStore(workspacePath);
    await original.savePlan(standalonePlan());
    await original.saveJob(buildJob("completed"));
    const expiredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    for (const directory of ["resource-architect-plans", "resource-build-jobs"]) {
      const directoryPath = path.join(workspacePath, directory);
      const [file] = fs.readdirSync(directoryPath);
      assert.ok(file);
      fs.utimesSync(path.join(directoryPath, file), expiredAt, expiredAt);
    }

    const reloaded = new ResourceArchitectStore(workspacePath);
    assert.deepEqual(await reloaded.listJobs(), []);
    assert.equal(await reloaded.getPlan("durable-plan"), null);
  });
});

test("resource build job listing retains an old running job and its plan", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const original = new ResourceArchitectStore(workspacePath);
    await original.savePlan(standalonePlan());
    await original.saveJob(buildJob("running"));
    const expiredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    for (const directory of ["resource-architect-plans", "resource-build-jobs"]) {
      const directoryPath = path.join(workspacePath, directory);
      const [file] = fs.readdirSync(directoryPath);
      assert.ok(file);
      fs.utimesSync(path.join(directoryPath, file), expiredAt, expiredAt);
    }

    const reloaded = new ResourceArchitectStore(workspacePath);
    assert.equal((await reloaded.listJobs())[0]?.status, "running");
    assert.deepEqual(await reloaded.getPlan("durable-plan"), standalonePlan());
  });
});

test("resource turn metrics persist only their allow-listed sanitized fields", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const store = new ResourceArchitectStore(workspacePath);
    const unsafeMetric = {
      ...turnMetric(1),
      prompt: "SECRET_PROMPT_CONTENT",
      uploadedDocument: "SECRET_DOCUMENT_CONTENT",
      credentials: "SECRET_CREDENTIAL_CONTENT",
    } as ResourceArchitectTurnMetric;

    await store.saveTurnMetric(unsafeMetric);

    const reloaded = new ResourceArchitectStore(workspacePath);
    assert.deepEqual(await reloaded.listTurnMetrics(), [turnMetric(1)]);
    const telemetryFile = path.join(
      workspacePath,
      "resource-architect-telemetry",
      "turns.json",
    );
    const stored = fs.readFileSync(telemetryFile, "utf8");
    assert.equal(stored.includes("SECRET_"), false);
  });
});

test("a turn recorded before its provider answered survives a restart", async () => {
  // The record written before the model is called is the only account of a
  // turn interrupted while it was running. A reader that refuses that status
  // drops exactly the record that exists to survive a crash.
  await withTempWorkspace(async (workspacePath) => {
    const running = {
      ...turnMetric(1),
      status: "running" as const,
      selection: {
        provider: "openrouter",
        model: "openai/gpt-4o-mini",
        source: "app-default" as const,
        reason: "agent-default" as const,
        caller: "authoring" as const,
      },
    };
    await new ResourceArchitectStore(workspacePath).saveTurnMetric(running);

    assert.deepEqual(
      await new ResourceArchitectStore(workspacePath).listTurnMetrics(),
      [running],
    );
  });
});

test("a recorded default-use survives a restart, and an unreadable one is dropped", async () => {
  // The allow-list above and the durable reader are two separate gates. A
  // selection that the sanitizer keeps but the reader silently drops would
  // leave every restarted process unable to say the default was used, and the
  // in-process test would never notice.
  await withTempWorkspace(async (workspacePath) => {
    const selection = {
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      source: "app-default",
      reason: "agent-default",
      caller: "authoring",
    } as const;
    await new ResourceArchitectStore(workspacePath).saveTurnMetric({
      ...turnMetric(1),
      selection,
    });

    const reloaded = await new ResourceArchitectStore(workspacePath).listTurnMetrics();
    assert.deepEqual(reloaded, [{ ...turnMetric(1), selection }]);
  });

  await withTempWorkspace(async (workspacePath) => {
    // Half a record cannot say how a model was decided. The timing record is
    // still worth keeping, so the metric survives without the claim.
    const telemetryDirectory = path.join(
      workspacePath,
      "resource-architect-telemetry",
    );
    fs.mkdirSync(telemetryDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(telemetryDirectory, "turns.json"),
      JSON.stringify({
        schemaVersion: 1,
        metrics: [
          {
            ...turnMetric(1),
            selection: { provider: "openrouter", source: "app-default" },
          },
        ],
      }),
    );

    const reloaded = await new ResourceArchitectStore(workspacePath).listTurnMetrics();
    assert.deepEqual(reloaded, [turnMetric(1)]);
  });
});

test("resource turn metrics retain the newest 200 records across concurrent writes", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const store = new ResourceArchitectStore(workspacePath);
    await Promise.all(
      Array.from({ length: 205 }, (_, index) => store.saveTurnMetric(turnMetric(index))),
    );

    const reloaded = new ResourceArchitectStore(workspacePath);
    const metrics = await reloaded.listTurnMetrics();
    assert.equal(metrics.length, 200);
    assert.deepEqual(
      metrics.map((metric) => metric.jobId),
      Array.from({ length: 200 }, (_, index) => `turn-${index + 5}`),
    );
  });
});

test("a plan file that does not describe a plan is never loaded", async () => {
  await withTempWorkspace(async (workspacePath) => {
    // Shaped like a plan and readable as JSON, but its Agent has no role. A
    // record read straight through would hand a half-built plan to a build.
    writeDurableFile(
      PLAN_FILE(workspacePath, "durable-plan"),
      `${JSON.stringify({
        id: "durable-plan",
        kind: "standalone_agents",
        agents: [{ name: "scoping-lawyer", tier: "strategic" }],
      })}\n`,
    );

    const store = new ResourceArchitectStore(workspacePath);

    assert.equal(await store.getPlan("durable-plan"), null);
    // Refused once is refused every time: nothing was remembered from it.
    assert.equal(await store.getPlan("durable-plan"), null);
  });
});

test("an update plan survives being written and read back", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const plan: ResourceArchitectPlan = {
      id: "durable-update-plan",
      kind: "resource_updates",
      operations: [{
        kind: "add_team_agents",
        target: { kind: "team", id: "contract-review-team" },
        expectedRevision: `sha256:${"a".repeat(64)}`,
        libraryAgentsToAdd: [
          { name: "scoping-lawyer", role: "Scope reviewer", rationale: "Reuse." },
        ],
        newAgentsToCreate: [{
          name: "drafting-completeness-lawyer",
          role: "Drafting reviewer",
          description: "Checks drafting completeness.",
          rationale: "No existing Agent covers drafting gaps.",
          documentSpecialization: {
            expertiseDomain: "Contract drafting",
            focus: "Missing clauses.",
            evidenceAnchors: ["limitation period"],
            assessmentTargets: ["completeness"],
            outOfScope: ["tax"],
          },
        }],
      }],
    };
    await new ResourceArchitectStore(workspacePath).savePlan(plan);

    assert.deepEqual(await new ResourceArchitectStore(workspacePath).getPlan(plan.id), plan);
  });
});

test("a job file that does not describe a job is never listed", async () => {
  await withTempWorkspace(async (workspacePath) => {
    // A status no build can be in. Listing it would offer the user a job whose
    // state nothing in the system knows how to finish.
    writeDurableFile(
      JOB_FILE(workspacePath, "durable-job"),
      `${JSON.stringify({
        jobId: "durable-job",
        planId: "durable-plan",
        status: "half-done",
        items: [],
        selectedResource: null,
        events: [],
      })}\n`,
    );

    const store = new ResourceArchitectStore(workspacePath);

    assert.deepEqual(await store.listJobs(), []);
    assert.equal(await store.getJob("durable-job"), null);
  });
});

test("a job file whose id does not match its own file is never loaded", async () => {
  await withTempWorkspace(async (workspacePath) => {
    // The file name is the job's identity. A record claiming a different id
    // reached this path some other way, and reading it here would let one job's
    // file answer for another.
    writeDurableFile(
      JOB_FILE(workspacePath, "durable-job"),
      `${JSON.stringify({ ...buildJob("completed"), jobId: "a-different-job" })}\n`,
    );

    const store = new ResourceArchitectStore(workspacePath);

    assert.equal(await store.getJob("durable-job"), null);
    assert.deepEqual(await store.listJobs(), []);
    assert.equal(await store.getJob("a-different-job"), null);
  });
});

test("a plan file whose id does not match its own file is never loaded", async () => {
  await withTempWorkspace(async (workspacePath) => {
    writeDurableFile(
      PLAN_FILE(workspacePath, "durable-plan"),
      `${JSON.stringify({ ...standalonePlan(), id: "a-different-plan" })}\n`,
    );

    const store = new ResourceArchitectStore(workspacePath);

    assert.equal(await store.getPlan("durable-plan"), null);
    assert.equal(await store.getPlan("a-different-plan"), null);
  });
});

test("a store with no workspace answers a record it never held with null", async () => {
  const store = new ResourceArchitectStore();

  assert.equal(await store.getPlan("durable-plan"), null);
  assert.equal(await store.getJob("durable-job"), null);
  assert.deepEqual(await store.listJobs(), []);
});

test("a plan that could not be written durably is not remembered", async () => {
  await withTempWorkspace(async (workspacePath) => {
    // The plans directory cannot be created, so the write fails. A plan the
    // server could not record is not a plan a build may later be started from.
    fs.writeFileSync(path.join(workspacePath, "resource-architect-plans"), "not a directory\n");
    const store = new ResourceArchitectStore(workspacePath);

    await assert.rejects(store.savePlan(standalonePlan()));

    assert.equal(await store.getPlan("durable-plan"), null);
  });
});

test("a job with every optional field survives being written and read back", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const job: ResourceBuildJobSnapshot = {
      jobId: "durable-job",
      planId: "durable-plan",
      status: "partially_completed",
      items: [
        {
          plannedResource: { kind: "team", id: "contract-review-team" },
          resource: { kind: "team", id: "contract-review-team" },
          planIndex: 0,
          status: "updated",
        },
        {
          plannedResource: { kind: "agent", id: "risk-lawyer" },
          planIndex: 1,
          status: "failed",
          error: "the provider refused",
        },
      ],
      selectedResource: { kind: "team", id: "contract-review-team" },
      events: [
        { id: 1, type: "build_started", message: "Started." },
        {
          id: 2,
          type: "agent_created",
          plannedResource: { kind: "agent", id: "risk-lawyer" },
          resource: { kind: "agent", id: "risk-lawyer" },
          planIndex: 1,
          message: "Created Agent `risk-lawyer`.",
        },
      ],
      error: "the provider refused",
    };
    await new ResourceArchitectStore(workspacePath).saveJob(job);

    assert.deepEqual(await new ResourceArchitectStore(workspacePath).getJob(job.jobId), job);
  });
});

/**
 * The event list is checked entry by entry, and one entry the parser does not
 * recognize takes the whole job record with it. A build that repaired a skill
 * would otherwise vanish from history the moment it was read back.
 */
test("a job that reports a repaired skill survives being written and read back", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const job: ResourceBuildJobSnapshot = {
      ...buildJob("completed"),
      items: [{
        plannedResource: { kind: "agent", id: "crypto-risk-compliance-analyst" },
        resource: { kind: "agent", id: "crypto-risk-compliance-analyst" },
        planIndex: 0,
        status: "created",
      }],
      events: [{
        id: 1,
        type: "skill_repaired",
        plannedResource: { kind: "agent", id: "crypto-risk-compliance-analyst" },
        planIndex: 0,
        message:
          "Repaired skill `crypto-scam-and-security-hygiene` to satisfy the Agent Skills specification.",
      }],
    };
    await new ResourceArchitectStore(workspacePath).saveJob(job);

    assert.deepEqual(await new ResourceArchitectStore(workspacePath).getJob(job.jobId), job);
  });
});

test("one malformed stored metric does not discard the history around it", async () => {
  await withTempWorkspace(async (workspacePath) => {
    // The malformed entry has a `timing` object with nothing in it — enough to
    // look like a metric from the outside. Reading the whole file as all or
    // nothing would throw part-way through and leave the user with no history
    // at all rather than with the turns that were recorded correctly.
    writeDurableFile(
      path.join(workspacePath, "resource-architect-telemetry", "turns.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        metrics: [turnMetric(1), { ...turnMetric(2), timing: {} }, turnMetric(3)],
      })}\n`,
    );

    const metrics = await new ResourceArchitectStore(workspacePath).listTurnMetrics();

    assert.deepEqual(metrics.map((metric) => metric.jobId), ["turn-1", "turn-3"]);
  });
});

/** A stored update operation adding one already-existing Agent to `teamId`. */
function storedLibraryOperation(teamId: string): Record<string, unknown> {
  return {
    kind: "add_team_agents",
    target: { kind: "team", id: teamId },
    expectedRevision: `sha256:${"a".repeat(64)}`,
    libraryAgentsToAdd: [
      { name: "scoping-lawyer", role: "Scope reviewer", rationale: "Reuse." },
    ],
    newAgentsToCreate: [],
  };
}

/** A stored update operation creating `agentName` for `teamId`. */
function storedCreateOperation(teamId: string, agentName: string): Record<string, unknown> {
  return {
    kind: "add_team_agents",
    target: { kind: "team", id: teamId },
    expectedRevision: `sha256:${"b".repeat(64)}`,
    libraryAgentsToAdd: [],
    newAgentsToCreate: [{
      name: agentName,
      role: "Drafting reviewer",
      description: "Checks drafting completeness.",
      rationale: "No existing Agent covers drafting gaps.",
    }],
  };
}

function writeStoredPlan(workspacePath: string, operations: unknown[]): void {
  writeDurableFile(
    PLAN_FILE(workspacePath, "durable-plan"),
    `${JSON.stringify({
      id: "durable-plan",
      kind: "resource_updates",
      operations,
    })}\n`,
  );
}

test("a stored plan that updates one Team twice is never loaded", async () => {
  await withTempWorkspace(async (workspacePath) => {
    // The proposal boundary refuses this shape. A file carrying it reached the
    // disk some other way, and running it would put two writes with one
    // revision against the same Team.
    writeStoredPlan(workspacePath, [
      storedLibraryOperation("contract-review-team"),
      storedCreateOperation("contract-review-team", "drafting-completeness-lawyer"),
    ]);

    assert.equal(await new ResourceArchitectStore(workspacePath).getPlan("durable-plan"), null);
  });
});

test("a stored plan that creates one Agent name twice is never loaded", async () => {
  await withTempWorkspace(async (workspacePath) => {
    writeStoredPlan(workspacePath, [
      storedCreateOperation("contract-review-team", "drafting-completeness-lawyer"),
      storedCreateOperation("diligence-team", "drafting-completeness-lawyer"),
    ]);

    assert.equal(await new ResourceArchitectStore(workspacePath).getPlan("durable-plan"), null);
  });
});

test("a stored plan adding one library Agent to two Teams is loaded", async () => {
  await withTempWorkspace(async (workspacePath) => {
    // One identity referenced twice is not one identity created twice, so this
    // plan is as legitimate on the way back in as it was on the way out.
    writeStoredPlan(workspacePath, [
      storedLibraryOperation("contract-review-team"),
      storedLibraryOperation("diligence-team"),
    ]);

    const plan = await new ResourceArchitectStore(workspacePath).getPlan("durable-plan");

    assert.ok(plan);
    assert.equal(plan.kind, "resource_updates");
    if (plan.kind !== "resource_updates") return;
    assert.deepEqual(
      plan.operations.map((operation) => operation.target.id),
      ["contract-review-team", "diligence-team"],
    );
  });
});
