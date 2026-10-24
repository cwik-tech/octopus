import { _electron as electron, expect, test } from "@playwright/test";
import * as fs from "node:fs/promises";

import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import { desktopEnvironment, repoRoot } from "./support/model-selection-fixture.js";

test("renames a session from its sidebar menu and keeps the name after reload", async ({}, testInfo) => {
  const paths = {
    projectRoot: testInfo.outputPath("project"),
    workspacePath: testInfo.outputPath("workspace"),
    userDataPath: testInfo.outputPath("user-data"),
  };
  await Promise.all(Object.values(paths).map((directory) => fs.mkdir(directory, { recursive: true })));
  const store = new FileSystemSessionStore(paths.workspacePath);
  const session = await store.createSession({ title: "Why Agents Need Memory" });
  const untouched = await store.createSession({ title: "Another session" });
  const app = await electron.launch({ args: ["."], cwd: repoRoot, env: desktopEnvironment(paths) });
  try {
    const page = await app.firstWindow();
    const sidebar = page.getByRole("complementary", { name: "Primary navigation" });
    const row = sidebar.getByRole("button", { name: session.title, exact: true });
    await row.click();
    await page.getByRole("button", { name: "Use dark mode", exact: true }).click();
    await row.hover();
    const actions = sidebar.getByRole("button", { name: `Session actions for ${session.title}`, exact: true });
    await actions.click();
    await expect(page.getByRole("menuitem", { name: "Add to Project", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Delete", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("session-menu.png"), animations: "disabled" });
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await expect(page.getByRole("menu")).toBeHidden();
    const dialog = page.getByRole("dialog", { name: "Rename session", exact: true });
    const name = dialog.getByRole("textbox", { name: "Session name", exact: true });
    await expect(name).toBeFocused();
    await expect(name).toHaveValue(session.title);
    await name.fill("Memory research notes");
    await page.screenshot({ path: testInfo.outputPath("rename-session.png"), animations: "disabled" });
    await name.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(sidebar.getByRole("button", { name: "Memory research notes", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit session title", exact: true })).toHaveText("Memory research notes");
    expect((await store.getSession(session.id))?.title).toBe("Memory research notes");
    expect((await store.getSession(untouched.id))?.title).toBe("Another session");

    await page.reload();
    const renamed = sidebar.getByRole("button", { name: "Memory research notes", exact: true });
    await expect(renamed).toBeVisible();
    await renamed.hover();
    await sidebar.getByRole("button", { name: "Session actions for Memory research notes", exact: true }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await name.fill("Discard this edit");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(renamed).toBeVisible();
    expect((await store.getSession(session.id))?.title).toBe("Memory research notes");
  } finally {
    await app.close();
  }
});
