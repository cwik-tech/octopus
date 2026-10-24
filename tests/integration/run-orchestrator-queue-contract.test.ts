import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { RunPlan } from "../../contracts/run-plan.js";
import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import { listOperations } from "../../services/operation-catalog.js";
import { executeOperation } from "../../services/operation-registry.js";
import { TaskQueue } from "../../services/task-queue.js";
import { ServiceError } from "../../services/service-errors.js";
import { WorkspaceDispatcherOwner } from "../../core/workspace-dispatcher-owner.js";
import { currentAttemptScope } from "../support/current-attempt-scope.js";

function makeDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeWorkflowRegistry(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  const registryPath = path.join(directory, "registry.yaml");
  fs.writeFileSync(
    registryPath,
    [
      "discussion-to-writing:",
      "  description: Think through a problem, then write the result.",
      "  template_path: ./discussion-to-writing.yaml",
      "  tags:",
      "    - discussion",
      "    - writing",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(directory, "discussion-to-writing.yaml"),
    [
      "workflow:",
      "  id: discussion-to-writing",
      "  description: Think through a problem, then write the result.",
      "  input:",
      "    artifact: incoming-brief.md",
      "  steps:",
      "    - id: write",
      "      type: team",
      "      team: writing-team",
      "      input_artifact: incoming-brief.md",
      "      result_artifact: final-draft.md",
      "  output:",
      "    from_step: write",
      "    artifact: final-draft.md",
      "  on_blocked: stop",
      "  on_failed: stop",
      "",
    ].join("\n"),
  );
  return registryPath;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs = 1_000,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

test("operation apply uses the real TaskQueue and returns durable admission without waiting for worker startup", async () => {
  const workspacePath = makeDirectory("run-queue-workspace-");
  const registryDirectory = makeDirectory("run-queue-registry-");
  const repoRootPath = process.cwd();
  const workflowsRegistryPath = writeWorkflowRegistry(registryDirectory);
  const sessionStore = new FileSystemSessionStore(workspacePath);
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath });
  let launchCount = 0;
  let markLaunchEntered!: () => void;
  const launchEntered = new Promise<void>((resolve) => {
    markLaunchEntered = resolve;
  });
  const taskQueue = new TaskQueue({
    sessionStore,
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath,
    workspacePath,
    workflowsRegistryPath,
    taskLauncher: {
      async startRun() {
        launchCount += 1;
        markLaunchEntered();
        return await new Promise<never>(() => undefined);
      },
    },
  });

  try {
    await taskQueue.initialize();
    const session = await sessionStore.createSession({ title: "Queued apply" });
    const planned = (await executeOperation(
      "runOrchestrator.plan",
      {
        sessionId: session.id,
        goal: "Think through this operational problem and write a detailed result.",
        workflowId: "discussion-to-writing",
      },
      {
        sessionStore,
        repoRootPath,
        workflowsRegistryPath,
      },
    )) as { plan: RunPlan };

    const applied = (await withTimeout(
      executeOperation(
        "runOrchestrator.apply",
        { sessionId: session.id, plan: planned.plan },
        {
          sessionStore,
          taskQueue,
          repoRootPath,
          workspacePath,
          workflowsRegistryPath,
        },
      ),
    )) as {
      ok: true;
      plan: RunPlan;
      task: {
        id: string;
        status: string;
        admission?: { phase: string; requestId: string; order: string };
      };
      events: Array<{ type: string }>;
    };

    assert.equal(applied.ok, true);
    assert.equal(applied.plan.status, "queued");
    assert.equal(applied.task.status, "queued");
    assert.equal(applied.task.admission?.phase, "pending");
    assert.ok(applied.task.admission?.requestId);
    assert.equal(applied.task.admission?.order, "1");
    assert.equal(applied.events.at(-1)?.type, "workflow_queued");
    assert.equal(applied.plan.applyClaimId, undefined);
    assert.equal(
      (await sessionStore.getRunPlan(session.id))?.applyClaimId,
      undefined,
      "the apply claim must not remain open while admission waits or launches",
    );
    await withTimeout(launchEntered);

    const repeated = (await withTimeout(
      executeOperation(
        "runOrchestrator.apply",
        { sessionId: session.id, plan: planned.plan },
        {
          sessionStore,
          taskQueue,
          repoRootPath,
          workspacePath,
          workflowsRegistryPath,
        },
      ),
    )) as { ok: true; task: { id: string }; events: Array<{ type: string }> };
    assert.equal(repeated.ok, true);
    assert.equal(repeated.task.id, applied.task.id);
    assert.equal(repeated.events.at(-1)?.type, "workflow_already_launched");
    assert.equal(launchCount, 1);
    assert.equal((await sessionStore.listTaskRecords(session.id)).length, 1);
  } finally {
    await taskQueue.close(1);
    await owner.release();
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(registryDirectory, { recursive: true, force: true });
  }
});

test("a queued apply stays claim-free beyond the former apply-claim lease", async () => {
  const workspacePath = makeDirectory("run-queue-lease-workspace-");
  const registryDirectory = makeDirectory("run-queue-lease-registry-");
  const repoRootPath = process.cwd();
  const workflowsRegistryPath = writeWorkflowRegistry(registryDirectory);
  let nowMs = Date.parse("2026-07-14T12:00:00.000Z");
  const sessionStore = new FileSystemSessionStore(workspacePath, {
    instanceId: "queued-apply-lease-contract",
    now: () => new Date(nowMs),
  });
  const owner = await WorkspaceDispatcherOwner.acquire({ workspacePath });
  let launchCount = 0;
  let markBlockerLaunched!: () => void;
  const blockerLaunched = new Promise<void>((resolve) => {
    markBlockerLaunched = resolve;
  });
  const taskQueue = new TaskQueue({
    sessionStore,
    owner,
    maximumConcurrentTasks: 1,
    repoRootPath,
    workspacePath,
    workflowsRegistryPath,
    taskLauncher: {
      async startRun() {
        launchCount += 1;
        markBlockerLaunched();
        return await new Promise<never>(() => undefined);
      },
    },
  });

  try {
    await taskQueue.initialize();
    const blockerSession = await sessionStore.createSession({
      title: "Lease-window blocker",
    });
    const blocker = await sessionStore.createTaskRecord(blockerSession.id, {
      workflowId: "discussion-to-writing",
      brief: "Hold the only admission slot open.",
    });
    assert.ok(blocker);
    const interrupted = await sessionStore.compareAndSetTaskRecord(
      blockerSession.id,
      blocker.id,
      ["queued"],
      {
        status: "interrupted",
        executionAttemptId: "lease-window-old-attempt",
        executionAttemptNumber: 1,
        ...await currentAttemptScope(blocker, 1),
        executionKind: "initial",
        interruptedAt: new Date(nowMs).toISOString(),
        recoveryDisposition: "manual",
        recoveryReason: "Contract-test blocker.",
      },
      { expectedExecutionAttemptId: null },
    );
    assert.equal(interrupted?.updated, true);
    await taskQueue.enqueueRecovery({
      sessionId: blockerSession.id,
      taskId: blocker.id,
      source: "manual_resume",
    });
    await withTimeout(blockerLaunched);

    const session = await sessionStore.createSession({ title: "Queued beyond lease" });
    const planned = (await executeOperation(
      "runOrchestrator.plan",
      {
        sessionId: session.id,
        goal: "Think through this operational problem and write a detailed result.",
        workflowId: "discussion-to-writing",
      },
      {
        sessionStore,
        repoRootPath,
        workflowsRegistryPath,
      },
    )) as { plan: RunPlan };
    const applied = (await executeOperation(
      "runOrchestrator.apply",
      { sessionId: session.id, plan: planned.plan },
      {
        sessionStore,
        taskQueue,
        repoRootPath,
        workspacePath,
        workflowsRegistryPath,
      },
    )) as {
      ok: true;
      plan: RunPlan;
      task: { id: string; admission?: { phase: string } };
    };

    assert.equal(applied.task.admission?.phase, "pending");
    assert.equal(applied.plan.status, "queued");
    assert.equal(applied.plan.applyClaimId, undefined);
    assert.equal(launchCount, 1);

    nowMs += 30_001;
    assert.equal(await sessionStore.recoverOrphanedRunPlanApplies(), false);
    const afterLease = await sessionStore.getRunPlan(session.id);
    assert.equal(afterLease?.status, "queued");
    assert.equal(afterLease?.applyClaimId, undefined);
    assert.equal(
      (await sessionStore.getTaskRecord(session.id, applied.task.id))?.admission
        ?.phase,
      "pending",
    );

    const repeated = (await executeOperation(
      "runOrchestrator.apply",
      { sessionId: session.id, plan: planned.plan },
      {
        sessionStore,
        taskQueue,
        repoRootPath,
        workspacePath,
        workflowsRegistryPath,
      },
    )) as { ok: true; task: { id: string } };
    assert.equal(repeated.task.id, applied.task.id);
    assert.equal(launchCount, 1);
  } finally {
    await taskQueue.close(1);
    await owner.release();
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(registryDirectory, { recursive: true, force: true });
  }
});

test("apply requires admission before claiming and the full operation surface hides direct run start", async () => {
  const workspacePath = makeDirectory("run-queue-required-");
  const registryDirectory = makeDirectory("run-queue-registry-");
  const workflowsRegistryPath = writeWorkflowRegistry(registryDirectory);
  try {
    const sessionStore = new FileSystemSessionStore(workspacePath);
    const session = await sessionStore.createSession({
      title: "Queue required",
    });
    const planned = (await executeOperation(
      "runOrchestrator.plan",
      {
        sessionId: session.id,
        goal: "Think through this operational problem and write a detailed result.",
        workflowId: "discussion-to-writing",
      },
      {
        sessionStore,
        repoRootPath: process.cwd(),
        workflowsRegistryPath,
      },
    )) as { plan: RunPlan };

    await assert.rejects(
      executeOperation(
        "runOrchestrator.apply",
        { sessionId: session.id, plan: planned.plan },
        {
          sessionStore,
          repoRootPath: process.cwd(),
          workspacePath,
          workflowsRegistryPath,
        },
      ),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "not_configured",
    );
    const persisted = await sessionStore.getRunPlan(session.id);
    assert.equal(persisted?.status, "ready");
    assert.equal(persisted?.applyClaimId, undefined);
    assert.deepEqual(await sessionStore.listTaskRecords(session.id), []);

    assert.equal(
      listOperations("runs").some((operation) => operation.id === "runs.start"),
      true,
    );
    assert.equal(
      listOperations("runs", { fullSessionRuntime: true }).some(
        (operation) => operation.id === "runs.start",
      ),
      false,
    );
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(registryDirectory, { recursive: true, force: true });
  }
});
