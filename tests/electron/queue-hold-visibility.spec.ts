import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { TaskAdmission } from "../../contracts/sessions.js";
import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import { currentAttemptScope } from "../support/current-attempt-scope.js";
import { fixtureDesktopEnvironment } from "../support/desktop-journey-environment.js";
import {
  describeErrors,
  stopAllCarrying,
  stopProcessesCarrying,
} from "../support/fixture-process-markers.js";

// A5.2, the desktop journey: a blocked queue names the task holding the only
// slot and why; once that task's worker stops, the notice clears and the
// waiting task starts. Real desktop, API and filesystem.
//
// Arranged before launch through the real session store: a cancelled task
// whose granted slot is held because its recorded worker is alive but does
// not carry the task's identity, as after a pid was reused. The worker is a
// fixture process with a marker of its own, registered before it starts,
// stopped only after that marker is read again, and always cleaned up. The
// waiting task is started through the API, as the live queue journey does.
// The queue view refreshes on its own every second; every wait here is a
// web-first assertion on what the page shows, or the task record itself.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const queueWorkflowId = "packaged-smoke";
const HOLD_SENTENCE =
  "Its recorded worker is still running but cannot be confirmed as this task's, so it is not stopped automatically. New work starts once it exits.";

test("a blocked queue names the held task and why; stopping its worker clears it and the waiting task starts", async ({}, testInfo) => {
  test.setTimeout(150_000);
  const userDataPath = testInfo.outputPath("queue-hold-user-data");
  const workspacePath = testInfo.outputPath("queue-hold-workspace");
  const projectRootPath = testInfo.outputPath("queue-hold-project");
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
    fs.cp(path.join(repoRoot, "tests", "fixtures", "packaged-workflow-smoke"), projectRootPath, {
      recursive: true,
    }),
  ]);

  const markers: string[] = [];
  const failures: unknown[] = [];
  let app: ElectronApplication | undefined;
  let apiBaseUrl: string | null = null;
  const startedTasks: TaskView[] = [];
  try {
    // ── Arrange: the held task, seeded as the product records it ──
    const store = new FileSystemSessionStore(workspacePath, { instanceId: "queue-hold-journey-seed" });
    const session = await store.createSession({ title: "Held research" });
    const created = await store.createTaskRecord(session.id, {
      workflowId: queueWorkflowId,
      brief: "Held by a worker that cannot be confirmed.",
    });
    expect(created, "the held task is created").not.toBeNull();
    if (!created) return;
    const marker = `--queue-hold-journey-fixture=${randomUUID()}`;
    markers.push(marker);
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)", "--", marker], {
      detached: true,
      stdio: "ignore",
    });
    await once(worker, "spawn");
    const workerPid = worker.pid;
    expect(workerPid, "the fixture worker has a pid").toEqual(expect.any(Number));
    if (workerPid === undefined) return;
    const executionAttemptId = `attempt-${created.id}`;
    const seeded = await store.compareAndSetTaskRecord(
      session.id,
      created.id,
      ["queued"],
      {
        status: "cancelled",
        admission: grantedAdmission(executionAttemptId),
        processIdentity: executionAttemptId,
        executionAttemptId,
        executionAttemptNumber: 1,
        executionKind: "initial",
        attemptStartedAt: new Date().toISOString(),
        workerStartedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: "Cancelled by user",
        pid: workerPid,
        processGroupId: workerPid,
        ...(await currentAttemptScope(created, 1)),
      },
      { expectedExecutionAttemptId: null },
    );
    expect(seeded?.updated, "the held task is seeded").toBe(true);

    // ── Launch, and start a task that has to wait for the only slot ──
    app = await launchDesktop(userDataPath, {
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
      TEAM_RUNTIME_TASK_RUNNER_DRY_RUN: "1",
      // Keeps the waiting task's real worker alive long enough to see it
      // started, as the live queue journey does.
      TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS: "30000",
      TEAM_RUNTIME_TASK_STARTUP_TIMEOUT_MS: "35000",
    });
    const page = await app.firstWindow();
    await saveSchedulingLimit(page, 1);
    apiBaseUrl = await desktopApiBaseUrl(page);
    const waiting = await launchWorkflowTask(apiBaseUrl, "Desktop waiting task");
    startedTasks.push(waiting);
    await waitForTask(
      apiBaseUrl,
      waiting,
      (task) => task.admission?.phase === "pending",
      "the new task to wait for the held slot",
    );

    // ── The queue view names the held task, then why, then the pid ──
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Queue overview/ }).click();
    const queuePanel = page.getByRole("tabpanel", { name: "Run" });
    await expect(queuePanel.getByRole("heading", { name: "Queue overview" })).toBeVisible();
    const notice = queuePanel.getByRole("alert");
    await expect(notice).toContainText("Held research · Packaged Smoke");
    await expect(notice).toContainText(HOLD_SENTENCE);
    await expect(notice).toContainText(`Process ${workerPid}`);
    await expect(notice).not.toContainText("Desktop waiting task");
    await expect(queuePanel.getByText("Held", { exact: true })).toBeVisible();

    // ── The worker stops: the notice clears, and the waiting task starts ──
    await stopProcessesCarrying(marker);
    await expect(notice).toBeHidden({ timeout: 30_000 });
    await waitForTask(
      apiBaseUrl,
      waiting,
      (task) => task.admission?.phase === "granted" && task.pid !== undefined,
      "the waiting task to be granted the freed slot and its worker started",
      30_000,
    );
    await expect(queuePanel.getByText("Held", { exact: true })).toHaveCount(0);
    // Its row has left the waiting section for a started one: the title alone
    // shows in either.
    const startedSection = queuePanel
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: /^(starting|running)$/i }) });
    await expect(startedSection.getByText("Desktop waiting task", { exact: true })).toBeVisible();
    await expect(queuePanel.getByRole("heading", { name: /^waiting$/i })).toHaveCount(0);
  } catch (error) {
    failures.push(error);
  } finally {
    for (const step of [
      async () => {
        if (apiBaseUrl) await cancelStartedTasks(apiBaseUrl, startedTasks);
      },
      async () => {
        await app?.close();
      },
    ]) {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    }
    failures.push(...(await stopAllCarrying(markers)));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `The journey and its cleanup failed: ${describeErrors(failures)}`);
  }
});

function grantedAdmission(executionAttemptId: string): Extract<TaskAdmission, { phase: "granted" }> {
  const at = new Date().toISOString();
  return {
    version: 1,
    phase: "granted",
    requestId: `request-${executionAttemptId}`,
    order: "1",
    requestedAt: at,
    executionKind: "initial",
    source: "apply",
    expectedExecutionAttemptId: null,
    grantId: `grant-${executionAttemptId}`,
    ownerEpoch: "queue-hold-journey-seed-epoch",
    grantedAt: at,
    executionAttemptId,
  };
}

async function launchDesktop(
  userDataPath: string,
  additionalEnvironment: Record<string, string>,
): Promise<ElectronApplication> {
  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : null;
  const env: Record<string, string> = {
    ...fixtureDesktopEnvironment(),
    ...additionalEnvironment,
    PIPELINE_DESKTOP_E2E: "1",
    ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
    PIPELINE_DESKTOP_USER_DATA: userDataPath,
  };
  delete env.TEAM_RUNTIME_MAX_CONCURRENT_TASKS;
  return electron.launch({
    args: executablePath ? ["--disable-gpu", "--no-sandbox"] : [".", "--disable-gpu", "--no-sandbox"],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env,
  });
}

async function saveSchedulingLimit(page: Page, value: number): Promise<void> {
  const heading = page.getByRole("heading", { name: "Scheduling and Queue" });
  if (!(await heading.isVisible())) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  }
  await page.getByRole("button", { name: "Scheduling and Queue" }).click();
  await expect(heading).toBeVisible();
  const limit = page.getByLabel("Maximum concurrent tasks or workflows");
  await limit.fill(String(value));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved. The new limit is active.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(heading).toBeHidden();
}

async function desktopApiBaseUrl(page: Page): Promise<string> {
  const baseUrl = await page.evaluate(() =>
    new URLSearchParams(window.location.hash.slice(1)).get("pipeline-api-base-url"),
  );
  if (!baseUrl) throw new Error("Desktop API URL is unavailable");
  return baseUrl;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The task record the API returns, read only for the fields this journey uses. */
interface TaskView {
  readonly id: string;
  readonly sessionId: string;
  readonly status: string;
  readonly admission?: { readonly phase: string };
  /** The worker's pid, recorded once its launch has spawned it. */
  readonly pid?: number;
}

function taskView(value: unknown): TaskView {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.sessionId !== "string" || typeof value.status !== "string") {
    throw new Error(`Not a task record: ${JSON.stringify(value)}`);
  }
  const admission = isRecord(value.admission) && typeof value.admission.phase === "string"
    ? { phase: value.admission.phase }
    : undefined;
  return {
    id: value.id,
    sessionId: value.sessionId,
    status: value.status,
    ...(admission ? { admission } : {}),
    ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
  };
}

async function launchWorkflowTask(apiBaseUrl: string, title: string): Promise<TaskView> {
  const sessionResponse = await fetch(`${apiBaseUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const sessionBody: unknown = await sessionResponse.json();
  expect(sessionResponse.status, JSON.stringify(sessionBody)).toBe(201);
  if (!isRecord(sessionBody) || typeof sessionBody.id !== "string") throw new Error("No session id");
  const taskResponse = await fetch(`${apiBaseUrl}/sessions/${sessionBody.id}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workflowId: queueWorkflowId, brief: `Wait for the held slot: ${title}.` }),
  });
  const taskBody: unknown = await taskResponse.json();
  expect(taskResponse.status, JSON.stringify(taskBody)).toBe(202);
  return taskView(taskBody);
}

async function readTask(apiBaseUrl: string, task: Pick<TaskView, "id" | "sessionId">): Promise<TaskView> {
  const response = await fetch(`${apiBaseUrl}/sessions/${task.sessionId}/tasks/${task.id}`);
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return taskView(body);
}

async function waitForTask(
  apiBaseUrl: string,
  task: Pick<TaskView, "id" | "sessionId">,
  predicate: (task: TaskView) => boolean,
  description: string,
  timeout = 15_000,
): Promise<void> {
  await expect
    .poll(async () => predicate(await readTask(apiBaseUrl, task)), {
      message: `Timed out waiting for ${description}`,
      timeout,
      intervals: [50, 100, 250],
    })
    .toBe(true);
}

async function cancelStartedTasks(apiBaseUrl: string, tasks: readonly TaskView[]): Promise<void> {
  for (const task of tasks) {
    await fetch(`${apiBaseUrl}/sessions/${task.sessionId}/tasks/${task.id}`, { method: "DELETE" }).catch(
      () => undefined,
    );
  }
}
