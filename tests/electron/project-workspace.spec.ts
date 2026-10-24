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

import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const sessionTitle = "Untitled session";

test("Library project navigation persists without changing the Run sidebar hierarchy", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const runKey = `${process.pid}-${Date.now()}`;
  const userDataPath = testInfo.outputPath(`project-workspace-user-data-${runKey}`);
  const workspacePath = testInfo.outputPath(`project-workspace-data-${runKey}`);
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
  ]);

  let desktop = await openDesktop(userDataPath, workspacePath);
  let app = desktop.app;
  let page = desktop.page;
  try {
    await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
    const apiBaseUrl = await desktopApiBaseUrl(page);
    // This journey is about Library navigation and the Run sidebar hierarchy,
    // and it needs a session that is actually in the sidebar. The desktop opens
    // on a draft that is persisted only once it is used, so the session is
    // created directly rather than by pressing New chat and hoping.
    const created = await fetch(`${apiBaseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(201);
    await expect(
      page.getByRole("button", { name: new RegExp(sessionTitle) }).first(),
    ).toBeVisible({ timeout: 15_000 });

    await expectUnchangedRunSidebar(page);
    await page.getByRole("tab", { name: "Library", exact: true }).click();
    await expectLibraryOverview(page);
    await createProject(
      page,
      "Project Alpha",
      testInfo.outputPath("create-project-dialog.png"),
    );
    await createProject(page, "Project Beta");

    await page.getByRole("tab", { name: "Run", exact: true }).click();
    const initialProjectAction = page
      .getByRole("complementary", { name: "Primary navigation" })
      .getByRole("button", { name: `Session actions for ${sessionTitle}` });
    await initialProjectAction.click();
    await page.getByRole("menuitem", { name: "Add to Project", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Add to Project" })
      .getByRole("button", { name: "Project Alpha", exact: true })
      .click();
    await initialProjectAction.click();
    await page.getByRole("menuitem", { name: "Assign to Different Project", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Add to Project" })
      .getByRole("button", { name: "Project Beta", exact: true })
      .click();
    await uploadProjectSessionFile(
      apiBaseUrl,
      "Project Beta",
      sessionTitle,
      "session-input.txt",
    );
    await createHiddenWorkflowArtifact(
      workspacePath,
      apiBaseUrl,
      "Project Beta",
      sessionTitle,
      "chain-step-1-brief-builder.md",
    );

    await page.getByRole("tab", { name: "Library", exact: true }).click();
    await expectLibraryOverview(page);
    await page.mouse.move(1_000, 700);
    await page.screenshot({
      path: testInfo.outputPath("library-overview.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Open Project Beta", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Project Beta" })).toBeVisible();
    const projectActions = page.getByRole("button", { name: "Project actions", exact: true });
    await expect(projectActions.locator("svg.lucide-ellipsis-vertical")).toBeVisible();
    const sessionsSection = page.locator('section[aria-labelledby="project-sessions-heading"]');
    await expect(sessionsSection.locator("xpath=following-sibling::*[1]")).toHaveAttribute(
      "aria-labelledby",
      "project-file-catalog-heading",
    );
    const fileCatalog = page.getByRole("region", { name: "File catalog" });
    await fileCatalog.getByRole("button", { name: sessionTitle, exact: true }).click();
    await expect(fileCatalog.getByText("session-input.txt", { exact: true })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: "project-source.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("durable project source", "utf8"),
    });
    await expect(
      page.getByText("project-source.txt", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText("Uploading…", { exact: true })).toHaveCount(0);
    await expect(
      page
        .getByRole("region", { name: "File catalog" })
        .getByText("project-source.txt", { exact: true }),
    ).toBeVisible();
    await expect(
      fileCatalog.getByRole("button", { name: `Collapse ${sessionTitle}` }),
    ).toBeVisible();
    await expect(fileCatalog.getByText("session-input.txt", { exact: true })).toBeVisible();
    await fileCatalog.getByRole("button", { name: "Inputs", exact: true }).click();
    await expect(fileCatalog.getByText("session-input.txt", { exact: true })).toHaveCount(0);
    await fileCatalog.getByRole("button", { name: "Inputs", exact: true }).click();
    await expect(fileCatalog.getByText("session-input.txt", { exact: true })).toBeVisible();
    await expect(
      fileCatalog.getByText("chain-step-1-brief-builder.md", { exact: true }),
    ).toHaveCount(0);
    await projectActions.click();
    await expect(page.getByRole("menu")).toHaveCSS("white-space", "nowrap");
    const hiddenFilesToggle = page.getByRole("menuitemcheckbox", {
      name: "Show Hidden Files",
      exact: true,
    });
    await expect(hiddenFilesToggle).not.toBeChecked();
    await hiddenFilesToggle.click();
    await expect(
      fileCatalog.getByText("chain-step-1-brief-builder.md", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: testInfo.outputPath("project-detail.png"),
      fullPage: true,
    });
    const centerPane = page
      .getByRole("region", { name: "Project library" })
      .locator(":scope > div")
      .first();
    const scrollMetrics = await centerPane.evaluate((element) => ({
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
      scrollHeight: element.scrollHeight,
    }));
    expect(scrollMetrics.overflowY).toBe("auto");
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
    await centerPane.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(() => centerPane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByRole("heading", { name: "Project memory", exact: true })).toBeInViewport();
    const libraryProjectAction = page.getByRole("button", {
      name: `Project actions for ${sessionTitle}`,
    });
    await libraryProjectAction.hover();
    const libraryProjectTooltip = page.locator('[data-slot="tooltip-content"][data-open]');
    await expect(libraryProjectTooltip).toContainText("Assign to Different Project");
    await expect(libraryProjectTooltip.locator("..")).toHaveAttribute("data-side", "top");
    const disconnectAction = page.getByRole("button", {
      name: `Remove ${sessionTitle} from project`,
    });
    await disconnectAction.hover();
    const disconnectTooltip = page.locator('[data-slot="tooltip-content"][data-open]');
    await expect(disconnectTooltip).toContainText("Disconnect from Project");
    await expect(disconnectTooltip.locator("..")).toHaveAttribute("data-side", "top");
    await disconnectAction.click();
    await expect(fileCatalog.getByText("session-input.txt", { exact: true })).toHaveCount(0);
    await expect(fileCatalog.getByText("No project sessions", { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("project-detail-scrolled.png"),
      fullPage: true,
    });
  } finally {
    await app.close();
  }

  desktop = await openDesktop(userDataPath, workspacePath);
  app = desktop.app;
  page = desktop.page;
  try {
    await page.getByRole("tab", { name: "Library", exact: true }).click();
    await expectLibraryOverview(page);
    await page.getByRole("button", { name: "Open Project Beta", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Project Beta" })).toBeVisible();
    await expect(
      page.getByText("project-source.txt", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText("No sessions belong to this project yet.", { exact: true }))
      .toBeVisible();

    await page.getByRole("button", { name: "Project actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await expect(page.getByText("Archived", { exact: true }).first()).toBeVisible();
    const librarySidebar = page.getByRole("complementary", {
      name: "Primary navigation",
    });
    const archiveAccordion = librarySidebar.getByRole("button", {
      name: "Archive (1)",
      exact: true,
    });
    await expect(archiveAccordion).toHaveAttribute("aria-expanded", "false");
    await expect(
      librarySidebar.getByRole("button", { name: /Project Beta/ }),
    ).toHaveCount(0);
    await archiveAccordion.click();
    await expect(
      librarySidebar.getByRole("button", { name: /Project Beta/ }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Project actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete Project", exact: true }).click();
    const deleteDialog = page.getByRole("dialog", { name: "Delete project?" });
    await expect(
      deleteDialog.getByRole("radio", { name: /Leave session data ungrouped/ }),
    ).toBeChecked();
    await expect(
      deleteDialog.getByRole("radio", { name: /Delete all data and chats/ }),
    ).toBeVisible();
    await deleteDialog.getByRole("button", { name: "Delete project" }).click();
    await expectLibraryOverview(page);

    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await expectUnchangedRunSidebar(page);
    await expect(
      page.getByRole("button", { name: new RegExp(sessionTitle) }).first(),
    ).toBeVisible();
    await page
      .getByRole("complementary", { name: "Primary navigation" })
      .getByRole("button", { name: `Session actions for ${sessionTitle}` })
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Add to Project", exact: true }).click();
    const assignmentDialog = page.getByRole("dialog", { name: "Add to Project" });
    await expect(
      assignmentDialog.getByRole("button", { name: "Project Beta", exact: true }),
    ).toHaveCount(0);
    await expect(
      assignmentDialog.getByRole("button", { name: "Project Alpha", exact: true }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

async function createProject(
  page: Page,
  name: string,
  screenshotPath?: string,
): Promise<void> {
  await page
    .getByRole("group", { name: "Left window actions" })
    .getByRole("button", { name: "New project", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project name").fill(name);
  if (screenshotPath) {
    await page.mouse.move(1_000, 700);
    await page.screenshot({ path: screenshotPath, fullPage: true });
  }
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

async function expectLibraryOverview(page: Page): Promise<void> {
  await expect(
    page.getByRole("tab", { name: "Library", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const sidebar = page.getByRole("complementary", { name: "Primary navigation" });
  await expect(sidebar.getByRole("button", { name: /All projects/ })).toBeVisible();
  await expect(sidebar.getByText("Projects", { exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /Queue overview/ })).toHaveCount(0);
  await expect(
    page
      .getByRole("tabpanel", { name: "Library" })
      .getByRole("heading", { name: "Library", exact: true }),
  ).toBeVisible();
}

async function expectUnchangedRunSidebar(page: Page): Promise<void> {
  const sidebar = page.getByRole("complementary", { name: "Primary navigation" });
  await expect(sidebar.getByRole("button", { name: /Queue overview/ })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /Schedule & Batches/ })).toBeVisible();
  await expect(sidebar.getByText("Active", { exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
  await expect(sidebar.getByText("Recent", { exact: true })).toHaveCount(0);
  await expect(sidebar.getByText("Projects", { exact: true })).toHaveCount(0);
  await expect(sidebar.getByText("Ungrouped", { exact: true })).toHaveCount(0);
}

async function uploadProjectSessionFile(
  apiBaseUrl: string,
  projectName: string,
  title: string,
  filename: string,
): Promise<void> {
  const projectsResponse = await fetch(`${apiBaseUrl}/projects?includeArchived=true`);
  const projectsPayload = await projectsResponse.json() as {
    projects: Array<{ id: string; name: string }>;
  };
  const project = projectsPayload.projects.find((candidate) => candidate.name === projectName);
  expect(project).toBeDefined();
  let sessionId: string | undefined;
  await expect.poll(async () => {
    const sessionsResponse = await fetch(
      `${apiBaseUrl}/projects/${project!.id}/sessions`,
    );
    const payload = await sessionsResponse.json() as {
      sessions: Array<{ id: string; title: string }>;
    };
    sessionId = payload.sessions.find(
      (candidate) => candidate.title === title,
    )?.id;
    return sessionId;
  }).toBeDefined();
  const uploadResponse = await fetch(`${apiBaseUrl}/sessions/${sessionId!}/files`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "x-filename": encodeURIComponent(filename),
    },
    body: "session catalog refresh input",
  });
  expect(uploadResponse.status).toBe(201);
}

async function createHiddenWorkflowArtifact(
  workspacePath: string,
  apiBaseUrl: string,
  projectName: string,
  title: string,
  filename: string,
): Promise<void> {
  const projectsResponse = await fetch(`${apiBaseUrl}/projects?includeArchived=true`);
  const projectsPayload = await projectsResponse.json() as {
    projects: Array<{ id: string; name: string }>;
  };
  const project = projectsPayload.projects.find((candidate) => candidate.name === projectName);
  expect(project).toBeDefined();
  const sessionsResponse = await fetch(`${apiBaseUrl}/projects/${project!.id}/sessions`);
  const sessionsPayload = await sessionsResponse.json() as {
    sessions: Array<{ id: string; title: string }>;
  };
  const session = sessionsPayload.sessions.find((candidate) => candidate.title === title);
  expect(session).toBeDefined();

  const sessionStore = new FileSystemSessionStore(workspacePath);
  const task = await sessionStore.createTaskRecord(session!.id, {
    workflowId: "hidden-files-electron-fixture",
    brief: "Create one internal handoff artifact.",
    workflowYaml: "workflow:\n  id: hidden-files-electron-fixture\n",
  });
  expect(task?.assignmentPath).toBeTruthy();
  await fs.writeFile(path.join(task!.assignmentPath!, filename), "internal handoff");
  await sessionStore.updateTaskRecord(session!.id, task!.id, { status: "done" });
}

async function desktopApiBaseUrl(page: Page): Promise<string> {
  const apiBaseUrl = await page.evaluate(() =>
    new URLSearchParams(window.location.hash.slice(1)).get("pipeline-api-base-url"),
  );
  expect(apiBaseUrl).not.toBeNull();
  return apiBaseUrl!;
}

async function launchDesktop(
  userDataPath: string,
  workspacePath: string,
): Promise<ElectronApplication> {
  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : null;
  return electron.launch({
    args: executablePath
      ? ["--disable-gpu", "--no-sandbox"]
      : [".", "--disable-gpu", "--no-sandbox"],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env: {
      ...fixtureDesktopEnvironment(),
      PIPELINE_DESKTOP_E2E: "1",
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
    },
  });
}

async function openDesktop(
  userDataPath: string,
  workspacePath: string,
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchDesktop(userDataPath, workspacePath);
  try {
    return { app, page: await app.firstWindow() };
  } catch (error) {
    await app.close();
    throw error;
  }
}
