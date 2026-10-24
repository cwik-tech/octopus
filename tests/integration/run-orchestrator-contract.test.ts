import { whenDefined } from '../../core/optional-properties.js'
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { RunLauncher } from "../../domains/run/run-launcher.js";
import { executeOperation } from "../../services/operation-registry.js";
import { TaskQueue } from "../../services/task-queue.js";
import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import type { RunPlan } from "../../contracts/run-plan.js";
import { WorkspaceDispatcherOwner } from "../../core/workspace-dispatcher-owner.js";

function makeWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitForValue<T>(params: {
  read: () => T | Promise<T>;
  accept: (value: T) => boolean;
  description: string;
  timeoutMs?: number;
}): Promise<T> {
  const deadline = Date.now() + (params.timeoutMs ?? 2_000);
  let value = await params.read();
  while (!params.accept(value) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    value = await params.read();
  }
  assert.ok(params.accept(value), `Timed out waiting for ${params.description}`);
  return value;
}

async function withTaskQueue<T>(
  params: {
    sessionStore: FileSystemSessionStore;
    workspacePath: string;
    repoRootPath: string;
    workflowsRegistryPath?: string;
    taskLauncher: RunLauncher;
  },
  run: (taskQueue: TaskQueue) => Promise<T>,
): Promise<T> {
  const owner = await WorkspaceDispatcherOwner.acquire({
    workspacePath: params.workspacePath,
  });
  const taskQueue = new TaskQueue({
    sessionStore: params.sessionStore,
    owner,
    maximumConcurrentTasks: 3,
    repoRootPath: params.repoRootPath,
    workspacePath: params.workspacePath,
    ...whenDefined(params.workflowsRegistryPath, (workflowsRegistryPath) => ({ workflowsRegistryPath: workflowsRegistryPath })),
    taskLauncher: params.taskLauncher,
  });
  try {
    await taskQueue.initialize();
    return await run(taskQueue);
  } finally {
    await taskQueue.close(2_000);
    await owner.release();
  }
}

function writeWorkflowRegistry(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const registryPath = path.join(dir, "registry.yaml");
  fs.writeFileSync(
    registryPath,
    [
      "discussion-to-writing:",
      "  description: Think through a problem, then write the result.",
      "  template_path: ./discussion-to-writing.yaml",
      "  tags:",
      "    - discussion",
      "    - writing",
      "  capabilities:",
      "    - analysis",
      "    - writing",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "discussion-to-writing.yaml"),
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

function writeInvalidWorkflowRegistry(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const registryPath = path.join(dir, "registry.yaml");
  fs.writeFileSync(
    registryPath,
    [
      "bad-clarify:",
      "  description: Invalid clarification workflow.",
      "  template_path: ./bad-clarify.yaml",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "bad-clarify.yaml"),
    [
      "workflow:",
      "  id: bad-clarify",
      "  description: Invalid clarification workflow.",
      "  input:",
      "    artifact: incoming-brief.md",
      "  steps:",
      "    - id: clarify",
      "      type: team",
      "      team: reception-desk",
      "      input_artifact: incoming-brief.md",
      "      result_artifact: output/clarified-brief.md",
      "      runtime_overrides:",
      "        levels:",
      "          intake:",
      "            discussion:",
      "              participants:",
      "                - receptionist",
      "              min_rounds: 1",
      "              max_rounds: 1",
      "  output:",
      "    from_step: clarify",
      "    artifact: output/clarified-brief.md",
      "  on_blocked: stop",
      "  on_failed: stop",
      "",
    ].join("\n"),
  );
  return registryPath;
}

test("shipped clarify-debate-write passes Start preflight and launches", async () => {
  const workspacePath = makeWorkspace("run-orchestrator-live-clarify-");
  const repoRootPath = process.cwd();
  const workflowsRegistryPath = path.join(
    repoRootPath,
    "workflows",
    "registry.yaml",
  );
  try {
    const sessionStore = new FileSystemSessionStore(workspacePath);
    const session = await sessionStore.createSession({ title: "Live clarify" });
    let launchCount = 0;
    const planned = (await executeOperation(
      "runOrchestrator.plan",
      {
        sessionId: session.id,
        goal:
          "Write an informative one-page overview of US foreign policy for the general public.",
        workflowId: "clarify-debate-write",
      },
      {
        sessionStore,
        repoRootPath,
        workflowsRegistryPath,
      },
    )) as { plan: RunPlan };

    assert.equal(planned.plan.status, "ready");
    assert.equal(planned.plan.selectedWorkflow?.id, "clarify-debate-write");

    const applied = await withTaskQueue(
      {
        sessionStore,
        repoRootPath,
        workspacePath,
        workflowsRegistryPath,
        taskLauncher: {
          async startRun(request) {
            launchCount += 1;
            return { launched: true as const, pid: 123, cwd: request.cwd };
          },
        },
      },
      async (taskQueue) => {
        const accepted = (await executeOperation(
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
          task: {
            workflowId: string;
            status: string;
            admission?: { phase: string };
          };
        };
        await waitForValue({
          read: () => launchCount,
          accept: (count) => count === 1,
          description: "the shipped workflow to reach the launcher",
        });
        return accepted;
      },
    );

    assert.equal(applied.ok, true);
    assert.equal(applied.plan.status, "queued");
    assert.equal(applied.task.workflowId, "clarify-debate-write");
    assert.equal(applied.task.status, "queued");
    assert.equal(applied.task.admission?.phase, "pending");
    assert.equal(launchCount, 1);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("operation registry plans and applies a run through shared services", async () => {
  const workspacePath = makeWorkspace("run-orchestrator-workspace-");
  const registryDir = makeWorkspace("run-orchestrator-registry-");
  try {
    const workflowsRegistryPath = writeWorkflowRegistry(registryDir);
    const sessionStore = new FileSystemSessionStore(workspacePath);
    const session = await sessionStore.createSession({ title: "Run" });
    let launchCount = 0;
    const taskLauncher = {
      async startRun(request: {
        cwd: string;
        env?: Record<string, string>;
        processIdentity?: string;
      }) {
        launchCount += 1;
        assert.equal(
          request.env?.TEAM_RUNTIME_WORKFLOWS_REGISTRY_PATH,
          path.resolve(workflowsRegistryPath),
        );
        const taskId = request.env?.TEAM_RUNTIME_TASK_ID;
        assert.ok(taskId);
        const reservedTask = await sessionStore.getTaskRecord(
          session.id,
          taskId,
        );
        assert.equal(reservedTask?.processIdentity, request.processIdentity);
        assert.equal(reservedTask?.pid, undefined);
        return { launched: true as const, pid: 123, cwd: request.cwd };
      },
    };

    const planned = (await executeOperation(
      "runOrchestrator.plan",
      {
        sessionId: session.id,
        goal: "Think through this problem and write the result.",
        workflowId: "discussion-to-writing",
      },
      {
        sessionStore,
        workflowsRegistryPath,
      },
    )) as { plan: RunPlan };

    assert.equal(planned.plan.status, "ready");
    assert.equal(planned.plan.selectedWorkflow?.id, "discussion-to-writing");
    assert.equal(
      (await sessionStore.getRunPlan(session.id))?.id,
      planned.plan.id,
    );

    await withTaskQueue(
      {
        sessionStore,
        workflowsRegistryPath,
        workspacePath,
        repoRootPath: process.cwd(),
        taskLauncher,
      },
      async (taskQueue) => {
        const context = {
          sessionStore,
          taskQueue,
          workflowsRegistryPath,
          workspacePath,
          repoRootPath: process.cwd(),
        };
        const applied = (await executeOperation(
          "runOrchestrator.apply",
          {
            sessionId: session.id,
            plan: planned.plan,
          },
          context,
        )) as {
          ok: true;
          plan: RunPlan;
          task: {
            id: string;
            workflowId: string;
            status: string;
            admission?: { phase: string };
          };
        };

        assert.equal(applied.ok, true);
        assert.equal(applied.plan.status, "queued");
        assert.equal(applied.task.workflowId, "discussion-to-writing");
        assert.equal(applied.task.status, "queued");
        assert.equal(applied.task.admission?.phase, "pending");

        const repeated = (await executeOperation(
          "runOrchestrator.apply",
          { sessionId: session.id, plan: planned.plan },
          context,
        )) as { ok: true; task: { id: string }; events: Array<{ type: string }> };
        assert.equal(repeated.ok, true);
        assert.equal(repeated.task.id, applied.task.id);
        assert.equal(repeated.events.at(-1)?.type, "workflow_already_launched");
        await waitForValue({
          read: () => launchCount,
          accept: (count) => count === 1,
          description: "the admitted workflow to reach the launcher",
        });
        assert.equal(launchCount, 1);
      },
    );
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test("apply returns durable admission before an asynchronous worker launch failure", async () => {
  const workspacePath = makeWorkspace("run-orchestrator-fast-fail-");
  const registryDir = makeWorkspace("run-orchestrator-registry-");
  try {
    const workflowsRegistryPath = writeWorkflowRegistry(registryDir);
    const sessionStore = new FileSystemSessionStore(workspacePath);
    const session = await sessionStore.createSession({ title: "Fast failure" });
    const planned = (await executeOperation(
      "runOrchestrator.plan",
      {
        sessionId: session.id,
        goal: "Think through this customer problem and write a detailed result.",
        workflowId: "discussion-to-writing",
      },
      { sessionStore, workflowsRegistryPath },
    )) as { plan: RunPlan };

    await withTaskQueue(
      {
        sessionStore,
        workflowsRegistryPath,
        workspacePath,
        repoRootPath: process.cwd(),
        taskLauncher: {
          async startRun() {
            throw new Error("Worker rejected startup.");
          },
        },
      },
      async (taskQueue) => {
        const applied = (await executeOperation(
          "runOrchestrator.apply",
          { sessionId: session.id, plan: planned.plan },
          {
            sessionStore,
            taskQueue,
            workflowsRegistryPath,
            workspacePath,
            repoRootPath: process.cwd(),
          },
        )) as {
          ok: true;
          plan: RunPlan;
          task: { id: string; status: string; admission?: { phase: string } };
          events: Array<{ type: string }>;
        };

        assert.equal(applied.ok, true);
        assert.equal(applied.plan.status, "queued");
        assert.equal(applied.task.status, "queued");
        assert.equal(applied.task.admission?.phase, "pending");
        assert.equal(applied.events.at(-1)?.type, "workflow_queued");
        const failedTask = await waitForValue({
          read: () => sessionStore.getTaskRecord(session.id, applied.task.id),
          accept: (task) => task?.status === "failed",
          description: "the worker launch failure to become terminal",
        });
        assert.match(failedTask?.error ?? "", /Worker rejected startup/);
        const failedPlan = await waitForValue({
          read: () => sessionStore.getRunPlan(session.id),
          accept: (plan) => plan?.status === "failed",
          description: "the terminal task to finalize its plan",
        });
        assert.equal(failedPlan?.taskId, applied.task.id);
      },
    );
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test("apply rejects a stale client plan without launching a task", async () => {
  const workspacePath = makeWorkspace("run-orchestrator-stale-");
  const registryDir = makeWorkspace("run-orchestrator-registry-");
  try {
    const workflowsRegistryPath = writeWorkflowRegistry(registryDir);
    const sessionStore = new FileSystemSessionStore(workspacePath);
    const session = await sessionStore.createSession({ title: "Stale plan" });
    const first = (await executeOperation(
      "runOrchestrator.plan",
      {
        sessionId: session.id,
        goal: "Think through this first problem and write a detailed result.",
        workflowId: "discussion-to-writing",
      },
      { sessionStore, workflowsRegistryPath },
    )) as { plan: RunPlan };
    await executeOperation(
      "runOrchestrator.plan",
      {
        sessionId: session.id,
        goal: "Think through this replacement problem and write a detailed result.",
        workflowId: "discussion-to-writing",
      },
      { sessionStore, workflowsRegistryPath },
    );
    let launchCount = 0;

    await assert.rejects(
      executeOperation(
        "runOrchestrator.apply",
        { sessionId: session.id, plan: first.plan },
        {
          sessionStore,
          workflowsRegistryPath,
          workspacePath,
          repoRootPath: process.cwd(),
          taskLauncher: {
            async startRun(request) {
              launchCount += 1;
              return { launched: true as const, pid: 123, cwd: request.cwd };
            },
          },
        },
      ),
      /stale/i,
    );
    assert.equal(launchCount, 0);
    assert.equal((await sessionStore.listTaskRecords(session.id)).length, 0);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test("concurrent apply calls share one server-owned task", async () => {
  const workspacePath = makeWorkspace("run-orchestrator-concurrent-");
  const registryDir = makeWorkspace("run-orchestrator-registry-");
  try {
    const workflowsRegistryPath = writeWorkflowRegistry(registryDir);
    const sessionStore = new FileSystemSessionStore(workspacePath);
    const session = await sessionStore.createSession({ title: "Concurrent apply" });
    const planned = (await executeOperation(
      "runOrchestrator.plan",
      {
        sessionId: session.id,
        goal: "Think through this concurrency problem and write a detailed result.",
        workflowId: "discussion-to-writing",
      },
      { sessionStore, workflowsRegistryPath },
    )) as { plan: RunPlan };

    let releaseLaunch!: () => void;
    const launchReleased = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    let notifyLaunchStarted!: () => void;
    const launchStarted = new Promise<void>((resolve) => {
      notifyLaunchStarted = resolve;
    });
    let launchCount = 0;
    const taskLauncher = {
        async startRun(request: { cwd: string }) {
          launchCount += 1;
          notifyLaunchStarted();
          await launchReleased;
          return { launched: true as const, pid: 123, cwd: request.cwd };
        },
    };
    await withTaskQueue(
      {
        sessionStore,
        workflowsRegistryPath,
        workspacePath,
        repoRootPath: process.cwd(),
        taskLauncher,
      },
      async (taskQueue) => {
        const context = {
          sessionStore,
          taskQueue,
          workflowsRegistryPath,
          workspacePath,
          repoRootPath: process.cwd(),
        };
        const firstApply = executeOperation(
          "runOrchestrator.apply",
          { sessionId: session.id, plan: planned.plan },
          context,
        ) as Promise<{ ok: true; task: { id: string; status: string } }>;
        await launchStarted;
        const secondApply = executeOperation(
          "runOrchestrator.apply",
          { sessionId: session.id, plan: planned.plan },
          context,
        ) as Promise<{ ok: true; task: { id: string; status: string } }>;
        const [firstResult, secondResult] = await Promise.all([
          firstApply,
          secondApply,
        ]);

        assert.equal(firstResult.ok, true);
        assert.equal(secondResult.ok, true);
        assert.equal(firstResult.task.status, "queued");
        assert.equal(secondResult.task.id, firstResult.task.id);
        assert.equal(launchCount, 1);
        assert.equal((await sessionStore.listTaskRecords(session.id)).length, 1);
        releaseLaunch();
      },
    );
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test("concurrent apply calls share admission before an asynchronous launch failure", async () => {
  const workspacePath = makeWorkspace("run-orchestrator-concurrent-failure-");
  const registryDir = makeWorkspace("run-orchestrator-registry-");
  try {
    const workflowsRegistryPath = writeWorkflowRegistry(registryDir);
    const sessionStore = new FileSystemSessionStore(workspacePath);
    const session = await sessionStore.createSession({ title: "Concurrent failure" });
    const planned = (await executeOperation(
      "runOrchestrator.plan",
      {
        sessionId: session.id,
        goal: "Think through this launch failure and write a detailed result.",
        workflowId: "discussion-to-writing",
      },
      { sessionStore, workflowsRegistryPath },
    )) as { plan: RunPlan };

    let releaseLaunch!: () => void;
    const launchReleased = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    let notifyLaunchStarted!: () => void;
    const launchStarted = new Promise<void>((resolve) => {
      notifyLaunchStarted = resolve;
    });
    let launchCount = 0;
    const taskLauncher = {
        async startRun() {
          launchCount += 1;
          notifyLaunchStarted();
          await launchReleased;
          throw new Error("Launcher rejected startup.");
        },
    };
    await withTaskQueue(
      {
        sessionStore,
        workflowsRegistryPath,
        workspacePath,
        repoRootPath: process.cwd(),
        taskLauncher,
      },
      async (taskQueue) => {
        const context = {
          sessionStore,
          taskQueue,
          workflowsRegistryPath,
          workspacePath,
          repoRootPath: process.cwd(),
        };
        const firstApply = executeOperation(
          "runOrchestrator.apply",
          { sessionId: session.id, plan: planned.plan },
          context,
        ) as Promise<{ ok: true; task: { id: string; status: string } }>;
        await launchStarted;
        const secondApply = executeOperation(
          "runOrchestrator.apply",
          { sessionId: session.id, plan: planned.plan },
          context,
        ) as Promise<{
          ok: true;
          task: { id: string; status: string };
          events: Array<{ type: string }>;
        }>;
        const [firstResult, secondResult] = await Promise.all([
          firstApply,
          secondApply,
        ]);

        assert.equal(firstResult.ok, true);
        assert.equal(secondResult.ok, true);
        assert.equal(firstResult.task.status, "queued");
        assert.equal(secondResult.task.id, firstResult.task.id);
        assert.equal(secondResult.events.at(-1)?.type, "workflow_already_launched");
        releaseLaunch();
        const failedTask = await waitForValue({
          read: () => sessionStore.getTaskRecord(session.id, firstResult.task.id),
          accept: (task) => task?.status === "failed",
          description: "the shared task launch failure to become terminal",
        });
        assert.match(failedTask?.error ?? "", /Launcher rejected startup/);
        assert.equal(launchCount, 1);
        await waitForValue({
          read: () => sessionStore.getRunPlan(session.id),
          accept: (plan) => plan?.status === "failed",
          description: "the shared failed task to finalize its plan",
        });
      },
    );
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test("a legacy queued apply left by a crashed API is linked and reused on restart", async () => {
  const workspacePath = makeWorkspace("run-orchestrator-crash-window-");
  const registryDir = makeWorkspace("run-orchestrator-registry-");
  try {
    const workflowsRegistryPath = writeWorkflowRegistry(registryDir);
    const originalStore = new FileSystemSessionStore(workspacePath, {
      instanceId: "api-before-crash",
      processId: 41_001,
    });
    const session = await originalStore.createSession({ title: "Crash window" });
    const planned = (await executeOperation(
      "runOrchestrator.plan",
      {
        sessionId: session.id,
        goal: "Think through this crash window and write a detailed result.",
        workflowId: "discussion-to-writing",
      },
      { sessionStore: originalStore, workflowsRegistryPath },
    )) as { plan: RunPlan };
    const claim = await originalStore.claimRunPlanForApply(
      session.id,
      planned.plan.id,
    );
    assert.equal(claim?.claimed, true);
    const queued = await originalStore.createTaskRecord(session.id, {
      workflowId: "discussion-to-writing",
      brief: "The API crashes before starting a worker.",
    });
    assert.ok(queued);

    let launchCount = 0;
    const restartedStore = new FileSystemSessionStore(workspacePath, {
      instanceId: "api-after-crash",
      processId: 41_002,
      isProcessAlive: (pid) => pid !== 41_001,
    });
    const result = await withTaskQueue(
      {
        sessionStore: restartedStore,
        workflowsRegistryPath,
        workspacePath,
        repoRootPath: process.cwd(),
        taskLauncher: {
          async startRun(request) {
            launchCount += 1;
            return { launched: true as const, pid: 123, cwd: request.cwd };
          },
        },
      },
      async (taskQueue) => {
        const accepted = (await executeOperation(
          "runOrchestrator.apply",
          { sessionId: session.id, plan: planned.plan },
          {
            sessionStore: restartedStore,
            taskQueue,
            workflowsRegistryPath,
            workspacePath,
            repoRootPath: process.cwd(),
          },
        )) as {
          ok: true;
          task: { id: string; status: string; error?: string };
          plan: RunPlan;
        };
        await waitForValue({
          read: () => launchCount,
          accept: (count) => count === 1,
          description: "the retried crash-window task to reach the launcher",
        });
        return accepted;
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.task.id, queued.id);
    assert.ok(
      result.plan.status === "queued" || result.plan.status === "running",
      `expected accepted plan to be queued or running, got ${result.plan.status}`,
    );
    assert.ok(
      result.task.status === "queued" || result.task.status === "running",
      `expected accepted task to be queued or running, got ${result.task.status}`,
    );
    assert.equal(result.plan.taskId, result.task.id);
    assert.equal(
      (await restartedStore.getTaskRecord(session.id, queued.id))?.runPlanId,
      planned.plan.id,
    );
    assert.equal((await restartedStore.listTaskRecords(session.id)).length, 1);
    assert.equal(launchCount, 1);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test("a duplicate apply reuses a queued task without waiting for startup", async () => {
  const workspacePath = makeWorkspace("run-orchestrator-startup-timeout-");
  const registryDir = makeWorkspace("run-orchestrator-registry-");
  try {
    const workflowsRegistryPath = writeWorkflowRegistry(registryDir);
    const sessionStore = new FileSystemSessionStore(workspacePath, {
      instanceId: "launching-api",
    });
    const session = await sessionStore.createSession({ title: "Startup timeout" });
    const planned = (await executeOperation(
      "runOrchestrator.plan",
      {
        sessionId: session.id,
        goal: "Think through this unresolved startup and write a detailed result.",
        workflowId: "discussion-to-writing",
      },
      { sessionStore, workflowsRegistryPath },
    )) as { plan: RunPlan };
    const claim = await sessionStore.claimRunPlanForApply(
      session.id,
      planned.plan.id,
    );
    assert.equal(claim?.claimed, true);
    const queued = await sessionStore.createTaskRecord(session.id, {
      workflowId: "discussion-to-writing",
      brief: "Worker startup remains unresolved.",
    });
    assert.ok(queued);

    const startedAt = Date.now();
    const repeated = (await executeOperation(
      "runOrchestrator.apply",
      { sessionId: session.id, plan: planned.plan },
      {
        sessionStore,
        workflowsRegistryPath,
        workspacePath,
        repoRootPath: process.cwd(),
      },
    )) as {
      ok: true;
      plan: RunPlan;
      task: { id: string; status: string };
      events: Array<{ type: string }>;
    };
    const elapsedMs = Date.now() - startedAt;

    assert.equal(repeated.ok, true);
    assert.equal(repeated.task.id, queued.id);
    assert.equal(repeated.task.status, "queued");
    assert.equal(repeated.events.at(-1)?.type, "workflow_already_launched");
    assert.ok(elapsedMs < 500, `duplicate apply waited ${elapsedMs}ms`);
    assert.equal(
      (await sessionStore.getTaskRecord(session.id, queued.id))?.status,
      "queued",
    );
    assert.equal((await sessionStore.getRunPlan(session.id))?.status, "applying");
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test("a restarted API reclaims an apply that crashed before task creation", async () => {
  const workspacePath = makeWorkspace("run-orchestrator-claimed-");
  const registryDir = makeWorkspace("run-orchestrator-registry-");
  try {
    const workflowsRegistryPath = writeWorkflowRegistry(registryDir);
    const originalStore = new FileSystemSessionStore(workspacePath, {
      instanceId: "crashed-api",
      processId: 42_001,
    });
    const session = await originalStore.createSession({ title: "Claimed plan" });
    const planned = (await executeOperation(
      "runOrchestrator.plan",
      {
        sessionId: session.id,
        goal: "Think through this claimed plan and write a detailed result.",
        workflowId: "discussion-to-writing",
      },
      { sessionStore: originalStore, workflowsRegistryPath },
    )) as { plan: RunPlan };
    const claim = await originalStore.claimRunPlanForApply(
      session.id,
      planned.plan.id,
    );
    assert.equal(claim?.claimed, true);

    const restartedStore = new FileSystemSessionStore(workspacePath, {
      instanceId: "restarted-api",
      processId: 42_002,
      isProcessAlive: (pid) => pid !== 42_001,
    });
    let launches = 0;
    const result = await withTaskQueue(
      {
        sessionStore: restartedStore,
        workflowsRegistryPath,
        workspacePath,
        repoRootPath: process.cwd(),
        taskLauncher: {
          async startRun(request) {
            launches += 1;
            return { launched: true as const, pid: 123, cwd: request.cwd };
          },
        },
      },
      async (taskQueue) => {
        const accepted = (await executeOperation(
          "runOrchestrator.apply",
          { sessionId: session.id, plan: planned.plan },
          {
            sessionStore: restartedStore,
            taskQueue,
            workflowsRegistryPath,
            workspacePath,
            repoRootPath: process.cwd(),
          },
        )) as { ok: true; plan: RunPlan; task: { id: string; status: string } };
        await waitForValue({
          read: () => launches,
          accept: (count) => count === 1,
          description: "the reclaimed apply to reach the launcher",
        });
        return accepted;
      },
    );

    assert.equal(result.ok, true);
    assert.ok(
      result.plan.status === "queued" || result.plan.status === "running",
      `expected accepted plan to be queued or running, got ${result.plan.status}`,
    );
    assert.ok(
      result.task.status === "queued" || result.task.status === "running",
      `expected accepted task to be queued or running, got ${result.task.status}`,
    );
    assert.equal(result.plan.taskId, result.task.id);
    assert.equal(launches, 1);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test("a restarted API repairs and reuses a task written before its plan link", async () => {
  const workspacePath = makeWorkspace("run-orchestrator-linked-crash-");
  const registryDir = makeWorkspace("run-orchestrator-registry-");
  try {
    const workflowsRegistryPath = writeWorkflowRegistry(registryDir);
    const originalStore = new FileSystemSessionStore(workspacePath, {
      instanceId: "crashed-api",
      processId: 43_001,
    });
    const session = await originalStore.createSession({ title: "Linked task crash" });
    const planned = (await executeOperation(
      "runOrchestrator.plan",
      {
        sessionId: session.id,
        goal: "Think through this linked crash and write a detailed result.",
        workflowId: "discussion-to-writing",
      },
      { sessionStore: originalStore, workflowsRegistryPath },
    )) as { plan: RunPlan };
    const claim = await originalStore.claimRunPlanForApply(
      session.id,
      planned.plan.id,
    );
    assert.equal(claim?.claimed, true);
    const abandoned = await originalStore.createTaskRecord(session.id, {
      workflowId: "discussion-to-writing",
      brief: "The API crashed before spawning this queued task.",
      runPlanId: planned.plan.id,
      ...whenDefined(claim?.plan.applyClaimId, (runPlanApplyClaimId) => ({ runPlanApplyClaimId: runPlanApplyClaimId })),
    });
    assert.ok(abandoned);
    assert.equal((await originalStore.getRunPlan(session.id))?.taskId, abandoned.id);
    fs.writeFileSync(
      path.join(workspacePath, "sessions", session.id, "run-plan.json"),
      `${JSON.stringify(claim!.plan, null, 2)}\n`,
    );
    assert.equal((await originalStore.getRunPlan(session.id))?.taskId, undefined);

    const restartedStore = new FileSystemSessionStore(workspacePath, {
      instanceId: "restarted-api",
      processId: 43_002,
      isProcessAlive: (pid) => pid !== 43_001,
    });
    let launches = 0;
    const result = await withTaskQueue(
      {
        sessionStore: restartedStore,
        workflowsRegistryPath,
        workspacePath,
        repoRootPath: process.cwd(),
        taskLauncher: {
          async startRun(request) {
            launches += 1;
            return { launched: true as const, pid: 124, cwd: request.cwd };
          },
        },
      },
      async (taskQueue) => {
        const accepted = (await executeOperation(
          "runOrchestrator.apply",
          { sessionId: session.id, plan: planned.plan },
          {
            sessionStore: restartedStore,
            taskQueue,
            workflowsRegistryPath,
            workspacePath,
            repoRootPath: process.cwd(),
          },
        )) as { ok: true; plan: RunPlan; task: { id: string; status: string } };
        await waitForValue({
          read: () => launches,
          accept: (count) => count === 1,
          description: "the recovered plan-link task to reach the launcher",
        });
        return accepted;
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.task.id, abandoned.id);
    assert.ok(
      result.plan.status === "queued" || result.plan.status === "running",
      `expected accepted plan to be queued or running, got ${result.plan.status}`,
    );
    assert.ok(
      result.task.status === "queued" || result.task.status === "running",
      `expected accepted task to be queued or running, got ${result.task.status}`,
    );
    assert.equal(result.plan.taskId, result.task.id);
    assert.equal(launches, 1);
    assert.equal(
      (await restartedStore.getTaskRecord(session.id, abandoned.id))?.runPlanId,
      planned.plan.id,
    );
    assert.equal((await restartedStore.listTaskRecords(session.id)).length, 1);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test("a restarted API reuses a pre-spawn task when no worker exists", async () => {
  const workspacePath = makeWorkspace("run-orchestrator-pre-spawn-crash-");
  const registryDir = makeWorkspace("run-orchestrator-registry-");
  try {
    const workflowsRegistryPath = writeWorkflowRegistry(registryDir);
    const originalStore = new FileSystemSessionStore(workspacePath, {
      instanceId: "pre-spawn-api",
      processId: 44_001,
    });
    const session = await originalStore.createSession({ title: "Pre-spawn crash" });
    const planned = (await executeOperation(
      "runOrchestrator.plan",
      {
        sessionId: session.id,
        goal: "Think through this pre-spawn crash and write a detailed result.",
        workflowId: "discussion-to-writing",
      },
      { sessionStore: originalStore, workflowsRegistryPath },
    )) as { plan: RunPlan };
    const claim = await originalStore.claimRunPlanForApply(
      session.id,
      planned.plan.id,
    );
    assert.ok(claim?.claimed);
    assert.ok(claim.plan.applyClaimId);
    const abandoned = await originalStore.createTaskRecord(session.id, {
      workflowId: "discussion-to-writing",
      brief: "The API reserved a process identity but crashed before spawn.",
      runPlanId: planned.plan.id,
      runPlanApplyClaimId: claim.plan.applyClaimId,
    });
    assert.ok(abandoned);
    const reserved = await originalStore.compareAndSetTaskRecord(
      session.id,
      abandoned.id,
      ["queued"],
      { processIdentity: "worker-never-spawned" },
    );
    assert.equal(reserved?.updated, true);

    const restartedStore = new FileSystemSessionStore(workspacePath, {
      instanceId: "restarted-api",
      processId: 44_002,
      isProcessAlive: (pid) => pid !== 44_001,
      findProcessByIdentity: () => null,
    });
    let launches = 0;
    const result = await withTaskQueue(
      {
        sessionStore: restartedStore,
        workflowsRegistryPath,
        workspacePath,
        repoRootPath: process.cwd(),
        taskLauncher: {
          async startRun(request) {
            launches += 1;
            return { launched: true as const, pid: 125, cwd: request.cwd };
          },
        },
      },
      async (taskQueue) => {
        const accepted = (await executeOperation(
          "runOrchestrator.apply",
          { sessionId: session.id, plan: planned.plan },
          {
            sessionStore: restartedStore,
            taskQueue,
            workflowsRegistryPath,
            workspacePath,
            repoRootPath: process.cwd(),
          },
        )) as { ok: true; plan: RunPlan; task: { id: string; status: string } };
        await waitForValue({
          read: () => launches,
          accept: (count) => count === 1,
          description: "the pre-spawn retry to reach the launcher",
        });
        return accepted;
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.task.id, abandoned.id);
    assert.ok(
      result.plan.status === "queued" || result.plan.status === "running",
      `expected accepted plan to be queued or running, got ${result.plan.status}`,
    );
    assert.ok(
      result.task.status === "queued" || result.task.status === "running",
      `expected accepted task to be queued or running, got ${result.task.status}`,
    );
    assert.equal(launches, 1);
    assert.equal((await restartedStore.listTaskRecords(session.id)).length, 1);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test("a live second API cannot steal a launch claim and stale tokens cannot create tasks", async () => {
  const workspacePath = makeWorkspace("run-orchestrator-live-owner-");
  const registryDir = makeWorkspace("run-orchestrator-registry-");
  try {
    const workflowsRegistryPath = writeWorkflowRegistry(registryDir);
    const ownerStore = new FileSystemSessionStore(workspacePath, {
      instanceId: "live-owner",
      processId: 45_001,
    });
    const session = await ownerStore.createSession({ title: "Live owner" });
    const planned = (await executeOperation(
      "runOrchestrator.plan",
      {
        sessionId: session.id,
        goal: "Think through this live ownership race and write a detailed result.",
        workflowId: "discussion-to-writing",
      },
      { sessionStore: ownerStore, workflowsRegistryPath },
    )) as { plan: RunPlan };
    const ownerClaim = await ownerStore.claimRunPlanForApply(
      session.id,
      planned.plan.id,
    );
    assert.ok(ownerClaim?.claimed);
    assert.ok(ownerClaim.plan.applyClaimId);

    const competingStore = new FileSystemSessionStore(workspacePath, {
      instanceId: "live-competitor",
      processId: 45_002,
      isProcessAlive: (pid) => pid === 45_001,
    });
    let competingLaunches = 0;
    await assert.rejects(
      executeOperation(
        "runOrchestrator.apply",
        { sessionId: session.id, plan: planned.plan },
        {
          sessionStore: competingStore,
          workflowsRegistryPath,
          workspacePath,
          repoRootPath: process.cwd(),
          taskLauncher: {
            async startRun(request) {
              competingLaunches += 1;
              return { launched: true as const, pid: 126, cwd: request.cwd };
            },
          },
        },
      ),
      /already being applied/i,
    );
    assert.equal(competingLaunches, 0);
    assert.equal((await competingStore.listTaskRecords(session.id)).length, 0);

    const recoveryStore = new FileSystemSessionStore(workspacePath, {
      instanceId: "replacement-owner",
      processId: 45_003,
      isProcessAlive: () => false,
    });
    assert.equal(
      (await recoveryStore.recoverRunPlanApply(session.id, planned.plan.id))?.status,
      "ready",
    );
    const replacementClaim = await recoveryStore.claimRunPlanForApply(
      session.id,
      planned.plan.id,
    );
    assert.ok(replacementClaim?.claimed);
    assert.ok(replacementClaim.plan.applyClaimId);

    const staleTask = await ownerStore.createTaskRecord(session.id, {
      workflowId: "discussion-to-writing",
      brief: "The stale owner must not create this task.",
      runPlanId: planned.plan.id,
      runPlanApplyClaimId: ownerClaim.plan.applyClaimId,
    });
    assert.equal(staleTask, null);
    const replacementTask = await recoveryStore.createTaskRecord(session.id, {
      workflowId: "discussion-to-writing",
      brief: "Only the replacement owner can create this task.",
      runPlanId: planned.plan.id,
      runPlanApplyClaimId: replacementClaim.plan.applyClaimId,
    });
    assert.ok(replacementTask);
    assert.equal((await recoveryStore.listTaskRecords(session.id)).length, 1);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test("operation registry cancellation persists cancelled and closes the plan", async () => {
  const workspacePath = makeWorkspace("run-orchestrator-cancel-");
  try {
    const sessionStore = new FileSystemSessionStore(workspacePath, {
      instanceId: "api-instance",
    });
    const session = await sessionStore.createSession({ title: "Cancel" });
    const plan: RunPlan = {
      id: "cancel-plan",
      goal: "Run then cancel.",
      summary: "Ready",
      status: "ready",
      selectedWorkflow: {
        id: "wf-1",
        confidence: "high",
        rationale: "Selected for cancellation testing.",
      },
      requiredInputs: [],
      actions: [{
        id: "launch-workflow",
        type: "launch_workflow",
        status: "ready",
        title: "Launch wf-1",
        rationale: "Ready.",
      }],
      warnings: [],
      createdAt: new Date().toISOString(),
    };
    await sessionStore.saveRunPlan(session.id, plan);
    const task = await sessionStore.createTaskRecord(session.id, {
      workflowId: "wf-1",
      brief: "Run then cancel.",
    });
    assert.ok(task);
    await sessionStore.compareAndSetTaskRecord(session.id, task.id, ["queued"], {
      status: "running",
    });

    const cancelled = (await executeOperation(
      "runOrchestrator.cancel",
      { sessionId: session.id, taskId: task.id },
      { sessionStore },
    )) as { task: { status: string } };

    assert.equal(cancelled.task.status, "cancelled");
    assert.equal((await sessionStore.getRunPlan(session.id))?.status, "cancelled");
    assert.equal((await sessionStore.getSession(session.id))?.status, "done");
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("operation registry refuses to apply a run plan that still needs details", async () => {
  const workspacePath = makeWorkspace("run-orchestrator-workspace-");
  const registryDir = makeWorkspace("run-orchestrator-registry-");
  try {
    const workflowsRegistryPath = writeWorkflowRegistry(registryDir);
    const sessionStore = new FileSystemSessionStore(workspacePath);
    const session = await sessionStore.createSession({ title: "Run" });
    let launchCount = 0;

    const planned = (await executeOperation(
      "runOrchestrator.plan",
      {
        sessionId: session.id,
        goal: "Create a site structure.",
        workflowId: "discussion-to-writing",
      },
      {
        sessionStore,
        workflowsRegistryPath,
      },
    )) as { plan: RunPlan };

    assert.equal(planned.plan.status, "needs_input");
    assert.ok(planned.plan.requiredInputs.includes("specific task details"));

    const applied = (await executeOperation(
      "runOrchestrator.apply",
      {
        sessionId: session.id,
        plan: planned.plan,
      },
      {
        sessionStore,
        workflowsRegistryPath,
        workspacePath,
        repoRootPath: process.cwd(),
        taskLauncher: {
          async startRun(request) {
            launchCount += 1;
            return { launched: true as const, pid: 123, cwd: request.cwd };
          },
        },
      },
    )) as { ok: false; status: string; plan: RunPlan };

    assert.equal(applied.ok, false);
    assert.equal(applied.status, "needs_input");
    assert.equal(applied.plan.status, "needs_input");
    assert.equal(launchCount, 0);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test("operation registry rejects invalid workflow overrides before launching", async () => {
  const workspacePath = makeWorkspace("run-orchestrator-workspace-");
  const registryDir = makeWorkspace("run-orchestrator-registry-");
  try {
    const workflowsRegistryPath = writeInvalidWorkflowRegistry(registryDir);
    const sessionStore = new FileSystemSessionStore(workspacePath);
    const session = await sessionStore.createSession({ title: "Run" });
    let launchCount = 0;
    const plan: RunPlan = {
      id: "ready-invalid-plan",
      goal: "Clarify and write a website plan for customer discovery students.",
      summary: "Ready",
      status: "ready",
      selectedWorkflow: {
        id: "bad-clarify",
        confidence: "high",
        rationale: "Selected for test.",
      },
      requiredInputs: [],
      brief: "Clarify and write a website plan for customer discovery students.",
      actions: [],
      warnings: [],
      createdAt: new Date().toISOString(),
    };
    await sessionStore.saveRunPlan(session.id, plan);

    const applied = (await executeOperation(
      "runOrchestrator.apply",
      {
        sessionId: session.id,
        plan,
      },
      {
        sessionStore,
        workflowsRegistryPath,
        workspacePath,
        repoRootPath: process.cwd(),
        taskLauncher: {
          async startRun(request) {
            launchCount += 1;
            return { launched: true as const, pid: 123, cwd: request.cwd };
          },
        },
      },
    )) as { ok: false; status: string; statusCode: number; detail?: string };

    assert.equal(applied.ok, false);
    assert.equal(applied.status, "failed");
    assert.equal(applied.statusCode, 400);
    assert.match(applied.detail ?? "", /declares discussion settings/);
    assert.match(applied.detail ?? "", /level is type 'routing'/);
    assert.equal(launchCount, 0);
    assert.equal((await sessionStore.listTaskRecords(session.id)).length, 0);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});
