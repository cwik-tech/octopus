import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { fixtureDesktopEnvironment } from "../support/desktop-journey-environment.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { SessionTask } from "../../contracts/sessions.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const maximumConcurrentTasksEnvironmentVariable =
  "TEAM_RUNTIME_MAX_CONCURRENT_TASKS";
const queueWorkflowId = "packaged-smoke";

test("Scheduling and Queue is fourth, saves the limit, reloads it, and honors the environment override", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userDataPath = testInfo.outputPath("scheduling-settings-user-data");
  await fs.mkdir(userDataPath, { recursive: true });

  let app = await launchDesktop(userDataPath);
  let page = await app.firstWindow();
  try {
    await openSchedulingSettings(page);

    const sectionButtons = page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button");
    await expect(sectionButtons).toHaveText([
      "AI Providers",
      "Research & Acquisition",
      "MCPs",
      "Scheduling and Queue",
      "Batch folders",
      "Shared folders",
    ]);

    const limit = page.getByLabel("Maximum concurrent tasks or workflows");
    await expect(limit).toHaveValue("3");
    await expect(limit).toBeEnabled();
    await expect(limit).toHaveAttribute("min", "1");
    await expect(limit).toHaveAttribute("max", "64");
    await expect(limit).toHaveAttribute("step", "1");
    await expect(
      page.getByRole("button", { name: "Save", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByText("Excess work waits in FIFO order.", { exact: false }),
    ).toBeVisible();

    await limit.fill("5");
    await expect(
      page.getByText("Unsaved changes.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByText("Saved. The new limit is active.", { exact: true }),
    ).toBeVisible();
    await expect(limit).toHaveValue("5");
  } finally {
    await app.close();
  }

  const persistedSettings = JSON.parse(
    await fs.readFile(
      path.join(userDataPath, "workspace", "task-queue", "settings.json"),
      "utf8",
    ),
  ) as unknown;
  expect(persistedSettings).toEqual({
    version: 1,
    maximumConcurrentTasks: 5,
  });

  app = await launchDesktop(userDataPath);
  page = await app.firstWindow();
  try {
    await openSchedulingSettings(page);
    await expect(
      page.getByLabel("Maximum concurrent tasks or workflows"),
    ).toHaveValue("5");
  } finally {
    await app.close();
  }

  app = await launchDesktop(userDataPath, "7");
  page = await app.firstWindow();
  try {
    await openSchedulingSettings(page);
    const limit = page.getByLabel("Maximum concurrent tasks or workflows");
    await expect(limit).toHaveValue("7");
    await expect(limit).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Save", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByText(
        "This value is managed by the TEAM_RUNTIME_MAX_CONCURRENT_TASKS environment variable.",
        { exact: false },
      ),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("live desktop queue shows waiting work and applies cap changes without killing active workers", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const userDataPath = testInfo.outputPath("live-queue-user-data");
  const workspacePath = testInfo.outputPath("live-queue-workspace");
  const projectRootPath = testInfo.outputPath("live-queue-project");
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
    fs.cp(
      path.join(repoRoot, "tests", "fixtures", "packaged-workflow-smoke"),
      projectRootPath,
      { recursive: true },
    ),
  ]);

  const app = await launchDesktop(userDataPath, undefined, {
    PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath,
    PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    TEAM_RUNTIME_TASK_RUNNER_DRY_RUN: "1",
    // Keep the detached workers alive long enough to observe admission and
    // limit changes. They still run the real task-runner process and complete
    // naturally after the delay.
    TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS: "30000",
    TEAM_RUNTIME_TASK_STARTUP_TIMEOUT_MS: "35000",
  });
  const page = await app.firstWindow();
  const acceptedTasks: SessionTask[] = [];
  const observedProcessTargets = new Set<number>();
  let apiBaseUrl: string | null = null;

  try {
    await saveSchedulingLimit(page, 1);
    apiBaseUrl = await desktopApiBaseUrl(page);

    const holder = await launchWorkflowTask(apiBaseUrl, "Desktop queue holder");
    acceptedTasks.push(holder);
    const liveHolder = await waitForTask(
      apiBaseUrl,
      holder,
      (task) => task.admission?.phase === "granted" && isTaskProcessAlive(task),
      "the first real worker to hold the only slot",
    );
    expect(liveHolder.status).toBe("queued");
    expect(liveHolder.pid).toEqual(expect.any(Number));

    const waiting = await launchWorkflowTask(apiBaseUrl, "Desktop queued task");
    acceptedTasks.push(waiting);
    const pendingTask = await waitForTask(
      apiBaseUrl,
      waiting,
      (task) =>
        task.admission?.phase === "pending" &&
        task.pid === undefined &&
        task.processGroupId === undefined,
      "the second task to remain pending without a worker",
    );
    expect(pendingTask.status).toBe("queued");

    const cancelledWaiting = await launchWorkflowTask(
      apiBaseUrl,
      "Desktop cancelled wait",
    );
    acceptedTasks.push(cancelledWaiting);
    await waitForTask(
      apiBaseUrl,
      cancelledWaiting,
      (task) => task.admission?.phase === "pending" && task.pid === undefined,
      "a cancellable workflow to enter the FIFO queue",
    );

    // Reload only the renderer so both API-created sessions are hydrated
    // through the same visible desktop session selector an operator uses.
    await page.reload({ waitUntil: "domcontentloaded" });
    const hydratedSession = page
      .getByRole("tabpanel", { name: "Run" })
      .getByRole("button", {
        name: /^Desktop queued task (?!Workflow session)/,
      });
    await expect(hydratedSession).toBeAttached({ timeout: 10_000 });
    await page.getByRole("button", { name: /Queue overview/ }).click();
    const queuePanel = page.getByRole("tabpanel", { name: "Run" });
    await expect(
      queuePanel.getByRole("heading", { name: "Queue overview" }),
    ).toBeVisible();
    await expect(queuePanel.getByText("1 / 1", { exact: true })).toBeVisible();
    await expect(
      queuePanel.getByText("Desktop queue holder", { exact: true }),
    ).toBeVisible();
    await expect(
      queuePanel.getByText("Desktop queued task", { exact: true }),
    ).toBeVisible();
    await expect(
      queuePanel.getByText("Desktop cancelled wait", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Active", { exact: true })).toBeVisible();
    await expect(page.getByText("Recent", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Show inspector" }),
    ).toBeDisabled();

    await queuePanel.getByRole("button", { name: "Scheduling" }).click();
    await expect(
      page.getByRole("heading", { name: "Scheduling and Queue" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();

    await page
      .getByRole("button", { name: "Cancel Desktop cancelled wait" })
      .click();
    await expect(
      page.getByText("It will be removed from the FIFO queue and will not start."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Yes, cancel" }).click();
    await waitForTask(
      apiBaseUrl,
      cancelledWaiting,
      (task) => task.status === "cancelled" && task.admission === undefined,
      "the Queue overview cancellation to persist",
    );
    await expect(
      queuePanel.getByText("Desktop cancelled wait", { exact: true }),
    ).toBeHidden();

    await page.getByRole("button", { name: "Open Desktop queued task" }).click();
    await page.getByRole("tab", { name: "Workflows", exact: true }).click();

    const runSummary = page.getByLabel("Run summary");
    await expect(
      runSummary.getByText("Desktop queued task", { exact: true }),
    ).toBeVisible();
    await expect(
      runSummary.getByText("Queued", { exact: true }),
    ).toBeVisible();
    await expect(
      runSummary.getByRole("button", { name: "Stop workflow" }),
    ).toBeEnabled();
    await expect(
      page.getByText(
        "Waiting for execution capacity. It will start automatically.",
        { exact: true },
      ),
    ).toHaveCount(0);
    await expect(
      page.getByRole("tablist", { name: "Task history" }),
    ).toHaveCount(0);

    await saveSchedulingLimit(page, 2);
    const startedSecond = await waitForTask(
      apiBaseUrl,
      waiting,
      (task) => task.admission?.phase === "granted" && isTaskProcessAlive(task),
      "raising the cap to start a second real worker",
    );
    const stillLiveHolder = await readTask(apiBaseUrl, holder);
    expect(startedSecond.pid).toEqual(expect.any(Number));
    expect(startedSecond.pid).not.toBe(stillLiveHolder.pid);
    expect(isTaskProcessAlive(stillLiveHolder)).toBe(true);

    const holderProcessTarget = taskProcessTarget(stillLiveHolder);
    const secondProcessTarget = taskProcessTarget(startedSecond);
    expect(holderProcessTarget).not.toBeNull();
    expect(secondProcessTarget).not.toBeNull();
    observedProcessTargets.add(holderProcessTarget!);
    observedProcessTargets.add(secondProcessTarget!);

    const third = await launchWorkflowTask(apiBaseUrl, "Desktop drain guard");
    acceptedTasks.push(third);
    await waitForTask(
      apiBaseUrl,
      third,
      (task) =>
        task.admission?.phase === "pending" &&
        task.pid === undefined &&
        task.processGroupId === undefined,
      "a third task to wait behind both active workers",
    );

    await saveSchedulingLimit(page, 1);
    // Give an accidental eviction enough time to become observable before
    // checking both durable grants and their original process groups.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    const [holderAfterLowering, secondAfterLowering, thirdAfterLowering] =
      await Promise.all([
        readTask(apiBaseUrl, holder),
        readTask(apiBaseUrl, waiting),
        readTask(apiBaseUrl, third),
      ]);
    expect(holderAfterLowering.admission?.phase).toBe("granted");
    expect(secondAfterLowering.admission?.phase).toBe("granted");
    expect(taskProcessTarget(holderAfterLowering)).toBe(holderProcessTarget);
    expect(taskProcessTarget(secondAfterLowering)).toBe(secondProcessTarget);
    expect(isTaskProcessAlive(holderAfterLowering)).toBe(true);
    expect(isTaskProcessAlive(secondAfterLowering)).toBe(true);
    expect(thirdAfterLowering.admission?.phase).toBe("pending");
    expect(thirdAfterLowering.pid).toBeUndefined();

    await waitForTask(
      apiBaseUrl,
      holder,
      (task) => task.status === "done" && !isTaskProcessAlive(task),
      "the first worker to complete naturally",
      45_000,
    );
    const [secondWhileDraining, thirdWhileDraining] = await Promise.all([
      readTask(apiBaseUrl, waiting),
      readTask(apiBaseUrl, third),
    ]);
    expect(isTaskProcessAlive(secondWhileDraining)).toBe(true);
    expect(thirdWhileDraining.admission?.phase).toBe("pending");
    expect(thirdWhileDraining.pid).toBeUndefined();

    const completedSecond = await waitForTask(
      apiBaseUrl,
      waiting,
      (task) => task.status === "done",
      "the admitted second worker to complete naturally",
      45_000,
    );
    expect(completedSecond.workerStartedAt).toEqual(expect.any(String));
    const startedThird = await waitForTask(
      apiBaseUrl,
      third,
      (task) => task.admission?.phase === "granted" && isTaskProcessAlive(task),
      "the third task to start only after active usage falls below one",
      20_000,
    );
    const thirdProcessTarget = taskProcessTarget(startedThird);
    expect(thirdProcessTarget).not.toBeNull();
    expect(thirdProcessTarget).not.toBe(holderProcessTarget);
    expect(thirdProcessTarget).not.toBe(secondProcessTarget);
    observedProcessTargets.add(thirdProcessTarget!);
    await expect(
      runSummary.getByText("Complete", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
  } finally {
    await cancelNonTerminalTasks(apiBaseUrl, acceptedTasks);
    await app.close();
  }

  for (const target of observedProcessTargets) {
    await expect.poll(() => isProcessTargetAlive(target)).toBe(false);
  }
});

async function launchDesktop(
  userDataPath: string,
  maximumConcurrentTasks?: string,
  additionalEnvironment: Record<string, string> = {},
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
  delete env[maximumConcurrentTasksEnvironmentVariable];
  if (maximumConcurrentTasks !== undefined) {
    env[maximumConcurrentTasksEnvironmentVariable] = maximumConcurrentTasks;
  }

  return electron.launch({
    args: executablePath
      ? ["--disable-gpu", "--no-sandbox"]
      : [".", "--disable-gpu", "--no-sandbox"],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env,
  });
}

async function openSchedulingSettings(page: Page): Promise<void> {
  const heading = page.getByRole("heading", { name: "Scheduling and Queue" });
  if (!(await heading.isVisible())) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  }
  await page.getByRole("button", { name: "Scheduling and Queue" }).click();
  await expect(heading).toBeVisible();
  await expect(
    page.getByLabel("Maximum concurrent tasks or workflows"),
  ).toBeVisible();
}

async function saveSchedulingLimit(page: Page, value: number): Promise<void> {
  await openSchedulingSettings(page);
  const limit = page.getByLabel("Maximum concurrent tasks or workflows");
  await limit.fill(String(value));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Saved. The new limit is active.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(
    page.getByRole("heading", { name: "Scheduling and Queue" }),
  ).toBeHidden();
}

async function desktopApiBaseUrl(page: Page): Promise<string> {
  const baseUrl = await page.evaluate(() =>
    new URLSearchParams(window.location.hash.slice(1)).get(
      "pipeline-api-base-url",
    ),
  );
  if (!baseUrl) throw new Error("Desktop API URL is unavailable");
  return baseUrl;
}

async function launchWorkflowTask(
  apiBaseUrl: string,
  title: string,
): Promise<SessionTask> {
  const sessionResponse = await fetch(`${apiBaseUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const sessionBody = await sessionResponse.json();
  expect(sessionResponse.status, JSON.stringify(sessionBody)).toBe(201);
  const session = sessionBody as { id: string };

  const taskResponse = await fetch(
    `${apiBaseUrl}/sessions/${session.id}/tasks`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowId: queueWorkflowId,
        brief: `Exercise live desktop queue behavior for ${title}.`,
      }),
    },
  );
  const taskBody = await taskResponse.json();
  expect(taskResponse.status, JSON.stringify(taskBody)).toBe(202);
  return taskBody as SessionTask;
}

async function readTask(
  apiBaseUrl: string,
  task: Pick<SessionTask, "id" | "sessionId">,
): Promise<SessionTask> {
  const response = await fetch(
    `${apiBaseUrl}/sessions/${task.sessionId}/tasks/${task.id}`,
  );
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body as SessionTask;
}

async function waitForTask(
  apiBaseUrl: string,
  task: Pick<SessionTask, "id" | "sessionId">,
  predicate: (task: SessionTask) => boolean,
  description: string,
  timeout = 15_000,
): Promise<SessionTask> {
  let current: SessionTask | null = null;
  await expect
    .poll(
      async () => {
        current = await readTask(apiBaseUrl, task);
        return predicate(current);
      },
      {
        message: `Timed out waiting for ${description}`,
        timeout,
        intervals: [50, 100, 250],
      },
    )
    .toBe(true);
  return current!;
}

async function cancelNonTerminalTasks(
  apiBaseUrl: string | null,
  tasks: readonly SessionTask[],
): Promise<void> {
  if (!apiBaseUrl) return;
  for (const task of tasks) {
    const current = await readTask(apiBaseUrl, task).catch(() => null);
    if (
      !current ||
      current.status === "done" ||
      current.status === "failed" ||
      current.status === "blocked" ||
      current.status === "cancelled"
    ) {
      continue;
    }
    await fetch(`${apiBaseUrl}/sessions/${task.sessionId}/tasks/${task.id}`, {
      method: "DELETE",
    }).catch(() => undefined);
  }
}

function taskProcessTarget(
  task: Pick<SessionTask, "pid" | "processGroupId">,
): number | null {
  const pid = task.processGroupId ?? task.pid;
  if (!pid) return null;
  return process.platform === "win32" ? pid : -pid;
}

function isTaskProcessAlive(
  task: Pick<SessionTask, "pid" | "processGroupId">,
): boolean {
  const target = taskProcessTarget(task);
  return target !== null && isProcessTargetAlive(target);
}

function isProcessTargetAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
